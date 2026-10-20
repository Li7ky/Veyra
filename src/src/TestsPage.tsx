import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, Clock, Loader2, RefreshCw, Square, XCircle } from "lucide-react";
import BrandLogo from "./BrandLogo";
import { brandDef } from "./brandLogos";
import { t } from "./i18n";

export type UnlockItem = {
  id: string;
  title: string;
  ok: boolean;
  fail?: boolean;
  region?: string | null;
  note: string;
  status?: number;
  testedAt?: number;
};

const IDLE: UnlockItem[] = [
  { id: "bilibili-cn", title: "哔哩哔哩大陆", ok: false, note: "" },
  { id: "bilibili-hk", title: "哔哩哔哩港澳台", ok: false, note: "" },
  { id: "bahamut", title: "Bahamut Anime", ok: false, note: "" },
  { id: "chatgpt", title: "ChatGPT Web", ok: false, note: "" },
  { id: "claude", title: "Claude", ok: false, note: "" },
  { id: "disney", title: "Disney+", ok: false, note: "" },
  { id: "gemini", title: "Gemini", ok: false, note: "" },
  { id: "netflix", title: "Netflix", ok: false, note: "" },
  { id: "prime", title: "Prime Video", ok: false, note: "" },
  { id: "spotify", title: "Spotify", ok: false, note: "" },
  { id: "tiktok", title: "TikTok", ok: false, note: "" },
  { id: "youtube", title: "YouTube Premium", ok: false, note: "" },
];

/** 分组只影响排版：不在任何分组里的条目会落到「其他服务」，不会丢 */
const GROUPS: { id: string; title: string; desc: string; ids: string[] }[] = [
  { id: "ai", title: "AI 与效率", desc: "对话、推理与生成式服务", ids: ["chatgpt", "claude", "gemini"] },
  {
    id: "video",
    title: "流媒体与视频",
    desc: "区域版权与片库可达性",
    ids: ["netflix", "disney", "prime", "youtube", "bahamut", "bilibili-cn", "bilibili-hk"],
  },
  { id: "social", title: "音乐与社区", desc: "音乐、短视频与内容平台", ids: ["spotify", "tiktok"] },
];

/** 卡片副标题：写服务归属，比重复一遍名字更有信息量 */
const SUBTITLE: Record<string, string> = {
  chatgpt: "OpenAI",
  claude: "Anthropic",
  gemini: "Google",
  netflix: "影视流媒体",
  disney: "影视流媒体",
  prime: "Amazon",
  youtube: "Google",
  spotify: "音乐流媒体",
  tiktok: "ByteDance",
  bahamut: "巴哈姆特",
  "bilibili-cn": "哔哩哔哩",
  "bilibili-hk": "哔哩哔哩 · 港澳台",
};

type CardState = "idle" | "queued" | "testing" | "ok" | "no" | "fail";

