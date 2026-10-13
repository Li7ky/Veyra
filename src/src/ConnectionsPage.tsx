import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, X, ArrowDownAZ, Filter } from "lucide-react";
import type { ConnectionItem } from "./vite-env";

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

type SortKey = "upload" | "download" | "host" | "chain";

function ConnectionsPage({
  onToast,
}: {
  onToast: (m: string) => void;
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
    reload();
    const t = window.setInterval(reload, 2000);
    return () => window.clearInterval(t);
  }, [reload]);

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
        <h2>连接</h2>
        <span className="pill dim">
          {filtered.length}/{items.length} · ↑{formatBytes(totals.up)} ↓{formatBytes(totals.down)}
        </span>
        <div className="s-actions" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button
            type="button"
            className="btn danger btn-sm"
            disabled={busy || !items.length}
            onClick={async () => {
              setBusy(true);
              try {
                await window.veyra?.closeAllConnections();
                onToast("已断开全部连接");
                await reload();
              } finally {
                setBusy(false);
              }
            }}
          >
            全部断开
          </button>
        </div>
      </div>

      <div className="import-bar" style={{ marginBottom: 12 }}>
        <Filter size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选主机 / 进程 / 链路…" />
        <select className="s-input" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="download">按下载</option>
          <option value="upload">按上传</option>
          <option value="host">按主机</option>
          <option value="chain">按链路</option>
        </select>
        <ArrowDownAZ size={14} />
      </div>

      {!filtered.length ? (
        <div className="empty">暂无连接</div>
      ) : (
        <div className="conn-table-wrap">
          <table className="conn-table">
            <thead>
              <tr>
                <th>主机</th>
                <th>进程</th>
                <th>链路</th>
                <th>规则</th>
                <th>↑</th>
                <th>↓</th>
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
                      title="断开"
                      onClick={async () => {
                        await window.veyra?.closeConnection?.(c.id);
                        await reload();
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
