import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, X, Filter, ListFilter, Network } from "lucide-react";
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
  const busyRef = useRef(false);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!window.veyra?.listConnections) return;
      // 轮询、手动刷新、删除后的补偿刷新可能同时在飞：只放行最新一轮
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const data = await window.veyra.listConnections();
        setItems(data.connections || []);
        setTotals({
          up: data.uploadTotal || 0,
          down: data.downloadTotal || 0,
        });
      } catch (e) {
        // 后台轮询失败静默：内核刚挂、running 还没翻转的那几秒，
        // 每 2 秒弹一次 ECONNREFUSED 会把整个界面盖住
        if (!opts?.silent) onToast(connErrorText(e));
      } finally {
        busyRef.current = false;
      }
    },
    [onToast]
  );

  useEffect(() => {
    // 仅在「页面可见 + 内核在跑」时轮询
    if (!active || !running) return;
    void reload({ silent: true });
    const timer = window.setInterval(() => void reload({ silent: true }), 2000);
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
      <header className="cn-head">
        <div className="cn-head-l">
          <h1>{t("conn.title")}</h1>
          <span className="pill dim">
            {filtered.length}
            <i className="cn-pill-sep">/</i>
            {items.length}
          </span>
          <span className="cn-head-meta">
            <em className="down">↓ {formatBytes(totals.down)}</em>
            <em className="up">↑ {formatBytes(totals.up)}</em>
          </span>
        </div>
        <div className="cn-head-r">
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
      </header>

      <div className="cn-toolbar">
        <label className="cn-filter">
          <Filter size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("conn.filter")} />
        </label>
        <div className="cn-toolbar-r">
          <span className="cn-sort-k">
            <ListFilter size={12} />
            {t("conn.sortBy", "排序")}
          </span>
          <select
            className="s-input cn-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="download">{t("conn.sortDownload")}</option>
            <option value="upload">{t("conn.sortUpload")}</option>
            <option value="host">{t("conn.sortHost")}</option>
            <option value="chain">{t("conn.sortChain")}</option>
          </select>
        </div>
      </div>

      {!filtered.length ? (
        <div className="empty-state cn-empty">
          <div className="es-icon">
            <Network size={19} />
          </div>
          <h3>{running ? t("conn.emptyTitle", "当前没有活动连接") : t("conn.coreOfflineTitle", "内核未运行")}</h3>
          <p>
            {running
              ? t("conn.emptyDesc", "代理生效后，经过本机的网络请求会实时显示在这里。")
              : t("conn.coreOfflineHint", "启动代理服务后即可查看实时连接。")}
          </p>
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
                <th className="cn-col-act" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const payload = c.rulePayload || "";
                const chain = (c.chains || []).slice().reverse().map(stripFlagEmoji);
                return (
                  <tr key={c.id}>
                    <td className="cn-host" title={c.metadata?.destinationIP}>
                      <span className="cn-host-name">
                        {c.metadata?.host || c.metadata?.destinationIP || "—"}
                      </span>
                      {c.metadata?.destinationPort ? (
                        <span className="cn-host-port">:{c.metadata?.destinationPort}</span>
                      ) : null}
                    </td>
                    <td className="cn-proc">{c.metadata?.process || "—"}</td>
                    <td>
                      <span className="cn-chain">
                        {chain.length
                          ? chain.map((step, i) => (
                              <span key={`${step}-${i}`} className="cn-chain-step">
                                {i > 0 ? <i className="cn-arrow" aria-hidden="true" /> : null}
                                <span className={i === chain.length - 1 ? "is-node" : ""}>{step}</span>
                              </span>
                            ))
                          : "—"}
                      </span>
                    </td>
                    <td className="cn-rule" title={`${c.rule || ""}${payload ? `, ${payload}` : ""}`}>
                      <span className="cn-rule-payload">{payload || c.rule || "—"}</span>
                    </td>
                    <td className="num cn-num">{formatBytes(c.upload)}</td>
                    <td className="num cn-num">{formatBytes(c.download)}</td>
                    <td className="cn-col-act">
                      <button
                        type="button"
                        className="cn-kill"
                        title={t("conn.disconnect")}
                        aria-label={t("conn.disconnect")}
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
