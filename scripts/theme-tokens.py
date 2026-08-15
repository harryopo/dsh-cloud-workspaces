"""Replace hardcoded colors with DSW token aliases and drop the light-mode block."""
import io
import re

path = r'D:\ai\deepseek harness\linux ide\src\client\panel\panel.module.css'
with io.open(path, 'r', encoding='utf-8') as f:
    css = f.read()

# 1. Drop the @media (prefers-color-scheme: light) block entirely (DSW tokens
#    switch with the shell theme via data-ds-dark-theme instead).
css = re.sub(r'/\* light theme overrides \*/\s*@media \(prefers-color-scheme: light\) \{.*?\n\}\n', '', css, flags=re.S)

# 2. State colors -> tokens.
css = css.replace('.stateConnected {\n  color: #4ec46c;\n}', '.stateConnected {\n  color: var(--ri-ok);\n}')
css = css.replace('.stateConnecting {\n  color: #d8a13c;\n}', '.stateConnecting {\n  color: var(--ri-warn);\n}')
css = css.replace('.stateFailed {\n  color: #e06c6c;\n}', '.stateFailed {\n  color: var(--ri-danger);\n}')
css = css.replace('.stateDisconnected {\n  color: #9a9a9a;\n}', '.stateDisconnected {\n  color: var(--ri-muted);\n}')
css = css.replace('color: #e06c6c;\n  font-size: 11px;', 'color: var(--ri-danger);\n  font-size: 11px;')
css = css.replace('.editorStatus.error {\n  color: #e06c6c;\n}', '.editorStatus.error {\n  color: var(--ri-danger);\n}')
css = css.replace('.editorStatus.ok {\n  color: #4ec46c;\n}', '.editorStatus.ok {\n  color: var(--ri-ok);\n}')

# 3. Buttons -> accent/danger tokens.
css = css.replace('''.btnPrimary {
  border-color: #2d6fc3;
  background: #1f4d8f;
  color: #fff;
}

.btnPrimary:hover {
  background: #2a5fb0;
}''', '''.btnPrimary {
  border-color: var(--ri-accent);
  background: var(--ri-accent);
  color: #fff;
}

.btnPrimary:hover {
  opacity: 0.88;
}''')
css = css.replace('''.btnDanger {
  border-color: #a33;
  background: #7a2626;
  color: #fff;
}

.btnDanger:hover {
  background: #993030;
}''', '''.btnDanger {
  border-color: var(--ri-danger);
  background: transparent;
  color: var(--ri-danger);
}

.btnDanger:hover {
  background: rgba(239, 68, 68, 0.14);
}''')

# 4. Hover / selection / entry highlight -> tokens.
css = css.replace('.entry:hover {\n  background: rgba(128, 128, 128, 0.12);\n}', '.entry:hover {\n  background: var(--ri-hover);\n}')
css = css.replace('.entry[data-active=\'true\'] {\n  background: rgba(80, 160, 255, 0.16);\n  color: #4da3ff;\n}', '.entry[data-active=\'true\'] {\n  background: var(--ri-accent-soft);\n  color: var(--ri-accent);\n}')
css = css.replace('.treeRow:hover {\n  background: rgba(128, 128, 128, 0.12);\n}', '.treeRow:hover {\n  background: var(--ri-hover);\n}')
css = css.replace('.treeRow.selected {\n  background: rgba(80, 160, 255, 0.18);\n}', '.treeRow.selected {\n  background: var(--ri-accent-soft);\n}')
css = css.replace('.btn:hover {\n  background: rgba(128, 128, 128, 0.18);\n}', '.btn:hover {\n  background: var(--ri-hover);\n}')
css = css.replace('.btnGhost:hover {\n  background: rgba(128, 128, 128, 0.15);\n}', '.btnGhost:hover {\n  background: var(--ri-hover);\n}')
css = css.replace('.tabClose:hover {\n  background: rgba(128, 128, 128, 0.3);\n}', '.tabClose:hover {\n  background: var(--ri-hover);\n}')
css = css.replace('.hostCard:hover {\n  border-color: #4a6a8a;\n}', '.hostCard:hover {\n  border-color: var(--ri-accent);\n}')

# 5. Terminal / welcome accents.
css = css.replace('.terminalWrap {\n  border-top: 1px solid var(--ri-border, #333);\n  background: #1e1e1e;', '.terminalWrap {\n  border-top: 1px solid var(--ri-border, #333);\n  background: var(--ri-bg);')
css = css.replace('.welcomeIconWrap {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 64px;\n  height: 64px;\n  border-radius: 50%;\n  background: rgba(0, 122, 204, 0.12);\n  border: 1px solid rgba(0, 122, 204, 0.28);\n  color: #4da3ff;\n  margin-bottom: 8px;\n}', '.welcomeIconWrap {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 64px;\n  height: 64px;\n  border-radius: 50%;\n  background: var(--ri-accent-soft);\n  border: 1px solid var(--ri-accent);\n  color: var(--ri-accent);\n  margin-bottom: 8px;\n}')

# 6. Status bar uses the alias already (statusbar-bg); keep the explicit blue
#    only as fallback — leave as-is.

with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(css)
print('done')
