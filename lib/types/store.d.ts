/**
 * Host config store: persists SSH host entries to ~/.dsh/dsh-remote-ide.json
 * (0600), with import from ~/.ssh/config. The browser and agent only ever see
 * the secret-free summary projection.
 */
import type { HostPayload, ImportResult, SshHostEntry, SshHostSummary } from './protocol';
/** Expand a leading ~ to the user home directory. */
export declare function expandHome(path: string): string;
/**
 * 主机别名的安全白名单：作为对象键与目录段使用——拒绝原型污染键
 * （__proto__ / constructor / prototype）与其余危险拼写。
 */
export declare function isSafeHostId(id: string): boolean;
/** Store file location (overridable for tests). */
export declare function defaultStorePath(): string;
/** Parse an OpenSSH config file into raw host blocks (best-effort). */
export interface RawSshHostBlock {
    name: string;
    hostName?: string;
    port?: number;
    user?: string;
    identityFile?: string;
}
export declare function parseSshConfig(text: string): RawSshHostBlock[];
/** The host store. */
export declare class HostStore {
    private readonly file;
    private readonly entries;
    /**
     * @param file - store file path (defaults to ~/.dsh/dsh-remote-ide.json).
     */
    constructor(file?: string);
    private load;
    private save;
    /**
     * Windows 收紧凭据文件的 ACL（best-effort）：chmod 在 Windows 是 no-op，
     * 新文件继承目录 ACL——本机 `.dsh` 的继承链含沙箱用户组的读取权，明文口令
     * 因此可被沙箱进程读到。断继承并仅授予管理员/SYSTEM/当前用户；非 Windows
     * 或 icacls 不可用时静默跳过（下一次 save 会重试）。
     */
    private tightenWindowsAcl;
    /** All entries, sorted by alias. */
    list(): SshHostEntry[];
    /** Secret-free projection. */
    summarize(entry: SshHostEntry): SshHostSummary;
    get(alias: string): SshHostEntry | undefined;
    /**
     * 记录首次信任的服务器主机密钥指纹（TOFU）。
     * 未知别名（如测试连接的 ad-hoc 探测）不落盘；指纹未变时不重写文件。
     */
    trustHostKey(alias: string, fingerprint: string): void;
    /** Create or update an entry (by the payload alias or entry.alias). */
    upsert(payload: HostPayload, existingAlias?: string): SshHostEntry;
    remove(alias: string): boolean;
    /** Import hosts from ~/.ssh/config. Returns counts per outcome. */
    importSshConfig(): ImportResult;
    /** Resolve a private-key path (expand ~) against the store dir for imports. */
    resolveKeyPath(keyPath: string): string;
}
