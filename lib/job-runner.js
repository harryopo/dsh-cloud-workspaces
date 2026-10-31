import { n as quoteSh, r as debugLog } from "./engine-CeZErvrF.js";
import { randomUUID } from "node:crypto";
//#region src/job-runner.ts
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
const READ_CHUNK = 65536;
const OUTPUT_LIMIT_BYTES = 8192;
const KILL_ESCALATION_MS = 5e3;
const PUMP_INTERVAL_MS = 3e3;
/** Agent → SessionId（0.2 JobSpec.owner 是会话 id；取不到则不设 owner）。 */
function sessionIdOf(agent) {
	if (agent === null || typeof agent !== "object") return void 0;
	const id = agent.id;
	return typeof id === "string" ? id : void 0;
}
function startRemoteJob(deps, spec) {
	const { engine, jobs } = deps;
	if (jobs === void 0) throw new Error("background jobs unavailable — load @deepseek-ai/dsh-jobs (dsh-base)");
	const runId = randomUUID();
	const pidPath = `/tmp/dsh-job-${runId}.pid`;
	const logPath = `/tmp/dsh-job-${runId}.log`;
	const owner = sessionIdOf(spec.agent);
	return {
		kind: "background",
		jobId: jobs.start({
			kind: "ssh",
			label: spec.command,
			outputLimitBytes: OUTPUT_LIMIT_BYTES,
			...owner !== void 0 ? { owner } : {},
			run: (job) => buildHooks(engine, spec, pidPath, logPath, job)
		})
	};
}
function buildHooks(engine, spec, pidPath, logPath, job) {
	const q = quoteSh;
	let settled = false;
	let settle;
	const done = new Promise((resolve) => {
		settle = resolve;
	});
	let cursor = 0;
	let inflight = false;
	let cancelRequested = false;
	let killStarted = false;
	let channelReady = false;
	let escalateTimer;
	const pump = () => {
		if (inflight || settled) return;
		inflight = true;
		engine.exec(spec.hostId, `dd if=${q(logPath)} bs=${READ_CHUNK} skip=${cursor} count=1 2>/dev/null`).then((r) => {
			if (r.success && r.stdout !== "") {
				cursor += 1;
				job.append(r.stdout);
			}
		}).catch(() => {}).finally(() => {
			inflight = false;
		});
	};
	const pumpTimer = setInterval(pump, PUMP_INTERVAL_MS);
	pumpTimer.unref?.();
	const finish = (o) => {
		if (settled) return;
		settled = true;
		clearInterval(pumpTimer);
		if (escalateTimer !== void 0) clearTimeout(escalateTimer);
		settle(o);
	};
	const killGroup = (sig) => {
		engine.exec(spec.hostId, `bash -c ${q(`kill -${sig} -$(cat ${pidPath})`)}`).catch((error) => {
			debugLog(`job kill -${sig} failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	const requestCancel = () => {
		if (killStarted) return;
		killStarted = true;
		killGroup("TERM");
		escalateTimer = setTimeout(() => {
			if (!settled) killGroup("KILL");
		}, KILL_ESCALATION_MS);
		escalateTimer.unref?.();
	};
	engine.openChannel(spec.hostId, `if ! printf %s $$ > ${q(pidPath)} 2>/dev/null; then echo 'dsh-job: pid file unwritable' >&2; exit 127; fi; exec bash -c ${q(spec.command)} > ${q(logPath)} 2>&1`, spec.cwd !== void 0 ? { cwd: spec.cwd } : {}).then((channel) => {
		channelReady = true;
		channel.onClose((code, signal) => {
			if (code !== null) {
				if (code === 127) {
					engine.exec(spec.hostId, `bash -c ${q(`test -s ${pidPath}`)}`).then((probe) => finish(probe.success ? {
						status: "completed",
						detail: "exit code: 127"
					} : {
						status: "failed",
						detail: `cannot write pid file ${pidPath} — is /tmp writable on the server?`
					})).catch(() => finish({
						status: "completed",
						detail: "exit code: 127"
					}));
					return;
				}
				finish({
					status: "completed",
					detail: `exit code: ${String(code)}`
				});
				return;
			}
			if (signal !== null) {
				finish({
					status: "killed",
					detail: signal
				});
				return;
			}
			engine.exec(spec.hostId, `bash -c ${q(`kill -0 $(cat ${pidPath})`)}`).then((probe) => finish(probe.success ? {
				status: "failed",
				detail: `connection lost; remote process may still be running (pid file ${pidPath}, log ${logPath})`
			} : {
				status: "failed",
				detail: `exit status unknown (connection lost); log: ${logPath}`
			})).catch(() => finish({
				status: "failed",
				detail: `connection lost; state of remote process unknown; log: ${logPath}`
			}));
		});
		if (cancelRequested) requestCancel();
	}).catch((error) => {
		finish({
			status: "failed",
			detail: error instanceof Error ? error.message : String(error)
		});
	});
	return {
		cancel: () => {
			cancelRequested = true;
			if (channelReady) requestCancel();
		},
		done
	};
}
//#endregion
export { startRemoteJob };
