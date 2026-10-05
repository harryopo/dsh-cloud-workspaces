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
 *   testConnection(hostId, cfg) / listRemoteDir(hostId, path) /
 *   mkdirRemote(hostId, path) / removeRemote(hostId, path) /
 *   createPlaceholder(hostId, remotePath) / listPlaceholders()
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-workspaces', // must equal the package name (loader contract)
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    // ------------------------------------------------------------ typert

    const REMOTE_PACKAGE = 'dsh-remote-ide' // typert descriptor prefix — protocol constant, keep in sync with src/typert.ts
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
    /**
     * 错误转字符串：只取 message（叠一层 stack 首行）。绝不把 error 对象丢进
     * console —— 它可能挂着主机配置/连接上下文，整对象 dump 等于泄进浏览器。
     */
    function errText(value) {
      if (value === null || value === undefined) return 'unknown error'
      if (typeof value === 'string') return value
      if (typeof value.message === 'string' && value.message) {
        const stack = typeof value.stack === 'string' ? value.stack : ''
        const first = stack.split('\n')[0]
        return first && first.indexOf(value.message) !== -1 ? first : value.message
      }
      try { return String(value) } catch { return 'unprintable error' }
    }
    /** typert 调用超时保护：宿主侧挂起时给出可见错误，而不是无限转圈（卡退观感）。 */
    function withTimeout(promise, ms, label) {
      const guarded = Promise.resolve(promise)
      guarded.catch(() => {}) // 落败方的 rejection 不作为 unhandled 抛出
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' 超时（请检查服务器是否可达）')), ms)
      })
      return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer))
    }

    /**
     * 由显示名/主机派生唯一 id：同名主机此前会撞上同一 id 互相覆盖
     * （用户数据静默丢失）。已存在时追加数字后缀。
     */
    function slugId(base) {
      const slug = String(base || 'host').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'host'
      const existing = store.getSnapshot().hosts
      if (!existing[slug]) return slug
      let n = 2
      while (existing[slug + '-' + n]) n += 1
      return slug + '-' + n
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

    // 语义层：全部指向宿主 --dsw-* token。不写死 Apple 浅色 fallback——token
    // 缺失时宁可继承宿主，也让明色主题成对翻转（bg 变白时 fg 自动变深）。
    // 挂在两个根上：设置区块与 fixed 定位的工作区选择器（后者不是前者的后代）。
    const CSS = `
      .dri-section, .dri-pickerOverlay {
        --dri-surface:   var(--dsw-alias-bg-layer-1);
        --dri-surface-2: var(--dsw-alias-bg-layer-2);
        --dri-border:    var(--dsw-alias-border-l1);
        --dri-border-2:  var(--dsw-alias-border-l2);
        --dri-fg:        var(--dsw-alias-label-primary);
        --dri-fg-2:      var(--dsw-alias-label-secondary);
        --dri-fg-3:      var(--dsw-alias-label-tertiary);
        --dri-hover:     var(--dsw-alias-interactive-bg-hover);
        --dri-accent:    var(--dsw-alias-brand-primary);
        --dri-danger:    var(--dsw-alias-state-error-primary);
        --dri-ok:        var(--dsw-alias-state-success-primary);
        --dri-mono:      ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        color: var(--dri-fg);
      }
      .dri-section h2 { font-size: 18px; margin: 0 0 6px; font-weight: 600; letter-spacing: -0.01em; }
      .dri-intro { margin: 0 0 16px; font-size: 12px; color: var(--dri-fg-2); line-height: 1.6; }
      .dri-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
      .dri-error { color: var(--dri-danger); font-size: 12px; margin: 0 0 12px; }
      .dri-empty { border: 1px dashed var(--dri-border-2); border-radius: 12px; padding: 32px 20px;
        text-align: center; color: var(--dri-fg-3); font-size: 12px; line-height: 1.7; }

      .dri-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .dri-card { border: 1px solid var(--dri-border); border-radius: 12px; padding: 12px 14px;
        background: var(--dri-surface); transition: border-color 0.15s ease; }
      .dri-card:hover { border-color: var(--dri-border-2); }
      .dri-cardHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .dri-cardTitle { font-size: 14px; font-weight: 600; }
      /* 主机地址用比例字体（与宿主一致）；等宽只留给真实路径/代码。 */
      .dri-cardSub { font-size: 12px; color: var(--dri-fg-3); margin-top: 2px; }

      .dri-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 9px;
        border-radius: 999px; border: 1px solid var(--dri-border); background: var(--dri-surface-2);
        color: var(--dri-fg-2); font-weight: 500; white-space: nowrap; }
      .dri-pill::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
      .dri-pill-ok { border-color: transparent; color: var(--dri-ok); }

      .dri-actions { display: flex; gap: 6px; align-items: center; }

      /* 按钮走宿主 ghost 风：深底浅字 + 1px 边，主按钮靠字重与更亮的边分层。
         不用 button-primary-fill（浅色实心）——明色主题下会翻成白底白字。 */
      .dri-btn { font-size: 12px; font-weight: 500; padding: 5px 12px; border-radius: 8px;
        border: 1px solid var(--dri-border-2); background: var(--dri-surface-2);
        color: var(--dri-fg); cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease; }
      .dri-btn:hover { background: var(--dri-hover); }
      .dri-btn:focus-visible { outline: 2px solid var(--dri-accent); outline-offset: 2px; }
      .dri-btn:disabled { opacity: 0.45; cursor: default; }
      .dri-btn-primary { font-weight: 600; border-color: var(--dsw-alias-border-l3, var(--dri-border-2)); }
      .dri-btn-danger { color: var(--dri-danger); border-color: transparent; background: transparent; }
      .dri-btn-danger:hover { background: color-mix(in srgb, var(--dri-danger) 12%, transparent); }

      /* tab 语义：选中用 ghost-active + inset ring（对齐宿主 nav），不占用主按钮。 */
      .dri-tab { font-size: 13px; font-weight: 500; padding: 6px 14px; border-radius: 8px; cursor: pointer;
        border: 1px solid transparent; background: transparent; color: var(--dri-fg-2);
        transition: background 0.15s ease, color 0.15s ease; }
      .dri-tab:hover { background: var(--dri-hover); color: var(--dri-fg); }
      .dri-tab-active { background: var(--dsw-alias-button-ghost-active-fill, var(--dri-surface-2));
        color: var(--dri-fg); box-shadow: inset 0 0 0 1px var(--dri-border-2); }
      .dri-tab-active:hover { background: var(--dsw-alias-button-ghost-active-hover, var(--dri-hover)); }

      .dri-testResult { margin-top: 10px; font-size: 12px; padding: 8px 10px; border-radius: 8px;
        display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .dri-testOk { background: color-mix(in srgb, var(--dri-ok) 12%, transparent); color: var(--dri-ok); }
      .dri-testFail { background: color-mix(in srgb, var(--dri-danger) 12%, transparent); color: var(--dri-danger); }
      .dri-close { border: none; background: transparent; cursor: pointer; color: inherit; font-size: 15px;
        padding: 2px 6px; border-radius: 6px; opacity: 0.7; line-height: 1; }
      .dri-close:hover { opacity: 1; background: var(--dri-hover); }

      .dri-form { display: flex; flex-direction: column; gap: 12px; margin-top: 14px;
        border: 1px solid var(--dri-border); border-radius: 12px; padding: 16px; background: var(--dri-surface); }
      .dri-field { display: flex; flex-direction: column; gap: 5px; }
      .dri-field label { font-size: 12px; color: var(--dri-fg-2); font-weight: 500; }
      .dri-field input, .dri-field select { font-size: 13px; padding: 7px 10px; border-radius: 8px;
        border: 1px solid var(--dri-border-2); background: var(--dsw-alias-bg-base);
        color: var(--dri-fg); transition: border-color 0.15s ease, box-shadow 0.15s ease; outline: none; }
      .dri-field input:focus, .dri-field select:focus { border-color: var(--dri-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dri-accent) 18%, transparent); }
      .dri-pwWrap { position: relative; display: flex; align-items: center; }
      .dri-pwWrap input { width: 100%; padding-right: 34px; }
      .dri-eye { position: absolute; right: 6px; display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; border: none; background: transparent; cursor: pointer; border-radius: 6px;
        color: var(--dri-fg-3); padding: 0; transition: color 0.15s ease, background 0.15s ease; }
      .dri-eye:hover { color: var(--dri-fg); background: var(--dri-hover); }
      .dri-field .dri-hint { font-size: 11px; color: var(--dri-fg-3); }
      .dri-formActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
      .dri-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

      .dri-dirBrowser { margin-top: 14px; border: 1px solid var(--dri-border); border-radius: 12px;
        padding: 16px; background: var(--dri-surface); }
      .dri-dirPath { font-family: var(--dri-mono); font-size: 12px; color: var(--dri-fg-2);
        margin: 8px 0; word-break: break-all; }
      .dri-dirList { max-height: 240px; overflow: auto; border: 1px solid var(--dri-border);
        border-radius: 8px; padding: 3px; }
      .dri-dirRow { display: flex; justify-content: space-between; align-items: center; gap: 8px;
        padding: 6px 9px; font-size: 13px; border-radius: 6px; cursor: pointer;
        transition: background 0.12s ease; }
      .dri-dirRow:hover { background: var(--dri-hover); }
      /* 远端目录名不可信：只作文本截断显示，绝不拼进任何属性。 */
      .dri-dirName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .dri-dirRow .dri-dirSize { color: var(--dri-fg-3); font-size: 12px; flex-shrink: 0; }
      .dri-dirIcon { display: inline-flex; align-items: center; justify-content: center; width: 16px;
        margin-right: 5px; color: var(--dri-fg-3); font-size: 12px; flex-shrink: 0; }
      .dri-dirDel { border: none; background: transparent; color: var(--dri-fg-3); cursor: pointer;
        font-size: 14px; padding: 0 4px; border-radius: 6px; opacity: 0; flex-shrink: 0;
        transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease; }
      .dri-dirRow:hover .dri-dirDel { opacity: 1; }
      .dri-dirDel:hover { color: var(--dri-danger);
        background: color-mix(in srgb, var(--dri-danger) 10%, transparent); }
      .dri-newDir { font-size: 13px; padding: 6px 10px; border-radius: 8px; flex: 1; min-width: 0;
        border: 1px solid var(--dri-border-2); background: var(--dsw-alias-bg-base);
        color: var(--dri-fg); outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
      .dri-newDir:focus { border-color: var(--dri-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dri-accent) 18%, transparent); }
      .dri-dirActions { margin-top: 10px; display: flex; align-items: center; gap: 8px; }
      .dri-created { margin-top: 10px; font-size: 12px; padding: 9px 11px; border-radius: 8px;
        background: color-mix(in srgb, var(--dri-ok) 12%, transparent); color: var(--dri-ok);
        word-break: break-all; line-height: 1.7; }
      .dri-wsRow { font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--dri-border); }
      .dri-wsRow code { font-family: var(--dri-mono); }
      .dri-code { font-family: var(--dri-mono); }
      .dri-hint { font-size: 12px; color: var(--dri-fg-3); }
      /* 子分区标题：与主标题拉开权重差（主 18/600，子 13/600 + 次级色）。
         元素是 h2，需与上面的 .dri-section h2 同等特指度才不被覆盖。 */
      .dri-section h2.dri-subtitle, .dri-picker h2.dri-subtitle { font-size: 13px; font-weight: 600;
        color: var(--dri-fg-2); margin: 24px 0 4px; letter-spacing: 0.01em; }

      .dri-pickerOverlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center;
        justify-content: center; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4)); }
      .dri-picker { width: min(520px, calc(100vw - 48px)); max-height: min(560px, calc(100vh - 64px));
        overflow: auto; border-radius: 16px; padding: 18px 20px 14px; color: var(--dri-fg);
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dri-border-2);
        box-shadow: 0 24px 60px rgba(0,0,0,0.28); }
      .dri-pickerHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .dri-tabs { display: flex; gap: 4px; }
      .dri-pickerBody { display: flex; flex-direction: column; gap: 4px; }
      .dri-pickLocal { font-size: 13px; padding: 10px 16px; border-radius: 8px; align-self: flex-start; }
      .dri-pickerFoot { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dri-border); }

      /* 危险操作确认框（替换原生 window.confirm）。路径为远端不可信输入，
         仅作文本节点渲染 + break-all 防超长撑破布局。 */
      .dri-confirm { width: min(420px, calc(100vw - 48px)); }
      .dri-confirmTitle { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
      .dri-confirmBody { font-size: 13px; color: var(--dri-fg-2); line-height: 1.7; margin: 0 0 4px; }
      .dri-confirmPath { font-family: var(--dri-mono); font-size: 12px; color: var(--dri-fg);
        background: var(--dri-surface-2); border: 1px solid var(--dri-border); border-radius: 8px;
        padding: 8px 10px; margin: 8px 0 12px; word-break: break-all; }
    `

    // ---------------------------------------------------------- component

    /**
     * 危险操作确认框（替换原生 window.confirm）。
     *
     * 安全：`detail` 来自远端（不可信输入），只能作为 children 文本节点交给
     * React 转义——本文件禁止 innerHTML / 模板拼 HTML（见文件头纪律）。
     * 删除不可逆，故打开时把焦点放到确认键，Escape 关闭时焦点不外泄。
     */
    function ConfirmDialog({ title, body, detail, confirmLabel, danger, onConfirm, onCancel }) {
      const confirmRef = useRef(null)
      const cancelRef = useRef(null)

      useEffect(() => {
        if (confirmRef.current) confirmRef.current.focus()
        else if (cancelRef.current) cancelRef.current.focus()
      }, [])

      useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
          // 焦点困在框内：模态未确认前不应能 Tab 到背景
          if (e.key === 'Tab') {
            const nodes = [confirmRef.current, cancelRef.current].filter(Boolean)
            if (nodes.length === 0) return
            const idx = nodes.indexOf(document.activeElement)
            const next = nodes[(idx + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length]
            if (next) { e.preventDefault(); next.focus() }
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onCancel])

      return h('div', { className: 'dri-pickerOverlay', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { className: 'dri-picker dri-confirm' },
          h('h2', { className: 'dri-confirmTitle' }, title),
          h('p', { className: 'dri-confirmBody' }, body),
          detail ? h('div', { className: 'dri-confirmPath' }, detail) : null,
          h('div', { className: 'dri-formActions' },
            h('button', { type: 'button', ref: cancelRef, className: 'dri-btn', onClick: onCancel }, '取消'),
            h('button', {
              type: 'button', ref: confirmRef,
              className: 'dri-btn' + (danger ? ' dri-btn-danger' : ' dri-btn-primary'),
              onClick: onConfirm,
            }, confirmLabel))))
    }

    /** 主机行：名称/地址/认证 + 测试/编辑/删除。 */
    function HostRow({ host, hasSecret, onTest, onEdit, onDelete }) {
      const [testing, setTesting] = useState(false)
      const [result, setResult] = useState(null) // { ok, message } | null
      const run = useCallback(async () => {
        setTesting(true); setResult(null)
        try {
          const res = await onTest()
          const value = unwrap(res, null)
          setResult(value && value.ok
            ? { ok: true, message: '连接成功（' + value.latencyMs + 'ms）' }
            : { ok: false, message: (value && value.error) || resError(res, '连接失败') })
        } catch (error) {
          setResult({ ok: false, message: errText(error) })
        }
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
          '配置远程开发主机，之后在「添加工作区」里选「云端（SSH）」即可使用。'),
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
            const id = editing.mode === 'edit' ? editing.host.id : slugId(patch.name || patch.host)
            let res
            try {
              res = await saveHost(id, patch)
            } catch (error) {
              res = { ok: false, error: { message: errText(error) } }
            }
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
              try {
                await deleteHost(pendingDelete); setPendingDelete(null); await load()
              } catch (error) {
                store.set({ error: errText(error) })
              }
            } }, '确认删除'))) : null,

        h('h2', { className: 'dri-subtitle' }, '远端工作区'),
        h('p', { className: 'dri-intro' }, '浏览服务器目录，一键绑定为工作区。'),

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
      const [pendingRemove, setPendingRemove] = useState(null) // { hostId, fullPath } 待确认删除
      const [removing, setRemoving] = useState(false)
      const seq = useRef(0) // 浏览请求序号：乱序返回不覆盖最新目录

      const fail = (res, fallback) => { store.set({ error: resError(res, fallback) }) }

      const browseTo = async (hostId, nextPath) => {
        const my = ++seq.current
        setBrowser({ hostId, path: nextPath, entries: [], loading: true })
        let res
        try {
          res = await withTimeout(listRemoteDir(hostId, nextPath), 20_000, '读取远端目录')
        } catch (error) {
          res = { ok: false, error: { message: errText(error) } }
        }
        if (my !== seq.current) return
        setBrowser({ hostId, path: nextPath, entries: unwrap(res, []) || [], loading: false })
        if (!res || res.ok !== true) fail(res, '读取远端目录失败')
      }

      const createDir = async () => {
        const name = newDir.trim()
        if (!name || !browser) return
        const next = (browser.path === '/' ? '' : browser.path) + '/' + name
        try {
          const res = await withTimeout(mkdirRemote(browser.hostId, next), 20_000, '新建文件夹')
          if (!res || res.ok !== true) fail(res, '新建文件夹失败')
          else { setNewDir(''); await browseTo(browser.hostId, browser.path) }
        } catch (error) {
          store.set({ error: errText(error) })
        }
      }

      const doRemove = async (hostId, fullPath) => {
        setPendingRemove({ hostId, fullPath })
      }

      const confirmRemove = async () => {
        const target = pendingRemove
        if (!target || removing) return
        setRemoving(true)
        try {
          const res = await withTimeout(removeRemote(target.hostId, target.fullPath), 20_000, '删除')
          if (!res || res.ok !== true) fail(res, '删除失败')
          else if (browser) await browseTo(target.hostId, browser.path)
        } catch (error) {
          store.set({ error: errText(error) })
        }
        setRemoving(false)
        setPendingRemove(null)
      }

      const bindWorkspace = async () => {
        try {
          const res = await withTimeout(createPlaceholder(browser.hostId, browser.path), 30_000, '创建工作区')
          const value = unwrap(res, null)
          if (value) { setCreated({ localPath: value.localPath }); await reloadPlaceholders() }
          else fail(res, '创建工作区失败')
        } catch (error) {
          store.set({ error: errText(error) })
        }
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
              h('span', { className: 'dri-dirName' },
                h('span', { className: 'dri-dirIcon' }, '›'), e.name),
              h('button', { className: 'dri-dirDel', 'aria-label': '删除 ' + e.name, onClick: (ev) => {
                ev.stopPropagation()
                doRemove(browser.hostId, (browser.path === '/' ? '' : browser.path) + '/' + e.name)
              } }, '×')))
          } else {
            dirRows.push(h('div', { key: e.name, className: 'dri-dirRow', style: { cursor: 'default' } },
              h('span', { className: 'dri-dirName' },
                h('span', { className: 'dri-dirIcon', style: { opacity: 0.35 } }, '·'), e.name),
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
        pendingRemove ? h(ConfirmDialog, {
          title: '删除远端目录？',
          body: '仅删除空目录或文件；非空目录请先清空内容。此操作不可撤销。',
          // 远端路径（不可信输入）只作 children 文本节点，React 负责转义
          detail: pendingRemove.fullPath,
          confirmLabel: removing ? '删除中…' : '确认删除',
          danger: true,
          onConfirm: () => { void confirmRemove() },
          onCancel: () => { if (!removing) setPendingRemove(null) },
        }) : null,
      )
    }

    // -------------------------------------------------------------- apply

    /** 订阅模块 store 的极简 hook（避免依赖 useSyncExternalStore 的版本差异）。 */
    function useStore() {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return store.getSnapshot()
    }

    /**
     * 工作区选择器：填充官方 ui-workspace 的 directory-flow 洞（本机 / 云端
     * 双 tab）。官方拥有「添加工作区」触发与收养（onPicked(path) 交给
     * createWorkspace），本组件只负责「选目录」这一段交互：
     *   本机 tab → 宿主原生系统目录对话框（ctx.workspaces.pickDirectory）
     *   云端 tab → SSH 主机 + 远端目录浏览 → 创建占位工作区 → onPicked(占位路径)
     * pickerDeps 由 apply() 注入（closure 捕获 typert 动作与 workspaces 面）。
     */
    function WorkspacePicker(props) {
      const { open, busy, onPicked, onCancel, onError } = props
      const state = useStore()
      const [tab, setTab] = useState('cloud')
      const [localBusy, setLocalBusy] = useState(false)
      const [browser, setBrowser] = useState(null)
      const [newDir, setNewDir] = useState('')
      const [creating, setCreating] = useState(false)
      const [addingHost, setAddingHost] = useState(false)
      const seq = useRef(0) // 浏览请求序号：乱序返回不覆盖最新目录

      useEffect(() => {
        if (open && pickerDeps) void pickerDeps.load()
      }, [open])

      useEffect(() => {
        if (!open) return
        const onKey = (e) => { if (e.key === 'Escape' && !busy && !creating) onCancel && onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, busy, creating])

      if (!open) return null
      const hostList = Object.values(state.hosts || {})
      const deps = pickerDeps || {}

      const pickLocal = async () => {
        if (!deps.pickDirectory) { onError && onError('本机目录选择服务不可用'); return }
        setLocalBusy(true)
        try {
          const path = await deps.pickDirectory()
          if (path) onPicked(path)
        } catch (error) {
          onError && onError(errText(error))
        }
        setLocalBusy(false)
      }

      const browseTo = async (hostId, nextPath) => {
        const my = ++seq.current
        setBrowser({ hostId, path: nextPath, entries: [], loading: true })
        try {
          const res = await withTimeout(deps.listRemoteDir(hostId, nextPath), 20_000, '读取远端目录')
          if (my !== seq.current) return
          setBrowser({ hostId, path: nextPath, entries: unwrap(res, []) || [], loading: false })
        } catch (error) {
          if (my !== seq.current) return
          setBrowser({ hostId, path: nextPath, entries: [], loading: false })
          onError && onError(errText(error))
        }
      }

      const createDir = async () => {
        const name = newDir.trim()
        if (!name || !browser) return
        const next = (browser.path === '/' ? '' : browser.path) + '/' + name
        try {
          const res = await withTimeout(deps.mkdirRemote(browser.hostId, next), 20_000, '新建文件夹')
          if (!res || res.ok !== true) onError && onError(resError(res, '新建文件夹失败'))
          else { setNewDir(''); await browseTo(browser.hostId, browser.path) }
        } catch (error) {
          onError && onError(errText(error))
        }
      }

      const useRemoteDir = async () => {
        if (!browser || creating) return
        setCreating(true)
        try {
          const res = await withTimeout(deps.createPlaceholder(browser.hostId, browser.path), 30_000, '创建工作区')
          const value = unwrap(res, null)
          if (value) onPicked(value.localPath)
          else onError && onError(resError(res, '创建云端工作区失败'))
        } catch (error) {
          onError && onError(errText(error))
        }
        setCreating(false)
      }

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
              h('span', { className: 'dri-dirName' }, h('span', { className: 'dri-dirIcon' }, '›'), e.name)))
          }
        }
        if (browser.loading) dirRows.push(h('div', { key: 'loading', className: 'dri-dirRow', style: { cursor: 'default' } }, '连接中…'))
      }

      const tabBtn = (id, label) => h('button', {
        type: 'button',
        className: 'dri-tab' + (tab === id ? ' dri-tab-active' : ''),
        role: 'tab',
        'aria-selected': tab === id ? 'true' : 'false',
        onClick: () => setTab(id),
      }, label)

      const hostSelect = h('div', { className: 'dri-field' },
        h('label', null, 'SSH 主机'),
        h('select', { value: browser ? browser.hostId : '', onChange: (e) => {
          const hostId = e.target.value
          if (hostId) void browseTo(hostId, '/')
          else setBrowser(null)
        } },
          h('option', { value: '' }, '选择主机…'),
          hostList.map((host) => h('option', { key: host.id, value: host.id }, (host.name || host.id) + '（' + host.user + '@' + host.host + '）'))),
        hostList.length === 0 ? h('span', { className: 'dri-hint' }, '还没有主机。') : null,
        h('button', { className: 'dri-btn', style: { alignSelf: 'flex-start', marginTop: 6 }, onClick: () => setAddingHost(!addingHost) },
          addingHost ? '收起' : '+ 添加主机'),
      )

      return h('div', { className: 'dri-pickerOverlay', role: 'dialog', 'aria-label': '选择工作区' },
        h('div', { className: 'dri-picker' },
          h('div', { className: 'dri-pickerHead' },
            h('div', { className: 'dri-tabs' }, tabBtn('local', '本机'), tabBtn('cloud', '云端（SSH）')),
            h('button', { className: 'dri-close', onClick: onCancel, 'aria-label': '取消' }, '×')),

          tab === 'local'
            ? h('div', { className: 'dri-pickerBody' },
                h('p', { className: 'dri-intro' }, '选择 DSH 所在电脑上的一个文件夹作为工作区。'),
                h('button', { className: 'dri-btn dri-btn-primary dri-pickLocal', disabled: localBusy || busy, onClick: pickLocal },
                  localBusy ? '等待系统对话框…' : '选择文件夹…'),
                h('p', { className: 'dri-hint', style: { marginTop: 10 } }, '将打开系统文件夹选择对话框。'))
            : h('div', { className: 'dri-pickerBody' },
                h('p', { className: 'dri-intro' }, '把服务器上的目录作为工作区，会话即在该服务器执行。'),
                addingHost
                  ? h(HostForm, {
                      initial: null,
                      onCancel: () => setAddingHost(false),
                      onSave: async (patch) => {
                        const id = slugId(patch.name || patch.host)
                        const res = await deps.saveHost(id, patch)
                        if (!res || res.ok !== true) { onError && onError(resError(res, '保存失败')); return }
                        setAddingHost(false)
                        await deps.load()
                      },
                    })
                  : hostSelect,
                browser ? h('div', null,
                  h('div', { className: 'dri-dirPath' }, browser.path),
                  h('div', { className: 'dri-dirList', style: { maxHeight: 200 } }, ...dirRows),
                  h('div', { className: 'dri-dirActions' },
                    h('input', {
                      className: 'dri-newDir', value: newDir, placeholder: '新建文件夹名称…',
                      onChange: (e) => setNewDir(e.target.value),
                      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void createDir() } },
                    }),
                    h('button', { className: 'dri-btn', disabled: !newDir.trim(), onClick: createDir }, '新建文件夹')),
                  h('div', { className: 'dri-formActions', style: { marginTop: 12 } },
                    h('button', { className: 'dri-btn dri-btn-primary', disabled: busy || creating, onClick: useRemoteDir },
                      busy || creating ? '正在创建…' : '使用「' + browser.path + '」作为工作区')))
                  : null),

          h('div', { className: 'dri-pickerFoot' },
            h('span', { className: 'dri-hint' }, '选择后会创建工作区并开始使用。')),
        ),
      )
    }

    /** apply() 注入给 WorkspacePicker 的动作集合（模块级，供闭包读取）。 */
    let pickerDeps = null

    function apply(ctx) {
      try {
        applyInner(ctx)
      } catch (error) {
        // apply 抛错会让整个 client 模块加载失败（选择器/设置卡全挂）——
        // 必须在 console 留下可辨识的现场。只打 message：error 对象可能挂着
        // 主机配置等上下文，整对象 dump 会把它们泄进浏览器控制台。
        console.error('[dsh-cloud-workspaces] client apply failed: ' + errText(error))
      }
    }

    function applyInner(ctx) {
      const styleEl = document.createElement('style')
      styleEl.dataset.pluginCss = 'dsh-remote-ide/client'
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-remote-ide: settings css')

      let mounted = false
      // namespace 服务 remote.ssh-remote：用 ctx.get 读取（无 inject 要求——
      // 直接 ctx.remote['ssh-remote'] 属性访问会被 cordis 的 inject 检查拒绝）。
      // 缺失（host 半未加载/未就绪）时给出可见错误，绝不 undefined.method 崩溃。
      const svc = () => {
        const s = ctx.get('remote.ssh-remote')
        if (!s) throw new Error('SSH 远程服务未就绪（插件 host 半未加载），请刷新页面重试')
        return s
      }

      const refresh = async () => {
        if (!mounted) return
        try {
          const s = svc()
          const [hostsRes, phRes] = await Promise.all([
            s.listHosts(),
            s.listPlaceholders(),
          ])
          const value = unwrap(hostsRes, null)
          if (value) store.set({ status: 'ready', hosts: value.hosts || {}, secrets: value.secrets || {}, error: null })
          else store.set({ status: 'error', error: resError(hostsRes, '无法读取主机配置') })
          store.set({ placeholders: unwrap(phRes, []) || [] })
        } catch (error) {
          store.set({ status: 'error', error: errText(error) })
        }
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
        try {
          store.set({ placeholders: unwrap(await svc().listPlaceholders(), []) || [] })
        } catch { /* 主机列表刷新时的附带数据，失败不阻断主流程 */ }
      }
      const saveHost = (id, patch) => svc().saveHost(id, patch)
      const deleteHost = (id) => svc().deleteHost(id)
      const testConnection = (host) => svc().testConnection(host.id, {
        host: host.host, port: host.port, user: host.user,
        authType: host.authType || 'key', privateKeyPath: host.privateKeyPath,
      })
      const listRemoteDir = (hostId, path) => svc().listRemoteDir(hostId, path)
      const mkdirRemote = (hostId, path) => svc().mkdirRemote(hostId, path)
      const removeRemote = (hostId, path) => svc().removeRemote(hostId, path)
      const createPlaceholder = (hostId, remotePath) => svc().createPlaceholder(hostId, remotePath)

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

      // 工作区选择器：填充官方 ui-workspace 的两个 directory-flow 洞
      // （conversation hero + sidebar 的「添加工作区」入口只在洞被占用时
      // 出现；onPicked(路径) 交给官方 createWorkspace 收养）。
      const workspaces = () => {
        try { return ctx.get('workspaces') } catch { return undefined }
      }
      pickerDeps = {
        load,
        saveHost,
        listRemoteDir,
        mkdirRemote,
        createPlaceholder,
        pickDirectory: async () => {
          const surface = workspaces()
          if (!surface || typeof surface.pickDirectory !== 'function') return null
          return surface.pickDirectory()
        },
      }
      ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
        ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
          yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-remote-ide', priority: -100 }, WorkspacePicker)
          yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', id: 'dsh-remote-ide', priority: -100 }, WorkspacePicker)
        }),
      )

      // 本插件渲染错误的可观测性：带上前缀，浏览器 console 一眼可辨。
      ctx.effect(() => {
        const onError = (event) => {
          console.error('[dsh-cloud-workspaces] window error: ' + errText(event && (event.error || event.message)))
        }
        window.addEventListener('error', onError)
        return () => window.removeEventListener('error', onError)
      }, 'dsh-remote-ide: window error log')
    }

    // 'workspaces' 面不经 exports.inject 声明（loader 解析不了会连累整个
    // client 加载）；运行时面走 package.json dsh.client.inject 声明的
    // dsh-client-runtime，apply 内 ctx.get('workspaces') 防御式获取。
    return { apply, inject: ['slots', 'connection', 'remote'] }
  },
})
