import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import yaml from "js-yaml";

type ProxyDraft = {
  name: string;
  type: string;
  server: string;
  port: string;
  password: string;
  uuid: string;
  cipher: string;
};

type GroupDraft = {
  name: string;
  type: string;
  proxies: string;
};

const EMPTY_PROXY: ProxyDraft = {
  name: "",
  type: "ss",
  server: "",
  port: "443",
  password: "",
  uuid: "",
  cipher: "aes-128-gcm",
};

export function ProxiesVisualEditor({
  onToast,
  onBusy,
}: {
  onToast: (m: string) => void;
  onBusy: (v: boolean) => void;
}) {
  const [rows, setRows] = useState<ProxyDraft[]>([]);
  const [draft, setDraft] = useState<ProxyDraft>({ ...EMPTY_PROXY });

  useEffect(() => {
    (async () => {
      try {
        const text = (await window.veyra?.readRuntime?.()) || "";
        const cfg = (yaml.load(text) as { proxies?: Record<string, unknown>[] }) || {};
        const list = Array.isArray(cfg.proxies) ? cfg.proxies : [];
        setRows(
          list.slice(0, 200).map((p) => ({
            name: String(p.name || ""),
            type: String(p.type || "ss"),
            server: String(p.server || ""),
            port: String(p.port || ""),
            password: String(p.password || ""),
            uuid: String(p.uuid || ""),
            cipher: String(p.cipher || ""),
          }))
        );
      } catch {
        setRows([]);
      }
    })();
  }, []);

  async function save() {
    onBusy(true);
    try {
      const proxies = rows.map((r) => {
        const base: Record<string, unknown> = {
          name: r.name,
          type: r.type,
          server: r.server,
          port: Number(r.port) || 443,
          udp: true,
        };
        if (r.type === "ss") {
          base.cipher = r.cipher || "aes-128-gcm";
          base.password = r.password;
        } else if (r.type === "trojan" || r.type === "hysteria2") {
          base.password = r.password;
        } else if (r.type === "vmess" || r.type === "vless" || r.type === "tuic") {
          base.uuid = r.uuid || r.password;
          if (r.password) base.password = r.password;
        }
        return base;
      });
      const body = yaml.dump(
        { "prepend-proxies": proxies },
        { lineWidth: -1, noRefs: true }
      );
      // 复用已有的 visual-proxies 增强档案：每次都新建会在 enhance 时叠加应用，
      // 造成节点/分组在运行时配置里成倍膨胀。
      const list = (await window.veyra?.listProfilesRich?.()) || [];
      const existing = list.find((x) => x.type === "proxies" && x.name === "visual-proxies");
      const uid =
        existing?.uid || (await window.veyra?.createEnhanceProfile?.("proxies", "visual-proxies", true))?.uid;
      if (uid) {
        await window.veyra?.writeProfile?.(uid, body);
        await window.veyra?.enhanceApply?.();
      }
      onToast(`已保存 ${proxies.length} 个节点并增强`);
    } catch (e) {
      onToast(String((e as Error).message || e));
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="visual-ed">
      <div className="block-hd">
        <h2>节点可视化编辑</h2>
        <button type="button" className="btn primary btn-sm" onClick={save}>
          <Save size={13} /> 保存为 Proxies 增强
        </button>
      </div>
      <div className="s-fields" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {(
          [
            ["name", "名称"],
            ["type", "类型"],
            ["server", "服务器"],
            ["port", "端口"],
            ["password", "密码"],
            ["uuid", "UUID"],
            ["cipher", "加密"],
          ] as const
        ).map(([k, label]) => (
          <label key={k}>
            {label}
            {k === "type" ? (
              <select
                className="s-input"
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value })}
              >
                {["ss", "vmess", "vless", "trojan", "hysteria2", "tuic"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="s-input"
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
      <button
        type="button"
        className="btn ghost btn-sm"
        style={{ marginTop: 8 }}
        onClick={() => {
          if (!draft.name || !draft.server) return onToast("名称与服务器必填");
          setRows((prev) => [{ ...draft }, ...prev]);
          setDraft({ ...EMPTY_PROXY });
        }}
      >
        <Plus size={13} /> 添加节点
      </button>
      <div className="pf-list" style={{ marginTop: 12 }}>
        {rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="pf-item">
            <div className="pf-item-body">
              <div className="pf-item-name">
                {r.name} <span className="s-muted">({r.type})</span>
              </div>
              <div className="pf-item-sub">
                {r.server}:{r.port}
              </div>
            </div>
            <button type="button" className="btn ghost btn-sm" onClick={() => setRows((p) => p.filter((_, j) => j !== i))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GroupsVisualEditor({
  onToast,
  onBusy,
}: {
  onToast: (m: string) => void;
  onBusy: (v: boolean) => void;
}) {
  const [rows, setRows] = useState<GroupDraft[]>([]);
  const [draft, setDraft] = useState<GroupDraft>({ name: "", type: "select", proxies: "DIRECT" });

  useEffect(() => {
    (async () => {
      try {
        const text = (await window.veyra?.readRuntime?.()) || "";
        const cfg = (yaml.load(text) as { "proxy-groups"?: Record<string, unknown>[] }) || {};
        const list = Array.isArray(cfg["proxy-groups"]) ? cfg["proxy-groups"] : [];
        setRows(
          list.slice(0, 80).map((g) => ({
            name: String(g.name || ""),
            type: String(g.type || "select"),
            proxies: Array.isArray(g.proxies) ? g.proxies.join(", ") : "",
          }))
        );
      } catch {
        setRows([]);
      }
    })();
  }, []);

  async function save() {
    onBusy(true);
    try {
      const groups = rows.map((r) => ({
        name: r.name,
        type: r.type,
        proxies: r.proxies
          .split(/[,，\n]/)
          .map((x) => x.trim())
          .filter(Boolean),
      }));
      const body = yaml.dump({ "prepend-proxy-groups": groups }, { lineWidth: -1, noRefs: true });
      // 同 Proxies 编辑器：复用已有档案，避免重复创建导致增强叠加
      const list = (await window.veyra?.listProfilesRich?.()) || [];
      const existing = list.find((x) => x.type === "groups" && x.name === "visual-groups");
      const uid =
        existing?.uid || (await window.veyra?.createEnhanceProfile?.("groups", "visual-groups", true))?.uid;
      if (uid) {
        await window.veyra?.writeProfile?.(uid, body);
        await window.veyra?.enhanceApply?.();
      }
      onToast(`已保存 ${groups.length} 个策略组`);
    } catch (e) {
      onToast(String((e as Error).message || e));
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="visual-ed">
      <div className="block-hd">
        <h2>策略组可视化编辑</h2>
        <button type="button" className="btn primary btn-sm" onClick={save}>
          <Save size={13} /> 保存为 Groups 增强
        </button>
      </div>
      <div className="s-fields" style={{ gridTemplateColumns: "1fr 1fr 2fr" }}>
        <label>
          名称
          <input className="s-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label>
          类型
          <select className="s-input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
            {["select", "url-test", "fallback", "load-balance", "relay"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          节点（逗号分隔）
          <input
            className="s-input"
            value={draft.proxies}
            onChange={(e) => setDraft({ ...draft, proxies: e.target.value })}
          />
        </label>
      </div>
      <button
        type="button"
        className="btn ghost btn-sm"
        style={{ marginTop: 8 }}
        onClick={() => {
          if (!draft.name) return onToast("名称必填");
          setRows((p) => [{ ...draft }, ...p]);
          setDraft({ name: "", type: "select", proxies: "DIRECT" });
        }}
      >
        <Plus size={13} /> 添加策略组
      </button>
      <div className="pf-list" style={{ marginTop: 12 }}>
        {rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="pf-item">
            <div className="pf-item-body">
              <div className="pf-item-name">
                {r.name} <span className="s-muted">({r.type})</span>
              </div>
              <div className="pf-item-sub">{r.proxies}</div>
            </div>
            <button type="button" className="btn ghost btn-sm" onClick={() => setRows((p) => p.filter((_, j) => j !== i))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
