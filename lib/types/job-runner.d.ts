/**
 * dsh-remote-ide — 远程后台任务生产者（ctx.jobs seam 的 SSH 实现）。
 *
 * 设计（docs/07）：registry 永不下远程（官方 E2B 先例），远程性=本模块。
 * 常驻 exec 通道跑 wrapper `printf %s $$ > pidfile && exec bash -c '<cmd>' > log 2>&1`
 * ——sshd 为每条通道建独立进程组，`$$`（exec 前后不变）即 pgid。
 * - done：通道 close 的 (code, signal) 是唯一权威退出事实（零轮询）；
 *   非零码=completed+detail（对齐官方），signal=killed，无码无号=传输断，
 *   探测 kill -0 后如实报告孤儿可能（pid/log 路径），不谎称工作已停。
 * - 输出：0.2 采用**推模式**——3s dd 增量泵读到新字节即 job.append()（拉取式
 *   readOutput 已在 0.2 删除）；块对齐读取无 UTF-8 游标劈裂的系统性漂移。
 * - cancel：同步幂等标记 + fire-and-forget 杀进程组（TERM→5s→KILL）。
 * 流式 job 的 done 不带 result（dsh-jobs d.ts：stream jobs leave it unset）。
 */
import type { JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { SshEngine } from './engine';
/** 声明合并扩 kind：id 前缀 ssh-N。 */
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        ssh: 'ssh';
    }
}
export interface JobRunnerDeps {
    engine: SshEngine;
    /** index.ts 经 ctx.get('jobs') 解析；缺失=能力不可用（官方同款报错）。 */
    jobs: JobRegistry | undefined;
}
export interface RemoteJobSpec {
    hostId: string;
    /** 用户命令原文（与前台执行同一信任边界）。 */
    command: string;
    /** 远程工作目录（省略=连接默认目录）。 */
    cwd?: string;
    /** 归属 agent（exec.agent 本体）；省略=无主 job。0.2 起 owner 需要 SessionId。 */
    agent?: unknown;
}
export declare function startRemoteJob(deps: JobRunnerDeps, spec: RemoteJobSpec): {
    kind: 'background';
    jobId: string;
};
