/**
 * Prompt contexts are logged as a full snapshot every time their text
 * changes. Memory and agenda change often, so their text is refreshed at
 * most once every `everyTurns` turns (and whenever an agent is created or
 * resumed). What a bot wrote in the meantime is already in its conversation
 * as its own tool calls.
 */
export class DigestCache {
  private readonly cache = new Map<string, { text: string; turns: number }>()

  constructor(private readonly everyTurns = 10) {}

  get(sessionId: string, name: string, compute: () => string): string {
    const key = `${sessionId}\u0000${name}`
    const cached = this.cache.get(key)
    if (cached === undefined) {
      const text = compute()
      this.cache.set(key, { text, turns: 0 })
      return text
    }
    if (cached.turns >= this.everyTurns) {
      const text = compute()
      if (text !== cached.text) this.cache.set(key, { text, turns: 0 })
    }
    return this.cache.get(key)!.text
  }

  turnEnded(sessionId: string): void {
    for (const [key, value] of this.cache) if (key.startsWith(`${sessionId}\u0000`)) value.turns += 1
  }

  forget(sessionId: string): void {
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.cache.delete(key)
  }
}
