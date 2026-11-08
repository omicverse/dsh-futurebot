/**
 * Page styles. Only Harness theme tokens (`--dsw-alias-*`) carry color, so the
 * page follows light/dark and theme changes like the host's own pages.
 * Layout copies the Harness management pages: a 960px centered column.
 */
export const CSS = `
.ob-page { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 14px; line-height: 1.6; }
.ob-content { max-width: 960px; margin: 0 auto; padding: 32px 24px 48px; }
.ob-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.ob-title { margin: 0; font-size: 20px; font-weight: 600; }
.ob-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); }
.ob-muted { color: var(--dsw-alias-label-tertiary); }
.ob-empty { padding: 32px 0; text-align: center; }
.ob-error { margin: 8px 0 0; color: var(--dsw-alias-state-error-primary); }
.ob-hint { display: block; margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; }
.ob-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ob-button { height: 30px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.ob-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ob-button:disabled { opacity: 0.5; cursor: default; }
.ob-button--primary { border-color: transparent; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); }
.ob-button--primary:hover:not(:disabled) { background: var(--dsw-alias-state-business-primary); opacity: 0.9; }
.ob-button--danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.ob-link { padding: 0; border: 0; background: none; color: var(--dsw-alias-state-business-primary); font: inherit; cursor: pointer; }
.ob-card { margin-bottom: 20px; padding: 20px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.ob-form { display: flex; flex-direction: column; gap: 14px; }
.ob-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ob-fieldset { margin: 0; padding: 0; border: 0; gap: 6px; }
.ob-label { font-weight: 500; }
.ob-input { box-sizing: border-box; width: 100%; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.ob-input.ob-mono { font-size: 12px; }
.ob-input:disabled { color: var(--dsw-alias-label-tertiary); }
.ob-textarea { resize: vertical; min-height: 96px; }
.ob-radio { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.ob-radio input { margin-top: 5px; }
.ob-radio small { display: block; }
.ob-advanced summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }
.ob-advanced[open] { display: flex; flex-direction: column; gap: 10px; }
.ob-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
.ob-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ob-list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--dsw-alias-border-l2); }
.ob-item { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; padding: 14px 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ob-item-full { flex-basis: 100%; min-width: 0; padding-left: 48px; box-sizing: border-box; }
.ob-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 600; }
.ob-item-main { flex: 1; min-width: 0; }
.ob-item-title { display: flex; align-items: center; gap: 8px; }
.ob-name { font-weight: 600; }
.ob-chip { padding: 0 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ob-chip--main { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.ob-chip--full { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.ob-item-text { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
.ob-item-caption { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ob-item-actions { flex: none; display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 50%; }
.ob-confirm { color: var(--dsw-alias-label-secondary); font-size: 13px; }
.ob-tabs { display: flex; gap: 4px; margin: 0 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ob-tab { padding: 6px 12px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; }
.ob-tab--on { border-bottom-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); font-weight: 600; }
.ob-subhead { display: flex; justify-content: flex-end; margin-bottom: 12px; }
.ob-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 20px; margin-top: 2px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.ob-h2 { margin: 0; font-size: 17px; font-weight: 600; }
.ob-h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.ob-count { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.ob-mini { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.ob-mini li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.ob-mini-text { white-space: pre-wrap; }
.ob-mini-meta { width: 100%; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.ob-replaced { opacity: 0.55; }
.ob-replaced .ob-mini-text { text-decoration: line-through; }
.ob-tag { padding: 0 6px; border-radius: 4px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
.ob-tag--correction { color: var(--dsw-alias-state-error-primary); }
.ob-tag--inference { color: var(--dsw-alias-state-business-primary); }
.ob-item--link { cursor: pointer; }
.ob-item--link:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ob-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ob-pick { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 999px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.ob-pick input { margin: 0; }
.ob-pick--on { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); }
.ob-group { display: flex; flex-direction: column; gap: 12px; }
.ob-group-head { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.ob-goal { padding: 12px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.ob-goal-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ob-goal-actions { margin-left: auto; display: flex; gap: 6px; }
.ob-stages { margin: 8px 0 0; padding-left: 20px; display: grid; gap: 4px; }
.ob-stage { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.ob-stage--passed { color: var(--dsw-alias-label-tertiary); }
.ob-banner { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.ob-log { display: flex; flex-direction: column; gap: 10px; max-height: 55vh; overflow: auto; padding: 4px 2px; }
.ob-msg { display: flex; gap: 8px; align-items: flex-start; }
.ob-msg--me { flex-direction: row-reverse; }
.ob-msg--me .ob-msg-body { align-items: flex-end; }
.ob-msg-body { display: flex; flex-direction: column; min-width: 0; max-width: 80%; }
.ob-msg-name { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.ob-msg-text { margin: 2px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); white-space: pre-wrap; overflow-wrap: anywhere; }
.ob-avatar--sm { width: 28px; height: 28px; font-size: 13px; }
.ob-event { margin: 0; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.ob-event--review { font-style: italic; }
.ob-composer { display: flex; flex-direction: column; gap: 8px; }
.ob-group-settings { padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
@media (max-width: 640px) {
  .ob-content { padding: 20px 16px 32px; }
  .ob-item { flex-wrap: wrap; }
  .ob-item-actions { box-sizing: border-box; max-width: none; width: 100%; justify-content: flex-start; padding-left: 48px; }
  .ob-item-full { padding-left: 0; }
  .ob-row2 { grid-template-columns: 1fr; }
}
`
