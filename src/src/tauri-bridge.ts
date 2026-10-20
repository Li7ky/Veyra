/**
 * Tauri 桥接层：把现有 `window.veyra.*` 调用映射到 Rust 侧。
 *
 * React 侧只认 `window.veyra`；Tauri 版由这里注入同形状的对象，
 * 后端按方法名实现命令，事件订阅保持 onXxx(cb) → 取消订阅函数。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const EVENTS: Record<string, string> = {
  onCoreStatus: "core:status",
  onCoreLog: "core:log",
  onCoreError: "core:error",
  onCoreProgress: "core:progress",
  onSystemProxyChanged: "system:proxyChanged",
  onConflictDetected: "conflict:detected",
  onConflictResolved: "conflict:resolved",
  onConflictBlockStartup: "conflict:blockStartup",
  onNotice: "veyra:notice",
  onUpdateAvailable: "app:updateAvailable",
  onUpdateProgress: "app:updateProgress",
  onLightweight: "app:lightweight",
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function installTauriBridge(): void {
  if (!isTauri()) return;

  const api = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;

        if (prop.startsWith("on")) {
          const event = EVENTS[prop];
          if (!event) return () => () => {};
          return (cb: (payload: unknown) => void) => {
            let unlisten: (() => void) | null = null;
            let closed = false;
            void listen(event, (e) => cb(e.payload)).then((fn) => {
              if (closed) fn();
              else unlisten = fn;
            });
            return () => {
              closed = true;
              unlisten?.();
            };
          };
        }

        // 方法名直接作为 Rust 侧 dispatch 的 method；参数按数组原样传递，
        // 避免为 96 个 API 逐个写签名。
        return (...args: unknown[]) => invoke("veyra_call", { method: prop, args });
      },
    }
  );

  (window as unknown as { veyra: unknown }).veyra = api;
}
