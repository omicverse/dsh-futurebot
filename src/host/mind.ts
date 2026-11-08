import { randomUUID } from 'node:crypto'
import type { Bot } from '../shared/types.ts'

/**
 * A bot's own memory and agenda. A bot is one independent individual, so
 * its memory is one whole, is never split by user, and is written only by
 * the bot itself.
 *
 * Memory keeps three kinds apart, as the Perspective asks: records of what
 * happened, inferences the bot drew, and corrections. A correction never
 * deletes what it corrects; it marks it, so the history of a belief stays
 * readable. Entries may be about a collaborator (the user or another bot):
 * that is how the bot keeps what each collaborator asked, refused and
 * corrected.
 *
 * The agenda is the bot's list of goals. Every change carries a reason and,
 * when one exists, the evidence that prompted it.
 */

export type MemoryKind = 'record' | 'inference' | 'correction'
export const MEMORY_KINDS: readonly MemoryKind[] = ['record', 'inference', 'correction']

export interface MemoryEntry {
  id: string
  bot: string
  kind: MemoryKind
  text: string
  /** `user`, or the id of the bot this is about. */
  about?: string
  /** The entry this one corrects. */
  corrects?: string
  /** Set on an entry a later correction replaced. */
  correctedBy?: string
  /** The conversation it was written in. */
  session?: string
  at: string
}

export type AgendaAction = 'add' | 'revise' | 'done' | 'drop' | 'reopen'
export const AGENDA_ACTIONS: readonly AgendaAction[] = ['add', 'revise', 'done', 'drop', 'reopen']

export interface AgendaChange {
  at: string
  action: AgendaAction
  goal?: string
  reason: string
  /** What prompted the change, e.g. an evidence notice. */
  trigger?: string
}

export interface AgendaItem {
  id: string
  bot: string
  goal: string
  state: 'open' | 'done' | 'dropped'
  /** Position among open goals; lower first. */
  order: number
  createdAt: string
  updatedAt: string
  history: AgendaChange[]
}

export interface Table<T> {
  get(id: string): T | undefined
  entries(): Iterable<[string, T]>
  put(id: string, value: T): Promise<void>
  delete(id: string): Promise<boolean>
}

export class MindError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MindError'
  }
}

export const MIND_LIMITS = {
  entryLength: 2000,
  entriesPerBot: 500,
  goalLength: 300,
  reasonLength: 500,
  openGoals: 30,
  digestChars: 2400,
} as const

export interface NoteInput {
  kind: string
  text: string
  /** `user`, a bot's name or id. */
  about?: string
  corrects?: string
}

export interface AgendaInput {
  action: string
  id?: string
  goal?: string
  /** 1-based position among open goals. */
  position?: number
  reason: string
  trigger?: string
}

