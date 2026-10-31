/**
 * 一次性迁移：DSH 0.2 删除了 settings 命名空间，旧版把主机元数据写在
 * settings.yaml 的 `dsh-remote-ide-hosts:` 段。首次启动若 0600 store 为空，
 * 把这批主机导入 store（口令一并导入——旧版本 0.1.x 已把口令剥离到 store，
 * 这里只兜底极老的数据）。
 *
 * 约束：只读 settings.yaml，绝不改写用户文件；任何失败都返回 0 导入。
 */
export interface LegacyImportOptions {
    /** 0600 store 路径（默认 ~/.dsh/dsh-remote-ide.json）。 */
    storeFile: string;
    /** settings.yaml 路径（默认 $DSH_HOME/settings.yaml 或 ~/.dsh/settings.yaml）。 */
    settingsFile?: string;
}
export interface LegacyImportResult {
    imported: number;
    skipped: number;
}
export declare function importLegacyHosts(opts: LegacyImportOptions): Promise<LegacyImportResult>;
