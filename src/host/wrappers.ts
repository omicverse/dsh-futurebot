/**
 * How a message between bots reads inside the receiving conversation. Same
 * tags and escaping as OmicOS uses, minus
 * the thread attribute: here every bot has one conversation.
 */

export type ReplyStatus = 'returned' | 'failed' | 'stopped' | 'unknown'

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function body(text: string): string {
  return text.replace(/<\/(from_bot|bot_reply)/g, '&lt;/$1')
}

export interface FromBot {
  name: string
  botId: string
  job: string
  expectReply: boolean
  text: string
  /** Set when the same job is handed over again after a restart cut its turn short. */
  resumed?: boolean
}

export function fromBot(message: FromBot): string {
  const lines = [
    `<from_bot name="${attr(message.name)}" bot_id="${attr(message.botId)}" job="${attr(message.job)}" reply="${message.expectReply ? 'expected' : 'none'}">`,
    body(message.text),
    '</from_bot>',
  ]
  if (message.resumed) lines.push('(This was handed to you before a restart interrupted your turn. Continue from where you were.)')
  if (message.expectReply) lines.push(`(Your final answer in this turn goes back to ${message.name} automatically.)`)
  return lines.join('\n')
}

export interface BotReply {
  name: string
  botId: string
  job: string
  status: ReplyStatus
  text: string
}

export function botReply(message: BotReply): string {
  return [
    `<bot_reply name="${attr(message.name)}" bot_id="${attr(message.botId)}" job="${attr(message.job)}" status="${message.status}">`,
    body(message.text),
    '</bot_reply>',
  ].join('\n')
}
