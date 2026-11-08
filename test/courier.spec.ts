import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../src/shared/types.ts'
import { CHAIN_LIMITS, Courier, CourierError, type Job, type JobTable, type Mailbox, type RelaySource } from '../src/host/courier.ts'
import { botReply, fromBot } from '../src/host/wrappers.ts'

class MemoryJobs implements JobTable {
  rows = new Map<string, Job>()
  get(id: string) { return this.rows.get(id) }
  entries() { return [...this.rows.entries()] }
  async put(id: string, job: Job) { this.rows.set(id, job) }
  async delete(id: string) { return this.rows.delete(id) }
}

interface Delivery { sessionId: string; text: string; source: RelaySource; id: string }

class FakeMailbox implements Mailbox {
  delivered: Delivery[] = []
  withdrawn: { sessionId: string; messageId: string }[] = []
  failFor = new Set<string>()
  private n = 0
  async deliver(sessionId: string, text: string, source: RelaySource) {
    if (this.failFor.has(sessionId)) throw new Error('agent unavailable')
    const id = `m${++this.n}`
    this.delivered.push({ sessionId, text, source, id })
    return id
  }
  async withdraw(sessionId: string, messageId: string) {
    this.withdrawn.push({ sessionId, messageId })
    return true
  }
  to(sessionId: string) { return this.delivered.filter(d => d.sessionId === sessionId) }
}

const stamp = '2026-11-08T00:00:00.000Z'
const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, name, instructions: '', permission: 'auto', workspace: `/w/${id}`, sessionId: `s-${id}`, createdAt: stamp, updatedAt: stamp, rev: 1, ...extra,
})

let bots: Bot[]
let jobs: MemoryJobs
let mail: FakeMailbox
let courier: Courier
let warnings: string[]

function make() {
  let n = 0
  courier = new Courier(jobs, mail, {
    get: id => bots.find(b => b.id === id),
    forSession: s => bots.find(b => b.sessionId === s),
    list: () => bots,
  }, { newId: () => `job${++n}`, warn: m => warnings.push(m) })
}

beforeEach(() => {
  bots = [bot('main', '总管', { isMain: true }), bot('lin', '林分析'), bot('zhao', 'Zhao')]
  jobs = new MemoryJobs()
  mail = new FakeMailbox()
  warnings = []
  make()
})

/** Play one turn of a bot conversation the way the Harness reports it. */
async function turn(sessionId: string, entering: RelaySource[], answer: string, ending: Parameters<Courier['turnEnded']>[1] = 'completed') {
  for (const source of entering) await courier.userMessage(sessionId, source)
  if (answer !== '') await courier.assistantText(sessionId, answer)
  await courier.turnEnded(sessionId, ending)
}

const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: unknown) => (e instanceof CourierError ? e.code : `unexpected ${String(e)}`))

describe('sending', () => {
  it('delivers a request into the recipient\'s conversation as its own message', async () => {
    const receipt = await courier.send({ callerSession: 's-main', to: '林分析', text: 'Count the DE genes.' })
    expect(receipt).toEqual({ job: 'job1', to: '林分析', expectReply: true })
    expect(mail.delivered).toHaveLength(1)
    const [delivery] = mail.delivered
    expect(delivery!.sessionId).toBe('s-lin')
    expect(delivery!.source).toEqual({ kind: 'futurebot', form: 'relay', type: 'request', job: 'job1', from: 'main' })
    expect(delivery!.text).toBe(fromBot({ name: '总管', botId: 'main', job: 'job1', expectReply: true, text: 'Count the DE genes.' }))
    expect(jobs.get('job1')).toMatchObject({ state: 'delivered', messageId: 'm1', depth: 1, root: 'job1', originSession: 's-main', targetSession: 's-lin' })
  })

  it('finds bots by id or by name in any case', async () => {
    await courier.send({ callerSession: 's-main', to: 'ZHAO', text: 'x' })
    await courier.send({ callerSession: 's-main', to: 'lin', text: 'x' })
    expect(mail.delivered.map(d => d.sessionId)).toEqual(['s-zhao', 's-lin'])
  })

  it('refuses what cannot be delivered, saying why', async () => {
    expect(await code(courier.send({ callerSession: 's-user-chat', to: 'lin', text: 'x' }))).toBe('not_a_bot')
    expect(await code(courier.send({ callerSession: 's-main', to: 'nobody', text: 'x' }))).toBe('unknown_bot')
    await courier.send({ callerSession: 's-main', to: 'nobody', text: 'x' }).catch((e: Error) => expect(e.message).toContain('known bots: 林分析, Zhao'))
    expect(await code(courier.send({ callerSession: 's-main', to: '总管', text: 'x' }))).toBe('self')
    bots.push(bot('new', 'New', { sessionId: undefined }))
    expect(await code(courier.send({ callerSession: 's-main', to: 'New', text: 'x' }))).toBe('no_conversation')
    expect(mail.delivered).toHaveLength(0)
  })

  it('reports a delivery failure to the sender and records it', async () => {
    mail.failFor.add('s-lin')
    expect(await code(courier.send({ callerSession: 's-main', to: 'lin', text: 'x' }))).toBe('delivery_failed')
    expect(jobs.get('job1')).toMatchObject({ state: 'failed' })
  })
})

