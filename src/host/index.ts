/**
 * futurebot Host plugin.
 *
 * A bot is a record in the plugin's storage domain plus ordinary Harness
 * sessions: its own ongoing conversation, and one seat per group it is in.
 * The plugin never runs its own agent loop. It gives each bot conversation an
 * identity, its team, its memory and agenda, its group's rules and the bot
 * tools; keeps the sessions' title, model and permission in line with the
 * record; carries work between bots (courier.ts) and in groups (groups.ts);
 * wakes bots on evidence (evidence.ts); answers approval requests first where
 * a bot's settings or its group allow (approvals.ts); and serves the API.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-user-approval'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalPolicy } from './approvals.ts'
import { Courier, type TurnEnding } from './courier.ts'
import { DigestCache } from './digests.ts'
import { botDomain, groupDomain, jobDomain, mindDomain } from './domain.ts'
import { Watcher } from './evidence.ts'
import { Groups } from './groups.ts'
import {
  Attachments, HarnessConversations, HarnessGroupPorts, HarnessHistory, HarnessMailbox, HarnessReviewer, HarnessSessions, HarnessWatchPort,
} from './harness.ts'
import { searchOwn } from './history.ts'
import { Mind } from './mind.ts'
import { API_PREFIX, createHandler, type App } from './routes.ts'
import { BotService } from './service.ts'
import { botTools } from './tools.ts'

export const name = 'futurebot'

export const inject = ['agents', 'sessionController', 'storageDomain', 'tools']

const ENDINGS = new Set<TurnEnding>(['completed', 'error', 'aborted', 'interrupted', 'blocked', 'max-tokens'])
/** Jobs not yet picked up; picked-up ones show as their recipient's running turn. */
const NOT_STARTED = new Set(['queued', 'delivered'])

