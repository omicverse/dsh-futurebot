import { randomUUID } from 'node:crypto'
import type { Bot } from '../shared/types.ts'
import { botReply, fromBot, type ReplyStatus } from './wrappers.ts'

/**
 * Work between bots, with the same rules as OmicOS:
 *
 * - A job is one `bot_send` that expects a reply. It enters the recipient's
 *   conversation as a message of its own, which wakes it.
 * - When the recipient's turn that handled the job ends, its final answer is
 *   the reply: the plugin wraps it and delivers it to the sender, which wakes
 *   the sender. No reply tool is involved.
 * - A job whose recipient handed work further down waits for those children;
 *   each child's reply re-enters the recipient's conversation and makes the
 *   parent job current again.
 * - A bot may not message a bot that is waiting for its own answer.
 * - After a restart, undelivered messages are delivered and jobs whose turn
 *   was cut short are handed over again once.
 */

export type JobState =
  | 'queued' | 'delivered' | 'answering' | 'waiting_children'
  | 'returned' | 'failed' | 'stopped' | 'unknown'
  /** A message that expects no reply has entered the recipient's turn. */
  | 'read'

const FINISHED: ReadonlySet<JobState> = new Set(['returned', 'failed', 'stopped', 'unknown', 'read'])

export interface Job {
  id: string
  from: string
  to: string
  text: string
  expectReply: boolean
  /** The job the sender was answering when it sent this one. */
  parent?: string
  root: string
  depth: number
  /** The sender's conversation: where the reply goes. */
  originSession: string
  targetSession: string
  state: JobState
  messageId?: string
  resumed?: boolean
  reply?: string
  replyMessageId?: string
  /** The reply has entered the sender's conversation. */
  replyEntered?: boolean
  createdAt: string
  updatedAt: string
}

export interface JobTable {
  get(id: string): Job | undefined
  entries(): Iterable<[string, Job]>
  put(id: string, job: Job): Promise<void>
  delete(id: string): Promise<boolean>
}

/** Provenance of a message the plugin puts into a bot conversation. */
export interface RelaySource {
  kind: 'futurebot'
  form: 'relay'
  type: 'request' | 'reply'
  job: string
  from: string
}

/** Puts messages into conversations; the Harness side of delivery. */
export interface Mailbox {
  /** Queue `text` as its own turn in the conversation, waking it; returns the message id. */
  deliver(sessionId: string, text: string, source: RelaySource): Promise<string>
  /** Take back a message still waiting in the conversation's inbox. */
  withdraw(sessionId: string, messageId: string): Promise<boolean>
}

/** The bots the courier can address. */
export interface Directory {
  get(id: string): Bot | undefined
  forSession(sessionId: string): Bot | undefined
  list(): Bot[]
}

export type CourierErrorCode = 'not_a_bot' | 'unknown_bot' | 'self' | 'no_conversation' | 'upstream' | 'too_deep' | 'too_many' | 'delivery_failed'

export class CourierError extends Error {
  constructor(readonly code: CourierErrorCode, message: string) {
    super(message)
    this.name = 'CourierError'
  }
}

export const CHAIN_LIMITS = { depth: 6, jobsPerChain: 40 } as const

export type TurnEnding = 'completed' | 'error' | 'aborted' | 'interrupted' | 'blocked' | 'max-tokens' | 'other'

const STATUS_FOR: Record<TurnEnding, ReplyStatus> = {
  completed: 'returned',
  'max-tokens': 'returned',
  other: 'returned',
  error: 'failed',
  blocked: 'failed',
  aborted: 'stopped',
  interrupted: 'unknown',
}

export interface SendRequest {
  callerSession: string
  to: string
  text: string
  expectReply?: boolean
}

export interface SendReceipt {
  job: string
  to: string
  expectReply: boolean
}

export interface CourierOptions {
  now?: () => Date
  newId?: () => string
  warn?: (message: string) => void
}

export function isRelaySource(value: unknown): value is RelaySource {
  if (typeof value !== 'object' || value === null) return false
  const source = value as Record<string, unknown>
  return source.kind === 'futurebot' && (source.type === 'request' || source.type === 'reply') && typeof source.job === 'string'
}

interface OpenTurn {
  jobs: string[]
  text: string
}

export class Courier {
  private readonly turns = new Map<string, OpenTurn>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly warn: (message: string) => void

