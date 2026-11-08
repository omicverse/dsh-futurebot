/**
 * `@name` mentions in group messages, with the same rules as OmicOS:
 * longest name first, case-insensitive; an `@`
 * preceded by an ASCII letter, digit, `_` or `.` does not count (e-mail
 * addresses); a name followed by an ASCII letter, digit, `_` or `-` does not
 * count (`@Lin` inside `@Linda`), while CJK text right after a name does
 * (`@林分析帮我`); mentions inside inline code and links do not count.
 */

export const EVERYONE = ['所有人', '全体', 'all', 'everyone'] as const
export const USER_NAMES = ['用户', 'user'] as const

export interface Named {
  id: string
  name: string
}

export interface Mentions {
  /** Bot ids, in the order they first appear. */
  bots: string[]
  everyone: boolean
  user: boolean
}

/** Drop inline code, fenced code and link targets, where mentions do not count. */
function visible(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/https?:\/\/\S+/g, ' ')
}

export function parseMentions(text: string, members: readonly Named[]): Mentions {
  const source = visible(text)
  const lower = source.toLocaleLowerCase()
  const names = [
    ...members.map(member => ({ key: member.name.toLocaleLowerCase(), id: member.id as string | undefined, kind: 'bot' as const })),
    ...EVERYONE.map(key => ({ key, id: undefined, kind: 'everyone' as const })),
    ...USER_NAMES.map(key => ({ key, id: undefined, kind: 'user' as const })),
  ].sort((a, b) => b.key.length - a.key.length)
  const found: Mentions = { bots: [], everyone: false, user: false }
  for (let at = lower.indexOf('@'); at >= 0; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && /[A-Za-z0-9_.]/.test(source[at - 1]!)) continue
    const rest = lower.slice(at + 1)
    const hit = names.find(name => rest.startsWith(name.key) && !/^[A-Za-z0-9_-]/.test(source.slice(at + 1 + name.key.length)))
    if (hit === undefined) continue
    if (hit.kind === 'everyone') found.everyone = true
    else if (hit.kind === 'user') found.user = true
    else if (!found.bots.includes(hit.id!)) found.bots.push(hit.id!)
  }
  return found
}
