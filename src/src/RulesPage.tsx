import { memo, useEffect, useRef, useState } from "react";
import { Plus, Save, Trash2, RefreshCw } from "lucide-react";
import { t } from "./i18n";

type RuleRow = { payload: string; type?: string; isBuiltin?: boolean };

/**
 * 规则归一化纯函数：任何上游形状都收敛为 { payload, type }，绝不产出 "[object Object]"。
 * - 字符串 → { payload: trim, type: "Rule" }；空/纯空白 → null
 * - 对象 → 依次取 payload/rule/raw/value 字段当 payload，仅接受 string；缺 type 或空白 → "Rule"
 * - 其它（number/boolean/数组/null）→ null
 */
export function normalizeRule(input: unknown): { payload: string; type: string } | null {
  if (input == null) return null;
  let payload: unknown;
  let type: unknown;
  if (typeof input === "string") {
    payload = input;
  } else if (typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    payload = obj.payload ?? obj.rule ?? obj.raw ?? obj.value;
    type = obj.type;
  } else {
    return null;
  }
  if (typeof payload !== "string") return null;
  const trimmed = payload.trim();
  if (!trimmed) return null;
  const t = typeof type === "string" ? type.trim() : "";
  return { payload: trimmed, type: t || "Rule" };
}

// 虚拟滚动参数：列表容器仅 280px 高，只渲染可视区 + 上下缓冲
const ROW_FALLBACK = 56;
const ROW_GAP = 4;
const OVERSCAN = 8;

// 内置主流规则（默认加载）
const BUILTIN_RULES: string[] = [
  // 内网直连
  "IP-CIDR,192.168.0.0/16,DIRECT",
  "IP-CIDR,10.0.0.0/8,DIRECT",
  "IP-CIDR,172.16.0.0/12,DIRECT",
  "IP-CIDR,127.0.0.0/8,DIRECT",
  "DOMAIN-SUFFIX,local,DIRECT",
  // 常用代理
  "DOMAIN-SUFFIX,google.com,PROXY",
  "DOMAIN-SUFFIX,youtube.com,PROXY",
  "DOMAIN-SUFFIX,github.com,PROXY",
  "DOMAIN-SUFFIX,x.com,PROXY",
  "DOMAIN-SUFFIX,twitter.com,PROXY",
  "DOMAIN-SUFFIX,facebook.com,PROXY",
  "DOMAIN-SUFFIX,instagram.com,PROXY",
  "DOMAIN-SUFFIX,telegram.org,PROXY",
  "DOMAIN-SUFFIX,openai.com,PROXY",
  "DOMAIN-SUFFIX,claude.ai,PROXY",
  // 广告拦截
  "DOMAIN-SUFFIX,doubleclick.net,REJECT",
  "DOMAIN-SUFFIX,googlesyndication.com,REJECT",
  "DOMAIN-SUFFIX,google-analytics.com,REJECT",
  "DOMAIN-SUFFIX,adservice.google.com,REJECT",
  // 国内直连
  "DOMAIN-SUFFIX,baidu.com,DIRECT",
  "DOMAIN-SUFFIX,qq.com,DIRECT",
  "DOMAIN-SUFFIX,taobao.com,DIRECT",
  "DOMAIN-SUFFIX,jd.com,DIRECT",
  "DOMAIN-SUFFIX,163.com,DIRECT",
  "DOMAIN-SUFFIX,bilibili.com,DIRECT",
];

