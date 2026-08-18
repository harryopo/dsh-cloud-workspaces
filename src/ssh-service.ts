/**
 * dsh-remote-ide — 共享 SSH 连接生命周期所有者（Cordis Service）。
 *
 * 完全复刻官方 E2BRuntime 模式（.research/dsh-source/deepseek-harness-master/
 * packages/e2b/e2b/src/index.ts）：一个 Service 拥有唯一的「远程世界」，
 * 能力适配器（M1 fs-ssh、M2 subprocess-ssh）通过 await getConnection() 消费
 * 同一句柄，绝不自行管理连接生命周期。
 *
 * 与 E2BRuntime 的三处关键差异：
 * 1. 惰性连接 —— e2b 构造即连（apiKey 已知）；SSH 目标由会话首轮模型决策
 *    决定，插件加载时不存在，故 connect(alias) 才建立 ready。
 * 2. 单会话单目标 —— 当前激活连接是唯一可消费目标（消费者看不到 alias）；
 *    切换服务器 = connect(新 alias)，旧连接由 engine 保持/回收。
 * 3. 底层复用 SshEngine 的连接池机制（ProxyJump / SFTP 懒加载 / sweep /
 *    broken 自动重建），仅把对外语义收敛为单目标。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { SshEngine } from './engine'
import type { SshExecChannel, ShellSession } from './engine'
import type { ExecResult, RemoteDirEntry, RemoteFileContent, WorkspaceStatus } from './protocol'
import type { HostPayload } from './protocol'
import { HostStore } from './store'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 共享 SSH 连接生命周期所有者（本 Service）。 */
    ssh: SshRuntime
  }
}

/** 连接生命周期配置（引擎旋钮 + 存储位置）。 */
export interface Config {
  /** 空闲连接回收超时（ms）。 */
  idleTimeoutMs?: number
  /** SSH 握手超时（ms）。 */
  connectTimeoutMs?: number
  /** Keepalive 心跳间隔（ms）。 */
  keepaliveIntervalMs?: number
  /** 单次 exec 捕获输出上限（字节）。 */
  maxOutputBytes?: number
  /** 默认 exec 超时（ms）。 */
  defaultExecTimeoutMs?: number
  /** 远程文件读入上限（字节）。 */
  maxReadBytes?: number
  /** 主机配置存储文件路径（空串 = 默认 ~/.dsh/dsh-remote-ide.json，测试可覆盖）。 */
  storeFile?: string
}

export const Config: z<Config> = z.object({
  idleTimeoutMs: z.number().min(1).default(30 * 60_000),
  connectTimeoutMs: z.number().min(1).default(15_000),
  keepaliveIntervalMs: z.number().min(1).default(15_000),
  maxOutputBytes: z.number().min(1024).default(2 * 1024 * 1024),
  defaultExecTimeoutMs: z.number().min(1).default(60_000),
  maxReadBytes: z.number().min(1024).default(2 * 1024 * 1024),
  // 本仓库用 npm schemastery 3.x（无 .optional()），遵循官方惯例以空串表达缺省。
  storeFile: z.string().default(''),
})

/**
 * 消费者（fs-ssh / subprocess-ssh）持有的稳定连接句柄。alias 被隐藏：
 * 单会话单目标语义下，句柄上的每个操作都作用于当前激活连接。
 */
export interface SshConnection {
  /** 激活目标的 alias。 */
  readonly alias: string
  /** 远程 $HOME（未解析或未连接时为 undefined）。 */
  readonly home: string | undefined
  /** 在当前连接上执行一条非交互命令。 */
  exec(command: string, options?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult>
  /** 打开一个低层流式命令通道（subprocess-ssh 的 wrapper 传输）。 */
  execChannel(command: string, options?: { cwd?: string }): Promise<SshExecChannel>
  /** 打开一个 PTY shell 会话。 */
  openShell(cols: number, rows: number): Promise<ShellSession>
  /** 列出远程目录。 */
  ls(path: string): Promise<RemoteDirEntry[]>
  /** 读取远程文件文本（超过 maxReadBytes 截断）。 */
  readFile(path: string): Promise<RemoteFileContent>
  /** 写入远程文件（按需创建父目录）。 */
  writeFile(path: string, content: string): Promise<{ size: number; mtimeMs: number }>
  /** 创建远程目录。 */
  mkdir(path: string): Promise<void>
  /** 删除远程文件或空目录。 */
  remove(path: string): Promise<void>
  /** 重命名/移动远程路径。 */
  rename(from: string, to: string): Promise<void>
  /** 获取底层 SFTP 子系统句柄（fs-ssh 能力适配器直接消费，对应 e2b 的 sandbox.files）。 */
  getSftp(): Promise<import('ssh2').SFTPWrapper>
}

/**
 * 创建唯一可消费的 SSH 连接句柄，并在连接超时或 Service 卸载时释放全部
 * 连接。与 E2B 不同：连接目标由会话首轮决定，故 connect() 惰性建立 ready；
 * 适配器在任何首次操作前 await getConnection()。
 */
export class SshRuntime extends Service {
  static Config: z<Config> = Config

