import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Bot } from '../shared/types.ts'
import type { Courier } from './courier.ts'
import type { Watcher } from './evidence.ts'
import type { Groups } from './groups.ts'
import { roleLine } from './identity.ts'
import { AGENDA_ACTIONS, MEMORY_KINDS, type Mind } from './mind.ts'

const text = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const

export interface ToolDeps {
  courier: Courier
  mind: Mind
  watcher: Watcher
  groups: Groups
  /** Search the caller's own conversation. */
  searchOwn: (sessionId: string, query: string, limit: number | undefined) => Promise<string>
}

/**
 * The bot whose conversation is calling (its own or one of its group seats),
 * or a refusal.
 */
function caller(courier: Courier, groups: Groups, exec: { agent?: { id: unknown } }): { bot: Bot; session: string; inGroup: boolean } {
  const session = exec.agent === undefined ? undefined : String(exec.agent.id)
  const own = session === undefined ? undefined : courier.botForSession(session)
  const seat = session === undefined || own !== undefined ? undefined : groups.forSession(session)
  const bot = own ?? seat?.bot
  if (bot === undefined || session === undefined) throw new Error('this tool works only in a bot\'s conversation')
  return { bot, session, inGroup: seat !== undefined }
}

/**
 * Tools a bot conversation gets. They are registered on each bot's own agent
 * context, so ordinary Harness conversations never see them, and every bot
 * sees the same definitions (the tool list stays cache-identical).
 */
