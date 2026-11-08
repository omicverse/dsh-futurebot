import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Bot, PermissionMode } from '../shared/types.ts'
import type { Mailbox, RelaySource } from './courier.ts'
import { REVIEW_TIMEOUT_MS, parseVerdict, reviewPrompt, type ReviewInput, type ReviewVerdict } from './approvals.ts'
import type { DigestCache } from './digests.ts'
import type { GroupPorts, GroupSource } from './groups.ts'
import type { EvidenceSource, WatchPort } from './evidence.ts'
import type { HistoryPort, HistoryRecord } from './history.ts'
import {
  AGENDA_CONTEXT, AGENDA_ORDER, GROUP_CONTEXT, GROUP_ORDER, IDENTITY_CONTEXT, IDENTITY_ORDER, MEMORY_CONTEXT, MEMORY_ORDER, TEAM_CONTEXT, TEAM_ORDER,
  identityText, teamText,
} from './identity.ts'
import type { BotSessions, SyncField } from './service.ts'

/** A short account injected into a running turn, e.g. why a reviewer denied a request. */
export interface NoticeSource {
  kind: 'futurebot'
  form: 'notice'
  summary: string
  type: 'notice'
  job: string
  from: string
}

/** Provenance of every message the plugin puts into a bot conversation. */
export type BotMessageSource = RelaySource | EvidenceSource | GroupSource | NoticeSource

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Work between bots (courier.ts), evidence (evidence.ts), group updates (groups.ts), notices. */
    'futurebot': BotMessageSource
    /** The input of an admin's review call; never part of a conversation. */
    'futurebot-review': { kind: 'futurebot-review' }
  }
}

/** Queue `text` as its own turn in a conversation, waking it; returns the message id. */
async function post(ctx: Context, sessionId: string, text: string, source: BotMessageSource | { kind: 'user' }): Promise<string> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`cannot open conversation ${sessionId}: ${JSON.stringify(resolved.error)}`)
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  // A follow-up is its own turn and wakes an idle agent; a busy one runs it next.
  resolved.agent.followup(message)
  return String(message.id)
}

/**
 * Permission presets the Harness ships. `read_only` has no preset of its own:
 * it is the approve-changes preset with the sandbox narrowed to read-only.
 */
const PRESET_FOR: Record<PermissionMode, string> = {
  read_only: 'workspace-write',
  auto: 'workspace-write',
  full: 'danger-full-access',
}

/**
 * Bot conversations are ordinary Harness sessions owned by the Web session
 * controller. Each bot's workspace is registered as a Harness Workspace
 * titled with the bot's name, so its conversation is listed, opened and
 * prompted exactly like any other.
 */
export class HarnessSessions implements BotSessions {
  constructor(private readonly ctx: Context) {}

  async create(bot: Bot): Promise<string> {
    const preset = bot.basePreset === undefined ? {} : { agentPreset: bot.basePreset }
    const workspace = await this.register(bot)
    const created = await this.ctx.sessionController.create(
      workspace === undefined ? { cwd: bot.workspace, ...preset } : { workspaceId: workspace, ...preset },
    )
    return String(created.sessionId)
  }

  /**
   * Register (idempotently) the bot's directory as a Workspace. The registry
   * groups sessions by canonical directory, so this also files a conversation
   * created before its Workspace existed. Returns undefined in a profile
   * without the registry.
   */
  async register(bot: Bot): Promise<WorkspaceId | undefined> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    return (await registry.create(bot.workspace, bot.name)).id
  }

  async sync(bot: Bot, fields: readonly SyncField[]): Promise<void> {
    if (bot.sessionId === undefined) return
    const sessionId = SessionId(bot.sessionId)
    const controller = this.ctx.sessionController
    if (fields.includes('name')) {
      await controller.rename({ sessionId, title: bot.name })
      const registry = this.ctx.get('workspaceRegistry')
      if (registry !== undefined) await (await registry.create(bot.workspace)).setTitle(bot.name)
    }
    if (fields.includes('model') && bot.model !== undefined) {
      await controller.selectModel({ sessionId, provider: bot.model.provider, model: bot.model.model })
    }
    if (fields.includes('permission')) {
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(`cannot open ${bot.name}'s conversation: ${JSON.stringify(resolved.error)}`)
      applyPermission(this.ctx, resolved.agent, bot.permission)
    }
  }
}

/** Write the bot's permission into its session through the Harness's own setters. */
export function applyPermission(ctx: Context, agent: Agent, mode: PermissionMode): void {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined) throw new Error('this profile has no permission presets; set the permission in the conversation')
  // `set` appends nothing when the preset is already in effect.
  presets.set(agent.session, PRESET_FOR[mode])
  if (mode === 'read_only') setSandboxMode(agent.session, 'read-only')
}

