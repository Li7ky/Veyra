import { useEffect, useState } from "react";
import { Activity, CheckCircle2, AlertTriangle, XCircle, X, ShieldCheck } from "lucide-react";

type Props = {
  running: boolean;
  sysProxy: boolean;
  downRate: number;
  upRate: number;
  connCount: number;
  nodeName: string;
  delay?: number | null;
  nodeCount: number;
  startedAt: number | null;
  blockedToday?: number;
  /** bar = 首页顶部常驻状态条；button = 只渲染一颗「体检」按钮（首页页头用） */
  variant?: "bar" | "button";
};

type Level = "ok" | "warn" | "bad";

type Item = {
  id: string;
  level: Level;
  title: string;
  detail: string;
};

const api = () =>
  (window as unknown as { veyra?: Record<string, (...a: unknown[]) => Promise<unknown>> }).veyra;

function rate(bps: number) {
  if (!bps) return "0 B/s";
  const u = ["B", "KB", "MB", "GB"];
  let v = bps;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}/s`;
}

function uptime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** 首屏常驻状态条：一屏给全「状态 / 速率 / 节点 / 延迟 / 连接 / 体检」 */
export function HomePulse(props: Props) {
  const [open, setOpen] = useState(
    () => import.meta.env.DEV && new URLSearchParams(location.search).get("diag") === "1"
  );
  const [, force] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      force((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const state = !props.running ? "off" : props.sysProxy ? "on" : "idle";
  const up = props.startedAt ? Date.now() - props.startedAt : 0;

  // 页头按钮形态：把「体检」作为首页页头的次要操作，不再占用一整条状态栏
  if (props.variant === "button") {
    return (
      <>
        <button
          type="button"
          className="btn ghost btn-sm hs-health"
          onClick={() => setOpen(true)}
          title="网络体检"
        >
          <Activity size={13} />
          体检
        </button>
        {open ? <DiagnoseSheet onClose={() => setOpen(false)} {...props} /> : null}
      </>
    );
  }

  return (
    <>
      <div className={`pulse ${state}`}>
        <span className={`pulse-dot ${state}`} aria-hidden="true" />
        <span className="pulse-sep" aria-hidden="true" />
        <span className="pulse-rate down">↓ {rate(props.downRate)}</span>
        <span className="pulse-rate up">↑ {rate(props.upRate)}</span>
        <span className="pulse-live" aria-hidden="true">
          {props.running ? `已运行 ${uptime(up)}` : "服务未运行"}
        </span>
        <button type="button" className="pulse-health" onClick={() => setOpen(true)}>
          <Activity size={13} />
          体检
          <i className="new-badge">NEW</i>
        </button>
      </div>
      {open ? <DiagnoseSheet onClose={() => setOpen(false)} {...props} /> : null}
    </>
  );
}

/** 体检弹层：逐项跑检查、给出分数与建议 */
function DiagnoseSheet(props: Props & { onClose: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    const push = (i: Item) => {
      if (alive) setItems((prev) => [...prev, i]);
    };

    (async () => {
      const v = api();

      // 1. 系统代理
      let proxyOn = props.sysProxy;
      try {
        const s = (await v?.systemProxyStatus?.()) as { enabled?: boolean } | undefined;
        if (s) proxyOn = !!s.enabled;
      } catch {
        /* 读取失败就用运行态兜底 */
      }
      push(
        proxyOn
          ? { id: "proxy", level: "ok", title: "系统代理", detail: "已由 Veyra 接管" }
          : { id: "proxy", level: props.running ? "warn" : "bad", title: "系统代理", detail: props.running ? "内核在跑，但系统代理未开启" : "未接管系统代理" }
      );
      await new Promise((r) => setTimeout(r, 320));

      // 2. 内核
      let coreOk = props.running;
      let ver = "";
      try {
        const c = (await v?.coreStatus?.()) as { running?: boolean; version?: string } | undefined;
        if (c) {
          coreOk = !!c.running;
          ver = c.version || "";
        }
      } catch {
        /* ignore */
      }
      push(
        coreOk
          ? { id: "core", level: "ok", title: "内核", detail: `Mihomo ${ver || ""} 运行中`.trim() }
          : { id: "core", level: "bad", title: "内核", detail: "内核未运行，代理不可用" }
      );
      await new Promise((r) => setTimeout(r, 320));

      // 3. 端口
      let ports = "";
      try {
        const s = (await v?.getSettings?.()) as { mixedPort?: number; controllerPort?: number } | undefined;
        if (s?.mixedPort) ports = `${s.mixedPort} / ${s.controllerPort ?? "-"}`;
      } catch {
        /* ignore */
      }
      push(
        ports
          ? { id: "ports", level: "ok", title: "代理端口", detail: `混合 / 控制端口 ${ports}` }
          : { id: "ports", level: "warn", title: "代理端口", detail: "未读取到端口配置" }
      );
      await new Promise((r) => setTimeout(r, 320));

      // 4. 节点
      const good = props.nodeName ? 1 : 0;
      push(
        props.nodeCount === 0
          ? { id: "node", level: "bad", title: "节点", detail: "没有可用节点，先导入订阅" }
          : good && props.delay != null && props.delay > 800
            ? { id: "node", level: "warn", title: "节点", detail: `当前节点延迟偏高（${props.delay}ms），可切换` }
            : {
                id: "node",
                level: "ok",
                title: "节点",
                detail: `${props.nodeCount} 个可用${props.delay ? ` · 当前 ${props.delay}ms` : ""}`,
              }
      );
      await new Promise((r) => setTimeout(r, 320));

      // 5. 订阅
      let subs: { userinfo?: { expire?: number } }[] = [];
      try {
        subs = ((await v?.listSubscriptions?.()) as typeof subs) || [];
      } catch {
        /* ignore */
      }
      const soon = subs
        .map((s) => (s.userinfo?.expire || 0) * 1000)
        .filter((t) => t > 0)
        .sort((a, b) => a - b)[0];
      // 用 ceil：还剩 12 小时应显示「1 天后」，已过期则为负数，单独出一句「已过期 N 天」
      const days = soon ? Math.ceil((soon - Date.now()) / 86400000) : null;
      const expireText =
        days === null
          ? ""
          : days < 0
            ? ` · 已过期 ${Math.abs(days)} 天`
            : ` · ${days} 天后到期`;
      push(
        subs.length === 0
          ? { id: "sub", level: "warn", title: "订阅", detail: "还没有订阅，导入机场链接即可开始" }
          : days !== null && days <= 7
            ? { id: "sub", level: "warn", title: "订阅", detail: `${subs.length} 个订阅${expireText}` }
            : { id: "sub", level: "ok", title: "订阅", detail: `${subs.length} 个订阅${expireText}` }
      );

      if (alive) setDone(true);
    })();

    return () => {
      alive = false;
    };
    // 只在打开时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const score = done
    ? Math.max(
        0,
        100 -
          items.reduce((acc, i) => acc + (i.level === "warn" ? 8 : i.level === "bad" ? 25 : 0), 0)
      )
    : null;

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal-box diag" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="diag-hd">
          <div>
            <h3>网络体检</h3>
            <p>{done ? "检查完成，以下是可以改进的地方" : "正在逐项检查…"}</p>
          </div>
          {score !== null ? (
            <div className={`diag-score ${score >= 90 ? "ok" : score >= 70 ? "warn" : "bad"}`}>
              <b>{score}</b>
              <span>分</span>
            </div>
          ) : (
            <div className="diag-score loading">
              <b>…</b>
            </div>
          )}
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <ul className="diag-list">
          {items.map((i) => (
            <li key={i.id} className={i.level}>
              <span className="diag-ico">
                {i.level === "ok" ? <CheckCircle2 size={15} /> : i.level === "warn" ? <AlertTriangle size={15} /> : <XCircle size={15} />}
              </span>
              <span className="diag-title">{i.title}</span>
              <span className="diag-detail">{i.detail}</span>
            </li>
          ))}
        </ul>

        <footer className="diag-ft">
          <ShieldCheck size={14} />
          <span>检查项全部在本机完成，不会上传任何数据</span>
          <button type="button" className="btn primary" onClick={props.onClose}>
            {done ? "完成" : "关闭"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default HomePulse;
