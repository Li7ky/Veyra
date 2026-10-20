import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Save, Trash2, RefreshCw, Search, Info, ArrowRight } from "lucide-react";
import { t } from "./i18n";

type RuleRow = {
  payload: string;
  type?: string;
  isBuiltin?: boolean;
  /** 内核 / 订阅里带的策略名（PROXY / DIRECT / 自定义策略组） */
  policy?: string;
};

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

/** 对象形状里额外的策略字段（不改变 normalizeRule 的契约，测试依赖它的输出形状） */
function rulePolicyOf(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const p = (input as Record<string, unknown>).proxy;
    if (typeof p === "string" && p.trim()) return p.trim();
  }
  return "";
}

/** 解析 "DOMAIN-SUFFIX,x.com,PROXY" 这类字符串形式的规则，用于展示 */
export function splitRuleText(payload: string): { type: string; value: string; policy: string } | null {
  const parts = payload.split(",").map((s) => s.trim());
  if (parts.length >= 2 && /^[A-Z][A-Z0-9-]*$/.test(parts[0])) {
    return { type: parts[0], value: parts[1], policy: parts[2] || "" };
  }
  return null;
}

function policyTone(policy: string): "direct" | "reject" | "proxy" | "none" {
  const p = policy.toUpperCase();
  if (!p) return "none";
  if (p === "DIRECT" || p === "直连") return "direct";
  if (p === "REJECT" || p === "REJECT-DROP" || p === "拦截") return "reject";
  return "proxy";
}

