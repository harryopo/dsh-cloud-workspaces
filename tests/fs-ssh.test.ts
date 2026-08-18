/**
 * SshFileSystem（fs-ssh）测试 —— 参照 fs-e2b 语义 + ssh-service 的 mock 模式：
 * vi.mock('ssh2') + 内存 FakeSftp / FakeExec（realpath/chmod/ln 守卫分发），
 * 验证 dsh-fs 能力缝的 13 个方法 + 错误码分支。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { posix } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SshRuntime from '../src/ssh-service'
import SshFileSystem from '../src/fs-ssh'

/** 可编程的 ssh2 假实现：内存文件系统 + exec 脚本分发。 */
const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void

  class MiniEmitter {
    private listeners = new Map<string, Handler[]>()

    on(event: string, cb: Handler) {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }

    once(event: string, cb: Handler) {
      const wrapper: Handler = (...args) => {
        this.remove(event, wrapper)
        cb(...args)
      }
      const list = this.listeners.get(event) ?? []
      list.push(wrapper)
      this.listeners.set(event, list)
      return this
    }

    remove(event: string, cb: Handler) {
      const list = this.listeners.get(event)
      if (!list) return
      const index = list.indexOf(cb)
      if (index >= 0) list.splice(index, 1)
    }

    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
      return this
    }
  }

  class FakeStream extends MiniEmitter {
    stderr = new MiniEmitter()
    close() {
      this.emit('close', 0)
    }
  }

  /** SSH 连接 + SFTP 状态（每次测试重建）。 */
  const state = {
    sftp: undefined as unknown,
    home: '/home/dev',
  }

  /** SFTP 元数据对象（模拟 ssh2 Stats）。 */
  class FakeStats {
    constructor(
      private kind: 'file' | 'dir' | 'symlink',
      public size: number,
      public mode: number,
      public mtime: number,
    ) {}

    isFile() { return this.kind === 'file' }
    isDirectory() { return this.kind === 'dir' }
    isSymbolicLink() { return this.kind === 'symlink' }
    isBlockDevice() { return false }
    isCharacterDevice() { return false }
    isFIFO() { return false }
    isSocket() { return false }
  }

  interface FakeFile { kind: 'file'; content: Buffer; mode: number; mtime: number }
  interface FakeDir { kind: 'dir'; mode: number; mtime: number }
  type FakeNode = FakeFile | FakeDir

  const norm = (p: string) => p === '/' ? '/' : p.replace(/\/+$/g, '')

  /** 内存远程文件系统。 */
  class FakeSftp {
    nodes = new Map<string, FakeNode>()
    symlinks = new Map<string, string>() // linkPath → absolute target
    /** 单调 mtime：同一毫秒内多次写入也能区分版本（Date.now 会碰撞）。 */
    private mtimeCounter = 0

    private tick(): number {
      this.mtimeCounter += 1
      return this.mtimeCounter
    }

    /** 默认远程世界：home 下的 project 目录与一个文件。 */
    seed() {
      this.nodes.set('/home/dev', { kind: 'dir', mode: 0o755, mtime: 1 })
      this.nodes.set('/home/dev/project', { kind: 'dir', mode: 0o755, mtime: 1 })
      this.nodes.set('/home/dev/project/main.ts', {
        kind: 'file',
        content: Buffer.from("console.log('hi')\n", 'utf8'),
        mode: 0o644,
        mtime: 100,
      })
    }

    /** 跟随 symlink 链解析目标路径。 */
    targetOf(path: string): string {
      const seen = new Set<string>()
      let current = norm(path)
      while (this.symlinks.has(current)) {
        if (seen.has(current)) break
        seen.add(current)
        const target = this.symlinks.get(current)!
        current = norm(target.startsWith('/') ? target : posix.join(posix.dirname(current), target))
      }
      return current
    }

    stat(path: string, cb: (err: Error | undefined, stats: FakeStats) => void) {
      const target = this.targetOf(path)
      const node = this.nodes.get(target)
      if (node === undefined) {
        cb(new Error('No such file or directory'), null as unknown as FakeStats)
        return
      }
      const symlink = target !== norm(path)
      cb(undefined, new FakeStats(
        symlink ? 'file' : node.kind,
        node.kind === 'file' ? node.content.length : 0,
        node.mode,
        node.mtime,
      ))
    }

    lstat(path: string, cb: (err: Error | undefined, stats: FakeStats) => void) {
      const key = norm(path)
      if (this.symlinks.has(key)) {
        const target = this.targetOf(key)
        const node = this.nodes.get(target)
        const size = node?.kind === 'file' ? node.content.length : 0
        cb(undefined, new FakeStats('symlink', size, 0o120777, 1))
        return
      }
      const node = this.nodes.get(key)
      if (node === undefined) {
        cb(new Error('No such file or directory'), null as unknown as FakeStats)
        return
      }
      cb(undefined, new FakeStats(node.kind, node.kind === 'file' ? node.content.length : 0, node.mode, node.mtime))
    }

    readdir(path: string, cb: (err: Error | undefined, list: Array<{ filename: string; longname: string; attrs: FakeStats }>) => void) {
      const dir = norm(path)
      const node = this.nodes.get(dir)
      if (node === undefined) {
        cb(new Error('No such file or directory'), [])
        return
      }
      if (node.kind !== 'dir') {
        cb(new Error('Not a directory'), [])
        return
      }
      const names = new Set<string>()
      for (const key of this.nodes.keys()) {
        if (key.startsWith(dir + '/')) {
          const rest = key.slice(dir.length + 1)
          if (rest.includes('/')) continue
          names.add(rest)
        }
      }
      for (const key of this.symlinks.keys()) {
        if (key.startsWith(dir + '/')) {
          const rest = key.slice(dir.length + 1)
          if (rest.includes('/')) continue
          names.add(rest)
        }
      }
      const list = [...names].map((name) => {
        const full = posix.join(dir, name)
        if (this.symlinks.has(full)) {
          return { filename: name, longname: '', attrs: new FakeStats('symlink', 0, 0o120777, 1) }
        }
        const child = this.nodes.get(full)
        return {
          filename: name,
          longname: '',
          attrs: new FakeStats(
            child?.kind ?? 'file',
            child?.kind === 'file' ? child.content.length : 0,
            child?.mode ?? 0o644,
            child?.mtime ?? 1,
          ),
        }
      })
      cb(undefined, list)
    }

    readFile(path: string, cb: (err: Error | undefined, data: Buffer) => void) {
      const target = this.targetOf(path)
      const node = this.nodes.get(target)
      if (node === undefined) {
        cb(new Error('No such file or directory'), Buffer.alloc(0))
        return
      }
      if (node.kind !== 'file') {
        cb(new Error('Is a directory'), Buffer.alloc(0))
        return
      }
      cb(undefined, Buffer.from(node.content))
    }

    createReadStream(path: string) {
      const target = this.targetOf(path)
      const node = this.nodes.get(target)
      const content = node?.kind === 'file' ? node.content : Buffer.alloc(0)
      return Readable.from([Buffer.from(content)])
    }

    writeFile(path: string, data: string | Buffer, cb: (err?: Error) => void) {
      const key = norm(path)
      const parent = posix.dirname(key)
      if (!this.nodes.has(parent)) {
        cb(new Error('No such file or directory'))
        return
      }
      const content = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
      const existing = this.nodes.get(key)
      this.nodes.set(key, {
        kind: 'file',
        content,
        mode: existing?.kind === 'file' ? existing.mode : 0o600,
        mtime: this.tick(),
      })
      cb(undefined)
    }

    mkdir(path: string, cb: (err?: Error) => void) {
      const key = norm(path)
      if (this.nodes.has(key) || this.symlinks.has(key)) {
        cb(new Error('File exists'))
        return
      }
      this.nodes.set(key, { kind: 'dir', mode: 0o700, mtime: this.tick() })
      cb(undefined)
    }

    rmdir(path: string, cb: (err?: Error) => void) {
      const key = norm(path)
      const node = this.nodes.get(key)
      if (node === undefined) {
        cb(new Error('No such file or directory'))
        return
      }
      if (node.kind !== 'dir') {
        cb(new Error('Not a directory'))
        return
      }
      for (const child of this.nodes.keys()) {
        if (child.startsWith(key + '/')) {
          cb(new Error('Directory not empty'))
          return
        }
      }
      this.nodes.delete(key)
      cb(undefined)
    }

    unlink(path: string, cb: (err?: Error) => void) {
      const key = norm(path)
      if (this.symlinks.has(key)) {
        this.symlinks.delete(key)
        cb(undefined)
        return
      }
      const node = this.nodes.get(key)
      if (node === undefined) {
        cb(new Error('No such file or directory'))
        return
      }
      if (node.kind !== 'file') {
        cb(new Error('Is a directory'))
        return
      }
      this.nodes.delete(key)
      cb(undefined)
    }

    rename(from: string, to: string, cb: (err?: Error) => void) {
      const src = norm(from)
      const dst = norm(to)
      if (this.nodes.has(src)) {
        const node = this.nodes.get(src)!
        this.nodes.delete(src)
        this.nodes.set(dst, node)
      } else if (this.symlinks.has(src)) {
        const target = this.symlinks.get(src)!
        this.symlinks.delete(src)
        this.symlinks.set(dst, target)
      } else {
        cb(new Error('No such file or directory'))
        return
      }
      cb(undefined)
    }

    chmod(path: string, mode: number | string, cb: (err?: Error) => void) {
      const key = norm(path)
      const node = this.nodes.get(key)
      const numeric = typeof mode === 'number' ? mode : parseInt(mode, 8)
      if (node === undefined) {
        cb(new Error('No such file or directory'))
        return
      }
      node.mode = (node.mode & ~0o777) | (numeric & 0o777)
      cb(undefined)
    }
  }

  /** exec 脚本分发：realpath / chmod / ln 守卫 / $HOME。 */
  function execScript(command: string): { stdout: string; stderr: string; exitCode: number } {
    const sftp = state.sftp as FakeSftp
    if (command === 'printf %s "$HOME"') {
      return { stdout: state.home, stderr: '', exitCode: 0 }
    }
    const realpathMatch = /realpath -mz -- '([^']*)' \| base64 -w0/.exec(command)
    if (realpathMatch) {
      const canonical = sftp.targetOf(realpathMatch[1]!)
      const framed = Buffer.concat([Buffer.from(canonical, 'utf8'), Buffer.from([0])])
      return { stdout: framed.toString('base64'), stderr: '', exitCode: 0 }
    }
    const chmodMatch = /^chmod ([0-7]+) -- '([^']*)'$/.exec(command)
    if (chmodMatch) {
      sftp.chmod(chmodMatch[2]!, parseInt(chmodMatch[1]!, 8), () => {})
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const lnMatch = /if ln -T -- '([^']*)' '([^']*)'; then/.exec(command)
    if (lnMatch) {
      const tmp = lnMatch[1]!
      const target = lnMatch[2]!
      if (sftp.symlinks.has(target) || sftp.nodes.has(target)) {
        return { stdout: 'exists', stderr: '', exitCode: 0 }
      }
      const src = sftp.nodes.get(norm(tmp))
      if (src?.kind !== 'file') return { stdout: '', stderr: '', exitCode: 1 }
      // 硬链接语义：target 获得 staging 内容的副本（staging 侧随后 unlink）。
      sftp.nodes.set(norm(target), {
        kind: 'file',
        content: Buffer.from(src.content),
        mode: src.mode,
        mtime: src.mtime,
      })
      return { stdout: 'created', stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: `unknown command: ${command}`, exitCode: 1 }
  }

  /** 每次测试重建内存文件系统（hoisted state 跨测试共享，必须重置）。 */
  function resetSftp(): void {
    state.sftp = new FakeSftp()
    state.sftp.seed()
  }

  class FakeClient extends MiniEmitter {
    static instances: FakeClient[] = []
    exec = vi.fn()
    shell = vi.fn()
    sftp = vi.fn()
    end = vi.fn()

    constructor() {
      super()
      FakeClient.instances.push(this)
      this.exec.mockImplementation((command: string, cb: (err: unknown, stream: FakeStream) => void) => {
        const stream = new FakeStream()
        queueMicrotask(() => {
          cb(null, stream)
          const out = execScript(command)
          if (out.stderr.length > 0) stream.stderr.emit('data', Buffer.from(out.stderr))
          stream.emit('data', Buffer.from(out.stdout))
          stream.emit('close', out.exitCode)
        })
        return this
      })
      this.sftp.mockImplementation((cb: (err: unknown, sftp: unknown) => void) => {
        queueMicrotask(() => cb(null, state.sftp))
        return this
      })
    }

    connect() {
      setImmediate(() => this.trigger('ready'))
      return this
    }

    trigger(event: string, ...args: unknown[]) {
      this.emit(event, ...args)
      return this
    }
  }

  return { FakeClient, state, resetSftp }
})

