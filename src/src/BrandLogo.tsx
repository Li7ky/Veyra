import { memo } from "react";
import { brandDef } from "./brandLogos";

/**
 * 品牌磁贴：一块 44px 的「应用图标」——底色是品牌色，图形本身来自官方矢量源。
 *
 * 两类素材：
 *  - svg：单路径/多路径矢量，随容器缩放，任意 DPI 都清晰（多数品牌）
 *  - img：位图 data URI（巴哈姆特只有官方 favicon，无可用的公开矢量标）
 *
 * 磁贴尺寸固定，图形统一限制在 30px 的内框里，靠 SVG 自身 preserveAspectRatio
 * 在方形框里等比缩放，所以 1:1 的星芒和 551:1000 的 N 字标不会互相拉扯变形。
 */
function BrandLogo({ id, size = 44 }: { id: string; size?: number }) {
  const def = brandDef(id);
  const art = def?.art || 28;
  const style: React.CSSProperties = {
    width: size,
    height: size,
    background: def?.bg || "#8a93a6",
    color: def?.fg || "#ffffff",
  };

  return (
    <span
      className={`tp-logo${def?.light ? " is-light" : ""}${def?.img ? " is-img" : ""}`}
      style={style}
      aria-hidden="true"
    >
      {def?.img ? (
        <img src={def.img} alt="" draggable={false} />
      ) : def?.svg ? (
        // 静态品牌 SVG（本仓库内的常量），不含任何外部输入
        <span
          className="tp-logo-art"
          style={{ width: art, height: art }}
          dangerouslySetInnerHTML={{ __html: def.svg }}
        />
      ) : (
        <b className="tp-logo-fallback">{id.slice(0, 2).toUpperCase()}</b>
      )}
    </span>
  );
}

export default memo(BrandLogo);
