/**
 * dsh-remote-ide — 占位工作区会话的透明工具集（免 preset 的核心竞争力）。
 *
 * agent/created 钩子读会话 cwd：落在 ~/.dsh/remote/<hostId>/<b64> 下 → 在
 * agent scope 注册与官方同名的 bash / read / write / edit / glob / grep 遮蔽
 * 工具，execute 全部经共享 SshEngine 直接落在锚定主机上；配合 systemPrompt
 * 的动态段（按会话 cwd 求值）宣告远程身份。本地会话不注册任何东西，零影响。
 *
 * 设计约束：
 * - 参数名与官方 tool-fs / tool-bash 对齐（file_path / content / pattern /
 *   command…），模型无需学新接口；输出 schema 是我们自己的（更简单）。
 * - 所有输出过 jsonSafe —— 工具结果同样要过 lossless-JSON 校验。
 * - 钩子内任何异常都不得影响会话创建（整体 try/catch 吞掉）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { SshRuntime } from './ssh-service';
/** 一个远程会话的路由（钩子时确定，此后全部工具共用）。 */
export interface SessionRoute {
    /** 锚定主机 alias（占位路径第一段）。 */
    hostId: string;
    /** 远程工作区绝对路径（占位编码的还原）。 */
    remoteCwd: string;
    /** 本地占位目录（占位绝对路径重锚定的基准）。 */
    placeholderCwd: string;
}
/** 构建一个远程会话的遮蔽工具集（bash/read/write/edit/glob/grep/read_image）。 */
export declare function buildSessionTools(runtime: SshRuntime, route: SessionRoute, jobs?: JobRegistry | undefined): import("@deepseek-ai/dsh-tools").ToolDefinition[];
/** 会话动态 prompt 段文本（cwd 非占位时返回空串 = 本地会话零注入）。 */
export declare function sessionSectionText(cwd: string | undefined): string;
/** 轻量文件诊断日志（scope.logger 不落盘，钩子链路必须自己留痕）。超上限重置文件，避免无限增长。 */
/**
 * 安装会话路由：agent/created 看会话 cwd，占位会话在 agent scope 注册遮蔽
 * 工具。订阅走 cordis 事件总线 **ctx.on(...)**（AgentRegistry 服务上没有
 * on 方法——之前误用 agents.on 被防御分支静默跳过，钩子从未生效）。
 * 任何异常都不得影响会话创建——整体吞掉（最坏情况 = 该会话没有远程工具，
 * 回退 ssh_* 显式工具）。
 *
 * ⚠️ 遮蔽工具只允许注册进 payload.agent.ctx（agent 作用域）。缺失时绝不
 * 退回插件级 ctx——那会让 bash/read 等在全局（含本地会话）遮蔽官方工具。
 */
export declare function installSessionRouting(ctx: Context, runtime: SshRuntime, isEnabled?: () => boolean, jobsProvider?: () => JobRegistry | undefined): void;