/** Puts bot messages into conversations as their own turns. */
export class HarnessMailbox implements Mailbox {
  constructor(private readonly ctx: Context) {}

  deliver(sessionId: string, text: string, source: RelaySource): Promise<string> {
    return post(this.ctx, sessionId, text, source)
  }

  async withdraw(sessionId: string, messageId: string): Promise<boolean> {
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
    if ('error' in resolved) return false
    return resolved.agent.inbox.remove(messageId as MessageId)
  }
}

/** Wakes a bot on evidence; a running turn means the change was its own. */
export class HarnessWatchPort implements WatchPort {
  constructor(private readonly ctx: Context) {}

  async wake(sessionId: string, text: string, source: EvidenceSource): Promise<void> {
    await post(this.ctx, sessionId, text, source)
  }

  busy(sessionId: string): boolean {
    return this.ctx.agents.get(SessionId(sessionId))?.status === 'running'
  }
}

/** Reads a conversation's durable log, newest pages first. */
export class HarnessHistory implements HistoryPort {
  constructor(private readonly ctx: Context) {}

  async page(sessionId: string, beforeSeq: number | undefined) {
    const page = await this.ctx.sessionController.page({
      address: { kind: 'session', sessionId: SessionId(sessionId) },
      maxMessages: 200,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }, AbortSignal.timeout(20_000))
    // Each record is a `{ type: 'event', event }` envelope around one logged event.
    return { records: page.records.map(record => record.event as unknown as HistoryRecord), hasMore: page.hasMore }
  }
}

/** Group conversations live in the member's workspace, titled after the group. */
export class HarnessGroupPorts implements GroupPorts {
  constructor(private readonly ctx: Context, private readonly sessions: HarnessSessions) {}

  async createSession(bot: Bot, title: string): Promise<string> {
    const preset = bot.basePreset === undefined ? {} : { agentPreset: bot.basePreset }
    const workspace = await this.sessions.register(bot)
    const created = await this.ctx.sessionController.create(
      workspace === undefined ? { cwd: bot.workspace, ...preset } : { workspaceId: workspace, ...preset },
    )
    const sessionId = String(created.sessionId)
    await this.ctx.sessionController.rename({ sessionId: created.sessionId, title }).catch(() => undefined)
    if (bot.model !== undefined) {
      await this.ctx.sessionController.selectModel({ sessionId: created.sessionId, provider: bot.model.provider, model: bot.model.model }).catch(() => undefined)
    }
    const resolved = await this.ctx.sessionController.resolveAgent(created.sessionId)
    if (!('error' in resolved)) applyPermission(this.ctx, resolved.agent, bot.permission)
    return sessionId
  }

  deliver(sessionId: string, text: string, source: GroupSource): Promise<string> {
    return post(this.ctx, sessionId, text, source)
  }
}

/** The model side of an admin's review: one short call, outside any conversation. */
export class HarnessReviewer {
  constructor(private readonly ctx: Context) {}

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    if (input.route === undefined) throw new Error('no model to review with')
    const { system, user } = reviewPrompt(input)
    const signal = AbortSignal.timeout(REVIEW_TIMEOUT_MS)
    // Not in the plugin's inject list (bots work without a review model), so read it optionally.
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('no model service in this profile')
    // Reasoning models spend part of the budget thinking before the one-line answer.
    const call = await llm.prepareCall({ provider: input.route.provider, model: input.route.model, maxTokens: 1500 }, signal)
    const messages = [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'futurebot-review' } })]
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream({ ...call.config, messages, system, purpose: 'futurebot-review' as never, signal })) assembler.push(chunk)
    const blocks = assembler.blocks() as { type: string; text?: string }[]
    const answer = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    // Some models put the JSON at the end of their reasoning and leave the answer short.
    if (/\{[\s\S]*\}/.test(answer)) return parseVerdict(answer)
    return parseVerdict(blocks.filter(block => block.type === 'reasoning').map(block => block.text ?? '').join('\n'))
  }

  /** The model a conversation currently runs on. */
  route(sessionId: string): { provider: string; model: string } | undefined {
    const selection = this.ctx.agents.get(SessionId(sessionId))?.model.current()
    return selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
  }

  /** Tell a running turn something, without waking an idle one. */
  tell(sessionId: string, text: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    agent?.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'futurebot', form: 'notice', summary: text.slice(0, 200), type: 'notice', job: '', from: 'review' },
    }))
  }
}

/** What the HTTP API needs to talk to a bot as the user. */
export interface Conversations {
  say(sessionId: string, text: string): Promise<string>
  cursor(sessionId: string): Promise<number>
  /** The conversation is blocked on the user (a question or an approval nobody answered yet). */
  waitingOnUser(sessionId: string): Promise<boolean>
  /** Wait until the conversation is idle; the newest answer after `after`, if any. */
  wait(sessionId: string, after: number, timeoutMs: number): Promise<{ reason: string; cursor: number; answer?: string; running: boolean }>
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n')
}