// 虚拟滚动参数：只渲染可视区 + 上下缓冲
const ROW_FALLBACK = 42;
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
  const [procName, setProcName] = useState("");
  const [procPolicy, setProcPolicy] = useState<"PROXY" | "DIRECT">("PROXY");
  const [mode, setMode] = useState<"domain" | "process">("domain");
  const [filter, setFilter] = useState("");
  // 虚拟滚动状态：只渲染可视区，避免上千行规则撑爆 DOM
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [rowH, setRowH] = useState(ROW_FALLBACK);
  const [viewH, setViewH] = useState(320);

  async function reload() {
    if (!window.veyra?.listRules) {
      // 预览版：直接用内置规则
      setRows(BUILTIN_RULES.map((payload) => ({ payload, isBuiltin: true })));
      return;
    }
    const data = await window.veyra.listRules();
    const raw = (data.rules || []) as unknown[];
    const list = raw
      .map((r) => {
        const normalized = normalizeRule(r);
        if (!normalized) return null;
        const policy = rulePolicyOf(r);
        return policy ? { ...normalized, policy } : normalized;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    // 无自定义规则时仅用内置规则做预览：标记 isBuiltin，
    // 保存时跳过（避免把演示规则静默持久化进用户配置）
    setRows(list.length ? list : BUILTIN_RULES.map((payload) => ({ payload, isBuiltin: true })));
  }

  useEffect(() => {
    reload().catch(() => {});
  }, []);

  // 实测行高与视口高度，CSS 调整后虚拟滚动仍能对齐。
  // 用 ResizeObserver 跟着窗口/列表尺寸变化重测：只在 [rows.length, filter] 时量一次的话，
  // 改窗口大小后行高与视口高度都会过期，切片错位、底部留一大段空白。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      setViewH(el.clientHeight || 320);
      const first = el.querySelector<HTMLElement>(".rl-row");
      const h = first?.getBoundingClientRect().height;
      if (h && h > 0) setRowH(h + ROW_GAP);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length, filter]);

  // 筛选条件或规则条数变化后回到顶部：
  // 否则旧的 scrollTop 会让 start 越过 total，切片为空、padTop 却是几千像素，
  // 看起来就是「列表一片空白」，必须手动滚一下才恢复。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [filter, rows.length]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.payload} ${r.type || ""} ${r.policy || ""}`.toLowerCase().includes(needle));
  }, [rows, filter]);

  const total = shown.length;
  const visibleCount = Math.max(1, Math.ceil(viewH / rowH));
  // start 必须夹在「最后还能铺满一屏」的范围内，越界会产生空切片 + 巨量 padding
  const maxStart = Math.max(0, total - visibleCount - OVERSCAN);
  const start = Math.min(maxStart, Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN));
  const end = Math.min(total, start + visibleCount + OVERSCAN * 2);
  const visibleRows = shown.slice(start, end);
  const padTop = start * rowH;
  const padBottom = Math.max(0, (total - end) * rowH);

  const builtinOnly = rows.length > 0 && rows.every((r) => r.isBuiltin);

  function addRule(payload: string) {
    const tr = payload.trim();
    if (!tr) return;
    if (rows.some((r) => r.payload === tr)) {
      onToast(t("rule.alreadyExists", "这条规则已经存在"));
      return;
    }
    setRows((prev) => [{ payload: tr }, ...prev]);
    onToast(t("rule.ruleAdded", "已添加：{rule}").replace("{rule}", tr));
  }

  function detailOf(r: RuleRow): { type: string; value: string; policy: string } {
    const parsed = splitRuleText(r.payload);
    if (parsed) return { ...parsed, policy: r.policy || parsed.policy };
    return { type: (r.type || "Rule").toUpperCase(), value: r.payload, policy: r.policy || "" };
  }

  return (
    <div className="pane rules-page">
      <header className="rl-head">
        <div className="rl-head-l">
          <h1>{t("rule.title")}</h1>
          <span className="pill dim">{rows.length}</span>
          <span className="rl-head-meta">
            {t("rule.headMeta", "可视化编辑路由规则 · 保存在全局规则增强中")}
          </span>
        </div>
        <div className="rl-head-r">
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
                const r = await window.veyra?.saveVisualRules?.(userRows.map((r) => r.payload));
                // 内容与内核当前规则完全一致时不写增强项（避免把订阅规则固化成快照）
                onToast(r?.unchanged ? t("rule.unchanged", "规则没有变化") : t("rule.saved"));
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
      </header>

      {builtinOnly ? (
        <div className="rl-callout" role="status">
          <Info size={14} />
          <span>
            {t(
              "rule.builtinPreview",
              "当前配置没有规则，下面是内置示例（仅预览，不会生效）。添加自己的规则后才会写入配置。"
            )}
          </span>
        </div>
      ) : null}

      <div className="rl-toolbar">
        <div className="rl-mode seg" role="tablist" aria-label={t("rule.modeLabel", "规则类型")}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "domain"}
            className={mode === "domain" ? "active" : ""}
            onClick={() => setMode("domain")}
          >
            {t("rule.modeDomain", "域名 / IP")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "process"}
            className={mode === "process" ? "active" : ""}
            onClick={() => setMode("process")}
          >
            {t("rule.modeProcess", "应用进程")}
          </button>
        </div>

        {mode === "domain" ? (
          <>
            <input
              className="rl-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addRule(draft);
                  setDraft("");
                }
              }}
              placeholder={t("rule.placeholder")}
              aria-label={t("rule.placeholder")}
            />
            <button
              type="button"
              className="btn primary btn-sm"
              disabled={!draft.trim()}
              onClick={() => {
                addRule(draft);
                setDraft("");
              }}
            >
              <Plus size={13} /> {t("rule.add")}
            </button>
          </>
        ) : (
          <>
            <input
              className="rl-input"
              value={procName}
              onChange={(e) => setProcName(e.target.value)}
              placeholder={t("rule.processPlaceholder")}
              aria-label={t("rule.processPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") (document.getElementById("rl-proc-add") as HTMLButtonElement)?.click();
              }}
            />
            <select
              className="s-input rl-proc-policy"
              value={procPolicy}
              onChange={(e) => setProcPolicy(e.target.value as "PROXY" | "DIRECT")}
              aria-label={t("rule.processPolicy", "策略")}
            >
              <option value="PROXY">{t("rule.processProxy", "走代理")}</option>
              <option value="DIRECT">{t("rule.processDirect", "直连")}</option>
            </select>
            <button
              id="rl-proc-add"
              type="button"
              className="btn primary btn-sm"
              disabled={!procName.trim()}
              onClick={() => {
                const name = procName.trim();
                if (!name) return;
                addRule(`PROCESS-NAME,${name},${procPolicy}`);
                setProcName("");
              }}
            >
              <Plus size={13} /> {t("rule.addAppRule", "添加应用规则")}
            </button>
          </>
        )}

        <label className="rl-search">
          <Search size={13} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("rule.search", "筛选规则")}
          />
        </label>
      </div>

      {!shown.length ? (
        <div className="empty-state rl-empty">
          <div className="es-icon">
            <ArrowRight size={19} />
          </div>
          <h3>{rows.length ? t("rule.noMatch", "没有匹配的规则") : t("rule.emptyTitle", "还没有规则")}</h3>
          <p>
            {rows.length
              ? t("rule.noMatchDesc", "换个关键词试试，或清空筛选条件。")
              : t("rule.emptyDesc", "在上方输入框按 TYPE,payload,策略 格式添加，例如 DOMAIN-SUFFIX,google.com,PROXY。")}
          </p>
        </div>
      ) : (
        <div className="rl-list-head" aria-hidden="true">
          <span className="rl-c-type">{t("rule.colType", "类型")}</span>
          <span className="rl-c-value">{t("rule.colValue", "匹配内容")}</span>
          <span className="rl-c-policy">{t("rule.colPolicy", "策略")}</span>
          <span className="rl-c-act" />
        </div>
      )}

      {shown.length ? (
        <div
          className="rl-list"
          ref={listRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {padTop > 0 ? <div style={{ height: padTop, flexShrink: 0 }} aria-hidden /> : null}
          {visibleRows.map((r, k) => {
            const d = detailOf(r);
            const tone = policyTone(d.policy);
            return (
              <div key={`${r.payload}-${start + k}`} className="rl-row">
                <span className="rl-type">{d.type}</span>
                <span className="rl-value" title={r.payload}>
                  {d.value}
                  {r.isBuiltin ? (
                    <em className="rl-builtin">{t("rule.previewTag", "示例")}</em>
                  ) : null}
                </span>
                <span className={`rl-policy is-${tone}`}>{d.policy || "—"}</span>
                <button
                  type="button"
                  className="rl-del"
                  aria-label={t("rule.delete", "删除规则")}
                  title={t("rule.delete", "删除规则")}
                  // 按 payload 删除，不能按渲染下标 i：
                  // 这里渲染的是虚拟滚动切片（visibleRows），i = start + k 只是
                  // 视口内的相对位置。行集合一变（新增/删除/滚动后重算），
                  // 同一个 i 指向的就是另一行，表现为「点删除却删掉了别的规则」。
                  onClick={() => setRows((prev) => prev.filter((x) => x.payload !== r.payload))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {padBottom > 0 ? <div style={{ height: padBottom, flexShrink: 0 }} aria-hidden /> : null}
        </div>
      ) : null}
    </div>
  );
}

export default memo(RulesPage);