function RulesPage({ onToast, onBusy }: { onToast: (m: string) => void; onBusy: (v: boolean) => void }) {
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [draft, setDraft] = useState("");
  // 虚拟滚动状态：只渲染可视区，避免上千行规则撑爆 DOM
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [rowH, setRowH] = useState(ROW_FALLBACK);
  const [viewH, setViewH] = useState(280);

  async function reload() {
    if (!window.veyra?.listRules) {
      // 预览版：直接用内置规则
      setRows(BUILTIN_RULES.map((payload) => ({ payload, isBuiltin: true })));
      return;
    }
    const data = await window.veyra.listRules();
    const list = (data.rules || [])
      .map((r) => normalizeRule(r))
      .filter((r): r is NonNullable<ReturnType<typeof normalizeRule>> => r !== null);
    // 无自定义规则时仅用内置规则做预览：标记 isBuiltin，
    // 保存时跳过（避免把演示规则静默持久化进用户配置）
    setRows(list.length ? list : BUILTIN_RULES.map((payload) => ({ payload, isBuiltin: true })));
  }

  useEffect(() => {
    reload().catch(() => {});
  }, []);

  // 实测行高与视口高度，CSS 调整后虚拟滚动仍能对齐
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setViewH(el.clientHeight || 280);
    const first = el.querySelector<HTMLElement>(".pf-item");
    if (first) {
      const h = first.getBoundingClientRect().height;
      if (h > 0) setRowH(h + ROW_GAP);
    }
  }, [rows.length]);

  const total = rows.length;
  const visibleCount = Math.max(1, Math.ceil(viewH / rowH));
  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const end = Math.min(total, start + visibleCount + OVERSCAN * 2);
  const visibleRows = rows.slice(start, end);
  const padTop = start * rowH;
  const padBottom = Math.max(0, (total - end) * rowH);

  return (
    <div className="pane rules-page">
      <div className="block-hd" style={{ marginBottom: 12 }}>
        <h2>{t("rule.title")}</h2>
        <span className="pill dim">{rows.length} 条</span>
        <div className="s-actions" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn ghost btn-sm" onClick={() => reload().catch(() => {})}>
            <RefreshCw size={13} /> {t("rule.refresh")}
          </button>
          <button
            type="button"
            className="btn primary btn-sm"
            onClick={async () => {
              const userRows = rows.filter((r) => !r.isBuiltin);
              if (!userRows.length) {
                onToast(t("rule.nothingToSave", "暂无自定义规则可保存"));
                return;
              }
              onBusy(true);
              try {
                await window.veyra?.saveVisualRules?.(userRows.map((r) => r.payload));
                onToast(t("rule.saved"));
                await reload();
              } catch (e) {
                onToast(String((e as Error).message || e));
              } finally {
                onBusy(false);
              }
            }}
          >
            <Save size={13} /> {t("rule.saveApply")}
          </button>
        </div>
      </div>

      <p className="s-muted" style={{ marginBottom: 12 }}>
        {t("rule.desc")}
      </p>

      <div className="import-bar" style={{ marginBottom: 12 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("rule.placeholder")} />
        <button
          type="button"
          className="btn primary btn-sm"
          onClick={() => {
            const tr = draft.trim();
            if (!tr) return;
            setRows((prev) => [{ payload: tr }, ...prev]);
            setDraft("");
          }}
        >
          <Plus size={13} /> {t("rule.add")}
        </button>
      </div>

      <div className="import-bar" style={{ marginBottom: 12, background: "var(--hover)", padding: 10, borderRadius: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{t("rule.processLabel")}</span>
        <input
          id="proc-name-input"
          placeholder={t("rule.processPlaceholder")}
          style={{ flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (document.getElementById("proc-add-btn") as HTMLButtonElement)?.click();
          }}
        />
        <select id="proc-policy-select" className="s-input" style={{ width: 90 }}>
          <option value="PROXY">{t("rule.processProxy")}</option>
          <option value="DIRECT">{t("rule.processDirect")}</option>
        </select>
        <button
          id="proc-add-btn"
          type="button"
          className="btn ghost btn-sm"
          onClick={() => {
            const nameInput = document.getElementById("proc-name-input") as HTMLInputElement;
            const policySelect = document.getElementById("proc-policy-select") as HTMLSelectElement;
            const name = nameInput?.value.trim();
            if (!name) {
              onToast(t("rule.processNameRequired"));
              return;
            }
            const rule = `PROCESS-NAME,${name},${policySelect?.value || "PROXY"}`;
            setRows((prev) => {
              if (prev.some((r) => r.payload === rule)) {
                onToast(t("rule.alreadyExists"));
                return prev;
              }
              return [{ payload: rule }, ...prev];
            });
            nameInput.value = "";
            onToast(t("rule.ruleAdded").replace("{rule}", rule));
          }}
        >
          <Plus size={13} /> {t("rule.addAppRule")}
        </button>
      </div>

      {!rows.length ? (
        <div className="empty">{t("rule.empty")}</div>
      ) : (
        <div
          className="pf-list"
          ref={listRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {padTop > 0 ? <div style={{ height: padTop, flexShrink: 0 }} aria-hidden /> : null}
          {visibleRows.map((r, k) => {
            const i = start + k;
            return (
              <div key={`${r.payload}-${i}`} className="pf-item">
                <div className="pf-item-body">
                  <div className="pf-item-name s-mono">{r.payload}</div>
                  <div className="pf-item-sub">{r.type || "Rule"}</div>
                </div>
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {padBottom > 0 ? <div style={{ height: padBottom, flexShrink: 0 }} aria-hidden /> : null}
        </div>
      )}
    </div>
  );
}

export default memo(RulesPage);
