/**
 * dsh-remote-ide — 文件级诊断日志。
 *
 * scope.logger 不落盘（web 进程的 stdout 也几乎为空），关键链路（会话路由、
 * settings 迁移等）必须自己留痕才能在真机上定位。512KiB 自动重置。
 */
export declare function debugLog(message: string): void;
