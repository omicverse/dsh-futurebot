// Condition 4 — long-term collaboration.
//
// Perspective: collaboration is not message exchange; requests and refusals
// change what each side expects, and feedback and corrections shape later
// work. The test follows one collaborator across several tasks, then changes
// that collaborator's information, needs or availability, and checks whether
// the Bot adjusts in turn.
//
// Test: the user works with an analyst bot over several small tasks, then
// changes their needs (English only, with a line of code) and their
// availability (from now on too busy to read results: send them to the
// writer bot and just confirm). Later tasks should follow both changes
// without being reminded.

import { args, connect, includesAny, run, sleep, tag } from './lib.mjs'

const opts = args()
const client = await connect(opts.url)
const t = run('c4-collaboration')
const suffix = tag()
const analyst = await client.createBot({ name: `C4 分析员 ${suffix}`, instructions: '你是用户的数据分析员。', permission: 'full' })
const writer = await client.createBot({ name: `C4 写手 ${suffix}`, instructions: '你负责把分析结论整理成周报条目，一条一句。', permission: 'full' })

for (const task of ['1 到 20 的平方和是多少？', '1 到 15 的和是多少？']) {
  const answer = await client.ask(analyst, task)
  t.step(`task: ${task}`, { answer: answer.answer })
}

const needs = await client.ask(analyst, '跟你说一下：从现在起我只读英文，而且每个结果后面都附一行能算出它的 Python 代码。')
t.step('the user changed their needs', { answer: needs.answer })
const away = await client.ask(analyst, `还有，从现在起我顾不上看具体结果了：你算出的结论都直接发给 ${writer.name}，让它整理成周报条目；回我一句 Forwarded 就行。`)
t.step('the user changed their availability', { answer: away.answer })

await sleep(2000)
const since = new Date().toISOString()
const later = await client.ask(analyst, '1 到 30 的立方和是多少？')
t.step('a later task, no reminder', { answer: later.answer })
await client.settled(600_000)

const english = later.answer !== undefined && !/[一-鿿]/.test(later.answer.replace(new RegExp(writer.name, 'g'), ''))
t.check('it answers in English without being reminded', english, later.answer)
const jobs = (await client.jobs()).filter(job => job.createdAt > since)
const toWriter = jobs.filter(job => job.from === analyst.id && job.to === writer.id)
t.check(`it sends the later result to ${writer.name} without being reminded`, toWriter.some(job => job.text.includes('216225') || job.text.includes('216,225')), toWriter.map(j => j.text).join(' | '))
// The result now goes to the writer, so the line of Python belongs wherever the result went.
const delivered = [later.answer ?? '', ...toWriter.map(job => job.text)].join('\n')
t.check('the result carries a line of Python, wherever it was delivered', includesAny(delivered, ['sum(', 'range(', 'print(', '```python']), delivered)
const memory = await client.memory(analyst)
const aboutUser = memory.filter(entry => entry.about === 'user')
t.check('it keeps the changes as notes about the user', aboutUser.some(e => includesAny(e.text, ['英文', 'english', 'python', '代码'])) && aboutUser.some(e => includesAny(e.text, [writer.name, '写手', 'writer', 'forward', '转'])), aboutUser.map(e => e.text).join(' | '))
t.check('a person judges the collaboration over the whole record', 'review')

if (!opts.keep) for (const bot of [analyst, writer]) await client.removeBot(bot.id)
await t.finish()
