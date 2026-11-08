// Shared helpers for the condition tests. Plain Node (>= 22), no dependencies.
//
// Every test talks to a running Harness with dsh-futurebot installed, through the
// plugin's HTTP API, as the signed-in user. Pass the URL the Harness printed
// at start (it carries the one-time launch token):
//
//   node conditions/c1-continuing.mjs --url 'http://127.0.0.1:3080/?token=…'
//
// Results go to conditions/results/<test>-<time>.json: every message, every
// answer, the bots' memory, agenda and jobs, and each check's verdict.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function args() {
  const out = { keep: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--restart') out.restart = argv[++i]
    else if (argv[i] === '--keep') out.keep = true
  }
  out.url ??= process.env.DSH_URL
  out.restart ??= process.env.DSH_RESTART
  if (!out.url) throw new Error('pass --url with the address the Harness printed (it includes ?token=…), or set DSH_URL')
  return out
}

/** Sign in with the launch token and return an API client bound to the cookie. */
export async function connect(url) {
  const start = new URL(url)
  const origin = start.origin
  let cookie = ''
  if (start.searchParams.has('token')) {
    const res = await fetch(url, { redirect: 'manual' })
    const set = res.headers.getSetCookie?.() ?? []
    cookie = set.map(line => line.split(';')[0]).join('; ')
    if (cookie === '') throw new Error(`sign-in did not return a cookie (HTTP ${res.status}); is the token current?`)
  }
  async function api(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${origin}/futurebot/api${path}`, {
          method,
          headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${payload.error ?? ''} ${payload.message ?? ''}`), { status: res.status })
        return payload
      } catch (error) {
        // While the Harness restarts the socket refuses; retry for a while.
        if (error.status !== undefined || attempt >= 60) throw error
        await sleep(2000)
      }
    }
  }
  return {
    origin,
    api,
    createBot: spec => api('POST', '/bots', spec).then(r => r.bot),
    removeBot: id => api('DELETE', `/bots/${id}`),
    bots: () => api('GET', '/bots').then(r => r.bots),
    /** Say something to a bot as the user and wait for its answer. */
    async ask(bot, text, timeoutMs = 300_000) {
      const { after } = await api('POST', `/bots/${bot.id}/messages`, { text })
      return { text, after, ...(await this.wait(bot, after, timeoutMs)) }
    },
    /**
     * Wait for the bot's answer after `after`. Polls in one-minute requests:
     * Node's fetch gives up on a response that takes over five minutes.
     */
    async wait(bot, after, timeoutMs = 300_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const chunk = Math.max(1000, Math.min(60_000, deadline - Date.now()))
        const result = await api('GET', `/bots/${bot.id}/wait?after=${after}&timeoutMs=${chunk}`)
        if ((result.answer !== undefined && !result.running) || Date.now() >= deadline) return result
      }
    },
    /** Wait until no bot works and no job waits (a bot blocked on the user counts as quiet). */
    async settled(timeoutMs = 300_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const chunk = Math.max(1000, Math.min(60_000, deadline - Date.now()))
        if ((await api('GET', `/settled?timeoutMs=${chunk}`)).settled) return true
        if (Date.now() >= deadline) return false
      }
    },
    memory: bot => api('GET', `/bots/${bot.id}/memory`).then(r => r.entries),
    setMemory: (bot, entries) => api('PUT', `/bots/${bot.id}/memory`, { entries }),
    agenda: bot => api('GET', `/bots/${bot.id}/agenda`).then(r => r.goals),
    watches: bot => api('GET', `/bots/${bot.id}/watches`).then(r => r.watches),
    jobs: () => api('GET', '/jobs').then(r => r.jobs),
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Restart the Harness with the given shell command and wait until the API answers again. */
export async function restart(client, command) {
  if (!command) throw new Error('this step restarts the Harness: pass --restart "<shell command>" or set DSH_RESTART')
  execSync(command, { stdio: 'inherit', shell: '/bin/bash' })
  await sleep(3000)
  await client.bots()
}

export async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

export async function read(path) {
  try { return await readFile(path, 'utf8') } catch { return undefined }
}

/** A test run: collects steps and checks, prints verdicts, writes the record. */
export function run(name) {
  const record = { test: name, startedAt: new Date().toISOString(), steps: [], checks: [] }
  return {
    record,
    step(label, data) {
      record.steps.push({ at: new Date().toISOString(), label, ...data })
      console.log(`· ${label}`)
    },
    /** verdict: true → PASS, false → FAIL, 'review' → needs a person to judge from the record. */
    check(label, verdict, detail) {
      const outcome = verdict === 'review' ? 'REVIEW' : verdict ? 'PASS' : 'FAIL'
      record.checks.push({ label, outcome, ...(detail === undefined ? {} : { detail }) })
      console.log(`  ${outcome.padEnd(6)} ${label}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
    },
    async finish() {
      record.finishedAt = new Date().toISOString()
      const dir = join(here, 'results')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${name}-${record.startedAt.replace(/[:.]/g, '-')}.json`)
      await writeFile(file, JSON.stringify(record, null, 2))
      const counts = record.checks.reduce((acc, c) => ({ ...acc, [c.outcome]: (acc[c.outcome] ?? 0) + 1 }), {})
      console.log(`\n${name}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}. Record: ${file}`)
      return record
    },
  }
}

/** A unique, readable suffix so repeated runs never collide. */
export const tag = () => new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')

export const includesAny = (text, words) => words.some(word => (text ?? '').toLowerCase().includes(word.toLowerCase()))
