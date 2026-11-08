// Condition 1 — continuing earlier work.
//
// Perspective: a mature Bot's state is not only stored but resumable; the work
// it started and the relationships it holds survive the end of a task, a
// closed session, or a pause and resume. A persistent name alone does not pass.
//
// Test: give a bot a two-step task, let it finish step one, restart the
// Harness, then say only "continue". It should do step two from where it was,
// and know who asked and what step one produced.

import { join } from 'node:path'
import { args, connect, includesAny, read, restart, run, tag } from './lib.mjs'

const opts = args()
const client = await connect(opts.url)
const t = run('c1-continuing')
const bot = await client.createBot({
  name: `C1 分析员 ${tag()}`,
  instructions: '你是数据分析员。用中文回答。',
  permission: 'full',
})
t.step('created bot', { bot })

const first = await client.ask(bot, '这件事分两步，请按顺序来：第一步，在你的工作区写一个 Python 脚本，算出 1 到 50000 之间有多少个质数，把这个数字写进 step1.txt。第二步要等我说「继续」再做：把这个数字写成一句完整的中文句子，存进 step2.txt。现在只做第一步。')
t.step('step one requested', { answer: first.answer })
const step1 = (await read(join(bot.workspace, 'step1.txt')))?.trim()
t.check('step one produced step1.txt', step1 !== undefined, step1)
t.check('step two waited for "continue"', (await read(join(bot.workspace, 'step2.txt'))) === undefined)

await restart(client, opts.restart)
t.step('restarted the Harness')

const second = await client.ask(bot, '继续')
t.step('said only "continue"', { answer: second.answer })
const step2 = await read(join(bot.workspace, 'step2.txt'))
t.check('step two produced step2.txt after the restart', step2 !== undefined, step2)
t.check('step two carries step one\'s number', step1 !== undefined && step2 !== undefined && step2.includes(step1.replace(/\D/g, '')), `${step1} → ${step2}`)

const recall = await client.ask(bot, '这件质数的事最初是谁提出的？一共几步、你现在做到哪了？')
t.step('asked who and where', { answer: recall.answer })
t.check('it knows both steps are done', includesAny(recall.answer, ['两步都', '两步已', '第二步也', '都完成', '全部完成', '都已完成', 'both']), recall.answer)
t.check('a person confirms it names who asked and what each step produced (see record)', 'review', recall.answer)

if (!opts.keep) await client.removeBot(bot.id)
await t.finish()
