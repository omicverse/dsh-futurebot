import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../src/shared/types.ts'
import { GROUP_LIMITS, GroupError, Groups, type Group, type GroupSource, type LogEntry } from '../src/host/groups.ts'
import { parseMentions } from '../src/host/mentions.ts'
import type { Table } from '../src/host/mind.ts'

class Rows<T> implements Table<T> {
  rows = new Map<string, T>()
  get(id: string) { return this.rows.get(id) }
  entries() { return [...this.rows.entries()] }
  async put(id: string, value: T) { this.rows.set(id, value) }
  async delete(id: string) { return this.rows.delete(id) }
}

const stamp = '2026-11-08T00:00:00.000Z'
const bot = (id: string, name: string): Bot => ({ id, name, instructions: '', permission: 'auto', workspace: `/w/${id}`, sessionId: `s-${id}`, createdAt: stamp, updatedAt: stamp, rev: 1 })

let bots: Bot[]
let delivered: { session: string; text: string; source: GroupSource }[]
let seated: string[][]
let groups: Groups

beforeEach(() => {
  bots = [bot('main', '总管'), bot('lin', '林分析'), bot('zhao', 'Zhao')]
  delivered = []
  seated = []
  let n = 0
  groups = new Groups(new Rows<Group>(), new Rows<LogEntry>(), { get: id => bots.find(b => b.id === id), list: () => bots }, {
    createSession: async (b, title) => `g-${b.id}-${title.length}`,
    deliver: async (session, text, source) => { delivered.push({ session, text, source }); return `m${delivered.length}` },
  }, { newId: prefix => `${prefix}${++n}`, warn: () => undefined, onSeats: sessions => seated.push(sessions) })
})

const seat = (group: Group, id: string) => group.sessions[id]!
const to = (group: Group, id: string) => delivered.filter(d => d.session === seat(group, id))

/** A member's whole turn, as the Harness reports it. */
async function speak(group: Group, id: string, text: string, opts: { tools?: boolean; completed?: boolean } = {}) {
  const session = seat(group, id)
  const last = to(group, id).at(-1)
  groups.turnInput(session, last?.source ?? { kind: 'user' })
  groups.turnOutput(session, text, opts.tools ?? true)
  await groups.turnEnded(session, opts.completed ?? true)
}

async function team() {
  return groups.create({ title: '单细胞小组', members: ['总管', '林分析', 'Zhao'], admin: '总管', notice: '只用公开数据。' })
}

describe('mentions', () => {
  const members = [{ id: 'lin', name: '林分析' }, { id: 'zhao', name: 'Zhao' }, { id: 'zz', name: 'Zhao Writer' }]
  it('follows the shared rules', () => {
    expect(parseMentions('@林分析帮我看看', members).bots).toEqual(['lin'])
    expect(parseMentions('@Zhao Writer and @zhao', members).bots).toEqual(['zz', 'zhao'])
    expect(parseMentions('mail me at a@Zhao.com', members).bots).toEqual([])
    expect(parseMentions('@Zhaox', members).bots).toEqual([])
    expect(parseMentions('see `@林分析` and [x](http://h/@Zhao)', members).bots).toEqual([])
    expect(parseMentions('@所有人 开工', members)).toMatchObject({ everyone: true })
    expect(parseMentions('问一下 @用户', members)).toMatchObject({ user: true, bots: [] })
  })
})

describe('managing groups', () => {
  it('gives every member a seat, announces the seats once recorded, and logs the founding', async () => {
    const group = await team()
    expect(seated).toEqual([Object.values(group.sessions)])
    expect(group).toMatchObject({ title: '单细胞小组', members: ['main', 'lin', 'zhao'], admin: 'main', approvals: 'admin', adminMayApprove: false, userIn: true })
    expect(Object.keys(group.sessions)).toEqual(['main', 'lin', 'zhao'])
    expect(groups.forSession(seat(group, 'lin'))!.bot.id).toBe('lin')
    expect(groups.entries(group.id).map(e => e.text)).toEqual(['建群：总管、林分析、Zhao,管理员 总管'])
  })

  it('refuses bad groups', async () => {
    await team()
    await expect(groups.create({ title: '单细胞小组', members: ['lin'] })).rejects.toMatchObject({ code: 'title_taken' })
    await expect(groups.create({ title: 'x', members: [] })).rejects.toMatchObject({ code: 'invalid_group' })
    await expect(groups.create({ title: 'x', members: ['nobody'] })).rejects.toMatchObject({ code: 'invalid_group' })
    await expect(groups.create({ title: 'x', members: ['lin'], admin: 'Zhao' })).rejects.toMatchObject({ code: 'not_member' })
    bots.push(...Array.from({ length: GROUP_LIMITS.members }, (_, i) => bot(`b${i}`, `B${i}`)))
    await expect(groups.create({ title: 'big', members: bots.map(b => b.id) })).rejects.toThrow(/at most/)
  })

  it('adds seats for new members, logs the change and drops a deleted bot', async () => {
    const group = await team()
    bots.push(bot('wu', 'Wu'))
    const updated = await groups.update(group.id, { members: ['main', 'lin', 'zhao', 'Wu'], notice: '新公告' })
    expect(updated.sessions.wu).toBeDefined()
    expect(seated.at(-1)).toEqual([updated.sessions.wu])
    expect(groups.entries(group.id).map(e => e.text)).toContain('Wu 进群')
    await groups.removeBot('main')
    expect(groups.get(group.id)).toMatchObject({ members: ['lin', 'zhao', 'wu'] })
    expect(groups.get(group.id)!.admin).toBeUndefined()
  })
})