export interface MindOptions {
  now?: () => Date
  newId?: (prefix: 'm' | 'a') => string
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export class Mind {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date
  private readonly newId: (prefix: 'm' | 'a') => string

  constructor(
    private readonly memory: Table<MemoryEntry>,
    private readonly agenda: Table<AgendaItem>,
    private readonly bots: () => readonly Bot[],
    options: MindOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (prefix => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`)
  }

  // ── memory ──────────────────────────────────────────────────────────────

  entries(bot: string): MemoryEntry[] {
    return [...this.memory.entries()].map(([, entry]) => entry).filter(entry => entry.bot === bot)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  }

  note(bot: string, input: NoteInput, session?: string): Promise<MemoryEntry> {
    return this.serial(async () => {
      if (!MEMORY_KINDS.includes(input.kind as MemoryKind)) throw new MindError(`kind must be one of ${MEMORY_KINDS.join(', ')}`)
      const text = input.text.trim()
      if (text === '' || text.length > MIND_LIMITS.entryLength) throw new MindError(`text must be 1–${MIND_LIMITS.entryLength} characters`)
      const about = input.about === undefined || input.about.trim() === '' ? undefined : this.collaborator(input.about, bot)
      let corrected: MemoryEntry | undefined
      if (input.corrects !== undefined && input.corrects.trim() !== '') {
        corrected = this.memory.get(input.corrects.trim())
        if (corrected === undefined || corrected.bot !== bot) throw new MindError(`you have no memory entry ${input.corrects}`)
      }
      if (input.kind === 'correction' && corrected === undefined && about === undefined) {
        throw new MindError('a correction names the entry it corrects (corrects) or who it is about (about)')
      }
      const entry: MemoryEntry = {
        id: this.newId('m'), bot, kind: input.kind as MemoryKind, text,
        ...(about === undefined ? {} : { about }),
        ...(corrected === undefined ? {} : { corrects: corrected.id }),
        ...(session === undefined ? {} : { session }),
        at: this.now().toISOString(),
      }
      await this.memory.put(entry.id, entry)
      if (corrected !== undefined) await this.memory.put(corrected.id, { ...corrected, correctedBy: entry.id })
      await this.prune(bot)
      return entry
    })
  }

  /** Every term must appear, ignoring case; newest first. Without a query: the newest entries. */
  search(bot: string, query: string | undefined, limit = 10): MemoryEntry[] {
    const terms = (query ?? '').toLocaleLowerCase().split(/\s+/).filter(term => term !== '')
    return this.entries(bot).reverse()
      .filter(entry => terms.every(term => `${entry.text} ${this.aboutName(entry.about) ?? ''}`.toLocaleLowerCase().includes(term)))
      .slice(0, Math.max(1, Math.min(limit, 50)))
  }

  /**
   * Replace a bot's whole memory (used to keep, clear or swap experience in a
   * controlled test). Entries get fresh ids, so copying another bot's memory
   * never touches the original; references between them are carried over.
   */
  replaceMemory(bot: string, entries: readonly Omit<MemoryEntry, 'bot'>[]): Promise<void> {
    return this.serial(async () => {
      for (const entry of entries) {
        if (!MEMORY_KINDS.includes(entry.kind) || typeof entry.text !== 'string' || entry.text.trim() === '') {
          throw new MindError('each entry needs a kind (record, inference or correction) and text')
        }
      }
      const ids = new Map(entries.map(entry => [entry.id, this.newId('m')]))
      for (const entry of this.entries(bot)) await this.memory.delete(entry.id)
      for (const entry of entries) {
        const { corrects, correctedBy, ...rest } = entry
        const next: MemoryEntry = {
          ...rest, id: ids.get(entry.id)!, bot,
          ...(corrects !== undefined && ids.has(corrects) ? { corrects: ids.get(corrects)! } : {}),
          ...(correctedBy !== undefined && ids.has(correctedBy) ? { correctedBy: ids.get(correctedBy)! } : {}),
        }
        await this.memory.put(next.id, next)
      }
    })
  }

  /** A short account of the bot's memory for its prompt context. */
  memoryDigest(bot: string): string {
    const all = this.entries(bot)
    if (all.length === 0) {
      return 'Your memory is empty. Keep what you learn with memory_note: records of what happened, conclusions you draw, and corrections, each about the user or a bot when it concerns them.'
    }
    const live = all.filter(entry => entry.correctedBy === undefined).reverse()
    const line = (entry: MemoryEntry) => `- [${entry.id}] ${clip(entry.text.replace(/\s+/g, ' '), 240)}${entry.corrects ? ` (corrects ${entry.corrects})` : ''}`
    const sections: string[] = ['Your memory (only you write it; cite an entry by its id when you rely on it):']
    const used = new Set<string>()
    const take = (title: string, list: MemoryEntry[], max: number) => {
      const picked = list.filter(entry => !used.has(entry.id)).slice(0, max)
      if (picked.length === 0) return
      for (const entry of picked) used.add(entry.id)
      sections.push(title, ...picked.map(line))
    }
    take('Corrections:', live.filter(entry => entry.kind === 'correction'), 12)
    take('About the user:', live.filter(entry => entry.about === 'user'), 6)
    for (const other of this.bots()) {
      if (other.id !== bot) take(`About ${other.name}:`, live.filter(entry => entry.about === other.id), 3)
    }
    take('What you have concluded:', live.filter(entry => entry.kind === 'inference'), 6)
    take('Recent records:', live.filter(entry => entry.kind === 'record'), 5)
    let text = ''
    for (const section of sections) {
      if (text.length + section.length + 1 > MIND_LIMITS.digestChars) break
      text += (text === '' ? '' : '\n') + section
    }
    const hidden = all.length - used.size
    if (hidden > 0) text += `\n(${hidden} more entries, including replaced ones: use memory_search.)`
    return text
  }

  // ── agenda ──────────────────────────────────────────────────────────────

  goals(bot: string): AgendaItem[] {
    return [...this.agenda.entries()].map(([, item]) => item).filter(item => item.bot === bot)
      .sort((a, b) => {
        const openA = a.state === 'open' ? 0 : 1
        const openB = b.state === 'open' ? 0 : 1
        if (openA !== openB) return openA - openB
        // Open goals in the bot's order; finished ones in the order they finished.
        return openA === 0 ? a.order - b.order || a.createdAt.localeCompare(b.createdAt) : a.updatedAt.localeCompare(b.updatedAt)
      })
  }

  plan(bot: string, input: AgendaInput): Promise<AgendaItem> {
    return this.serial(async () => {
      if (!AGENDA_ACTIONS.includes(input.action as AgendaAction)) throw new MindError(`action must be one of ${AGENDA_ACTIONS.join(', ')}`)
      const action = input.action as AgendaAction
      const reason = input.reason.trim()
      if (reason.length < 2 || reason.length > MIND_LIMITS.reasonLength) throw new MindError('give a reason for the change (2–500 characters)')
      const goal = input.goal?.trim()
      if (goal !== undefined && (goal === '' || goal.length > MIND_LIMITS.goalLength)) throw new MindError(`goal must be 1–${MIND_LIMITS.goalLength} characters`)
      const stamp = this.now().toISOString()
      const change: AgendaChange = { at: stamp, action, reason, ...(goal === undefined ? {} : { goal }), ...(input.trigger ? { trigger: input.trigger } : {}) }
      const open = this.goals(bot).filter(item => item.state === 'open')
      let item: AgendaItem
      if (action === 'add') {
        if (goal === undefined) throw new MindError('add needs a goal')
        if (open.length >= MIND_LIMITS.openGoals) throw new MindError(`at most ${MIND_LIMITS.openGoals} open goals; finish or drop some first`)
        item = { id: this.newId('a'), bot, goal, state: 'open', order: open.length + 1, createdAt: stamp, updatedAt: stamp, history: [change] }
      } else {
        const current = input.id === undefined ? undefined : this.agenda.get(input.id.trim())
        if (current === undefined || current.bot !== bot) throw new MindError(`you have no goal ${input.id ?? ''}`.trim())
        const state = action === 'done' ? 'done' : action === 'drop' ? 'dropped' : 'open'
        if (action === 'revise' && current.state !== 'open') throw new MindError('only an open goal can be revised; reopen it first')
        item = { ...current, ...(goal === undefined ? {} : { goal }), state, updatedAt: stamp, history: [...current.history, change] }
      }
      await this.agenda.put(item.id, item)
      await this.reorder(bot, item, input.position)
      return this.agenda.get(item.id)!
    })
  }

  agendaDigest(bot: string): string {
    const open = this.goals(bot).filter(item => item.state === 'open')
    if (open.length === 0) return 'Your agenda is empty. When you take on goals that outlast one turn, track them with agenda_update.'
    const lines = open.map((item, index) => {
      const last = item.history[item.history.length - 1]!
      return `${index + 1}. [${item.id}] ${clip(item.goal, 200)}${last.action === 'add' ? '' : ` (last ${last.action}: ${clip(last.reason, 100)})`}`
    })
    return ['Your agenda (open goals, in your order):', ...lines].join('\n')
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private collaborator(name: string, self: string): string {
    const wanted = name.trim().toLocaleLowerCase()
    if (wanted === 'user' || wanted === 'the user' || wanted === '用户') return 'user'
    const bot = this.bots().find(other => other.id === name.trim() || other.name.toLocaleLowerCase() === wanted)
    if (bot === undefined) throw new MindError(`about must be "user" or a bot's name; no bot named ${name}`)
    if (bot.id === self) throw new MindError('about names someone else; leave it out for notes about yourself')
    return bot.id
  }

  private aboutName(about: string | undefined): string | undefined {
    if (about === undefined) return undefined
    if (about === 'user') return 'user'
    return this.bots().find(bot => bot.id === about)?.name
  }

  /** Keep the newest entries; drop old records first, never corrections. */
  private async prune(bot: string): Promise<void> {
    const all = this.entries(bot)
    let excess = all.length - MIND_LIMITS.entriesPerBot
    for (const kind of ['record', 'inference'] as const) {
      for (const entry of all.filter(e => e.kind === kind)) {
        if (excess <= 0) return
        await this.memory.delete(entry.id)
        excess -= 1
      }
    }
  }

  private async reorder(bot: string, moved: AgendaItem, position: number | undefined): Promise<void> {
    const open = this.goals(bot).filter(item => item.state === 'open' && item.id !== moved.id)
    const latest = this.agenda.get(moved.id)!
    if (latest.state === 'open') {
      const at = position === undefined ? open.findIndex(item => item.order > latest.order) : Math.max(0, Math.min(open.length, Math.floor(position) - 1))
      open.splice(at < 0 ? open.length : at, 0, latest)
    }
    for (const [index, item] of open.entries()) {
      if (item.order !== index + 1) await this.agenda.put(item.id, { ...this.agenda.get(item.id)!, order: index + 1 })
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }
}