/** The text blocks of an assistant message, joined. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n')
}

function usesTools(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => block?.type === 'tool-call')
}

export function apply(ctx: Context): void {
  let app: App | undefined
  let tools: ReturnType<typeof botTools> = []
  const digests = new DigestCache()
  /** The bot a session belongs to: its own conversation, or one of its group seats. */
  const botFor = (sessionId: string) => app?.service.forSession(sessionId) ?? app?.groups?.forSession(sessionId)?.bot
  const attachments = new Attachments({
    lookup: botFor,
    roster: () => app?.service.list() ?? [],
    tools: () => tools,
    memory: botId => app?.mind?.memoryDigest(botId) ?? '',
    agenda: botId => app?.mind?.agendaDigest(botId) ?? '',
    digests,
    group: sessionId => {
      const seat = app?.groups?.forSession(sessionId)
      return seat === undefined ? '' : app!.groups!.context(seat.group, seat.bot.id)
    },
  })

  const ready: Promise<App> = Promise.all([
    ctx.storageDomain.open(botDomain), ctx.storageDomain.open(jobDomain), ctx.storageDomain.open(mindDomain), ctx.storageDomain.open(groupDomain),
  ]).then(([bots, jobs, mind, grouped]) => {
    const sessions = new HarnessSessions(ctx)
    const service = new BotService(bots.table('bots'), sessions, {
      // The Harness may create the Agent inside `create`, before the record exists.
      onBound: bot => {
        const agent = bot.sessionId === undefined ? undefined : ctx.agents.get(SessionId(bot.sessionId))
        if (agent !== undefined) attachments.attach(agent)
      },
    })
    const courier = new Courier(jobs.table('jobs'), new HarnessMailbox(ctx), service)
    const minds = new Mind(mind.table('memory'), mind.table('agenda'), () => service.list())
    const watcher = new Watcher(mind.table('watches'), new HarnessWatchPort(ctx), id => service.get(id))
    const groups = new Groups(grouped.table('groups'), grouped.table('log'), service, new HarnessGroupPorts(ctx, sessions), {
      onSeats: seats => {
        for (const seat of seats) {
          const agent = ctx.agents.get(SessionId(seat))
          if (agent !== undefined) attachments.attach(agent)
        }
      },
    })
    const history = new HarnessHistory(ctx)
    const reviewer = new HarnessReviewer(ctx)
    const approvals = new ApprovalPolicy({
      locate: sessionId => {
        const own = service.forSession(sessionId)
        if (own !== undefined) return { bot: own }
        const seat = groups.forSession(sessionId)
        return seat === undefined ? undefined : { bot: seat.bot, group: seat.group }
      },
      route: sessionId => reviewer.route(sessionId),
      review: input => reviewer.review(input),
      recent: groupId => groups.entries(groupId).filter(entry => entry.kind !== 'review').slice(-12),
      names: id => groups.name(id),
      tell: (sessionId, text) => reviewer.tell(sessionId, text),
      record: (groupId, admin, text) => groups.review(groupId, admin, text),
    })
    tools = botTools({ courier, mind: minds, watcher, groups, searchOwn: (session, query, limit) => searchOwn(history, session, query, limit) })
    const conversations = new HarnessConversations(ctx)
    const running = (sessionId: string) => ctx.agents.get(SessionId(sessionId))?.status === 'running'
    app = {
      service, courier, mind: minds, watcher, groups, approvals, conversations,
      busy: async () => {
        if (courier.jobs().some(job => NOT_STARTED.has(job.state))) return true
        const seats = [
          ...service.list().map(bot => bot.sessionId),
          ...groups.list().flatMap(group => Object.values(group.sessions)),
        ].filter((id): id is string => id !== undefined)
        for (const session of seats) {
          if (!running(session)) continue
          // A turn blocked on the user's answer will not move without the user.
          if (!(await conversations.waitingOnUser(session).catch(() => false))) return true
        }
        return false
      },
    }
    // Bot conversations that were already live before this plugin loaded.
    for (const agent of ctx.agents.list()) attachments.attach(agent)
    // Keep every bot's directory registered as a Workspace (a user may have
    // removed it, or the bot predates registration).
    for (const bot of service.list()) {
      sessions.register(bot).catch(error => console.warn(`futurebot: cannot register ${bot.name}'s workspace: ${String(error)}`))
    }
    watcher.start()
    courier.recover().catch(error => console.error('futurebot: recovery failed', error))
    return app
  })
  ready.catch(error => console.error('futurebot: storage unavailable', error))

  ctx.effect(() => () => {
    attachments.dispose()
    app?.watcher?.dispose()
  }, 'futurebot: per-agent registrations and watches')

  ctx.on('agent/created', async ({ agent }) => {
    await ready.catch(() => undefined)
    attachments.attach(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => { attachments.forget(String(agent.id)) })

  // Bot conversations answer approval requests first, before the Harness asks the user.
  ctx.on('approval/request', (request, next) => {
    const policy = app?.approvals
    if (policy === undefined) return next()
    return policy.decide({ sessionId: String(request.agent.id), toolName: request.toolName, ...(request.reason ? { reason: request.reason } : {}) }, next)
  }, { prepend: true })

  // Turn boundaries drive replies between bots, group conversation and digest refreshes.
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (app === undefined || botFor(sessionId) === undefined) return
    const { courier, groups } = app
    const run = (work: Promise<void> | undefined) => { work?.catch(error => console.error('futurebot: turn handling', error)) }
    if (event.type === 'user/message') {
      const source = (event.data as { source?: unknown }).source
      run(courier?.userMessage(sessionId, source))
      groups?.turnInput(sessionId, source)
    } else if (event.type === 'assistant/message') {
      const data = event.data as { message: { content?: unknown }; interrupted?: true }
      if (data.interrupted === true) return
      const text = textOf(data.message.content)
      run(courier?.assistantText(sessionId, text))
      groups?.turnOutput(sessionId, text, usesTools(data.message.content))
    } else if (event.type === 'turn/end') {
      digests.turnEnded(sessionId)
      const kind = (event.data as { reason?: { kind?: string } }).reason?.kind
      run(courier?.turnEnded(sessionId, ENDINGS.has(kind as TurnEnding) ? kind as TurnEnding : 'other'))
      run(groups?.turnEnded(sessionId, kind === 'completed' || kind === 'max-tokens'))
    }
  })

  ctx.inject(['webServer', 'connection'], sub => {
    const handler = createHandler({
      app: () => ready,
      reject: request => {
        const admission = sub.connection.admit(request)
        return 'rejection' in admission ? admission.rejection : undefined
      },
    })
    sub.effect(() => sub.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'futurebot: HTTP API')
  })
}
