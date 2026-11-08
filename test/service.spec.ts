import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../src/shared/types.ts'
import { BotService, workspaceFolder, type BotSessions, type SyncField } from '../src/host/service.ts'
import { MemoryTable } from '../src/host/store.ts'
import { BotError } from '../src/host/validate.ts'

class FakeSessions implements BotSessions {
  created: Bot[] = []
  synced: { bot: Bot; fields: readonly SyncField[] }[] = []
  failCreate = false
  failSync = false
  private next = 1
  async create(bot: Bot): Promise<string> {
    if (this.failCreate) throw new Error('boom')
    this.created.push(bot)
    return `session-${this.next++}`
  }
  async sync(bot: Bot, fields: readonly SyncField[]): Promise<void> {
    if (this.failSync) throw new Error('sync boom')
    this.synced.push({ bot, fields })
  }
}

let root: string
let sessions: FakeSessions
let table: MemoryTable
let service: BotService
let bound: Bot[]
let warnings: string[]
let clock: number

function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => 'ok', (error: unknown) => (error instanceof BotError ? error.code : `unexpected: ${String(error)}`))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'futurebot-'))
  sessions = new FakeSessions()
  table = new MemoryTable()
  bound = []
  warnings = []
  clock = Date.UTC(2026, 10, 8, 0, 0, 0)
  let ids = 0
  service = new BotService(table, sessions, {
    workspaceRoot: root,
    now: () => new Date(clock += 1000),
    newId: () => `bot_${++ids}`,
    warn: message => warnings.push(message),
    onBound: bot => bound.push(bot),
  })
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('creating a bot', () => {
  it('creates its workspace and conversation and binds them in one record', async () => {
    const bot = await service.create({ name: '  Lin   Analyst ', instructions: 'Analyse RNA-seq.\r\n' })
    expect(bot).toMatchObject({ id: 'bot_1', name: 'Lin Analyst', instructions: 'Analyse RNA-seq.', permission: 'auto', approvalScope: 'once_per_chat', sessionId: 'session-1', rev: 1 })
    expect(bot.workspace).toBe(join(root, 'Lin Analyst'))
    expect((await stat(bot.workspace)).isDirectory()).toBe(true)
    expect(sessions.created[0]).toMatchObject({ workspace: bot.workspace })
    expect(sessions.synced).toEqual([{ bot, fields: ['name', 'model', 'permission'] }])
    expect(bound).toEqual([bot])
    expect(service.forSession('session-1')).toEqual(bot)
    expect(table.get('bot_1')).toEqual(bot)
  })

  it('passes the chosen base agent and workspace to the Harness', async () => {
    const workspace = join(root, 'custom', 'place')
    await service.create({ name: 'A', workspace, basePreset: 'omicos', model: { provider: 'deepseek', model: 'deepseek-chat' }, permission: 'read_only' })
    expect(sessions.created[0]).toMatchObject({ workspace, basePreset: 'omicos', model: { provider: 'deepseek', model: 'deepseek-chat' }, permission: 'read_only' })
  })

  it('refuses a name another bot has, ignoring case', async () => {
    await service.create({ name: 'Lin' })
    expect(await code(service.create({ name: ' lin ' }))).toBe('duplicate_name')
  })

  it('serializes concurrent creates so only one of two same-named bots exists', async () => {
    const results = await Promise.all([code(service.create({ name: 'Twin' })), code(service.create({ name: 'Twin' }))])
    expect(results.sort()).toEqual(['duplicate_name', 'ok'])
    expect(service.list()).toHaveLength(1)
  })

  it('stores nothing when the Harness cannot create the conversation', async () => {
    sessions.failCreate = true
    expect(await code(service.create({ name: 'A' }))).toBe('session_failed')
    expect(service.list()).toEqual([])
  })

  it('keeps the bot when applying title/model/permission fails, and says so', async () => {
    sessions.failSync = true
    const bot = await service.create({ name: 'A' })
    expect(service.get(bot.id)).toEqual(bot)
    expect(warnings[0]).toContain('could not apply name, model, permission')
  })

  it('refuses malformed input', async () => {
    expect(await code(service.create({}))).toBe('invalid_name')
    expect(await code(service.create({ name: 'A', permission: 'root' }))).toBe('invalid_permission')
    expect(await code(service.create({ name: 'A', workspace: 'relative/dir' }))).toBe('invalid_workspace')
    expect(await code(service.create({ name: 'A', model: { provider: 'x' } }))).toBe('invalid_model')
    expect(await code(service.create({ name: 'A', colour: 'blue' }))).toBe('invalid_request')
    expect(await code(service.create({ name: 'x'.repeat(41) }))).toBe('invalid_name')
  })
})

