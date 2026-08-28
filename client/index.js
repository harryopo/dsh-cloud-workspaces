/**
 * dsh-remote-ide — client half: SSH 主机设置卡片（设置页 → 「SSH 连接」）。
 *
 * 官方 client 插件形态（window.__ModuleLoader__.load({id, factory(require)})，
 * factory 自包含，require 只解析 web 模块映射：react 等；**不使用 JSX**——
 * web 端 ModuleLoader 直接执行 bundle，JSX 需自行转 createElement）。
 * - 注册 settings.section slot（id 'ssh-hosts'）——DSH 设置页的自定义区块；
 * - 主机 CRUD / 测试连接 / 远端目录浏览 / 占位工作区创建全部经 Typert
 *   remote（ctx.remote.ssh-remote.<method>，host 半 SshRemoteService 实现）；
 * - 样式只用 --dsw-alias-* design token，不引入额外 UI 库。
 *
 * 与 src/typert.ts 的端点参数名（wire）必须一一对应：
 *   listHosts() / saveHost(id, patch) / deleteHost(id) /
 *   testConnection(cfg) / listRemoteDir(hostId, path) /
 *   createPlaceholder(hostId, remotePath) / listPlaceholders()
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-ide',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    // ------------------------------------------------------------ typert

    const REMOTE_PACKAGE = 'dsh-remote-ide'
    const REMOTE_NAMESPACE = 'ssh-remote'

    function passthroughSchema(typeSymbol) {
      return { mode: 'strict', typeSymbol, schema: { parse: (value) => value } }
    }
    function desc(method, params, resultType) {
      return {
        id: REMOTE_PACKAGE + '#' + REMOTE_NAMESPACE + '/' + method,
        service: REMOTE_NAMESPACE,
        namespace: REMOTE_NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        parameters: params.map((name) => ({
          name, wire: name, source: 'json',
          codec: passthroughSchema(REMOTE_PACKAGE + '#' + name),
        })),
        result: passthroughSchema(REMOTE_PACKAGE + '#' + resultType),
      }
    }
    const CLIENT_TYPERT_REMOTE = {
      package: REMOTE_PACKAGE,
      descriptors: [
        desc('listHosts', [], 'ListHostsResult'),
        desc('saveHost', ['id', 'patch'], 'SaveHostResult'),
        desc('deleteHost', ['id'], 'DeleteHostResult'),
        desc('testConnection', ['cfg'], 'TestConnectionResult'),
        desc('listRemoteDir', ['hostId', 'path'], 'ListRemoteDirResult'),
        desc('createPlaceholder', ['hostId', 'remotePath'], 'CreatePlaceholderResult'),
        desc('listPlaceholders', [], 'ListPlaceholdersResult'),
      ],
    }

    function unwrap(res, fallback) {
      if (res && typeof res === 'object' && res.ok === true) return res.value
      return fallback
    }
    function resError(res, fallback) {
      const e = res && typeof res === 'object' ? res.error : null
      return (e && typeof e === 'object' && typeof e.message === 'string' && e.message) || fallback
    }

    // --------------------------------------------------------------- store

    function createStore() {
      let snap = {
        status: 'loading', // loading | ready | error
        hosts: {}, // id → redacted host
        secrets: {}, // id → password set flag
        error: null,
        placeholders: [],
      }
      const subs = new Set()
      return {
        getSnapshot: () => snap,
        subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } },
        set(patch) { snap = { ...snap, ...patch }; for (const fn of subs) fn() },
      }
    }
    const store = createStore()

    // ---------------------------------------------------------------- css

    const CSS = `
      .dri-section { padding: 4px 2px; color: var(--dsw-alias-label-primary, #333); }
      .dri-section h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
      .dri-intro { margin: 0 0 14px; font-size: 13px; color: var(--dsw-alias-label-secondary, #666); line-height: 1.5; }
      .dri-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .dri-error { color: var(--dsw-alias-state-error-primary, #d03050); font-size: 13px; margin: 0 0 10px; }
      .dri-empty { border: 1px dashed var(--dsw-alias-border-l2, #ccc); border-radius: 8px; padding: 28px 16px;
        text-align: center; color: var(--dsw-alias-label-secondary, #666); font-size: 13px; }
      .dri-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
      .dri-card { border: 1px solid var(--dsw-alias-border-l1, #e5e5e5); border-radius: 10px; padding: 12px 14px;
        background: var(--dsw-alias-bg-layer-1, #fff); }
      .dri-cardHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .dri-cardTitle { font-size: 14px; font-weight: 600; }
      .dri-cardSub { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); margin-top: 2px; font-family: var(--dsw-font-family, monospace); }
      .dri-pill { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l2, #ccc); color: var(--dsw-alias-label-secondary, #666); }
      .dri-actions { display: flex; gap: 6px; align-items: center; }
      .dri-btn { font-size: 12px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #ccc);
        background: transparent; color: var(--dsw-alias-label-primary, #333); cursor: pointer; }
      .dri-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f0f0f0); }
      .dri-btn-primary { background: var(--dsw-alias-button-primary-fill, #4d6bfe); border-color: transparent;
        color: var(--dsw-alias-label-primary-foreground, #fff); }
      .dri-btn-primary:hover { background: var(--dsw-alias-button-primary-hover, #3a56d6); }
      .dri-btn-danger { color: var(--dsw-alias-state-error-primary, #d03050); }
      .dri-btn:disabled { opacity: 0.55; cursor: default; }
      .dri-testResult { margin-top: 10px; font-size: 12px; padding: 8px 10px; border-radius: 6px; display: flex;
        justify-content: space-between; align-items: center; }
      .dri-testOk { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ba471) 10%, transparent);
        color: var(--dsw-alias-state-success-primary, #2ba471); }
      .dri-testFail { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d03050) 10%, transparent);
        color: var(--dsw-alias-state-error-primary, #d03050); }
      .dri-close { border: none; background: transparent; cursor: pointer; color: inherit; font-size: 14px; }
      .dri-form { display: flex; flex-direction: column; gap: 10px; margin-top: 12px;
        border: 1px solid var(--dsw-alias-border-l1, #e5e5e5); border-radius: 10px; padding: 14px; }
      .dri-field { display: flex; flex-direction: column; gap: 4px; }
      .dri-field label { font-size: 12px; color: var(--dsw-alias-label-secondary, #666); }
      .dri-field input, .dri-field select { font-size: 13px; padding: 6px 8px; border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l2, #ccc); background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #333); }
      .dri-field .dri-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); }
      .dri-formActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .dri-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .dri-dirBrowser { margin-top: 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e5e5); border-radius: 10px; padding: 14px; }
      .dri-dirPath { font-family: var(--dsw-font-family, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #666);
        margin: 8px 0; word-break: break-all; }
      .dri-dirList { max-height: 220px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1, #e5e5e5); border-radius: 6px; }
      .dri-dirRow { display: flex; justify-content: space-between; align-items: center; padding: 5px 10px; font-size: 13px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, #f0f0f0); cursor: pointer; }
      .dri-dirRow:hover { background: var(--dsw-alias-interactive-bg-hover, #f6f6f6); }
      .dri-dirRow .dri-dirSize { color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; }
      .dri-dirActions { margin-top: 10px; display: flex; align-items: center; gap: 8px; }
      .dri-created { margin-top: 10px; font-size: 12px; padding: 8px 10px; border-radius: 6px;
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ba471) 10%, transparent);
        color: var(--dsw-alias-state-success-primary, #2ba471); word-break: break-all; }
      .dri-wsRow { font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #f0f0f0); }
      .dri-wsRow code { font-family: var(--dsw-font-family, monospace); }
      .dri-code { font-family: var(--dsw-font-family, monospace); }
      .dri-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
    `

    // ---------------------------------------------------------- component

    /** 主机行：名称/地址/认证 + 测试/编辑/删除。 */
    function HostRow({ host, hasSecret, onTest, onEdit, onDelete }) {
      const [testing, setTesting] = useState(false)
      const [result, setResult] = useState(null) // { ok, message } | null
      const run = useCallback(async () => {
        setTesting(true); setResult(null)
        const res = await onTest()
        const value = unwrap(res, null)
        setResult(value && value.ok
          ? { ok: true, message: '连接成功（' + value.latencyMs + 'ms）' }
          : { ok: false, message: (value && value.error) || resError(res, '连接失败') })
        setTesting(false)
      }, [onTest])
      const authLabel = host.authType === 'password' ? (hasSecret ? '口令 ✓' : '口令') : '密钥'
      const children = [
        h('div', { className: 'dri-cardHead' },
          h('div', null,
            h('div', { className: 'dri-cardTitle' }, host.name || host.id),
            h('div', { className: 'dri-cardSub' }, host.user + '@' + host.host + ':' + host.port)),
          h('div', { className: 'dri-actions' },
            h('span', { className: 'dri-pill' }, authLabel),
            h('button', { className: 'dri-btn', disabled: testing, onClick: run }, testing ? '测试中…' : '测试'),
            h('button', { className: 'dri-btn', onClick: onEdit }, '编辑'),
            h('button', { className: 'dri-btn dri-btn-danger', onClick: onDelete }, '删除'))),
      ]
      if (result) {
        children.push(h('div', { className: 'dri-testResult ' + (result.ok ? 'dri-testOk' : 'dri-testFail') },
          h('span', null, result.message),
          h('button', { className: 'dri-close', onClick: () => setResult(null), 'aria-label': '关闭' }, '×')))
      }
      return h('li', { className: 'dri-card' }, ...children)
    }

    /** 主机表单（添加/编辑）。 */
    function HostForm({ initial, onCancel, onSave }) {
      const [form, setForm] = useState(initial || {
        name: '', host: '', port: '22', user: '', authType: 'key', privateKeyPath: '', password: '',
      })
      const [error, setError] = useState(null)
      const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
      const submit = () => {
        if (!form.host.trim()) { setError('主机名/IP 必填'); return }
        if (!form.user.trim()) { setError('登录用户必填'); return }
        const port = Number.parseInt(form.port, 10)
        if (!Number.isInteger(port) || port < 1 || port > 65535) { setError('端口须为 1–65535'); return }
        if (form.authType === 'key' && !form.privateKeyPath.trim()) {
          setError('请填写私钥路径，或改用口令认证'); return
        }
        onSave({
          name: form.name.trim() || undefined,
          host: form.host.trim(),
          port,
          user: form.user.trim(),
          authType: form.authType,
          privateKeyPath: form.authType === 'key' ? form.privateKeyPath.trim() : undefined,
          password: form.authType === 'password' ? form.password : undefined,
        })
      }
      const field = (label, child) => h('div', { className: 'dri-field' }, h('label', null, label), child)
      return h('div', { className: 'dri-form', role: 'form' },
        error ? h('p', { className: 'dri-error', role: 'alert' }, error) : null,
        h('div', { className: 'dri-grid2' },
          field('显示名', h('input', { value: form.name, onChange: set('name'), placeholder: '例如 web-1 生产机' })),
          field('主机名 / IP *', h('input', { value: form.host, onChange: set('host'), placeholder: '1.2.3.4 或 host.example.com' })),
          field('端口', h('input', { value: form.port, onChange: set('port'), placeholder: '22' })),
          field('登录用户 *', h('input', { value: form.user, onChange: set('user'), placeholder: 'root' }))),
        field('认证方式', h('select', { value: form.authType, onChange: set('authType') },
          h('option', { value: 'key' }, '密钥（私钥路径；留空走 ssh-agent）'),
          h('option', { value: 'password' }, '口令'))),
        form.authType === 'key'
          ? field('私钥路径', h('input', { value: form.privateKeyPath, onChange: set('privateKeyPath'), placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519 或 ~/.ssh/id_ed25519' }))
          : field('口令' + (initial ? '（留空保持已保存）' : ''), h('input', { type: 'password', value: form.password, onChange: set('password'), placeholder: '••••••••' })),
        h('div', { className: 'dri-formActions' },
          h('button', { className: 'dri-btn', onClick: onCancel }, '取消'),
          h('button', { className: 'dri-btn dri-btn-primary', onClick: submit }, '保存')))
    }

    /** 设置页区块：主机列表 + 添加/编辑 + 远端目录 → 工作区。 */
    function SshHostsSection(props) {
      const { useSshHosts, load, saveHost, deleteHost, testConnection, listRemoteDir, createPlaceholder, reloadPlaceholders } = props
      const state = useSshHosts((snap) => snap)
      const [editing, setEditing] = useState(null)
      const [pendingDelete, setPendingDelete] = useState(null)
      const [browser, setBrowser] = useState(null) // { hostId, path, entries, loading }
      const [created, setCreated] = useState(null)

      useEffect(() => { void load() }, [load])

      if (state.status === 'error') {
        return h('div', { className: 'dri-section' },
          h('p', { className: 'dri-error', role: 'alert' }, state.error),
          h('button', { className: 'dri-btn', onClick: load }, '重试'))
      }
      const hosts = Object.values(state.hosts)

      const browseTo = async (hostId, nextPath) => {
        setBrowser({ hostId, path: nextPath, entries: [], loading: true })
        const res = await listRemoteDir(hostId, nextPath)
        setBrowser({ hostId, path: nextPath, entries: unwrap(res, []) || [], loading: false })
      }

      return h('div', { className: 'dri-section' },
        h('h2', null, 'SSH 连接'),
        h('p', { className: 'dri-intro' },
          '配置远程开发主机。保存后可在「服务器开发」模式中通过 ssh_workspace 把服务器目录绑定为工作区（或在本页「远端工作区」直接创建）；会话工作区落在占位目录时，文件 / 搜索 / 编辑 / 终端全部在该主机上执行。'),
        h('div', { className: 'dri-head' },
          state.error ? h('p', { className: 'dri-error', role: 'alert' }, state.error) : null,
          h('span', null),
          h('button', { className: 'dri-btn dri-btn-primary', onClick: () => setEditing({ mode: 'create' }) }, '+ 添加主机')),

        hosts.length === 0
          ? h('div', { className: 'dri-empty' }, '还没有配置主机。', h('br', null), '点击「+ 添加主机」开始。')
          : h('ul', { className: 'dri-cards' }, hosts.map((host) => h(HostRow, {
              key: host.id, host, hasSecret: !!state.secrets[host.id],
              onTest: () => testConnection(host),
              onEdit: () => setEditing({ mode: 'edit', host }),
              onDelete: () => setPendingDelete(host.id),
            }))),

        editing ? h(HostForm, {
          initial: editing.mode === 'edit' ? {
            name: editing.host.name || '', host: editing.host.host, port: String(editing.host.port),
            user: editing.host.user, authType: editing.host.authType || 'key',
            privateKeyPath: editing.host.privateKeyPath || '', password: '',
          } : null,
          onCancel: () => setEditing(null),
          onSave: async (patch) => {
            const id = editing.mode === 'edit' ? editing.host.id : (patch.name || patch.host || 'host').replace(/[^A-Za-z0-9._-]/g, '-')
            const res = await saveHost(id, patch)
            if (!res || res.ok !== true) store.set({ error: resError(res, '保存失败') })
            else { setEditing(null); await load() }
          },
        }) : null,

        pendingDelete ? h('div', { className: 'dri-testResult dri-testFail', role: 'alert' },
          h('span', null, '删除主机「' + (state.hosts[pendingDelete] ? (state.hosts[pendingDelete].name || pendingDelete) : pendingDelete) + '」？仅移除本机配置，远端不受影响。'),
          h('span', null,
            h('button', { className: 'dri-btn', onClick: () => setPendingDelete(null) }, '取消'),
            ' ',
            h('button', { className: 'dri-btn dri-btn-danger', onClick: async () => {
              await deleteHost(pendingDelete); setPendingDelete(null); await load()
            } }, '确认删除'))) : null,

        h('h2', { style: { marginTop: 22 } }, '远端工作区'),
        h('p', { className: 'dri-intro' },
          '选择一个已配置主机，浏览远端目录并绑定为 DSH 工作区；绑定后到「选择工作区」里选返回的本地路径即可。'),

        hosts.length === 0 ? null : h('div', { className: 'dri-dirBrowser' },
          h('div', { className: 'dri-field', style: { marginBottom: 8 } },
            h('label', null, '主机'),
            h('select', { value: browser ? browser.hostId : '', onChange: (e) => {
              const hostId = e.target.value
              if (hostId) void browseTo(hostId, '/')
              else setBrowser(null)
            } },
              h('option', { value: '' }, '选择主机…'),
              hosts.map((host) => h('option', { key: host.id, value: host.id }, host.name || host.id)))),
          browser ? h('div', null,
            h('div', { className: 'dri-dirPath' }, '当前目录：' + browser.path),
            h('div', { className: 'dri-dirList' },
              browser.path !== '/' ? h('div', { className: 'dri-dirRow', onClick: () => {
                const parent = browser.path.split('/').slice(0, -1).join('/') || '/'
                void browseTo(browser.hostId, parent)
              } }, h('span', null, '..')) : null,
              (browser.entries || []).filter((e) => e.type === 'dir').map((e) => h('div', { key: e.name, className: 'dri-dirRow', onClick: () => {
                const next = (browser.path === '/' ? '' : browser.path) + '/' + e.name
                void browseTo(browser.hostId, next)
              } }, h('span', null, '📁 ' + e.name))),
              (browser.entries || []).filter((e) => e.type === 'file').map((e) => h('div', { key: e.name, className: 'dri-dirRow', style: { cursor: 'default' } },
                h('span', null, e.name),
                h('span', { className: 'dri-dirSize' }, String(e.size)))),
              browser.loading ? h('div', { className: 'dri-dirRow', style: { cursor: 'default' } }, '加载中…') : null),
            h('div', { className: 'dri-dirActions' },
              h('button', { className: 'dri-btn dri-btn-primary', onClick: async () => {
                const res = await createPlaceholder(browser.hostId, browser.path)
                const value = unwrap(res, null)
                if (value) { setCreated({ localPath: value.localPath }); await reloadPlaceholders() }
                else store.set({ error: resError(res, '创建工作区失败') })
              } }, '将当前目录绑定为工作区'),
              h('span', { className: 'dri-hint' }, browser.loading ? '连接中…' : ((browser.entries || []).length + ' 项')))) : null,
          created ? h('div', { className: 'dri-created' },
            '工作区已创建，本地占位路径：', h('br', null),
            h('code', { className: 'dri-code' }, created.localPath),
            h('br', null), '在 DSH「选择工作区」中选中它，会话即在该主机该目录运行。') : null,
          state.placeholders.length > 0 ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'dri-hint', style: { marginBottom: 4 } }, '已绑定：'),
            state.placeholders.map((w) => h('div', { key: w.localPath, className: 'dri-wsRow' },
              h('code', { className: 'dri-code' }, w.hostId),
              ' → ',
              h('code', { className: 'dri-code' }, w.remotePath))),
          ) : null))
    }

    // -------------------------------------------------------------- apply

    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.dataset.pluginCss = 'dsh-remote-ide/client'
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-remote-ide: settings css')

      let mounted = false
      // namespace 服务 remote.ssh-remote：用 ctx.get 读取（无 inject 要求——
      // 直接 ctx.remote['ssh-remote'] 属性访问会被 cordis 的 inject 检查拒绝）。
      const remote = () => ctx.get('remote.ssh-remote')

      const refresh = async () => {
        if (!mounted) return
        const [hostsRes, phRes] = await Promise.all([
          remote().listHosts(),
          remote().listPlaceholders(),
        ])
        const value = unwrap(hostsRes, null)
        if (value) store.set({ status: 'ready', hosts: value.hosts || {}, secrets: value.secrets || {}, error: null })
        else store.set({ status: 'error', error: resError(hostsRes, '无法读取主机配置') })
        store.set({ placeholders: unwrap(phRes, []) || [] })
      }

      ctx.effect(async () => {
        const disposer = await ctx.remote.$mount(CLIENT_TYPERT_REMOTE)
        mounted = true
        await refresh()
        return disposer
      }, 'dsh-remote-ide: typert mount')

      const load = () => refresh()
      const reloadPlaceholders = async () => {
        if (!mounted) return
        store.set({ placeholders: unwrap(await remote().listPlaceholders(), []) || [] })
      }
      const saveHost = (id, patch) => remote().saveHost(id, patch)
      const deleteHost = (id) => remote().deleteHost(id)
      const testConnection = (host) => remote().testConnection({
        host: host.host, port: host.port, user: host.user,
        authType: host.authType || 'key', privateKeyPath: host.privateKeyPath,
      })
      const listRemoteDir = (hostId, path) => remote().listRemoteDir(hostId, path)
      const createPlaceholder = (hostId, remotePath) => remote().createPlaceholder(hostId, remotePath)

      ctx.effect(() => {
        const disposers = [ctx.remote.$on('settings/document-updated', () => { void refresh() })]
        return () => { for (const dispose of disposers) dispose() }
      }, 'dsh-remote-ide: settings refresh')

      const injected = () => ({
        hooks: { sshHosts: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
        load, reloadPlaceholders, saveHost, deleteHost, testConnection, listRemoteDir, createPlaceholder,
      })

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'ssh-hosts',
        order: 40,
        label: () => 'SSH 连接',
        locale: 'settings.ssh',
        inject: injected,
      }, SshHostsSection))
    }

    return { apply, inject: ['slots', 'connection', 'remote'] }
  },
})