  constructor(
    private readonly table: JobTable,
    private readonly mailbox: Mailbox,
    private readonly directory: Directory,
    options: CourierOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => `job_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
    this.warn = options.warn ?? (message => console.warn(`futurebot: ${message}`))
  }

  /** Find a bot by id or by name, ignoring case. */
  resolve(nameOrId: string): Bot | undefined {
    const wanted = nameOrId.trim().toLocaleLowerCase()
    return this.directory.get(nameOrId.trim()) ?? this.directory.list().find(bot => bot.name.toLocaleLowerCase() === wanted)
  }

  bots(): Bot[] {
    return this.directory.list()
  }

  botForSession(sessionId: string): Bot | undefined {
    return this.directory.forSession(sessionId)
  }

  jobs(): Job[] {
    return [...this.table.entries()].map(([, job]) => job)
  }

  send(request: SendRequest): Promise<SendReceipt> {
    return this.serial(async () => {
      const caller = this.directory.forSession(request.callerSession)
      if (caller === undefined) throw new CourierError('not_a_bot', 'only a bot conversation can message other bots')
      const target = this.resolve(request.to)
      if (target === undefined) {
        const names = this.directory.list().filter(bot => bot.id !== caller.id).map(bot => bot.name)
        throw new CourierError('unknown_bot', `no bot named ${request.to}; known bots: ${names.join(', ') || 'none'}`)
      }
      if (target.id === caller.id) throw new CourierError('self', 'you cannot message yourself')
      if (target.sessionId === undefined) throw new CourierError('no_conversation', `${target.name} has no conversation yet`)

      const answering = this.turns.get(request.callerSession)?.jobs ?? []
      const waiting = this.upstream(answering)
      if (waiting.has(target.id)) {
        throw new CourierError('upstream', `${target.name} is waiting for your answer; your final answer in this turn goes to ${target.name} automatically, so put what you want to say there`)
      }
      const parent = answering.length > 0 ? this.table.get(answering[answering.length - 1]!) : undefined
      const depth = parent === undefined ? 1 : parent.depth + 1
      if (depth > CHAIN_LIMITS.depth) {
        throw new CourierError('too_deep', `this request is already ${parent!.depth} hand-offs deep; do the work yourself or answer with what you have`)
      }
      const id = this.newId()
      const root = parent?.root ?? id
      if (this.jobs().filter(job => job.root === root).length >= CHAIN_LIMITS.jobsPerChain) {
        throw new CourierError('too_many', 'this piece of work has already sent too many messages between bots; answer with what you have')
      }
      const expectReply = request.expectReply ?? true
      const stamp = this.now().toISOString()
      const job: Job = {
        id, from: caller.id, to: target.id, text: request.text, expectReply,
        ...(parent === undefined ? {} : { parent: parent.id }),
        root, depth,
        originSession: request.callerSession, targetSession: target.sessionId,
        state: 'queued', createdAt: stamp, updatedAt: stamp,
      }
      await this.table.put(id, job)
      const delivered = await this.dispatch(job, false)
      if (delivered.state === 'failed') throw new CourierError('delivery_failed', delivered.reply ?? `could not reach ${target.name}`)
      return { job: id, to: target.name, expectReply }
    })
  }

  /** A user-role message entered a turn. */
  userMessage(sessionId: string, source: unknown): Promise<void> {
    if (!isRelaySource(source)) return Promise.resolve()
    return this.serial(async () => {
      const job = this.table.get(source.job)
      if (job === undefined) return
      if (source.type === 'request') {
        if (job.targetSession !== sessionId || FINISHED.has(job.state)) return
        if (!job.expectReply) {
          await this.update(job, { state: 'read' })
          return
        }
        await this.update(job, { state: 'answering' })
        this.turn(sessionId).jobs.push(job.id)
        return
      }
      if (job.originSession !== sessionId) return
      await this.update(job, { replyEntered: true })
      const parent = job.parent === undefined ? undefined : this.table.get(job.parent)
      if (parent !== undefined && parent.targetSession === sessionId && (parent.state === 'waiting_children' || parent.state === 'answering')) {
        await this.update(parent, { state: 'answering' })
        this.turn(sessionId).jobs.push(parent.id)
      }
    })
  }

  /** The model wrote text in the open turn; the last non-empty text is the turn's answer. */
  assistantText(sessionId: string, text: string): Promise<void> {
    // Queued behind the user message that opened the turn, so it is attributed.
    return this.serial(async () => {
      if (text.trim() !== '' && this.turns.has(sessionId)) this.turn(sessionId).text = text.trim()
    })
  }

  /** A turn closed: settle every job it was answering. */
  turnEnded(sessionId: string, ending: TurnEnding): Promise<void> {
    return this.serial(async () => {
      const turn = this.turns.get(sessionId)
      this.turns.delete(sessionId)
      if (turn === undefined) return
      for (const id of new Set(turn.jobs)) {
        const job = this.table.get(id)
        if (job === undefined || FINISHED.has(job.state)) continue
        const status = STATUS_FOR[ending]
        if (status === 'returned' && this.outstanding(job.id).length > 0) {
          await this.update(job, { state: 'waiting_children' })
          continue
        }
        const recipient = this.directory.get(job.to)?.name ?? 'The bot'
        const reply = turn.text !== '' ? turn.text
          : status === 'returned' ? `(${recipient} finished without a written answer)`
            : `(${recipient}'s turn ${status === 'stopped' ? 'was stopped' : status === 'failed' ? 'failed' : 'ended unexpectedly'} before it answered)`
        await this.finish(job, status, reply)
      }
    })
  }

  /** Pick up after a restart. */
  recover(): Promise<void> {
    return this.serial(async () => {
      for (const job of this.jobs()) {
        if (job.state === 'queued') {
          await this.dispatch(job, false)
        } else if (job.state === 'delivered') {
          // The Harness restores pending input; take that copy back so the job enters once.
          if (job.messageId !== undefined) await this.mailbox.withdraw(job.targetSession, job.messageId).catch(() => false)
          await this.dispatch(job, job.resumed ?? false)
        } else if (job.state === 'answering') {
          if (job.resumed) await this.finish(job, 'unknown', '(a restart interrupted this work twice; there is no answer)')
          else await this.dispatch(job, true)
        } else if (job.expectReply && FINISHED.has(job.state) && job.state !== 'read' && !job.replyEntered) {
          if (job.replyMessageId !== undefined) await this.mailbox.withdraw(job.originSession, job.replyMessageId).catch(() => false)
          await this.deliverReply(job, job.state as ReplyStatus, job.reply ?? '')
        }
      }
    })
  }

  /** Bots waiting, directly or further up, for an answer from whoever answers these jobs. */
  private upstream(answering: readonly string[]): Set<string> {
    const waiting = new Set<string>()
    for (const start of answering) {
      let job = this.table.get(start)
      const seen = new Set<string>()
      while (job !== undefined && !seen.has(job.id)) {
        seen.add(job.id)
        waiting.add(job.from)
        job = job.parent === undefined ? undefined : this.table.get(job.parent)
      }
    }
    return waiting
  }

  /** Children whose replies the parent's recipient has not yet seen. */
  private outstanding(jobId: string): Job[] {
    return this.jobs().filter(job => job.parent === jobId && job.expectReply && !(FINISHED.has(job.state) && job.replyEntered))
  }

  private async dispatch(job: Job, resumed: boolean): Promise<Job> {
    const sender = this.directory.get(job.from)
    const text = fromBot({ name: sender?.name ?? job.from, botId: job.from, job: job.id, expectReply: job.expectReply, text: job.text, resumed })
    try {
      const messageId = await this.mailbox.deliver(job.targetSession, text, { kind: 'futurebot', form: 'relay', type: 'request', job: job.id, from: job.from })
      return await this.update(job, { state: 'delivered', messageId, ...(resumed ? { resumed: true } : {}) })
    } catch (error) {
      const reply = `could not deliver to ${this.directory.get(job.to)?.name ?? job.to}: ${String(error)}`
      this.warn(reply)
      return await this.update(job, { state: 'failed', reply })
    }
  }

  private async finish(job: Job, status: ReplyStatus, reply: string): Promise<void> {
    const settled = await this.update(job, { state: status, reply })
    if (settled.expectReply) await this.deliverReply(settled, status, reply)
  }

  private async deliverReply(job: Job, status: ReplyStatus, reply: string): Promise<void> {
    const recipient = this.directory.get(job.to)
    const text = botReply({ name: recipient?.name ?? job.to, botId: job.to, job: job.id, status, text: reply })
    try {
      const replyMessageId = await this.mailbox.deliver(job.originSession, text, { kind: 'futurebot', form: 'relay', type: 'reply', job: job.id, from: job.to })
      await this.update(job, { replyMessageId })
    } catch (error) {
      this.warn(`could not return ${recipient?.name ?? job.to}'s answer: ${String(error)}`)
    }
  }

  private turn(sessionId: string): OpenTurn {
    let turn = this.turns.get(sessionId)
    if (turn === undefined) {
      turn = { jobs: [], text: '' }
      this.turns.set(sessionId, turn)
    }
    return turn
  }

  private async update(job: Job, patch: Partial<Job>): Promise<Job> {
    const current = this.table.get(job.id) ?? job
    const next: Job = { ...current, ...patch, updatedAt: this.now().toISOString() }
    await this.table.put(next.id, next)
    return next
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }
}