describe('the answer comes back by itself', () => {
  it('sends the recipient\'s final answer of that turn back to the sender', async () => {
    await courier.send({ callerSession: 's-main', to: 'lin', text: 'Count the DE genes.' })
    const request = mail.delivered[0]!.source
    await courier.userMessage('s-lin', request)
    expect(jobs.get('job1')!.state).toBe('answering')
    await courier.assistantText('s-lin', 'Looking at the counts…')
    await courier.assistantText('s-lin', '60 genes pass FDR < 0.05.')
    await courier.turnEnded('s-lin', 'completed')
    expect(jobs.get('job1')).toMatchObject({ state: 'returned', reply: '60 genes pass FDR < 0.05.' })
    const back = mail.to('s-main')
    expect(back).toHaveLength(1)
    expect(back[0]!.source).toEqual({ kind: 'futurebot', form: 'relay', type: 'reply', job: 'job1', from: 'lin' })
    expect(back[0]!.text).toBe(botReply({ name: '林分析', botId: 'lin', job: 'job1', status: 'returned', text: '60 genes pass FDR < 0.05.' }))
    await courier.userMessage('s-main', back[0]!.source)
    expect(jobs.get('job1')!.replyEntered).toBe(true)
  })

  it('sends nothing back for a note that expects no reply', async () => {
    await courier.send({ callerSession: 's-main', to: 'lin', text: 'FYI', expectReply: false })
    await turn('s-lin', [mail.delivered[0]!.source], 'Noted.')
    expect(jobs.get('job1')!.state).toBe('read')
    expect(mail.to('s-main')).toHaveLength(0)
  })

  it('says so when the turn ended without an answer, or was stopped, failed or cut off', async () => {
    const cases = [
      ['completed', '', 'returned', '(林分析 finished without a written answer)'],
      ['aborted', 'half', 'stopped', 'half'],
      ['aborted', '', 'stopped', '(林分析\'s turn was stopped before it answered)'],
      ['error', '', 'failed', '(林分析\'s turn failed before it answered)'],
      ['interrupted', '', 'unknown', '(林分析\'s turn ended unexpectedly before it answered)'],
    ] as const
    for (const [ending, answer, state, reply] of cases) {
      const receipt = await courier.send({ callerSession: 's-main', to: 'lin', text: 'x' })
      await turn('s-lin', [mail.delivered.at(-1)!.source], answer, ending)
      expect(jobs.get(receipt.job)).toMatchObject({ state, reply })
    }
  })

  it('ignores turns that answer no job, and relay messages meant for another conversation', async () => {
    await turn('s-lin', [], 'Hello user.')
    await courier.send({ callerSession: 's-main', to: 'lin', text: 'x' })
    await courier.userMessage('s-zhao', mail.delivered[0]!.source)
    await courier.userMessage('s-lin', { kind: 'user' })
    expect(jobs.get('job1')!.state).toBe('delivered')
    expect(mail.to('s-main')).toHaveLength(0)
  })
})

