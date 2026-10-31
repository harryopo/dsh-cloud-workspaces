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

import { randomUUID } from 'node:crypto'
import type { JobHandle, JobHooks, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SshEngine } from './engine'
import { quoteSh } from './engine'
import { debugLog } from './debug-log'

/** 声明合并扩 kind：id 前缀 ssh-N。 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    ssh: 'ssh'
  }
}

export interface JobRunnerDeps {
  engine: SshEngine
  /** index.ts 经 ctx.get('jobs') 解析；缺失=能力不可用（官方同款报错）。 */
  jobs: JobRegistry | undefined
}

export interface RemoteJobSpec {
  hostId: string
  /** 用户命令原文（与前台执行同一信任边界）。 */
  command: string
  /** 远程工作目录（省略=连接默认目录）。 */
  cwd?: string
  /** 归属 agent（exec.agent 本体）；省略=无主 job。0.2 起 owner 需要 SessionId。 */
  agent?: unknown
}

const READ_CHUNK = 65536
const OUTPUT_LIMIT_BYTES = 8192
const KILL_ESCALATION_MS = 5_000
const PUMP_INTERVAL_MS = 3_000

/** Agent → SessionId（0.2 JobSpec.owner 是会话 id；取不到则不设 owner）。 */
function sessionIdOf(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

export function startRemoteJob(deps: JobRunnerDeps, spec: RemoteJobSpec): { kind: 'background'; jobId: string } {
  const { engine, jobs } = deps
  if (jobs === undefined) {
    throw new Error('background jobs unavailable — load @deepseek-ai/dsh-jobs (dsh-base)')
  }
  const runId = randomUUID()
  const pidPath = `/tmp/dsh-job-${runId}.pid`
  const logPath = `/tmp/dsh-job-${runId}.log`
  const owner = sessionIdOf(spec.agent)
  const jobId = jobs.start({
    kind: 'ssh',
    label: spec.command,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
    ...(owner !== undefined ? { owner: owner as never } : {}),
    run: (job) => buildHooks(engine, spec, pidPath, logPath, job),
  })
  return { kind: 'background', jobId }
}

function buildHooks(engine: SshEngine, spec: RemoteJobSpec, pidPath: string, logPath: string, job: JobHandle): JobHooks {
  const q = quoteSh
  let settled = false
  let settle!: (o: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => { settle = resolve })

  // 增量读取泵状态
  let cursor = 0
  let inflight = false
  // cancel 状态
  let cancelRequested = false
  let killStarted = false
  let channelReady = false
  let escalateTimer: NodeJS.Timeout | undefined

  const pump = (): void => {
    if (inflight || settled) return
    inflight = true
    engine.exec(spec.hostId, `dd if=${q(logPath)} bs=${READ_CHUNK} skip=${cursor} count=1 2>/dev/null`)
      .then((r) => {
        if (r.success && r.stdout !== '') {
          cursor += 1
          job.append(r.stdout)
        }
      })
      .catch(() => { /* 日志未生成/断连：下轮再拉 */ })
      .finally(() => { inflight = false })
  }
  const pumpTimer = setInterval(pump, PUMP_INTERVAL_MS)
  pumpTimer.unref?.()

  const finish = (o: JobOutcome): void => {
    if (settled) return
    settled = true
    clearInterval(pumpTimer)
    if (escalateTimer !== undefined) clearTimeout(escalateTimer)
    settle(o)
  }

  const killGroup = (sig: 'TERM' | 'KILL'): void => {
    engine.exec(spec.hostId, `bash -c ${q(`kill -${sig} -$(cat ${pidPath})`)}`)
      .catch((error) => { debugLog(`job kill -${sig} failed: ${error instanceof Error ? error.message : String(error)}`) })
  }
  const requestCancel = (): void => {
    if (killStarted) return
    killStarted = true
    killGroup('TERM')
    escalateTimer = setTimeout(() => { if (!settled) killGroup('KILL') }, KILL_ESCALATION_MS)
    escalateTimer.unref?.()
  }

  engine.openChannel(
    spec.hostId,
    `if ! printf %s $$ > ${q(pidPath)} 2>/dev/null; then echo 'dsh-job: pid file unwritable' >&2; exit 127; fi; exec bash -c ${q(spec.command)} > ${q(logPath)} 2>&1`,
    spec.cwd !== undefined ? { cwd: spec.cwd } : {},
  ).then((channel) => {
    channelReady = true
    channel.onClose((code, signal) => {
      if (code !== null) {
        // 127 可能是「用户命令不存在」，也可能是 wrapper 的 pid 文件写失败；
        // 用一次 test -s 区分，避免把后者误报成命令自身的退出码。
        if (code === 127) {
          engine.exec(spec.hostId, `bash -c ${q(`test -s ${pidPath}`)}`)
            .then((probe) => finish(probe.success
              ? { status: 'completed', detail: 'exit code: 127' }
              : { status: 'failed', detail: `cannot write pid file ${pidPath} — is /tmp writable on the server?` }))
            .catch(() => finish({ status: 'completed', detail: 'exit code: 127' }))
          return
        }
        finish({ status: 'completed', detail: `exit code: ${String(code)}` })
        return
      }
      if (signal !== null) { finish({ status: 'killed', detail: signal }); return }
      // 无码无号=传输断。探测一次：进程还活着就如实报告孤儿，绝不谎称已停。
      engine.exec(spec.hostId, `bash -c ${q(`kill -0 $(cat ${pidPath})`)}`)
        .then((probe) => finish(probe.success
          ? { status: 'failed', detail: `connection lost; remote process may still be running (pid file ${pidPath}, log ${logPath})` }
          : { status: 'failed', detail: `exit status unknown (connection lost); log: ${logPath}` }))
        .catch(() => finish({ status: 'failed', detail: `connection lost; state of remote process unknown; log: ${logPath}` }))
    })
    if (cancelRequested) requestCancel()
  }).catch((error: unknown) => {
    finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
  })

  return {
    cancel: (): void => {
      cancelRequested = true
      if (channelReady) requestCancel()
      // 通道未建立：open resolve 后补杀；reject 路径 finish 已兜底（远端未起进程）。
    },
    done,
  }
}
