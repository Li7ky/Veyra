/**
 * 把后端 IPC 抛出的错误还原成人类可读的一句话。
 *
 * 命令 reject 的错误经 IPC 会被包一层：
 *   Error invoking remote method 'app:downloadUpdate': Error: 请求超时
 * 直接展示给用户既长又像崩溃日志，这里只保留真正的原因。
 */
export function ipcErrorText(e: unknown): string {
  const raw = String((e as Error)?.message || e || "");
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}
