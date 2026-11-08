import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../src/shared/types.ts'
import { ApprovalPolicy, parseVerdict, reviewPrompt, type ApprovalPorts, type Outcome, type ReviewVerdict } from '../src/host/approvals.ts'
import type { Group } from '../src/host/groups.ts'

const stamp = '2026-11-08T00:00:00.000Z'
const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({ id, name: id, instructions: '', permission: 'auto', workspace: `/w/${id}`, sessionId: `s-${id}`, createdAt: stamp, updatedAt: stamp, rev: 1, approvalScope: 'once_per_chat', ...extra })

const group = (extra: Partial<Group> = {}): Group => ({
  id: 'g1', title: 'Team', members: ['admin', 'lin'], admin: 'admin', notice: '', approvals: 'admin', adminMayApprove: false, userIn: true,
  sessions: { admin: 'g-admin', lin: 'g-lin' }, cursors: {}, paused: false, idleRounds: 0, nextSeq: 1, createdAt: stamp, updatedAt: stamp, rev: 1, ...extra,
})

let bots: Record<string, Bot>
let theGroup: Group
let verdict: ReviewVerdict | Error
let reviews: number
let told: string[]
let recorded: string[]
let userAnswers: Outcome[]
let asked: number
let policy: ApprovalPolicy

function ports(): ApprovalPorts {
  return {
    locate: session => {
      if (session === 's-lin') return { bot: bots.lin! }
      if (session === 's-admin') return { bot: bots.admin! }
      if (session === 'g-lin') return { bot: bots.lin!, group: theGroup }
      if (session === 'g-admin') return { bot: bots.admin!, group: theGroup }
      return undefined
    },
    route: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    review: async () => { reviews += 1; if (verdict instanceof Error) throw verdict; return verdict },
    recent: () => [],
    names: id => id,
    tell: (_s, text) => told.push(text),
    record: async (_g, _a, text) => { recorded.push(text) },
  }
}

const user = async () => { asked += 1; return userAnswers.shift() ?? 'unavailable' }

beforeEach(() => {
  bots = { lin: bot('lin'), admin: bot('admin') }
  theGroup = group()
  verdict = { decision: 'approve', reason: 'routine QC' }
  reviews = 0
  told = []
  recorded = []
  userAnswers = []
  asked = 0
  policy = new ApprovalPolicy(ports(), 200)
})