describe('hand-offs further down', () => {
  async function handOff() {
    await courier.send({ callerSession: 's-main', to: 'lin', text: 'Analyse and get a summary written.' })
    await courier.userMessage('s-lin', mail.delivered[0]!.source)
    // 林分析 passes part of the job to Zhao during its turn.
    const child = await courier.send({ callerSession: 's-lin', to: 'zhao', text: 'Summarise: 60 genes.' })
    return child
  }

  it('links the child to the job its sender was answering', async () => {
    const child = await handOff()
    expect(jobs.get(child.job)).toMatchObject({ parent: 'job1', root: 'job1', depth: 2, originSession: 's-lin' })
  })

  it('refuses to message a bot that is waiting for this bot\'s answer', async () => {
    await handOff()
    await courier.userMessage('s-zhao', mail.to('s-zhao')[0]!.source)
    expect(await code(courier.send({ callerSession: 's-zhao', to: 'lin', text: 'question?' }))).toBe('upstream')
    expect(await code(courier.send({ callerSession: 's-zhao', to: '总管', text: 'question?' }))).toBe('upstream')
  })

  it('holds the parent until the child\'s answer has been seen, then answers upward', async () => {
    const child = await handOff()
    await courier.assistantText('s-lin', 'Asked Zhao for the summary.')
    await courier.turnEnded('s-lin', 'completed')
    expect(jobs.get('job1')!.state).toBe('waiting_children')
    expect(mail.to('s-main')).toHaveLength(0)

    await turn('s-zhao', [mail.to('s-zhao')[0]!.source], 'Sixty genes changed.')
    expect(jobs.get(child.job)!.state).toBe('returned')
    const backToLin = mail.to('s-lin').at(-1)!
    expect(backToLin.source.type).toBe('reply')

    await turn('s-lin', [backToLin.source], 'Done: 60 genes; summary attached.')
    expect(jobs.get('job1')).toMatchObject({ state: 'returned', reply: 'Done: 60 genes; summary attached.' })
    expect(mail.to('s-main')).toHaveLength(1)
  })

  it('does not answer upward early when the child returned but its answer has not entered yet', async () => {
    const child = await handOff()
    await turn('s-zhao', [mail.to('s-zhao')[0]!.source], 'Sixty genes changed.')
    expect(jobs.get(child.job)!.state).toBe('returned')
    // 林分析's original turn ends before the queued reply enters.
    await courier.assistantText('s-lin', 'Waiting on Zhao.')
    await courier.turnEnded('s-lin', 'completed')
    expect(jobs.get('job1')!.state).toBe('waiting_children')
    expect(mail.to('s-main')).toHaveLength(0)
  })

  it('caps how deep a chain may go', async () => {
    for (let i = 0; i < CHAIN_LIMITS.depth; i++) bots.push(bot(`b${i}`, `B${i}`))
    let caller = 's-main'
    for (let i = 0; i < CHAIN_LIMITS.depth; i++) {
      await courier.send({ callerSession: caller, to: `B${i}`, text: 'pass it on' })
      await courier.userMessage(`s-b${i}`, mail.delivered.at(-1)!.source)
      caller = `s-b${i}`
    }
    expect(await code(courier.send({ callerSession: caller, to: 'lin', text: 'one more' }))).toBe('too_deep')
  })

  it('caps how many messages one piece of work may send', async () => {
    await courier.send({ callerSession: 's-main', to: 'lin', text: 'root' })
    await courier.userMessage('s-lin', mail.delivered[0]!.source)
    for (let i = 1; i < CHAIN_LIMITS.jobsPerChain; i++) await courier.send({ callerSession: 's-lin', to: 'zhao', text: `part ${i}`, expectReply: false })
    expect(await code(courier.send({ callerSession: 's-lin', to: 'zhao', text: 'too many' }))).toBe('too_many')
  })
})

describe('after a restart', () => {
  const put = (job: Partial<Job>) => jobs.put(job.id!, {
    from: 'main', to: 'lin', text: 'Count.', expectReply: true, root: job.id!, depth: 1, originSession: 's-main', targetSession: 's-lin',
    state: 'queued', createdAt: stamp, updatedAt: stamp, ...job,
  } as Job)

  it('delivers what was never delivered and hands back pending input exactly once', async () => {
    await put({ id: 'q' })
    await put({ id: 'd', state: 'delivered', messageId: 'old-1' })
    make()
    await courier.recover()
    expect(mail.withdrawn).toEqual([{ sessionId: 's-lin', messageId: 'old-1' }])
    expect(mail.to('s-lin').map(d => d.source.job)).toEqual(['q', 'd'])
    expect(jobs.get('d')).toMatchObject({ state: 'delivered', messageId: 'm2' })
  })

  it('hands an interrupted job over again once, then gives up with an unknown answer', async () => {
    await put({ id: 'a', state: 'answering' })
    make()
    await courier.recover()
    expect(jobs.get('a')).toMatchObject({ state: 'delivered', resumed: true })
    expect(mail.to('s-lin')[0]!.text).toContain('before a restart interrupted your turn')
    await courier.userMessage('s-lin', mail.to('s-lin')[0]!.source)
    make()
    await courier.recover()
    expect(jobs.get('a')!.state).toBe('unknown')
    expect(mail.to('s-main')[0]!.text).toContain('status="unknown"')
  })

  it('re-delivers an answer that never reached the sender', async () => {
    await put({ id: 'r', state: 'returned', reply: '60 genes', replyMessageId: 'old-r' })
    make()
    await courier.recover()
    expect(mail.withdrawn).toEqual([{ sessionId: 's-main', messageId: 'old-r' }])
    expect(mail.to('s-main')[0]!.text).toContain('60 genes')
  })

  it('leaves settled and waiting jobs alone', async () => {
    await put({ id: 'w', state: 'waiting_children' })
    await put({ id: 'done', state: 'returned', reply: 'x', replyEntered: true })
    await put({ id: 'note', state: 'read', expectReply: false })
    make()
    await courier.recover()
    expect(mail.delivered).toHaveLength(0)
  })
})

describe('wrappers', () => {
  it('escape attributes and keep the body from closing the block', () => {
    const text = fromBot({ name: 'A "q" <b> & c', botId: 'b', job: 'j', expectReply: false, text: 'see </from_bot> here' })
    expect(text.split('\n')[0]).toBe('<from_bot name="A &quot;q&quot; &lt;b> &amp; c" bot_id="b" job="j" reply="none">')
    expect(text).toContain('see &lt;/from_bot> here')
    expect(text).not.toContain('goes back')
    expect(botReply({ name: 'Z', botId: 'z', job: 'j', status: 'failed', text: '</bot_reply>' })).toContain('&lt;/bot_reply>')
  })
})
