import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Bot } from '../shared/types.ts'
import type { Job } from './courier.ts'
import type { Watch } from './evidence.ts'
import type { Group, LogEntry } from './groups.ts'
import type { AgendaItem, MemoryEntry } from './mind.ts'
import { DOMAIN_NAME, GROUPS_DOMAIN_NAME, JOBS_DOMAIN_NAME, MIND_DOMAIN_NAME, agendaSchema, botSchema, groupSchema, jobSchema, logEntrySchema, memorySchema, watchSchema } from './schema.ts'

/**
 * Host-wide bot records. The default backend writes JSON under
 * `$DSH_HOME/storages`; bump `version` (and list the old one as compatible)
 * whenever the stored shape changes.
 */
export const botDomain = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: { bots: domainTable<string, Bot>(botSchema) },
})

/** Jobs between bots: what was sent, to whom, and where each reply goes. */
export const jobDomain = defineDomain({
  name: JOBS_DOMAIN_NAME,
  version: 1,
  tables: { jobs: domainTable<string, Job>(jobSchema) },
})

/** Each bot's own memory, agenda and watched folders. */
export const mindDomain = defineDomain({
  name: MIND_DOMAIN_NAME,
  version: 1,
  tables: {
    memory: domainTable<string, MemoryEntry>(memorySchema),
    agenda: domainTable<string, AgendaItem>(agendaSchema),
    watches: domainTable<string, Watch>(watchSchema),
  },
})

/** Groups of bots and what was said in them. */
export const groupDomain = defineDomain({
  name: GROUPS_DOMAIN_NAME,
  version: 1,
  tables: {
    groups: domainTable<string, Group>(groupSchema),
    log: domainTable<string, LogEntry>(logEntrySchema),
  },
})
