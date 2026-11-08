/**
 * Wire shapes shared by the Host plugin and the browser page.
 * Keep this file free of runtime imports: both halves compile it.
 */

/**
 * What a bot may do without asking. Only the user can change it. Mapped onto
 * the Harness's own knobs: `read_only` = read-only sandbox, each write needs
 * approval; `auto` = workspace-write sandbox, approval to go beyond it;
 * `full` = no sandbox, no approvals.
 */
export type PermissionMode = 'read_only' | 'auto' | 'full'

export const PERMISSION_MODES: readonly PermissionMode[] = ['read_only', 'auto', 'full']

export type ApprovalScope = 'each' | 'once_per_chat'
export const APPROVAL_SCOPES: readonly ApprovalScope[] = ['each', 'once_per_chat']

/** A model a bot runs on; absent means the Harness default. */
export interface BotModel {
  readonly provider: string
  readonly model: string
}

/** One bot as stored and as the page sees it. */
export interface Bot {
  readonly id: string
  readonly name: string
  /** The user's standing instructions to this bot. */
  readonly instructions: string
  /** Agent preset its conversation runs; absent means the Harness default preset. */
  readonly basePreset?: string
  readonly model?: BotModel
  readonly permission: PermissionMode
  /** The user's coordinator: delegates to the other bots. At most one bot has it. */
  readonly isMain?: boolean
  /**
   * After an operation was allowed once in a conversation, allow the same kind
   * again there without asking (`once_per_chat`, the default for new bots), or
   * ask every time (`each`, and bots made before the setting existed).
   */
  readonly approvalScope?: ApprovalScope
  /** Absolute directory the bot works in. */
  readonly workspace: string
  /** Its ongoing conversation; set once the Harness created it. */
  readonly sessionId?: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Bumped on every change; edits name the revision they started from. */
  readonly rev: number
}

/** Fields a create or edit request may carry. */
export interface BotInput {
  readonly name?: string
  readonly instructions?: string
  readonly basePreset?: string | null
  readonly model?: BotModel | null
  readonly permission?: PermissionMode
  readonly workspace?: string
  readonly isMain?: boolean
  readonly approvalScope?: ApprovalScope
}

/** Machine-readable refusal codes the page localizes. */
export type BotErrorCode =
  | 'invalid_request'
  | 'invalid_name'
  | 'duplicate_name'
  | 'invalid_instructions'
  | 'invalid_permission'
  | 'invalid_workspace'
  | 'invalid_model'
  | 'invalid_preset'
  | 'not_found'
  | 'conflict'
  | 'session_failed'
  | 'too_many_bots'

export interface BotErrorBody {
  readonly error: BotErrorCode
  readonly message: string
}

export const LIMITS = {
  nameLength: 40,
  instructionsLength: 8000,
  maxBots: 64,
} as const
