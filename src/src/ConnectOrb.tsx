import { memo } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Power, ShieldCheck, ShieldOff } from "lucide-react";
import { t } from "./i18n";

type Props = {
  sysProxy: boolean;
  running: boolean;
  busy?: boolean;
  mixedPort: number;
  nodeName: string;
  onToggleProxy: () => void;
  onToggleCore?: () => void;
  onNodeClick?: () => void;
  /** 运行态附加信息（内核名 · 运行时长）。原属右栏「系统时间」卡，
      v13 右栏精简后移到这里，避免单独占一张卡的高度。 */
  meta?: ReactNode;
  /** 当前节点延迟 / 可用节点数：填进 hero 右侧原本空着的 200px，
      同时把「用的谁、快不快」提到首屏（此前在折叠线以下） */
  delay?: number | null;
  nodeCount?: number;
  nodeType?: string;
  /** 首页「当前节点」开关：关掉时 hero 右侧的节点块整块隐藏 */
  showNodeBlock?: boolean;
};

function delayTone(ms?: number | null): string {
  if (ms == null || ms <= 0) return "na";
  if (ms < 200) return "good";
  if (ms < 500) return "mid";
  return "bad";
}

function ConnectOrb({
  sysProxy,
  running,
  busy,
  mixedPort,
  nodeName,
  onToggleProxy,
  onToggleCore,
  onNodeClick,
  meta,
  delay,
  nodeCount,
  nodeType,
  showNodeBlock = true,
}: Props) {
  // 与托盘同语义：只有「内核在线 && 系统代理开」才算生效。
  const active = running && sysProxy;
  const state = !running ? "off" : active ? "on" : "idle";
  const showNode = nodeName && nodeName !== "—";
  const stateText = !running ? "未连接" : active ? "代理生效中" : "内核运行中";
  const stateEn = !running ? "DISCONNECTED" : active ? "PROTECTED" : "CORE ONLY";

  return (
    <section className={`hero ${state}`}>
      {/* 外环光晕 — 仅在连接状态显示 */}
      {active && (
        <div className="hero-ring" aria-hidden="true">
          <div className="ring ring-1" />
          <div className="ring ring-2" />
          <div className="ring ring-3" />
        </div>
      )}

      <button
        type="button"
        className={`hero-orb-btn ${busy ? "spinning" : ""} ${active ? "pulse" : ""}`}
        onClick={onToggleCore ?? onToggleProxy}
        disabled={busy}
        title={running ? "点击停止代理服务" : "点击启动代理服务"}
      >
        <div className="orb-glow" aria-hidden="true" />
        <div className="orb-core">
          <Power size={34} strokeWidth={2.4} />
        </div>
      </button>

      <div className="hero-info">
        <div className="hero-k">
          <span className={`k-dot ${state}`} />
          <span className="k-text">{stateEn}</span>
          <span className="k-sep">·</span>
          <span className="k-brand">Veyra-omini Core</span>
        </div>
        <div className="hero-state">{stateText}</div>
        <div className="hero-meta">
          {running ? (
            <>
              <code>127.0.0.1:{mixedPort}</code>
              {meta ? <span className="hero-run-sep">·</span> : null}
              {meta}
            </>
          ) : (
            <span>点击 Core 按钮启动代理服务</span>
          )}
        </div>
      </div>

      {/* 当前节点：原本在折叠线以下的「当前节点 / 延迟」两个 tile，
          合并成 hero 右侧这一块——首屏就能看到「用的谁、快不快」，
          点一下直接去代理页切节点。 */}
      {showNodeBlock ? (
      <button
        type="button"
        className="hero-node-block"
        onClick={onNodeClick}
        disabled={!onNodeClick}
        title={t("hero.switchNode", "切换节点")}
      >
        <span className="hnb-k">{t("home.currentNode", "当前节点")}</span>
        <span className="hnb-v">
          <span className={`hnb-name${showNode ? "" : " is-empty"}`}>
            {showNode ? nodeName : t("home.noNodeShort", "未选择")}
          </span>
          {nodeType ? <span className="hnb-type">{nodeType}</span> : null}
          <ChevronDown size={13} aria-hidden="true" />
        </span>
        <span className="hnb-meta">
          {/* 没选节点时不显示延迟：一个孤零零的「—」看不出是延迟还是缺数据 */}
          {showNode ? (
            <>
              <span className={`hnb-delay ${delayTone(delay)}`}>
                {delay != null && delay > 0 ? `${delay} ms` : "未测速"}
              </span>
              <span className="hnb-dot">·</span>
            </>
          ) : null}
          <span>
            {nodeCount ?? 0} {t("home.nodesAvailable", "节点可用")}
          </span>
        </span>
      </button>
      ) : null}

      <div className="hero-actions">
        <button
          type="button"
          className={`hero-btn ${sysProxy ? "stop" : running ? "warn" : "go"}`}
          onClick={onToggleProxy}
          disabled={busy || (!running && !sysProxy)}
        >
          {sysProxy ? (
            <>
              <ShieldCheck size={16} /> 系统代理 · 开
            </>
          ) : (
            <>
              <ShieldOff size={16} /> {running ? "系统代理 · 未开启" : "系统代理 · 关"}
            </>
          )}
        </button>
        {onToggleCore ? (
          <button
            type="button"
            className="hero-btn ghosty"
            onClick={onToggleCore}
            disabled={busy}
          >
            {running ? "停止内核服务" : "启动内核服务"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default memo(ConnectOrb);
