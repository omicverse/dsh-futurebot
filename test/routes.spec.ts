import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_PREFIX, createHandler } from '../src/host/routes.ts'
import { BotService } from '../src/host/service.ts'
import { Mind, type Table } from '../src/host/mind.ts'
import { MemoryTable } from '../src/host/store.ts'

let server: Server
let base: string
let root: string
let signedIn: boolean
let said: { session: string; text: string }[]
let busy: boolean
let waits: number

class Rows<T> implements Table<T> {
  rows = new Map<string, T>()
  get(id: string) { return this.rows.get(id) }
  entries() { return [...this.rows.entries()] }
  async put(id: string, value: T) { this.rows.set(id, value) }
  async delete(id: string) { return this.rows.delete(id) }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'futurebot-routes-'))
  let n = 0
  const service = new BotService(new MemoryTable(), {
    create: async () => `session-${++n}`,
    sync: async () => undefined,
  }, { workspaceRoot: root })
  signedIn = true
  said = []
  busy = false
  waits = 0
  const mind = new Mind(new Rows(), new Rows(), () => service.list())
  const conversations = {
    say: async (session: string, text: string) => { said.push({ session, text }); return 'msg' },
    cursor: async () => 41,
    waitingOnUser: async () => false,
    // The first wait sees no answer yet (the turn has not started); the second sees it.
    wait: async () => (++waits === 1 ? { reason: 'idle', cursor: 41, running: false } : { reason: 'idle', cursor: 45, running: false, answer: 'done' }),
  }
  const handler = createHandler({
    app: async () => ({ service, mind, conversations, busy: async () => busy }),
    reject: () => (signedIn ? undefined : 401),
    sleep: async () => undefined,
  })
  server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${API_PREFIX}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('HTTP API', () => {
  it('refuses requests without the Harness browser credential', async () => {
    signedIn = false
    const response = await fetch(`${base}/bots`)
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('creates, lists, edits and deletes a bot', async () => {
    const created = await fetch(`${base}/bots`, json('POST', { name: 'Lin', instructions: 'hi' }))
    expect(created.status).toBe(201)
    const { bot } = await created.json() as { bot: { id: string; rev: number; sessionId: string } }
    expect(bot.sessionId).toBe('session-1')

    const listed = await (await fetch(`${base}/bots`)).json() as { bots: unknown[] }
    expect(listed.bots).toHaveLength(1)

    const edited = await fetch(`${base}/bots/${bot.id}`, json('PATCH', { rev: 1, instructions: 'changed' }))
    expect(edited.status).toBe(200)
    expect(((await edited.json()) as { bot: { rev: number } }).bot.rev).toBe(2)

    const stale = await fetch(`${base}/bots/${bot.id}`, json('PATCH', { rev: 1, instructions: 'again' }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'conflict' })

    const deleted = await fetch(`${base}/bots/${bot.id}`, { method: 'DELETE' })
    expect(await deleted.json()).toEqual({ deleted: true, sessionId: 'session-1' })
    expect(((await (await fetch(`${base}/bots`)).json()) as { bots: unknown[] }).bots).toHaveLength(0)
  })

  it('suggests a workspace under the root', async () => {
    const response = await fetch(`${base}/workspace?name=${encodeURIComponent('林分析')}`)
    expect(await response.json()).toEqual({ workspace: join(root, '林分析') })
  })

  it('maps refusals to statuses with stable codes', async () => {
    expect((await fetch(`${base}/bots`, json('POST', { name: '' }))).status).toBe(400)
    await fetch(`${base}/bots`, json('POST', { name: 'Lin' }))
    const duplicate = await fetch(`${base}/bots`, json('POST', { name: 'lin' }))
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ error: 'duplicate_name' })
    expect((await fetch(`${base}/bots/bot_missing`, json('PATCH', { name: 'x' }))).status).toBe(404)
    expect((await fetch(`${base}/bots/x`, json('PATCH', { rev: 'one' }))).status).toBe(400)
    expect((await fetch(`${base}/nowhere`)).status).toBe(404)
  })

  it('accepts only JSON bodies of bounded size', async () => {
    const form = await fetch(`${base}/bots`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}' })
    expect(form.status).toBe(400)
    const broken = await fetch(`${base}/bots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(await broken.json()).toMatchObject({ error: 'invalid_request' })
    const huge = await fetch(`${base}/bots`, json('POST', { name: 'x', instructions: 'y'.repeat(70 * 1024) }))
    expect(huge.status).toBe(400)
  })
})

describe('talking to a bot and reading its mind', () => {
  it('sends a message as the user and waits for an answer after it', async () => {
    const { bot } = await (await fetch(`${base}/bots`, json('POST', { name: 'Lin' }))).json() as { bot: { id: string } }
    const sent = await fetch(`${base}/bots/${bot.id}/messages`, json('POST', { text: 'Hello' }))
    expect(sent.status).toBe(202)
    expect(await sent.json()).toEqual({ after: 41 })
    expect(said).toEqual([{ session: 'session-1', text: 'Hello' }])
    const waited = await (await fetch(`${base}/bots/${bot.id}/wait?after=41&timeoutMs=5000`)).json()
    expect(waited).toEqual({ reason: 'idle', cursor: 45, running: false, answer: 'done' })
    expect(waits).toBe(2)
    expect((await fetch(`${base}/bots/${bot.id}/messages`, json('POST', { text: ' ' }))).status).toBe(400)
    expect((await fetch(`${base}/bots/bot_none/messages`, json('POST', { text: 'x' }))).status).toBe(404)
  })

  it('reads and replaces memory, and reads the agenda', async () => {
    const { bot } = await (await fetch(`${base}/bots`, json('POST', { name: 'Lin' }))).json() as { bot: { id: string } }
    const entries = [{ id: 'm1', kind: 'correction', text: 'Use DESeq2 for counts.', about: 'user', at: '2026-11-08T00:00:00.000Z' }]
    expect(await (await fetch(`${base}/bots/${bot.id}/memory`, json('PUT', { entries }))).json()).toEqual({ count: 1 })
    const read = await (await fetch(`${base}/bots/${bot.id}/memory`)).json() as { entries: { bot: string; text: string }[] }
    expect(read.entries.map(e => [e.bot, e.text])).toEqual([[bot.id, 'Use DESeq2 for counts.']])
    expect((await fetch(`${base}/bots/${bot.id}/memory`, json('PUT', { entries: [{ id: 'x' }] }))).status).toBe(400)
    expect(await (await fetch(`${base}/bots/${bot.id}/agenda`)).json()).toEqual({ goals: [] })
  })

  it('reports settled once nothing has been busy for a while', async () => {
    busy = false
    expect(await (await fetch(`${base}/settled?timeoutMs=1000`)).json()).toMatchObject({ settled: expect.any(Boolean) })
  })
})

