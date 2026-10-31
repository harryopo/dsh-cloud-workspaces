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
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
import { SshEngine } from './engine';
import type { SshExecChannel, ShellSession } from './engine';
import type { ExecResult, RemoteDirEntry, RemoteFileContent, WorkspaceStatus } from './protocol';
import type { HostPayload } from './protocol';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 共享 SSH 连接生命周期所有者（本 Service）。 */
        ssh: SshRuntime;
    }
}
/** 连接生命周期配置（引擎旋钮 + 存储位置）。 */
export interface Config {
    /** 空闲连接回收超时（ms）。 */
    idleTimeoutMs?: number;
    /** SSH 握手超时（ms）。 */
    connectTimeoutMs?: number;
    /** Keepalive 心跳间隔（ms）。 */
    keepaliveIntervalMs?: number;
    /** 单次 exec 捕获输出上限（字节）。 */
    maxOutputBytes?: number;
    /** 默认 exec 超时（ms）。 */
    defaultExecTimeoutMs?: number;
    /** 远程文件读入上限（字节）。 */
    maxReadBytes?: number;
    /** 主机配置存储文件路径（空串 = 默认 ~/.dsh/dsh-remote-ide.json，测试可覆盖）。 */
    storeFile?: string;
}
export declare const Config: z<Config>;
/**
 * 消费者（fs-ssh / subprocess-ssh）持有的稳定连接句柄。alias 被隐藏：
 * 单会话单目标语义下，句柄上的每个操作都作用于当前激活连接。
 */
export interface SshConnection {
    /** 激活目标的 alias。 */
    readonly alias: string;
    /** 远程 $HOME（未解析或未连接时为 undefined）。 */
    readonly home: string | undefined;
    /** 在当前连接上执行一条非交互命令。 */
    exec(command: string, options?: {
        timeoutMs?: number;
        cwd?: string;
    }): Promise<ExecResult>;
    /** 打开一个低层流式命令通道（subprocess-ssh 的 wrapper 传输）。 */
    execChannel(command: string, options?: {
        cwd?: string;
    }): Promise<SshExecChannel>;
    /** 打开一个 PTY shell 会话。 */
    openShell(cols: number, rows: number): Promise<ShellSession>;
    /** 列出远程目录。 */
    ls(path: string): Promise<RemoteDirEntry[]>;
    /** 读取远程文件文本（超过 maxReadBytes 截断）。 */
    readFile(path: string): Promise<RemoteFileContent>;
    /** 写入远程文件（按需创建父目录）。 */
    writeFile(path: string, content: string): Promise<{
        size: number;
        mtimeMs: number;
    }>;
    /** 创建远程目录。 */
    mkdir(path: string): Promise<void>;
    /** 删除远程文件或空目录。 */
    remove(path: string): Promise<void>;
    /** 重命名/移动远程路径。 */
    rename(from: string, to: string): Promise<void>;
    /** 获取底层 SFTP 子系统句柄（fs-ssh 能力适配器直接消费，对应 e2b 的 sandbox.files）。 */
    getSftp(): Promise<import('ssh2').SFTPWrapper>;
}
/**
 * 创建唯一可消费的 SSH 连接句柄，并在连接超时或 Service 卸载时释放全部
 * 连接。与 E2B 不同：连接目标由会话首轮决定，故 connect() 惰性建立 ready；
 * 适配器在任何首次操作前 await getConnection()。
 */
export declare class SshRuntime extends Service {
    static Config: z<Config>;
    private readonly engine_;
    private readonly store;
    /** 当前激活目标（'' = 未连接）。 */
    private activeAlias;
    private disposed;
    /** 惰性连接句柄：connect() 建立，getConnection() 复用同一引用。 */
    private ready;
    constructor(ctx: Context, config: Config);
    /**
     * 底层引擎只读句柄（供 ssh_* 工具消费：连接池 / ProxyJump / exec / SFTP
     * 全量能力。所有适配器仍经 getConnection() 走单目标语义，二者共享同一引擎）。
     */
    get engine(): SshEngine;
    /** 将某个已存主机设为当前激活目标并建立连接（可重复调用以切换）。 */
    connect(alias: string): Promise<WorkspaceStatus>;
    /** 解除当前激活目标（连接由 engine 按空闲策略回收）。 */
    disconnect(): WorkspaceStatus;
    /** 当前连接状态快照（ssh_status 数据源）。 */
    status(): WorkspaceStatus;
    /**
     * 返回共享连接句柄。首次调用建立连接并缓存句柄；底层连接 broken 时自动
     * 重建（openConnection 内 engine.ensureConnection 重建 + 重解析 home）。
     * @throws 当无激活目标或 Service 正在卸载时。
     */
    getConnection(): Promise<SshConnection>;
    /**
     * 返回指定主机的连接句柄，且不切换激活目标（占位工作区多主机路由用：
     * 会话 cwd 落在 ~/.dsh/remote/<hostId>/… 时，适配器按 hostId 取句柄，
     * 与 ssh_* 工具的 activeAlias 互不干扰，二者共享同一 engine 连接池）。
     * @throws 主机不存在或 Service 正在卸载时。
     */
    getConnectionFor(alias: string): Promise<SshConnection>;
    /** 已存主机（secret-free 摘要）。 */
    listHosts(query?: string): import("./protocol").SshHostSummary[];
    /** 单个主机摘要。 */
    getHost(alias: string): import("./protocol").SshHostSummary | undefined;
    /** 完整已存条目（含口令）——仅 host 平面内部使用（typert 补回口令），绝不进 wire 面。 */
    getStoredEntry(alias: string): import("./protocol").SshHostEntry | undefined;
    /** 创建或更新主机。 */
    upsertHost(payload: HostPayload, existingAlias?: string): import("./protocol").SshHostEntry;
    /** 删除主机（若为激活目标则先断开）。 */
    removeHost(alias: string): boolean;
    /** 从 ~/.ssh/config 导入主机。 */
    importSshConfig(): import("./protocol").ImportResult;
    /** 建立（或复用）指向当前激活目标的连接句柄。 */
    private openConnection;
    /** 将激活目标绑定为消费者句柄（隐藏 alias，固定单目标语义）。 */
    private wrap;
}
export default SshRuntime;
