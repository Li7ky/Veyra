import { memo } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Power, ShieldCheck, ShieldOff } from "lucide-react";
import { t } from "./i18n";
import { stripFlagEmoji } from "./nodeName";

type Props = {
  sysProxy: boolean;
  running: boolean;
  busy?: boolean;
  mixedPort: number;
  nodeName: string;
  onToggleProxy: () => void;
  onToggleCore?: () => void;
  onNodeClick?: () => void;
  /** 运行态附加信息（内核名 · 运行时长）。 */
  meta?: ReactNode;
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
    <section className={`v-hero ${state}`}>
      <div className="v-hero-main">
        <button
          type="button"
          className={`v-orb ${busy ? "is-busy" : ""}`}
          onClick={onToggleCore ?? onToggleProxy}
          disabled={busy}
          title={running ? "点击停止代理服务" : "点击启动代理服务"}
          aria-label={running ? "停止代理服务" : "启动代理服务"}
        >
          <span className="v-orb-halo" aria-hidden="true" />
          <Power size={22} strokeWidth={2.2} />
        </button>

        <div className="v-hero-copy">
          <div className="v-hero-eyebrow">
            <i className={`v-dot ${state}`} aria-hidden="true" />
            <span>{stateEn}</span>
          </div>
          <div className="v-hero-title">{stateText}</div>
          <div className="v-hero-sub">
            {running ? (
              <>
                <code>127.0.0.1:{mixedPort}</code>
                {meta ? <span className="v-sep">·</span> : null}
                {meta}
              </>
            ) : (
              <span>点击左侧电源键启动内核</span>
            )}
          </div>
        </div>
      </div>

      <div className="v-hero-side">
        {showNodeBlock ? (
          <button
            type="button"
            className="v-node"
            onClick={onNodeClick}
            disabled={!onNodeClick}
            title={t("hero.switchNode", "切换节点")}
          >
            <span className="v-node-top">
              <span className={`v-node-name${showNode ? "" : " is-empty"}`}>
                {showNode ? stripFlagEmoji(nodeName) : t("home.noNodeShort", "未选择")}
              </span>
              {nodeType ? <span className="v-node-type">{nodeType}</span> : null}
              <ChevronRight size={13} aria-hidden="true" />
            </span>
            <span className="v-node-bottom">
              {showNode && delay != null && delay > 0 ? (
                <span className={`v-node-delay ${delayTone(delay)}`}>{delay} ms</span>
              ) : showNode ? (
                <span className="v-node-delay na">未测速</span>
              ) : null}
              <span className="v-node-count">
                {nodeCount ?? 0} {t("home.nodesAvailable", "节点可用")}
              </span>
            </span>
          </button>
        ) : null}

        <button
          type="button"
          className={`v-power ${sysProxy ? "on" : running ? "idle" : "off"}`}
          onClick={onToggleProxy}
          disabled={busy || (!running && !sysProxy)}
        >
          {sysProxy ? <ShieldCheck size={15} /> : <ShieldOff size={15} />}
          <span>
            {t("hero.systemProxy", "系统代理")}
            <b>{sysProxy ? "开" : "关"}</b>
          </span>
        </button>
      </div>
    </section>
  );
}

export default memo(ConnectOrb);
