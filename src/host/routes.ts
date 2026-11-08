import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BotErrorBody } from '../shared/types.ts'
import { CourierError, type Courier } from './courier.ts'
import { WatchError, type Watcher } from './evidence.ts'
import type { Conversations } from './harness.ts'
import type { ApprovalPolicy } from './approvals.ts'
import { GroupError, type Groups } from './groups.ts'
import { MindError, type MemoryEntry, type Mind } from './mind.ts'
import type { BotService } from './service.ts'
import { BotError } from './validate.ts'

/** Mount point of the plugin's HTTP API on the Harness web server. */
export const API_PREFIX = '/futurebot/api'

const MAX_BODY_BYTES = 64 * 1024

/** Status for each refusal code. */
const STATUS: Record<BotError['code'], number> = {
  invalid_request: 400,
  invalid_name: 400,
  duplicate_name: 409,
  invalid_instructions: 400,
  invalid_permission: 400,
  invalid_workspace: 400,
  invalid_model: 400,
  invalid_preset: 400,
  not_found: 404,
  conflict: 409,
  session_failed: 502,
  too_many_bots: 409,
}

/** Everything behind the API once storage is open. */
export interface App {
  service: BotService
  courier?: Courier
  mind?: Mind
  watcher?: Watcher
  groups?: Groups
  approvals?: ApprovalPolicy
  conversations?: Conversations
  /**
   * True while something will still happen without the user: a bot runs a
   * turn that is not blocked on the user, or a job waits to be picked up.
   */
  busy?: () => Promise<boolean>
}

export interface RouteDeps {
  app: () => Promise<App>
  /** Returns 401/403 when the request is not from the signed-in browser or an API peer. */
  reject: (request: IncomingMessage) => 401 | 403 | undefined
  sleep?: (ms: number) => Promise<void>
}

const MAX_WAIT_MS = 10 * 60_000

