/**
 * 会话透明工具集测试 —— 免 preset 的核心：agent/created 钩子 + 会话级遮蔽
 * 工具（bash/read/write/edit/glob/grep 直接落锚定主机）。
 */

import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { buildSessionTools, installSessionRouting, sessionSectionText } from '../src/session-tools'
import { remoteRoot } from '../src/workspace'
import type { SshRuntime } from '../src/ssh-service'

/** 占位工作区路径（workspace.ts base64url 对 /remote/work 的固定编码）。 */
const PLACEHOLDER = join(remoteRoot(), 'dev', 'L3JlbW90ZS93b3Jr')
const REMOTE_CWD = '/remote/work'

function stubRuntime(engineOverrides: Record<string, unknown> = {}): SshRuntime {
  return {
    engine: {
      status: () => ({ alias: 'dev', state: 'connected', home: '/root' }),
      exec: async () => ({ success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }),
      readFile: async () => ({ content: 'alpha\nbeta\ngamma\n', truncated: false, size: 18, mtimeMs: 1 }),
      writeFile: async () => ({ size: 5, mtimeMs: 2 }),
      ...engineOverrides,
    },
    connect: async () => ({ state: 'connected', alias: 'dev', home: '/root' }),
  } as unknown as SshRuntime
}

function route() {
  return { hostId: 'dev', remoteCwd: REMOTE_CWD, placeholderCwd: PLACEHOLDER }
}

