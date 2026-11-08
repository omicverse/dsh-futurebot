import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { PERMISSION_MODES, type Bot, type BotInput, type PermissionMode } from '../shared/types.ts'
import { ApiError, type Api } from './api.ts'
import { BotDetails } from './BotDetails.tsx'
import { GroupsPanel } from './GroupsPanel.tsx'
import type { MessageKey, Translate } from './i18n.ts'
import { CSS } from './styles.ts'

export interface BotsPageProps {
  api: Api
  openSession: (sessionId: string) => void
  t: Translate
}

interface Draft {
  name: string
  instructions: string
  permission: PermissionMode
  workspace: string
  basePreset: string
  provider: string
  model: string
  isMain: boolean
  askOnce: boolean
}

type Editor = { mode: 'create' } | { mode: 'edit'; bot: Bot }

const EMPTY: Draft = { name: '', instructions: '', permission: 'auto', workspace: '', basePreset: '', provider: '', model: '', isMain: false, askOnce: true }

function draftOf(bot: Bot): Draft {
  return {
    name: bot.name,
    instructions: bot.instructions,
    permission: bot.permission,
    workspace: bot.workspace,
    basePreset: bot.basePreset ?? '',
    provider: bot.model?.provider ?? '',
    model: bot.model?.model ?? '',
    isMain: bot.isMain === true,
    askOnce: bot.approvalScope === 'once_per_chat',
  }
}

function errorKey(error: unknown): MessageKey {
  return error instanceof ApiError ? (`err_${error.code}` as MessageKey) : 'err_network'
}

