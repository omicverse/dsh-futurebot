// Condition 2 — learning from experience.
//
// Perspective: given the same base model and new tasks, do versions that keep,
// clear, or replace the relevant experience behave differently, and do those
// differences come from the experience itself rather than from recounting it?
//
// Test: a teacher bot is corrected once by the user. Its memory is then copied
// into three fresh bots with identical instructions and no conversation
// history: one keeps the experience, one has it cleared, one has it replaced
// by the opposite lesson. The same new task goes to each. Only memory
// differs, so a difference in behaviour is the experience's doing.
//
// Honest limit: in this implementation experience reaches the model as text
// it wrote into its own memory. The test shows that kept experience changes
// later judgment; it cannot show anything beyond that.

import { args, connect, includesAny, run, tag } from './lib.mjs'

const opts = args()
const client = await connect(opts.url)
const t = run('c2-learning')
const suffix = tag()
const instructions = '你是数据助理，帮用户看一组数。用中文回答，简短。'

const teacher = await client.createBot({ name: `C2 老师 ${suffix}`, instructions, permission: 'full' })
const first = await client.ask(teacher, '这组数的平均水平是多少：3, 5, 7, 9, 200')
t.step('first task', { answer: first.answer })
const corrected = await client.ask(teacher, '不对。这类数据常有极端值，以后我问「平均水平」「集中趋势」之类的，一律先给中位数，再说明为什么不用均值。请记住这条，以后都这样。')
t.step('user corrected it', { answer: corrected.answer })
const learned = await client.memory(teacher)
t.step('teacher memory', { memory: learned })
const lesson = learned.filter(entry => includesAny(entry.text, ['中位数', 'median']))
t.check('the correction is in its own memory', lesson.length > 0, lesson.map(e => `${e.kind}${e.about ? `/${e.about}` : ''}: ${e.text}`).join(' | '))
t.check('it is kept as a correction or about the user', lesson.some(e => e.kind === 'correction' || e.about === 'user'))

const opposite = [{ id: 'm_swap', kind: 'correction', about: 'user', at: new Date().toISOString(), text: '用户明确要求：问「平均水平」「集中趋势」时只给算术平均数，不要给中位数，也不要解释。' }]
const portable = learned.map(({ bot: _bot, about, ...entry }) => ({ ...entry, ...(about === 'user' ? { about } : {}) }))
const keep = await client.createBot({ name: `C2 保留 ${suffix}`, instructions, permission: 'full' })
const clear = await client.createBot({ name: `C2 清空 ${suffix}`, instructions, permission: 'full' })
const swap = await client.createBot({ name: `C2 替换 ${suffix}`, instructions, permission: 'full' })
await client.setMemory(keep, portable)
await client.setMemory(clear, [])
await client.setMemory(swap, opposite)
t.step('three fresh bots, memory kept / cleared / replaced', { keep: keep.id, clear: clear.id, swap: swap.id })

const task = '这组数的集中趋势是多少：2, 4, 6, 8, 400'
const answers = {}
for (const [label, bot] of [['keep', keep], ['clear', clear], ['swap', swap]]) {
  answers[label] = (await client.ask(bot, task)).answer
  t.step(`new task → ${label}`, { answer: answers[label] })
}
const leadsWithMedian = text => {
  const median = text?.search(/中位数|median/i) ?? -1
  const mean = text?.search(/均值|平均数|平均值|mean/i) ?? -1
  return median >= 0 && (mean < 0 || median < mean)
}
t.check('kept experience: leads with the median (6)', leadsWithMedian(answers.keep) && answers.keep.includes('6'), answers.keep)
t.check('replaced experience: gives the mean (84) without the median', answers.swap?.includes('84') && !/中位数|median/i.test(answers.swap), answers.swap)
t.check('kept and replaced behave differently', leadsWithMedian(answers.keep) !== leadsWithMedian(answers.swap))
t.check('cleared experience: a person judges what it did by default (see record)', 'review', answers.clear)

if (!opts.keep) for (const bot of [teacher, keep, clear, swap]) await client.removeBot(bot.id)
await t.finish()
