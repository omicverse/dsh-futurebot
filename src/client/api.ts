import type { Bot, BotErrorCode, BotInput } from '../shared/types.ts'

const BASE = '/futurebot/api'

/** A refusal from the Host, or `network` when it never answered. */
export class ApiError extends Error {
  constructor(readonly code: BotErrorCode | 'network' | string, message: string) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new ApiError('network', String(error))
  }
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!response.ok) {
    const code = typeof payload?.error === 'string' ? payload.error as BotErrorCode : 'network'
    throw new ApiError(code, typeof payload?.message === 'string' ? payload.message : response.statusText)
  }
  return payload as T
}

export interface MemoryEntry { id: string; kind: 'record' | 'inference' | 'correction'; text: string; about?: string; corrects?: string; correctedBy?: string; at: string }
export interface AgendaItem { id: string; goal: string; state: 'open' | 'done' | 'dropped'; history: { at: string; action: string; reason: string; trigger?: string }[] }
export interface Watch { id: string; path: string; note: string }
export interface Job { id: string; from: string; to: string; text: string; state: string; reply?: string; createdAt: string }
export interface Stage { title: string; owner: string; doneWhen: string; status: 'pending' | 'working' | 'checking' | 'passed'; attempts: number; evidence?: string; note?: string }
export interface Goal { objective: string; doneWhen: string; status: 'planning' | 'active' | 'waiting_user' | 'paused' | 'done' | 'stopped'; current: number; stages: Stage[] }
export interface Group { id: string; title: string; members: string[]; admin?: string; notice: string; approvals: 'admin' | 'user'; adminMayApprove: boolean; userIn: boolean; paused: boolean; goal?: Goal; rev: number }
export interface LogEntry { id: string; seq: number; from: string; kind: 'message' | 'event' | 'review'; text: string; mentions: string[]; at: string }
export interface GroupInput { title?: string; members?: string[]; admin?: string | null; notice?: string; approvals?: 'admin' | 'user'; adminMayApprove?: boolean; userIn?: boolean }

export const api = {
  list: () => call<{ bots: Bot[] }>('GET', '/bots').then(value => value.bots),
  defaultWorkspace: (name: string) => call<{ workspace: string }>('GET', `/workspace?name=${encodeURIComponent(name)}`).then(value => value.workspace),
  create: (input: BotInput) => call<{ bot: Bot }>('POST', '/bots', input).then(value => value.bot),
  update: (id: string, rev: number, input: BotInput) => call<{ bot: Bot }>('PATCH', `/bots/${encodeURIComponent(id)}`, { ...input, rev }).then(value => value.bot),
  remove: (id: string) => call<{ deleted: true; sessionId?: string }>('DELETE', `/bots/${encodeURIComponent(id)}`),
  memory: (id: string) => call<{ entries: MemoryEntry[] }>('GET', `/bots/${encodeURIComponent(id)}/memory`).then(value => value.entries),
  agenda: (id: string) => call<{ goals: AgendaItem[] }>('GET', `/bots/${encodeURIComponent(id)}/agenda`).then(value => value.goals),
  watches: (id: string) => call<{ watches: Watch[] }>('GET', `/bots/${encodeURIComponent(id)}/watches`).then(value => value.watches),
  jobs: () => call<{ jobs: Job[] }>('GET', '/jobs').then(value => value.jobs),
  groups: () => call<{ groups: Group[] }>('GET', '/groups').then(value => value.groups),
  group: (id: string) => call<{ group: Group }>('GET', `/groups/${encodeURIComponent(id)}`).then(value => value.group),
  createGroup: (input: GroupInput) => call<{ group: Group }>('POST', '/groups', input).then(value => value.group),
  updateGroup: (id: string, input: GroupInput) => call<{ group: Group }>('PATCH', `/groups/${encodeURIComponent(id)}`, input).then(value => value.group),
  removeGroup: (id: string) => call<{ deleted: true }>('DELETE', `/groups/${encodeURIComponent(id)}`),
  log: (id: string, after = 0) => call<{ entries: LogEntry[] }>('GET', `/groups/${encodeURIComponent(id)}/log?after=${after}`).then(value => value.entries),
  post: (id: string, text: string) => call<{ entry: LogEntry }>('POST', `/groups/${encodeURIComponent(id)}/post`, { text }).then(value => value.entry),
  goal: (id: string, action: string) => call<{ group: Group }>('POST', `/groups/${encodeURIComponent(id)}/goal`, { action }).then(value => value.group),
}

export type Api = typeof api