describe('editing a bot', () => {
  it('applies only what changed to the conversation and bumps the revision', async () => {
    const bot = await service.create({ name: 'A' })
    sessions.synced = []
    const renamed = await service.update(bot.id, { name: 'B', instructions: 'new' }, 1)
    expect(renamed).toMatchObject({ name: 'B', instructions: 'new', rev: 2 })
    expect(sessions.synced.map(s => s.fields)).toEqual([['name']])
    await service.update(bot.id, { instructions: 'only text' })
    expect(sessions.synced).toHaveLength(1)
    await service.update(bot.id, { permission: 'full', model: { provider: 'p', model: 'm' } })
    expect(sessions.synced.at(-1)!.fields).toEqual(['model', 'permission'])
    const cleared = await service.update(bot.id, { model: null })
    expect(cleared.model).toBeUndefined()
  })

  it('refuses a stale revision', async () => {
    const bot = await service.create({ name: 'A' })
    await service.update(bot.id, { instructions: 'x' })
    expect(await code(service.update(bot.id, { instructions: 'y' }, 1))).toBe('conflict')
  })

  it('keeps the base agent and workspace fixed', async () => {
    const bot = await service.create({ name: 'A', basePreset: 'omicos' })
    expect(await code(service.update(bot.id, { basePreset: 'other' }))).toBe('invalid_preset')
    expect(await code(service.update(bot.id, { workspace: join(root, 'elsewhere') }))).toBe('invalid_workspace')
    expect(await code(service.update(bot.id, { basePreset: 'omicos', workspace: bot.workspace }))).toBe('ok')
  })

  it('refuses renaming onto another bot', async () => {
    await service.create({ name: 'A' })
    const b = await service.create({ name: 'B' })
    expect(await code(service.update(b.id, { name: 'a' }))).toBe('duplicate_name')
    expect(await code(service.update(b.id, { name: 'B' }))).toBe('ok')
  })
})

describe('the coordinator', () => {
  it('is at most one bot: taking the role removes it from the previous holder', async () => {
    const main = await service.create({ name: 'Main', isMain: true })
    expect(main.isMain).toBe(true)
    const other = await service.create({ name: 'Other', isMain: true })
    expect(service.get(main.id)!.isMain).toBeUndefined()
    expect(service.get(main.id)!.rev).toBe(2)
    await service.update(main.id, { isMain: true })
    expect(service.get(other.id)!.isMain).toBeUndefined()
    expect(service.get(main.id)!.isMain).toBe(true)
    await service.update(main.id, { isMain: false })
    expect(service.list().filter(bot => bot.isMain)).toEqual([])
  })

  it('refuses a non-boolean flag', async () => {
    expect(await code(service.create({ name: 'A', isMain: 'yes' }))).toBe('invalid_request')
  })
})

describe('removing a bot', () => {
  it('forgets the record and leaves its conversation', async () => {
    const bot = await service.create({ name: 'A' })
    expect(await service.remove(bot.id)).toEqual({ sessionId: 'session-1' })
    expect(service.get(bot.id)).toBeUndefined()
    expect(service.forSession('session-1')).toBeUndefined()
    expect(await code(service.remove(bot.id))).toBe('not_found')
  })
})

describe('restart', () => {
  it('finds bots by session from what the table already holds', async () => {
    const bot = await service.create({ name: 'A' })
    const reopened = new BotService(table, sessions, { workspaceRoot: root })
    expect(reopened.forSession('session-1')).toEqual(bot)
  })
})

describe('workspaceFolder', () => {
  it('keeps the name and drops path syntax', () => {
    expect(workspaceFolder('林分析')).toBe('林分析')
    expect(workspaceFolder('a/b\\c:d')).toBe('a-b-c-d')
    expect(workspaceFolder('..hidden')).toBe('hidden')
    expect(workspaceFolder('...')).toBe('bot')
  })
})