function waitMs(url: URL, fallback: number): number {
  const value = Number(url.searchParams.get('timeoutMs') ?? fallback)
  return Number.isFinite(value) ? Math.max(1000, Math.min(MAX_WAIT_MS, value)) : fallback
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new BotError('invalid_request', `${what} is not available in this profile`)
  return value
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function refuse(response: ServerResponse, status: number, error: BotErrorBody['error'], message: string): void {
  send(response, status, { error, message } satisfies BotErrorBody)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type'] ?? ''
  if (!/^application\/json\b/i.test(type)) throw new BotError('invalid_request', 'expected application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new BotError('invalid_request', 'request body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BotError('invalid_request', 'request body is not valid JSON')
  }
}

/**
 * Bots: `GET|POST /bots`, `PATCH|DELETE /bots/:id` (PATCH takes an optional
 * `rev`), `GET /workspace?name=`.
 *
 * Talking to a bot as the user, for scripts such as the condition tests:
 * `POST /bots/:id/messages {text}` returns `after`, the log position before
 * the message; `GET /bots/:id/wait?after=&timeoutMs=` returns once that bot is
 * idle with its newest answer; `GET /settled?timeoutMs=` returns once no bot
 * is working and no job is in flight.
 *
 * Groups: `GET|POST /groups`, `PATCH|DELETE /groups/:id`,
 * `POST /groups/:id/post {text, mentions?}` (the user speaks),
 * `GET /groups/:id/log?after=`, `POST /groups/:id/goal {action}` with action
 * start, pause, resume, stop or clear.
 *
 * A bot's mind: `GET|PUT /bots/:id/memory` (PUT replaces it, to keep, clear or
 * swap experience in a controlled comparison), `GET /bots/:id/agenda`,
 * `GET /bots/:id/watches`, and `GET /jobs`.
 *
 * Every request must carry the Harness browser cookie (or an API peer's).
 */
export function createHandler(deps: RouteDeps) {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rejection = deps.reject(request)
    if (rejection !== undefined) {
      refuse(response, rejection, 'invalid_request', 'not signed in to this Harness')
      return
    }
    const url = new URL(request.url ?? '/', 'http://local')
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
    const method = (request.method ?? 'GET').toUpperCase()
    try {
      const app = await deps.app()
      const { service } = app
      if (path === '/jobs' && method === 'GET') {
        send(response, 200, { jobs: need(app.courier, 'work between bots').jobs() })
        return
      }
      if (path === '/settled' && method === 'GET') {
        const busy = need(app.busy, 'activity')
        const deadline = Date.now() + waitMs(url, 120_000)
        let quietSince: number | undefined
        for (;;) {
          if (await busy()) quietSince = undefined
          else quietSince ??= Date.now()
          if (quietSince !== undefined && Date.now() - quietSince >= 3000) { send(response, 200, { settled: true }); return }
          if (Date.now() > deadline) { send(response, 200, { settled: false }); return }
          await sleep(500)
        }
      }
      if (path === '/groups' && method === 'GET') {
        send(response, 200, { groups: need(app.groups, 'groups').list() })
        return
      }
      if (path === '/groups' && method === 'POST') {
        send(response, 201, { group: await need(app.groups, 'groups').create(await readJson(request) as never) })
        return
      }
      const groupRoute = /^\/groups\/([A-Za-z0-9_-]{1,64})(?:\/(post|log|goal))?$/.exec(path)
      if (groupRoute !== null) {
        const groups = need(app.groups, 'groups')
        const [, id, part] = groupRoute
        if (part === undefined && method === 'PATCH') { send(response, 200, { group: await groups.update(id!, await readJson(request) as never) }); return }
        if (part === undefined && method === 'DELETE') { await groups.remove(id!); send(response, 200, { deleted: true }); return }
        if (part === undefined && method === 'GET') {
          const group = groups.get(id!)
          if (group === undefined) throw new BotError('not_found', `no group ${id}`)
          send(response, 200, { group })
          return
        }
        if (part === 'post' && method === 'POST') {
          const body = await readJson(request) as { text?: unknown; mentions?: unknown }
          if (typeof body?.text !== 'string') throw new BotError('invalid_request', 'text must be a string')
          const mentions = Array.isArray(body.mentions) ? body.mentions.filter((m): m is string => typeof m === 'string') : undefined
          send(response, 201, { entry: await groups.post(id!, body.text, mentions) })
          return
        }
        if (part === 'log' && method === 'GET') {
          if (groups.get(id!) === undefined) throw new BotError('not_found', `no group ${id}`)
          send(response, 200, { entries: groups.entries(id!, Number(url.searchParams.get('after') ?? 0)) })
          return
        }
        if (part === 'goal' && method === 'POST') {
          const body = await readJson(request) as { action?: unknown }
          send(response, 200, { group: await groups.goalAction(id!, String(body?.action ?? '')) })
          return
        }
      }
      if (path === '/bots' && method === 'GET') {
        send(response, 200, { bots: service.list() })
        return
      }
      if (path === '/workspace' && method === 'GET') {
        send(response, 200, { workspace: service.defaultWorkspace(url.searchParams.get('name') ?? '') })
        return
      }
      if (path === '/bots' && method === 'POST') {
        send(response, 201, { bot: await service.create(await readJson(request)) })
        return
      }
      const sub = /^\/bots\/([A-Za-z0-9_-]{1,64})\/(messages|wait|memory|agenda|watches)$/.exec(path)
      if (sub !== null) {
        const bot = service.get(sub[1]!)
        if (bot === undefined) throw new BotError('not_found', `no bot ${sub[1]}`)
        const part = sub[2]
        if (part === 'messages' && method === 'POST') {
          const body = await readJson(request) as { text?: unknown }
          if (typeof body?.text !== 'string' || body.text.trim() === '') throw new BotError('invalid_request', 'text must be a non-empty string')
          if (bot.sessionId === undefined) throw new BotError('session_failed', `${bot.name} has no conversation`)
          const conversations = need(app.conversations, 'conversations')
          const after = await conversations.cursor(bot.sessionId)
          await conversations.say(bot.sessionId, body.text)
          send(response, 202, { after })
          return
        }
        if (part === 'wait' && method === 'GET') {
          if (bot.sessionId === undefined) throw new BotError('session_failed', `${bot.name} has no conversation`)
          const conversations = need(app.conversations, 'conversations')
          const after = Number(url.searchParams.get('after') ?? 0)
          const deadline = Date.now() + waitMs(url, 120_000)
          // A just-queued message may not have started its turn yet: wait for an answer after `after`.
          for (;;) {
            const left = Math.max(1000, deadline - Date.now())
            const result = await conversations.wait(bot.sessionId, after, Math.min(left, 30_000))
            if ((result.reason !== 'timeout' && result.answer !== undefined && !result.running) || Date.now() >= deadline) {
              send(response, 200, result)
              return
            }
            await sleep(1000)
          }
        }
        if (part === 'memory' && method === 'GET') {
          send(response, 200, { entries: need(app.mind, 'memory').entries(bot.id) })
          return
        }
        if (part === 'memory' && method === 'PUT') {
          const body = await readJson(request) as { entries?: unknown }
          if (!Array.isArray(body?.entries)) throw new BotError('invalid_request', 'entries must be an array')
          const entries = body.entries.map(entry => {
            const { bot: _bot, ...rest } = entry as MemoryEntry
            if (typeof rest.id !== 'string' || typeof rest.text !== 'string' || typeof rest.kind !== 'string' || typeof rest.at !== 'string') {
              throw new BotError('invalid_request', 'each entry needs id, kind, text and at')
            }
            return rest
          })
          await need(app.mind, 'memory').replaceMemory(bot.id, entries)
          send(response, 200, { count: entries.length })
          return
        }
        if (part === 'agenda' && method === 'GET') {
          send(response, 200, { goals: need(app.mind, 'agenda').goals(bot.id) })
          return
        }
        if (part === 'watches' && method === 'GET') {
          send(response, 200, { watches: need(app.watcher, 'watches').list(bot.id) })
          return
        }
      }
      const match = /^\/bots\/([A-Za-z0-9_-]{1,64})$/.exec(path)
      if (match !== null && method === 'PATCH') {
        const body = await readJson(request)
        let rev: number | undefined
        let fields = body
        if (typeof body === 'object' && body !== null && 'rev' in body) {
          const { rev: value, ...rest } = body as Record<string, unknown>
          if (typeof value !== 'number' || !Number.isInteger(value)) throw new BotError('invalid_request', 'rev must be an integer')
          rev = value
          fields = rest
        }
        send(response, 200, { bot: await service.update(match[1]!, fields, rev) })
        return
      }
      if (match !== null && method === 'DELETE') {
        const removed = await service.remove(match[1]!)
        await app.watcher?.removeBot(match[1]!)
        await app.groups?.removeBot(match[1]!)
        send(response, 200, { deleted: true, ...removed })
        return
      }
      refuse(response, 404, 'not_found', `no route ${method} ${path}`)
    } catch (error) {
      if (error instanceof BotError) {
        refuse(response, STATUS[error.code], error.code, error.message)
        return
      }
      if (error instanceof MindError || error instanceof WatchError || error instanceof CourierError) {
        refuse(response, 400, 'invalid_request', error.message)
        return
      }
      if (error instanceof GroupError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'title_taken' || error.code === 'invalid_state' ? 409 : 400
        send(response, status, { error: error.code, message: error.message })
        return
      }
      console.error('futurebot: request failed', error)
      refuse(response, 500, 'session_failed', 'internal error')
    }
  }
}