export function botTools({ courier, mind, watcher, groups, searchOwn }: ToolDeps) {
  const who = (exec: { agent?: { id: unknown } }) => caller(courier, groups, exec)
  const list = defineTool({
    name: 'bot_list',
    description: 'List the other bots you can message with bot_send: their names, what they do, and which one is the coordinator.',
    parameters: {},
    output: text,
    async execute(_args, exec) {
      const me = exec.agent === undefined ? undefined : who(exec).bot
      const others = courier.bots().filter(bot => bot.id !== me?.id)
      if (others.length === 0) return 'There are no other bots yet.'
      return others.map(bot => {
        const role = roleLine(bot)
        return `${bot.name}${bot.isMain ? ' (coordinator)' : ''} [${bot.id}]${role === '' ? '' : ` — ${role}`}`
      }).join('\n')
    },
  })

  const send = defineTool({
    name: 'bot_send',
    description: 'Send another bot a message or a piece of work. By default it is a request: the bot works on it in its own conversation and its answer comes back to you later as a new message (do not wait or poll). Set expect_reply to false for a note that needs no answer.',
    parameters: {
      to: { type: 'string', required: true, description: 'The bot\'s name or id.' },
      message: { type: 'string', required: true, description: 'What you want, with everything the bot needs: it cannot see this conversation.' },
      expect_reply: { type: 'boolean', description: 'Whether you want an answer back. Defaults to true.' },
    },
    output: text,
    async execute(args, exec) {
      const { session, inGroup } = who(exec)
      if (inGroup) throw new Error('in a group, hand someone the floor with @name in your answer instead of bot_send')
      const receipt = await courier.send({
        callerSession: session,
        to: args.to,
        text: args.message,
        ...(args.expect_reply === undefined ? {} : { expectReply: args.expect_reply }),
      })
      return receipt.expectReply
        ? `Sent to ${receipt.to} (job ${receipt.job}). Its answer will arrive as a new message in this conversation; finish what you can now and end your turn.`
        : `Delivered to ${receipt.to}. No reply expected.`
    },
  })

  const note = defineTool({
    name: 'memory_note',
    description: 'Keep something in your own long-term memory. Use kind "record" for what happened or what someone said, "inference" for a conclusion you drew, and "correction" when something you believed or did turned out wrong (name the entry it corrects, or who it is about). Set about to "user" or a bot\'s name when the note concerns them: what they asked for, refused, prefer or corrected.',
    parameters: {
      kind: { type: 'string', required: true, enum: [...MEMORY_KINDS], description: 'record, inference or correction.' },
      text: { type: 'string', required: true, description: 'The note, self-contained.' },
      about: { type: 'string', description: '"user" or a bot\'s name, when the note concerns them.' },
      corrects: { type: 'string', description: 'Id of the memory entry this corrects (for example m3f2a…).' },
    },
    output: text,
    async execute(args, exec) {
      const { bot, session } = who(exec)
      const entry = await mind.note(bot.id, {
        kind: args.kind, text: args.text,
        ...(args.about === undefined ? {} : { about: args.about }),
        ...(args.corrects === undefined ? {} : { corrects: args.corrects }),
      }, session)
      return `Kept as ${entry.id}${entry.corrects ? `, replacing ${entry.corrects}` : ''}.`
    },
  })

  const recall = defineTool({
    name: 'memory_search',
    description: 'Search your own long-term memory, including entries a correction replaced. Every word must appear. Without a query, returns your newest entries.',
    parameters: {
      query: { type: 'string', description: 'Words to look for.' },
      limit: { type: 'integer', description: 'At most this many entries (default 10, max 50).' },
    },
    output: text,
    async execute(args, exec) {
      const { bot } = who(exec)
      const found = mind.search(bot.id, args.query, args.limit ?? 10)
      if (found.length === 0) return 'Nothing in your memory matches.'
      return found.map(entry => {
        const about = entry.about === undefined ? '' : entry.about === 'user' ? ' about the user' : ` about ${courier.bots().find(b => b.id === entry.about)?.name ?? entry.about}`
        const status = entry.correctedBy ? ` — replaced by ${entry.correctedBy}` : ''
        return `[${entry.id}] ${entry.at.slice(0, 16).replace('T', ' ')} ${entry.kind}${about}${entry.corrects ? ` (corrects ${entry.corrects})` : ''}${status}: ${entry.text}`
      }).join('\n')
    },
  })

  const agenda = defineTool({
    name: 'agenda_update',
    description: 'Change your agenda: the goals you are pursuing beyond this turn, in your order. add a goal, revise its wording or position, mark it done, drop it, or reopen it. Always say why, and what prompted the change when something did (a message, new data, a failure).',
    parameters: {
      action: { type: 'string', required: true, enum: [...AGENDA_ACTIONS], description: 'add, revise, done, drop or reopen.' },
      id: { type: 'string', description: 'The goal to change (not for add).' },
      goal: { type: 'string', description: 'The goal, for add or a reworded revise.' },
      position: { type: 'integer', description: '1-based place among open goals; 1 is next.' },
      reason: { type: 'string', required: true, description: 'Why you are making this change.' },
      prompted_by: { type: 'string', description: 'What prompted it, for example "evidence: new file results/day7.csv".' },
    },
    output: text,
    async execute(args, exec) {
      const { bot } = who(exec)
      const item = await mind.plan(bot.id, {
        action: args.action, reason: args.reason,
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.goal === undefined ? {} : { goal: args.goal }),
        ...(args.position === undefined ? {} : { position: args.position }),
        ...(args.prompted_by === undefined ? {} : { trigger: args.prompted_by }),
      })
      return `${item.id} is ${item.state}. ${mind.agendaDigest(bot.id)}`
    },
  })

  const watch = defineTool({
    name: 'watch_folder',
    description: 'Be woken when files in a folder change while you are idle, so new evidence can change your plans without anyone asking. add a folder with a note on why it matters, remove a watch by id, or list your watches. Changes you make yourself do not wake you.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'remove', 'list'], description: 'add, remove or list.' },
      path: { type: 'string', description: 'Absolute folder path, for add.' },
      note: { type: 'string', description: 'Why this folder matters, shown to you when it wakes you.' },
      id: { type: 'string', description: 'The watch to remove.' },
    },
    output: text,
    async execute(args, exec) {
      const { bot } = who(exec)
      if (args.action === 'add') {
        if (args.path === undefined) throw new Error('add needs a path')
        const added = await watcher.add(bot.id, args.path, args.note ?? '')
        return `Watching ${added.path} as ${added.id}.`
      }
      if (args.action === 'remove') {
        if (args.id === undefined) throw new Error('remove needs an id')
        return (await watcher.remove(bot.id, args.id)) ? `Stopped watching ${args.id}.` : `You have no watch ${args.id}.`
      }
      const mine = watcher.list(bot.id)
      return mine.length === 0 ? 'You watch no folders.' : mine.map(w => `[${w.id}] ${w.path}${w.note === '' ? '' : ` — ${w.note}`}`).join('\n')
    },
  })

  const search = defineTool({
    name: 'search_own',
    description: 'Search back through this conversation of yours, including turns that no longer fit in context. Every word must appear. Results show who said it: you, the user, another bot, or an evidence notice.',
    parameters: {
      query: { type: 'string', required: true, description: 'Words to look for.' },
      limit: { type: 'integer', description: 'At most this many results (default 8, max 20).' },
    },
    output: text,
    async execute(args, exec) {
      const { session } = who(exec)
      return searchOwn(session, args.query, args.limit)
    },
  })

  const plan = defineTool({
    name: 'goal_plan',
    description: 'Group admins only, in the group: propose the group\'s goal as stages, each owned by a member, with a completion standard for the whole goal and for each stage. The user starts it; the plugin then hands each stage to its owner. While a goal runs, this replaces the stages from the current one on.',
    parameters: {
      objective: { type: 'string', required: true, description: 'What the group is to achieve.' },
      done_when: { type: 'string', required: true, description: 'How everyone will know the goal is achieved.' },
      stages: {
        type: 'array', required: true, description: 'The stages in order.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'What this stage does.' },
            owner: { type: 'string', required: true, description: 'The member who does it (name).' },
            done_when: { type: 'string', required: true, description: 'Evidence that the stage is finished.' },
          },
        },
      },
    },
    output: text,
    async execute(args, exec) {
      const { session } = who(exec)
      return groups.plan(session, args as never)
    },
  })

  const check = defineTool({
    name: 'goal_check',
    description: 'Group admins only, in the group: judge the current stage against its completion standard. pass (with evidence) hands the next stage out; redo (with a note) sends it back to its owner; ask_user (with a note) waits for the user.',
    parameters: {
      verdict: { type: 'string', required: true, enum: ['pass', 'redo', 'ask_user'], description: 'pass, redo or ask_user.' },
      evidence: { type: 'string', description: 'For pass: what shows the standard is met.' },
      note: { type: 'string', description: 'For redo or ask_user: what to fix, or the question.' },
    },
    output: text,
    async execute(args, exec) {
      const { session } = who(exec)
      return groups.check(session, {
        verdict: args.verdict,
        ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
        ...(args.note === undefined ? {} : { note: args.note }),
      })
    },
  })

  return [list, send, note, recall, agenda, watch, search, plan, check]
}