function fmtTime(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function errText(e: unknown) {
  return String((e as Error)?.message || e || "测试失败");
}

function stateOf(u: UnlockItem, testing: boolean): CardState {
  if (testing) return "testing";
  if (!u.testedAt) return "idle";
  if (u.ok) return "ok";
  if (u.fail || /失败|网络/i.test(u.note)) return "fail";
  return "no";
}

const STATE_LABEL: Record<CardState, string> = {
  idle: "未测试",
  queued: "排队中",
  testing: "测试中",
  ok: "支持",
  no: "不支持",
  fail: "失败",
};

function StateIcon({ state }: { state: CardState }) {
  if (state === "testing") return <Loader2 size={12} className="spin" />;
  if (state === "queued") return <Clock size={12} />;
  if (state === "ok") return <CheckCircle2 size={12} />;
  if (state === "no") return <XCircle size={12} />;
  if (state === "fail") return <AlertCircle size={12} />;
  return <CircleDashed size={12} />;
}

/** 筛选器：全部 / 可用 / 不支持 / 失败 / 未测试 */
type Filter = "all" | "ok" | "no" | "fail" | "idle";

const FILTER_DEFS: { id: Filter; label: string; state?: CardState }[] = [
  { id: "all", label: "全部" },
  { id: "ok", label: "可用", state: "ok" },
  { id: "no", label: "不支持", state: "no" },
  { id: "fail", label: "失败", state: "fail" },
  { id: "idle", label: "未测试", state: "idle" },
];

function TestsPage({ running, onToast }: { running: boolean; onToast: (m: string) => void }) {
  const [items, setItems] = useState<UnlockItem[]>(IDLE);
  const [busyAll, setBusyAll] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(IDLE.length);
  const [filter, setFilter] = useState<Filter>("all");
  const stopRef = useRef(false);
  // 每次「测试全部」领取一个序号：过期的批次（例如组件热更新前遗留的循环）
  // 即使还在 await 里，也不会再改 UI、不会清掉新批次的停止标记。
  const runTokenRef = useRef(0);
  // 目录是否已从内核取回。冷启动时目录还没回来，items 只有本地 IDLE 兜底列表，
  // 此时直接开跑会「已完成 4/4」宣布全部通过，而真实服务列表随后才扩充到 20+ 项。
  const [catalogReady, setCatalogReady] = useState(false);

  const titleById = useMemo(() => new Map(items.map((i) => [i.id, i.title] as const)), [items]);

  useEffect(() => {
    let alive = true;
    window.veyra
      ?.unlockCatalog?.()
      .then((list) => {
        if (!alive) return;
        // 即使返回空也要置位：否则用户永远等不到「可测试」状态，
        // 按钮会一直卡在被禁用/被拦截的状态。
        setCatalogReady(true);
        if (!Array.isArray(list) || !list.length) return;
        setItems((prev) => {
          const byId = new Map(prev.map((p) => [p.id, p] as const));
          const merged = list.map((x) => {
            const old = byId.get(x.id);
            return old
              ? { ...old, title: x.title || old.title }
              : { id: x.id, title: x.title || x.id, ok: false, fail: false, region: null, note: "", testedAt: 0 };
          });
          const known = new Set(list.map((x) => x.id));
          // 目录里没有、但本地已有的条目保留在末尾（后端加/减项时不丢状态）
          return [...merged, ...prev.filter((p) => !known.has(p.id))];
        });
      })
      .catch(() => {
        // 取目录失败时也放行，避免按钮永久不可用（宁可测兜底列表也不卡死）
        if (alive) setCatalogReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  function mergeOne(next: UnlockItem) {
    setItems((prev) =>
      prev.map((p) =>
        p.id === next.id ? { ...p, ...next, title: next.title || p.title, testedAt: next.testedAt || Date.now() } : p
      )
    );
  }

  async function testOne(id: string) {
    if (!window.veyra?.streamingUnlockOne) {
      onToast("内核接口不可用");
      return;
    }
    if (!running) {
      onToast("请先启动内核再测试");
      return;
    }
    setBusyId(id);
    try {
      const r = await window.veyra.streamingUnlockOne(id);
      mergeOne({ ...r, id, title: r.title || titleById.get(id) || id } as UnlockItem);
    } catch (e) {
      mergeOne({
        id,
        title: titleById.get(id) || id,
        ok: false,
        fail: true,
        region: null,
        note: errText(e),
      });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 逐项调用 streamingUnlockOne，而不是一次 streamingUnlock：
   * 后端本来就是串行跑完 12 项再返回，逐项调用能把「正在测谁 / 已完成几项」
   * 实时反映到卡片上，也允许中途停止（停止后已完成的项不会丢）。
   */
  async function testAll() {
    if (!window.veyra?.streamingUnlockOne) {
      onToast("内核接口不可用");
      return;
    }
    if (!running) {
      onToast("请先启动内核再测试");
      return;
    }
    if (busyAll) {
      stopRef.current = true;
      setStopping(true);
      return;
    }
    if (!catalogReady) {
      onToast("服务列表加载中，请稍候再试");
      return;
    }
    stopRef.current = false;
    setStopping(false);
    const token = ++runTokenRef.current;
    const ids = items.map((i) => i.id);
    setBusyAll(true);
    setDone(0);
    setTotal(ids.length);
    let aborted = false;
    let finished = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        if (stopRef.current || token !== runTokenRef.current) {
          aborted = true;
          break;
        }
        const id = ids[i];
        setBusyId(id);
        try {
          const r = await window.veyra.streamingUnlockOne(id);
          if (token !== runTokenRef.current) break;
          mergeOne({ ...r, id, title: r.title || titleById.get(id) || id } as UnlockItem);
        } catch (e) {
          if (token !== runTokenRef.current) break;
          mergeOne({
            id,
            title: titleById.get(id) || id,
            ok: false,
            fail: true,
            region: null,
            note: errText(e),
          });
        }
        setDone(i + 1);
        finished = i + 1;
      }
    } finally {
      // 只有当前批次负责收尾；过期批次不得关掉新一轮的进度条/停止标记
      if (token === runTokenRef.current) {
        setBusyId(null);
        setBusyAll(false);
        setStopping(false);
        stopRef.current = false;
        onToast(aborted ? `已停止，已完成 ${finished} 项` : "解锁测试完成");
      }
    }
  }

  const stats = useMemo(() => {
    let ok = 0;
    let no = 0;
    let fail = 0;
    let idle = 0;
    for (const u of items) {
      if (!u.testedAt) idle++;
      else if (u.ok) ok++;
      else if (u.fail || /失败|网络/i.test(u.note)) fail++;
      else no++;
    }
    return { ok, no, fail, idle, total: items.length };
  }, [items]);

  const lastTestedAt = useMemo(() => items.reduce((max, u) => Math.max(max, u.testedAt || 0), 0), [items]);
  const pct = stats.total > 0 ? stats.ok / stats.total : 0;
  const RING_R = 44;
  const ringC = 2 * Math.PI * RING_R;

  // 英雄面板底色：全可用偏绿、有失败偏琥珀、其余中性（很淡，只作氛围）
  const heroTint = useMemo(() => {
    if (stats.total > 0 && stats.ok === stats.total) {
      return "color-mix(in srgb, var(--ok) 10%, transparent)";
    }
    if (stats.fail > 0) return "color-mix(in srgb, var(--warn) 9%, transparent)";
    if (stats.no > 0) return "color-mix(in srgb, var(--bad) 6%, transparent)";
    return "transparent";
  }, [stats.ok, stats.no, stats.fail, stats.total]);

  // 筛选计数：每个筛选器显示它命中多少项
  const filterCounts = useMemo(() => {
    const counts: Record<Filter, number> = { all: items.length, ok: 0, no: 0, fail: 0, idle: 0 };
    for (const u of items) {
      const s = stateOf(u, false);
      if (s === "ok") counts.ok++;
      else if (s === "no") counts.no++;
      else if (s === "fail") counts.fail++;
      else counts.idle++;
    }
    return counts;
  }, [items]);

  const grouped = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i] as const));
    const used = new Set<string>();
    const out = GROUPS.map((g) => {
      const list = g.ids.map((id) => byId.get(id)).filter((x): x is UnlockItem => !!x);
      list.forEach((x) => used.add(x.id));
      return { id: g.id, title: g.title, desc: g.desc, list };
    });
    const rest = items.filter((i) => !used.has(i.id));
    if (rest.length) out.push({ id: "other", title: "其他服务", desc: "尚未归类的检测项", list: rest });
    return out.filter((g) => g.list.length);
  }, [items]);

  const summaryTitle = busyAll
    ? `正在逐项检测… ${Math.min(done + 1, total)}/${total}`
    : stats.ok === stats.total && stats.total > 0
      ? "当前节点全部可用"
      : lastTestedAt
        ? `当前节点 ${stats.ok} 项可用`
        : "还没有检测结果";

  const hint = !running
    ? "内核未运行。启动代理后，这里的结果才代表当前出口节点的真实可达性。"
    : busyAll
      ? "结果会逐项回填；中途停止不会丢掉已完成的项。"
      : !lastTestedAt
        ? "点「测试全部」会用当前节点依次访问 12 项服务，通常需要 1–2 分钟。"
        : stats.ok === 0
          ? "全部不可用：先确认节点已生效、订阅未过期，再重试。"
          : "地区码取自 Cloudflare trace，代表探测请求的出口位置。";

  /** 卡片可见性：筛选器命中，且正在测试的项永远可见（避免它从视野里消失） */
  const visibleOf = (u: UnlockItem): boolean => {
    if (filter === "all") return true;
    if (busyId === u.id) return true;
    return stateOf(u, busyId === u.id) === filter;
  };

  return (
    <div className="pane tests-page tp-page">
      <header className="tp-head">
        <div className="tp-head-text">
          <h1>
            {t("tests.title", "解锁测试")}
            <span className="tp-count-badge">{stats.total} 项</span>
          </h1>
          <p>
            {t("tests.sub", "检测当前节点对 AI、流媒体与音乐服务的可达性，并标出探测出口所在地区。")}
          </p>
        </div>
        <div className="tp-head-actions">
          {lastTestedAt ? <span className="tp-last">{t("tests.lastRun", "上次测试")} · {relTime(lastTestedAt)}</span> : null}
        </div>
      </header>

      {!running ? (
        <div className="tp-alert" role="status">
          <AlertCircle size={15} />
          <span>{t("tests.coreOff", "内核未运行，启动代理服务后才能进行解锁测试。")}</span>
        </div>
      ) : null}

      {busyAll ? (
        <div
          className="tp-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="解锁测试进度"
        >
          <div className="tp-progress-track">
            <i style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <span>
            已完成 {done}/{total}
            {busyId ? ` · 正在检测 ${titleById.get(busyId) || busyId}` : ""}
          </span>
        </div>
      ) : null}

      {/* ── 英雄面板：环 + 状态分布 + 主操作 ─────────────────── */}
      <section className="tp-hero" aria-label="检测汇总" style={{ "--tp-tint": heroTint } as CSSProperties}>
        <div className="tp-hero-glow" aria-hidden="true" />
        <div className="tp-hero-ring">
          <svg viewBox="0 0 112 112" aria-hidden="true">
            <circle className="tp-ring-track" cx="56" cy="56" r={RING_R} />
            <circle
              className="tp-ring-value"
              cx="56"
              cy="56"
              r={RING_R}
              strokeDasharray={ringC}
              strokeDashoffset={ringC * (1 - pct)}
            />
          </svg>
          <div className="tp-ring-label">
            <b>{Math.round(pct * 100)}</b>
            <span>%</span>
            <em>{t("tests.available", "可用")}</em>
          </div>
        </div>

        <div className="tp-hero-main">
          <div className="tp-hero-title">{summaryTitle}</div>
          <div className="tp-stats">
            <span className="tp-stat is-ok">
              <CheckCircle2 size={13} />
              <b>{stats.ok}</b>
              <em>{t("tests.statOk", "可用")}</em>
            </span>
            <span className="tp-stat is-no">
              <XCircle size={13} />
              <b>{stats.no}</b>
              <em>{t("tests.statNo", "不支持")}</em>
            </span>
            <span className="tp-stat is-fail">
              <AlertCircle size={13} />
              <b>{stats.fail}</b>
              <em>{t("tests.statFail", "失败")}</em>
            </span>
            <span className="tp-stat is-idle">
              <CircleDashed size={13} />
              <b>{stats.idle}</b>
              <em>{t("tests.statIdle", "未测试")}</em>
            </span>
          </div>
          <div className="tp-summary-hint">{hint}</div>
        </div>

        <div className="tp-hero-cta">
          <button
            type="button"
            className={`btn primary tp-run${busyAll ? " is-busy" : ""}`}
            disabled={!running}
            onClick={() => testAll()}
            title={running ? (busyAll ? "停止本次检测" : "依次检测全部服务") : "请先启动内核"}
          >
            {busyAll ? <Square size={13} /> : <RefreshCw size={14} />}
            {busyAll ? (stopping ? t("tests.stopping", "正在停止…") : t("tests.stop", "停止测试")) : t("tests.runAll", "测试全部")}
          </button>
          <span className="tp-hero-count">
            {stats.ok}/{stats.total} {t("tests.available", "可用")}
          </span>
        </div>
      </section>

      {/* ── 状态筛选 ─────────────────────────────────────────── */}
      <div className="tp-filters" role="tablist" aria-label="按状态筛选">
        {FILTER_DEFS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`tp-filter${filter === f.id ? " is-on" : ""} is-${f.id}`}
            onClick={() => setFilter(f.id)}
          >
            <span className="tp-filter-dot" />
            <span>{t(`tests.filter.${f.id}`, f.label)}</span>
            <b>{filterCounts[f.id]}</b>
          </button>
        ))}
      </div>

      {/* ── 分组面板 ─────────────────────────────────────────── */}
      {grouped.map((g) => {
        const okCount = g.list.filter((u) => u.testedAt && u.ok).length;
        const list = g.list.filter(visibleOf);
        // 筛选后没有命中项时整组隐藏，避免出现空壳分组
        if (!list.length) return null;
        return (
          <section className="tp-group" key={g.id}>
            <div className="tp-group-hd">
              <div className="tp-group-titles">
                <h2>{g.title}</h2>
                <span className="tp-group-desc">{g.desc}</span>
              </div>
              <div className="tp-group-meta">
                <div className="tp-group-bar" aria-hidden="true">
                  <i style={{ width: `${g.list.length ? (okCount / g.list.length) * 100 : 0}%` }} />
                </div>
                <span className="tp-group-count">
                  <b>{okCount}</b>/{g.list.length} {t("tests.available", "可用")}
                </span>
              </div>
            </div>
            <div className="tp-grid">
              {list.map((u) => {
                const isCurrent = busyId === u.id;
                // 串行队列里，尚未轮到的项显示「排队中」，只有真正在跑的项才显示「测试中」
                const queued = busyAll && !isCurrent && !u.testedAt;
                const state: CardState = queued ? "queued" : stateOf(u, isCurrent);
                const brand = brandDef(u.id)?.bg || "var(--text-500)";
                const foot =
                  state === "idle"
                    ? t("tests.footIdle", "尚未检测")
                    : state === "queued"
                      ? t("tests.footQueued", "等待前面的检测完成…")
                      : state === "testing"
                        ? t("tests.footTesting", "正在通过当前节点请求…")
                        : state === "ok"
                          ? t("tests.footOk", "已验证连通")
                          : state === "no"
                            ? u.note && u.note !== "不支持"
                              ? u.note
                              : t("tests.footNo", "可访问，但地区未开放")
                            : u.note || t("tests.footFail", "请求失败");
                return (
                  <article
                    key={u.id}
                    className={`tp-card is-${state}`}
                    style={{ "--tp-brand": brand } as CSSProperties}
                  >
                    <div className="tp-card-top">
                      <BrandLogo id={u.id} size={36} />
                      <div className="tp-card-id">
                        <h3 title={u.title}>{u.title}</h3>
                        <span>{SUBTITLE[u.id] || "Service"}</span>
                      </div>
                      <button
                        type="button"
                        className="tp-card-refresh"
                        disabled={!running || busyAll || isCurrent}
                        onClick={() => testOne(u.id)}
                        title={`${t("tests.retest", "单独测试")} ${u.title}`}
                        aria-label={`${t("tests.retest", "单独测试")} ${u.title}`}
                      >
                        <RefreshCw size={14} className={busyId === u.id ? "spin" : undefined} />
                      </button>
                    </div>

                    <div className="tp-card-body">
                      <span className={`tp-pill is-${state}`}>
                        <StateIcon state={state} />
                        {STATE_LABEL[state]}
                      </span>
                      {state === "ok" && u.region ? (
                        <span className="tp-region" title={t("tests.regionTitle", "探测出口地区")}>
                          <i />
                          {u.region}
                        </span>
                      ) : null}
                    </div>

                    <div className="tp-card-foot">
                      <span className={`tp-note${state === "fail" ? " is-fail" : ""}`} title={u.note || undefined}>
                        {foot}
                      </span>
                      <time>{fmtTime(u.testedAt) || "—"}</time>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default memo(TestsPage);
