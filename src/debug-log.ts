/**
 * dsh-remote-ide — 文件级诊断日志。
 *
 * scope.logger 不落盘（web 进程的 stdout 也几乎为空），关键链路（会话路由、
 * settings 迁移等）必须自己留痕才能在真机上定位。512KiB 自动重置。
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LIMIT = 512 * 1024
let bytes = -1

function file(): string {
  return join(homedir(), '.dsh', 'dsh-remote-ide-debug.log')
}

export function debugLog(message: string): void {
  try {
    const line = `${new Date().toISOString()} ${message}\n`
    if (bytes < 0) {
      try { bytes = statSync(file()).size } catch { bytes = 0 }
    }
    if (bytes > LIMIT) {
      writeFileSync(file(), line, 'utf8')
      bytes = Buffer.byteLength(line)
      return
    }
    appendFileSync(file(), line, 'utf8')
    bytes += Buffer.byteLength(line)
  } catch {
    // 诊断日志绝不影响主流程。
  }
}
