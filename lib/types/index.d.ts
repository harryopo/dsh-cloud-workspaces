/**
 * dsh-remote-ide — host half.
 *
 * 免 preset 的「云端工作区」模式：工作区选择器（client 半双 tab）选定远程
 * 目录后，会话内官方同名工具（bash/read/write/edit/glob/grep）经 agent/created
 * 钩子在 agent scope 遮蔽为 SSH 实现（session-tools），另有全局 ssh_* 工具
 * （tools）、设置卡主机管理（host-settings + typert）。agent-presets/remote-legacy
 * 保留 fs/subprocess 真 seam 替换路线作参考，不再部署。
 *
 * Host entries live in ~/.dsh/dsh-remote-ide.json (0600, import from
 * ~/.ssh/config) plus the settings namespace the web settings card edits.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
/** Stable cordis plugin name. */
export declare const name = "remote-ide";
/** Services required before the surfaces can mount. */
export declare const inject: string[];
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
    /** Master switch for the plugin (tools). */
    enabled?: boolean;
    /** Remote file read cap for ssh_read (bytes). */
    maxReadBytes?: number;
    /** When true, announce the remote tools to the agent via a prompt section. */
    announceToAgent?: boolean;
}
export declare const Config: z<Config>;
/** Model-facing announcement: plugin presence and limits. */
export declare const REMOTE_GUIDANCE = "\u672C\u673A\u5DF2\u5B89\u88C5 dsh-remote-ide\uFF08\u8FDC\u7A0B\u5DE5\u4F5C\u533A\uFF09\uFF1A\u5728\u300C\u6DFB\u52A0\u5DE5\u4F5C\u533A\u300D\u91CC\u9009\u300C\u4E91\u7AEF\uFF08SSH\uFF09\u300D\u5373\u53EF\u628A\u670D\u52A1\u5668\u76EE\u5F55\u7ED1\u5B9A\u4E3A\u5DE5\u4F5C\u533A\u2014\u2014\u8BE5\u4F1A\u8BDD\u7684 bash/read/write/edit/glob/grep \u4E0E ssh_* \u5DE5\u5177\u4F1A\u81EA\u52A8\u5728\u8BE5\u670D\u52A1\u5668\u4E0A\u6267\u884C\uFF0C\u548C\u672C\u5730\u4E00\u6837\u3002\u4E5F\u53EF\u7528 ssh_list \u5217\u51FA\u5DF2\u914D\u7F6E\u4E3B\u673A\u3001ssh_workspace \u7ED1\u5B9A\u8FDC\u7A0B\u76EE\u5F55\u3001ssh_tunnel \u628A\u670D\u52A1\u5668\u7AEF\u53E3\u6620\u5C04\u5230\u672C\u673A 127.0.0.1\u3002\u957F\u547D\u4EE4\uFF08\u5B89\u88C5/\u6784\u5EFA/\u6D4B\u8BD5\u5957\u4EF6\uFF09\u7528 bash \u6216 ssh_exec \u7684 run_in_background:true \u8D77\u540E\u53F0\uFF0C\u968F\u540E job_output/job_list \u8F6E\u8BE2\u3001job_kill \u7EC8\u6B62\u3002\u9650\u5236\uFF1A\u9700\u5148\u5728 \u8BBE\u7F6E \u2192 SSH \u8FDE\u63A5 \u914D\u7F6E\u4E3B\u673A\uFF1B\u8FDC\u7A0B\u547D\u4EE4\u6D88\u8017\u771F\u5B9E\u670D\u52A1\u5668\u8D44\u6E90\uFF1B\u5BC6\u7801\u4EE5\u660E\u6587\u5B58\u5728\u7528\u6237\u4E3B\u76EE\u5F55\u79C1\u6709\u6587\u4EF6\uFF080600\uFF09\u3002\u7528\u6237\u63D0\u5230\u300CSSH / \u8FDC\u7A0B\u670D\u52A1\u5668 / \u8FDC\u7A0B\u5F00\u53D1 / \u4E91\u7AEF\u5DE5\u4F5C\u533A\u300D\u65F6\u5373\u6307\u672C\u63D2\u4EF6\u3002";
/**
 * Mount the shared SSH runtime and the remote-development tools.
 *
 * The SshRuntime (ctx.ssh) is the ONE connection owner on the host plane: the
 * ssh_* tools registered here and the preset-scoped adapters (fs-ssh /
 * subprocess-ssh, mounted by agent-presets/remote in an isolate realm that
 * injects `ssh`) all consume the same engine, so a connection established by
 * one is visible to the others.
 * @param ctx - host plugin context carrying tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
