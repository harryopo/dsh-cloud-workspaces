/**
 * dsh-remote-ide — 设置卡片的 Typert 远程端点（host 半）。
 *
 * 官方跨半 RPC 通道（dsh-api-gateway + dsh-typert-registry + dsh-typert-protocol）：
 * host 半注册严格描述符（face:'host' + invocations，codec 用 src-json，
 * 真实校验在 settings schema / engine 内）到 ctx.typert.register；服务实例
 * 用 bindTypertRemote 提供 typertRemote 绑定（gateway validateBinding 的
 * 硬要求）。client 半 $mount 同形描述符（strict passthrough codec）后得到
 * ctx.remote.ssh-remote.<method>()。业务失败用返回值表达（gateway 只透传
 * error.message，结构化字段会丢）。
 *
 * 端点面 = 设置卡片的全部数据能力：主机 CRUD（读写 settings + 桥接
 * HostStore）、测试连接（engine.testConfig 直连探测）、远端目录浏览与
 * 占位工作区创建（复用 workspace.ts 与 engine.ls）。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import type { SshRuntime } from './ssh-service'
import { HOSTS_NAMESPACE, hostsOf, redactHosts, secretFlags, toHostPayload, type SshHostConfig } from './host-settings'
import { createPlaceholderDir, listPlaceholders } from './workspace'
import { jsonSafe } from './jsonsafe'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** ctx.workspaceRegistry 的形状（可选服务，经 ctx.get 读取，无 inject 要求）。 */
type WorkspaceRegistryLike = Pick<WorkspaceRegistry, 'create'> | undefined

/** npm 包名（描述符 id 前缀）。 */
export const REMOTE_PACKAGE = 'dsh-remote-ide'
/** Cordis service key。 */
export const REMOTE_SERVICE = 'ssh-remote'
/** wire 命名空间（client 侧 ctx.remote.<ns>.<method>）。 */
export const REMOTE_NAMESPACE = 'ssh-remote'

const SRC_JSON: TypertCodec = { mode: 'src-json' }

/** 一个 host 半 invocation 描述符（strict local 注册表形状）。 */
export interface HostInvocation {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: Array<{ name: string; wire: string; source: 'json'; codec: TypertCodec }>
  result: TypertCodec
}

function hostInvocation(method: string, parameters: string[]): HostInvocation {
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({ name, wire: name, source: 'json', codec: SRC_JSON })),
    result: SRC_JSON,
  }
}

/**
 * 网关边界校验（assertJsonValue）要求业务结果纯 JSON-safe：显式赋值的
 * `error: undefined` 也是 own property，网关直接拒绝（"business result
 * failed boundary validation"）。实现移至 ./jsonsafe（工具输出同用），
 * 此处 re-export 保持既有导入路径。
 */
export { jsonSafe } from './jsonsafe'

/** host 半贡献（ctx.typert.register 消费；face:'host' + invocations）。 */
export interface HostTypertContribution {
  package: string
  face: 'host'
  schemas: unknown[]
  invocations: HostInvocation[]
  model: undefined
}

/** host 半贡献：参数名（wire）与 SshRemoteService 方法参数一一对应。 */
export const HOST_TYPERT_CONTRIBUTION: HostTypertContribution = {
  package: REMOTE_PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    hostInvocation('listHosts', []),
    hostInvocation('saveHost', ['id', 'patch']),
    hostInvocation('deleteHost', ['id']),
    hostInvocation('testConnection', ['hostId', 'cfg']),
    hostInvocation('listRemoteDir', ['hostId', 'path']),
    hostInvocation('mkdirRemote', ['hostId', 'path']),
    hostInvocation('removeRemote', ['hostId', 'path']),
    hostInvocation('createPlaceholder', ['hostId', 'remotePath']),
    hostInvocation('listPlaceholders', []),
  ],
  model: undefined,
}

