import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, X, Filter } from "lucide-react";
import type { ConnectionItem } from "./vite-env";
import { t } from "./i18n";
import { ipcErrorText } from "./errors";
import { stripFlagEmoji } from "./nodeName";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

type SortKey = "upload" | "download" | "host" | "chain";

/** 内核未启动时主进程会回 ECONNREFUSED；直接抛给用户既长又像崩溃 */
function connErrorText(e: unknown) {
  const raw = String((e as Error)?.message || e || "");
  if (/ECONNREFUSED|connect\s+ECONNREFUSED/i.test(raw)) {
    return t("conn.coreOffline", "内核未运行，启动代理服务后可查看连接");
  }
  return ipcErrorText(e);
}

function ConnectionsPage({
  onToast,
  active,
  running,
}: {
  onToast: (m: string) => void;
  active: boolean;
  running: boolean;
}) {
  const [items, setItems] = useState<ConnectionItem[]>([]);
  const [totals, setTotals] = useState({ up: 0, down: 0 });
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("download");
  const [busy, setBusy] = useState(false);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);

  const reload = useCallback(async () => {
    if (!window.veyra?.listConnections) return;
    try {
      const data = await window.veyra.listConnections();
      setItems(data.connections || []);
      setTotals({
        up: data.uploadTotal || 0,
        down: data.downloadTotal || 0,
      });
    } catch (e) {
      onToast(connErrorText(e));
    }
  }, [onToast]);

  useEffect(() => {
    // 仅在「页面可见 + 内核在跑」时轮询：否则每 2s 一次 ECONNREFUSED 会让 toast 反复弹出
    if (!active || !running) return;
    reload();
    const timer = window.setInterval(reload, 2000);
    return () => window.clearInterval(timer);
  }, [reload, active, running]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = items.slice();
    if (needle) {
      list = list.filter((c) => {
        const host = `${c.metadata?.host || ""} ${c.metadata?.destinationIP || ""} ${c.metadata?.process || ""} ${
          c.chains?.join(" ") || ""
        }`.toLowerCase();
        return host.includes(needle);
      });
    }
    list.sort((a, b) => {
      if (sort === "upload") return (b.upload || 0) - (a.upload || 0);
      if (sort === "download") return (b.download || 0) - (a.download || 0);
      if (sort === "host") {
        return String(a.metadata?.host || "").localeCompare(String(b.metadata?.host || ""));
      }
      return String(a.chains?.[0] || "").localeCompare(String(b.chains?.[0] || ""));
    });
    return list;
  }, [items, q, sort]);

  return (
    <div className="pane conn-page">
      <div className="block-hd" style={{ marginBottom: 12 }}>
        <h2>{t("conn.title")}</h2>
        <span className="pill dim">
          {filtered.length}/{items.length} · ↑ {formatBytes(totals.up)} · ↓ {formatBytes(totals.down)}
        </span>
        <div className="s-actions" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> {t("conn.refresh")}
          </button>
          <button
            type="button"
            className="btn danger btn-sm"
            disabled={busy || !items.length}
            onClick={() =>
              setConfirmReq({
                title: t("conn.closeAll", "全部断开"),
                message: t(
                  "conn.closeAllConfirm",
                  "将断开当前所有 {n} 条连接（下载、网页、更新会被中断），确定继续？"
                ).replace("{n}", String(items.length)),
                confirmText: t("conn.closeAll", "全部断开"),
                danger: true,
                onConfirm: async () => {
                  setBusy(true);
                  try {
                    await window.veyra?.closeAllConnections();
                    onToast(t("conn.closeAllDone"));
                    await reload();
                  } catch (e) {
                    onToast(connErrorText(e));
                  } finally {
                    setBusy(false);
                  }
                },
              })
            }
          >
            {t("conn.closeAll")}
          </button>
        </div>
      </div>

      <div className="import-bar" style={{ marginBottom: 12 }}>
        <Filter size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("conn.filter")} />
        <select className="s-input" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="download">{t("conn.sortDownload")}</option>
          <option value="upload">{t("conn.sortUpload")}</option>
          <option value="host">{t("conn.sortHost")}</option>
          <option value="chain">{t("conn.sortChain")}</option>
        </select>
      </div>

      {!filtered.length ? (
        <div className="empty center">
          {running ? t("conn.empty") : t("conn.coreOffline", "内核未运行，启动代理服务后可查看连接")}
        </div>
      ) : (
        <div className="conn-table-wrap">
          <table className="conn-table">
            <thead>
              <tr>
                <th>{t("conn.colHost")}</th>
                <th>{t("conn.colProcess")}</th>
                <th>{t("conn.colChain")}</th>
                <th>{t("conn.colRule")}</th>
                <th className="num">{t("conn.colUp")}</th>
                <th className="num">{t("conn.colDown")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const payload = c.rulePayload || "";
                return (
                  <tr key={c.id}>
                    <td title={c.metadata?.destinationIP}>
                      {c.metadata?.host || c.metadata?.destinationIP || "—"}
                      <span className="s-muted"> :{c.metadata?.destinationPort || ""}</span>
                    </td>
                    <td>{c.metadata?.process || "—"}</td>
                    <td className="s-mono">
                      {(c.chains || []).slice().reverse().map(stripFlagEmoji).join(" → ") || "—"}
                    </td>
                    <td className="conn-rule" title={`${c.rule || ""}${payload ? `, ${payload}` : ""}`}>
                      {payload || c.rule || "—"}
                    </td>
                    <td className="num">{formatBytes(c.upload)}</td>
                    <td className="num">{formatBytes(c.download)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn ghost btn-sm"
                        title={t("conn.disconnect")}
                        onClick={async () => {
                          try {
                            await window.veyra?.closeConnection?.(c.id);
                            await reload();
                          } catch (e) {
                            onToast(connErrorText(e));
                          }
                        }}
                      >
                        <X size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
    </div>
  );
}

export default memo(ConnectionsPage);