describe('approval paths', () => {
  it('leaves ordinary conversations to the user', async () => {
    userAnswers = ['allowed-once']
    expect(await policy.decide({ sessionId: 'plain', toolName: 'bash' }, user)).toBe('allowed-once')
    expect(asked).toBe(1)
  })

  it('asks once per conversation for the same kind of operation, when the bot says so', async () => {
    userAnswers = ['allowed-once']
    expect(await policy.decide({ sessionId: 's-lin', toolName: 'bash' }, user)).toBe('allowed-once')
    expect(await policy.decide({ sessionId: 's-lin', toolName: 'bash' }, user)).toBe('allowed-once')
    expect(asked).toBe(1)
    expect(await policy.decide({ sessionId: 's-lin', toolName: 'write' }, user)).toBe('unavailable')
    expect(asked).toBe(2)
  })

  it('asks every time for a bot set to each, or after the user declined', async () => {
    bots.lin = bot('lin', { approvalScope: 'each' })
    userAnswers = ['allowed-once', 'allowed-once']
    await policy.decide({ sessionId: 's-lin', toolName: 'bash' }, user)
    await policy.decide({ sessionId: 's-lin', toolName: 'bash' }, user)
    expect(asked).toBe(2)
    bots.admin = bot('admin')
    userAnswers = ['rejected']
    await policy.decide({ sessionId: 's-admin', toolName: 'bash' }, user)
    userAnswers = ['rejected']
    await policy.decide({ sessionId: 's-admin', toolName: 'bash' }, user)
    expect(asked).toBe(4)
  })

  it('lets the admin deny a member\'s request, telling the member why', async () => {
    verdict = { decision: 'deny', reason: 'QC first; no network access needed' }
    expect(await policy.decide({ sessionId: 'g-lin', toolName: 'bash', reason: 'pip install scanpy' }, user)).toBe('rejected')
    expect(asked).toBe(0)
    expect(told).toEqual(['Your bash request was denied by admin (your reviewer): QC first; no network access needed'])
    expect(recorded).toEqual(["admin denied lin's bash request: QC first; no network access needed"])
  })

  it('passes an approval to the user unless the user let the admin approve', async () => {
    userAnswers = ['allowed-once']
    expect(await policy.decide({ sessionId: 'g-lin', toolName: 'bash' }, user)).toBe('allowed-once')
    expect(asked).toBe(1)
    expect(recorded[0]).toContain('passed to the user')
    theGroup = group({ adminMayApprove: true })
    policy = new ApprovalPolicy(ports(), 200)
    expect(await policy.decide({ sessionId: 'g-lin', toolName: 'write' }, user)).toBe('allowed-once')
    expect(asked).toBe(1)
    expect(recorded.at(-1)).toContain(' approved ')
    // And once allowed, the same kind passes without another review in that conversation.
    expect(await policy.decide({ sessionId: 'g-lin', toolName: 'write' }, user)).toBe('allowed-once')
    expect(reviews).toBe(2)
  })

  it('sends uncertain, failed and slow reviews to the user', async () => {
    verdict = { decision: 'ask_user', reason: 'costs money' }
    await policy.decide({ sessionId: 'g-lin', toolName: 'bash' }, user)
    verdict = new Error('model down')
    await policy.decide({ sessionId: 'g-lin', toolName: 'write' }, user)
    expect(asked).toBe(2)
    expect(recorded[1]).toContain('review unavailable (model down)')
    const slow = new ApprovalPolicy({ ...ports(), review: () => new Promise(() => undefined) }, 20)
    await slow.decide({ sessionId: 'g-lin', toolName: 'edit' }, user)
    expect(asked).toBe(3)
  })

  it('never reviews the admin\'s own requests, nor groups where the user approves', async () => {
    await policy.decide({ sessionId: 'g-admin', toolName: 'bash' }, user)
    theGroup = group({ approvals: 'user' })
    await policy.decide({ sessionId: 'g-lin', toolName: 'bash' }, user)
    expect(reviews).toBe(0)
    expect(asked).toBe(2)
  })
})

describe('the review call', () => {
  it('reads one JSON object even inside prose or a fence', () => {
    expect(parseVerdict('```json\n{"decision":"deny","reason":"no"}\n```')).toEqual({ decision: 'deny', reason: 'no' })
    expect(parseVerdict('Sure: {"decision": "approve"}')).toEqual({ decision: 'approve', reason: '(no reason given)' })
    expect(() => parseVerdict('{"decision":"maybe"}')).toThrow(/unknown decision/)
    expect(() => parseVerdict('no json')).toThrow(/JSON/)
  })

  it('briefs the admin with the group, the requester and the operation', () => {
    const prompt = reviewPrompt({ admin: bot('总管', { instructions: '谨慎' }), requester: bot('林分析'), group: group({ notice: '只用公开数据' }), recent: [{ id: 'e', group: 'g1', seq: 1, from: 'user', kind: 'message', text: '做 QC', mentions: [], at: stamp }], names: id => (id === 'user' ? 'User' : id), toolName: 'bash', reason: 'pip install' })
    expect(prompt.system).toContain('You are 总管, the admin of the group "Team"')
    expect(prompt.system).toContain('谨慎')
    expect(prompt.user).toContain('Group notice: 只用公开数据')
    expect(prompt.user).toContain('[User] 做 QC')
    expect(prompt.user).toContain('Operation: bash — pip install')
  })
})
