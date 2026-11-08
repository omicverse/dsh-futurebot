import { useCallback, useEffect, useState } from 'react'
import type { Bot } from '../shared/types.ts'
import type { AgendaItem, Api, Job, MemoryEntry, Watch } from './api.ts'
import type { MessageKey, Translate } from './i18n.ts'

/**
 * What a bot keeps and does, read-only: its memory (records, conclusions and
 * corrections, with whom they concern and what replaced them), its agenda
 * with the reason for every change, the folders it watches, and its work
 * with other bots. This is the visible side of the Perspective's conditions.
 */
export function BotDetails({ bot, bots, api, t }: { bot: Bot; bots: Bot[]; api: Api; t: Translate }) {
  const [memory, setMemory] = useState<MemoryEntry[]>()
  const [agenda, setAgenda] = useState<AgendaItem[]>()
  const [watches, setWatches] = useState<Watch[]>()
  const [jobs, setJobs] = useState<Job[]>()
  const [failed, setFailed] = useState(false)
  const name = (id: string) => bots.find(b => b.id === id)?.name ?? id

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const [m, a, w, j] = await Promise.all([api.memory(bot.id), api.agenda(bot.id), api.watches(bot.id), api.jobs()])
      setMemory([...m].reverse())
      setAgenda(a)
      setWatches(w)
      setJobs(j.filter(job => job.from === bot.id || job.to === bot.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 20))
    } catch {
      setFailed(true)
    }
  }, [api, bot.id])

  useEffect(() => { void load() }, [load])

  if (failed) return <p className="ob-error">{t('loadFailed')} <button type="button" className="ob-link" onClick={() => void load()}>{t('retry')}</button></p>
  if (memory === undefined) return <p className="ob-muted">{t('loading')}</p>

  return (
    <div className="ob-details">
      <section>
        <h3 className="ob-h3">{t('memory')} <span className="ob-count">{memory.length}</span></h3>
        {memory.length === 0 ? <p className="ob-muted">{t('memoryEmpty')}</p> : (
          <ul className="ob-mini">
            {memory.slice(0, 30).map(entry => (
              <li key={entry.id} className={entry.correctedBy ? 'ob-replaced' : undefined}>
                <span className={`ob-tag ob-tag--${entry.kind}`}>{t(`kind_${entry.kind}` as MessageKey)}</span>
                {entry.about !== undefined && <span className="ob-tag">{entry.about === 'user' ? t('aboutUser') : t('aboutBot', { name: name(entry.about) })}</span>}
                <span className="ob-mini-text">{entry.text}</span>
                <span className="ob-mini-meta ob-mono">{entry.id}{entry.correctedBy ? ` · ${t('replacedBy', { id: entry.correctedBy })}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="ob-h3">{t('agenda')}</h3>
        {agenda!.length === 0 ? <p className="ob-muted">{t('agendaEmpty')}</p> : (
          <ul className="ob-mini">
            {agenda!.map(item => {
              const last = item.history[item.history.length - 1]
              return (
                <li key={item.id} className={item.state === 'open' ? undefined : 'ob-replaced'}>
                  <span className={`ob-tag ob-tag--goal-${item.state}`}>{t(`goal_${item.state}` as MessageKey)}</span>
                  <span className="ob-mini-text">{item.goal}</span>
                  {last !== undefined && <span className="ob-mini-meta">{last.action}: {last.reason}{last.trigger ? ` · ${last.trigger}` : ''}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section>
        <h3 className="ob-h3">{t('watches')}</h3>
        {watches!.length === 0 ? <p className="ob-muted">{t('watchesEmpty')}</p> : (
          <ul className="ob-mini">
            {watches!.map(watch => <li key={watch.id}><span className="ob-mini-text ob-mono">{watch.path}</span>{watch.note !== '' && <span className="ob-mini-meta">{watch.note}</span>}</li>)}
          </ul>
        )}
      </section>
      <section>
        <h3 className="ob-h3">{t('jobs')}</h3>
        {jobs!.length === 0 ? <p className="ob-muted">{t('jobsEmpty')}</p> : (
          <ul className="ob-mini">
            {jobs!.map(job => (
              <li key={job.id}>
                <span className="ob-tag">{job.from === bot.id ? t('jobTo', { name: name(job.to) }) : t('jobFrom', { name: name(job.from) })}</span>
                <span className="ob-tag">{job.state}</span>
                <span className="ob-mini-text">{job.text.split('\n')[0]}</span>
                {job.reply !== undefined && <span className="ob-mini-meta">↩ {job.reply.split('\n')[0]}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
