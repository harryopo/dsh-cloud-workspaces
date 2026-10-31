/**
 * The remote-IDE SSH engine: a per-alias persistent connection pool (ssh2)
 * with jump-host support, command execution, PTY shells and SFTP file
 * operations — the DSH counterpart of a remote-development backend, living
 * entirely in the host process.
 */
import { Client } from 'ssh2';
import type { ExecResult, RemoteDirEntry, RemoteFileContent, RemoteTunnel, SshAuthKind, SshHostEntry, SshHostSummary, TestResult, WorkspaceStatus } from './protocol';
import { type HostStore } from './store';
/** Engine knobs. */
export interface EngineOptions {
    /** Connections idle longer than this are closed (ms). */
    idleTimeoutMs?: number;
    /** SSH handshake timeout (ms). */
    connectTimeoutMs?: number;
    /** Keepalive ping interval (ms). */
    keepaliveIntervalMs?: number;
    /** Cap on captured stdout/stderr bytes per exec. */
    maxOutputBytes?: number;
    /** Default exec timeout (ms). */
    defaultExecTimeoutMs?: number;
    /** Cap on remote file bytes read into the editor (larger files are truncated). */
    maxReadBytes?: number;
}
/** One pooled connection record. */
interface PoolRecord {
    client: Client;
    /** Jump-chain clients kept alive under the target. */
    hops: Client[];
    /** SFTP subsystem handle, lazily opened. */
    sftp?: import('ssh2').SFTPWrapper;
    sftpReady?: Promise<import('ssh2').SFTPWrapper>;
    /** Remote $HOME, resolved lazily. */
    home?: string;
    idleAt: number;
    broken: boolean;
    /** Operations currently running on this connection (sweep guard). */
    inFlight: number;
}
/**
 * Low-level streaming command channel: raw duplex access to one SSH exec
 * channel without collection, timeouts, or exit-code normalization. The
 * subprocess adapter (subprocess-ssh) builds its wrapper protocol and
 * tree-scoped termination on top of this seam.
 *
 * stdout/stderr are delivered as distinct Buffer streams (ssh2 keeps the
 * remote stderr on an extended-data channel); the close event carries the
 * remote exit-status (code) or, for a signal death, null plus the signal
 * name — matching the Node child-process vocabulary the subprocess seam uses.
 */
