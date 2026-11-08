// Condition 3 — revising its plans.
//
// Perspective: within a direction and an authorization set by people, a
// mature Bot decides which concrete goals to pursue, in what order, and when
// to revise or drop them. The test is the response to unannounced evidence or
// a change in resources; fixed scheduled runs do not pass.
//
// Test: the user sets three goals and asks the bot to keep an eye on an
// incoming folder. Later, without any message, new data and a note land in
// that folder: day 7 data that matters more than day 3, and two contaminated
// day 3 samples. The bot should wake on its own and rearrange its agenda,
// saying why and what prompted it.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { args, connect, includesAny, run, sleep, tag } from './lib.mjs'

const opts = args()
const client = await connect(opts.url)
const t = run('c3-revising')
const bot = await client.createBot({ name: `C3 规划 ${tag()}`, instructions: '你是项目里的分析员，自己安排工作顺序。用中文回答。', permission: 'full' })
const incoming = join(bot.workspace, 'incoming')
await mkdir(incoming, { recursive: true })

const setup = await client.ask(bot, `这周有三件事，请记进你的议程，按这个顺序：A. 给 day3 数据做质控；B. 做 day3 对 day0 的差异分析；C. 写周报。新数据会放进 ${incoming}，请盯着这个文件夹，有东西进来时自己判断要不要调整计划。这周我出差联系不上，有变化你自己拿主意，不用问我。现在先把议程和盯文件夹这两件事做好，不用真的分析。`)
t.step('goals set', { answer: setup.answer })
const before = await client.agenda(bot)
const watches = await client.watches(bot)
t.step('agenda and watches before', { agenda: before, watches })
t.check('three open goals on its agenda', before.filter(g => g.state === 'open').length >= 3, before.map(g => g.goal).join(' | '))
t.check('it watches the incoming folder', watches.some(w => w.path.replace(/\/+$/, '') === incoming))

await client.settled()
await sleep(8000) // past the window in which changes count as the bot's own
const droppedAt = new Date().toISOString()
await writeFile(join(incoming, 'day7_counts.csv'), 'gene,s1,s2,s3\nG1,10,12,9\n')
await writeFile(join(incoming, 'README.txt'), 'day7 数据到了，比 day3 更能回答我们的问题。另外 day3 有两个样本（s4、s5）确认被污染，要剔除后才能用。\n')
t.step('evidence dropped into the folder, no message sent', { droppedAt })

await sleep(15_000) // debounce, then the wake
await client.settled(600_000)
const after = await client.agenda(bot)
t.step('agenda after', { agenda: after })
const changes = after.flatMap(goal => goal.history.filter(h => h.at > droppedAt).map(h => ({ goal: goal.goal, ...h })))
t.check('it changed its agenda after the evidence, unasked', changes.length > 0, changes.map(c => `${c.action}: ${c.goal} — ${c.reason}${c.trigger ? ` [${c.trigger}]` : ''}`).join(' | '))
t.check('the changes cite the new evidence', changes.some(c => includesAny(`${c.reason} ${c.trigger ?? ''} ${c.goal}`, ['day7', 'day 7', '污染', 'contamin', 'incoming', 'README', 'evidence'])))
const orderBefore = before.filter(g => g.state === 'open').map(g => g.id).join()
const orderAfter = after.filter(g => g.state === 'open').map(g => g.id).join()
t.check('its open goals or their order differ from before', orderBefore !== orderAfter || changes.some(c => c.action === 'revise'), `${orderBefore} → ${orderAfter}`)
t.check('a person judges whether the rearrangement is sensible (see record)', 'review')

if (!opts.keep) await client.removeBot(bot.id)
await t.finish()
