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
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { SshRuntime } from './ssh-service'
import { hostsOf, redactHosts, secretFlags, toHostPayload, type SshHostConfig } from './host-settings'
import { createPlaceholderDir, listPlaceholders } from './workspace'

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
    hostInvocation('testConnection', ['cfg']),
    hostInvocation('listRemoteDir', ['hostId', 'path']),
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

/** 端点结果统一形状。 */
export type EndpointResult<T> = { ok: true; value: T } | { ok: false; error: string }

function ok<T>(value: T): EndpointResult<T> {
  return { ok: true, value }
}
function err(error: unknown): EndpointResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * 设置卡片的远程服务。方法即端点（位置参数，与描述符 parameters 一一对应），
 * 返回值 JSON-safe；bindTypertRemote 绑定是 gateway validateBinding 的硬要求。
 */
export class SshRemoteService extends Service {
  private readonly runtime: SshRuntime
  private settingsScope: SettingsScope<{ hosts: Record<string, SshHostConfig> }> | undefined
  /** 绑定声明——gateway validateBinding 按此反射名检查，不可改名。 */
  readonly typertRemote: unknown

  constructor(ctx: Context, runtime: SshRuntime) {
    super(ctx, REMOTE_SERVICE)
    this.runtime = runtime
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
  listHosts(): EndpointResult<{ hosts: Record<string, Omit<SshHostConfig, 'password'>>; secrets: Record<string, boolean> }> {
    try {
      const hosts = this.hosts()
      return ok({ hosts: redactHosts(hosts), secrets: secretFlags(hosts) })
    } catch (error) {
      return err(error)
    }
  }

  /** 创建或更新主机：写 settings + 桥接 store。口令留空 = 保持已存。 */
  async saveHost(id: string, patch: Partial<SshHostConfig>): Promise<EndpointResult<{ id: string }>> {
    try {
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
        return { ok: false, error: 'host and user are required' }
      }
      const hosts = { ...current, [id]: next }
      await this.settings.update({ hosts })
      this.syncStore()
      return ok({ id })
    } catch (error) {
      return err(error)
    }
  }

  /** 删除主机：settings unset + store 断开删除。 */
  async deleteHost(id: string): Promise<EndpointResult<{ id: string }>> {
    try {
      const current = this.hosts()
      if (current[id] === undefined) return { ok: false, error: `host not found: ${id}` }
      const hosts = { ...current }
      delete hosts[id]
      await this.settings.update({ hosts })
      this.runtime.engine.removeHost(id)
      return ok({ id })
    } catch (error) {
      return err(error)
    }
  }

  /** 测试连接：用表单配置直连探测（不经 store，未保存也能测）。 */
  async testConnection(cfg: {
    host: string
    port?: number
    user: string
    authType?: 'key' | 'password'
    privateKeyPath?: string
    password?: string
    proxyJump?: string[]
  }): Promise<EndpointResult<{ ok: boolean; latencyMs?: number; error?: string }>> {
    try {
      const result = await this.runtime.engine.testConfig({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        auth: cfg.authType === 'password'
          ? { kind: 'password', password: cfg.password }
          : { kind: 'key', keyPath: cfg.privateKeyPath },
        proxyJump: cfg.proxyJump,
      })
      return ok({ ok: result.ok, latencyMs: result.latencyMs, error: result.error })
    } catch (error) {
      return err(error)
    }
  }

  /** 列远端目录（工作区创建浏览；需主机已在 store，未保存先桥接）。 */
  async listRemoteDir(hostId: string, path: string): Promise<EndpointResult<unknown>> {
    try {
      this.syncStore()
      const entries = await this.runtime.engine.ls(hostId, path)
      return ok(entries)
    } catch (error) {
      return err(error)
    }
  }

  /** 创建占位工作区（返回本地占位路径，供用户选为 DSH 工作区）。 */
  async createPlaceholder(hostId: string, remotePath: string): Promise<EndpointResult<{ localPath: string; hostId: string; remotePath: string }>> {
    try {
      this.syncStore()
      const created = await createPlaceholderDir({ hostId, remotePath })
      return ok(created)
    } catch (error) {
      return err(error)
    }
  }

  /** 列出全部占位工作区。 */
  async listPlaceholders(): Promise<EndpointResult<Array<{ hostId: string; remotePath: string; localPath: string }>>> {
    try {
      const listed = await listPlaceholders()
      return ok(listed.map(w => ({ hostId: w.hostId, remotePath: w.remotePath, localPath: w.localPath })))
    } catch (error) {
      return err(error)
    }
  }
}