export function BotsPage({ api, openSession, t }: BotsPageProps) {
  const [bots, setBots] = useState<Bot[] | undefined>(undefined)
  const [loadError, setLoadError] = useState(false)
  const [editor, setEditor] = useState<Editor | undefined>(undefined)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [workspaceTouched, setWorkspaceTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<MessageKey | undefined>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [rowError, setRowError] = useState<{ id: string; key: MessageKey } | undefined>(undefined)
  const [tab, setTab] = useState<'bots' | 'groups'>('bots')
  const [details, setDetails] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    setLoadError(false)
    try {
      setBots(await api.list())
    } catch {
      setLoadError(true)
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  // Suggest a workspace from the name until the user types their own.
  useEffect(() => {
    if (editor?.mode !== 'create' || workspaceTouched) return
    const name = draft.name.trim()
    if (name === '') return
    let live = true
    const timer = setTimeout(() => {
      api.defaultWorkspace(name).then(workspace => { if (live) setDraft(current => ({ ...current, workspace })) }, () => undefined)
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [api, editor, draft.name, workspaceTouched])

  const startCreate = () => {
    setEditor({ mode: 'create' })
    setDraft(EMPTY)
    setWorkspaceTouched(false)
    setFormError(undefined)
  }

  const startEdit = (bot: Bot) => {
    setEditor({ mode: 'edit', bot })
    setDraft(draftOf(bot))
    setFormError(undefined)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (editor === undefined || saving) return
    const provider = draft.provider.trim()
    const model = draft.model.trim()
    if ((provider === '') !== (model === '')) {
      setFormError('err_invalid_model')
      return
    }
    const common: BotInput = {
      name: draft.name,
      instructions: draft.instructions,
      permission: draft.permission,
      model: provider === '' ? null : { provider, model },
      isMain: draft.isMain,
      approvalScope: draft.askOnce ? 'once_per_chat' : 'each',
    }
    setSaving(true)
    setFormError(undefined)
    try {
      if (editor.mode === 'create') {
        await api.create({
          ...common,
          ...(draft.workspace.trim() === '' ? {} : { workspace: draft.workspace.trim() }),
          ...(draft.basePreset.trim() === '' ? {} : { basePreset: draft.basePreset.trim() }),
        })
      } else {
        await api.update(editor.bot.id, editor.bot.rev, common)
      }
      setEditor(undefined)
      await load()
    } catch (error) {
      setFormError(errorKey(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (bot: Bot) => {
    try {
      await api.remove(bot.id)
      setConfirming(undefined)
      await load()
    } catch (error) {
      setRowError({ id: bot.id, key: errorKey(error) })
    }
  }

  const creating = editor?.mode === 'create'

  return (
    <div className="ob-page">
      <style>{CSS}</style>
      <div className="ob-content">
        <header className="ob-header">
          <div>
            <h1 className="ob-title">{t('title')}</h1>
            <p className="ob-subtitle">{t('subtitle')}</p>
          </div>
          {editor === undefined && tab === 'bots' && <button type="button" className="ob-button ob-button--primary" onClick={startCreate}>{t('newBot')}</button>}
        </header>
        <div className="ob-tabs" role="tablist">
          {(['bots', 'groups'] as const).map(key => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={`ob-tab${tab === key ? ' ob-tab--on' : ''}`} onClick={() => setTab(key)}>
              {t(key === 'bots' ? 'tabBots' : 'tabGroups')}
            </button>
          ))}
        </div>
        {tab === 'groups' && <GroupsPanel api={api} bots={bots ?? []} t={t} />}
        {tab === 'bots' && <>

        {editor !== undefined && (
          <form className="ob-card ob-form" onSubmit={submit} aria-label={creating ? t('newBot') : t('edit')}>
            <label className="ob-field">
              <span className="ob-label">{t('fieldName')}</span>
              <input className="ob-input" aria-label={t('fieldName')} value={draft.name} maxLength={40} autoFocus required
                onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, name: value })) }} />
            </label>
            <label className="ob-field">
              <span className="ob-label">{t('fieldInstructions')}</span>
              <textarea className="ob-input ob-textarea" aria-label={t('fieldInstructions')} value={draft.instructions} rows={5} maxLength={8000}
                onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, instructions: value })) }} />
              <span className="ob-hint">{t('fieldInstructionsHint')}</span>
            </label>
            <fieldset className="ob-field ob-fieldset">
              <legend className="ob-label">{t('fieldPermission')}</legend>
              {PERMISSION_MODES.map(mode => (
                <label key={mode} className="ob-radio">
                  <input type="radio" name="ob-permission" aria-label={t(`perm_${mode}`)} checked={draft.permission === mode}
                    onChange={() => setDraft(current => ({ ...current, permission: mode }))} />
                  <span><strong>{t(`perm_${mode}`)}</strong><small className="ob-hint">{t(`perm_${mode}Hint`)}</small></span>
                </label>
              ))}
            </fieldset>
            {draft.permission !== 'full' && (
              <label className="ob-radio">
                <input type="checkbox" aria-label={t('fieldAskOnce')} checked={draft.askOnce}
                  onChange={event => { const value = event.target.checked; setDraft(current => ({ ...current, askOnce: value })) }} />
                <span><strong>{t('fieldAskOnce')}</strong><small className="ob-hint">{t('fieldAskOnceHint')}</small></span>
              </label>
            )}
            <label className="ob-radio">
              <input type="checkbox" aria-label={t('fieldMain')} checked={draft.isMain}
                onChange={event => { const value = event.target.checked; setDraft(current => ({ ...current, isMain: value })) }} />
              <span><strong>{t('fieldMain')}</strong><small className="ob-hint">{t('fieldMainHint')}</small></span>
            </label>
            <label className="ob-field">
              <span className="ob-label">{t('fieldWorkspace')}</span>
              <input className="ob-input ob-mono" aria-label={t('fieldWorkspace')} value={draft.workspace} disabled={!creating}
                onChange={event => { const value = event.target.value; setWorkspaceTouched(true); setDraft(current => ({ ...current, workspace: value })) }} />
              <span className="ob-hint">{t('fieldWorkspaceHint')}</span>
            </label>
            <details className="ob-advanced">
              <summary>{t('fieldModel')} · {t('fieldPreset')}</summary>
              <div className="ob-row2">
                <label className="ob-field">
                  <span className="ob-label">{t('fieldProvider')}</span>
                  <input className="ob-input ob-mono" aria-label={t('fieldProvider')} value={draft.provider} onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, provider: value })) }} />
                </label>
                <label className="ob-field">
                  <span className="ob-label">{t('fieldModelName')}</span>
                  <input className="ob-input ob-mono" aria-label={t('fieldModelName')} value={draft.model} onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, model: value })) }} />
                </label>
              </div>
              <span className="ob-hint">{t('fieldModelHint')}</span>
              <label className="ob-field">
                <span className="ob-label">{t('fieldPreset')}</span>
                <input className="ob-input ob-mono" aria-label={t('fieldPreset')} value={draft.basePreset} disabled={!creating}
                  onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, basePreset: value })) }} />
                <span className="ob-hint">{t('fieldPresetHint')}</span>
              </label>
            </details>
            {formError !== undefined && <p className="ob-error" role="alert">{t(formError)}</p>}
            <div className="ob-actions">
              <button type="button" className="ob-button" onClick={() => setEditor(undefined)} disabled={saving}>{t('cancel')}</button>
              <button type="submit" className="ob-button ob-button--primary" disabled={saving || draft.name.trim() === ''}>
                {saving ? t('saving') : creating ? t('create') : t('save')}
              </button>
            </div>
          </form>
        )}

        {bots === undefined && !loadError && <p className="ob-muted">{t('loading')}</p>}
        {loadError && (
          <p className="ob-error" role="alert">
            {t('loadFailed')} <button type="button" className="ob-link" onClick={() => void load()}>{t('retry')}</button>
          </p>
        )}
        {bots !== undefined && bots.length === 0 && editor === undefined && <p className="ob-muted ob-empty">{t('empty')}</p>}

        {bots !== undefined && bots.length > 0 && (
          <ul className="ob-list">
            {bots.map(bot => (
              <li key={bot.id} className="ob-item">
                <span className="ob-avatar" aria-hidden="true">{Array.from(bot.name)[0]}</span>
                <div className="ob-item-main">
                  <div className="ob-item-title">
                    <span className="ob-name">{bot.name}</span>
                    {bot.isMain === true && <span className="ob-chip ob-chip--main">{t('fieldMain')}</span>}
                    <span className={`ob-chip ob-chip--${bot.permission}`}>{t(`perm_${bot.permission}`)}</span>
                  </div>
                  {bot.instructions !== '' && <p className="ob-item-text">{bot.instructions}</p>}
                  <p className="ob-item-caption ob-mono">{bot.workspace}</p>
                  {rowError?.id === bot.id && <p className="ob-error" role="alert">{t(rowError.key)}</p>}
                </div>
                <div className="ob-item-actions">
                  {confirming === bot.id ? (
                    <>
                      <span className="ob-confirm">{t('deleteConfirm', { name: bot.name })}</span>
                      <button type="button" className="ob-button ob-button--danger" onClick={() => void remove(bot)}>{t('delete')}</button>
                      <button type="button" className="ob-button" onClick={() => setConfirming(undefined)}>{t('cancel')}</button>
                    </>
                  ) : (
                    <>
                      {bot.sessionId !== undefined && (
                        <button type="button" className="ob-button ob-button--primary" onClick={() => openSession(bot.sessionId!)}>{t('open')}</button>
                      )}
                      <button type="button" className="ob-button" aria-expanded={details === bot.id} onClick={() => setDetails(current => (current === bot.id ? undefined : bot.id))}>{details === bot.id ? t('hideDetails') : t('details')}</button>
                      <button type="button" className="ob-button" onClick={() => startEdit(bot)} disabled={editor !== undefined}>{t('edit')}</button>
                      <button type="button" className="ob-button" onClick={() => { setRowError(undefined); setConfirming(bot.id) }}>{t('delete')}</button>
                    </>
                  )}
                </div>
                {details === bot.id && <div className="ob-item-full"><BotDetails bot={bot} bots={bots} api={api} t={t} /></div>}
              </li>
            ))}
          </ul>
        )}
        </>}
      </div>
    </div>
  )
}
