import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, join, posix, resolve } from "node:path";
import { Client } from "ssh2";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
//#region src/store.ts
/**
* Host config store: persists SSH host entries to ~/.dsh/dsh-remote-ide.json
* (0600), with import from ~/.ssh/config. The browser and agent only ever see
* the secret-free summary projection.
*/
/** Expand a leading ~ to the user home directory. */
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
/**
* 主机别名的安全白名单：作为对象键与目录段使用——拒绝原型污染键
* （__proto__ / constructor / prototype）与其余危险拼写。
*/
function isSafeHostId(id) {
	return /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}
/** Store file location (overridable for tests). */
function defaultStorePath() {
	return join(homedir(), ".dsh", "dsh-remote-ide.json");
}
function parseSshConfig(text) {
	const blocks = [];
	let current;
	let inHost = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#") || line.startsWith("!")) {
			if (line.startsWith("!") && inHost && current) {}
			continue;
		}
		const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1].toLowerCase();
		const value = match[2].trim();
		if (key === "host") {
			if (inHost && current && current.hostName) blocks.push(current);
			current = { name: value };
			inHost = true;
			continue;
		}
		if (!inHost || !current) continue;
		switch (key) {
			case "hostname":
				current.hostName = value;
				break;
			case "port":
				current.port = Number.parseInt(value, 10) || void 0;
				break;
			case "user":
				current.user = value;
				break;
			case "identityfile":
				if (current.identityFile === void 0) current.identityFile = value;
				break;
			default: break;
		}
	}
	if (inHost && current && current.hostName) blocks.push(current);
	return blocks;
}
/** Read the ssh config file, returning its text or undefined when missing. */
function readSshConfigFile() {
	const path = join(homedir(), ".ssh", "config");
	try {
		return readFileSync(path, "utf8");
	} catch {
		return;
	}
}
/** The host store. */
var HostStore = class {
	file;
	entries = /* @__PURE__ */ new Map();
	/**
	* @param file - store file path (defaults to ~/.dsh/dsh-remote-ide.json).
	*/
	constructor(file) {
		this.file = file ?? defaultStorePath();
		this.load();
	}
	load() {
		try {
			const raw = readFileSync(this.file, "utf8");
			const parsed = JSON.parse(raw);
			for (const entry of parsed.hosts ?? []) if (entry && typeof entry.alias === "string" && entry.alias !== "") this.entries.set(entry.alias, entry);
		} catch {}
	}
	save() {
		const dir = dirname(this.file);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const tmp = this.file + ".tmp";
		writeFileSync(tmp, JSON.stringify({ hosts: [...this.entries.values()] }, null, 2), {
			encoding: "utf8",
			mode: 384
		});
		try {
			chmodSync(tmp, 384);
		} catch {}
		renameSync(tmp, this.file);
		this.tightenWindowsAcl();
	}
	/**
	* Windows 收紧凭据文件的 ACL（best-effort）：chmod 在 Windows 是 no-op，
	* 新文件继承目录 ACL——本机 `.dsh` 的继承链含沙箱用户组的读取权，明文口令
	* 因此可被沙箱进程读到。断继承并仅授予管理员/SYSTEM/当前用户；非 Windows
	* 或 icacls 不可用时静默跳过（下一次 save 会重试）。
	*/
	tightenWindowsAcl() {
		if (process.platform !== "win32") return;
		try {
			const user = process.env.USERNAME ?? "Administrator";
			execFileSync("icacls", [
				this.file,
				"/inheritance:r",
				"/grant:r",
				"*S-1-5-32-544:F",
				"*S-1-5-18:F",
				`${user}:F`
			], { stdio: "ignore" });
		} catch {}
	}
	/** All entries, sorted by alias. */
	list() {
		return [...this.entries.values()].sort((a, b) => a.alias.localeCompare(b.alias));
	}
	/** Secret-free projection. */
	summarize(entry) {
		return {
			alias: entry.alias,
			host: entry.host,
			port: entry.port,
			user: entry.user,
			auth: entry.auth.kind,
			keyReady: entry.auth.kind !== "key" || existsSync(expandHome(entry.auth.keyPath ?? "")),
			proxyJump: [...entry.proxyJump],
			description: entry.description,
			environment: entry.environment,
			tags: [...entry.tags],
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt
		};
	}
	get(alias) {
		return this.entries.get(alias);
	}
	/** Create or update an entry (by the payload alias or entry.alias). */
	upsert(payload, existingAlias) {
		const now = Date.now();
		const alias = (existingAlias ?? payload.alias ?? "").trim();
		if (alias === "") throw new Error("alias is required");
		if (!isSafeHostId(alias)) throw new Error(`unsafe host alias: ${JSON.stringify(alias)}`);
		const prev = this.entries.get(alias);
		const entry = {
			alias,
			host: payload.host.trim(),
			port: payload.port ?? prev?.port ?? 22,
			user: payload.user.trim(),
			auth: payload.auth ?? prev?.auth ?? {
				kind: "password",
				password: ""
			},
			proxyJump: payload.proxyJump ?? prev?.proxyJump ?? [],
			description: payload.description ?? prev?.description,
			environment: payload.environment ?? prev?.environment,
			tags: payload.tags ?? prev?.tags ?? [],
			createdAt: prev?.createdAt ?? now,
			updatedAt: now
		};
		if (entry.host === "") throw new Error("host is required");
		if (entry.user === "") throw new Error("user is required");
		if (entry.auth.kind === "password" && entry.auth.password === "" && prev === void 0) throw new Error("password is required for password auth");
		if (entry.auth.kind === "key" && !entry.auth.keyPath) throw new Error("keyPath is required for key auth");
		this.entries.set(alias, entry);
		this.save();
		return entry;
	}
	remove(alias) {
		const removed = this.entries.delete(alias);
		if (removed) this.save();
		return removed;
	}
	/** Import hosts from ~/.ssh/config. Returns counts per outcome. */
	importSshConfig() {
		const text = readSshConfigFile();
		if (text === void 0) return {
			parsed: 0,
			added: 0,
			skipped: 0,
			skippedNames: []
		};
		const blocks = parseSshConfig(text);
		let added = 0;
		const skippedNames = [];
		for (const block of blocks) {
			if (!block.hostName || block.name.includes("*") || block.name.includes("?")) {
				skippedNames.push(block.name);
				continue;
			}
			const alias = block.name.trim();
			if (alias === "" || this.entries.has(alias)) {
				skippedNames.push(alias);
				continue;
			}
			this.upsert({
				alias,
				host: block.hostName,
				port: block.port,
				user: block.user ?? process.env.USER ?? "root",
				auth: {
					kind: "key",
					keyPath: block.identityFile ?? "~/.ssh/id_ed25519"
				},
				tags: ["ssh-config"]
			}, void 0);
			added += 1;
		}
		return {
			parsed: blocks.length,
			added,
			skipped: skippedNames.length,
			skippedNames: skippedNames.slice(0, 50)
		};
	}
	/** Resolve a private-key path (expand ~) against the store dir for imports. */
	resolveKeyPath(keyPath) {
		return resolve(expandHome(keyPath));
	}
};
//#endregion
//#region src/debug-log.ts
/**
* dsh-remote-ide — 文件级诊断日志。
*
* scope.logger 不落盘（web 进程的 stdout 也几乎为空），关键链路（会话路由、
* settings 迁移等）必须自己留痕才能在真机上定位。512KiB 自动重置。
*/
const LIMIT = 512 * 1024;
let bytes = -1;
function file() {
	return join(homedir(), ".dsh", "dsh-remote-ide-debug.log");
}
function debugLog(message) {
	try {
		const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${message}\n`;
		if (bytes < 0) try {
			bytes = statSync(file()).size;
		} catch {
			bytes = 0;
		}
		if (bytes > LIMIT) {
			writeFileSync(file(), line, "utf8");
			bytes = Buffer.byteLength(line);
			return;
		}
		appendFileSync(file(), line, "utf8");
		bytes += Buffer.byteLength(line);
	} catch {}
}
//#endregion
//#region src/engine.ts
/**
* The remote-IDE SSH engine: a per-alias persistent connection pool (ssh2)
* with jump-host support, command execution, PTY shells and SFTP file
* operations — the DSH counterpart of a remote-development backend, living
* entirely in the host process.
*/
const DEFAULTS = {
	idleTimeoutMs: 30 * 6e4,
	connectTimeoutMs: 15e3,
	keepaliveIntervalMs: 15e3,
	maxOutputBytes: 2 * 1024 * 1024,
	defaultExecTimeoutMs: 6e4,
	maxReadBytes: 2 * 1024 * 1024
};
/** Build the ssh2 connect config for one entry (key read from disk). */
function buildConnectConfig(entry, sock, readyTimeoutMs) {
	const config = {
		host: entry.host,
		port: entry.port,
		username: entry.user,
		readyTimeout: readyTimeoutMs ?? 15e3,
		keepaliveInterval: 15e3,
		keepaliveCountMax: 3
	};
	if (sock !== void 0) config.sock = sock;
	config.tryKeyboard = true;
	if (entry.auth.kind === "password") config.password = entry.auth.password;
	else {
		const keyPath = entry.auth.keyPath === void 0 ? void 0 : expandHome(entry.auth.keyPath);
		if (keyPath === void 0 || !existsSync(keyPath)) throw new Error(`private key not found: '${entry.auth.keyPath ?? "(unset)"}'`);
		config.privateKey = readFileSync(keyPath, "utf8");
		if (entry.auth.passphrase !== void 0 && entry.auth.passphrase !== "") config.passphrase = entry.auth.passphrase;
	}
	return config;
}
/** Connect one ssh2 client (resolve on ready, reject on error/close). */
function connectClient(config, password) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		client.on("error", () => {});
		let settled = false;
		client.once("ready", () => {
			if (settled) return;
			settled = true;
			resolve(client);
		});
		client.once("error", (error) => {
			if (settled) return;
			settled = true;
			try {
				client.end();
			} catch {}
			reject(error instanceof Error ? error : new Error(String(error)));
		});
		client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
			finish(prompts.map(() => password ?? ""));
		});
		try {
			client.connect(config);
		} catch (error) {
			if (!settled) {
				settled = true;
				try {
					client.end();
				} catch {}
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
	});
}
/** Cap captured output at the configured byte budget (marks truncation). */
function appendOutput(target, chunk, maxBytes) {
	if (target.truncated) return;
	if (target.text.length + chunk.length > maxBytes) {
		let cut = chunk.toString("utf8").slice(0, maxBytes - target.text.length);
		if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
		target.text += cut + "…[output truncated]";
		target.truncated = true;
		return;
	}
	target.text += chunk.toString("utf8");
}
/** The engine. Owns the pool, the active IDE connection and all operations. */
var SshEngine = class {
	store;
	opts;
	pool = /* @__PURE__ */ new Map();
	/** In-flight connect attempts (concurrent callers await instead of racing). */
	connecting = /* @__PURE__ */ new Map();
	/** Live local port forwards (`127.0.0.1 → remote`), owned per alias. */
	tunnels = /* @__PURE__ */ new Map();
	sweepTimer;
	/** Alias of the connection the IDE workspace is bound to ('' = none). */
	activeAlias = "";
	state = "disconnected";
	lastError;
	connectedAt;
	constructor(store, options) {
		this.store = store;
		this.opts = {
			...DEFAULTS,
			...options
		};
		this.sweepTimer = setInterval(() => this.sweep(), Math.max(1e4, this.opts.idleTimeoutMs / 4));
		this.sweepTimer.unref?.();
	}
	/** Secret-free host list (filtered by the optional query). */
	list(query) {
		const needle = query?.trim().toLowerCase();
		return this.store.list().filter((entry) => needle === void 0 || needle === "" || entry.alias.toLowerCase().includes(needle) || (entry.description ?? "").toLowerCase().includes(needle) || entry.host.toLowerCase().includes(needle) || entry.tags.some((tag) => tag.toLowerCase().includes(needle))).map((entry) => this.store.summarize(entry));
	}
	/** One host summary by alias. */
	get(alias) {
		const entry = this.store.get(alias);
		return entry === void 0 ? void 0 : this.store.summarize(entry);
	}
	/** Full stored entry (secrets included) — host-plane internal use only. */
	getEntry(alias) {
		return this.store.get(alias);
	}
	/** Create or update a host. */
	upsertHost(payload, existingAlias) {
		return this.store.upsert(payload, existingAlias);
	}
	removeHost(alias) {
		if (this.activeAlias === alias) this.disconnect();
		this.dropConnection(alias);
		return this.store.remove(alias);
	}
	importSshConfig() {
		return this.store.importSshConfig();
	}
	/** Test a host without keeping a pooled connection. */
	async test(alias) {
		const entry = this.store.get(alias);
		if (entry === void 0) return {
			ok: false,
			error: `unknown host: ${alias}`
		};
		return this.testEntry(entry);
	}
	/**
	* Test an ad-hoc host config (settings-card "test connection" endpoint).
	* Builds an entry from the config and runs the same probe as test().
	*/
	async testConfig(config) {
		const entry = {
			alias: "(probe)",
			host: config.host,
			port: config.port ?? 22,
			user: config.user,
			auth: config.auth,
			proxyJump: config.proxyJump ?? [],
			tags: [],
			createdAt: 0,
			updatedAt: 0
		};
		return this.testEntry(entry);
	}
	/** Shared probe: connect (optionally through the jump chain) and exec echo. */
	async testEntry(entry) {
		const started = Date.now();
		let client;
		const hops = [];
		try {
			const config = buildConnectConfig(entry, void 0, this.opts.connectTimeoutMs);
			const password = entry.auth.kind === "password" ? entry.auth.password : void 0;
			if (entry.proxyJump.length > 0) {
				const opened = await this.connectHops(entry);
				for (const hop of opened) hops.push(hop.client);
				config.sock = opened[opened.length - 1].sock;
			}
			client = await connectClient(config, password);
			return {
				ok: await new Promise((resolve) => {
					client.exec("echo dsh-remote-ide-ping", (error, stream) => {
						if (error) {
							resolve(false);
							return;
						}
						stream.resume();
						stream.on("close", () => resolve(true));
					});
				}),
				latencyMs: Date.now() - started
			};
		} catch (error) {
			return {
				ok: false,
				latencyMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error)
			};
		} finally {
			client?.end();
			for (const hop of hops) try {
				hop.end();
			} catch {}
		}
	}
	/**
	* Open (or reuse) the pooled connection for a host. Concurrent callers
	* while a connect attempt is in flight await that same attempt — they must
	* never observe a record whose client has not been assigned yet.
	*/
	async ensureConnection(alias) {
		const existing = this.pool.get(alias);
		if (existing !== void 0 && existing.client !== void 0 && !existing.broken) return existing;
		const inflight = this.connecting.get(alias);
		if (inflight !== void 0) return inflight;
		const attempt = this.openPoolRecord(alias);
		this.connecting.set(alias, attempt);
		attempt.catch(() => {});
		return attempt;
	}
	/** Build one pooled connection record (pool + in-flight registry updated). */
	async openPoolRecord(alias) {
		try {
			const entry = this.store.get(alias);
			if (entry === void 0) throw new Error(`unknown host: ${alias}`);
			this.dropConnection(alias);
			const record = {
				client: void 0,
				hops: [],
				idleAt: Date.now(),
				broken: false,
				inFlight: 0
			};
			this.pool.set(alias, record);
			const config = buildConnectConfig(entry, void 0, this.opts.connectTimeoutMs);
			if (entry.proxyJump.length > 0) {
				const hops = await this.connectHops(entry);
				config.sock = hops[hops.length - 1].sock;
				record.hops = hops.map((h) => h.client);
			}
			let client;
			try {
				client = await connectClient(config, entry.auth.kind === "password" ? entry.auth.password : void 0);
			} catch (error) {
				for (const hop of record.hops) try {
					hop.end();
				} catch {}
				throw error;
			}
			record.client = client;
			client.on("error", (error) => {
				record.broken = true;
				if (this.activeAlias === alias) {
					this.state = "failed";
					this.lastError = error instanceof Error ? error.message : String(error);
				}
			});
			client.on("close", () => {
				record.broken = true;
				if (this.activeAlias === alias) {
					this.state = "disconnected";
					this.activeAlias = "";
					this.connectedAt = void 0;
				}
			});
			record.idleAt = Date.now();
			return record;
		} catch (error) {
			this.pool.delete(alias);
			throw error;
		} finally {
			this.connecting.delete(alias);
		}
	}
	/** Open the jump chain for an entry (returns hop sockets in order). */
	async connectHops(entry) {
		const hops = [];
		try {
			for (const hopAlias of entry.proxyJump) {
				const hop = this.store.get(hopAlias);
				if (hop === void 0) throw new Error(`jump host not found: ${hopAlias}`);
				const config = buildConnectConfig(hop, void 0, this.opts.connectTimeoutMs);
				if (hops.length > 0) config.sock = hops[hops.length - 1].sock;
				const client = await connectClient(config, hop.auth.kind === "password" ? hop.auth.password : void 0);
				const sock = client.sock;
				hops.push({
					client,
					sock
				});
			}
			return hops;
		} catch (error) {
			for (const hop of hops) try {
				hop.client.end();
			} catch {}
			throw error;
		}
	}
	/** Whether the pooled connection for a host is marked broken (rebuild decision). */
	isBroken(alias) {
		return this.pool.get(alias)?.broken ?? false;
	}
	/** Resolve (or reuse) the remote $HOME of a connection. */
	async resolveHome(alias) {
		const record = await this.ensureConnection(alias);
		if (record.home !== void 0) return record.home;
		try {
			record.home = (await this.exec(alias, "printf %s \"$HOME\"", { timeoutMs: 1e4 })).stdout.trim() || void 0;
		} catch {}
		return record.home;
	}
	/** The current IDE workspace status. */
	status() {
		const active = this.activeAlias === "" ? void 0 : this.pool.get(this.activeAlias);
		return {
			state: this.state,
			alias: this.activeAlias,
			home: active?.home,
			cwd: active?.home,
			error: this.lastError,
			connectedAt: this.connectedAt
		};
	}
	/** Cached remote $HOME of a host, if it has been resolved (sync read). */
	homeOf(alias) {
		return this.pool.get(alias)?.home;
	}
	/** Bind the IDE workspace to a host (connects on demand). */
	async connect(alias) {
		if (this.activeAlias !== "" && this.activeAlias !== alias) {
			this.activeAlias = "";
			this.state = "disconnected";
		}
		this.activeAlias = alias;
		this.state = "connecting";
		this.lastError = void 0;
		try {
			const record = await this.ensureConnection(alias);
			this.state = "connected";
			this.connectedAt = Date.now();
			if (record.home === void 0) try {
				record.home = (await this.exec(alias, "printf %s \"$HOME\"", { timeoutMs: 1e4 })).stdout.trim() || void 0;
			} catch {}
			return this.status();
		} catch (error) {
			this.state = "failed";
			this.lastError = error instanceof Error ? error.message : String(error);
			return this.status();
		}
	}
	/** Unbind the IDE workspace. */
	disconnect() {
		this.activeAlias = "";
		this.state = "disconnected";
		this.connectedAt = void 0;
		return this.status();
	}
	/**
	* Open a local port forward through the pooled connection.
	* Binds 127.0.0.1 only; each accepted socket is tunnelled with
	* `client.forwardOut`. The tunnel holds one `inFlight` slot so the idle
	* sweep never closes the connection under a live forward.
	*/
	async openTunnel(alias, options) {
		const remoteHost = options.remoteHost.trim();
		if (remoteHost === "") throw new Error("remoteHost is required");
		const { remotePort } = options;
		if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error("remotePort must be 1-65535");
		const localPort = options.localPort ?? 0;
		if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) throw new Error("localPort must be 0-65535");
		const record = await this.ensureConnection(alias);
		const tunnel = {
			id: randomUUID(),
			hostId: alias,
			localHost: "127.0.0.1",
			localPort,
			remoteHost,
			remotePort,
			createdAt: Date.now()
		};
		const server = createServer((socket) => {
			record.client.forwardOut("127.0.0.1", socket.remotePort ?? 0, remoteHost, remotePort, (error, stream) => {
				if (error) {
					debugLog(`tunnel forwardOut ${remoteHost}:${String(remotePort)} failed: ${error.message}`);
					socket.destroy();
					return;
				}
				socket.pipe(stream).pipe(socket);
				const teardown = () => {
					try {
						stream.close();
					} catch {}
					socket.destroy();
				};
				socket.on("error", teardown);
				stream.on("error", teardown);
				stream.on("close", () => socket.destroy());
			});
		});
		record.inFlight += 1;
		record.idleAt = Date.now();
		try {
			await new Promise((resolve, reject) => {
				const onError = (error) => {
					server.removeListener("error", onError);
					reject(error);
				};
				server.once("error", onError);
				server.listen(localPort, "127.0.0.1", () => {
					server.removeListener("error", onError);
					resolve();
				});
			});
		} catch (error) {
			record.inFlight = Math.max(0, record.inFlight - 1);
			throw error;
		}
		const address = server.address();
		if (typeof address === "object" && address !== null) tunnel.localPort = address.port;
		this.tunnels.set(tunnel.id, {
			info: tunnel,
			server,
			alias
		});
		server.on("close", () => {
			this.tunnels.delete(tunnel.id);
			record.inFlight = Math.max(0, record.inFlight - 1);
			record.idleAt = Date.now();
		});
		return tunnel;
	}
	/** All live local forwards. */
	listTunnels() {
		return [...this.tunnels.values()].map((entry) => entry.info);
	}
	/** Close one forward; false when the id is unknown (already closed). */
	closeTunnel(id) {
		const entry = this.tunnels.get(id);
		if (entry === void 0) return false;
		try {
			entry.server.close();
		} catch {}
		this.tunnels.delete(id);
		return true;
	}
	/** Drop every forward bound to an alias (connection teardown path). */
	closeTunnelsFor(alias) {
		for (const [id, entry] of [...this.tunnels]) {
			if (entry.alias !== alias) continue;
			try {
				entry.server.close();
			} catch {}
			this.tunnels.delete(id);
		}
	}
	/**
	* Open a streaming exec channel without collection, timeouts, or exit-code
	* normalization. Data flows as soon as the channel resolves; listeners
	* registered later still receive every event because pre-resolution events
	* are buffered until the first listener appears.
	*/
	async openChannel(alias, command, options) {
		const record = await this.ensureConnection(alias);
		record.inFlight += 1;
		record.idleAt = Date.now();
		return await new Promise((resolve, reject) => {
			const prefix = options?.cwd ? `cd ${quoteSh(options.cwd)} && ` : "";
			record.client.exec(prefix + command, (error, stream) => {
				if (error) {
					record.inFlight -= 1;
					record.idleAt = Date.now();
					reject(error);
					return;
				}
				const stdoutListeners = [];
				const stderrListeners = [];
				const closeListeners = [];
				const pending = {
					stdout: [],
					stderr: []
				};
				let pendingClose;
				const release = () => {
					record.inFlight -= 1;
					record.idleAt = Date.now();
				};
				stream.on("data", (chunk) => {
					if (stdoutListeners.length === 0) pending.stdout.push(chunk);
					else for (const listener of stdoutListeners) listener(chunk);
				});
				stream.stderr.on("data", (chunk) => {
					if (stderrListeners.length === 0) pending.stderr.push(chunk);
					else for (const listener of stderrListeners) listener(chunk);
				});
				stream.on("close", (code, signal) => {
					release();
					if (closeListeners.length === 0) pendingClose = [code, signal];
					else for (const listener of closeListeners) listener(code, signal);
				});
				stream.on("error", () => {});
				resolve({
					onStdout(listener) {
						stdoutListeners.push(listener);
						if (pending.stdout.length > 0) {
							const buffered = pending.stdout.splice(0);
							for (const chunk of buffered) listener(chunk);
						}
					},
					onStderr(listener) {
						stderrListeners.push(listener);
						if (pending.stderr.length > 0) {
							const buffered = pending.stderr.splice(0);
							for (const chunk of buffered) listener(chunk);
						}
					},
					onClose(listener) {
						if (pendingClose !== void 0) {
							const [code, signal] = pendingClose;
							pendingClose = void 0;
							listener(code, signal);
							return;
						}
						closeListeners.push(listener);
					},
					write(data) {
						if (!stream.destroyed) stream.write(data);
					},
					end() {
						if (!stream.destroyed && !stream.writableEnded) stream.end();
					},
					close() {
						stream.close();
					}
				});
			});
		});
	}
	/** Run one command on a host with a timeout and output caps. */
	async exec(alias, command, options) {
		const record = await this.ensureConnection(alias);
		const started = Date.now();
		const timeoutMs = options?.timeoutMs ?? this.opts.defaultExecTimeoutMs;
		record.inFlight += 1;
		record.idleAt = Date.now();
		try {
			return await new Promise((resolve) => {
				const prefix = options?.cwd ? `cd ${quoteSh(options.cwd)} && ` : "";
				record.client.exec(prefix + command, (error, stream) => {
					if (error) {
						resolve({
							success: false,
							exitCode: null,
							timedOut: false,
							stdout: "",
							stderr: "",
							durationMs: Date.now() - started,
							error: error.message
						});
						return;
					}
					const stdout = {
						text: "",
						truncated: false
					};
					const stderr = {
						text: "",
						truncated: false
					};
					let timedOut = false;
					const timer = setTimeout(() => {
						timedOut = true;
						stream.close();
					}, timeoutMs);
					stream.on("data", (chunk) => appendOutput(stdout, chunk, this.opts.maxOutputBytes));
					stream.stderr.on("data", (chunk) => appendOutput(stderr, chunk, this.opts.maxOutputBytes));
					stream.on("close", (code) => {
						clearTimeout(timer);
						resolve({
							success: !timedOut && (code === null || code === 0),
							exitCode: timedOut ? null : code,
							timedOut,
							stdout: stdout.text,
							stderr: stderr.text,
							durationMs: Date.now() - started
						});
					});
					stream.on("error", () => {
						clearTimeout(timer);
						resolve({
							success: false,
							exitCode: null,
							timedOut,
							stdout: stdout.text,
							stderr: stderr.text,
							durationMs: Date.now() - started,
							error: "channel error"
						});
					});
				});
			});
		} finally {
			record.inFlight -= 1;
			record.idleAt = Date.now();
		}
	}
	/** Open a PTY shell on the active connection (WebSocket terminal). */
	async openShell(alias, cols, rows) {
		const record = await this.ensureConnection(alias);
		record.inFlight += 1;
		record.idleAt = Date.now();
		return await new Promise((resolve, reject) => {
			record.client.shell({
				term: "xterm-256color",
				cols,
				rows
			}, (error, channel) => {
				if (error) {
					record.inFlight -= 1;
					reject(error);
					return;
				}
				const session = {
					onData: void 0,
					onExit: void 0,
					send(data) {
						channel.write(data);
					},
					resize(c, r) {
						channel.setWindow(r, c, 0, 0);
					},
					pause() {
						channel.pause();
					},
					resume() {
						channel.resume();
					},
					close() {
						channel.close();
					}
				};
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					record.inFlight -= 1;
					record.idleAt = Date.now();
				};
				channel.on("data", (chunk) => session.onData?.(chunk));
				channel.on("close", () => {
					release();
					session.onExit?.(null);
				});
				channel.on("error", (error) => {
					release();
					session.onExit?.(null, error.message);
				});
				resolve(session);
			});
		});
	}
	/** Get (and lazily open) the SFTP subsystem of a connection. */
	async getSftp(alias) {
		const record = await this.ensureConnection(alias);
		if (record.sftp !== void 0) return record.sftp;
		record.sftpReady ??= new Promise((resolve, reject) => {
			record.client.sftp((error, sftp) => {
				if (error) {
					record.sftpReady = void 0;
					reject(error);
					return;
				}
				record.sftp = sftp;
				resolve(sftp);
			});
		});
		return record.sftpReady;
	}
	/** List a remote directory. */
	async ls(alias, path) {
		const sftp = await this.getSftp(alias);
		return (await new Promise((resolve, reject) => {
			sftp.readdir(path, (error, list) => {
				if (error) reject(error);
				else resolve(list);
			});
		})).map((entry) => {
			const mode = entry.attrs.mode;
			const isDir = (mode & 61440) === 16384;
			const isFile = (mode & 61440) === 32768;
			return {
				name: entry.filename,
				type: isDir ? "dir" : isFile ? "file" : "other",
				size: entry.attrs.size,
				mtimeMs: entry.attrs.mtime * 1e3,
				mode
			};
		}).sort((a, b) => {
			if (a.type === "dir" && b.type !== "dir") return -1;
			if (a.type !== "dir" && b.type === "dir") return 1;
			return a.name.localeCompare(b.name);
		});
	}
	/** Read a remote file into text (capped at maxReadBytes). */
	async readFile(alias, path) {
		const sftp = await this.getSftp(alias);
		const stat = await new Promise((resolve, reject) => {
			sftp.stat(path, (error, stats) => {
				if (error) reject(error);
				else resolve(stats);
			});
		});
		if (stat.isDirectory()) throw new Error(`cannot read directory: ${path}`);
		const cap = this.opts.maxReadBytes;
		const truncated = stat.size > cap;
		const buffer = truncated ? await new Promise((resolve, reject) => {
			const chunks = [];
			const stream = sftp.createReadStream(path, {
				start: 0,
				end: cap - 1
			});
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", () => resolve(Buffer.concat(chunks)));
			stream.on("error", reject);
		}) : await new Promise((resolve, reject) => {
			sftp.readFile(path, (error, data) => {
				if (error) reject(error);
				else resolve(data);
			});
		});
		const slice = truncated ? buffer.subarray(0, cap) : buffer;
		if (slice.subarray(0, 8192).includes(0)) throw new Error(`binary file (${stat.size} bytes); preview is not supported`);
		return {
			content: slice.toString("utf8"),
			truncated,
			size: stat.size,
			mtimeMs: stat.mtime * 1e3
		};
	}
	/** Write text to a remote file (missing parent directories are created). */
	async writeFile(alias, path, content) {
		const sftp = await this.getSftp(alias);
		const write = () => new Promise((resolve, reject) => {
			sftp.writeFile(path, Buffer.from(content, "utf8"), (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
		try {
			await write();
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			await this.mkdirParents(sftp, path);
			await write();
		}
		const stat = await new Promise((resolve, reject) => {
			sftp.stat(path, (error, stats) => {
				if (error) reject(error);
				else resolve(stats);
			});
		});
		return {
			size: stat.size,
			mtimeMs: stat.mtime * 1e3
		};
	}
	/** Create the missing parent directories of a remote path (bottom-up scan). */
	async mkdirParents(sftp, path) {
		let dir = posix.dirname(path);
		const missing = [];
		while (dir !== "/" && dir !== "." && dir !== "") {
			if (await new Promise((resolve, reject) => {
				sftp.stat(dir, (error) => {
					if (error === void 0 || error === null) resolve(true);
					else if (isMissingPathError(error)) resolve(false);
					else reject(error);
				});
			})) break;
			missing.push(dir);
			dir = posix.dirname(dir);
		}
		for (const target of missing.reverse()) await new Promise((resolve, reject) => {
			sftp.mkdir(target, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}
	/** Create a remote directory (recursively via mkdir -p fallback). */
	async mkdir(alias, path) {
		const sftp = await this.getSftp(alias);
		await new Promise((resolve, reject) => {
			sftp.mkdir(path, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}
	/** Remove a remote file or empty directory. */
	async remove(alias, path) {
		const sftp = await this.getSftp(alias);
		await new Promise((resolve, reject) => {
			sftp.stat(path, (statError, stats) => {
				if (statError) {
					reject(statError);
					return;
				}
				(stats.isDirectory() ? (cb) => sftp.rmdir(path, cb) : (cb) => sftp.unlink(path, cb))((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		});
	}
	/** Rename or move a remote path. */
	async rename(alias, from, to) {
		const sftp = await this.getSftp(alias);
		await new Promise((resolve, reject) => {
			sftp.rename(from, to, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}
	/** Close idle connections (keeps the active one and pinned ones). */
	sweep() {
		const now = Date.now();
		for (const [alias, record] of this.pool) {
			if (record.inFlight > 0) continue;
			if (alias === this.activeAlias) continue;
			if (now - record.idleAt < this.opts.idleTimeoutMs) continue;
			this.dropConnection(alias);
		}
	}
	/** Tear down one pooled connection. */
	dropConnection(alias) {
		this.closeTunnelsFor(alias);
		const record = this.pool.get(alias);
		if (record === void 0) return;
		this.pool.delete(alias);
		for (const hop of record.hops) try {
			hop.end();
		} catch {}
		try {
			record.client.end();
		} catch {}
	}
	/** Close every connection and stop the sweeper. */
	dispose() {
		if (this.sweepTimer !== void 0) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = void 0;
		}
		for (const alias of [...this.pool.keys()]) this.dropConnection(alias);
		this.activeAlias = "";
		this.state = "disconnected";
	}
};
/** POSIX single-quote escaping for remote shell interpolation. */
function quoteSh(value) {
	return "'" + value.replace(/'/g, `'\\''`) + "'";
}
/** SFTP 错误的「路径不存在」判定（跨实现的错误消息匹配）。 */
function isMissingPathError(error) {
	return /no such file|ENOENT|not found/i.test(error instanceof Error ? error.message : String(error));
}
//#endregion
export { defaultStorePath as a, HostStore as i, quoteSh as n, debugLog as r, SshEngine as t };
