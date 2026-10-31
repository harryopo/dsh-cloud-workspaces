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
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol';
import type { SshRuntime } from './ssh-service';
import type { SshHostConfig } from './protocol';
/**
 * 后台注册占位目录进 DSH 工作区注册表（5s 超时；失败静默——目录本身已可用）。
 *
 * 注册只是「出现在选择列表」的锦上添花，绝不阻塞调用方：registry 启动依赖
 * sessionPersistence 完成引导，在部分作用域可能永远未就绪——await 它会让
 * 端点/工具无限挂起（真机「卡退」的根因）。选择器流程由官方收养
 * （onPicked → createWorkspace），这里的注册是补充。
 *
 * 端点与 ssh_workspace 工具共用本函数，保证两条创建路径行为一致。
 */
export declare function registerPlaceholderWorkspace(ctx: Context, localPath: string, title: string): Promise<void>;
/** 占位工作区在注册表里的展示标题：<host> / <末段目录名>。 */
export declare function placeholderTitle(hostId: string, remotePath: string): string;
/** npm 包名（描述符 id 前缀）。 */
export declare const REMOTE_PACKAGE = "dsh-remote-ide";
/** Cordis service key。 */
export declare const REMOTE_SERVICE = "ssh-remote";
/** wire 命名空间（client 侧 ctx.remote.<ns>.<method>）。 */
export declare const REMOTE_NAMESPACE = "ssh-remote";
/** 一个 host 半 invocation 描述符（strict local 注册表形状）。 */
export interface HostInvocation {
    id: string;
    service: string;
    namespace: string;
    method: string;
    invocation: {
        kind: 'direct';
    };
    parameters: Array<{
        name: string;
        wire: string;
        source: 'json';
        codec: TypertCodec;
    }>;
    result: TypertCodec;
}
/**
 * 网关边界校验（assertJsonValue）要求业务结果纯 JSON-safe：显式赋值的
 * `error: undefined` 也是 own property，网关直接拒绝（"business result
 * failed boundary validation"）。实现移至 ./jsonsafe（工具输出同用），
 * 此处 re-export 保持既有导入路径。
 */
export { jsonSafe } from './jsonsafe';
/** host 半贡献（ctx.typert.register 消费；face:'host' + invocations）。 */
export interface HostTypertContribution {
    package: string;
    face: 'host';
    schemas: unknown[];
    invocations: HostInvocation[];
    model: undefined;
}
/** host 半贡献：参数名（wire）与 SshRemoteService 方法参数一一对应。 */
export declare const HOST_TYPERT_CONTRIBUTION: HostTypertContribution;
/** 类型扩展：TypertRegistryContract 未导出 register，运行时存在。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRegistryContract {
        register(contribution: HostTypertContribution): () => void;
    }
}
/**
 * 设置卡片的远程服务。方法即端点（位置参数，与描述符 parameters 一一对应）。
 * ⚠️ 端点返回**裸业务值**：gateway 已用 {ok, value} 表达调用成败，若端点再
 * 自包一层 {ok, value} 会让 client 收到双层包装（unwrap 只解一层）。
 * 业务失败直接 throw（gateway 捕获转 {ok:false, error:{message}}）。
 * bindTypertRemote 绑定是 gateway validateBinding 的硬要求。
 */
export declare class SshRemoteService extends Service {
    private readonly runtime;
    /** 宿主 ctx（workspaceRegistry 等可选服务经 ctx.get 读取）。 */
    private readonly runtimeCtx;
    /** 绑定声明——gateway validateBinding 按此反射名检查，不可改名。 */
    readonly typertRemote: unknown;
    constructor(ctx: Context, runtime: SshRuntime);
    /** store 里的摘要（0.2 起主机元数据唯一来源 = 0600 store）。 */
    private summary;
    /** 把 store 摘要投影成 client 表单形状（不携带任何口令）。 */
    private toConfig;
    /** 列出全部主机（脱敏）+ 口令已设标记（直接从 0600 store 读取）。 */
    listHosts(): {
        hosts: Record<string, Omit<SshHostConfig, 'password'>>;
        secrets: Record<string, boolean>;
    };
    /**
     * 创建或更新主机：唯一写路径 = 0600 的 dsh-remote-ide.json。
     * 口令留空 = 沿用 store 既有口令。
     */
    saveHost(id: string, patch: Partial<SshHostConfig>): Promise<{
        id: string;
    }>;
    /** 删除主机（store 唯一写路径）。 */
    deleteHost(id: string): Promise<{
        id: string;
    }>;
    /**
     * 测试连接：用表单配置直连探测。对已保存主机（hostId 非空），密码/密钥
     * 从 0600 store 补回（UI 拿到的是脱敏视图，password 已被剥离——测试不带
     * 密码必然 "All configured authentication methods failed"）。
     */
    testConnection(hostId: string, cfg: {
        host: string;
        port?: number;
        user: string;
        authType?: 'key' | 'password';
        privateKeyPath?: string;
        password?: string;
        proxyJump?: string[];
    }): Promise<{
        ok: boolean;
        latencyMs?: number;
        error?: string;
    }>;
    /** 列远端目录（工作区创建浏览；需主机已在 store，未保存先桥接）。 */
    listRemoteDir(hostId: string, path: string): Promise<unknown>;
    /** 在远端创建目录（递归创建父级）。 */
    mkdirRemote(hostId: string, path: string): Promise<{
        path: string;
    }>;
    /** 删除远端文件或空目录（非空目录请先清空内容）。 */
    removeRemote(hostId: string, path: string): Promise<{
        path: string;
    }>;
    /** 创建占位工作区（返回本地占位路径，供用户选为 DSH 工作区）。 */
    createPlaceholder(hostId: string, remotePath: string): Promise<{
        localPath: string;
        hostId: string;
        remotePath: string;
    }>;
    /** 列出全部占位工作区。 */
    listPlaceholders(): Promise<Array<{
        hostId: string;
        remotePath: string;
        localPath: string;
    }>>;
}