export interface SshExecChannel {
    /** Register a stdout-data listener (Buffer chunks, delivery order). */
    onStdout(listener: (chunk: Buffer) => void): void;
    /** Register a stderr-data listener (Buffer chunks, delivery order). */
    onStderr(listener: (chunk: Buffer) => void): void;
    /** Register a close listener: `(code)` on normal exit, `(null, signal)` on signal death. */
    onClose(listener: (code: number | null, signal: string | null) => void): void;
    /** Write bytes to the channel's stdin. */
    write(data: Buffer | string): void;
    /** Send EOF on stdin (the remote child sees `read(0)` return 0). */
    end(): void;
    /** Close the channel immediately without waiting for the remote side. */
    close(): void;
}
/** A live PTY shell session. */
export interface ShellSession {
    /** Assign to receive remote output. */
    onData?: (data: Buffer) => void;
    /** Assign to be notified when the channel closes. */
    onExit?: (code: number | null, error?: string) => void;
    /** Write raw input to the shell. */
    send(data: string): void;
    /** Resize the remote PTY. */
    resize(cols: number, rows: number): void;
    /** Pause remote output delivery (transport backpressure). */
    pause(): void;
    /** Resume remote output delivery. */
    resume(): void;
    /** Close the session and its channel. */
    close(): void;
}
/** The engine. Owns the pool, the active IDE connection and all operations. */
export declare class SshEngine {
    private readonly store;
    private readonly opts;
    private readonly pool;
    /** In-flight connect attempts (concurrent callers await instead of racing). */
    private readonly connecting;
    /** Live local port forwards (`127.0.0.1 → remote`), owned per alias. */
    private readonly tunnels;
    private sweepTimer;
    /** Alias of the connection the IDE workspace is bound to ('' = none). */
    private activeAlias;
    private state;
    private lastError;
    private connectedAt;
    constructor(store: HostStore, options?: EngineOptions);
    /** Secret-free host list (filtered by the optional query). */
    list(query?: string): SshHostSummary[];
    /** One host summary by alias. */
    get(alias: string): SshHostSummary | undefined;
    /** Full stored entry (secrets included) — host-plane internal use only. */
    getEntry(alias: string): SshHostEntry | undefined;
    /** Create or update a host. */
    upsertHost(payload: Parameters<HostStore['upsert']>[0], existingAlias?: string): SshHostEntry;
    removeHost(alias: string): boolean;
    importSshConfig(): import("./protocol").ImportResult;
    /** Test a host without keeping a pooled connection. */
    test(alias: string): Promise<TestResult>;
    /**
     * Test an ad-hoc host config (settings-card "test connection" endpoint).
     * Builds an entry from the config and runs the same probe as test().
     */
    testConfig(config: {
        host: string;
        port?: number;
        user: string;
        auth: {
            kind: SshAuthKind;
            keyPath?: string;
            passphrase?: string;
            password?: string;
        };
        proxyJump?: string[];
    }): Promise<TestResult>;
    /** Shared probe: connect (optionally through the jump chain) and exec echo. */
    private testEntry;
    /**
     * Open (or reuse) the pooled connection for a host. Concurrent callers
     * while a connect attempt is in flight await that same attempt — they must
     * never observe a record whose client has not been assigned yet.
     */
    ensureConnection(alias: string): Promise<PoolRecord>;
    /** Build one pooled connection record (pool + in-flight registry updated). */
    private openPoolRecord;
    /** Open the jump chain for an entry (returns hop sockets in order). */
    private connectHops;
    /** Whether the pooled connection for a host is marked broken (rebuild decision). */
    isBroken(alias: string): boolean;
    /** Resolve (or reuse) the remote $HOME of a connection. */
    resolveHome(alias: string): Promise<string | undefined>;
    /** The current IDE workspace status. */
    status(): WorkspaceStatus;
    /** Cached remote $HOME of a host, if it has been resolved (sync read). */
    homeOf(alias: string): string | undefined;
    /** Bind the IDE workspace to a host (connects on demand). */
    connect(alias: string): Promise<WorkspaceStatus>;
    /** Unbind the IDE workspace. */
    disconnect(): WorkspaceStatus;
    /**
     * Open a local port forward through the pooled connection.
     * Binds 127.0.0.1 only; each accepted socket is tunnelled with
     * `client.forwardOut`. The tunnel holds one `inFlight` slot so the idle
     * sweep never closes the connection under a live forward.
     */
    openTunnel(alias: string, options: {
        remoteHost: string;
        remotePort: number;
        localPort?: number;
    }): Promise<RemoteTunnel>;
    /** All live local forwards. */
    listTunnels(): RemoteTunnel[];
    /** Close one forward; false when the id is unknown (already closed). */
    closeTunnel(id: string): boolean;
    /** Drop every forward bound to an alias (connection teardown path). */
    private closeTunnelsFor;
    /**
     * Open a streaming exec channel without collection, timeouts, or exit-code
     * normalization. Data flows as soon as the channel resolves; listeners
     * registered later still receive every event because pre-resolution events
     * are buffered until the first listener appears.
     */
    openChannel(alias: string, command: string, options?: {
        cwd?: string;
    }): Promise<SshExecChannel>;
    /** Run one command on a host with a timeout and output caps. */
    exec(alias: string, command: string, options?: {
        timeoutMs?: number;
        cwd?: string;
    }): Promise<ExecResult>;
    /** Open a PTY shell on the active connection (WebSocket terminal). */
    openShell(alias: string, cols: number, rows: number): Promise<ShellSession>;
    /** Get (and lazily open) the SFTP subsystem of a connection. */
    getSftp(alias: string): Promise<import('ssh2').SFTPWrapper>;
    /** List a remote directory. */
    ls(alias: string, path: string): Promise<RemoteDirEntry[]>;
    /** Read a remote file into text (capped at maxReadBytes). */
    readFile(alias: string, path: string): Promise<RemoteFileContent>;
    /** Write text to a remote file (missing parent directories are created). */
    writeFile(alias: string, path: string, content: string): Promise<{
        size: number;
        mtimeMs: number;
    }>;
    /** Create the missing parent directories of a remote path (bottom-up scan). */
    private mkdirParents;
    /** Create a remote directory (recursively via mkdir -p fallback). */
    mkdir(alias: string, path: string): Promise<void>;
    /** Remove a remote file or empty directory. */
    remove(alias: string, path: string): Promise<void>;
    /** Rename or move a remote path. */
    rename(alias: string, from: string, to: string): Promise<void>;
    /** Close idle connections (keeps the active one and pinned ones). */
    private sweep;
    /** Tear down one pooled connection. */
    private dropConnection;
    /** Close every connection and stop the sweeper. */
    dispose(): void;
}
/** POSIX single-quote escaping for remote shell interpolation. */
export declare function quoteSh(value: string): string;
export {};
