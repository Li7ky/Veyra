import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, X, ArrowDownAZ, Filter } from "lucide-react";
import type { ConnectionItem } from "./vite-env";
import { t } from "./i18n";

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

type SortKey = "upload" | "download" | "host" | "chain";

function ConnectionsPage({
  onToast,
  active,
}: {
  onToast: (m: string) => void;
  active: boolean;
}) {
  const [items, setItems] = useState<ConnectionItem[]>([]);
  const [totals, setTotals] = useState({ up: 0, down: 0 });
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("download");
  const [busy, setBusy] = useState(false);

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
      onToast(String((e as Error).message || e));
    }
  }, [onToast]);

  useEffect(() => {
    // 仅在页面可见时轮询：App 用 hidden 保活不卸载本组件，
    // 不门控的话即使从未打开过连接页也会每 2s 打一次 IPC 并 setState。
    if (!active) return;
    reload();
    const t = window.setInterval(reload, 2000);
    return () => window.clearInterval(t);
  }, [reload, active]);

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
          {filtered.length}/{items.length} · ↑{formatBytes(totals.up)} ↓{formatBytes(totals.down)}
        </span>
        <div className="s-actions" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> {t("conn.refresh")}
          </button>
          <button
            type="button"
            className="btn danger btn-sm"
            disabled={busy || !items.length}
            onClick={async () => {
              setBusy(true);
              try {
                await window.veyra?.closeAllConnections();
                onToast(t("conn.closeAllDone"));
                await reload();
              } catch (e) {
                onToast(String((e as Error).message || e));
              } finally {
                setBusy(false);
              }
            }}
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
        <ArrowDownAZ size={14} />
      </div>

      {!filtered.length ? (
        <div className="empty center">{t("conn.empty")}</div>
      ) : (
        <div className="conn-table-wrap">
          <table className="conn-table">
            <thead>
              <tr>
                <th>{t("conn.colHost")}</th>
                <th>{t("conn.colProcess")}</th>
                <th>{t("conn.colChain")}</th>
                <th>{t("conn.colRule")}</th>
                <th>{t("conn.colUp")}</th>
                <th>{t("conn.colDown")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td title={c.metadata?.destinationIP}>
                    {c.metadata?.host || c.metadata?.destinationIP || "—"}
                    <span className="s-muted">:{c.metadata?.destinationPort || ""}</span>
                  </td>
                  <td>{c.metadata?.process || "—"}</td>
                  <td className="s-mono">{(c.chains || []).slice().reverse().join(" → ") || "—"}</td>
                  <td>{c.rule || "—"}</td>
                  <td>{formatBytes(c.upload)}</td>
                  <td>{formatBytes(c.download)}</td>
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
                          onToast(String((e as Error).message || e));
                        }
                      }}
                    >
                      <X size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default memo(ConnectionsPage);
