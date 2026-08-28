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
        desc('testConnection', ['hostId', 'cfg'], 'TestConnectionResult'),
        desc('listRemoteDir', ['hostId', 'path'], 'ListRemoteDirResult'),
        desc('mkdirRemote', ['hostId', 'path'], 'MkdirRemoteResult'),
        desc('removeRemote', ['hostId', 'path'], 'RemoveRemoteResult'),
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
      .dri-section { padding: 4px 6px 24px; color: var(--dsw-alias-label-primary, #1d1d1f); }
      .dri-section h2 { font-size: 20px; margin: 0 0 6px; font-weight: 700; letter-spacing: -0.01em; }
      .dri-intro { margin: 0 0 20px; font-size: 13px; color: var(--dsw-alias-label-secondary, #6e6e73); line-height: 1.6; }
      .dri-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
      .dri-error { color: var(--dsw-alias-state-error-primary, #d70015); font-size: 13px; margin: 0 0 12px; }
      .dri-empty { border: 1.5px dashed var(--dsw-alias-border-l2, #d2d2d7); border-radius: 16px; padding: 40px 20px;
        text-align: center; color: var(--dsw-alias-label-tertiary, #86868b); font-size: 13px; line-height: 1.7; }
      .dri-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
      .dri-card { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.07)); border-radius: 16px; padding: 14px 16px;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 88%, transparent);
        box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 6px 20px rgba(0,0,0,0.04);
        transition: transform 0.15s ease, box-shadow 0.15s ease; }
      .dri-card:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0,0,0,0.05), 0 10px 28px rgba(0,0,0,0.07); }
      .dri-cardHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .dri-cardTitle { font-size: 14px; font-weight: 600; letter-spacing: -0.005em; }
      .dri-cardSub { font-size: 12px; color: var(--dsw-alias-label-tertiary, #86868b); margin-top: 3px; font-family: var(--dsw-font-family, ui-monospace, SFMono-Regular, monospace); }
      .dri-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 10px; border-radius: 999px;
        background: color-mix(in srgb, var(--dsw-alias-label-secondary, #6e6e73) 8%, transparent);
        color: var(--dsw-alias-label-secondary, #6e6e73); font-weight: 500; }
      .dri-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%;
        background: currentColor; opacity: 0.6; }
      .dri-pill-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1d9d6e) 12%, transparent);
        color: var(--dsw-alias-state-success-primary, #1d9d6e); }
      .dri-actions { display: flex; gap: 8px; align-items: center; }
      .dri-btn { font-size: 12px; padding: 5px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
        background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 92%, transparent); color: var(--dsw-alias-label-primary, #1d1d1f);
        cursor: pointer; font-weight: 500; transition: background 0.15s ease, transform 0.1s ease; }
      .dri-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f5f5f7); }
      .dri-btn:active { transform: scale(0.97); }
      .dri-btn-primary { background: var(--dsw-alias-button-primary-fill, #0071e3); border-color: transparent;
        color: var(--dsw-alias-label-primary-foreground, #fff); box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
      .dri-btn-primary:hover { background: var(--dsw-alias-button-primary-hover, #0077ed); }
      .dri-btn-danger { color: var(--dsw-alias-state-error-primary, #d70015); border-color: transparent; background: transparent; }
      .dri-btn-danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d70015) 8%, transparent); }
      .dri-btn:disabled { opacity: 0.5; cursor: default; transform: none; }
      .dri-testResult { margin-top: 12px; font-size: 12px; padding: 9px 12px; border-radius: 12px; display: flex;
        justify-content: space-between; align-items: center; gap: 8px; }
      .dri-testOk { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1d9d6e) 10%, transparent);
        color: var(--dsw-alias-state-success-primary, #1d9d6e); }
      .dri-testFail { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d70015) 9%, transparent);
        color: var(--dsw-alias-state-error-primary, #d70015); }
      .dri-close { border: none; background: transparent; cursor: pointer; color: inherit; font-size: 14px; padding: 2px 4px;
        border-radius: 6px; opacity: 0.7; }
      .dri-close:hover { opacity: 1; background: rgba(0,0,0,0.05); }
      .dri-form { display: flex; flex-direction: column; gap: 14px; margin-top: 16px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.07)); border-radius: 16px; padding: 18px;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 88%, transparent);
        box-shadow: 0 6px 20px rgba(0,0,0,0.04); }
      .dri-field { display: flex; flex-direction: column; gap: 5px; }
      .dri-field label { font-size: 12px; color: var(--dsw-alias-label-secondary, #6e6e73); font-weight: 500; }
      .dri-field input, .dri-field select { font-size: 13px; padding: 8px 12px; border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
        background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1d1d1f);
        transition: border-color 0.15s ease, box-shadow 0.15s ease; outline: none; }
      .dri-field input:focus, .dri-field select:focus { border-color: var(--dsw-alias-brand-primary, #0071e3);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #0071e3) 18%, transparent); }
      .dri-pwWrap { position: relative; display: flex; align-items: center; }
      .dri-pwWrap input { width: 100%; padding-right: 34px; }
      .dri-eye { position: absolute; right: 6px; display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; border: none; background: transparent; cursor: pointer; border-radius: 6px;
        color: var(--dsw-alias-label-tertiary, #86868b); padding: 0; transition: color 0.15s ease, background 0.15s ease; }
      .dri-eye:hover { color: var(--dsw-alias-label-primary, #1d1d1f); background: var(--dsw-alias-interactive-bg-hover, #f5f5f7); }
      .dri-field .dri-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #86868b); }
      .dri-formActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .dri-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .dri-dirBrowser { margin-top: 16px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.07)); border-radius: 16px; padding: 18px;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 88%, transparent);
        box-shadow: 0 6px 20px rgba(0,0,0,0.04); }
      .dri-dirPath { font-family: var(--dsw-font-family, ui-monospace, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #6e6e73);
        margin: 10px 0; word-break: break-all; }
      .dri-dirList { max-height: 240px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06)); border-radius: 12px;
        padding: 4px; }
      .dri-dirRow { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; font-size: 13px;
        border-radius: 8px; cursor: pointer; transition: background 0.12s ease; }
      .dri-dirRow:hover { background: var(--dsw-alias-interactive-bg-hover, #f5f5f7); }
      .dri-dirRow .dri-dirSize { color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; }
      .dri-dirIcon { display: inline-flex; align-items: center; justify-content: center; width: 20px; margin-right: 6px;
        color: var(--dsw-alias-label-tertiary, #86868b); font-size: 12px; }
      .dri-dirDel { border: none; background: transparent; color: var(--dsw-alias-label-tertiary, #86868b); cursor: pointer;
        font-size: 14px; padding: 0 4px; border-radius: 6px; opacity: 0; transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease; }
      .dri-dirRow:hover .dri-dirDel { opacity: 1; }
      .dri-dirDel:hover { color: var(--dsw-alias-state-error-primary, #d70015); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d70015) 8%, transparent); }
      .dri-newDir { font-size: 13px; padding: 6px 12px; border-radius: 10px; flex: 1;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); background: var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-label-primary, #1d1d1f); outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
      .dri-newDir:focus { border-color: var(--dsw-alias-brand-primary, #0071e3);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #0071e3) 18%, transparent); }
      .dri-dirActions { margin-top: 12px; display: flex; align-items: center; gap: 10px; }
      .dri-created { margin-top: 12px; font-size: 12px; padding: 10px 12px; border-radius: 12px;
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1d9d6e) 10%, transparent);
        color: var(--dsw-alias-state-success-primary, #1d9d6e); word-break: break-all; line-height: 1.7; }
      .dri-wsRow { font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.05)); }
      .dri-wsRow code { font-family: var(--dsw-font-family, ui-monospace, monospace); }
      .dri-code { font-family: var(--dsw-font-family, ui-monospace, monospace); }
      .dri-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #86868b); }
      .dri-subtitle { font-size: 14px; font-weight: 600; margin: 28px 0 4px; letter-spacing: -0.005em; }
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
      const authLabel = host.authType === 'password' ? (hasSecret ? '密码已保存' : '密码') : '密钥'
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
      const [showPw, setShowPw] = useState(false)
      const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
      const submit = () => {
        if (!form.host.trim()) { setError('主机名/IP 必填'); return }
        if (!form.user.trim()) { setError('登录用户必填'); return }
        const port = Number.parseInt(form.port, 10)
        if (!Number.isInteger(port) || port < 1 || port > 65535) { setError('端口须为 1–65535'); return }
        if (form.authType === 'key' && !form.privateKeyPath.trim()) {
          setError('请填写私钥路径，或改用密码认证'); return
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
      // 小眼睛：显示/隐藏密码（纯 SVG，无 emoji）。
      const eyeIcon = h('svg', {
        width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, showPw
        ? h('g', null,
            h('path', { d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' }),
            h('path', { d: 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19' }),
            h('line', { x1: 1, y1: 1, x2: 23, y2: 23 }))
        : h('g', null,
            h('path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z' }),
            h('circle', { cx: 12, cy: 12, r: 3 })))
      const passwordInput = h('div', { className: 'dri-pwWrap' },
        h('input', {
          type: showPw ? 'text' : 'password',
          value: form.password, onChange: set('password'), placeholder: '••••••••',
          autoComplete: 'new-password',
        }),
        h('button', {
          type: 'button', className: 'dri-eye', onClick: () => setShowPw(!showPw),
          'aria-label': showPw ? '隐藏密码' : '显示密码', title: showPw ? '隐藏密码' : '显示密码',
        }, eyeIcon))
      const field = (label, child) => h('div', { className: 'dri-field' }, h('label', null, label), child)
      return h('div', { className: 'dri-form', role: 'form' },
        error ? h('p', { className: 'dri-error', role: 'alert' }, error) : null,
        h('div', { className: 'dri-grid2' },
          field('显示名', h('input', { value: form.name, onChange: set('name'), placeholder: '例如 web-1 生产机' })),
          field('主机名 / IP *', h('input', { value: form.host, onChange: set('host'), placeholder: '1.2.3.4 或 host.example.com' })),
          field('端口', h('input', { value: form.port, onChange: set('port'), placeholder: '22' })),
          field('登录用户 *', h('input', { value: form.user, onChange: set('user'), placeholder: 'root' }))),
        field('认证方式', h('select', { value: form.authType, onChange: set('authType') },
          h('option', { value: 'key' }, '密钥认证（私钥路径；留空走 ssh-agent）'),
          h('option', { value: 'password' }, '密码认证（账号密码登录）'))),
        form.authType === 'key'
          ? field('私钥路径', h('input', { value: form.privateKeyPath, onChange: set('privateKeyPath'), placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519 或 ~/.ssh/id_ed25519' }))
          : field('密码' + (initial ? '（留空保持已保存）' : ''), passwordInput),
        h('div', { className: 'dri-formActions' },
          h('button', { className: 'dri-btn', onClick: onCancel }, '取消'),
          h('button', { className: 'dri-btn dri-btn-primary', onClick: submit }, '保存')))
    }

    /** 设置页区块：主机列表 + 添加/编辑 + 远端目录 → 工作区。 */
    function SshHostsSection(props) {
      const { useSshHosts, load, saveHost, deleteHost, testConnection, listRemoteDir, mkdirRemote, removeRemote, createPlaceholder, reloadPlaceholders } = props
      const state = useSshHosts((snap) => snap)
      const [editing, setEditing] = useState(null)
      const [pendingDelete, setPendingDelete] = useState(null)

      useEffect(() => { void load() }, [load])

      if (state.status === 'error') {
        return h('div', { className: 'dri-section' },
          h('p', { className: 'dri-error', role: 'alert' }, state.error),
          h('button', { className: 'dri-btn', onClick: load }, '重试'))
      }
      const hosts = Object.values(state.hosts)

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

        h('h2', { className: 'dri-subtitle' }, '远端工作区'),
        h('p', { className: 'dri-intro' },
          '选择一个已配置主机，浏览远端目录并绑定为 DSH 工作区；绑定后到「选择工作区」里选返回的本地路径即可。'),

        h(DirBrowserSection, {
          hosts,
          placeholders: state.placeholders,
          listRemoteDir, mkdirRemote, removeRemote, createPlaceholder, reloadPlaceholders,
        }),
      )
    }

    /** 远端目录浏览器：浏览 / 新建 / 删除 / 绑定工作区。 */
    function DirBrowserSection({ hosts, placeholders, listRemoteDir, mkdirRemote, removeRemote, createPlaceholder, reloadPlaceholders }) {
      const [browser, setBrowser] = useState(null) // { hostId, path, entries, loading }
      const [created, setCreated] = useState(null)
      const [newDir, setNewDir] = useState('')

      const browseTo = async (hostId, nextPath) => {
        setBrowser({ hostId, path: nextPath, entries: [], loading: true })
        const res = await listRemoteDir(hostId, nextPath)
        setBrowser({ hostId, path: nextPath, entries: unwrap(res, []) || [], loading: false })
      }

      const createDir = async () => {
        const name = newDir.trim()
        if (!name || !browser) return
        const next = (browser.path === '/' ? '' : browser.path) + '/' + name
        const res = await mkdirRemote(browser.hostId, next)
        if (!res || res.ok !== true) store.set({ error: resError(res, '新建文件夹失败') })
        else { setNewDir(''); await browseTo(browser.hostId, browser.path) }
      }

      const doRemove = async (hostId, fullPath) => {
        if (!window.confirm('删除远端 ' + fullPath + '？\n（仅删除空目录或文件，非空目录请先清空）')) return
        const res = await removeRemote(hostId, fullPath)
        if (!res || res.ok !== true) store.set({ error: resError(res, '删除失败') })
        else if (browser) await browseTo(hostId, browser.path)
      }

      const bindWorkspace = async () => {
        const res = await createPlaceholder(browser.hostId, browser.path)
        const value = unwrap(res, null)
        if (value) { setCreated({ localPath: value.localPath }); await reloadPlaceholders() }
        else store.set({ error: resError(res, '创建工作区失败') })
      }

      if (hosts.length === 0) return null

      const dirRows = []
      if (browser) {
        if (browser.path !== '/') {
          dirRows.push(h('div', { key: '..', className: 'dri-dirRow', onClick: () => {
            const parent = browser.path.split('/').slice(0, -1).join('/') || '/'
            void browseTo(browser.hostId, parent)
          } }, h('span', null, '..')))
        }
        for (const e of browser.entries || []) {
          if (e.type === 'dir') {
            dirRows.push(h('div', { key: e.name, className: 'dri-dirRow', onClick: () => {
              const next = (browser.path === '/' ? '' : browser.path) + '/' + e.name
              void browseTo(browser.hostId, next)
            } },
              h('span', null, h('span', { className: 'dri-dirIcon' }, '›'), e.name),
              h('button', { className: 'dri-dirDel', 'aria-label': '删除 ' + e.name, onClick: (ev) => {
                ev.stopPropagation()
                void doRemove(browser.hostId, (browser.path === '/' ? '' : browser.path) + '/' + e.name)
              } }, '×')))
          } else {
            dirRows.push(h('div', { key: e.name, className: 'dri-dirRow', style: { cursor: 'default' } },
              h('span', null, h('span', { className: 'dri-dirIcon', style: { opacity: 0.35 } }, '·'), e.name),
              h('span', { className: 'dri-dirSize' }, String(e.size))))
          }
        }
        if (browser.loading) dirRows.push(h('div', { key: 'loading', className: 'dri-dirRow', style: { cursor: 'default' } }, '加载中…'))
      }

      return h('div', { className: 'dri-dirBrowser' },
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
          h('div', { className: 'dri-dirList' }, ...dirRows),
          h('div', { className: 'dri-dirActions' },
            h('button', { className: 'dri-btn dri-btn-primary', onClick: bindWorkspace }, '将当前目录绑定为工作区'),
            h('span', { className: 'dri-hint' }, browser.loading ? '连接中…' : ((browser.entries || []).length + ' 项'))),
          h('div', { className: 'dri-dirActions', style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.05))', paddingTop: 12 } },
            h('input', {
              className: 'dri-newDir', value: newDir, placeholder: '新建文件夹名称…',
              onChange: (e) => setNewDir(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void createDir() } },
            }),
            h('button', { className: 'dri-btn', disabled: !newDir.trim(), onClick: createDir }, '新建文件夹'),
            h('span', { className: 'dri-hint' }, '删除按钮在目录行右侧')),
          created ? h('div', { className: 'dri-created' },
            '工作区已创建，本地占位路径：', h('br', null),
            h('code', { className: 'dri-code' }, created.localPath),
            h('br', null), '它已出现在 DSH「选择工作区」列表中（会话即在该主机该目录运行）。') : null,
          placeholders.length > 0 ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'dri-hint', style: { marginBottom: 4 } }, '已绑定：'),
            placeholders.map((w) => h('div', { key: w.localPath, className: 'dri-wsRow' },
              h('code', { className: 'dri-code' }, w.hostId),
              ' → ',
              h('code', { className: 'dri-code' }, w.remotePath)))) : null,
        ) : null,
      )
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
      const testConnection = (host) => remote().testConnection(host.id, {
        host: host.host, port: host.port, user: host.user,
        authType: host.authType || 'key', privateKeyPath: host.privateKeyPath,
      })
      const listRemoteDir = (hostId, path) => remote().listRemoteDir(hostId, path)
      const mkdirRemote = (hostId, path) => remote().mkdirRemote(hostId, path)
      const removeRemote = (hostId, path) => remote().removeRemote(hostId, path)
      const createPlaceholder = (hostId, remotePath) => remote().createPlaceholder(hostId, remotePath)

      ctx.effect(() => {
        const disposers = [ctx.remote.$on('settings/document-updated', () => { void refresh() })]
        return () => { for (const dispose of disposers) dispose() }
      }, 'dsh-remote-ide: settings refresh')

      const injected = () => ({
        hooks: { sshHosts: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
        load, reloadPlaceholders, saveHost, deleteHost, testConnection,
        listRemoteDir, mkdirRemote, removeRemote, createPlaceholder,
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