describe('buildSessionTools', () => {
  it('bash：相对 workdir 解析到远程工作区，输出 lossless', async () => {
    const exec = vi.fn(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', durationMs: 4 }))
    const tools = buildSessionTools(stubRuntime({ exec }), route())
    const bash = tools.find((t) => t.name === 'bash')!
    const output = await bash.execute({ command: 'pwd', description: 'print cwd', workdir: 'sub' })
    expect(exec).toHaveBeenCalledWith('dev', 'pwd', { cwd: REMOTE_CWD + '/sub', timeoutMs: undefined })
    expect(output.success).toBe(true)
    expect(Object.hasOwn(output, 'exitCode')).toBe(true)
  })

  it('read：相对路径落到远程工作区，offset/limit 切片', async () => {
    const readFile = vi.fn(async () => ({ content: 'l1\nl2\nl3\nl4\n', truncated: false, size: 16, mtimeMs: 1 }))
    const tools = buildSessionTools(stubRuntime({ readFile }), route())
    const read = tools.find((t) => t.name === 'read')!
    const output = await read.execute({ file_path: 'src/app.ts', offset: 2, limit: 2 })
    expect(readFile).toHaveBeenCalledWith('dev', REMOTE_CWD + '/src/app.ts')
    expect(output.totalLines).toBe(4)
    expect(output.content).toBe('l2\nl3')
  })

  it('edit：唯一匹配替换；多处不带 replace_all 报错', async () => {
    const writeFile = vi.fn(async () => ({ size: 9, mtimeMs: 3 }))
    const tools = buildSessionTools(stubRuntime({
      readFile: async () => ({ content: 'a X b X c\n', truncated: false, size: 10, mtimeMs: 1 }),
      writeFile,
    }), route())
    const edit = tools.find((t) => t.name === 'edit')!
    await expect(edit.execute({ file_path: 'f.txt', old_string: 'X', new_string: 'Y' }))
      .rejects.toThrow(/appears 2 times/)
    const output = await edit.execute({ file_path: 'f.txt', old_string: 'X', new_string: 'Y', replace_all: true })
    expect(output.replacements).toBe(2)
    const written = writeFile.mock.calls[0]?.[2]
    expect(written).toBe('a Y b Y c\n')
  })

  it('glob：无 "/" 的 pattern 按任意深度 basename 匹配', async () => {
    const exec = vi.fn(async () => ({
      success: true, exitCode: 0, timedOut: false,
      stdout: [REMOTE_CWD + '/a.ts', REMOTE_CWD + '/sub/b.ts', REMOTE_CWD + '/readme.md', REMOTE_CWD + '/c.tsx'].join('\n'),
      stderr: '', durationMs: 5,
    }))
    const tools = buildSessionTools(stubRuntime({ exec }), route())
    const glob = tools.find((t) => t.name === 'glob')!
    const output = await glob.execute({ pattern: '*.ts' })
    expect(output.matches).toEqual([REMOTE_CWD + '/a.ts', REMOTE_CWD + '/sub/b.ts'])
    expect(output.truncated).toBe(false)
  })

  it('grep：include 过滤进命令，pattern 经单引号转义', async () => {
    const exec = vi.fn(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 2 }))
    const tools = buildSessionTools(stubRuntime({ exec }), route())
    const grep = tools.find((t) => t.name === 'grep')!
    await grep.execute({ pattern: "it's", path: '.', include: '*.ts' })
    const [alias, command] = exec.mock.calls[0] as [string, string]
    expect(alias).toBe('dev')
    expect(command).toContain("--include='*.ts'")
    expect(command).toContain("-e 'it'\\''s'")
  })

  it('read_image：PNG 魔数识别 + base64 输出；非图片拒绝', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const sftp = { readFile: (p: string, cb: (e: Error | null, d?: Buffer) => void) => cb(null, png) }
    const tools = buildSessionTools(stubRuntime({ getSftp: async () => sftp }), route())
    const readImage = tools.find((t) => t.name === 'read_image')!
    const output = await readImage.execute({ file_path: 'img/logo.png' })
    expect(output.mediaType).toBe('image/png')
    expect(output.path).toBe(REMOTE_CWD + '/img/logo.png')
    expect(output.data).toBe(png.toString('base64'))
    expect(output.bytes).toBe(png.length)

    const badSftp = { readFile: (p: string, cb: (e: Error | null, d?: Buffer) => void) => cb(null, Buffer.from('plain text')) }
    const tools2 = buildSessionTools(stubRuntime({ getSftp: async () => badSftp }), route())
    const readImage2 = tools2.find((t) => t.name === 'read_image')!
    await expect(readImage2.execute({ file_path: 'notes.txt' })).rejects.toThrow(/PNG\/JPEG\/WebP\/GIF/)
  })

  it('bash presenter：terminal 视图（官方 BashRow 可展开的前提）', () => {
    const tools = buildSessionTools(stubRuntime(), route())
    const bash = tools.find((t) => t.name === 'bash')! as {
      presentCall?: (args: unknown) => { card: string; title?: string; description?: string; cwd?: string }
      presentResult?: (args: unknown, result: unknown) => { card: string; output?: string; exitCode?: number } | undefined
    }
    expect(bash.presentCall).toBeTruthy()
    const callView = bash.presentCall!({ command: 'uptime', description: '看负载', workdir: 'sub' })
    expect(callView.card).toBe('terminal')
    expect(callView.title).toBe('uptime')
    expect(callView.description).toBe('看负载')
    expect(callView.cwd).toBe('sub')

    const resultView = bash.presentResult!({ command: 'uptime', description: '看负载' }, {
      content: [{ type: 'text', text: '[exit code: 0]\nstdout:\nup 14:44\nduration: 12 ms' }],
      isError: false,
    })
    expect(resultView?.card).toBe('terminal')
    expect(resultView?.exitCode).toBe(0)
    expect(resultView?.output).toContain('up 14:44')
    expect(resultView?.output).not.toContain('duration:')
    // 出错结果软落到通用卡（undefined）
    expect(bash.presentResult!({ command: 'uptime', description: '看负载' }, { content: [], isError: true })).toBeUndefined()
  })

  it('read presenter：read 卡视图带行号窗口', () => {
    const tools = buildSessionTools(stubRuntime(), route())
    const read = tools.find((t) => t.name === 'read')! as {
      presentResult?: (args: unknown, result: unknown) => {
        card: string; path?: string; offset?: number; totalLines?: number
        lines?: Array<{ number: number; text: string }>
      } | undefined
    }
    const view = read.presentResult!({ file_path: '/remote/work/a.ts' }, {
      content: [{ type: 'text', text: '/remote/work/a.ts (2/4 lines, from 2):\nl2\nl3' }],
      isError: false,
    })
    expect(view?.card).toBe('read')
    expect(view?.path).toBe('/remote/work/a.ts')
    expect(view?.offset).toBe(2)
    expect(view?.totalLines).toBe(4)
    expect(view?.lines).toEqual([{ number: 2, text: 'l2' }, { number: 3, text: 'l3' }])
  })
})