/** 类型扩展：TypertRegistryContract 未导出 register，运行时存在。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRegistryContract {
    register(contribution: HostTypertContribution): () => void
  }
}

/**
 * 设置卡片的远程服务。方法即端点（位置参数，与描述符 parameters 一一对应）。
 * ⚠️ 端点返回**裸业务值**：gateway 已用 {ok, value} 表达调用成败，若端点再
 * 自包一层 {ok, value} 会让 client 收到双层包装（unwrap 只解一层）。
 * 业务失败直接 throw（gateway 捕获转 {ok:false, error:{message}}）。
 * bindTypertRemote 绑定是 gateway validateBinding 的硬要求。
 */
export class SshRemoteService extends Service {
  private readonly runtime: SshRuntime
  /** 宿主 ctx（workspaceRegistry 等可选服务经 ctx.get 读取）。 */
  private readonly runtimeCtx: Context
  private settingsScope: SettingsScope<{ hosts: Record<string, SshHostConfig> }> | undefined
  /** provider 级句柄（scope 无 mutate；单键 unset 需 ctx.settings.mutate）。 */
  private readonly settingsProvider: SettingsProvider
  /** 绑定声明——gateway validateBinding 按此反射名检查，不可改名。 */
  readonly typertRemote: unknown

  constructor(ctx: Context, runtime: SshRuntime) {
    super(ctx, REMOTE_SERVICE)
    this.runtime = runtime
    this.runtimeCtx = ctx
    this.settingsProvider = ctx.settings
    this.typertRemote = bindTypertRemote(this, REMOTE_SERVICE)
  }

  /** 注入 settings scope（index.ts 的 inject 段在构造后立即调用）。 */
  setSettings(scope: SettingsScope<{ hosts: Record<string, SshHostConfig> }>): void {
    this.settingsScope = scope
  }

  private get settings(): SettingsScope<{ hosts: Record<string, SshHostConfig> }> {
    if (this.settingsScope === undefined) throw new Error('ssh-remote: settings scope not injected yet')
    return this.settingsScope
  }

  private hosts(): Record<string, SshHostConfig> {
    return hostsOf(this.settings.get())
  }

  /** 桥接当前 settings 主机进 HostStore（ssh_* 工具与占位路由立即可用）。 */
  private syncStore(): void {
    for (const cfg of Object.values(this.hosts())) {
      try {
        this.runtime.engine.upsertHost(toHostPayload(cfg), cfg.id)
      } catch {
        // 主机残缺（表单未提交完整）→ 跳过，不影响其它主机。
      }
    }
  }

  // ------------------------------------------------------------ endpoints

  /** 列出全部主机（脱敏）+ 口令已设标记。 */
  listHosts(): { hosts: Record<string, Omit<SshHostConfig, 'password'>>; secrets: Record<string, boolean> } {
    return jsonSafe({ hosts: redactHosts(this.hosts()), secrets: secretFlags(this.hosts()) })
  }

  /** 创建或更新主机：写 settings + 桥接 store。口令留空 = 保持已存。 */
  async saveHost(id: string, patch: Partial<SshHostConfig>): Promise<{ id: string }> {
    const current = this.hosts()
    const prev = current[id]
    const next: SshHostConfig = {
      id,
      name: patch.name ?? prev?.name,
      host: (patch.host ?? prev?.host ?? '').trim(),
      port: patch.port ?? prev?.port ?? 22,
      user: (patch.user ?? prev?.user ?? '').trim(),
      authType: patch.authType ?? prev?.authType ?? 'key',
      privateKeyPath: patch.privateKeyPath ?? prev?.privateKeyPath,
      // write-only：只有提交了新口令才覆盖，否则沿用已存值。
      password: typeof patch.password === 'string' && patch.password !== ''
        ? patch.password
        : prev?.password,
      proxyJump: patch.proxyJump ?? prev?.proxyJump,
      description: patch.description ?? prev?.description,
    }
    if (next.host === '' || next.user === '') {
      throw new Error('host and user are required')
    }
    const hosts = { ...current, [id]: next }
    await this.settings.update({ hosts })
    this.syncStore()
    return { id }
  }

  /** 删除主机：settings 单键 unset + store 断开删除。 */
  async deleteHost(id: string): Promise<{ id: string }> {
    const current = this.hosts()
    if (current[id] === undefined) throw new Error(`host not found: ${id}`)
    // settings.mutate 单键 unset（scope.update 是递归 merge，删不掉键）。
    await this.settingsProvider.mutate(HOSTS_NAMESPACE, [{ op: 'unset', path: ['hosts', id] }])
    this.runtime.engine.removeHost(id)
    return { id }
  }

