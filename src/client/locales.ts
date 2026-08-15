/**
 * dsh-remote-ide locale dictionaries (zh + en). The key interface is merged
 * into the DSH locale map in index.ts.
 */

/** All user-facing strings of the remote-IDE plugin. */
export type RemoteIdeKey = {
  'entry.label': string
  'entry.tooltip': string
  'panel.title': string
  'panel.empty': string
  'panel.noHosts': string
  'panel.connect': string
  'panel.disconnect': string
  'panel.connecting': string
  'panel.connected': string
  'panel.failed': string
  'panel.disconnected': string
  'panel.workspace': string
  'panel.home': string
  'panel.hint': string
  'hosts.title': string
  'hosts.add': string
  'hosts.edit': string
  'hosts.delete': string
  'hosts.deleteConfirm': string
  'hosts.test': string
  'hosts.testing': string
  'hosts.import': string
  'hosts.importResult': string
  'hosts.search': string
  'host.form.titleNew': string
  'host.form.titleEdit': string
  'host.form.alias': string
  'host.form.host': string
  'host.form.port': string
  'host.form.user': string
  'host.form.authKind': string
  'host.form.password': string
  'host.form.keyPath': string
  'host.form.passphrase': string
  'host.form.proxyJump': string
  'host.form.description': string
  'host.form.tags': string
  'host.form.save': string
  'host.form.cancel': string
  'host.form.required': string
  'explorer.title': string
  'explorer.empty': string
  'explorer.loading': string
  'explorer.error': string
  'explorer.refresh': string
  'explorer.newFile': string
  'explorer.newFolder': string
  'explorer.rename': string
  'explorer.delete': string
  'explorer.deleteConfirm': string
  'editor.title': string
  'editor.saving': string
  'editor.saved': string
  'editor.saveError': string
  'editor.readError': string
  'editor.truncated': string
  'editor.dirty': string
  'terminal.title': string
  'terminal.connecting': string
  'terminal.exited': string
  'terminal.newTab': string
  'terminal.close': string
  'common.close': string
  'common.cancel': string
  'common.confirm': string
  'common.ok': string
  'common.yes': string
  'common.no': string
  'common.untitled': string
}

export const zh: RemoteIdeKey = {
  'entry.label': '远程 IDE',
  'entry.tooltip': 'SSH 远程 IDE：远程文件、编辑与终端',
  'panel.title': '远程 IDE',
  'panel.empty': '尚未连接任何服务器。先在「主机」页配置 SSH 主机。',
  'panel.noHosts': '还没有 SSH 主机。点击「添加」或从 ~/.ssh/config 导入。',
  'panel.connect': '连接',
  'panel.disconnect': '断开',
  'panel.connecting': '连接中…',
  'panel.connected': '已连接',
  'panel.failed': '连接失败',
  'panel.disconnected': '未连接',
  'panel.workspace': '远程工作区',
  'panel.home': '主目录',
  'panel.hint': '连接后即可浏览远程文件、在线编辑并打开 SSH 终端',
  'hosts.title': 'SSH 主机',
  'hosts.add': '添加主机',
  'hosts.edit': '编辑',
  'hosts.delete': '删除',
  'hosts.deleteConfirm': '确定删除主机 {alias} 吗？',
  'hosts.test': '测试连接',
  'hosts.testing': '测试中…',
  'hosts.import': '从 ~/.ssh/config 导入',
  'hosts.importResult': '导入完成：解析 {parsed} 项，新增 {added} 项，跳过 {skipped} 项',
  'hosts.search': '搜索主机…',
  'host.form.titleNew': '添加 SSH 主机',
  'host.form.titleEdit': '编辑 SSH 主机',
  'host.form.alias': '别名',
  'host.form.host': '主机地址',
  'host.form.port': '端口',
  'host.form.user': '用户名',
  'host.form.authKind': '认证方式',
  'host.form.password': '密码',
  'host.form.keyPath': '私钥路径',
  'host.form.passphrase': '私钥口令',
  'host.form.proxyJump': '跳板机（别名，逗号分隔）',
  'host.form.description': '备注',
  'host.form.tags': '标签（逗号分隔）',
  'host.form.save': '保存',
  'host.form.cancel': '取消',
  'host.form.required': '必填',
  'explorer.title': '远程文件',
  'explorer.empty': '（空目录）',
  'explorer.loading': '加载中…',
  'explorer.error': '加载失败',
  'explorer.refresh': '刷新',
  'explorer.newFile': '新建文件',
  'explorer.newFolder': '新建文件夹',
  'explorer.rename': '重命名',
  'explorer.delete': '删除',
  'explorer.deleteConfirm': '确定删除 {path} 吗？此操作不可恢复。',
  'editor.title': '编辑器',
  'editor.saving': '保存中…',
  'editor.saved': '已保存',
  'editor.saveError': '保存失败',
  'editor.readError': '读取失败',
  'editor.truncated': '（文件超过大小上限，仅显示前 2MB）',
  'editor.dirty': '●',
  'terminal.title': '远程终端',
  'terminal.connecting': '正在打开远程终端…',
  'terminal.exited': '终端已退出（{code}）',
  'terminal.newTab': '新终端',
  'terminal.close': '关闭终端',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.ok': '确定',
  'common.yes': '是',
  'common.no': '否',
  'common.untitled': '未命名',
}

