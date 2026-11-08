import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Bot } from '../shared/types.ts'
import { ApiError, type Api, type Group, type GroupInput, type LogEntry } from './api.ts'
import type { MessageKey, Translate } from './i18n.ts'

interface Props {
  api: Api
  bots: Bot[]
  t: Translate
}

const POLL_MS = 2000

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error)
}

/** Groups: the list, a form to make one, and one group's conversation and goal. */
export function GroupsPanel({ api, bots, t }: Props) {
  const [groups, setGroups] = useState<Group[]>()
  const [open, setOpen] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try { setGroups(await api.groups()); setError(undefined) } catch (e) { setError(errorText(e)) }
  }, [api])
  useEffect(() => { void load() }, [load])

  if (open !== undefined) {
    return <GroupView id={open} api={api} bots={bots} t={t} onBack={() => { setOpen(undefined); void load() }} />
  }
  return (
    <div>
      <div className="ob-subhead">
        {!creating && <button type="button" className="ob-button ob-button--primary" onClick={() => setCreating(true)} disabled={bots.length === 0}>{t('newGroup')}</button>}
      </div>
      {creating && <GroupForm api={api} bots={bots} t={t} onDone={async created => { setCreating(false); await load(); if (created) setOpen(created.id) }} />}
      {error !== undefined && <p className="ob-error" role="alert">{error}</p>}
      {groups === undefined && error === undefined && <p className="ob-muted">{t('loading')}</p>}
      {groups !== undefined && groups.length === 0 && !creating && <p className="ob-muted ob-empty">{t('groupsEmpty')}</p>}
      {groups !== undefined && groups.length > 0 && (
        <ul className="ob-list">
          {groups.map(group => (
            <li key={group.id} className="ob-item ob-item--link" role="button" tabIndex={0}
              onClick={() => setOpen(group.id)} onKeyDown={event => { if (event.key === 'Enter') setOpen(group.id) }}>
              <span className="ob-avatar" aria-hidden="true">#</span>
              <div className="ob-item-main">
                <div className="ob-item-title">
                  <span className="ob-name">{group.title}</span>
                  {group.goal !== undefined && <span className="ob-chip">{t(`goalStatus_${group.goal.status}` as MessageKey)}</span>}
                </div>
                <p className="ob-item-caption">{group.members.map(id => bots.find(b => b.id === id)?.name ?? id).join('、')}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function GroupForm({ api, bots, t, onDone }: Props & { onDone: (created?: Group) => void }) {
  const [title, setTitle] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [admin, setAdmin] = useState<string>('')
  const [approvals, setApprovals] = useState<'admin' | 'user'>('admin')
  const [adminMayApprove, setAdminMayApprove] = useState(false)
  const [userIn, setUserIn] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const toggle = (id: string) => {
    const next = members.includes(id) ? members.filter(m => m !== id) : [...members, id]
    setMembers(next)
    // Default the admin to the coordinator when it is in the group, else the first member.
    if (!next.includes(admin)) setAdmin(next.find(m => bots.find(b => b.id === m)?.isMain) ?? next[0] ?? '')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(undefined)
    try {
      const input: GroupInput = { title, members, admin: admin === '' ? null : admin, approvals, adminMayApprove, userIn }
      onDone(await api.createGroup(input))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="ob-card ob-form" onSubmit={submit} aria-label={t('newGroup')}>
      <label className="ob-field">
        <span className="ob-label">{t('fieldTitle')}</span>
        <input className="ob-input" aria-label={t('fieldTitle')} value={title} maxLength={60} autoFocus required onChange={event => { const value = event.target.value; setTitle(value) }} />
      </label>
      <fieldset className="ob-field ob-fieldset">
        <legend className="ob-label">{t('fieldMembers')}</legend>
        <div className="ob-chips">
          {bots.map(bot => (
            <label key={bot.id} className={`ob-pick${members.includes(bot.id) ? ' ob-pick--on' : ''}`}>
              <input type="checkbox" aria-label={bot.name} checked={members.includes(bot.id)} onChange={() => toggle(bot.id)} />{bot.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="ob-field">
        <span className="ob-label">{t('fieldAdmin')}</span>
        <select className="ob-input" aria-label={t('fieldAdmin')} value={admin} onChange={event => { const value = event.target.value; setAdmin(value) }}>
          <option value="">{t('noAdmin')}</option>
          {members.map(id => <option key={id} value={id}>{bots.find(b => b.id === id)?.name ?? id}</option>)}
        </select>
      </label>
      <fieldset className="ob-field ob-fieldset">
        <legend className="ob-label">{t('fieldApprovals')}</legend>
        {(['admin', 'user'] as const).map(mode => (
          <label key={mode} className="ob-radio">
            <input type="radio" name="ob-approvals" aria-label={t(`approvals_${mode}`)} checked={approvals === mode} onChange={() => setApprovals(mode)} />
            <span><strong>{t(`approvals_${mode}`)}</strong></span>
          </label>
        ))}
        {approvals === 'admin' && (
          <label className="ob-radio">
            <input type="checkbox" aria-label={t('fieldAdminMayApprove')} checked={adminMayApprove} onChange={event => { const value = event.target.checked; setAdminMayApprove(value) }} />
            <span><strong>{t('fieldAdminMayApprove')}</strong><small className="ob-hint">{t('fieldAdminMayApproveHint')}</small></span>
          </label>
        )}
      </fieldset>
      <label className="ob-radio">
        <input type="checkbox" aria-label={t('fieldUserIn')} checked={userIn} onChange={event => { const value = event.target.checked; setUserIn(value) }} />
        <span><strong>{t('fieldUserIn')}</strong></span>
      </label>
      {error !== undefined && <p className="ob-error" role="alert">{error}</p>}
      <div className="ob-actions">
        <button type="button" className="ob-button" onClick={() => onDone()} disabled={saving}>{t('cancel')}</button>
        <button type="submit" className="ob-button ob-button--primary" disabled={saving || title.trim() === '' || members.length === 0}>{saving ? t('saving') : t('create')}</button>
      </div>
    </form>
  )
}

const GOAL_ACTIONS: Record<string, string[]> = {
  planning: ['start', 'clear'],
  active: ['pause', 'stop'],
  waiting_user: ['pause', 'stop'],
  paused: ['resume', 'stop'],
  done: ['clear'],
  stopped: ['clear'],
}

function GroupView({ id, api, bots, t, onBack }: Omit<Props, 'bots'> & { id: string; bots: Bot[]; onBack: () => void }) {
  const [group, setGroup] = useState<Group>()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [confirming, setConfirming] = useState(false)
  const last = useRef(0)
  const bottom = useRef<HTMLDivElement>(null)
  const name = (who: string) => (who === 'user' ? t('you') : who === 'system' ? t('event') : bots.find(b => b.id === who)?.name ?? who)

  const refresh = useCallback(async () => {
    try {
      const [g, fresh] = await Promise.all([api.group(id), api.log(id, last.current)])
      setGroup(g)
      if (fresh.length > 0) {
        last.current = fresh[fresh.length - 1]!.seq
        setEntries(current => [...current, ...fresh])
      }
    } catch (e) {
      setError(errorText(e))
    }
  }, [api, id])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [entries.length])

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (text.trim() === '') return
    try {
      await api.post(id, text)
      setText('')
      await refresh()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const act = async (action: string) => {
    try { setGroup(await api.goal(id, action)); await refresh() } catch (e) { setError(errorText(e)) }
  }

  const update = async (input: GroupInput) => {
    try { setGroup(await api.updateGroup(id, input)) } catch (e) { setError(errorText(e)) }
  }

  if (group === undefined) return <p className="ob-muted">{error ?? t('loading')}</p>
  const goal = group.goal
  const stage = goal?.stages[goal.current]

  return (
    <div className="ob-group">
      <div className="ob-group-head">
        <button type="button" className="ob-link" onClick={onBack}>← {t('back')}</button>
        <h2 className="ob-h2">{group.title}</h2>
        <span className="ob-item-caption">{group.members.map(m => `${name(m)}${m === group.admin ? '★' : ''}`).join('、')}</span>
      </div>

      {goal !== undefined && (
        <div className="ob-goal" aria-label={t('goal')}>
          <div className="ob-goal-line">
            <strong>{t('goal')}</strong>
            <span>{goal.objective}</span>
            <span className="ob-chip">{t(`goalStatus_${goal.status}` as MessageKey)}</span>
            <span className="ob-goal-actions">
              {(GOAL_ACTIONS[goal.status] ?? []).map(action => (
                <button key={action} type="button" className={`ob-button${action === 'start' || action === 'resume' ? ' ob-button--primary' : ''}`} onClick={() => void act(action)}>{t(`goal_${action}` as MessageKey)}</button>
              ))}
            </span>
          </div>
          {stage !== undefined && goal.status !== 'done' && (
            <p className="ob-item-caption">{t('goalStage', { n: String(goal.current + 1), total: String(goal.stages.length), title: stage.title, owner: name(stage.owner) })}</p>
          )}
          <ol className="ob-stages">
            {goal.stages.map((s, index) => (
              <li key={index} className={`ob-stage ob-stage--${s.status}`}>
                <span className="ob-tag">{t(`stage_${s.status}` as MessageKey)}</span>
                <span>{s.title} · {name(s.owner)}</span>
                {s.evidence !== undefined && <span className="ob-mini-meta">✓ {s.evidence}</span>}
                {s.note !== undefined && s.status !== 'passed' && <span className="ob-mini-meta">↺ {s.note}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {group.paused && <p className="ob-banner">{t('paused')}</p>}

      <div className="ob-log" aria-live="polite">
        {entries.map(entry => entry.kind === 'message' ? (
          <div key={entry.id} className={`ob-msg${entry.from === 'user' ? ' ob-msg--me' : ''}`}>
            <span className="ob-avatar ob-avatar--sm" aria-hidden="true">{Array.from(name(entry.from))[0]}</span>
            <div className="ob-msg-body">
              <span className="ob-msg-name">{name(entry.from)}</span>
              <p className="ob-msg-text">{entry.text}</p>
            </div>
          </div>
        ) : (
          <p key={entry.id} className={`ob-event${entry.kind === 'review' ? ' ob-event--review' : ''}`}>{entry.text}</p>
        ))}
        <div ref={bottom} />
      </div>

      {error !== undefined && <p className="ob-error" role="alert">{error}</p>}
      {group.userIn ? (
        <form className="ob-composer" onSubmit={send}>
          <div className="ob-chips">
            {group.members.map(m => <button key={m} type="button" className="ob-pick" onClick={() => setText(current => `${current}@${name(m)} `)}>@{name(m)}</button>)}
          </div>
          <textarea className="ob-input ob-textarea" aria-label={t('composer')} placeholder={t('composer')} rows={3} value={text}
            onChange={event => { const value = event.target.value; setText(value) }}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(event) }} />
          <div className="ob-actions"><button type="submit" className="ob-button ob-button--primary" disabled={text.trim() === ''}>{t('send')}</button></div>
        </form>
      ) : <p className="ob-muted">{t('notInGroup')}</p>}

      <details className="ob-advanced ob-group-settings">
        <summary>{t('fieldApprovals')} · {t('fieldUserIn')} · {t('deleteGroup')}</summary>
        {(['admin', 'user'] as const).map(mode => (
          <label key={mode} className="ob-radio">
            <input type="radio" name="ob-group-approvals" checked={group.approvals === mode} onChange={() => void update({ approvals: mode })} />
            <span><strong>{t(`approvals_${mode}`)}</strong></span>
          </label>
        ))}
        {group.approvals === 'admin' && (
          <label className="ob-radio">
            <input type="checkbox" checked={group.adminMayApprove} onChange={event => void update({ adminMayApprove: event.target.checked })} />
            <span><strong>{t('fieldAdminMayApprove')}</strong><small className="ob-hint">{t('fieldAdminMayApproveHint')}</small></span>
          </label>
        )}
        <label className="ob-radio">
          <input type="checkbox" checked={group.userIn} onChange={event => void update({ userIn: event.target.checked })} />
          <span><strong>{t('fieldUserIn')}</strong></span>
        </label>
        <div className="ob-actions">
          {confirming ? (
            <>
              <span className="ob-confirm">{t('deleteGroupConfirm', { title: group.title })}</span>
              <button type="button" className="ob-button ob-button--danger" onClick={async () => { await api.removeGroup(id); onBack() }}>{t('deleteGroup')}</button>
              <button type="button" className="ob-button" onClick={() => setConfirming(false)}>{t('cancel')}</button>
            </>
          ) : <button type="button" className="ob-button ob-button--danger" onClick={() => setConfirming(true)}>{t('deleteGroup')}</button>}
        </div>
      </details>
    </div>
  )
}
