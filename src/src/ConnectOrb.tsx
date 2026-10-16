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
};

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
          <Power size={36} strokeWidth={2.4} />
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
              {showNode ? (
                onNodeClick ? (
                  /* P2：节点名从纯文本改为可点击入口——切节点是日频操作，
                     首屏直接回答「现在用的谁、去哪换」，省掉三步导航 */
                  <button
                    type="button"
                    className="hero-node-btn"
                    onClick={onNodeClick}
                    title={t("hero.switchNode", "切换节点")}
                  >
                    <span className="hero-node">{nodeName}</span>
                    <ChevronDown size={13} />
                  </button>
                ) : (
                  <span className="hero-node">· {nodeName}</span>
                )
              ) : null}
            </>
          ) : (
            <span>点击 Core 按钮启动代理服务</span>
          )}
        </div>
      </div>

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
        {meta ? <div className="hero-run">{meta}</div> : null}
      </div>
    </section>
  );
}

export default memo(ConnectOrb);
