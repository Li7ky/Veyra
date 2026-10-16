import { memo } from "react";

type Props = {
  up: number[];
  down: number[];
  /** 空态：只渲染网格底，不画数据线（零流量画出的贴底直线会被读成「图表故障」） */
  empty?: boolean;
};

function smoothPath(data: number[], w: number, h: number, pad = 10) {
  const pts = data.length ? data : [0];
  const max = Math.max(...pts, 1);
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  const coords = pts.map((v, i) => {
    const x = i * step;
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y] as const;
  });
  if (coords.length < 2) {
    const [x, y] = coords[0];
    return { line: `M0,${h - pad} L${w},${h - pad}`, area: `M0,${h - pad} L${w},${h - pad} L${w},${h} L0,${h} Z`, tip: { x: w, y } };
  }
  // Catmull-Rom → Bezier 平滑
  let d = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(coords.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const tip = { x: coords[coords.length - 1][0], y: coords[coords.length - 1][1] };
  return { line: d, area: `${d} L${w},${h} L0,${h} Z`, tip };
}

function WaveChart({ up, down, empty }: Props) {
  const w = 720;
  const h = 170;
  // 全 0 数据：smoothPath 会算出一条贴底水平线，与「图表挂了」无法区分——直接不画。
  const hasData = !empty && (up.some((v) => v > 0) || down.some((v) => v > 0));
  const dn = smoothPath(down, w, h);
  const u = smoothPath(up, w, h);
  const gid = "aurora-wave";
  return (
    <svg className="wave-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={`${gid}-dn`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--blue-500)" stopOpacity="0.38" />
          <stop offset="100%" stopColor="var(--blue-500)" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id={`${gid}-up`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--emerald-500)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--emerald-500)" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id={`${gid}-dn-line`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--blue-500)" stopOpacity="0.55" />
          <stop offset="60%" stopColor="var(--purple-500)" />
          <stop offset="100%" stopColor="var(--cyan-500)" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1="0"
          x2={w}
          y1={h * f}
          y2={h * f}
          stroke="currentColor"
          strokeOpacity="0.15"
          strokeDasharray="4 6"
          strokeWidth="1"
        />
      ))}
      {hasData && (
        <>
          <path d={dn.area} fill={`url(#${gid}-dn)`} />
          <path d={u.area} fill={`url(#${gid}-up)`} />
          <path d={dn.line} fill="none" stroke={`url(#${gid}-dn-line)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={u.line} fill="none" stroke="var(--green-400)" strokeOpacity="0.85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <circle cx={dn.tip.x} cy={dn.tip.y} r="4.5" fill="var(--indigo-500)" stroke="#fff" strokeWidth="2" />
        </>
      )}
    </svg>
  );
}

export default memo(WaveChart);
