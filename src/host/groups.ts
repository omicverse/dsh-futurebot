import { randomUUID } from 'node:crypto'
import type { Bot } from '../shared/types.ts'
import { parseMentions } from './mentions.ts'
import type { Table } from './mind.ts'

/**
 * Groups of bots, with the same rules as OmicOS:
 *
 * - Every bot member has its own conversation for each group it is in. When
 *   it is called on, everything said in the group since it last spoke is
 *   handed to it as one `<group_update>` message; its final answer in that
 *   turn is what it says in the group.
 * - Who answers: the bots a message mentions; a user message that mentions
 *   nobody goes to the admin. When the admin mentions members, it is woken
 *   once more after all of them have answered. `[PASS]` means "nothing to
 *   add". Six rounds between bots without any tool use pause the group until
 *   the user speaks.
 * - A group goal is split into stages, each owned by a member. The plugin
 *   decides who is called and when; the bots only do the work and the checks
 *   (`goal_plan`, `goal_check`, admin only).
 */

export type GoalStatus = 'planning' | 'active' | 'waiting_user' | 'paused' | 'done' | 'stopped'
export type StageStatus = 'pending' | 'working' | 'checking' | 'passed'

export interface Stage {
  title: string
  owner: string
  doneWhen: string
  status: StageStatus
  attempts: number
  evidence?: string
  note?: string
  /** Log position of the event that started this stage's current attempt. */
  startSeq?: number
}

export interface GroupGoal {
  objective: string
  doneWhen: string
  status: GoalStatus
  current: number
  stages: Stage[]
  createdAt: string
  updatedAt: string
}

export interface Group {
  id: string
  title: string
  /** Bot ids, in order. */
  members: string[]
  admin?: string
  notice: string
  /** Who first sees a member's approval request: its admin, or the user directly. */
  approvals: 'admin' | 'user'
  /** Whether the admin may approve on the user's behalf; otherwise it may only deny or pass to the user. */
  adminMayApprove: boolean
  userIn: boolean
  /** Each member's conversation for this group. */
  sessions: Record<string, string>
  /** Last log entry each member has been handed. */
  cursors: Record<string, number>
  paused: boolean
  idleRounds: number
  /** Members the admin is waiting on before it is woken again. */
  batch?: string[]
  goal?: GroupGoal
  nextSeq: number
  createdAt: string
  updatedAt: string
  rev: number
}

export interface LogEntry {
  id: string
  group: string
  seq: number
  /** `user`, `system`, or a bot id. */
  from: string
  kind: 'message' | 'event' | 'review'
  text: string
  /** Bot ids, plus `user` when the user was mentioned. */
  mentions: string[]
  at: string
}

export interface GroupSource {
  kind: 'futurebot'
  form: 'relay'
  type: 'group'
  job: string
  from: 'group'
  reason: string
  /** Last group log position this update hands over. */
  upto: number
}

export interface GroupPorts {
  /** Create a bot's conversation for a group, in its workspace. */
  createSession(bot: Bot, title: string): Promise<string>
  /** Queue `text` as its own turn in that conversation, waking it. */
  deliver(sessionId: string, text: string, source: GroupSource): Promise<string>
}

export class GroupError extends Error {
  constructor(readonly code: 'invalid_group' | 'not_found' | 'title_taken' | 'not_member' | 'not_admin' | 'invalid_state', message: string) {
    super(message)
    this.name = 'GroupError'
  }
}

export const GROUP_LIMITS = {
  title: 60,
  notice: 2000,
  members: 9,
  idleRounds: 6,
  redoLimit: 3,
  stages: 12,
  updateLines: 60,
} as const

export interface GroupInput {
  title?: unknown
  members?: unknown
  admin?: unknown
  notice?: unknown
  approvals?: unknown
  adminMayApprove?: unknown
  userIn?: unknown
}

export interface PlanInput {
  objective: string
  done_when: string
  stages: { title: string; owner: string; done_when: string }[]
}