export class HarnessConversations implements Conversations {
  constructor(private readonly ctx: Context) {}

  say(sessionId: string, text: string): Promise<string> {
    return post(this.ctx, sessionId, text, { kind: 'user' })
  }

  async cursor(sessionId: string): Promise<number> {
    return (await this.ctx.sessionController.state({ sessionId: SessionId(sessionId) }, AbortSignal.timeout(10_000))).cursor
  }

  async waitingOnUser(sessionId: string): Promise<boolean> {
    const state = await this.ctx.sessionController.state({ sessionId: SessionId(sessionId) }, AbortSignal.timeout(10_000))
    return state.pendingInput.length > 0
  }

  async wait(sessionId: string, after: number, timeoutMs: number) {
    const value = await this.ctx.sessionController.wait(
      { sessionId: SessionId(sessionId), afterSeq: after, timeoutMs, maxMessages: 5 },
      AbortSignal.timeout(timeoutMs + 10_000),
    )
    // Assistant records, newest first, each a `{ type: 'event', event }` envelope.
    const newest = value.output.records[0]?.event as unknown as { data?: { message?: { content?: unknown } } } | undefined
    const answer = textOf(newest?.data?.message?.content)
    return { reason: value.reason, cursor: value.state.cursor, running: value.state.running, ...(answer === '' ? {} : { answer }) }
  }
}

export interface AttachmentSources {
  /** The bot whose conversation this session is. */
  lookup: (sessionId: string) => Bot | undefined
  /** Every bot, for the team context. */
  roster: () => readonly Bot[]
  /** Tools every bot conversation gets. */
  tools: () => readonly ToolDefinition[]
  /** The bot's memory and agenda, as prompt text. */
  memory: (botId: string) => string
  agenda: (botId: string) => string
  /** Holds memory and agenda text steady between refreshes. */
  digests: DigestCache
  /** Standing rules of the group this conversation is a seat in; empty elsewhere. */
  group: (sessionId: string) => string
}

/**
 * Per-agent registrations. Each bot conversation's live Agent gets, in its
 * own scope: an identity context, a team context and the bot tools. The
 * contexts read the records on every assembly, so an edit reaches the next
 * model step without re-attaching.
 */
export class Attachments {
  private readonly disposers = new Map<string, () => void>()

  constructor(private readonly sources: AttachmentSources) {}

  attach(agent: Agent): void {
    const id = String(agent.id)
    const { lookup, roster, tools, memory, agenda, digests, group } = this.sources
    if (this.disposers.has(id) || lookup(id) === undefined) return
    const dispose = agent.ctx.effect(() => {
      const disposers = [
        agent.ctx.systemPrompt.context({
          name: IDENTITY_CONTEXT,
          order: IDENTITY_ORDER,
          interpolate: false,
          required: true,
          text: () => {
            const bot = lookup(id)
            return bot === undefined ? '' : identityText(bot)
          },
        }),
        agent.ctx.systemPrompt.context({
          name: TEAM_CONTEXT,
          order: TEAM_ORDER,
          interpolate: false,
          required: true,
          text: () => {
            const bot = lookup(id)
            return bot === undefined ? '' : teamText(bot, roster())
          },
        }),
        agent.ctx.systemPrompt.context({
          name: MEMORY_CONTEXT,
          order: MEMORY_ORDER,
          interpolate: false,
          required: true,
          text: () => {
            const bot = lookup(id)
            return bot === undefined ? '' : digests.get(id, 'memory', () => memory(bot.id))
          },
        }),
        agent.ctx.systemPrompt.context({
          name: AGENDA_CONTEXT,
          order: AGENDA_ORDER,
          interpolate: false,
          required: true,
          text: () => {
            const bot = lookup(id)
            return bot === undefined ? '' : digests.get(id, 'agenda', () => agenda(bot.id))
          },
        }),
        agent.ctx.systemPrompt.context({
          name: GROUP_CONTEXT,
          order: GROUP_ORDER,
          interpolate: false,
          required: true,
          text: () => (lookup(id) === undefined ? '' : group(id)),
        }),
        ...tools().map(tool => agent.ctx.tools.register(tool)),
      ]
      return () => { for (const release of disposers.reverse()) release() }
    }, 'futurebot: identity, team and tools')
    this.disposers.set(id, dispose)
  }

  detach(sessionId: string): void {
    const dispose = this.disposers.get(sessionId)
    this.disposers.delete(sessionId)
    dispose?.()
  }

  /** Forget an agent the Harness already disposed; its registrations went with it. */
  forget(sessionId: string): void {
    this.disposers.delete(sessionId)
    this.sources.digests.forget(sessionId)
  }

  has(sessionId: string): boolean {
    return this.disposers.has(sessionId)
  }

  dispose(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
  }
}
