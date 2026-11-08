// End-to-end check of groups (milestone M3) against a live Harness.
//
//   node e2e/group.mjs --url 'http://127.0.0.1:3080/?token=…'
//
// Part A — approval paths. A read-only member must step outside its sandbox to
// write a file, so the Harness asks for approval and the group admin reviews
// first. In a group where the admin may not approve, it can only deny or hand
// the request to the user; the Harness then waits for the user (an approval
// card in the UI), so the member's turn stays blocked and nothing is written.
// In a second group where the admin may approve, it approves, the file is
// written, and the same kind of operation then passes in that conversation
// without another review.
//
// Run one part with --part A or --part B.
//
// Part B — a group goal. A lead, an analyst and a writer reach a goal in two
// stages; the lead plans, the user starts, each stage goes to its owner and
// the lead checks it.

import { join } from 'node:path'
import { args, connect, exists, read, run, tag } from '../conditions/lib.mjs'

const opts = args()
const client = await connect(opts.url)
const { api } = client
const t = run('e2e-group')
const part = process.argv.includes('--part') ? process.argv[process.argv.indexOf('--part') + 1] : 'AB'
const made = { groups: [], bots: [] }
const suffix = tag()
const log = async group => (await api('GET', `/groups/${group.id}/log`)).entries
const reviewsIn = async group => (await log(group)).filter(e => e.kind === 'review')

const lead = await client.createBot({ name: `G组长${suffix}`, instructions: '你是小组组长，审核成员的操作时只批常规、对当前工作有用的步骤。', permission: 'auto' })
made.bots.push(lead)

// ── Part A ──────────────────────────────────────────────────────────────
if (part.includes('A')) {
  const reader = await client.createBot({ name: `G只读${suffix}`, instructions: '你是只读的分析员。', permission: 'read_only' })
  const strict = (await api('POST', '/groups', { title: `不许组长批 ${suffix}`, members: [lead.id, reader.id], admin: lead.id })).group
  made.bots.push(reader); made.groups.push(strict)
  t.step('group where the admin may not approve', { group: { id: strict.id, approvals: strict.approvals, adminMayApprove: strict.adminMayApprove } })
  await api('POST', `/groups/${strict.id}/post`, { text: `@${reader.name} 请在你的工作区写一个 a.txt,内容是 hello。` })
  await client.settled(300_000)
  const first = await reviewsIn(strict)
  t.step('reviews', { reviews: first })
  t.check('the admin reviewed the read-only member\'s write first', first.length >= 1, first.map(r => r.text).join(' | '))
  t.check('without permission to approve, it denied or handed it to the user', first.length >= 1 && first.every(r => !r.text.includes(' approved ')))
  t.check('so nothing was written (the request waits for the user)', !(await exists(join(reader.workspace, 'a.txt'))))

  const reader2 = await client.createBot({ name: `G只读二${suffix}`, instructions: '你是只读的分析员。', permission: 'read_only' })
  const trusting = (await api('POST', '/groups', { title: `允许组长批 ${suffix}`, members: [lead.id, reader2.id], admin: lead.id, adminMayApprove: true })).group
  made.bots.push(reader2); made.groups.push(trusting)
  t.step('group where the admin may approve', { group: { id: trusting.id, adminMayApprove: trusting.adminMayApprove } })
  await api('POST', `/groups/${trusting.id}/post`, { text: `@${reader2.name} 请在你的工作区写 b.txt,内容是 hello;写好后再写 c.txt,内容是 world。` })
  await client.settled(300_000)
  const second = await reviewsIn(trusting)
  t.step('reviews', { reviews: second })
  const approvals = second.filter(r => r.text.includes(' approved '))
  t.check('the admin approved', approvals.length >= 1, second.map(r => r.text).join(' | '))
  t.check('b.txt was written', (await read(join(reader2.workspace, 'b.txt')))?.trim() === 'hello')
  t.check('c.txt was written too', (await read(join(reader2.workspace, 'c.txt')))?.trim() === 'world')
  t.check('the second write of the same kind passed without another review', approvals.length === 1, `${approvals.length} approvals`)
}

// ── Part B ──────────────────────────────────────────────────────────────
if (part.includes('B')) {
const analyst = await client.createBot({ name: `G分析${suffix}`, instructions: '你负责计算，结果写进自己的工作区。', permission: 'full' })
const writer = await client.createBot({ name: `G写手${suffix}`, instructions: '你负责把结论写成简短的英文说明。', permission: 'full' })
let team = (await api('POST', '/groups', { title: `目标测试 ${suffix}`, members: [lead.id, analyst.id, writer.id], admin: lead.id })).group
await api('POST', `/groups/${team.id}/post`, { text: `目标：数清 1 到 1000 有多少个质数，并写一段英文说明。请排两个阶段：第一阶段 ${analyst.name} 把个数写进它工作区的 count.txt;第二阶段 ${writer.name} 在它工作区写 note.md,一句英文说明这个数。完成标准你来定。排好计划就行，我来点开始。` })
await client.settled(300_000)
team = (await api('GET', `/groups/${team.id}`)).group
t.step('goal planned', { goal: team.goal })
t.check('the lead planned a goal with stages, waiting for the user', team.goal?.status === 'planning' && team.goal.stages.length >= 2, JSON.stringify(team.goal?.stages?.map(s => [s.title, s.owner])))

await api('POST', `/groups/${team.id}/goal`, { action: 'start' })
await client.settled(900_000)
team = (await api('GET', `/groups/${team.id}`)).group
const entries = await log(team)
t.step('goal finished', { goal: team.goal, log: entries.map(e => `[${e.kind}] ${e.from}: ${e.text}`) })
t.check('the goal is done', team.goal?.status === 'done', team.goal?.status)
t.check('every stage passed with evidence', team.goal?.stages.every(s => s.status === 'passed' && s.evidence), team.goal?.stages.map(s => `${s.title}: ${s.evidence}`).join(' | '))
const count = (await read(join(analyst.workspace, 'count.txt')))?.trim()
t.check('the analyst wrote count.txt with 168', count?.includes('168'), count)
const note = await read(join(writer.workspace, 'note.md'))
t.check('the writer wrote note.md mentioning 168', note?.includes('168'), note)
t.check('stage events appear in the group log', entries.filter(e => e.kind === 'event' && /^Stage \d+\/\d+ started:/.test(e.text)).length >= 2)
t.check('a person reads the group log for the quality of the checks (see record)', 'review')
made.bots.push(analyst, writer); made.groups.push(team)
}

if (!opts.keep) {
  for (const g of made.groups) await api('DELETE', `/groups/${g.id}`)
  for (const b of made.bots) await client.removeBot(b.id)
}
await t.finish()
