import { startRemoteJob } from "./job-runner.js";
import { Service } from "@deepseek-ai/cordis";
import fs from "node:fs";
import path, { posix } from "node:path";
import os from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { bindTypertRemote } from "@deepseek-ai/dsh-typert-protocol";
//#region src/workspace.ts
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
/** 占位目录内的清单文件名（增强可诊断性：目录名即不依赖也能路由）。 */
const MANIFEST_NAME = ".dsh-remote-workspace.json";
/** 环境覆盖优先级：DSH_REMOTE_ROOT > $DSH_HOME/remote > ~/.dsh/remote。 */
function remoteRoot(env = process.env) {
	if (env.DSH_REMOTE_ROOT !== void 0 && env.DSH_REMOTE_ROOT !== "") return path.resolve(String(env.DSH_REMOTE_ROOT));
	const dshHome = env.DSH_HOME !== void 0 && env.DSH_HOME !== "" ? String(env.DSH_HOME) : path.join(os.homedir(), ".dsh");
	return path.join(dshHome, "remote");
}
/** hostId 必须是安全的单段目录名：字母数字开头，可含 . _ -，且不为 . / ..。 */
function isValidHostId(hostId) {
	if (typeof hostId !== "string" || hostId.length === 0) return false;
	if (hostId === "." || hostId === "..") return false;
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId);
}
/** 远程绝对路径 → base64url（无 padding）：单段、不含 '/'。 */
function encodeRemotePath(remotePath) {
	return Buffer.from(String(remotePath), "utf8").toString("base64url");
}
/** base64url → 原字符串；非法/非规范输入返回 null（可逆性守卫）。 */
function decodeRemotePath(encoded) {
	if (typeof encoded !== "string" || encoded.length === 0) return null;
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
	let text;
	try {
		text = Buffer.from(encoded, "base64url").toString("utf8");
	} catch {
		return null;
	}
	if (encodeRemotePath(text) !== encoded) return null;
	return text;
}
/** 远程路径 → 本地占位路径。hostId 非法时返回 null。 */
function mapRemoteToLocal(hostId, remotePath, env) {
	if (!isValidHostId(hostId)) return null;
	return path.join(remoteRoot(env), hostId, encodeRemotePath(remotePath));
}
/**
* 本地路径 → { hostId, remotePath } | null。要求恰好两段
* <root>/<hostId>/<encoded>，且 encoded 可解码为 '/' 开头的绝对路径
* （可逆、无穿越；碰巧同形的真实本地目录不会被误判）。
*/
function mapLocalToRemote(localPath, env) {
	if (typeof localPath !== "string" || localPath.length === 0) return null;
	const root = remoteRoot(env);
	const rel = path.relative(root, localPath);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	const segments = rel.split(path.sep);
	if (segments.length !== 2) return null;
	const hostId = segments[0];
	const encoded = segments[1];
	if (!isValidHostId(hostId)) return null;
	const remotePath = decodeRemotePath(encoded);
	if (remotePath === null) return null;
	if (!path.isAbsolute(remotePath) || !remotePath.startsWith("/")) return null;
	return {
		hostId,
		remotePath
	};
}
/** 路由入口：会话 cwd 恰为占位路径 → remote；否则 local（绝不抛错）。 */
function routeByCwd(cwd, env) {
	const mapped = mapLocalToRemote(cwd, env);
	if (mapped === null) return { kind: "local" };
	return {
		kind: "remote",
		hostId: mapped.hostId,
		remoteCwd: mapped.remotePath
	};
}
/**
* 远程路径解析：相对路径基于 remoteCwd；占位工作区内的绝对路径（Windows
* 本地形态 <placeholderCwd>/...）重锚定回远程；其余绝对路径按远程绝对路径
* 处理（词法规范化，折叠 ./../ 与重复斜杠——与官方 dsh-fs-sandbox 的
* containment 威胁模型一致，不做 symlink 解析）。
*/
function resolveRemotePath(requestedPath, remoteCwd, placeholderCwd) {
	if (!posix.isAbsolute(requestedPath)) {
		if (placeholderCwd !== void 0) {
			const rel = path.relative(placeholderCwd, requestedPath);
			if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return posix.join(remoteCwd, rel.split(path.sep).join("/"));
		}
		return posix.resolve(remoteCwd, requestedPath);
	}
	if (placeholderCwd !== void 0) {
		const rel = posix.relative(placeholderCwd, requestedPath);
		if (rel !== "" && !rel.startsWith("..") && !posix.isAbsolute(rel)) return posix.join(remoteCwd, rel);
	}
	return posix.normalize(requestedPath);
}
/**
* 创建占位目录并写入清单（幂等：recursive mkdir + 覆盖写）。
* hostId/remotePath 非法时抛错；fs 错误原样上抛由调用者包装。
*/
async function createPlaceholderDir({ hostId, remotePath, env, fsImpl = fs, now = /* @__PURE__ */ new Date() }) {
	if (!isValidHostId(hostId)) throw new Error(`invalid host id: ${JSON.stringify(hostId)}`);
	if (typeof remotePath !== "string" || remotePath === "" || !remotePath.startsWith("/")) throw new Error("remote path must be an absolute POSIX path");
	const localPath = mapRemoteToLocal(hostId, remotePath, env);
	if (localPath === null) throw new Error(`invalid host id: ${JSON.stringify(hostId)}`);
	await fsImpl.promises.mkdir(localPath, { recursive: true });
	const manifest = {
		hostId,
		remotePath,
		createdAt: now.toISOString()
	};
	await fsImpl.promises.writeFile(path.join(localPath, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	return {
		localPath,
		hostId,
		remotePath
	};
}
/** 列出全部占位工作区（root 下逐 hostId 目录；目录名解码 + manifest 双源）。 */
async function listPlaceholders(env, fsImpl = fs) {
	const root = remoteRoot(env);
	const result = [];
	let hostDirs;
	try {
		hostDirs = await fsImpl.promises.readdir(root);
	} catch {
		return result;
	}
	for (const hostId of hostDirs) {
		if (!isValidHostId(hostId)) continue;
		const hostDir = path.join(root, hostId);
		let entries;
		try {
			entries = await fsImpl.promises.readdir(hostDir);
		} catch {
			continue;
		}
		for (const encoded of entries) {
			const localPath = path.join(hostDir, encoded);
			const remotePath = decodeRemotePath(encoded);
			if (remotePath !== null && path.isAbsolute(remotePath)) result.push({
				localPath,
				hostId,
				remotePath
			});
		}
	}
	return result;
}
//#endregion
//#region src/jsonsafe.ts
/**
* dsh-remote-ide — 输出边界净化（lossless JSON / JSON-safe）。
*
* dsh 的两个边界校验都拒绝 undefined own-values：
*  - typert 网关 assertJsonValue（报 "business result failed boundary validation"）
*  - dsh-tools 工具输出校验 isJsonValue（报 "value is not lossless JSON"）
* 显式赋值的 `error: undefined` 也是 own property，而校验发生在进程内、
* JSON 序列化之前——JSON.stringify 丢 undefined 救不了。所有跨边界输出
* （typert 端点返回、工具 execute 返回）必须经此剥离 undefined。
*/
/** 递归剥离 undefined own-values 与数组内 undefined 元素（原样返回原值类型）。 */
function jsonSafe(value) {
	if (Array.isArray(value)) return value.map((item) => jsonSafe(item)).filter((item) => item !== void 0);
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) if (item !== void 0) out[key] = jsonSafe(item);
		return out;
	}
	return value;
}
//#endregion
//#region src/typert.ts
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
async function registerPlaceholderWorkspace(ctx, localPath, title) {
	try {
		const registry = await Promise.race([Promise.resolve(ctx.get("workspaceRegistry")), new Promise((resolve) => setTimeout(() => resolve(void 0), 5e3))]);
		if (registry !== void 0 && typeof registry.create === "function") await registry.create(localPath, title);
	} catch {}
}
/** 占位工作区在注册表里的展示标题：<host> / <末段目录名>。 */
function placeholderTitle(hostId, remotePath) {
	return `${hostId} / ${remotePath.split("/").filter(Boolean).pop() || "root"}`;
}
/** npm 包名（描述符 id 前缀）。 */
const REMOTE_PACKAGE = "dsh-remote-ide";
/** Cordis service key。 */
const REMOTE_SERVICE = "ssh-remote";
/** wire 命名空间（client 侧 ctx.remote.<ns>.<method>）。 */
const REMOTE_NAMESPACE = "ssh-remote";
const SRC_JSON = { mode: "src-json" };
function hostInvocation(method, parameters) {
	return {
		id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
		service: REMOTE_SERVICE,
		namespace: REMOTE_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: parameters.map((name) => ({
			name,
			wire: name,
			source: "json",
			codec: SRC_JSON
		})),
		result: SRC_JSON
	};
}
/** host 半贡献：参数名（wire）与 SshRemoteService 方法参数一一对应。 */
const HOST_TYPERT_CONTRIBUTION = {
	package: REMOTE_PACKAGE,
	face: "host",
	schemas: [],
	invocations: [
		hostInvocation("listHosts", []),
		hostInvocation("saveHost", ["id", "patch"]),
		hostInvocation("deleteHost", ["id"]),
		hostInvocation("testConnection", ["hostId", "cfg"]),
		hostInvocation("listRemoteDir", ["hostId", "path"]),
		hostInvocation("mkdirRemote", ["hostId", "path"]),
		hostInvocation("removeRemote", ["hostId", "path"]),
		hostInvocation("createPlaceholder", ["hostId", "remotePath"]),
		hostInvocation("listPlaceholders", [])
	],
	model: void 0
};
/**
* 设置卡片的远程服务。方法即端点（位置参数，与描述符 parameters 一一对应）。
* ⚠️ 端点返回**裸业务值**：gateway 已用 {ok, value} 表达调用成败，若端点再
* 自包一层 {ok, value} 会让 client 收到双层包装（unwrap 只解一层）。
* 业务失败直接 throw（gateway 捕获转 {ok:false, error:{message}}）。
* bindTypertRemote 绑定是 gateway validateBinding 的硬要求。
*/
var SshRemoteService = class extends Service {
	runtime;
	/** 宿主 ctx（workspaceRegistry 等可选服务经 ctx.get 读取）。 */
	runtimeCtx;
	/** 绑定声明——gateway validateBinding 按此反射名检查，不可改名。 */
	typertRemote;
	constructor(ctx, runtime) {
		super(ctx, REMOTE_SERVICE);
		this.runtime = runtime;
		this.runtimeCtx = ctx;
		this.typertRemote = bindTypertRemote(this, REMOTE_SERVICE);
	}
	/** store 里的摘要（0.2 起主机元数据唯一来源 = 0600 store）。 */
	summary(id) {
		return this.runtime.engine.list().find((s) => s.alias === id);
	}
	/** 把 store 摘要投影成 client 表单形状（不携带任何口令）。 */
	toConfig(alias) {
		const s = this.summary(alias);
		if (s === void 0) return void 0;
		const stored = this.runtime.getStoredEntry(alias);
		return {
			id: s.alias,
			name: s.description ?? s.alias,
			host: s.host,
			port: s.port,
			user: s.user,
			authType: s.auth,
			privateKeyPath: stored?.auth.kind === "key" ? stored.auth.keyPath : void 0,
			proxyJump: s.proxyJump,
			description: s.description
		};
	}
	/** 列出全部主机（脱敏）+ 口令已设标记（直接从 0600 store 读取）。 */
	listHosts() {
		const hosts = {};
		const secrets = {};
		for (const s of this.runtime.engine.list()) {
			hosts[s.alias] = {
				id: s.alias,
				name: s.description ?? s.alias,
				host: s.host,
				port: s.port,
				user: s.user,
				authType: s.auth,
				privateKeyPath: this.runtime.getStoredEntry(s.alias)?.auth.kind === "key" ? this.runtime.getStoredEntry(s.alias)?.auth.keyPath : void 0,
				proxyJump: s.proxyJump,
				description: s.description
			};
			secrets[s.alias] = s.auth === "password";
		}
		return jsonSafe({
			hosts,
			secrets
		});
	}
	/**
	* 创建或更新主机：唯一写路径 = 0600 的 dsh-remote-ide.json。
	* 口令留空 = 沿用 store 既有口令。
	*/
	async saveHost(id, patch) {
		const prev = this.toConfig(id);
		const next = {
			id,
			name: patch.name ?? prev?.name,
			host: (patch.host ?? prev?.host ?? "").trim(),
			port: patch.port ?? prev?.port ?? 22,
			user: (patch.user ?? prev?.user ?? "").trim(),
			authType: patch.authType ?? prev?.authType ?? "key",
			privateKeyPath: patch.privateKeyPath ?? prev?.privateKeyPath,
			proxyJump: patch.proxyJump ?? prev?.proxyJump,
			description: patch.description ?? prev?.description
		};
		if (next.host === "" || next.user === "") throw new Error("host and user are required");
		const stored = this.runtime.getStoredEntry(id);
		const password = typeof patch.password === "string" && patch.password !== "" ? patch.password : stored?.auth.kind === "password" ? stored.auth.password : void 0;
		this.runtime.engine.upsertHost({
			alias: id,
			host: next.host,
			port: next.port,
			user: next.user,
			auth: next.authType === "password" ? {
				kind: "password",
				password: password ?? ""
			} : {
				kind: "key",
				keyPath: next.privateKeyPath ?? ""
			},
			proxyJump: next.proxyJump ?? [],
			description: next.description ?? next.name
		}, id);
		return { id };
	}
	/** 删除主机（store 唯一写路径）。 */
	async deleteHost(id) {
		if (this.summary(id) === void 0) throw new Error(`host not found: ${id}`);
		this.runtime.engine.removeHost(id);
		return { id };
	}
	/**
	* 测试连接：用表单配置直连探测。对已保存主机（hostId 非空），密码/密钥
	* 从 0600 store 补回（UI 拿到的是脱敏视图，password 已被剥离——测试不带
	* 密码必然 "All configured authentication methods failed"）。
	*/
	async testConnection(hostId, cfg) {
		let password = cfg.password;
		let privateKeyPath = cfg.privateKeyPath;
		const stored = hostId === "" ? void 0 : this.runtime.getStoredEntry(hostId);
		if (stored !== void 0) {
			if (stored.auth.kind === "password" && (password === void 0 || password === "")) password = stored.auth.password;
			if (stored.auth.kind === "key" && (privateKeyPath === void 0 || privateKeyPath === "")) privateKeyPath = stored.auth.keyPath;
		}
		const result = await this.runtime.engine.testConfig({
			host: cfg.host,
			port: cfg.port,
			user: cfg.user,
			auth: cfg.authType === "password" || hostId !== "" && this.runtime.getStoredEntry(hostId)?.auth.kind === "password" ? {
				kind: "password",
				password
			} : {
				kind: "key",
				keyPath: privateKeyPath
			},
			proxyJump: cfg.proxyJump
		});
		return jsonSafe({
			ok: result.ok,
			latencyMs: result.latencyMs,
			error: result.error
		});
	}
	/** 列远端目录（工作区创建浏览；需主机已在 store，未保存先桥接）。 */
	async listRemoteDir(hostId, path) {
		return jsonSafe(await this.runtime.engine.ls(hostId, path));
	}
	/** 在远端创建目录（递归创建父级）。 */
	async mkdirRemote(hostId, path) {
		await this.runtime.engine.mkdir(hostId, path);
		return { path };
	}
	/** 删除远端文件或空目录（非空目录请先清空内容）。 */
	async removeRemote(hostId, path) {
		await this.runtime.engine.remove(hostId, path);
		return { path };
	}
	/** 创建占位工作区（返回本地占位路径，供用户选为 DSH 工作区）。 */
	async createPlaceholder(hostId, remotePath) {
		const created = await createPlaceholderDir({
			hostId,
			remotePath
		});
		registerPlaceholderWorkspace(this.runtimeCtx, created.localPath, placeholderTitle(hostId, remotePath));
		return created;
	}
	/** 列出全部占位工作区。 */
	async listPlaceholders() {
		return (await listPlaceholders()).map((w) => ({
			hostId: w.hostId,
			remotePath: w.remotePath,
			localPath: w.localPath
		}));
	}
};
//#endregion
//#region src/tools.ts
/**
* Remote-development agent tools: the model's hands on the connected Linux
* server (ssh_list / ssh_exec / ssh_ls / ssh_read / ssh_write / ssh_workspace).
* Registered globally by the host half; cloud-workspace sessions additionally
* get same-name shadow tools (session-tools) routed by the session cwd.
*
* The tools consume the shared SshRuntime (ctx.ssh, host plane): one engine
* serves the tools and the legacy preset-scoped adapters (fs-ssh /
* subprocess-ssh), so a connection established by one is visible to the others.
*/
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Host table render shared by list surfaces. */
function renderHosts(hosts) {
	if (hosts.length === 0) return "no hosts configured — ask the user to add one in 设置 → SSH 连接, or via the 云端（SSH）tab of 添加工作区";
	return [
		"alias | host | port | user | auth | environment | tags | description",
		"--- | --- | --- | --- | --- | --- | --- | ---",
		...hosts.map((host) => [
			host.alias,
			host.host,
			String(host.port),
			host.user,
			host.auth,
			host.environment ?? "-",
			host.tags.length > 0 ? host.tags.join(",") : "-",
			host.description ?? ""
		].join(" | "))
	].join("\n");
}
/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result) {
	const parts = [result.timedOut ? "[timed out]" : `[exit code: ${result.exitCode ?? "null"}]`];
	if (result.stdout !== "") parts.push("stdout:\n" + result.stdout);
	if (result.stderr !== "") parts.push("stderr:\n" + result.stderr);
	if (result.error !== void 0) parts.push("error: " + result.error);
	parts.push(`duration: ${result.durationMs} ms`);
	return parts.join("\n");
}
/** Render one directory listing. */
function renderEntries(entries) {
	if (entries.length === 0) return "(empty directory)";
	return ["type	size	name", ...entries.map((e) => [
		e.type === "dir" ? "d" : e.type === "file" ? "-" : "?",
		String(e.size),
		e.name
	].join("	"))].join("\n");
}
/** Resolve the target alias: explicit wins, else the active connection. */
function resolveAlias(runtime, alias) {
	const explicit = alias?.trim();
	if (explicit !== void 0 && explicit !== "") return explicit;
	const active = runtime.engine.status().alias;
	if (active !== "") return active;
	throw new Error("no alias given and no active connection — pick one from ssh_list");
}
/** The host-list tool. */
function sshListTool(runtime) {
	return defineTool({
		name: "ssh_list",
		description: "List configured SSH hosts (alias, host, user, auth, environment, tags, description). Use ssh_exec etc. with the alias. Triggers: SSH, remote server, server IP/hostname, connect/login, check server/status, deploy, upload/download, jump host.",
		parameters: { query: {
			type: "string",
			description: "Optional fuzzy match against alias, description, host, and tags."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					hosts: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								alias: {
									type: "string",
									required: true
								},
								host: {
									type: "string",
									required: true
								},
								port: {
									type: "integer",
									required: true
								},
								user: {
									type: "string",
									required: true
								},
								auth: {
									type: "string",
									enum: ["key", "password"],
									required: true
								},
								keyReady: {
									type: "boolean",
									required: true
								},
								proxyJump: {
									type: "array",
									items: { type: "string" },
									required: true
								},
								description: { type: "string" },
								environment: { type: "string" },
								tags: {
									type: "array",
									items: { type: "string" },
									required: true
								}
							}
						}
					},
					total: {
						type: "integer",
						required: true,
						description: "All configured hosts count (before query filter)."
					}
				}
			},
			render: (args, value) => {
				if (value.hosts.length === 0) {
					const query = args.query?.trim() ?? "";
					if (value.total > 0 && query !== "") return text(`no hosts match query "${query}" — call ssh_list without query to see all ${value.total} host(s)`);
					return text("no hosts configured — ask the user to add one in the DSH settings panel (设置 → SSH 连接), or place an entry in ~/.ssh/config on the DSH host and call ssh_list again to import");
				}
				return text(renderHosts(value.hosts));
			}
		},
		async execute(args) {
			return {
				hosts: jsonSafe(runtime.engine.list(args.query).map((host) => ({
					alias: host.alias,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: host.auth,
					keyReady: host.keyReady,
					proxyJump: host.proxyJump,
					description: host.description,
					environment: host.environment,
					tags: host.tags
				}))),
				total: runtime.engine.list().length
			};
		}
	});
}
/** Run a shell command on the remote server (foreground or background job). */
function sshExecTool(runtime, jobs) {
	return defineTool({
		name: "ssh_exec",
		description: "Run a shell command on the remote Linux server over SSH and return stdout/stderr/exit code. This is the model's shell on the server: use it for building, installing toolchains (apt/npm/pip), running tests, inspecting processes, and any other server-side work. The server is Linux; POSIX shell syntax applies. For long-running commands (installs, builds, test suites) pass run_in_background:true — no timeout applies; poll with job_output / job_list and stop with job_kill. Triggers: run a command on the server, deploy, build, test on remote, install packages, check server state.",
		parameters: {
			command: {
				type: "string",
				description: "The shell command to run (POSIX sh).",
				required: true
			},
			alias: {
				type: "string",
				description: "Host alias from ssh_list. Defaults to the active connection."
			},
			timeoutMs: {
				type: "integer",
				description: "Optional timeout in milliseconds (default 60000; ignored when run_in_background)."
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
		async execute(args, exec) {
			const alias = resolveAlias(runtime, args.alias);
			if (args.run_in_background === true) return jsonSafe(startRemoteJob({
				engine: runtime.engine,
				jobs
			}, {
				hostId: alias,
				command: args.command,
				...exec?.agent !== void 0 ? { agent: exec.agent } : {}
			}));
			const result = await runtime.engine.exec(alias, args.command, { timeoutMs: args.timeoutMs });
			return jsonSafe({
				kind: "foreground",
				...result,
				exitCode: result.exitCode ?? void 0
			});
		}
	});
}
/** Open, list or close a local port forward through the SSH connection. */
function sshTunnelTool(runtime) {
	return defineTool({
		name: "ssh_tunnel",
		description: "Forward a port from this machine (127.0.0.1) to a port on the remote network through the SSH connection. Use it to preview a remote web service locally, reach a database bound to the server's loopback, or hit an internal host only the server can see. start returns the listening port; stop closes one tunnel; list shows live tunnels. Tunnels close automatically when the connection drops. Triggers: port forward, tunnel, preview remote server locally, access remote database, ssh -L.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"start",
					"stop",
					"list"
				],
				required: true,
				description: "start a forward, stop one by id, or list live forwards."
			},
			alias: {
				type: "string",
				description: "Host alias from ssh_list. Defaults to the active connection."
			},
			remoteHost: {
				type: "string",
				description: "Target host as seen FROM the server (127.0.0.1 for the server itself). Required for start."
			},
			remotePort: {
				type: "integer",
				description: "Target port on remoteHost (1-65535). Required for start."
			},
			localPort: {
				type: "integer",
				description: "Local loopback port to listen on (0 or omitted = pick a free port)."
			},
			id: {
				type: "string",
				description: "Tunnel id returned by start. Required for stop."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: {
						type: "string",
						enum: [
							"start",
							"stop",
							"list"
						],
						required: true
					},
					id: { type: "string" },
					hostId: { type: "string" },
					localHost: { type: "string" },
					localPort: { type: "integer" },
					remoteHost: { type: "string" },
					remotePort: { type: "integer" },
					createdAt: { type: "integer" },
					tunnels: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: {
									type: "string",
									required: true
								},
								hostId: {
									type: "string",
									required: true
								},
								localHost: {
									type: "string",
									required: true
								},
								localPort: {
									type: "integer",
									required: true
								},
								remoteHost: {
									type: "string",
									required: true
								},
								remotePort: {
									type: "integer",
									required: true
								},
								createdAt: {
									type: "integer",
									required: true
								}
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const v = value;
				if (v.action === "start") return text(`forwarding ${v.localHost}:${String(v.localPort)} → ${v.hostId}:${v.remoteHost}:${String(v.remotePort)} (tunnel ${String(v.id)})`);
				if (v.action === "stop") return text(`closed tunnel ${String(v.id)}`);
				const rows = (v.tunnels ?? []).map((t) => `${t.id} | ${t.hostId} | ${t.localHost}:${t.localPort} → ${t.remoteHost}:${t.remotePort}`);
				return text(rows.length === 0 ? "no live tunnels" : [
					"id | host | forward",
					"--- | --- | ---",
					...rows
				].join("\n"));
			}
		},
		async execute(args) {
			if (args.action === "list") return jsonSafe({
				action: "list",
				tunnels: runtime.engine.listTunnels()
			});
			if (args.action === "stop") {
				const id = args.id?.trim();
				if (id === void 0 || id === "") throw new Error("id is required for stop");
				if (!runtime.engine.closeTunnel(id)) throw new Error(`unknown tunnel: ${id}`);
				return jsonSafe({
					action: "stop",
					id
				});
			}
			const alias = resolveAlias(runtime, args.alias);
			if (args.remoteHost === void 0 || args.remoteHost.trim() === "") throw new Error("remoteHost is required for start");
			if (args.remotePort === void 0) throw new Error("remotePort is required for start");
			return jsonSafe({
				action: "start",
				...await runtime.engine.openTunnel(alias, {
					remoteHost: args.remoteHost,
					remotePort: args.remotePort,
					...args.localPort !== void 0 ? { localPort: args.localPort } : {}
				})
			});
		}
	});
}
/** List a remote directory. */
function sshLsTool(runtime) {
	return defineTool({
		name: "ssh_ls",
		description: "List a directory on the remote server (entries sorted: directories first, then files, alphabetically). Use before reading or writing files to locate paths. Triggers: browse the server, list remote directory, find files on the server.",
		parameters: {
			path: {
				type: "string",
				description: "Remote directory path, e.g. /home/user or /var/www.",
				required: true
			},
			alias: {
				type: "string",
				description: "Host alias from ssh_list. Defaults to the active connection."
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
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: {
									type: "string",
									required: true
								},
								type: {
									type: "string",
									enum: [
										"dir",
										"file",
										"other"
									],
									required: true
								},
								size: {
									type: "integer",
									required: true
								},
								mtimeMs: {
									type: "integer",
									required: true
								},
								mode: {
									type: "integer",
									required: true
								}
							}
						}
					}
				}
			},
			render: (_args, value) => text(`${value.path}:\n${renderEntries(value.entries)}`)
		},
		async execute(args) {
			const alias = resolveAlias(runtime, args.alias);
			return jsonSafe({
				path: args.path,
				entries: await runtime.engine.ls(alias, args.path)
			});
		}
	});
}
/** Read a remote file (text, capped at 2 MiB). */
function sshReadTool(runtime) {
	return defineTool({
		name: "ssh_read",
		description: "Read a text file on the remote server over SFTP and return its content (cap: 2 MiB; binary files are refused). Use to inspect server-side code, configs, and logs. Triggers: read a file on the server, view remote config, cat a remote file.",
		parameters: {
			path: {
				type: "string",
				description: "Remote file path.",
				required: true
			},
			alias: {
				type: "string",
				description: "Host alias from ssh_list. Defaults to the active connection."
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
					content: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					},
					size: {
						type: "integer",
						required: true
					},
					mtimeMs: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => text(value.truncated ? `${value.path} (${value.size} bytes, truncated to 2 MiB):\n${value.content}` : `${value.path} (${value.size} bytes):\n${value.content}`)
		},
		async execute(args) {
			const alias = resolveAlias(runtime, args.alias);
			const file = await runtime.engine.readFile(alias, args.path);
			return jsonSafe({
				path: args.path,
				...file
			});
		}
	});
}
/** Write a remote file (text over SFTP). */
function sshWriteTool(runtime) {
	return defineTool({
		name: "ssh_write",
		description: "Write text content to a file on the remote server over SFTP (overwrites; missing parent directories are created automatically). Use for editing server-side code and configs. Triggers: edit a file on the server, save remote file, deploy a config.",
		parameters: {
			path: {
				type: "string",
				description: "Remote file path.",
				required: true
			},
			content: {
				type: "string",
				description: "Full file content to write.",
				required: true
			},
			alias: {
				type: "string",
				description: "Host alias from ssh_list. Defaults to the active connection."
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
					},
					mtimeMs: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => text(`wrote ${value.path} (${value.size} bytes)`)
		},
		async execute(args) {
			const alias = resolveAlias(runtime, args.alias);
			const stat = await runtime.engine.writeFile(alias, args.path, args.content);
			return jsonSafe({
				path: args.path,
				...stat
			});
		}
	});
}
/**
* Create or list placeholder workspaces (a remote dir mapped to a local dir).
*
* `register` is injected by index.ts so the create path registers with the DSH
* workspace registry exactly like the settings-card typert endpoint does — a
* workspace bound through this tool must also show up in "select workspace".
* It is optional: headless runs have no registry, and the placeholder directory
* is usable regardless.
*/
function sshWorkspaceTool(runtime, register) {
	return defineTool({
		name: "ssh_workspace",
		description: "Bind a remote directory as a DSH workspace: create a local placeholder directory (~/.dsh/remote/<host>/<encoded>) the user can pick in the \"select workspace\" dialog; sessions started there run entirely on that host and directory (file tools, search, editor and terminals all target it). Also lists existing placeholder workspaces. Triggers: use a server directory as workspace, work on /path/on/server, which workspace, set up remote workspace.",
		parameters: {
			action: {
				type: "string",
				enum: ["create", "list"],
				description: "create = bind a remote dir; list = show existing bindings.",
				required: true
			},
			host: {
				type: "string",
				description: "Host alias from ssh_list (required for create)."
			},
			path: {
				type: "string",
				description: "Absolute remote directory path, e.g. /home/user/project (required for create)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: {
						type: "string",
						required: true
					},
					localPath: { type: "string" },
					host: { type: "string" },
					remotePath: { type: "string" },
					workspaces: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								host: {
									type: "string",
									required: true
								},
								remotePath: {
									type: "string",
									required: true
								},
								localPath: {
									type: "string",
									required: true
								}
							}
						}
					},
					hint: { type: "string" }
				}
			},
			render: (_args, value) => {
				if (value.action === "list") {
					if (value.workspaces === void 0 || value.workspaces.length === 0) return text("no placeholder workspaces yet — call create with a host and an absolute remote path");
					return text([
						"host | remotePath | localPath",
						"--- | --- | ---",
						...value.workspaces.map((w) => `${w.host} | ${w.remotePath} | ${w.localPath}`)
					].join("\n"));
				}
				return text(`placeholder workspace ready:\n  host: ${value.host}\n  remote: ${value.remotePath}\n  local: ${value.localPath}\n${value.hint ?? ""}`);
			}
		},
		async execute(args) {
			if (args.action === "list") return jsonSafe({
				action: "list",
				workspaces: (await listPlaceholders()).map((w) => ({
					host: w.hostId,
					remotePath: w.remotePath,
					localPath: w.localPath
				}))
			});
			const alias = resolveAlias(runtime, args.host);
			await runtime.getConnectionFor(alias);
			const remotePath = args.path?.trim() ?? "";
			if (remotePath === "" || !remotePath.startsWith("/")) throw new Error("path must be an absolute remote directory path (e.g. /home/user/project)");
			const created = await createPlaceholderDir({
				hostId: alias,
				remotePath
			});
			register?.(created.localPath, placeholderTitle(created.hostId, created.remotePath));
			return jsonSafe({
				action: "create",
				localPath: created.localPath,
				host: created.hostId,
				remotePath: created.remotePath,
				hint: "In the DSH UI use \"select workspace\" on this local path (or start a new session with it) — the session will run on the remote directory."
			});
		}
	});
}
//#endregion
export { sshTunnelTool as a, HOST_TYPERT_CONTRIBUTION as c, registerPlaceholderWorkspace as d, jsonSafe as f, sshReadTool as i, REMOTE_SERVICE as l, routeByCwd as m, sshListTool as n, sshWorkspaceTool as o, resolveRemotePath as p, sshLsTool as r, sshWriteTool as s, sshExecTool as t, SshRemoteService as u };
