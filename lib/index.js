import { n as __toESM } from "./rolldown-runtime-FDOR9p9I.js";
import { a as defaultStorePath, n as quoteSh, r as debugLog } from "./engine-_GRw_K6A.js";
import { SshRuntime, t as require_lib } from "./ssh-service.js";
import { startRemoteJob } from "./job-runner.js";
import { a as sshTunnelTool, c as HOST_TYPERT_CONTRIBUTION, d as registerPlaceholderWorkspace, f as jsonSafe, i as sshReadTool, l as REMOTE_SERVICE, m as routeByCwd, n as sshListTool, o as sshWorkspaceTool, p as resolveRemotePath, r as sshLsTool, s as sshWriteTool, t as sshExecTool, u as SshRemoteService } from "./tools-B7XOK5-o.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { load } from "js-yaml";
//#region src/legacy-import.ts
var import_lib = /* @__PURE__ */ __toESM(require_lib(), 1);
/**
* 一次性迁移：DSH 0.2 删除了 settings 命名空间，旧版把主机元数据写在
* settings.yaml 的 `dsh-remote-ide-hosts:` 段。首次启动若 0600 store 为空，
* 把这批主机导入 store（口令一并导入——旧版本 0.1.x 已把口令剥离到 store，
* 这里只兜底极老的数据）。
*
* 约束：只读 settings.yaml，绝不改写用户文件；任何失败都返回 0 导入。
*/
function defaultSettingsFile() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "settings.yaml");
}
async function importLegacyHosts(opts) {
	try {
		if (existsSync(opts.storeFile)) {
			if ((JSON.parse(readFileSync(opts.storeFile, "utf8")).hosts?.length ?? 0) > 0) return {
				imported: 0,
				skipped: 0
			};
		}
		const settingsFile = opts.settingsFile ?? defaultSettingsFile();
		if (!existsSync(settingsFile)) return {
			imported: 0,
			skipped: 0
		};
		const hosts = (load(readFileSync(settingsFile, "utf8"))?.["dsh-remote-ide-hosts"])?.hosts ?? {};
		const entries = Object.entries(hosts).map(([alias, cfg]) => ({
			alias,
			host: String(cfg.host ?? ""),
			port: Number(cfg.port ?? 22),
			user: String(cfg.user ?? ""),
			auth: cfg.authType === "password" ? {
				kind: "password",
				password: String(cfg.password ?? "")
			} : {
				kind: "key",
				keyPath: String(cfg.privateKeyPath ?? "")
			},
			proxyJump: Array.isArray(cfg.proxyJump) ? cfg.proxyJump : [],
			...typeof (cfg.description ?? cfg.name) === "string" ? { description: String(cfg.description ?? cfg.name) } : {},
			tags: [],
			createdAt: Date.now(),
			updatedAt: Date.now()
		})).filter((e) => e.host !== "" && e.user !== "");
		if (entries.length === 0) return {
			imported: 0,
			skipped: 0
		};
		mkdirSync(dirname(opts.storeFile), { recursive: true });
		writeFileSync(opts.storeFile, JSON.stringify({ hosts: entries }, null, 2), { mode: 384 });
		return {
			imported: entries.length,
			skipped: Object.keys(hosts).length - entries.length
		};
	} catch {
		return {
			imported: 0,
			skipped: 0
		};
	}
}
//#endregion
//#region src/session-tools.ts
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** 会话内路径解析：相对 → 远程 cwd 基准；本地占位绝对路径 → 重锚定回远程。 */
function resolveInSession(route, requested) {
	return resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd);
}
/** 渲染 exec 结果（与 ssh_exec 一致的退出码约定）。 */
function renderExec(result) {
	const parts = [result.timedOut ? "[timed out]" : `[exit code: ${result.exitCode ?? "null"}]`];
	if (result.stdout !== "") parts.push("stdout:\n" + result.stdout);
	if (result.stderr !== "") parts.push("stderr:\n" + result.stderr);
	if (result.error !== void 0) parts.push("error: " + result.error);
	parts.push(`duration: ${result.durationMs} ms`);
	return parts.join("\n");
}
/** 官方 read 的行号渲染（1-based 制表符分隔）。 */
function renderLines(path, offset, lines, total) {
	const body = lines.map((line) => `${String(line.number).padStart(6)}\t${line.text}`).join("\n");
	return `${path} (${lines.length}/${total} lines, from ${offset}):\n${body}`;
}
/** 取唯一文本块；非单文本/出错返回 undefined（软落到通用卡）。 */
function singleText(result) {
	if (result.isError === true) return void 0;
	const only = result.content !== void 0 && result.content.length === 1 ? result.content[0] : void 0;
	if (only === void 0 || only.type !== "text") return void 0;
	return only.text ?? "";
}
/**
* bash 渲染文本 → terminal 视图。官方 UI 对名为 bash 的工具走 keyed BashRow，
* 仅当宿主经 presentCall/presentResult 附上 terminal 视图时该行才可展开——
* 缺视图则整行 inert（真机「bash 调用无法展开」的根因）。
*/
function bashTerminalView(result) {
	const text = singleText(result);
	if (text === void 0) return void 0;
	const kept = text.split("\n").filter((line) => !/^duration: \d+ ms$/.test(line));
	const exit = /^\[exit code: (\d+)\]$/.exec(kept[0] ?? "");
	return {
		card: "terminal",
		output: exit !== null || (kept[0] ?? "") === "[exit code: null]" ? kept.slice(1).join("\n") : kept.join("\n"),
		...exit !== null ? { exitCode: Number(exit[1]) } : {}
	};
}
/** read 渲染文本 → read 视图（keyed read 行同款：无视图不可展开）。 */
function readCardView(result) {
	const text = singleText(result);
	if (text === void 0) return void 0;
	const nl = text.indexOf("\n");
	const head = nl === -1 ? text : text.slice(0, nl);
	const match = /^(.*) \((\d+)\/(\d+) lines, from (\d+)\):$/.exec(head);
	if (match === null) return void 0;
	const body = nl === -1 ? "" : text.slice(nl + 1);
	const offset = Number(match[4]);
	return {
		card: "read",
		path: match[1],
		offset,
		lines: body === "" ? [] : body.split("\n").map((line, i) => ({
			number: offset + i,
			text: line
		})),
		totalLines: Number(match[3]),
		content: [{
			type: "text",
			text: body
		}]
	};
}
/** 简单 glob → RegExp（支持 **、*、?；其余字符按字面量）。 */
function globToRegExp(pattern) {
	let source = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i];
		if (char === "*") if (pattern[i + 1] === "*") {
			source += ".*";
			i += 1;
		} else source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if ("\\^$.|+()[]{}".includes(char)) source += "\\" + char;
		else source += char;
	}
	return new RegExp("^" + source + "$");
}
/** 无 "/" 的 pattern 匹配任意深度的 basename（与官方 glob 语义一致）。 */
function matchGlob(regexp, pattern, relative) {
	if (!pattern.includes("/")) return regexp.test(relative.split("/").pop() ?? "");
	return regexp.test(relative);
}
/** 构建一个远程会话的遮蔽工具集（bash/read/write/edit/glob/grep/read_image）。 */
function buildSessionTools(runtime, route, jobs) {
	const engine = runtime.engine;
	const bashTool = defineTool({
		name: "bash",
		description: "Run a bash command on the remote server (this session's workspace host) and return stdout/stderr/exit code. For long-running commands (installs, builds, test suites) pass run_in_background:true — no timeout applies; poll with job_output / job_list, stop with job_kill.",
		parameters: {
			command: {
				type: "string",
				description: "The bash command to execute.",
				required: true
			},
			description: {
				type: "string",
				description: "Short active-voice description of what the command does (shown in the UI).",
				required: true
			},
			timeoutMs: {
				type: "integer",
				description: "Timeout in milliseconds (default 60000; ignored when run_in_background)."
			},
			workdir: {
				type: "string",
				description: "Working directory (relative paths resolve against the session remote workspace)."
			},
			run_in_background: {
				type: "boolean",
				description: "Start the command as a background job; no timeout applies. Poll with job_output / job_list, stop with job_kill."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						enum: ["foreground", "background"],
						required: true
					},
					jobId: { type: "string" },
					success: { type: "boolean" },
					exitCode: { type: "integer" },
					timedOut: { type: "boolean" },
					stdout: { type: "string" },
					stderr: { type: "string" },
					durationMs: { type: "integer" },
					error: { type: "string" }
				}
			},
			render: (_args, value) => {
				const v = value;
				if (v.kind === "background") return text(`started background job ${String(v.jobId)} — poll with job_output`);
				return text(renderExec(value));
			}
		},
		presentCall: (args) => ({
			card: "terminal",
			title: args.command,
			...args.description !== void 0 && args.description !== "" ? { description: args.description } : {},
			...args.workdir !== void 0 && args.workdir !== "" ? { cwd: args.workdir } : {}
		}),
		presentResult: (_args, result) => {
			const t = singleText(result);
			if (t !== void 0 && t.startsWith("started background job")) return {
				card: "generic",
				content: [{
					type: "text",
					text: t
				}]
			};
			return bashTerminalView(result);
		},
		async execute(args, exec) {
			const cwd = args.workdir !== void 0 && args.workdir !== "" ? resolveInSession(route, args.workdir) : route.remoteCwd;
			if (args.run_in_background === true) return jsonSafe(startRemoteJob({
				engine,
				jobs
			}, {
				hostId: route.hostId,
				command: args.command,
				cwd,
				...exec?.agent !== void 0 ? { agent: exec.agent } : {}
			}));
			const result = await engine.exec(route.hostId, args.command, {
				cwd,
				timeoutMs: args.timeoutMs
			});
			return jsonSafe({
				kind: "foreground",
				...result,
				exitCode: result.exitCode ?? void 0
			});
		}
	});
	const readTool = defineTool({
		name: "read",
		description: "Read a UTF-8 text file on the remote server and return line-numbered content.",
		parameters: {
			file_path: {
				type: "string",
				description: "Path to read (relative paths resolve against the remote workspace).",
				required: true
			},
			offset: {
				type: "integer",
				description: "1-based first line to return. Defaults to 1."
			},
			limit: {
				type: "integer",
				description: "Maximum number of lines to return. Defaults to 2000."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					offset: {
						type: "integer",
						required: true
					},
					totalLines: {
						type: "integer",
						required: true
					},
					content: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text(renderLines(String(value.path), Number(value.offset), String(value.content).split("\n").map((line, i) => ({
				number: Number(value.offset) + i,
				text: line
			})), Number(value.totalLines)))
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Read ${args.file_path}`,
			kind: "read",
			locations: [{
				path: args.file_path,
				line: args.offset ?? 1
			}]
		}),
		presentResult: (_args, result) => readCardView(result),
		async execute(args) {
			const path = resolveInSession(route, args.file_path);
			const all = (await engine.readFile(route.hostId, path)).content.replace(/\n$/, "").split("\n");
			const offset = Math.max(1, Math.trunc(args.offset ?? 1));
			const limit = Math.max(1, Math.trunc(args.limit ?? 2e3));
			const slice = all.slice(offset - 1, offset - 1 + limit);
			return jsonSafe({
				path,
				offset,
				totalLines: all.length,
				content: slice.join("\n")
			});
		}
	});
	const writeTool = defineTool({
		name: "write",
		description: "Write full text content to a file on the remote server (overwrites; missing parent directories are created automatically).",
		parameters: {
			file_path: {
				type: "string",
				description: "Path to write (relative paths resolve against the remote workspace).",
				required: true
			},
			content: {
				type: "string",
				description: "Full UTF-8 text content to write.",
				required: true
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					size: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => text(`wrote ${String(value.path)} (${String(value.size)} bytes)`)
		},
		async execute(args) {
			const path = resolveInSession(route, args.file_path);
			return jsonSafe({
				path,
				size: (await engine.writeFile(route.hostId, path, args.content)).size
			});
		}
	});
	const editTool = defineTool({
		name: "edit",
		description: "Exact string replacement in a remote file. old_string must appear exactly once unless replace_all is set.",
		parameters: {
			file_path: {
				type: "string",
				description: "Path to edit (relative paths resolve against the remote workspace).",
				required: true
			},
			old_string: {
				type: "string",
				description: "Exact text to replace.",
				required: true
			},
			new_string: {
				type: "string",
				description: "Replacement text.",
				required: true
			},
			replace_all: {
				type: "boolean",
				description: "Replace every occurrence instead of requiring uniqueness."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					replacements: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => text(`edited ${String(value.path)} (${String(value.replacements)} replacement(s))`)
		},
		async execute(args) {
			if (args.old_string === "") throw new Error("old_string must be non-empty");
			const path = resolveInSession(route, args.file_path);
			const file = await engine.readFile(route.hostId, path);
			const occurrences = file.content.split(args.old_string).length - 1;
			if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
			if (occurrences > 1 && args.replace_all !== true) throw new Error(`old_string appears ${occurrences} times in ${path}; provide more surrounding context or set replace_all`);
			const next = args.replace_all === true ? file.content.split(args.old_string).join(args.new_string) : file.content.replace(args.old_string, args.new_string);
			await engine.writeFile(route.hostId, path, next);
			return jsonSafe({
				path,
				replacements: occurrences
			});
		}
	});
	const globTool = defineTool({
		name: "glob",
		description: "Find files on the remote server by glob pattern (e.g. \"**/*.ts\"). A pattern with no \"/\" matches basenames at any depth.",
		parameters: {
			pattern: {
				type: "string",
				description: "Glob pattern, e.g. \"**/*.ts\" or \"*.md\".",
				required: true
			},
			path: {
				type: "string",
				description: "Directory to search (defaults to the remote workspace)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					pattern: {
						type: "string",
						required: true
					},
					path: {
						type: "string",
						required: true
					},
					matches: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => text(`${String(value.pattern)} — ${value.matches.length} match(es) under ${String(value.path)}${value.truncated ? " (truncated)" : ""}:\n${value.matches.join("\n")}`)
		},
		async execute(args) {
			const base = resolveInSession(route, args.path ?? ".");
			const result = await engine.exec(route.hostId, `find ${quoteSh(base)} -type f -print 2>/dev/null | head -n 20000`, { timeoutMs: 3e4 });
			if (result.timedOut) throw new Error(`glob timed out after 30s under ${base} — narrow the path or pattern`);
			const regexp = globToRegExp(args.pattern);
			const prefix = base === "/" ? "" : base + "/";
			const matches = [];
			let truncated = false;
			for (const line of result.stdout.split("\n")) {
				const absolute = line.replace(/\r$/, "");
				if (absolute === "") continue;
				const relative = absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
				if (!matchGlob(regexp, args.pattern, relative)) continue;
				if (matches.length >= 2e3) {
					truncated = true;
					break;
				}
				matches.push(absolute);
			}
			return jsonSafe({
				pattern: args.pattern,
				path: base,
				matches,
				truncated
			});
		}
	});
	const grepTool = defineTool({
		name: "grep",
		description: "Search file contents on the remote server with a regex (recursive, skips binary files).",
		parameters: {
			pattern: {
				type: "string",
				description: "Regular expression (POSIX extended) to search for.",
				required: true
			},
			path: {
				type: "string",
				description: "Directory or file to search (defaults to the remote workspace)."
			},
			include: {
				type: "string",
				description: "Glob filter for file names, e.g. \"*.ts\"."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					pattern: {
						type: "string",
						required: true
					},
					path: {
						type: "string",
						required: true
					},
					matches: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => text(`${String(value.pattern)} — ${value.matches.length} match(es) under ${String(value.path)}${value.truncated ? " (truncated)" : ""}:\n${value.matches.join("\n")}`)
		},
		async execute(args) {
			const base = resolveInSession(route, args.path ?? ".");
			const command = `grep -rInE ${args.include !== void 0 && args.include !== "" ? ` --include=${quoteSh(args.include)}` : ""} -e ${quoteSh(args.pattern)} ${quoteSh(base)} 2>/dev/null | head -n 500`;
			const result = await engine.exec(route.hostId, command, { timeoutMs: 3e4 });
			if (result.timedOut) throw new Error(`grep timed out after 30s under ${base} — narrow the path, include filter or pattern`);
			const lines = result.stdout.split("\n").filter((line) => line !== "");
			const truncated = lines.length >= 500;
			return jsonSafe({
				pattern: args.pattern,
				path: base,
				matches: lines,
				truncated
			});
		}
	});
	/** 图片魔数 → media type（read_image 只接受 PNG/JPEG/WebP/GIF）。 */
	const imageSignatures = [
		{
			mediaType: "image/png",
			test: (b) => b.length > 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71
		},
		{
			mediaType: "image/jpeg",
			test: (b) => b.length > 3 && b[0] === 255 && b[1] === 216 && b[2] === 255
		},
		{
			mediaType: "image/gif",
			test: (b) => b.length > 6 && b.toString("ascii", 0, 3) === "GIF"
		},
		{
			mediaType: "image/webp",
			test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"
		}
	];
	return [
		bashTool,
		readTool,
		writeTool,
		editTool,
		globTool,
		grepTool,
		defineTool({
			name: "read_image",
			description: "Read a PNG/JPEG/WebP/GIF file on the remote server and return the image itself.",
			parameters: { file_path: {
				type: "string",
				description: "Path to the image file (relative paths resolve against the remote workspace).",
				required: true
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: {
							type: "string",
							required: true
						},
						mediaType: {
							type: "string",
							required: true
						},
						bytes: {
							type: "integer",
							required: true
						},
						data: {
							type: "string",
							required: true
						}
					}
				},
				render: (_args, value) => {
					return [{
						type: "text",
						text: `${String(value.path)} (${String(value.mediaType)}, ${String(value.bytes)} bytes)`
					}, {
						type: "image",
						source: {
							type: "base64",
							media_type: String(value.mediaType),
							data: String(value.data)
						}
					}];
				}
			},
			async execute(args) {
				const path = resolveInSession(route, args.file_path);
				const sftp = await engine.getSftp(route.hostId);
				const buffer = await new Promise((resolve, reject) => {
					sftp.readFile(path, (error, data) => {
						if (error) reject(error);
						else resolve(data);
					});
				});
				if (buffer.length > 8 * 1024 * 1024) throw new Error(`cannot read "${path}": image exceeds the 8 MiB cap; downscale or export a smaller copy`);
				const mediaType = imageSignatures.find((signature) => signature.test(buffer))?.mediaType;
				if (mediaType === void 0) throw new Error(`cannot read "${path}": read_image only accepts PNG/JPEG/WebP/GIF files`);
				return jsonSafe({
					path,
					mediaType,
					bytes: buffer.length,
					data: buffer.toString("base64")
				});
			}
		})
	];
}
/** 会话动态 prompt 段文本（cwd 非占位时返回空串 = 本地会话零注入）。 */
function sessionSectionText(cwd) {
	const route = routeByCwd(cwd);
	if (route.kind !== "remote") return "";
	return [
		"## Remote workspace session",
		`This session's workspace is a remote directory: ${route.remoteCwd} on host "${route.hostId}" (connected over SSH).`,
		"Your bash/read/write/edit/glob/grep tools execute on that server; relative paths resolve against the remote directory. Treat the server as your working machine.",
		"For long-running commands (installs, builds, test suites) pass run_in_background: true to bash, then poll with job_output / job_list / job_kill.",
		"The ssh_exec/ssh_ls/ssh_read/ssh_write tools also target this host automatically (their alias parameter is optional here).",
		"The plugin configuration lives on the DSH host machine, not on the server — do not look for it there."
	].join("\n");
}
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
function installSessionRouting(ctx, runtime, isEnabled, jobsProvider) {
	const emitter = ctx;
	if (typeof emitter.on !== "function") {
		debugLog("ctx.on unavailable — session routing disabled");
		return;
	}
	const onEvent = emitter.on.bind(emitter);
	ctx.effect(() => {
		debugLog("session routing installed (agent/created)");
		const listener = (payload) => {
			try {
				if (isEnabled !== void 0 && !isEnabled()) return;
				const cwd = payload?.agent?.session?.header?.cwd;
				const route = routeByCwd(cwd);
				debugLog(`agent/created: cwd=${cwd ?? "(none)"} → ${route.kind}`);
				if (route.kind !== "remote") return;
				const scope = payload.agent?.ctx;
				if (scope === void 0 || scope === ctx) {
					debugLog("agent/created: agent scope unavailable — shadow tools skipped (never register globally)");
					return;
				}
				const sessionRoute = {
					hostId: route.hostId,
					remoteCwd: route.remoteCwd,
					placeholderCwd: cwd ?? ""
				};
				let registered = 0;
				for (const tool of buildSessionTools(runtime, sessionRoute, jobsProvider?.())) try {
					scope.tools.register(tool);
					registered += 1;
				} catch (error) {
					debugLog(`shadow register failed for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
				}
				runtime.connect(route.hostId).catch((error) => {
					debugLog(`connect ${route.hostId} failed: ${error instanceof Error ? error.message : String(error)}`);
				});
				debugLog(`remote session routed: ${cwd} → ${route.hostId}:${route.remoteCwd} (${registered} shadow tools)`);
			} catch (error) {
				debugLog(`session routing skipped: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		const dispose = onEvent("agent/created", listener);
		return () => {
			if (typeof dispose === "function") dispose();
		};
	}, "dsh-remote-ide: session routing");
}
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "remote-ide";
/** Services required before the surfaces can mount. */
const inject = ["tools", "systemPrompt"];
const Config = import_lib.default.object({
	enabled: import_lib.default.boolean().default(true),
	maxReadBytes: import_lib.default.number().min(64 * 1024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
	announceToAgent: import_lib.default.boolean().default(true)
});
/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ENABLED = true;
const DEFAULT_ANNOUNCE = true;
/** Model-facing announcement: plugin presence and limits. */
const REMOTE_GUIDANCE = "本机已安装 dsh-remote-ide（远程工作区）：在「添加工作区」里选「云端（SSH）」即可把服务器目录绑定为工作区——该会话的 bash/read/write/edit/glob/grep 与 ssh_* 工具会自动在该服务器上执行，和本地一样。也可用 ssh_list 列出已配置主机、ssh_workspace 绑定远程目录、ssh_tunnel 把服务器端口映射到本机 127.0.0.1。长命令（安装/构建/测试套件）用 bash 或 ssh_exec 的 run_in_background:true 起后台，随后 job_output/job_list 轮询、job_kill 终止。限制：需先在 设置 → SSH 连接 配置主机；远程命令消耗真实服务器资源；密码以明文存在用户主目录私有文件（0600）。用户提到「SSH / 远程服务器 / 远程开发 / 云端工作区」时即指本插件。";
/** Tool-guidance band order. */
const SECTION_ORDER = 150;
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
async function apply(ctx, config) {
	debugLog("apply: dsh-cloud-workspaces host half starting");
	const resolve = () => ({
		enabled: config?.enabled ?? DEFAULT_ENABLED,
		maxReadBytes: config?.maxReadBytes,
		announceToAgent: config?.announceToAgent ?? DEFAULT_ANNOUNCE
	});
	importLegacyHosts({ storeFile: defaultStorePath() }).catch(() => {});
	await ctx.plugin(SshRuntime, { maxReadBytes: resolve().maxReadBytes });
	const runtime = ctx.get("ssh");
	if (!runtime) throw new Error("dsh-remote-ide: SshRuntime did not provide ctx.ssh");
	const tools = [
		sshListTool(runtime),
		sshExecTool(runtime, ctx.get("jobs")),
		sshLsTool(runtime),
		sshReadTool(runtime),
		sshWriteTool(runtime),
		sshTunnelTool(runtime),
		sshWorkspaceTool(runtime, (localPath, title) => {
			registerPlaceholderWorkspace(ctx, localPath, title);
		})
	];
	let disposeTools;
	let disposeSection;
	let disposeSessionSection;
	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (disposeSessionSection !== void 0) {
			disposeSessionSection();
			disposeSessionSection = void 0;
		}
		const value = resolve();
		if (!value.enabled) return;
		disposeTools = ctx.effect(() => {
			const disposers = tools.map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-remote-ide: tools");
		if (value.announceToAgent) {
			disposeSection = ctx.systemPrompt.section({
				name: "plugin:dsh-remote-ide",
				order: SECTION_ORDER,
				text: REMOTE_GUIDANCE
			});
			disposeSessionSection = ctx.systemPrompt.section({
				name: "plugin:dsh-remote-ide:session",
				order: 151,
				text: (context) => {
					const agent = context.agent;
					return sessionSectionText(agent?.session?.header?.cwd);
				}
			});
		}
	};
	ctx.inject(["typert"], (scope) => {
		try {
			debugLog("typert inject fired");
			const remote = new SshRemoteService(scope, runtime);
			scope.typert.register(HOST_TYPERT_CONTRIBUTION);
			scope.logger?.info("[dsh-remote-ide] typert remote " + REMOTE_SERVICE + " registered");
			debugLog("typert registered; store hosts=" + String(Object.keys(remote.listHosts().hosts).length));
		} catch (error) {
			debugLog("typert inject failed: " + (error instanceof Error ? error.message : String(error)));
		}
	});
	installSessionRouting(ctx, runtime, () => resolve().enabled === true, () => ctx.get("jobs"));
	sync();
}
//#endregion
export { Config, REMOTE_GUIDANCE, apply, inject, name };