export interface GroupOptions {
  now?: () => Date
  newId?: (prefix: 'g' | 'e') => string
  warn?: (message: string) => void
  /**
   * Called once new seats are recorded. The Harness creates a seat's Agent
   * before the group record names it, so whatever attaches per-session
   * behaviour must look again now.
   */
  onSeats?: (sessions: string[]) => void
}

interface Turn {
  text: string
  tools: boolean
  /** Highest group log position handed over in this turn. */
  upto: number
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export class Groups {
  private readonly turns = new Map<string, Turn>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date
  private readonly newId: (prefix: 'g' | 'e') => string
  private readonly warn: (message: string) => void
  private readonly onSeats: (sessions: string[]) => void

  constructor(
    private readonly groups: Table<Group>,
    private readonly log: Table<LogEntry>,
    private readonly bots: { get(id: string): Bot | undefined; list(): Bot[] },
    private readonly ports: GroupPorts,
    options: GroupOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (prefix => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`)
    this.warn = options.warn ?? (message => console.warn(`futurebot: ${message}`))
    this.onSeats = options.onSeats ?? (() => undefined)
  }

  // ── reading ─────────────────────────────────────────────────────────────

  list(): Group[] {
    return [...this.groups.entries()].map(([, group]) => group).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(id: string): Group | undefined {
    return this.groups.get(id)
  }

  entries(groupId: string, after = 0): LogEntry[] {
    return [...this.log.entries()].map(([, entry]) => entry).filter(entry => entry.group === groupId && entry.seq > after).sort((a, b) => a.seq - b.seq)
  }

  /** The group and member a group conversation belongs to. */
  forSession(sessionId: string): { group: Group; bot: Bot } | undefined {
    for (const group of this.list()) {
      for (const [botId, session] of Object.entries(group.sessions)) {
        if (session !== sessionId) continue
        const bot = this.bots.get(botId)
        return bot === undefined ? undefined : { group, bot }
      }
    }
    return undefined
  }

  name(id: string): string {
    if (id === 'user') return '用户'
    if (id === 'system') return '事件'
    return this.bots.get(id)?.name ?? id
  }

  // ── managing ────────────────────────────────────────────────────────────

  create(input: GroupInput): Promise<Group> {
    return this.serial(async () => {
      const title = this.title(input.title)
      const members = this.members(input.members)
      const admin = input.admin === undefined || input.admin === null || input.admin === '' ? undefined : this.member(input.admin, members)
      const stamp = this.now().toISOString()
      const group: Group = {
        id: this.newId('g'), title, members, ...(admin === undefined ? {} : { admin }),
        notice: this.notice(input.notice ?? ''),
        approvals: input.approvals === 'user' ? 'user' : 'admin',
        adminMayApprove: input.adminMayApprove === true,
        userIn: input.userIn !== false,
        sessions: {}, cursors: {}, paused: false, idleRounds: 0, nextSeq: 1,
        createdAt: stamp, updatedAt: stamp, rev: 1,
      }
      for (const id of members) group.sessions[id] = await this.ports.createSession(this.bots.get(id)!, `${title} · ${this.name(id)}`)
      await this.groups.put(group.id, group)
      this.onSeats(Object.values(group.sessions))
      await this.event(group, `建群：${members.map(id => this.name(id)).join('、')}${admin ? `,管理员 ${this.name(admin)}` : ''}`)
      return this.groups.get(group.id)!
    })
  }

  update(id: string, input: GroupInput): Promise<Group> {
    return this.serial(async () => {
      const group = this.must(id)
      const next: Group = { ...group, sessions: { ...group.sessions }, cursors: { ...group.cursors } }
      const notes: string[] = []
      if (input.title !== undefined) next.title = this.title(input.title, id)
      if (input.notice !== undefined) { next.notice = this.notice(input.notice); notes.push('改了群公告') }
      if (input.members !== undefined) {
        next.members = this.members(input.members)
        for (const added of next.members.filter(m => !group.members.includes(m))) {
          next.sessions[added] ??= await this.ports.createSession(this.bots.get(added)!, `${next.title} · ${this.name(added)}`)
          notes.push(`${this.name(added)} 进群`)
        }
        for (const left of group.members.filter(m => !next.members.includes(m))) notes.push(`${this.name(left)} 退群`)
      }
      if (input.admin !== undefined) {
        if (input.admin === null || input.admin === '') delete next.admin
        else next.admin = this.member(input.admin, next.members)
        notes.push(next.admin ? `管理员改为 ${this.name(next.admin)}` : '不再设管理员')
      } else if (next.admin !== undefined && !next.members.includes(next.admin)) {
        delete next.admin
      }
      if (input.approvals !== undefined) next.approvals = input.approvals === 'user' ? 'user' : 'admin'
      if (input.adminMayApprove !== undefined) next.adminMayApprove = input.adminMayApprove === true
      if (input.userIn !== undefined) next.userIn = input.userIn !== false
      next.updatedAt = this.now().toISOString()
      next.rev = group.rev + 1
      await this.groups.put(id, next)
      const added = Object.entries(next.sessions).filter(([bot]) => group.sessions[bot] === undefined).map(([, session]) => session)
      if (added.length > 0) this.onSeats(added)
      for (const note of notes) await this.event(next, note)
      return this.groups.get(id)!
    })
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.must(id)
      await this.groups.delete(id)
    })
  }

  /** Forget a deleted bot everywhere it was a member. */
  removeBot(botId: string): Promise<void> {
    return this.serial(async () => {
      for (const group of this.list().filter(g => g.members.includes(botId))) {
        const { [botId]: _s, ...sessions } = group.sessions
        const next: Group = { ...group, members: group.members.filter(m => m !== botId), sessions, updatedAt: this.now().toISOString(), rev: group.rev + 1 }
        if (next.admin === botId) delete next.admin
        await this.groups.put(group.id, next)
        await this.event(next, `${this.name(botId)} 已删除，退群`)
      }
    })
  }

  // ── talking ─────────────────────────────────────────────────────────────

  /** The user speaks in the group. */
  post(groupId: string, text: string, mentions?: readonly string[]): Promise<LogEntry> {
    return this.serial(async () => {
      let group = this.must(groupId)
      if (!group.userIn) throw new GroupError('not_member', 'you are not in this group')
      const body = text.trim()
      if (body === '') throw new GroupError('invalid_group', 'say something')
      const found = this.mentioned(group, body, mentions)
      const goal = group.goal?.status === 'waiting_user' ? { ...group.goal, status: 'active' as const, updatedAt: this.now().toISOString() } : group.goal
      group = await this.save(group, { paused: false, idleRounds: 0, ...(goal === undefined ? {} : { goal }) })
      const entry = await this.append(group, 'user', 'message', body, found.mentions)
      const targets = found.bots.length > 0 ? found.bots : group.admin !== undefined ? [group.admin] : group.members.slice(0, 1)
      for (const bot of targets) await this.wake(this.must(groupId), bot, found.bots.length > 0 ? 'mentioned' : 'admin_routed')
      return entry
    })
  }

  // Turn tracking, fed from the Harness session events of group conversations.

  turnInput(sessionId: string, source: unknown): void {
    if (this.forSession(sessionId) === undefined) return
    const upto = typeof source === 'object' && source !== null && (source as { type?: unknown }).type === 'group'
      ? Number((source as { upto?: unknown }).upto) || 0 : 0
    const turn = this.turns.get(sessionId)
    if (turn === undefined) this.turns.set(sessionId, { text: '', tools: false, upto })
    else turn.upto = Math.max(turn.upto, upto)
  }

  turnOutput(sessionId: string, text: string, usedTools: boolean): void {
    const turn = this.turns.get(sessionId)
    if (turn === undefined) return
    if (text.trim() !== '') turn.text = text.trim()
    if (usedTools) turn.tools = true
  }

  /** A member's turn in a group conversation ended: what it said goes to the group. */
  turnEnded(sessionId: string, completed: boolean): Promise<void> {
    const turn = this.turns.get(sessionId)
    this.turns.delete(sessionId)
    return this.serial(async () => {
      const where = this.forSession(sessionId)
      if (where === undefined || turn === undefined) return
      let group = where.group
      const bot = where.bot.id
      const text = turn.text
      let adminWoken = false
      const pass = text === '' || /^\[pass\]$/i.test(text) || !completed
      if (!pass) {
        const found = this.mentioned(group, text)
        // Only the admin may call on everyone; a member's @all counts for nobody.
        const bots = found.everyone && bot !== group.admin ? found.bots.filter(id => !found.everyoneOnly.includes(id)) : found.bots
        await this.append(group, bot, 'message', text, [...bots, ...(found.mentions.includes('user') ? ['user'] : [])])
        group = this.must(group.id)
        const idleRounds = turn.tools ? 0 : group.idleRounds + 1
        group = await this.save(group, { idleRounds })
        if (idleRounds >= GROUP_LIMITS.idleRounds && !group.paused) {
          group = await this.save(group, { paused: true })
          await this.event(group, `来回 ${GROUP_LIMITS.idleRounds} 次没有进展，先停下了;用户发言后继续`)
        }
        group = this.must(group.id)
        const targets = bots.filter(id => id !== bot && group.members.includes(id))
        if (!group.paused && targets.length > 0) {
          if (bot === group.admin) group = await this.save(group, { batch: targets })
          for (const target of targets) await this.wake(this.must(group.id), target, 'mentioned')
          if (group.admin !== undefined && targets.includes(group.admin)) adminWoken = true
        }
      }
      group = this.must(group.id)
      group = await this.stageAnswered(group, bot, pass, turn.upto)
      if (group.batch?.includes(bot)) {
        const waiting = group.batch.filter(id => id !== bot)
        group = await this.save(group, waiting.length > 0 ? { batch: waiting } : { batch: undefined })
        // One wake for the admin: skip it when this answer already called on it.
        if (waiting.length === 0 && group.admin !== undefined && !group.paused && !adminWoken) await this.wake(group, group.admin, this.checking(group) ? 'goal_check' : 'batch_done')
      }
    })
  }

  // ── goals ───────────────────────────────────────────────────────────────

  plan(sessionId: string, input: PlanInput): Promise<string> {
    return this.serial(async () => {
      const { group, bot } = this.admin(sessionId)
      const objective = input.objective?.trim() ?? ''
      const doneWhen = input.done_when?.trim() ?? ''
      if (objective === '' || doneWhen === '') throw new GroupError('invalid_group', 'a goal needs an objective and done_when')
      if (!Array.isArray(input.stages) || input.stages.length === 0 || input.stages.length > GROUP_LIMITS.stages) {
        throw new GroupError('invalid_group', `give 1–${GROUP_LIMITS.stages} stages`)
      }
      const stages: Stage[] = input.stages.map(stage => {
        const owner = this.member(stage.owner, group.members)
        if (!stage.title?.trim() || !stage.done_when?.trim()) throw new GroupError('invalid_group', 'every stage needs a title and done_when')
        return { title: stage.title.trim(), owner, doneWhen: stage.done_when.trim(), status: 'pending', attempts: 0 }
      })
      const stamp = this.now().toISOString()
      const running = group.goal !== undefined && ['active', 'paused', 'waiting_user'].includes(group.goal.status)
      if (!running) {
        await this.save(group, { goal: { objective, doneWhen, status: 'planning', current: 0, stages, createdAt: stamp, updatedAt: stamp } })
        await this.event(this.must(group.id), `${this.name(bot.id)} 提了目标计划(${stages.length} 个阶段),等用户确认开始`)
        return `Planned ${stages.length} stages. The user starts the goal; until then nothing is handed out.`
      }
      const goal = group.goal!
      const kept = goal.stages.slice(0, goal.current).filter(stage => stage.status === 'passed')
      const next: GroupGoal = { ...goal, objective, doneWhen, status: goal.status === 'waiting_user' ? 'active' : goal.status, current: kept.length, stages: [...kept, ...stages], updatedAt: stamp }
      const saved = await this.save(group, { goal: next })
      await this.event(saved, `${this.name(bot.id)} 调整了目标计划`)
      if (next.status === 'active') await this.startStage(this.must(group.id))
      return `Replanned from stage ${kept.length + 1}.`
    })
  }

  check(sessionId: string, input: { verdict: string; evidence?: string; note?: string }): Promise<string> {
    return this.serial(async () => {
      const { group } = this.admin(sessionId)
      const goal = group.goal
      if (goal === undefined || goal.status !== 'active') throw new GroupError('invalid_state', 'there is no active goal to check')
      const stage = goal.stages[goal.current]
      if (stage === undefined) throw new GroupError('invalid_state', 'no stage is in progress')
      const stamp = this.now().toISOString()
      const stages = goal.stages.map(s => ({ ...s }))
      const current = stages[goal.current]!
      if (input.verdict === 'pass') {
        if (!input.evidence?.trim()) throw new GroupError('invalid_group', 'pass needs evidence against the stage\'s done_when')
        current.status = 'passed'
        current.evidence = input.evidence.trim()
        const last = goal.current + 1 >= stages.length
        await this.save(group, { goal: { ...goal, stages, current: goal.current + 1, status: last ? 'done' : 'active', updatedAt: stamp } })
        await this.event(this.must(group.id), `阶段 ${goal.current + 1}/${stages.length}「${current.title}」通过:${clip(current.evidence, 200)}`)
        if (last) {
          await this.event(this.must(group.id), `目标完成:${goal.objective}`)
          return 'Stage passed. That was the last stage: the goal is done. Tell the group and the user.'
        }
        await this.startStage(this.must(group.id))
        return `Stage passed; stage ${goal.current + 2} has been handed to ${this.name(stages[goal.current + 1]!.owner)}.`
      }
      if (input.verdict === 'redo') {
        if (!input.note?.trim()) throw new GroupError('invalid_group', 'redo needs a note on what to fix')
        current.attempts += 1
        current.note = input.note.trim()
        if (current.attempts >= GROUP_LIMITS.redoLimit) {
          current.status = 'checking'
          await this.save(group, { goal: { ...goal, stages, status: 'waiting_user', updatedAt: stamp } })
          await this.event(this.must(group.id), `阶段「${current.title}」已退回 ${current.attempts} 次，等用户决定`)
          return `This stage has been sent back ${current.attempts} times; it now waits for the user. Explain the problem and mention @用户 in your answer.`
        }
        current.status = 'pending'
        await this.save(group, { goal: { ...goal, stages, updatedAt: stamp } })
        await this.startStage(this.must(group.id))
        return `Sent back to ${this.name(current.owner)} with your note.`
      }
      if (input.verdict === 'ask_user') {
        if (!input.note?.trim()) throw new GroupError('invalid_group', 'ask_user needs a note with the question')
        current.note = input.note.trim()
        await this.save(group, { goal: { ...goal, stages, status: 'waiting_user', updatedAt: stamp } })
        await this.event(this.must(group.id), `等用户决定:${clip(current.note, 200)}`)
        return 'The goal waits for the user. Put the question in your answer and mention @用户.'
      }
      throw new GroupError('invalid_group', 'verdict must be pass, redo or ask_user')
    })
  }

  /** The user starts, pauses, resumes, stops or clears the goal. */
  goalAction(groupId: string, action: string): Promise<Group> {
    return this.serial(async () => {
      const group = this.must(groupId)
      const goal = group.goal
      const stamp = this.now().toISOString()
      const fail = () => { throw new GroupError('invalid_state', `cannot ${action} a goal that is ${goal?.status ?? 'absent'}`) }
      if (goal === undefined) fail()
      if (action === 'clear') {
        await this.save(group, { goal: undefined })
        await this.event(this.must(groupId), '用户清除了目标')
      } else if (action === 'start') {
        if (goal!.status !== 'planning') fail()
        await this.save(group, { goal: { ...goal!, status: 'active', updatedAt: stamp }, paused: false, idleRounds: 0 })
        await this.event(this.must(groupId), '用户开始了目标')
        await this.startStage(this.must(groupId))
      } else if (action === 'pause') {
        if (goal!.status !== 'active' && goal!.status !== 'waiting_user') fail()
        await this.save(group, { goal: { ...goal!, status: 'paused', updatedAt: stamp } })
        await this.event(this.must(groupId), '用户暂停了目标')
      } else if (action === 'resume') {
        if (goal!.status !== 'paused') fail()
        await this.save(group, { goal: { ...goal!, status: 'active', updatedAt: stamp }, paused: false, idleRounds: 0 })
        await this.event(this.must(groupId), '用户继续了目标')
        const resumed = this.must(groupId)
        if (this.checking(resumed) && resumed.admin !== undefined) await this.wake(resumed, resumed.admin, 'goal_check')
        else await this.startStage(resumed)
      } else if (action === 'stop') {
        if (goal!.status === 'done' || goal!.status === 'stopped') fail()
        await this.save(group, { goal: { ...goal!, status: 'stopped', updatedAt: stamp } })
        await this.event(this.must(groupId), '用户停止了目标')
      } else {
        throw new GroupError('invalid_state', 'action must be start, pause, resume, stop or clear')
      }
      return this.must(groupId)
    })
  }

  /** Record an admin's review decision in the group log (never shown to members). */
  review(groupId: string, admin: string, text: string): Promise<void> {
    return this.serial(async () => {
      const group = this.groups.get(groupId)
      if (group !== undefined) await this.append(group, admin, 'review', text, [])
    })
  }

  // ── context ─────────────────────────────────────────────────────────────

  /** Standing rules for one member's group conversation; changes only when the group does. */
  context(group: Group, botId: string): string {
    const lines = [
      `This conversation is your seat in the group "${group.title}". Members: ${group.members.map(id => `${this.name(id)}${id === group.admin ? ' (admin)' : ''}`).join(', ')}${group.userIn ? ', and the user' : ''}.`,
      'Messages from the group reach you as <group_update> blocks: each line starts with who said it. Your final answer in a turn is what you say in the group. Mention a member with @name to hand them the floor; every mention wakes that member, so mention someone only when you need them to act, never just to thank or acknowledge them. Reply exactly [PASS] if you have nothing to add. Do not use bot_send here.',
    ]
    if (group.notice !== '') lines.push(`Group notice: ${group.notice}`)
    if (botId === group.admin) {
      lines.push('You are this group\'s admin: user messages that mention nobody come to you, and after the members you mention have all answered you are woken again to sum up or continue. For a goal with stages, propose it with goal_plan and verify each finished stage with goal_check; the plugin hands each stage to its owner.')
    }
    return lines.join('\n')
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async wake(group: Group, botId: string, reason: string): Promise<void> {
    const session = group.sessions[botId]
    if (session === undefined) return
    const since = group.cursors[botId] ?? 0
    const fresh = this.entries(group.id, since).filter(entry => entry.from !== botId && entry.kind !== 'review')
    const goal = this.goalLine(group, botId)
    if (fresh.length === 0 && goal === undefined) return
    const shown = fresh.slice(-GROUP_LIMITS.updateLines)
    const lines = [
      `<group_update group="${attr(group.id)}" title="${attr(group.title)}" reason="${reason}">`,
      ...(goal === undefined ? [] : [goal]),
      ...(fresh.length > shown.length ? [`(${fresh.length - shown.length} earlier lines omitted)`] : []),
      ...shown.map(entry => `[${this.name(entry.from)}] ${entry.text.replace(/<\/group_update/g, '&lt;/group_update')}`),
      '</group_update>',
    ]
    const latest = fresh.length > 0 ? fresh[fresh.length - 1]!.seq : since
    await this.save(group, { cursors: { ...group.cursors, [botId]: Math.max(since, latest) } })
    try {
      await this.ports.deliver(session, lines.join('\n'), { kind: 'futurebot', form: 'relay', type: 'group', job: group.id, from: 'group', reason, upto: Math.max(since, latest) })
    } catch (error) {
      this.warn(`could not reach ${this.name(botId)} in ${group.title}: ${String(error)}`)
    }
  }

  private goalLine(group: Group, botId: string): string | undefined {
    const goal = group.goal
    if (goal === undefined || !['planning', 'active', 'waiting_user', 'paused'].includes(goal.status)) return undefined
    const stage = goal.stages[goal.current]
    const parts = [`[群目标] 目标:${goal.objective} · 完成标准:${goal.doneWhen} · 状态:${goal.status}`]
    if (stage !== undefined) {
      parts.push(`当前阶段 ${goal.current + 1}/${goal.stages.length}「${stage.title}」负责人 ${this.name(stage.owner)} · 本阶段完成标准:${stage.doneWhen}${stage.note ? ` · 上次退回原因:${stage.note}` : ''}`)
      if (goal.status === 'active' && stage.owner === botId && stage.status === 'working') parts.push('这一阶段由你负责：做完在回答里给出证据。')
      if (goal.status === 'active' && botId === group.admin && stage.status === 'checking') parts.push(`${this.name(stage.owner)} 已回复：对照完成标准核对证据，然后调用 goal_check。`)
    }
    return parts.join(' · ')
  }

  private checking(group: Group): boolean {
    const goal = group.goal
    return goal?.status === 'active' && goal.stages[goal.current]?.status === 'checking'
  }

  private async startStage(group: Group): Promise<void> {
    const goal = group.goal
    if (goal === undefined || goal.status !== 'active') return
    const stage = goal.stages[goal.current]
    if (stage === undefined) return
    if (!group.members.includes(stage.owner)) {
      await this.save(group, { goal: { ...goal, status: 'waiting_user', updatedAt: this.now().toISOString() } })
      await this.event(this.must(group.id), `负责人 ${this.name(stage.owner)} 已不在群里，等用户决定`)
      return
    }
    const started = await this.event(group, `目标阶段 ${goal.current + 1}/${goal.stages.length} 开始:「${stage.title}」· 负责人 ${this.name(stage.owner)} · 完成标准:${stage.doneWhen}${stage.note ? ` · 退回原因:${stage.note}` : ''}`)
    const latest = this.must(group.id)
    const stages = latest.goal!.stages.map((s, i) => (i === goal.current ? { ...s, status: 'working' as const, startSeq: started.seq } : s))
    await this.save(latest, { goal: { ...latest.goal!, stages, updatedAt: this.now().toISOString() }, ...(stage.owner === latest.admin ? {} : { batch: [stage.owner] }) })
    await this.wake(this.must(group.id), stage.owner, 'goal_stage')
  }

  /**
   * The stage owner finished a turn that saw the stage begin: the stage waits
   * for the admin's check. A turn handed only older lines (queued before the
   * stage started) does not count.
   */
  private async stageAnswered(group: Group, botId: string, passed: boolean, upto: number): Promise<Group> {
    const goal = group.goal
    if (goal === undefined || goal.status !== 'active' || passed) return group
    const stage = goal.stages[goal.current]
    if (stage === undefined || stage.owner !== botId || stage.status !== 'working') return group
    if (stage.startSeq !== undefined && upto < stage.startSeq) return group
    const stages = goal.stages.map((s, i) => (i === goal.current ? { ...s, status: 'checking' as const } : s))
    const saved = await this.save(group, { goal: { ...goal, stages, updatedAt: this.now().toISOString() } })
    // The admin owns this stage and did not check it in the same turn: ask it to.
    if (botId === saved.admin) await this.wake(saved, botId, 'goal_check')
    return this.must(group.id)
  }

  private admin(sessionId: string): { group: Group; bot: Bot } {
    const where = this.forSession(sessionId)
    if (where === undefined) throw new GroupError('not_admin', 'this works only in a group conversation')
    if (where.group.admin !== where.bot.id) throw new GroupError('not_admin', 'only the group\'s admin can do this')
    return where
  }

  private mentioned(group: Group, text: string, explicit?: readonly string[]): { bots: string[]; mentions: string[]; everyone: boolean; everyoneOnly: string[] } {
    const members = group.members.map(id => ({ id, name: this.name(id) }))
    if (explicit !== undefined) {
      const bots = explicit.filter(id => group.members.includes(id))
      return { bots, mentions: [...bots, ...(explicit.includes('user') ? ['user'] : [])], everyone: false, everyoneOnly: [] }
    }
    const found = parseMentions(text, members)
    const everyoneOnly = found.everyone ? group.members.filter(id => !found.bots.includes(id)) : []
    const bots = found.everyone ? [...found.bots, ...everyoneOnly] : found.bots
    return { bots, mentions: [...bots, ...(found.user ? ['user'] : [])], everyone: found.everyone, everyoneOnly }
  }

  private async append(group: Group, from: string, kind: LogEntry['kind'], text: string, mentions: string[]): Promise<LogEntry> {
    const current = this.must(group.id)
    const entry: LogEntry = { id: this.newId('e'), group: group.id, seq: current.nextSeq, from, kind, text, mentions, at: this.now().toISOString() }
    await this.log.put(entry.id, entry)
    await this.groups.put(group.id, { ...current, nextSeq: current.nextSeq + 1 })
    return entry
  }

  private event(group: Group, text: string): Promise<LogEntry> {
    return this.append(group, 'system', 'event', text, [])
  }

  private async save(group: Group, patch: Partial<Group>): Promise<Group> {
    const current = this.groups.get(group.id) ?? group
    const next = { ...current, ...patch }
    for (const key of Object.keys(patch) as (keyof Group)[]) if (patch[key] === undefined) delete next[key]
    await this.groups.put(group.id, next)
    return next
  }

  private must(id: string): Group {
    const group = this.groups.get(id)
    if (group === undefined) throw new GroupError('not_found', `no group ${id}`)
    return group
  }

  private title(value: unknown, exceptId?: string): string {
    if (typeof value !== 'string' || value.trim() === '' || value.trim().length > GROUP_LIMITS.title) throw new GroupError('invalid_group', `title must be 1–${GROUP_LIMITS.title} characters`)
    const title = value.trim()
    if (this.list().some(group => group.id !== exceptId && group.title.toLocaleLowerCase() === title.toLocaleLowerCase())) throw new GroupError('title_taken', `a group named ${title} exists`)
    return title
  }

  private notice(value: unknown): string {
    if (typeof value !== 'string' || value.length > GROUP_LIMITS.notice) throw new GroupError('invalid_group', `notice must be at most ${GROUP_LIMITS.notice} characters`)
    return value.trim()
  }

  private members(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new GroupError('invalid_group', 'members must list at least one bot')
    const ids: string[] = []
    for (const item of value) {
      const bot = typeof item === 'string' ? this.find(item) : undefined
      if (bot === undefined) throw new GroupError('invalid_group', `no bot ${String(item)}`)
      if (bot.sessionId === undefined) throw new GroupError('invalid_group', `${bot.name} has no conversation yet`)
      if (!ids.includes(bot.id)) ids.push(bot.id)
    }
    if (ids.length > GROUP_LIMITS.members) throw new GroupError('invalid_group', `at most ${GROUP_LIMITS.members} members`)
    return ids
  }

  private member(value: unknown, members: readonly string[]): string {
    const bot = typeof value === 'string' ? this.find(value) : undefined
    if (bot === undefined || !members.includes(bot.id)) throw new GroupError('not_member', `${String(value)} is not a member of this group`)
    return bot.id
  }

  private find(nameOrId: string): Bot | undefined {
    const wanted = nameOrId.trim().toLocaleLowerCase()
    return this.bots.get(nameOrId.trim()) ?? this.bots.list().find(bot => bot.name.toLocaleLowerCase() === wanted)
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }
}
