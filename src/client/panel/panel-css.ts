/**
 * Generated file — do not edit. Run `node scripts/build-css.mjs` after
 * editing src/client/panel/panel.module.css (wired into `pnpm build`).
 */
/** Scoped CSS text; inject once via ensurePanelCss(). */
export const panelCss = `[data-dsh-remote-ide-col], ._ri_16dhQq_panel {
  --ri-bg: var(--dsw-alias-bg-base, #1e1e1e);
  --ri-fg: var(--dsw-static-neutral-bluish-900, #d4d4d4);
  --ri-border: var(--dsw-alias-border-l2, #333);
  --ri-border-soft: var(--dsw-alias-border-l1, #2a2a2a);
  --ri-input-bg: var(--dsw-alias-bg-module-platform, #252526);
  --ri-card-bg: var(--dsw-alias-bg-module-platform, #252526);
  --ri-toolbar-bg: var(--dsw-alias-bg-module-platform, #252526);
  --ri-tabbar-bg: var(--dsw-alias-bg-module-platform, #252526);
  --ri-hover: var(--dsw-alias-bg-overlay, #8080801f);
  --ri-selected: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6);
  --ri-muted: var(--dsw-static-neutral-bluish-500, #8a8a8a);
  --ri-muted-dim: var(--dsw-static-neutral-bluish-400, #6f6f6f);
  --ri-accent: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6);
  --ri-accent-soft: #4176e61f;
  --ri-ok: var(--dsw-static-green-500, #22c55e);
  --ri-danger: var(--dsw-static-red-500, #ef4444);
  --ri-warn: #d8a13c;
  --ri-statusbar-bg: var(--dsw-static-deepseek-500, #4176e6);
}

._ri_16dhQq_view, ._ri_16dhQq_tabHost {
  flex-direction: column;
  height: 100%;
  min-height: 0;
  display: flex;
}

._ri_16dhQq_workbench {
  flex-direction: column;
}

._ri_16dhQq_explorer {
  border-right: none;
  border-bottom: 1px solid var(--ri-border, #333);
  flex: none;
  width: auto;
  max-height: 38%;
}

._ri_16dhQq_explorerBody {
  overflow-y: auto;
}

._ri_16dhQq_toolbarTitle {
  display: none;
}

._ri_16dhQq_entry {
  width: 100%;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: none;
  border-radius: 6px;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  display: flex;
}

._ri_16dhQq_entry:hover {
  background: var(--ri-hover);
}

._ri_16dhQq_entry[data-active="true"] {
  background: var(--ri-accent-soft);
  color: var(--ri-accent);
}

._ri_16dhQq_entryIcon {
  color: inherit;
  opacity: .85;
  flex: none;
  display: inline-flex;
}

._ri_16dhQq_entryLabel {
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

._ri_16dhQq_panel {
  background: var(--ri-bg, #1e1e1e);
  height: 100%;
  min-height: 0;
  color: var(--ri-fg, #d4d4d4);
  flex-direction: column;
  font-size: 13px;
  line-height: 1.5;
  display: flex;
}

._ri_16dhQq_toolbar {
  border-bottom: 1px solid var(--ri-border, #333);
  background: var(--ri-toolbar-bg, #252526);
  flex-wrap: wrap;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  display: flex;
}

._ri_16dhQq_toolbarTitle {
  color: var(--ri-fg, #d4d4d4);
  margin-right: 4px;
  font-weight: 600;
}

._ri_16dhQq_hostSelect {
  border: 1px solid var(--ri-border, #3c3c3c);
  background: var(--ri-input-bg, #252526);
  min-width: 150px;
  max-width: 240px;
  color: inherit;
  font: inherit;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 12px;
}

._ri_16dhQq_hostSelect:focus {
  border-color: #007acc;
  outline: none;
}

._ri_16dhQq_statePill {
  white-space: nowrap;
  color: var(--ri-muted, #9a9a9a);
  font-size: 11px;
}

._ri_16dhQq_stateConnected {
  color: var(--ri-ok);
}

._ri_16dhQq_stateConnecting {
  color: var(--ri-warn);
}

._ri_16dhQq_stateDisconnected {
  color: var(--ri-muted);
}

._ri_16dhQq_stateFailed {
  color: var(--ri-danger);
}

._ri_16dhQq_errorText {
  color: var(--ri-danger);
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
  font-size: 11px;
  overflow: hidden;
}

._ri_16dhQq_spacer {
  flex: 1;
}

._ri_16dhQq_welcome {
  text-align: center;
  color: var(--ri-muted, #8a8a8a);
  user-select: none;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
  padding: 28px 24px;
  display: flex;
}

._ri_16dhQq_welcomeIconWrap {
  background: var(--ri-accent-soft);
  border: 1px solid var(--ri-accent);
  width: 64px;
  height: 64px;
  color: var(--ri-accent);
  border-radius: 50%;
  justify-content: center;
  align-items: center;
  margin-bottom: 8px;
  display: flex;
}

._ri_16dhQq_welcomeTitle {
  color: var(--ri-fg, #d4d4d4);
  font-size: 15px;
  font-weight: 600;
}

._ri_16dhQq_welcomeText {
  max-width: 280px;
  font-size: 12.5px;
  line-height: 1.6;
}

._ri_16dhQq_welcomeActions {
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 220px;
  margin-top: 12px;
  display: flex;
}

._ri_16dhQq_welcomeActions ._ri_16dhQq_btn {
  justify-content: center;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12.5px;
  display: flex;
}

._ri_16dhQq_welcomeHint {
  color: var(--ri-muted-dim, #6f6f6f);
  max-width: 240px;
  margin-top: 14px;
  font-size: 11px;
  line-height: 1.5;
}

._ri_16dhQq_btn {
  border: 1px solid var(--ri-border, #444);
  background: var(--ri-input-bg, #252526);
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 12px;
}

._ri_16dhQq_btn:hover {
  background: var(--ri-hover);
}

._ri_16dhQq_btn:disabled {
  opacity: .5;
  cursor: default;
}

._ri_16dhQq_btnPrimary {
  border-color: var(--ri-accent);
  background: var(--ri-accent);
  color: #fff;
}

._ri_16dhQq_btnPrimary:hover {
  opacity: .88;
}

._ri_16dhQq_btnDanger {
  border-color: var(--ri-danger);
  color: var(--ri-danger);
  background: none;
}

._ri_16dhQq_btnDanger:hover {
  background: #ef444424;
}

._ri_16dhQq_btnIcon {
  justify-content: center;
  align-items: center;
  padding: 4px 6px;
  display: inline-flex;
}

._ri_16dhQq_btnGhost {
  background: none;
  border-color: #0000;
}

._ri_16dhQq_btnGhost:hover {
  background: var(--ri-hover);
}

._ri_16dhQq_workbench {
  flex: 1;
  min-height: 0;
  display: flex;
}

._ri_16dhQq_explorer {
  border-right: 1px solid var(--ri-border, #333);
  flex-direction: column;
  flex: none;
  width: 220px;
  min-height: 0;
  display: flex;
}

._ri_16dhQq_explorerHeader {
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--ri-muted, #8a8a8a);
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  display: flex;
}

._ri_16dhQq_explorerHeader ._ri_16dhQq_spacer {
  flex: 1;
}

._ri_16dhQq_explorerBody {
  flex: 1;
  min-height: 0;
  padding: 4px 0;
  overflow: auto;
}

._ri_16dhQq_explorerPath {
  color: var(--ri-muted, #8a8a8a);
  border-bottom: 1px solid var(--ri-border, #2a2a2a);
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
  flex: none;
  padding: 2px 10px;
  font-size: 11px;
  overflow: hidden;
}

._ri_16dhQq_explorerEmpty {
  color: var(--ri-muted, #8a8a8a);
  padding: 12px 10px;
  font-size: 12px;
}

._ri_16dhQq_treeRow {
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  align-items: center;
  gap: 4px;
  padding: 2px 6px 2px 0;
  font-size: 12.5px;
  display: flex;
}

._ri_16dhQq_treeRow:hover {
  background: var(--ri-hover);
}

._ri_16dhQq_treeRow._ri_16dhQq_selected {
  background: var(--ri-accent-soft);
}

._ri_16dhQq_treeIndent {
  flex: none;
  width: 14px;
  height: 1px;
}

._ri_16dhQq_treeCaret {
  text-align: center;
  width: 14px;
  color: var(--ri-muted, #8a8a8a);
  flex: none;
  font-size: 10px;
}

._ri_16dhQq_treeCaret._ri_16dhQq_placeholder {
  visibility: hidden;
}

._ri_16dhQq_treeIcon {
  text-align: center;
  opacity: .9;
  flex: none;
  width: 16px;
}

._ri_16dhQq_treeName {
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

._ri_16dhQq_treeMeta {
  color: var(--ri-muted, #7a7a7a);
  flex: none;
  padding-right: 4px;
  font-size: 10.5px;
}

._ri_16dhQq_mainColumn {
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

._ri_16dhQq_tabBar {
  border-bottom: 1px solid var(--ri-border, #333);
  background: var(--ri-tabbar-bg, #252526);
  flex: none;
  align-items: stretch;
  display: flex;
  overflow-x: auto;
}

._ri_16dhQq_tab {
  border-right: 1px solid var(--ri-border, #333);
  cursor: pointer;
  white-space: nowrap;
  color: var(--ri-muted, #9a9a9a);
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 5px 12px;
  font-size: 12px;
  display: flex;
}

._ri_16dhQq_tab._ri_16dhQq_active {
  background: var(--ri-bg, #1e1e1e);
  color: var(--ri-fg, #d4d4d4);
}

._ri_16dhQq_tabName {
  text-overflow: ellipsis;
  overflow: hidden;
}

._ri_16dhQq_tabClose {
  color: inherit;
  cursor: pointer;
  background: none;
  border: none;
  border-radius: 3px;
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
}

._ri_16dhQq_tabClose:hover {
  background: var(--ri-hover);
}

._ri_16dhQq_tabDirty {
  color: #d8a13c;
}

._ri_16dhQq_editorArea {
  flex: 1;
  min-height: 0;
  position: relative;
}

._ri_16dhQq_editorArea > div, ._ri_16dhQq_editorArea > ._ri_16dhQq_cm-editor {
  height: 100%;
}

._ri_16dhQq_editorStatus {
  color: var(--ri-muted, #8a8a8a);
  pointer-events: none;
  z-index: 5;
  background: #00000059;
  border-radius: 8px;
  padding: 1px 8px;
  font-size: 11px;
  position: absolute;
  bottom: 6px;
  right: 8px;
}

._ri_16dhQq_editorStatus._ri_16dhQq_error {
  color: var(--ri-danger);
}

._ri_16dhQq_editorStatus._ri_16dhQq_ok {
  color: var(--ri-ok);
}

._ri_16dhQq_terminalWrap {
  border-top: 1px solid var(--ri-border, #333);
  background: var(--ri-bg);
  flex-direction: column;
  flex: none;
  display: flex;
}

._ri_16dhQq_terminalResize {
  cursor: ns-resize;
  background: none;
  flex: none;
  height: 4px;
}

._ri_16dhQq_terminalResize:hover, ._ri_16dhQq_terminalResize._ri_16dhQq_dragging {
  background: #50a0ff59;
}

._ri_16dhQq_terminalHeader {
  color: var(--ri-muted, #8a8a8a);
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  font-size: 11px;
  display: flex;
}

._ri_16dhQq_terminalBody {
  flex: none;
  height: 200px;
  padding: 0 4px 4px;
}

._ri_16dhQq_terminalBody ._ri_16dhQq_xterm {
  height: 100%;
}

._ri_16dhQq_terminalOverlay {
  height: 100%;
  color: var(--ri-muted, #8a8a8a);
  justify-content: center;
  align-items: center;
  font-size: 12px;
  display: flex;
}

._ri_16dhQq_hostList {
  flex-direction: column;
  flex: 1;
  gap: 6px;
  min-height: 0;
  padding: 8px;
  display: flex;
  overflow: auto;
}

._ri_16dhQq_hostCard {
  border: 1px solid var(--ri-border, #2f2f2f);
  background: var(--ri-card-bg, #252526);
  border-radius: 4px;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  display: flex;
}

._ri_16dhQq_hostCard:hover {
  border-color: var(--ri-accent);
}

._ri_16dhQq_hostMain {
  flex: 1;
  min-width: 0;
}

._ri_16dhQq_hostName {
  align-items: center;
  gap: 6px;
  font-weight: 600;
  display: flex;
}

._ri_16dhQq_hostAlias {
  text-overflow: ellipsis;
  overflow: hidden;
}

._ri_16dhQq_hostDetail {
  color: var(--ri-muted, #8a8a8a);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  overflow: hidden;
}

._ri_16dhQq_hostActions {
  flex: none;
  gap: 4px;
  display: flex;
}

._ri_16dhQq_envBadge {
  color: #6ab0ff;
  background: #50a0ff2e;
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
}

._ri_16dhQq_keyBadge {
  color: var(--ri-muted, #9a9a9a);
  background: #80808033;
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
}

._ri_16dhQq_overlay {
  z-index: 1000;
  background: #00000073;
  justify-content: center;
  align-items: center;
  display: flex;
  position: fixed;
  inset: 0;
}

._ri_16dhQq_dialog {
  border: 1px solid var(--ri-border, #444);
  background: var(--ri-card-bg, #252526);
  width: 460px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 80px);
  color: var(--ri-fg, #d4d4d4);
  border-radius: 8px;
  padding: 16px;
  overflow: auto;
  box-shadow: 0 8px 32px #00000080;
}

._ri_16dhQq_dialogTitle {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

._ri_16dhQq_formRow {
  flex-direction: column;
  gap: 3px;
  margin-bottom: 10px;
  display: flex;
}

._ri_16dhQq_formLabel {
  color: var(--ri-muted, #9a9a9a);
  font-size: 11.5px;
}

._ri_16dhQq_formInput {
  border: 1px solid var(--ri-border, #444);
  background: var(--ri-input-bg, #1e1e1e);
  color: inherit;
  font: inherit;
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 12.5px;
}

._ri_16dhQq_formInput:focus {
  border-color: #2d6fc3;
  outline: none;
}

._ri_16dhQq_formSelect {
  border: 1px solid var(--ri-border, #444);
  background: var(--ri-input-bg, #1e1e1e);
  color: inherit;
  font: inherit;
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 12.5px;
}

._ri_16dhQq_formRowInline {
  gap: 10px;
  display: flex;
}

._ri_16dhQq_formRowInline ._ri_16dhQq_formRow {
  flex: 1;
}

._ri_16dhQq_formActions {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
  display: flex;
}

._ri_16dhQq_formError {
  color: #e06c6c;
  margin-top: 8px;
  font-size: 12px;
}

._ri_16dhQq_statusBar {
  background: var(--ri-statusbar-bg, #4176e6);
  color: #fff;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 2px 10px;
  font-size: 11px;
  display: flex;
}

._ri_16dhQq_stateDot {
  border-radius: 50%;
  flex: none;
  width: 8px;
  height: 8px;
  display: inline-block;
}

._ri_16dhQq_stateDot._ri_16dhQq_stateConnected {
  background: var(--ri-ok);
}

._ri_16dhQq_stateDot._ri_16dhQq_stateConnecting {
  background: var(--ri-warn);
}

._ri_16dhQq_stateDot._ri_16dhQq_stateDisconnected {
  background: var(--ri-muted);
}

._ri_16dhQq_stateDot._ri_16dhQq_stateFailed {
  background: var(--ri-danger);
}

._ri_16dhQq_statusBtn {
  color: #fff;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  background: none;
  border: none;
  border-radius: 3px;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  display: inline-flex;
}

._ri_16dhQq_statusBtn:hover {
  background: #ffffff2e;
}

._ri_16dhQq_statusBtn:disabled {
  opacity: .6;
  cursor: default;
}

._ri_16dhQq_statusBar ._ri_16dhQq_hostSelect {
  color: #fff;
  background: #ffffff1f;
  border-color: #ffffff59;
  max-width: 180px;
}

._ri_16dhQq_statusItem {
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}`
/** Scoped class-name map (Lightning CSS CSS modules). */
export const panelClasses = {
  "tabHost": "_ri_16dhQq_tabHost",
  "editorStatus": "_ri_16dhQq_editorStatus",
  "toolbar": "_ri_16dhQq_toolbar",
  "formLabel": "_ri_16dhQq_formLabel",
  "hostMain": "_ri_16dhQq_hostMain",
  "treeMeta": "_ri_16dhQq_treeMeta",
  "welcomeText": "_ri_16dhQq_welcomeText",
  "mainColumn": "_ri_16dhQq_mainColumn",
  "active": "_ri_16dhQq_active",
  "terminalBody": "_ri_16dhQq_terminalBody",
  "hostList": "_ri_16dhQq_hostList",
  "entry": "_ri_16dhQq_entry",
  "errorText": "_ri_16dhQq_errorText",
  "error": "_ri_16dhQq_error",
  "btn": "_ri_16dhQq_btn",
  "statePill": "_ri_16dhQq_statePill",
  "spacer": "_ri_16dhQq_spacer",
  "stateConnecting": "_ri_16dhQq_stateConnecting",
  "entryIcon": "_ri_16dhQq_entryIcon",
  "terminalResize": "_ri_16dhQq_terminalResize",
  "placeholder": "_ri_16dhQq_placeholder",
  "treeIndent": "_ri_16dhQq_treeIndent",
  "stateConnected": "_ri_16dhQq_stateConnected",
  "workbench": "_ri_16dhQq_workbench",
  "hostAlias": "_ri_16dhQq_hostAlias",
  "dialog": "_ri_16dhQq_dialog",
  "tab": "_ri_16dhQq_tab",
  "dialogTitle": "_ri_16dhQq_dialogTitle",
  "stateDisconnected": "_ri_16dhQq_stateDisconnected",
  "btnPrimary": "_ri_16dhQq_btnPrimary",
  "terminalHeader": "_ri_16dhQq_terminalHeader",
  "ok": "_ri_16dhQq_ok",
  "explorerEmpty": "_ri_16dhQq_explorerEmpty",
  "tabDirty": "_ri_16dhQq_tabDirty",
  "explorerBody": "_ri_16dhQq_explorerBody",
  "tabName": "_ri_16dhQq_tabName",
  "hostSelect": "_ri_16dhQq_hostSelect",
  "view": "_ri_16dhQq_view",
  "terminalWrap": "_ri_16dhQq_terminalWrap",
  "hostName": "_ri_16dhQq_hostName",
  "btnGhost": "_ri_16dhQq_btnGhost",
  "treeRow": "_ri_16dhQq_treeRow",
  "explorer": "_ri_16dhQq_explorer",
  "btnIcon": "_ri_16dhQq_btnIcon",
  "terminalOverlay": "_ri_16dhQq_terminalOverlay",
  "welcomeHint": "_ri_16dhQq_welcomeHint",
  "hostDetail": "_ri_16dhQq_hostDetail",
  "hostCard": "_ri_16dhQq_hostCard",
  "formSelect": "_ri_16dhQq_formSelect",
  "btnDanger": "_ri_16dhQq_btnDanger",
  "formActions": "_ri_16dhQq_formActions",
  "stateDot": "_ri_16dhQq_stateDot",
  "statusItem": "_ri_16dhQq_statusItem",
  "welcomeIconWrap": "_ri_16dhQq_welcomeIconWrap",
  "stateFailed": "_ri_16dhQq_stateFailed",
  "toolbarTitle": "_ri_16dhQq_toolbarTitle",
  "welcomeActions": "_ri_16dhQq_welcomeActions",
  "statusBar": "_ri_16dhQq_statusBar",
  "entryLabel": "_ri_16dhQq_entryLabel",
  "treeIcon": "_ri_16dhQq_treeIcon",
  "selected": "_ri_16dhQq_selected",
  "overlay": "_ri_16dhQq_overlay",
  "hostActions": "_ri_16dhQq_hostActions",
  "treeName": "_ri_16dhQq_treeName",
  "xterm": "_ri_16dhQq_xterm",
  "envBadge": "_ri_16dhQq_envBadge",
  "panel": "_ri_16dhQq_panel",
  "treeCaret": "_ri_16dhQq_treeCaret",
  "formRowInline": "_ri_16dhQq_formRowInline",
  "formRow": "_ri_16dhQq_formRow",
  "cm-editor": "_ri_16dhQq_cm-editor",
  "dragging": "_ri_16dhQq_dragging",
  "welcomeTitle": "_ri_16dhQq_welcomeTitle",
  "formInput": "_ri_16dhQq_formInput",
  "explorerHeader": "_ri_16dhQq_explorerHeader",
  "statusBtn": "_ri_16dhQq_statusBtn",
  "tabClose": "_ri_16dhQq_tabClose",
  "keyBadge": "_ri_16dhQq_keyBadge",
  "tabBar": "_ri_16dhQq_tabBar",
  "editorArea": "_ri_16dhQq_editorArea",
  "welcome": "_ri_16dhQq_welcome",
  "formError": "_ri_16dhQq_formError",
  "explorerPath": "_ri_16dhQq_explorerPath"
}
/** Idempotent <style> injection (one tag per page). */
let panelCssInjected = false
export function ensurePanelCss(): void {
  if (panelCssInjected) return
  panelCssInjected = true
  const style = document.createElement('style')
  style.dataset.pluginCss = 'dsh-remote-ide/panel.module.css'
  style.textContent = panelCss
  document.head.appendChild(style)
}
