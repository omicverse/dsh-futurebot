import type { Bot } from '../shared/types.ts'

/** The slice of a storage-domain table the plugin uses; tests supply a Map-backed one. */
export interface BotTable {
  get(id: string): Bot | undefined
  entries(): Iterable<[string, Bot]>
  put(id: string, bot: Bot): Promise<void>
  delete(id: string): Promise<boolean>
}

/** In-memory table for tests. */
export class MemoryTable implements BotTable {
  private readonly rows = new Map<string, Bot>()
  get(id: string): Bot | undefined { return this.rows.get(id) }
  entries(): Iterable<[string, Bot]> { return [...this.rows.entries()] }
  async put(id: string, bot: Bot): Promise<void> { this.rows.set(id, bot) }
  async delete(id: string): Promise<boolean> { return this.rows.delete(id) }
}
