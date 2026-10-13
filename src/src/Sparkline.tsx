import { memo } from "react";

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

  const coords = pts.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = coords.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {fill && (
        <polygon points={area} fill={color} opacity={0.12} />
      )}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 数据引用不变时跳过重绘：代理页几十个节点的小趋势图不再跟着全页渲染跑
export default memo(Sparkline);
