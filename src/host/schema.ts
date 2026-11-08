import { z } from 'zod'
import { PERMISSION_MODES, type Bot } from '../shared/types.ts'
import type { Job } from './courier.ts'
import type { Watch } from './evidence.ts'
import type { Group, LogEntry } from './groups.ts'
import type { AgendaItem, MemoryEntry } from './mind.ts'

/** Storage-domain unit name; the Harness requires /^[a-z][a-z0-9_]*$/. */
export const DOMAIN_NAME = 'futurebot'

const instant = z.iso.datetime({ precision: 3 })

/** The stored shape of one bot; the storage domain validates every row with it. */
export const botSchema: z.ZodType<Bot> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string(),
  basePreset: z.string().min(1).optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
  permission: z.enum(PERMISSION_MODES as [Bot['permission'], ...Bot['permission'][]]),
  isMain: z.boolean().optional(),
  approvalScope: z.enum(['each', 'once_per_chat']).optional(),
  workspace: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  createdAt: instant,
  updatedAt: instant,
  rev: z.number().int().positive(),
}).strict()

/** Storage-domain unit for jobs between bots, kept apart so the bot table never migrates for it. */
export const JOBS_DOMAIN_NAME = 'futurebot_jobs'

const JOB_STATES = ['queued', 'delivered', 'answering', 'waiting_children', 'returned', 'failed', 'stopped', 'unknown', 'read'] as const

export const jobSchema: z.ZodType<Job> = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  text: z.string(),
  expectReply: z.boolean(),
  parent: z.string().min(1).optional(),
  root: z.string().min(1),
  depth: z.number().int().positive(),
  originSession: z.string().min(1),
  targetSession: z.string().min(1),
  state: z.enum(JOB_STATES),
  messageId: z.string().min(1).optional(),
  resumed: z.boolean().optional(),
  reply: z.string().optional(),
  replyMessageId: z.string().min(1).optional(),
  replyEntered: z.boolean().optional(),
  createdAt: instant,
  updatedAt: instant,
}).strict()

/** Storage-domain unit for each bot's memory, agenda and watched folders. */
export const MIND_DOMAIN_NAME = 'futurebot_mind'

export const memorySchema: z.ZodType<MemoryEntry> = z.object({
  id: z.string().min(1),
  bot: z.string().min(1),
  kind: z.enum(['record', 'inference', 'correction']),
  text: z.string().min(1),
  about: z.string().min(1).optional(),
  corrects: z.string().min(1).optional(),
  correctedBy: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  at: instant,
}).strict()

const agendaChange = z.object({
  at: instant,
  action: z.enum(['add', 'revise', 'done', 'drop', 'reopen']),
  goal: z.string().min(1).optional(),
  reason: z.string().min(1),
  trigger: z.string().min(1).optional(),
}).strict()

export const agendaSchema: z.ZodType<AgendaItem> = z.object({
  id: z.string().min(1),
  bot: z.string().min(1),
  goal: z.string().min(1),
  state: z.enum(['open', 'done', 'dropped']),
  order: z.number().int().positive(),
  createdAt: instant,
  updatedAt: instant,
  history: z.array(agendaChange).min(1),
}).strict()

export const watchSchema: z.ZodType<Watch> = z.object({
  id: z.string().min(1),
  bot: z.string().min(1),
  path: z.string().min(1),
  note: z.string(),
  createdAt: instant,
}).strict()

/** Storage-domain unit for groups and their logs. */
export const GROUPS_DOMAIN_NAME = 'futurebot_groups'

const stageSchema = z.object({
  title: z.string().min(1),
  owner: z.string().min(1),
  doneWhen: z.string().min(1),
  status: z.enum(['pending', 'working', 'checking', 'passed']),
  attempts: z.number().int().nonnegative(),
  evidence: z.string().optional(),
  note: z.string().optional(),
  startSeq: z.number().int().positive().optional(),
}).strict()

const goalSchema = z.object({
  objective: z.string().min(1),
  doneWhen: z.string().min(1),
  status: z.enum(['planning', 'active', 'waiting_user', 'paused', 'done', 'stopped']),
  current: z.number().int().nonnegative(),
  stages: z.array(stageSchema).min(1),
  createdAt: instant,
  updatedAt: instant,
}).strict()

export const groupSchema: z.ZodType<Group> = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  members: z.array(z.string().min(1)),
  admin: z.string().min(1).optional(),
  notice: z.string(),
  approvals: z.enum(['admin', 'user']),
  adminMayApprove: z.boolean(),
  userIn: z.boolean(),
  sessions: z.record(z.string(), z.string()),
  cursors: z.record(z.string(), z.number().int().nonnegative()),
  paused: z.boolean(),
  idleRounds: z.number().int().nonnegative(),
  batch: z.array(z.string()).optional(),
  goal: goalSchema.optional(),
  nextSeq: z.number().int().positive(),
  createdAt: instant,
  updatedAt: instant,
  rev: z.number().int().positive(),
}).strict()

export const logEntrySchema: z.ZodType<LogEntry> = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  seq: z.number().int().positive(),
  from: z.string().min(1),
  kind: z.enum(['message', 'event', 'review']),
  text: z.string(),
  mentions: z.array(z.string()),
  at: instant,
}).strict()