vi.mock('ssh2', () => ({ Client: fake.FakeClient }))

type Fiber = Awaited<ReturnType<Context['plugin']>>

/** 唯一 store 文件，隔离各测试的持久化。 */
let storeCounter = 0
function tmpStoreFile(): string {
  storeCounter += 1
  return join(tmpdir(), `dsh-remote-ide-fs-ssh-${process.pid}-${storeCounter}.json`)
}

describe('SshFileSystem 远程文件系统', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.resetSftp()
  })

  async function setup(): Promise<{ ctx: Context; fiber: Fiber; fs: SshFileSystem }> {
    const context = new Context()
    const f = await context.plugin(SshRuntime, { storeFile: tmpStoreFile() })
    context.ssh.upsertHost({
      alias: 'dev',
      host: '10.0.0.1',
      user: 'root',
      auth: { kind: 'password', password: 'secret' },
    })
    await context.ssh.connect('dev')
    expect(context.ssh.status().home).toBe('/home/dev')
    await context.plugin(SshFileSystem)
    return { ctx: context, fiber: f, fs: context.fs as SshFileSystem }
  }

  // ----------------------------------------------------------- resolve

  it('resolve：相对路径以 home 为基准，绝对路径原样，空路径报错', async () => {
    const { fiber, fs } = await setup()

    const relative = await fs.resolve('project/main.ts')
    expect(relative.displayPath).toBe('/home/dev/project/main.ts')
    expect(String(relative.targetKey)).toBe('/home/dev/project/main.ts')

    const absolute = await fs.resolve('/etc/hostname')
    expect(absolute.displayPath).toBe('/etc/hostname')
    expect(String(absolute.targetKey)).toBe('/etc/hostname')

    const withCwd = await fs.resolve('main.ts', { cwd: '/home/dev/project' })
    expect(withCwd.displayPath).toBe('/home/dev/project/main.ts')

    await expect(fs.resolve('   ')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await fiber.dispose()
  })

  it('resolve：symlink 解析为目标的 canonical 身份', async () => {
    const { fiber, fs } = await setup()
    const ctx = await fs['ctx'] as unknown as { ssh: { getConnection(): Promise<{ getSftp(): Promise<{ symlinks: Map<string, string> }> }> } }
    const sftp = await (await ctx.ssh.getConnection()).getSftp()
    sftp.symlinks.set('/home/dev/link.ts', '/home/dev/project/main.ts')

    const resolved = await fs.resolve('link.ts')
    expect(String(resolved.targetKey)).toBe('/home/dev/project/main.ts')
    await fiber.dispose()
  })

  // ------------------------------------------------ processPath/fileUrl/contains

  it('processPath / fileUrl / contains', async () => {
    const { fiber, fs } = await setup()
    const file = await fs.resolve('project/main.ts')
    const dir = await fs.resolve('project')
    const other = await fs.resolve('project/main.ts/../main.ts')

    expect(fs.processPath(file)).toBe(String(file.targetKey))
    expect(fs.fileUrl(file)).toBe('file:///home/dev/project/main.ts')
    expect(fs.contains(dir, file)).toBe(true)
    expect(fs.contains(file, dir)).toBe(false)
    expect(fs.contains(dir, other)).toBe(true)
    await fiber.dispose()
  })

  // ------------------------------------------------------------ stat/lstat

  it('stat：文件 / 目录 / 缺失（undefined）', async () => {
    const { fiber, fs } = await setup()

    const file = await fs.resolve('project/main.ts')
    const info = await fs.stat(file)
    expect(info).toBeDefined()
    expect(info!.type).toBe('file')
    expect(info!.size).toBe(Buffer.byteLength("console.log('hi')\n"))

    const dir = await fs.resolve('project')
    expect((await fs.stat(dir))!.type).toBe('directory')

    const missing = await fs.resolve('project/nope.ts')
    expect(await fs.stat(missing)).toBeUndefined()
    await fiber.dispose()
  })

  it('lstat：symlink 路径识别为 symlink，且不跟随', async () => {
    const { fiber, fs } = await setup()
    const ctx = await fs['ctx'] as unknown as { ssh: { getConnection(): Promise<{ getSftp(): Promise<{ symlinks: Map<string, string> }> }> } }
    const sftp = await (await ctx.ssh.getConnection()).getSftp()
    sftp.symlinks.set('/home/dev/link.ts', '/home/dev/project/main.ts')

    const link = await fs.lstat('link.ts')
    expect(link!.type).toBe('symlink')

    const missing = await fs.lstat('nope.ts')
    expect(missing).toBeUndefined()
    await fiber.dispose()
  })

  // -------------------------------------------------------------- readText

  it('readText：读取远程文本；二进制与非法 UTF-8 报 FS_NOT_TEXT', async () => {
    const { fiber, fs } = await setup()
    const file = await fs.resolve('project/main.ts')
    expect(await fs.readText(file)).toBe("console.log('hi')\n")

    const ctx = await fs['ctx'] as unknown as { ssh: { getConnection(): Promise<{ getSftp(): Promise<{ nodes: Map<string, { kind: string; content: Buffer }> }> }> } }
    const sftp = await (await ctx.ssh.getConnection()).getSftp()
    sftp.nodes.set('/home/dev/project/bin.dat', {
      kind: 'file',
      content: Buffer.from([0x00, 0x01, 0x02]),
    })
    sftp.nodes.set('/home/dev/project/bad.txt', {
      kind: 'file',
      content: Buffer.from([0xff, 0xfe, 0xfd]),
    })

    await expect(fs.readText(await fs.resolve('project/bin.dat'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(fs.readText(await fs.resolve('project/bad.txt'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(fs.readText(await fs.resolve('project/nope.ts'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await fiber.dispose()
  })

  it('readBytes：正常读取原始字节；超过 maxBytes 报 FS_TOO_LARGE', async () => {
    const { fiber, fs } = await setup()
    const file = await fs.resolve('project/main.ts')
    const bytes = await fs.readBytes(file, undefined, 1024)
    expect(Buffer.from(bytes).toString('utf8')).toBe("console.log('hi')\n")

    await expect(fs.readBytes(file, undefined, 4)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    await fiber.dispose()
  })

  it('streamText：流式解码整段文本', async () => {
    const { fiber, fs } = await setup()
    const file = await fs.resolve('project/main.ts')
    let text = ''
    for await (const chunk of await fs.streamText(file)) text += chunk
    expect(text).toBe("console.log('hi')\n")
    await fiber.dispose()
  })

  // -------------------------------------------------------------- listDir

  it('listDir：列出直接子项（稳定排序），symlink 跟随解析目标', async () => {
    const { fiber, fs } = await setup()
    const ctx = await fs['ctx'] as unknown as { ssh: { getConnection(): Promise<{ getSftp(): Promise<{ symlinks: Map<string, string> }> }> } }
    const sftp = await (await ctx.ssh.getConnection()).getSftp()
    sftp.symlinks.set('/home/dev/project/alias.ts', '/home/dev/project/main.ts')

    const dir = await fs.resolve('project')
    const entries = await fs.listDir(dir)
    expect(entries.map(e => e.name)).toEqual(['alias.ts', 'main.ts'])
    const alias = entries.find(e => e.name === 'alias.ts')!
    expect(alias.type).toBe('file')
    expect(String(alias.target.targetKey)).toBe('/home/dev/project/main.ts')

    await expect(fs.listDir(await fs.resolve('project/main.ts'))).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    await fiber.dispose()
  })

  // ------------------------------------------------------------- writeText

  it('writeText：创建新文件（create），返回版本与 diff 基准', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/new.ts')
    const outcome = await fs.writeText(target, 'const x = 1\n')
    expect(outcome.operation).toBe('create')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('const x = 1\n')

    const read = await fs.readText(target)
    expect(read).toBe('const x = 1\n')
    const info = await fs.stat(target)
    expect(info!.version).toBe(outcome.version)
    await fiber.dispose()
  })

  it('writeText：覆盖已有文件（update），before 为旧内容', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/main.ts')
    const outcome = await fs.writeText(target, 'const y = 2\n')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBe("console.log('hi')\n")
    expect(await fs.readText(target)).toBe('const y = 2\n')
    await fiber.dispose()
  })

  it('writeText：createIfAbsent 冲突报 FS_NOT_OBSERVED', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/main.ts')
    await expect(
      fs.writeText(target, 'x', { kind: 'createIfAbsent' }),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await fiber.dispose()
  })

  it('writeText：replaceIfVersion 版本不符报 FS_STALE_VERSION', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/main.ts')
    await fs.writeText(target, 'v1\n')
    const staleVersion = (await fs.stat(target))!.version // v1 写入后的版本（随后失效）
    await fs.writeText(target, 'v2\n')
    await expect(
      fs.writeText(target, 'v3\n', { kind: 'replaceIfVersion', version: staleVersion }),
    ).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await fiber.dispose()
  })

  it('writeText：写入目录报 FS_NOT_REGULAR_FILE', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project')
    await expect(fs.writeText(target, 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await fiber.dispose()
  })

  // -------------------------------------------------------------- editText

  it('editText：字面替换并返回 before/after', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/main.ts')
    const outcome = await fs.editText(target, {
      oldString: 'console.log',
      newString: 'console.error',
      replaceAll: false,
    })
    expect(outcome.before).toBe("console.log('hi')\n")
    expect(outcome.after).toBe("console.error('hi')\n")
    expect(await fs.readText(target)).toBe("console.error('hi')\n")
    await fiber.dispose()
  })

  it('editText：oldString 未找到报 FS_EDIT_NOT_FOUND；多匹配报 FS_AMBIGUOUS_EDIT', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/main.ts')
    await expect(fs.editText(target, {
      oldString: 'nope',
      newString: 'x',
      replaceAll: false,
    })).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await fs.writeText(target, 'a a\n')
    await expect(fs.editText(target, {
      oldString: 'a',
      newString: 'b',
      replaceAll: false,
    })).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    const all = await fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: true })
    expect(all.after).toBe('b b\n')
    await fiber.dispose()
  })

  it('editText：版本守卫过期报 FS_STALE_VERSION', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/main.ts')
    const observed = (await fs.stat(target))!.version
    await fs.writeText(target, 'changed\n')
    await expect(fs.editText(target, {
      oldString: 'changed',
      newString: 'again',
      replaceAll: false,
    }, { version: observed })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await fiber.dispose()
  })

  // ------------------------------------------------------ 并发与错误语义

  it('editText：目标不存在报 FS_STALE_VERSION（守卫创建被拒）', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/ghost.ts')
    await expect(fs.editText(target, {
      oldString: 'x',
      newString: 'y',
      replaceAll: false,
    })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await fiber.dispose()
  })

  it('并发写入同一文件：写窗口串行化，两个写入都成功且内容为后写者', async () => {
    const { fiber, fs } = await setup()
    const target = await fs.resolve('project/race.ts')
    await Promise.all([
      fs.writeText(target, 'first\n'),
      fs.writeText(target, 'second\n'),
    ])
    expect(await fs.readText(target)).toBe('second\n')
    await fiber.dispose()
  })

  it('未连接（无激活目标）时操作抛错（FS_IO_ERROR 包装）', async () => {
    const context = new Context()
    const f = await context.plugin(SshRuntime, { storeFile: tmpStoreFile() })
    await context.plugin(SshFileSystem)
    const fs = context.fs as SshFileSystem
    await expect(fs.resolve('x')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await f.dispose()
  })
})
