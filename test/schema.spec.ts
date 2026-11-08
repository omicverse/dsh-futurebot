import { describe, expect, it } from 'vitest'
import { DOMAIN_NAME, JOBS_DOMAIN_NAME, botSchema, jobSchema } from '../src/host/schema.ts'

const row = {
  id: 'bot_1', name: 'Lin', instructions: '', permission: 'auto', workspace: '/w/lin', sessionId: 's1',
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:01.000Z', rev: 1,
}

describe('stored bot rows', () => {
  it('accept what the service writes', () => {
    expect(botSchema.parse(row)).toEqual(row)
    expect(botSchema.parse({ ...row, basePreset: 'omicos', isMain: true, model: { provider: 'deepseek', model: 'deepseek-chat' } })).toMatchObject({ basePreset: 'omicos', isMain: true })
  })

  it('reject unknown fields, bad modes and bad stamps', () => {
    expect(botSchema.safeParse({ ...row, extra: 1 }).success).toBe(false)
    expect(botSchema.safeParse({ ...row, permission: 'root' }).success).toBe(false)
    expect(botSchema.safeParse({ ...row, createdAt: 'yesterday' }).success).toBe(false)
    expect(botSchema.safeParse({ ...row, rev: 0 }).success).toBe(false)
  })
})

describe('storage domain name', () => {
  it('fits the Harness unit-name rule', () => {
    expect(DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(JOBS_DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

describe('stored job rows', () => {
  const job = { id: 'job1', from: 'a', to: 'b', text: 'x', expectReply: true, root: 'job1', depth: 1, originSession: 's-a', targetSession: 's-b', state: 'delivered', messageId: 'm1', createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z' }
  it('accept what the courier writes and refuse unknown states', () => {
    expect(jobSchema.parse(job)).toEqual(job)
    expect(jobSchema.parse({ ...job, state: 'returned', reply: 'y', replyMessageId: 'm2', replyEntered: true, parent: 'job0', resumed: true })).toMatchObject({ state: 'returned' })
    expect(jobSchema.safeParse({ ...job, state: 'lost' }).success).toBe(false)
  })
})