describe('who answers', () => {
  it('sends a user message that mentions nobody to the admin, with what was said since its last turn', async () => {
    const group = await team()
    await groups.post(group.id, '把 pbmc 先做 QC')
    const [first] = to(group, 'main')
    expect(first!.source).toMatchObject({ type: 'group', job: group.id, reason: 'admin_routed' })
    expect(first!.text).toContain('[用户] 把 pbmc 先做 QC')
    expect(first!.text).toContain('建群')
    expect(to(group, 'lin')).toHaveLength(0)
  })

  it('wakes whoever is mentioned, and the admin once more after its batch answered', async () => {
    const group = await team()
    await groups.post(group.id, '开始吧')
    await speak(group, 'main', '@林分析 做 QC,@Zhao 等结果写摘要')
    expect(to(group, 'lin')).toHaveLength(1)
    expect(to(group, 'zhao')).toHaveLength(1)
    expect(to(group, 'lin')[0]!.text).toContain('[总管] @林分析 做 QC')
    await speak(group, 'lin', 'QC 做完了，剩 2600 个细胞。')
    expect(to(group, 'main')).toHaveLength(1)
    await speak(group, 'zhao', '[PASS]')
    expect(to(group, 'main')).toHaveLength(2)
    expect(to(group, 'main')[1]!.source.reason).toBe('batch_done')
    expect(to(group, 'main')[1]!.text).toContain('[林分析] QC 做完了')
    expect(groups.entries(group.id).some(e => e.text === '[PASS]')).toBe(false)
  })

  it('does not wake the admin twice when an answer already calls on it', async () => {
    const group = await team()
    await groups.post(group.id, '开始吧')
    await speak(group, 'main', '@林分析 做 QC')
    await speak(group, 'lin', '做完了 @总管')
    expect(to(group, 'main')).toHaveLength(2)
  })

  it('lets only the admin call on everyone', async () => {
    const group = await team()
    await groups.post(group.id, '开始吧')
    await speak(group, 'main', '@所有人 报一下进度')
    expect(to(group, 'lin')).toHaveLength(1)
    expect(to(group, 'zhao')).toHaveLength(1)
    await speak(group, 'lin', '@all 我好了')
    expect(to(group, 'zhao')).toHaveLength(1)
  })

  it('pauses after rounds between bots with no tool use, until the user speaks', async () => {
    const group = await team()
    await groups.post(group.id, '聊聊')
    for (let i = 0; i < GROUP_LIMITS.idleRounds; i++) {
      await speak(group, i % 2 === 0 ? 'main' : 'lin', i % 2 === 0 ? '@林分析 你觉得呢' : '@总管 我也不确定', { tools: false })
    }
    const paused = groups.get(group.id)!
    expect(paused.paused).toBe(true)
    expect(groups.entries(group.id).at(-1)!.text).toContain('先停下了')
    const before = delivered.length
    await speak(group, 'main', '@林分析 再想想', { tools: false })
    expect(delivered.length).toBe(before)
    await groups.post(group.id, '继续')
    expect(groups.get(group.id)!.paused).toBe(false)
  })

  it('keeps the user out of groups they left', async () => {
    const group = await groups.create({ title: 'bots only', members: ['lin', 'zhao'], userIn: false })
    await expect(groups.post(group.id, 'hi')).rejects.toMatchObject({ code: 'not_member' })
  })
})

