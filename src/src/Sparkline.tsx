import { memo, useId } from "react";

type Props = {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
};

function Sparkline({
  data,
  color = "var(--accent-strong)",
  width = 120,
  height = 36,
  fill = true,
}: Props) {
  const pts = data.length ? data : [0];
  const max = Math.max(...pts, 1);
  const min = 0;
  const span = Math.max(max - min, 1);
  const step = pts.length > 1 ? width / (pts.length - 1) : width;
  // 渐变面积填充：顶 0.26 → 底 0.02，比纯色低透明更有体积感
  const gid = `spark-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const coords = pts.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = coords.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.26" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {fill && <polygon points={area} fill={`url(#${gid})`} />}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

// 数据引用不变时跳过重绘：代理页几十个节点的小趋势图不再跟着全页渲染跑
export default memo(Sparkline);
