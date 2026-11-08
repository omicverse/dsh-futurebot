import type { Bot } from '../shared/types.ts'
import type { Group, LogEntry } from './groups.ts'

/**
 * Who answers a bot's approval request.
 *
 * The Harness asks before a tool call that needs it (in practice: stepping
 * outside the sandbox). For a bot conversation the plugin answers first:
 *
 * 1. Same kind of operation, same conversation, already allowed once and the
 *    bot asks once per conversation → allowed, no question.
 * 2. A group member whose group has its admin review first → the admin judges
 *    with one short model call. It may deny (the reason reaches the member) or
 *    hand the request to the user. It may approve only when the user turned
 *    that on for the group: the Harness's own rule is that approving a tool
 *    call is the user's.
 * 3. Everything else, and anything uncertain or failed → the user, through
 *    the Harness's usual approval prompt.
 */

export type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalAsk {
  sessionId: string
  toolName: string
  reason?: string
}

export interface ReviewVerdict {
  decision: 'approve' | 'deny' | 'ask_user'
  reason: string
}

export interface ReviewInput {
  /** The model to review with: the admin's, else the requester's current one. */
  route?: { provider: string; model: string }
  admin: Bot
  requester: Bot
  group: Group
  recent: LogEntry[]
  names: (id: string) => string
  toolName: string
  reason?: string
}

export interface ApprovalPorts {
  /** Where this conversation belongs. */
  locate(sessionId: string): { bot: Bot; group?: Group } | undefined
  /** The model a conversation currently runs on. */
  route(sessionId: string): { provider: string; model: string } | undefined
  /** The admin's one-line judgement; throws or times out → the user decides. */
  review(input: ReviewInput): Promise<ReviewVerdict>
  /** Recent group log for the reviewer. */
  recent(groupId: string): LogEntry[]
  names(id: string): string
  /** Put a notice in the requester's running turn (the reason for a denial). */
  tell(sessionId: string, text: string): void
  /** Write the review decision into the group log. */
  record(groupId: string, admin: string, text: string): Promise<void>
}

export const REVIEW_TIMEOUT_MS = 90_000

/** Parse the reviewer's reply: one JSON object, possibly wrapped in prose or a code fence. */
export function parseVerdict(text: string): ReviewVerdict {
  const match = /\{[\s\S]*\}/.exec(text)
  if (match === null) throw new Error('the reviewer did not answer with JSON')
  const value = JSON.parse(match[0]) as Record<string, unknown>
  const decision = value.decision
  if (decision !== 'approve' && decision !== 'deny' && decision !== 'ask_user') throw new Error(`unknown decision ${String(decision)}`)
  const reason = typeof value.reason === 'string' && value.reason.trim() !== '' ? value.reason.trim() : '(no reason given)'
  return { decision, reason }
}

/** The reviewer's prompt: who it is, the group, who asks, the last lines, the operation. */
export function reviewPrompt(input: ReviewInput): { system: string; user: string } {
  const system = [
    `You are ${input.admin.name}, the admin of the group "${input.group.title}". A member's operation needs approval and you review it first.`,
    input.admin.instructions === '' ? '' : `Your standing instructions from the user:\n${input.admin.instructions}`,
    'Approve only routine steps that clearly serve the group\'s current work. Deny with a reason the member can act on when the step is wrong or unnecessary. Choose ask_user when you are unsure, when it spends money, touches anything outside the members\' workspaces, or cannot be undone.',
    'Reply with exactly one line of JSON: {"decision": "approve" | "deny" | "ask_user", "reason": "one sentence"}',
  ].filter(line => line !== '').join('\n\n')
  const user = [
    `Group notice: ${input.group.notice || '(none)'}`,
    `Requester: ${input.requester.name}, workspace ${input.requester.workspace}, permission ${input.requester.permission}.`,
    'Recent group messages:',
    ...input.recent.map(entry => `[${input.names(entry.from)}] ${entry.text.replace(/\s+/g, ' ').slice(0, 300)}`),
    `Operation: ${input.toolName}${input.reason ? ` — ${input.reason}` : ''}`,
  ].join('\n')
  return { system, user }
}

export class ApprovalPolicy {
  /** `session \u0000 tool` pairs the user (or a permitted admin) already allowed. */
  private readonly allowed = new Set<string>()

  constructor(private readonly ports: ApprovalPorts, private readonly timeoutMs = REVIEW_TIMEOUT_MS) {}

  async decide(ask: ApprovalAsk, next: () => Promise<Outcome>): Promise<Outcome> {
    const where = this.ports.locate(ask.sessionId)
    if (where === undefined) return next()
    const { bot, group } = where
    const key = `${ask.sessionId}\u0000${ask.toolName}`
    const oncePerChat = bot.approvalScope === 'once_per_chat'
    if (oncePerChat && this.allowed.has(key)) return 'allowed-once'

    let adminView: ReviewVerdict | undefined
    if (group !== undefined && group.approvals === 'admin' && group.admin !== undefined && group.admin !== bot.id) {
      const admin = this.adminOf(group)
      if (admin !== undefined) {
        const route = admin.model ?? (group.sessions[admin.id] === undefined ? undefined : this.ports.route(group.sessions[admin.id]!)) ?? this.ports.route(ask.sessionId)
        adminView = await this.reviewWithTimeout({
          ...(route === undefined ? {} : { route }),
          admin, requester: bot, group, recent: this.ports.recent(group.id), names: id => this.ports.names(id), toolName: ask.toolName, ...(ask.reason ? { reason: ask.reason } : {}),
        })
        const verb = adminView.decision === 'deny' ? '拒绝了' : adminView.decision === 'approve' && group.adminMayApprove ? '批准了' : '转给用户决定'
        await this.ports.record(group.id, admin.id, `${admin.name} ${verb} ${bot.name} 的 ${ask.toolName}:${adminView.reason}`).catch(() => undefined)
        if (adminView.decision === 'deny') {
          this.ports.tell(ask.sessionId, `Your ${ask.toolName} request was denied by ${admin.name} (your reviewer): ${adminView.reason}`)
          return 'rejected'
        }
        if (adminView.decision === 'approve' && group.adminMayApprove) {
          if (oncePerChat) this.allowed.add(key)
          return 'allowed-once'
        }
      }
    }
    const outcome = await next()
    if (outcome === 'allowed-once' && oncePerChat) this.allowed.add(key)
    return outcome
  }

  private adminOf(group: Group): Bot | undefined {
    if (group.admin === undefined) return undefined
    const session = group.sessions[group.admin]
    return session === undefined ? undefined : this.ports.locate(session)?.bot
  }

  private async reviewWithTimeout(input: ReviewInput): Promise<ReviewVerdict> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.ports.review(input),
        new Promise<ReviewVerdict>((_, reject) => { timer = setTimeout(() => reject(new Error('the review timed out')), this.timeoutMs) }),
      ])
    } catch (error) {
      return { decision: 'ask_user', reason: `review unavailable (${error instanceof Error ? error.message : String(error)})` }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