export const en: RemoteIdeKey = {
  'entry.label': 'Remote IDE',
  'entry.tooltip': 'SSH remote IDE: remote files, editor and terminal',
  'panel.title': 'Remote IDE',
  'panel.empty': 'Not connected. Configure an SSH host in the Hosts tab first.',
  'panel.noHosts': 'No SSH hosts yet. Add one or import from ~/.ssh/config.',
  'panel.connect': 'Connect',
  'panel.disconnect': 'Disconnect',
  'panel.connecting': 'Connecting…',
  'panel.connected': 'Connected',
  'panel.failed': 'Connection failed',
  'panel.disconnected': 'Disconnected',
  'panel.workspace': 'Remote workspace',
  'panel.home': 'Home',
  'panel.hint': 'Connect to browse remote files, edit them online, and open an SSH terminal',
  'hosts.title': 'SSH Hosts',
  'hosts.add': 'Add host',
  'hosts.edit': 'Edit',
  'hosts.delete': 'Delete',
  'hosts.deleteConfirm': 'Delete host {alias}?',
  'hosts.test': 'Test connection',
  'hosts.testing': 'Testing…',
  'hosts.import': 'Import from ~/.ssh/config',
  'hosts.importResult': 'Imported: {parsed} parsed, {added} added, {skipped} skipped',
  'hosts.search': 'Search hosts…',
  'host.form.titleNew': 'Add SSH host',
  'host.form.titleEdit': 'Edit SSH host',
  'host.form.alias': 'Alias',
  'host.form.host': 'Host',
  'host.form.port': 'Port',
  'host.form.user': 'User',
  'host.form.authKind': 'Auth',
  'host.form.password': 'Password',
  'host.form.keyPath': 'Private key path',
  'host.form.passphrase': 'Key passphrase',
  'host.form.proxyJump': 'Jump hosts (aliases, comma-separated)',
  'host.form.description': 'Description',
  'host.form.tags': 'Tags (comma-separated)',
  'host.form.save': 'Save',
  'host.form.cancel': 'Cancel',
  'host.form.required': 'required',
  'explorer.title': 'Remote Files',
  'explorer.empty': '(empty)',
  'explorer.loading': 'Loading…',
  'explorer.error': 'Failed to load',
  'explorer.refresh': 'Refresh',
  'explorer.newFile': 'New file',
  'explorer.newFolder': 'New folder',
  'explorer.rename': 'Rename',
  'explorer.delete': 'Delete',
  'explorer.deleteConfirm': 'Delete {path}? This cannot be undone.',
  'editor.title': 'Editor',
  'editor.saving': 'Saving…',
  'editor.saved': 'Saved',
  'editor.saveError': 'Save failed',
  'editor.readError': 'Failed to read',
  'editor.truncated': '(file exceeds the size limit; showing the first 2MB)',
  'editor.dirty': '●',
  'terminal.title': 'Remote Terminal',
  'terminal.connecting': 'Opening remote terminal…',
  'terminal.exited': 'Terminal exited ({code})',
  'terminal.newTab': 'New terminal',
  'terminal.close': 'Close terminal',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.ok': 'OK',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.untitled': 'Untitled',
}

/** Interpolate {name} placeholders in a dictionary entry. */
export function interpolate(dictionary: Record<string, string>, key: string, values?: Record<string, string | number>): string {
  const template = dictionary[key] ?? key
  if (values === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}

/** All dictionaries by language tag. */
export const dictionaries: Record<'zh' | 'en', RemoteIdeKey> = { zh, en }
