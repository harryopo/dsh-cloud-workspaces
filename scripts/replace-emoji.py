"""Replace emoji glyphs with SVG icon components and add imports."""
import io

root = r'D:\ai\deepseek harness\linux ide\src\client'

# file -> list of (old, new)
EDITS = {
    'panel/RemoteExplorer.tsx': [
        ("<span className={css.treeIcon}>{row.entry.type === 'dir' ? '📁' : '📄'}</span>",
         "<span className={css.treeIcon}>{row.entry.type === 'dir' ? <FolderIcon size={12} /> : <FileIcon size={12} />}</span>"),
        ("          ↻\n", "          <RefreshIcon size={12} />\n"),
        ("          +f\n", "          <PlusIcon size={12} />\n"),
        ("          +d\n", "          <PlusIcon size={12} />\n"),
        ("                ? (row.expanded ? '▾' : row.loading ? '…' : '▸')\n",
         "                ? (row.expanded ? <ChevronDownIcon size={10} /> : row.loading ? <SpinnerIcon size={10} /> : <ChevronRightIcon size={10} />)\n"),
        ("                    ✎\n", "                    <PencilIcon size={11} />\n"),
        ("                    🗑\n", "                    <TrashIcon size={11} />\n"),
        ("import type { RemoteDirEntry } from '../../protocol'",
         "import type { RemoteDirEntry } from '../../protocol'\nimport {\n  ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon,\n  PencilIcon, PlusIcon, RefreshIcon, SpinnerIcon, TrashIcon,\n} from './icons'"),
    ],
    'panel/SshPanel.tsx': [
        ("{host.auth === 'key' ? '🔑' : '🔒'}", "{host.auth === 'key' ? <KeyIcon size={10} /> : <LockIcon size={10} />}"),
        ("<div className={css.welcomeIcon}>🖥️</div>", "<div className={css.welcomeIcon}><MonitorIcon size={36} /></div>"),
        ("import { basename } from './helpers'",
         "import { basename } from './helpers'\nimport { KeyIcon, LockIcon, MonitorIcon } from './icons'"),
    ],
    'panel/RemoteEditor.tsx': [
        ("          💾 {t('host.form.save')}", "          <SaveIcon size={12} /> {t('host.form.save')}"),
        ("import { basename } from './helpers'",
         "import { basename } from './helpers'\nimport { SaveIcon } from './icons'"),
    ],
    'panel/RemoteTerminal.tsx': [
        ("        <span>⛶ {t('terminal.title')} #{id}</span>", "        <span><TerminalIcon size={12} /> {t('terminal.title')} #{id}</span>"),
        ("          ✕\n", "          <CloseIcon size={11} />\n"),
        ("import { xtermCss } from './xterm.css'",
         "import { xtermCss } from './xterm.css'\nimport { CloseIcon, TerminalIcon } from './icons'"),
    ],
    'better-sidebar.ts': [
        ("      icon: createElement('span', { style: { fontSize: 14 } }, '🖥️'),",
         "      icon: createElement(MonitorIcon),"),
        ("import { panelClasses as css } from './panel/panel-css'",
         "import { panelClasses as css } from './panel/panel-css'\nimport { MonitorIcon } from './panel/icons'"),
    ],
}

for rel, edits in EDITS.items():
    path = root.replace('\\', '/') + '/' + rel
    with io.open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content
    for old, new in edits:
        if old not in content:
            print(f'WARN not found in {rel}: {old[:60]!r}')
        content = content.replace(old, new)
    if content != original:
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(content)
        print('updated:', rel)