describe('sessionSectionText', () => {
  it('占位 cwd → 远程身份宣告', () => {
    const text = sessionSectionText(PLACEHOLDER)
    expect(text).toContain('Remote workspace session')
    expect(text).toContain(REMOTE_CWD)
    expect(text).toContain('"dev"')
  })

  it('本地 cwd → 空串（零注入）', () => {
    expect(sessionSectionText('C:\\dev\\project')).toBe('')
    expect(sessionSectionText(undefined)).toBe('')
  })
})

describe('installSessionRouting', () => {
  it('占位 cwd 的会话注册 7 个遮蔽工具并激活连接；本地会话不注册', () => {
    const registered: string[] = []
    let listener: ((payload: { agent: unknown }) => void) | undefined
    // cordis 事件订阅 = ctx.on('agent/created', cb)；真实 effect 立即执行一次。
    const ctxStub = {
      on: (_event: string, cb: (payload: { agent: unknown }) => void) => { listener = cb; return () => {} },
      effect: (fn: () => unknown, _name: string) => { fn(); return () => {} },
    } as never
    // connect 挂在 runtime 层（钩子调用的是 runtime.connect，不是 engine.connect）。
    const connect = vi.fn(async () => ({ state: 'connected', alias: 'dev' }))
    const runtimeStub = stubRuntime() as unknown as Record<string, unknown>
    runtimeStub.connect = connect
    installSessionRouting(ctxStub, runtimeStub as unknown as SshRuntime)
    expect(listener).toBeTruthy()

    const scopeRegister = vi.fn((tool: { name: string }) => { registered.push(tool.name); return () => {} })
    listener!({ agent: { session: { header: { cwd: PLACEHOLDER } }, ctx: { tools: { register: scopeRegister } } } })
    expect(registered.sort()).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'read_image', 'write'])
    // ssh_* 全局工具的无别名回退读 activeAlias——钩子必须把它切到会话主机。
    expect(connect).toHaveBeenCalledWith('dev')

    listener!({ agent: { session: { header: { cwd: 'C:\\local\\proj' } }, ctx: { tools: { register: scopeRegister } } } })
    expect(scopeRegister).toHaveBeenCalledTimes(7)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('ctx.on 不可用时静默跳过', () => {
    const ctxStub = { effect: () => undefined } as never
    expect(() => installSessionRouting(ctxStub, stubRuntime())).not.toThrow()
  })

  it('agent scope 缺失时跳过注册——绝不退回插件全局（会遮蔽本地会话的官方工具）', () => {
    const pluginRegister = vi.fn()
    let listener: ((payload: { agent: unknown }) => void) | undefined
    const ctxStub = {
      on: (_event: string, cb: (payload: { agent: unknown }) => void) => { listener = cb; return () => {} },
      effect: (fn: () => unknown, _name: string) => { fn(); return () => {} },
      tools: { register: pluginRegister },
    } as never
    const connect = vi.fn(async () => ({ state: 'connected', alias: 'dev' }))
    const runtimeStub = stubRuntime() as unknown as Record<string, unknown>
    runtimeStub.connect = connect
    installSessionRouting(ctxStub, runtimeStub as unknown as SshRuntime)
    expect(listener).toBeTruthy()

    // 占位会话但 agent.ctx 缺失：宁可本会话无遮蔽工具，也不污染全局。
    listener!({ agent: { session: { header: { cwd: PLACEHOLDER } } } })
    expect(pluginRegister).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('enabled 开关在事件时求值：关闭时远程会话也不路由', () => {
    let listener: ((payload: { agent: unknown }) => void) | undefined
    const ctxStub = {
      on: (_event: string, cb: (payload: { agent: unknown }) => void) => { listener = cb; return () => {} },
      effect: (fn: () => unknown, _name: string) => { fn(); return () => {} },
    } as never
    const scopeRegister = vi.fn(() => () => {})
    installSessionRouting(ctxStub, stubRuntime(), () => false)
    listener!({ agent: { session: { header: { cwd: PLACEHOLDER } }, ctx: { tools: { register: scopeRegister } } } })
    expect(scopeRegister).not.toHaveBeenCalled()
  })
})
