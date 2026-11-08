import { describe, expect, it } from 'vitest'
import { RELAY_KIND, parseRelay, relayDefinition } from '../src/client/relay.ts'
import { botReply, fromBot } from '../src/host/wrappers.ts'

describe('reading bot messages back', () => {
  it('reads requests and notes the Host wrote', () => {
    const text = fromBot({ name: '总管 "A"', botId: 'main', job: 'j1', expectReply: true, text: 'Count the genes.\nUse </from_bot> carefully.' })
    expect(parseRelay(text, { type: 'request' })).toEqual({ kind: 'request', name: '总管 "A"', expectReply: true, body: 'Count the genes.\nUse </from_bot> carefully.' })
    const note = fromBot({ name: 'Zhao', botId: 'z', job: 'j2', expectReply: false, text: 'FYI' })
    expect(parseRelay(note, { type: 'request' })).toMatchObject({ kind: 'request', expectReply: false, body: 'FYI' })
  })

  it('reads replies with their status', () => {
    expect(parseRelay(botReply({ name: '林分析', botId: 'lin', job: 'j1', status: 'failed', text: '(stopped)' }), { type: 'reply' }))
      .toEqual({ kind: 'reply', name: '林分析', status: 'failed', body: '(stopped)' })
  })

  it('reads group updates, evidence and notices', () => {
    const group = '<group_update group="g1" title="单细胞小组" reason="goal_stage">\n[Group goal] Objective: …\n[User] start\n</group_update>'
    expect(parseRelay(group, { type: 'group' })).toEqual({ kind: 'group', title: '单细胞小组', reason: 'goal_stage', body: '[Group goal] Objective: …\n[User] start' })
    const evidence = '<evidence watch="w1" folder="/w/in">\nFiles changed while you were idle:\n- added: day7.csv\n</evidence>\n(Nobody asked you anything.)'
    expect(parseRelay(evidence, { type: 'evidence' })).toMatchObject({ kind: 'evidence', folder: '/w/in', body: 'Files changed while you were idle:\n- added: day7.csv' })
    expect(parseRelay('Your bash request was denied.', { type: 'notice' })).toEqual({ kind: 'notice', body: 'Your bash request was denied.' })
  })
})

describe('the conversation node', () => {
  const event = (source: object, text: string) => ({ type: 'user/message', seq: 42, data: { id: 'msg-9', content: [{ type: 'text', text }], source } })

  it('claims only messages the plugin wrote', () => {
    expect(relayDefinition.match(event({ kind: 'futurebot', type: 'reply' }, 'x'))).toEqual({ id: 'msg-9', role: 'start', exclusive: true })
    expect(relayDefinition.match(event({ kind: 'user' }, 'x'))).toBeNull()
    expect(relayDefinition.match({ type: 'assistant/message', seq: 1, data: {} })).toBeNull()
  })

  it('builds one input row at the message\'s position', () => {
    const start = relayDefinition.start(undefined, { event: event({ kind: 'futurebot', type: 'reply' }, botReply({ name: 'Zhao', botId: 'z', job: 'j', status: 'returned', text: 'done' })) })
    expect(start).toMatchObject({ seq: 42, kind: 'reply', name: 'Zhao', body: 'done' })
    const node = relayDefinition.buildViewNode({ key: 'k', id: 'msg-9', state: start, start: { location: { kind: 'step' } }, matches: [] })
    expect(node).toMatchObject({ key: 'k', kind: RELAY_KIND, target: 'chat', anchorSeq: 42, groupTree: 'input', visibility: 'visible', location: { kind: 'step' } })
    expect(relayDefinition.buildViewNode({ key: 'k', id: 'x', matches: [] })).toBeNull()
  })
})