describe('group goals', () => {
  const plan = { objective: '完成 pbmc 的预处理和注释', done_when: '有注释好的 h5ad 和一页摘要', stages: [
    { title: 'QC', owner: '林分析', done_when: 'qc.h5ad 存在' },
    { title: '写摘要', owner: 'Zhao', done_when: 'summary.md 存在' },
  ] }

  it('only the admin plans, and nothing is handed out until the user starts', async () => {
    const group = await team()
    await expect(groups.plan(seat(group, 'lin'), plan)).rejects.toMatchObject({ code: 'not_admin' })
    expect(await groups.plan(seat(group, 'main'), plan)).toContain('Planned 2 stages')
    expect(groups.get(group.id)!.goal).toMatchObject({ status: 'planning', current: 0 })
    expect(to(group, 'lin')).toHaveLength(0)
    await expect(groups.goalAction(group.id, 'resume')).rejects.toBeInstanceOf(GroupError)
  })

  it('runs stage by stage: owner works, admin checks, redo and pass', async () => {
    const group = await team()
    await groups.plan(seat(group, 'main'), plan)
    await groups.goalAction(group.id, 'start')
    const handed = to(group, 'lin').at(-1)!
    expect(handed.source.reason).toBe('goal_stage')
    expect(handed.text).toContain('[群目标]')
    expect(handed.text).toContain('这一阶段由你负责')
    await speak(group, 'lin', 'QC 完成，qc.h5ad 已写出。')
    expect(groups.get(group.id)!.goal!.stages[0]!.status).toBe('checking')
    const toCheck = to(group, 'main').at(-1)!
    expect(toCheck.source.reason).toBe('goal_check')
    expect(toCheck.text).toContain('林分析 已回复：对照完成标准核对证据')
    expect(await groups.check(seat(group, 'main'), { verdict: 'redo', note: '缺线粒体比例图' })).toContain('Sent back')
    expect(to(group, 'lin').at(-1)!.text).toContain('退回原因:缺线粒体比例图')
    await speak(group, 'lin', '补了线粒体比例图。')
    expect(await groups.check(seat(group, 'main'), { verdict: 'pass', evidence: 'qc.h5ad 和图都在' })).toContain('handed to Zhao')
    expect(to(group, 'zhao').at(-1)!.source.reason).toBe('goal_stage')
    await speak(group, 'zhao', 'summary.md 写好了。')
    expect(await groups.check(seat(group, 'main'), { verdict: 'pass', evidence: 'summary.md 在' })).toContain('goal is done')
    expect(groups.get(group.id)!.goal).toMatchObject({ status: 'done', current: 2 })
    expect(groups.entries(group.id).at(-1)!.text).toBe('目标完成:完成 pbmc 的预处理和注释')
  })

  it('waits for the user after three send-backs, and the user speaking resumes it', async () => {
    const group = await team()
    await groups.plan(seat(group, 'main'), plan)
    await groups.goalAction(group.id, 'start')
    for (let i = 0; i < GROUP_LIMITS.redoLimit; i++) {
      await speak(group, 'lin', `第 ${i + 1} 次`)
      await groups.check(seat(group, 'main'), { verdict: 'redo', note: `还不行 ${i}` })
    }
    expect(groups.get(group.id)!.goal!.status).toBe('waiting_user')
    await groups.post(group.id, '先这样，过吧')
    expect(groups.get(group.id)!.goal!.status).toBe('active')
  })

  it('does not count a turn queued before the stage started as the stage\'s answer', async () => {
    const group = await team()
    const adminPlan = { ...plan, stages: [{ title: '定方案', owner: '总管', done_when: '方案写好' }, { title: '复核', owner: '总管', done_when: '复核完' }] }
    await groups.plan(seat(group, 'main'), adminPlan)
    await groups.goalAction(group.id, 'start')
    const stageOne = to(group, 'main').at(-1)!
    // The admin works stage one and passes it in the same turn; stage two is handed to it again.
    groups.turnInput(seat(group, 'main'), stageOne.source)
    await groups.check(seat(group, 'main'), { verdict: 'pass', evidence: '方案在 plan.md' })
    groups.turnOutput(seat(group, 'main'), '方案定了。', true)
    await groups.turnEnded(seat(group, 'main'), true)
    expect(groups.get(group.id)!.goal!.stages[1]!.status).toBe('working')
  })

  it('pauses, resumes, stops and clears on the user\'s word', async () => {
    const group = await team()
    await groups.plan(seat(group, 'main'), plan)
    await groups.goalAction(group.id, 'start')
    await groups.goalAction(group.id, 'pause')
    expect(groups.get(group.id)!.goal!.status).toBe('paused')
    const before = to(group, 'lin').length
    await groups.goalAction(group.id, 'resume')
    expect(to(group, 'lin').length).toBe(before + 1)
    await groups.goalAction(group.id, 'stop')
    await expect(groups.goalAction(group.id, 'stop')).rejects.toMatchObject({ code: 'invalid_state' })
    await groups.goalAction(group.id, 'clear')
    expect(groups.get(group.id)!.goal).toBeUndefined()
  })

  it('tells members the group\'s standing rules, and the admin its extra role', async () => {
    const group = await team()
    expect(groups.context(group, 'lin')).toContain('your seat in the group "单细胞小组"')
    expect(groups.context(group, 'lin')).toContain('never just to thank')
    expect(groups.context(group, 'lin')).toContain('Group notice: 只用公开数据。')
    expect(groups.context(group, 'lin')).not.toContain('You are this group\'s admin')
    expect(groups.context(group, 'main')).toContain('You are this group\'s admin')
  })
})
