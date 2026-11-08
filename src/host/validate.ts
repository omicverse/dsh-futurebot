import { isAbsolute, normalize } from 'node:path'
import { APPROVAL_SCOPES, LIMITS, PERMISSION_MODES, type ApprovalScope, type Bot, type BotErrorCode, type BotInput, type BotModel, type PermissionMode } from '../shared/types.ts'

/** A refusal the HTTP layer turns into a 4xx with a stable code. */
export class BotError extends Error {
  constructor(readonly code: BotErrorCode, message: string) {
    super(message)
    this.name = 'BotError'
  }
}

/** A validated edit: only the fields the request carried, already normalized. */
export interface BotPatch {
  name?: string
  instructions?: string
  basePreset?: string | undefined
  model?: BotModel | undefined
  permission?: PermissionMode
  workspace?: string
  isMain?: boolean
  approvalScope?: ApprovalScope
}

// Control characters other than tab/newline never belong in a name or prompt.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new BotError('invalid_name', 'name must be a string')
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length === 0 || name.length > LIMITS.nameLength || CONTROL.test(name)) {
    throw new BotError('invalid_name', `name must be 1–${LIMITS.nameLength} printable characters`)
  }
  return name
}

function cleanInstructions(value: unknown): string {
  if (typeof value !== 'string') throw new BotError('invalid_instructions', 'instructions must be a string')
  const text = value.replace(/\r\n/g, '\n').trim()
  if (text.length > LIMITS.instructionsLength || CONTROL.test(text)) {
    throw new BotError('invalid_instructions', `instructions must be at most ${LIMITS.instructionsLength} printable characters`)
  }
  return text
}

function cleanWorkspace(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value.trim())) {
    throw new BotError('invalid_workspace', 'workspace must be an absolute directory path')
  }
  return normalize(value.trim())
}

function cleanModel(value: unknown): BotModel | undefined {
  if (value === null) return undefined
  if (typeof value !== 'object' || value === undefined) throw new BotError('invalid_model', 'model must be {provider, model} or null')
  const { provider, model } = value as Record<string, unknown>
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.trim() === '' || model.trim() === '') {
    throw new BotError('invalid_model', 'model needs a provider and a model name')
  }
  return { provider: provider.trim(), model: model.trim() }
}

function cleanPreset(value: unknown): string | undefined {
  if (value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) {
    throw new BotError('invalid_preset', 'basePreset must be a preset id')
  }
  return value
}

function cleanPermission(value: unknown): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) {
    throw new BotError('invalid_permission', `permission must be one of ${PERMISSION_MODES.join(', ')}`)
  }
  return value as PermissionMode
}

const KNOWN = new Set(['name', 'instructions', 'basePreset', 'model', 'permission', 'workspace', 'isMain', 'approvalScope'])

/**
 * Validate a create or edit body. Unknown fields are refused rather than
 * ignored, so a typo never silently does nothing.
 */
export function parseInput(body: unknown): BotPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BotError('invalid_request', 'request body must be a JSON object')
  }
  const input = body as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!KNOWN.has(key)) throw new BotError('invalid_request', `unknown field: ${key}`)
  }
  const patch: BotPatch = {}
  if ('name' in input) patch.name = cleanName(input.name)
  if ('instructions' in input) patch.instructions = cleanInstructions(input.instructions)
  if ('basePreset' in input) patch.basePreset = cleanPreset(input.basePreset)
  if ('model' in input) patch.model = cleanModel(input.model)
  if ('permission' in input) patch.permission = cleanPermission(input.permission)
  if ('workspace' in input) patch.workspace = cleanWorkspace(input.workspace)
  if ('isMain' in input) {
    if (typeof input.isMain !== 'boolean') throw new BotError('invalid_request', 'isMain must be true or false')
    patch.isMain = input.isMain
  }
  if ('approvalScope' in input) {
    if (!APPROVAL_SCOPES.includes(input.approvalScope as ApprovalScope)) throw new BotError('invalid_request', `approvalScope must be one of ${APPROVAL_SCOPES.join(', ')}`)
    patch.approvalScope = input.approvalScope as ApprovalScope
  }
  return patch
}

/** Names are unique ignoring case and surrounding space. */
export function assertUniqueName(name: string, bots: Iterable<Bot>, exceptId?: string): void {
  const wanted = name.toLocaleLowerCase()
  for (const bot of bots) {
    if (bot.id !== exceptId && bot.name.toLocaleLowerCase() === wanted) {
      throw new BotError('duplicate_name', `a bot named ${bot.name} already exists`)
    }
  }
}

export type { BotInput }
