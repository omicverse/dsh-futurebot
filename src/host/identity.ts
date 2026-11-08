import type { Bot } from '../shared/types.ts'

/** Names of the per-bot prompt contexts; unique within one agent's scope. */
export const IDENTITY_CONTEXT = 'futurebot:identity'
export const TEAM_CONTEXT = 'futurebot:team'
export const MEMORY_CONTEXT = 'futurebot:memory'
export const AGENDA_CONTEXT = 'futurebot:agenda'
export const GROUP_CONTEXT = 'futurebot:group'

/**
 * Just before the Harness's working-directory context (order 100): the bot
 * learns who it is and who it works with before where it is.
 */
export const IDENTITY_ORDER = 90
export const TEAM_ORDER = 92
export const MEMORY_ORDER = 94
export const AGENDA_ORDER = 96
export const GROUP_ORDER = 98

/** Keep user text from closing the block it is quoted in. */
function quote(text: string): string {
  return text.replace(/<\/?\s*instructions\s*>/gi, '')
}

/**
 * The model-facing account of who this bot is and how it works with others.
 *
 * It is a prompt *context*, not a system-prompt section: the Harness logs it
 * after the retained history and resends it only when it changes. The system
 * prompt and tool list therefore stay identical across every bot, which keeps
 * their prompt-cache prefix shared.
 */
export function identityText(bot: Bot): string {
  const lines = [
    `You are ${bot.name}, a Bot: a persistent AI individual who works with the user over the long term.`,
    'This conversation is your own ongoing conversation. It continues across days and tasks, so earlier turns in it are your own history and commitments.',
    `Your workspace is ${bot.workspace}. Keep your files there unless the user names another place.`,
    'You work with other bots. bot_list shows them; bot_send gives one of them a message or a piece of work. When you ask a bot for something, its answer arrives later as a new message in this conversation: do not wait or poll for it, finish what you can and end your turn.',
    'When another bot sends you work (a <from_bot> message), do it. Your final answer in that turn is the answer: it is delivered back automatically, so write it for that bot. A <bot_reply> message is the answer to something you asked.',
    'You learn from experience. Keep what matters with memory_note (records of what happened, conclusions, and corrections when you were wrong, marked with who they concern), and look things up with memory_search and search_own. Track goals that outlast a turn with agenda_update, always with a reason. To be woken by new evidence rather than by someone asking, watch a folder with watch_folder; to come back at a time, use a schedule tool if one is available. Your memory and agenda below may lag your latest notes by a few turns.',
  ]
  if (bot.isMain) {
    lines.push('You are the user\'s coordinator. When a request fits another bot better, delegate it with bot_send, then report the answers to the user when they come back.')
  }
  if (bot.instructions !== '') {
    lines.push('The user\'s standing instructions to you:', '<instructions>', quote(bot.instructions), '</instructions>')
  }
  return lines.join('\n')
}

/** One line about what a bot does: the start of its instructions. */
export function roleLine(bot: Bot): string {
  const first = bot.instructions.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

/** The other bots this bot can message; resent only when the team changes. */
export function teamText(bot: Bot, bots: readonly Bot[]): string {
  const others = bots.filter(other => other.id !== bot.id)
  if (others.length === 0) return 'You are the only bot so far.'
  return [
    'Bots you can message with bot_send:',
    ...others.map(other => {
      const role = roleLine(other)
      return `- ${other.name}${other.isMain ? ' (coordinator)' : ''}${role === '' ? '' : `: ${role}`}`
    }),
  ].join('\n')
}