  /**
   * 测试连接：用表单配置直连探测。对已保存主机（hostId 非空），密码/密钥
   * 从 settings 补回（UI 拿到的是脱敏视图，password 已被剥离——测试不带
   * 密码必然 "All configured authentication methods failed"）。
   */
  async testConnection(hostId: string, cfg: {
    host: string
    port?: number
    user: string
    authType?: 'key' | 'password'
    privateKeyPath?: string
    password?: string
    proxyJump?: string[]
  }): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    let password = cfg.password
    let privateKeyPath = cfg.privateKeyPath
    if (hostId !== '') {
      const stored = this.hosts()[hostId]
      if (stored !== undefined) {
        if (stored.authType === 'password' && (password === undefined || password === '')) {
          password = stored.password
        }
        if (stored.authType === 'key' && (privateKeyPath === undefined || privateKeyPath === '')) {
          privateKeyPath = stored.privateKeyPath
        }
      }
    }
    const result = await this.runtime.engine.testConfig({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      auth: cfg.authType === 'password' || (hostId !== '' && this.hosts()[hostId]?.authType === 'password')
        ? { kind: 'password', password }
        : { kind: 'key', keyPath: privateKeyPath },
      proxyJump: cfg.proxyJump,
    })
    // 成功时 error === undefined：必须剥离，否则网关边界校验拒绝整个结果。
    return jsonSafe({ ok: result.ok, latencyMs: result.latencyMs, error: result.error })
  }

  /** 列远端目录（工作区创建浏览；需主机已在 store，未保存先桥接）。 */
  async listRemoteDir(hostId: string, path: string): Promise<unknown> {
    this.syncStore()
    return jsonSafe(await this.runtime.engine.ls(hostId, path))
  }

  /** 在远端创建目录（递归创建父级）。 */
  async mkdirRemote(hostId: string, path: string): Promise<{ path: string }> {
    this.syncStore()
    await this.runtime.engine.mkdir(hostId, path)
    return { path }
  }

  /** 删除远端文件或空目录（非空目录请先清空内容）。 */
  async removeRemote(hostId: string, path: string): Promise<{ path: string }> {
    this.syncStore()
    await this.runtime.engine.remove(hostId, path)
    return { path }
  }

  /** 创建占位工作区（返回本地占位路径，供用户选为 DSH 工作区）。 */
  async createPlaceholder(hostId: string, remotePath: string): Promise<{ localPath: string; hostId: string; remotePath: string }> {
    this.syncStore()
    const created = await createPlaceholderDir({ hostId, remotePath })
    // 注册进 registry 只是「出现在选择列表」的锦上添花，绝不阻塞端点：
    // registry 启动依赖 sessionPersistence 完成引导，在部分作用域可能永远
    // 未就绪——await 它会让端点无限挂起（真机「卡退」的根因）。选择器流程
    // 由官方收养（onPicked → createWorkspace），这里的注册是设置页流程的补充。
    void this.registerWorkspace(created.localPath, `${hostId} / ${remotePath.split('/').filter(Boolean).pop() || 'root'}`)
    return created
  }

  /** 后台注册占位目录进 DSH 工作区注册表（5s 超时；失败静默——目录本身已可用）。 */
  private async registerWorkspace(localPath: string, title: string): Promise<void> {
    try {
      const registry = await Promise.race([
        Promise.resolve(this.runtimeCtx.get('workspaceRegistry') as WorkspaceRegistryLike),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
      ])
      if (registry !== undefined && typeof registry.create === 'function') {
        await registry.create(localPath, title)
      }
    } catch {
      // 注册失败不影响占位目录本身（用户仍可手动添加路径）。
    }
  }

  /** 列出全部占位工作区。 */
  async listPlaceholders(): Promise<Array<{ hostId: string; remotePath: string; localPath: string }>> {
    const listed = await listPlaceholders()
    return listed.map(w => ({ hostId: w.hostId, remotePath: w.remotePath, localPath: w.localPath }))
  }
}
