/**
 * dsh-remote-ide — 占位工作区映射（placeholder workspace router）。
 *
 * 语义复刻自 dsh-ssh/dsh-ssh（MIT，github.com/dsh-ssh/dsh-ssh，src/router.js）：
 * 一个「远程工作区」在本地只是一个占位目录——
 *   占位根   remoteRoot() = <$DSH_HOME || ~/.dsh>/remote
 *   占位路径 = <root>/<hostId>/<base64url(远程绝对路径)>
 *     （恰好两段：hostId + 单段可逆编码）
 * DSH 把占位目录当普通本地工作区（会话 cwd 落在里面）；适配器
 * （fs-ssh / subprocess-ssh）按 cwd 前缀路由到对应主机并把相对路径
 * 重锚定到远程目录。编码可逆（base64url 无 padding 单段）；hostId 校验
 * 拒绝路径穿越；解码必须还原为以 '/' 开头的绝对路径。
 *
 * 纯函数 + 两个窄口 IO（mkdir / 读 manifest）：单测可注入 fsImpl/env。
 */
import fs from 'node:fs';
/** 占位目录内的清单文件名（增强可诊断性：目录名即不依赖也能路由）。 */
export declare const MANIFEST_NAME = ".dsh-remote-workspace.json";
/** 环境覆盖优先级：DSH_REMOTE_ROOT > $DSH_HOME/remote > ~/.dsh/remote。 */
export declare function remoteRoot(env?: NodeJS.ProcessEnv): string;
/** hostId 必须是安全的单段目录名：字母数字开头，可含 . _ -，且不为 . / ..。 */
export declare function isValidHostId(hostId: unknown): hostId is string;
/** 远程绝对路径 → base64url（无 padding）：单段、不含 '/'。 */
export declare function encodeRemotePath(remotePath: string): string;
/** base64url → 原字符串；非法/非规范输入返回 null（可逆性守卫）。 */
export declare function decodeRemotePath(encoded: unknown): string | null;
/** 远程路径 → 本地占位路径。hostId 非法时返回 null。 */
export declare function mapRemoteToLocal(hostId: string, remotePath: string, env?: NodeJS.ProcessEnv): string | null;
/**
 * 本地路径 → { hostId, remotePath } | null。要求恰好两段
 * <root>/<hostId>/<encoded>，且 encoded 可解码为 '/' 开头的绝对路径
 * （可逆、无穿越；碰巧同形的真实本地目录不会被误判）。
 */
export declare function mapLocalToRemote(localPath: unknown, env?: NodeJS.ProcessEnv): {
    hostId: string;
    remotePath: string;
} | null;
/** 路由入口：会话 cwd 恰为占位路径 → remote；否则 local（绝不抛错）。 */
export declare function routeByCwd(cwd: unknown, env?: NodeJS.ProcessEnv): {
    kind: 'local';
} | {
    kind: 'remote';
    hostId: string;
    remoteCwd: string;
};
/**
 * 远程路径解析：相对路径基于 remoteCwd；占位工作区内的绝对路径（Windows
 * 本地形态 <placeholderCwd>/...）重锚定回远程；其余绝对路径按远程绝对路径
 * 处理（词法规范化，折叠 ./../ 与重复斜杠——与官方 dsh-fs-sandbox 的
 * containment 威胁模型一致，不做 symlink 解析）。
 */
export declare function resolveRemotePath(requestedPath: string, remoteCwd: string, placeholderCwd?: string): string;
/** 占位清单内容（写入占位目录，供诊断与未来目录名策略演进）。 */
export interface WorkspaceManifest {
    hostId: string;
    remotePath: string;
    createdAt: string;
}
/**
 * 创建占位目录并写入清单（幂等：recursive mkdir + 覆盖写）。
 * hostId/remotePath 非法时抛错；fs 错误原样上抛由调用者包装。
 */
export declare function createPlaceholderDir({ hostId, remotePath, env, fsImpl, now }: {
    hostId: string;
    remotePath: string;
    env?: NodeJS.ProcessEnv;
    fsImpl?: typeof fs;
    now?: Date;
}): Promise<{
    localPath: string;
    hostId: string;
    remotePath: string;
}>;
/** 读取占位清单；缺失/损坏返回 null（目录名编码是兜底路由依据）。 */
export declare function readManifest(localPath: string, fsImpl?: typeof fs): Promise<WorkspaceManifest | null>;
/** 列出全部占位工作区（root 下逐 hostId 目录；目录名解码 + manifest 双源）。 */
export declare function listPlaceholders(env?: NodeJS.ProcessEnv, fsImpl?: typeof fs): Promise<Array<{
    localPath: string;
    hostId: string;
    remotePath: string;
}>>;
