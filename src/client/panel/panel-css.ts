/**
 * Generated file — do not edit. Run `node scripts/build-css.mjs` after
 * editing src/client/panel/panel.module.css (wired into `pnpm build`).
 */
/** Scoped CSS text; inject once via ensurePanelCss(). */
export const panelCss = `._ri_16dhQq_view {
  flex-direction: column;
  height: 100%;
  min-height: 0;
  display: flex;
}

html[data-dsh-remote-ide-active] [data-pane="conversation"] > :not([data-dsh-remote-ide-view]), html[data-dsh-remote-ide-active] [class*="centerCol"] > :not([data-dsh-remote-ide-view]) {
  display: none !important;
}

html[data-dsh-remote-ide-active] [data-pane="conversation"], html[data-dsh-remote-ide-active] [class*="centerCol"] {
  overflow: hidden;
}

._ri_16dhQq_tabHost {
  flex-direction: column;
  height: 100%;
  min-height: 0;
  display: flex;
}

@media (width <= 520px) {
  ._ri_16dhQq_workbench {
    flex-direction: column;
  }

  ._ri_16dhQq_explorer {
    border-right: none;
    border-bottom: 1px solid var(--ri-border, #333);
    flex: none;
    width: auto;
    max-height: 40%;
  }

  ._ri_16dhQq_explorerBody {
    overflow-y: auto;
  }

  ._ri_16dhQq_toolbarTitle {
    display: none;
  }
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
  background: #8080801f;
}

._ri_16dhQq_entry[data-active="true"] {
  color: #4da3ff;
  background: #50a0ff29;
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
  flex-wrap: wrap;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  display: flex;
}

._ri_16dhQq_toolbarTitle {
  margin-right: 4px;
  font-weight: 600;
}

._ri_16dhQq_hostSelect {
  border: 1px solid var(--ri-border, #444);
  background: var(--ri-input-bg, #252526);
  min-width: 160px;
  max-width: 260px;
  color: inherit;
  font: inherit;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 12px;
}

._ri_16dhQq_statePill {
  white-space: nowrap;
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
}

._ri_16dhQq_stateConnected {
  color: #4ec46c;
  background: #23863640;
}

._ri_16dhQq_stateConnecting {
  color: #d8a13c;
  background: #d2992238;
}

._ri_16dhQq_stateDisconnected {
  color: #9a9a9a;
  background: #8080802e;
}

._ri_16dhQq_stateFailed {
  color: #e06c6c;
  background: #c83c3c38;
}

._ri_16dhQq_errorText {
  color: #e06c6c;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
  font-size: 11px;
  overflow: hidden;
}

._ri_16dhQq_spacer {
  flex: 1;
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
  background: #8080802e;
}

._ri_16dhQq_btn:disabled {
  opacity: .5;
  cursor: default;
}

._ri_16dhQq_btnPrimary {
  color: #fff;
  background: #1f4d8f;
  border-color: #2d6fc3;
}

._ri_16dhQq_btnPrimary:hover {
  background: #2a5fb0;
}

._ri_16dhQq_btnDanger {
  color: #fff;
  background: #7a2626;
  border-color: #a33;
}

._ri_16dhQq_btnDanger:hover {
  background: #993030;
}

._ri_16dhQq_btnGhost {
  background: none;
  border-color: #0000;
}

._ri_16dhQq_btnGhost:hover {
  background: #80808026;
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
  background: #8080801f;
}

._ri_16dhQq_treeRow._ri_16dhQq_selected {
  background: #50a0ff2e;
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
  background: #8080804d;
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
  color: #e06c6c;
}

._ri_16dhQq_editorStatus._ri_16dhQq_ok {
  color: #4ec46c;
}

._ri_16dhQq_terminalWrap {
  border-top: 1px solid var(--ri-border, #333);
  background: #1e1e1e;
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
  border: 1px solid var(--ri-border, #333);
  background: var(--ri-card-bg, #252526);
  border-radius: 6px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  display: flex;
}

._ri_16dhQq_hostCard:hover {
  border-color: #4a6a8a;
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
  border-top: 1px solid var(--ri-border, #333);
  color: var(--ri-muted, #8a8a8a);
  flex: none;
  align-items: center;
  gap: 12px;
  padding: 3px 10px;
  font-size: 11px;
  display: flex;
}

._ri_16dhQq_statusItem {
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

@media (prefers-color-scheme: light) {
  ._ri_16dhQq_panel {
    --ri-bg: #fff;
    --ri-fg: #1f1f1f;
    --ri-border: #d4d4d4;
    --ri-input-bg: #f5f5f5;
    --ri-card-bg: #fafafa;
    --ri-tabbar-bg: #f3f3f3;
    --ri-muted: #6f6f6f;
  }

  ._ri_16dhQq_terminalWrap, ._ri_16dhQq_editorArea {
    background: #fff;
  }

  ._ri_16dhQq_treeRow:hover {
    background: #0000000d;
  }

  ._ri_16dhQq_treeRow._ri_16dhQq_selected {
    background: #50a0ff24;
  }

  ._ri_16dhQq_stateConnected {
    background: #2386361f;
  }

  ._ri_16dhQq_stateConnecting {
    background: #d2992224;
  }

  ._ri_16dhQq_stateFailed {
    background: #c83c3c1f;
  }
}`
/** Scoped class-name map (Lightning CSS CSS modules). */
export const panelClasses = {
  "statusItem": "_ri_16dhQq_statusItem",
  "entry": "_ri_16dhQq_entry",
  "hostMain": "_ri_16dhQq_hostMain",
  "explorerPath": "_ri_16dhQq_explorerPath",
  "selected": "_ri_16dhQq_selected",
  "dialog": "_ri_16dhQq_dialog",
  "treeName": "_ri_16dhQq_treeName",
  "hostActions": "_ri_16dhQq_hostActions",
  "treeCaret": "_ri_16dhQq_treeCaret",
  "keyBadge": "_ri_16dhQq_keyBadge",
  "treeIcon": "_ri_16dhQq_treeIcon",
  "tab": "_ri_16dhQq_tab",
  "hostDetail": "_ri_16dhQq_hostDetail",
  "btnDanger": "_ri_16dhQq_btnDanger",
  "dragging": "_ri_16dhQq_dragging",
  "hostSelect": "_ri_16dhQq_hostSelect",
  "xterm": "_ri_16dhQq_xterm",
  "hostCard": "_ri_16dhQq_hostCard",
  "spacer": "_ri_16dhQq_spacer",
  "treeMeta": "_ri_16dhQq_treeMeta",
  "formRow": "_ri_16dhQq_formRow",
  "errorText": "_ri_16dhQq_errorText",
  "terminalOverlay": "_ri_16dhQq_terminalOverlay",
  "tabHost": "_ri_16dhQq_tabHost",
  "btn": "_ri_16dhQq_btn",
  "btnGhost": "_ri_16dhQq_btnGhost",
  "active": "_ri_16dhQq_active",
  "entryIcon": "_ri_16dhQq_entryIcon",
  "formError": "_ri_16dhQq_formError",
  "tabClose": "_ri_16dhQq_tabClose",
  "toolbar": "_ri_16dhQq_toolbar",
  "hostAlias": "_ri_16dhQq_hostAlias",
  "formSelect": "_ri_16dhQq_formSelect",
  "statusBar": "_ri_16dhQq_statusBar",
  "tabName": "_ri_16dhQq_tabName",
  "formRowInline": "_ri_16dhQq_formRowInline",
  "envBadge": "_ri_16dhQq_envBadge",
  "treeRow": "_ri_16dhQq_treeRow",
  "stateFailed": "_ri_16dhQq_stateFailed",
  "terminalResize": "_ri_16dhQq_terminalResize",
  "stateConnecting": "_ri_16dhQq_stateConnecting",
  "ok": "_ri_16dhQq_ok",
  "explorerBody": "_ri_16dhQq_explorerBody",
  "hostList": "_ri_16dhQq_hostList",
  "panel": "_ri_16dhQq_panel",
  "view": "_ri_16dhQq_view",
  "terminalBody": "_ri_16dhQq_terminalBody",
  "statePill": "_ri_16dhQq_statePill",
  "cm-editor": "_ri_16dhQq_cm-editor",
  "btnPrimary": "_ri_16dhQq_btnPrimary",
  "editorStatus": "_ri_16dhQq_editorStatus",
  "error": "_ri_16dhQq_error",
  "stateDisconnected": "_ri_16dhQq_stateDisconnected",
  "terminalWrap": "_ri_16dhQq_terminalWrap",
  "explorerEmpty": "_ri_16dhQq_explorerEmpty",
  "formLabel": "_ri_16dhQq_formLabel",
  "tabBar": "_ri_16dhQq_tabBar",
  "toolbarTitle": "_ri_16dhQq_toolbarTitle",
  "stateConnected": "_ri_16dhQq_stateConnected",
  "tabDirty": "_ri_16dhQq_tabDirty",
  "formActions": "_ri_16dhQq_formActions",
  "editorArea": "_ri_16dhQq_editorArea",
  "entryLabel": "_ri_16dhQq_entryLabel",
  "treeIndent": "_ri_16dhQq_treeIndent",
  "hostName": "_ri_16dhQq_hostName",
  "formInput": "_ri_16dhQq_formInput",
  "workbench": "_ri_16dhQq_workbench",
  "explorerHeader": "_ri_16dhQq_explorerHeader",
  "terminalHeader": "_ri_16dhQq_terminalHeader",
  "explorer": "_ri_16dhQq_explorer",
  "overlay": "_ri_16dhQq_overlay",
  "placeholder": "_ri_16dhQq_placeholder",
  "dialogTitle": "_ri_16dhQq_dialogTitle",
  "mainColumn": "_ri_16dhQq_mainColumn"
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