  private readonly engine_: SshEngine
  private readonly store: HostStore
  /** 当前激活目标（'' = 未连接）。 */
  private activeAlias = ''
  private disposed = false
  /** 惰性连接句柄：connect() 建立，getConnection() 复用同一引用。 */
  private ready: Promise<SshConnection> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    // schemastery 在构造前已填充默认值；类型不编码该步骤。
    const storeFile = config.storeFile === '' ? undefined : config.storeFile
    this.store = new HostStore(storeFile)
    this.engine_ = new SshEngine(this.store, {
      idleTimeoutMs: config.idleTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      keepaliveIntervalMs: config.keepaliveIntervalMs,
      maxOutputBytes: config.maxOutputBytes,
      defaultExecTimeoutMs: config.defaultExecTimeoutMs,
      maxReadBytes: config.maxReadBytes,
    })
    ctx.effect(() => async () => {
      this.disposed = true
      // 等待连接建立完成（或失败），随后释放所有连接与定时器。
      try {
        await this.ready
      } catch {
        // 连接未建立或已失败，无需处置。
      }
      this.engine_.dispose()
    }, 'ssh runtime teardown')
  }

  // ------------------------------------------------------------ connection

  /**
   * 底层引擎只读句柄（供 ssh_* 工具消费：连接池 / ProxyJump / exec / SFTP
   * 全量能力。所有适配器仍经 getConnection() 走单目标语义，二者共享同一引擎）。
   */
  get engine(): SshEngine {
    return this.engine_
  }

  /** 将某个已存主机设为当前激活目标并建立连接（可重复调用以切换）。 */
  async connect(alias: string): Promise<WorkspaceStatus> {
    if (this.disposed) throw new Error('ssh runtime is disposing')
    this.activeAlias = alias
    const status = await this.engine_.connect(alias)
    this.ready = this.openConnection()
    // 失败的连接保持可观察；getConnection() 仍返回该错误（或下次重连）。
    void this.ready.catch(() => {})
    return status
  }

  /** 解除当前激活目标（连接由 engine 按空闲策略回收）。 */
  disconnect(): WorkspaceStatus {
    this.activeAlias = ''
    this.ready = undefined
    return this.engine_.disconnect()
  }

  /** 当前连接状态快照（ssh_status 数据源）。 */
  status(): WorkspaceStatus {
    return this.engine_.status()
  }

  /**
   * 返回共享连接句柄。首次调用建立连接并缓存句柄；底层连接 broken 时自动
   * 重建（openConnection 内 engine.ensureConnection 重建 + 重解析 home）。
   * @throws 当无激活目标或 Service 正在卸载时。
   */
  async getConnection(): Promise<SshConnection> {
    if (this.disposed) throw new Error('ssh runtime is disposing')
    // 句柄缺失或底层连接已 broken → 重新建立。
    if (this.ready === undefined || this.engine_.isBroken(this.activeAlias)) {
      this.ready = this.openConnection()
    }
    const connection = await this.ready
    // 等待句柄期间可能发生 disposal：同步预检通过仍需复查。
    if (this.disposed) throw new Error('ssh runtime is disposing')
    return connection
  }

  // ----------------------------------------------------------- host store

  /** 已存主机（secret-free 摘要）。 */
  listHosts(query?: string) {
    return this.engine_.list(query)
  }

  /** 单个主机摘要。 */
  getHost(alias: string) {
    return this.engine_.get(alias)
  }

  /** 创建或更新主机。 */
  upsertHost(payload: HostPayload, existingAlias?: string) {
    return this.engine_.upsertHost(payload, existingAlias)
  }

  /** 删除主机（若为激活目标则先断开）。 */
  removeHost(alias: string): boolean {
    return this.engine_.removeHost(alias)
  }

  /** 从 ~/.ssh/config 导入主机。 */
  importSshConfig() {
    return this.engine_.importSshConfig()
  }

  // -------------------------------------------------------------- internal

  /** 建立（或复用）指向当前激活目标的连接句柄。 */
  private async openConnection(): Promise<SshConnection> {
    const alias = this.activeAlias
    if (alias === '') throw new Error('ssh runtime: no active connection; call connect(alias) first')
    await this.engine_.ensureConnection(alias)
    await this.engine_.resolveHome(alias)
    return this.wrap(alias)
  }

  /** 将激活目标绑定为消费者句柄（隐藏 alias，固定单目标语义）。 */
  private wrap(alias: string): SshConnection {
    const engine = this.engine
    return {
      get alias() {
        return alias
      },
      get home() {
        return engine.status().home
      },
      exec: (command, options) => engine.exec(alias, command, options),
      execChannel: (command, options) => engine.openChannel(alias, command, options),
      openShell: (cols, rows) => engine.openShell(alias, cols, rows),
      ls: (path) => engine.ls(alias, path),
      readFile: (path) => engine.readFile(alias, path),
      writeFile: (path, content) => engine.writeFile(alias, path, content),
      mkdir: (path) => engine.mkdir(alias, path),
      remove: (path) => engine.remove(alias, path),
      rename: (from, to) => engine.rename(alias, from, to),
      getSftp: () => engine.getSftp(alias),
    }
  }
}

export default SshRuntime
