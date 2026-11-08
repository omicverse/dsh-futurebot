import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, type Bot } from '../shared/types.ts'
import type { BotTable } from './store.ts'
import { BotError, assertUniqueName, parseInput } from './validate.ts'

/** Which record fields a sync must bring into the conversation. */
export type SyncField = 'name' | 'model' | 'permission'

/** The Harness side of a bot: its conversation. */
export interface BotSessions {
  /** Create the bot's conversation in its workspace and return the session id. */
  create(bot: Bot): Promise<string>
  /** Bring the conversation in line with the record for the given fields. */
  sync(bot: Bot, fields: readonly SyncField[]): Promise<void>
}

export interface BotServiceOptions {
  /** Parent of default workspaces; `~/futurebots` when empty. */
  workspaceRoot?: string
  now?: () => Date
  newId?: () => string
  /** Where non-fatal sync failures go. */
  warn?: (message: string) => void
  /** Called once a new bot's record names its session (the Agent may already be live). */
  onBound?: (bot: Bot) => void
}

/** Folder name for a bot's default workspace: its name, minus path syntax. */
export function workspaceFolder(name: string): string {
  const folder = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim()
  return folder === '' ? 'bot' : folder
}

/**
 * Bot records and their conversations.
 *
 * Every write goes through one queue, so two requests can never both pass the
 * uniqueness check or race a create against an edit of the same bot.
 */
export class BotService {
  private readonly bySessionId = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly warn: (message: string) => void
  private readonly workspaceRoot: string
  private readonly onBound: (bot: Bot) => void

  constructor(private readonly table: BotTable, private readonly sessions: BotSessions, options: BotServiceOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => `bot_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
    this.warn = options.warn ?? (message => console.warn(`futurebot: ${message}`))
    this.workspaceRoot = options.workspaceRoot || join(homedir(), 'futurebots')
    this.onBound = options.onBound ?? (() => undefined)
    for (const [, bot] of table.entries()) if (bot.sessionId) this.bySessionId.set(bot.sessionId, bot.id)
  }

  list(): Bot[] {
    return [...this.table.entries()].map(([, bot]) => bot).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  get(id: string): Bot | undefined {
    return this.table.get(id)
  }

  /** The bot whose ongoing conversation this session is. */
  forSession(sessionId: string): Bot | undefined {
    const id = this.bySessionId.get(sessionId)
    return id === undefined ? undefined : this.table.get(id)
  }

  defaultWorkspace(name: string): string {
    return join(this.workspaceRoot, workspaceFolder(name))
  }

  create(body: unknown): Promise<Bot> {
    return this.serial(async () => {
      const patch = parseInput(body)
      if (patch.name === undefined) throw new BotError('invalid_name', 'a bot needs a name')
      const bots = this.list()
      if (bots.length >= LIMITS.maxBots) throw new BotError('too_many_bots', `at most ${LIMITS.maxBots} bots`)
      assertUniqueName(patch.name, bots)
      const workspace = patch.workspace ?? this.defaultWorkspace(patch.name)
      try {
        await mkdir(workspace, { recursive: true })
      } catch (error) {
        throw new BotError('invalid_workspace', `cannot create workspace ${workspace}: ${String(error)}`)
      }
      const stamp = this.now().toISOString()
      const draft: Bot = {
        id: this.newId(),
        name: patch.name,
        instructions: patch.instructions ?? '',
        ...(patch.basePreset === undefined ? {} : { basePreset: patch.basePreset }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        permission: patch.permission ?? 'auto',
        ...(patch.isMain ? { isMain: true } : {}),
        approvalScope: patch.approvalScope ?? 'once_per_chat',
        workspace,
        createdAt: stamp,
        updatedAt: stamp,
        rev: 1,
      }
      let sessionId: string
      try {
        sessionId = await this.sessions.create(draft)
      } catch (error) {
        throw new BotError('session_failed', `the Harness could not create the conversation: ${String(error)}`)
      }
      const bot: Bot = { ...draft, sessionId }
      if (bot.isMain) await this.demoteOthers(bot.id)
      await this.table.put(bot.id, bot)
      this.bySessionId.set(sessionId, bot.id)
      this.onBound(bot)
      await this.trySync(bot, ['name', 'model', 'permission'])
      return bot
    })
  }

  update(id: string, body: unknown, expectedRev?: number): Promise<Bot> {
    return this.serial(async () => {
      const current = this.table.get(id)
      if (current === undefined) throw new BotError('not_found', `no bot ${id}`)
      if (expectedRev !== undefined && expectedRev !== current.rev) {
        throw new BotError('conflict', `bot ${id} changed since revision ${expectedRev}; reload and retry`)
      }
      const patch = parseInput(body)
      if (patch.name !== undefined) assertUniqueName(patch.name, this.list(), id)
      // The Harness fixes a session's preset after its first turn and its
      // directory for good, so these two belong to the bot's birth.
      if ('basePreset' in patch && patch.basePreset !== current.basePreset) {
        throw new BotError('invalid_preset', 'the base agent is fixed once the bot exists')
      }
      if (patch.workspace !== undefined && patch.workspace !== current.workspace) {
        throw new BotError('invalid_workspace', 'the workspace is fixed once the bot exists')
      }
      const model = 'model' in patch ? patch.model : current.model
      const isMain = 'isMain' in patch ? patch.isMain === true : current.isMain === true
      const { model: _previous, isMain: _wasMain, ...rest } = current
      const next: Bot = {
        ...rest,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
        ...(patch.permission === undefined ? {} : { permission: patch.permission }),
        ...(patch.approvalScope === undefined ? {} : { approvalScope: patch.approvalScope }),
        ...(model === undefined ? {} : { model }),
        ...(isMain ? { isMain: true } : {}),
        updatedAt: this.now().toISOString(),
        rev: current.rev + 1,
      }
      if (isMain && !current.isMain) await this.demoteOthers(id)
      await this.table.put(id, next)
      const fields: SyncField[] = []
      if (next.name !== current.name) fields.push('name')
      if (JSON.stringify(next.model) !== JSON.stringify(current.model)) fields.push('model')
      if (next.permission !== current.permission) fields.push('permission')
      if (fields.length > 0) await this.trySync(next, fields)
      return next
    })
  }

  /** Forget the bot. Its conversation stays as an ordinary conversation. */
  remove(id: string): Promise<{ sessionId?: string }> {
    return this.serial(async () => {
      const current = this.table.get(id)
      if (current === undefined) throw new BotError('not_found', `no bot ${id}`)
      await this.table.delete(id)
      if (current.sessionId) this.bySessionId.delete(current.sessionId)
      return current.sessionId === undefined ? {} : { sessionId: current.sessionId }
    })
  }

  /** Only one coordinator: taking the role removes it from whoever had it. */
  private async demoteOthers(keepId: string): Promise<void> {
    for (const bot of this.list()) {
      if (bot.id === keepId || !bot.isMain) continue
      const { isMain: _dropped, ...rest } = bot
      await this.table.put(bot.id, { ...rest, updatedAt: this.now().toISOString(), rev: bot.rev + 1 })
    }
  }

  private async trySync(bot: Bot, fields: readonly SyncField[]): Promise<void> {
    try {
      await this.sessions.sync(bot, fields)
    } catch (error) {
      // The record is the source of truth; the next sync (or the user) fixes the session.
      this.warn(`could not apply ${fields.join(', ')} to ${bot.name}'s conversation: ${String(error)}`)
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }
}
