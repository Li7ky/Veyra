import { memo } from "react";
import { Power, ShieldCheck, ShieldOff } from "lucide-react";

type Props = {
  sysProxy: boolean;
  running: boolean;
  busy?: boolean;
  mixedPort: number;
  nodeName: string;
  onToggleProxy: () => void;
  onToggleCore?: () => void;
};

function ConnectOrb({
  sysProxy,
  running,
  busy,
  mixedPort,
  nodeName,
  onToggleProxy,
  onToggleCore,
}: Props) {
  // 与托盘同语义：只有「内核在线 && 系统代理开」才算生效。
  const active = running && sysProxy;
  const state = !running ? "off" : active ? "on" : "idle";
  const showNode = nodeName && nodeName !== "—";
  const stateText = !running ? "未连接" : active ? "代理生效中" : "内核运行中";
  const stateEn = !running ? "DISCONNECTED" : active ? "PROTECTED" : "CORE ONLY";

  return (
    <section className={`hero ${state}`}>
      <button
        type="button"
        className={`hero-orb-btn ${busy ? "spinning" : ""}`}
        onClick={onToggleCore ?? onToggleProxy}
        disabled={busy}
        title={running ? "点击停止代理服务" : "点击启动代理服务"}
      >
        <Power size={32} strokeWidth={2.2} />
      </button>

      <div className="hero-info">
        <div className="hero-k">
          <span className="k-dot" />
          {stateEn} · Veyra Core
        </div>
        <div className="hero-state">{stateText}</div>
        <div className="hero-meta">
          {running ? (
            <>
              <code>127.0.0.1:{mixedPort}</code>
              {showNode ? <span className="hero-node">· {nodeName}</span> : null}
            </>
          ) : (
            <span>点击左侧电源按钮启动代理服务</span>
          )}
        </div>
      </div>

      <div className="hero-actions">
        <button
          type="button"
          className={`hero-btn ${sysProxy ? "stop" : "go"}`}
          onClick={onToggleProxy}
          disabled={busy || (!running && !sysProxy)}
        >
          {sysProxy ? (
            <>
              <ShieldCheck size={16} /> 系统代理 · 开
            </>
          ) : (
            <>
              <ShieldOff size={16} /> 系统代理 · 关
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
