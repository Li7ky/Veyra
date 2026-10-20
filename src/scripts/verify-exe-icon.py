"""校验已打包 exe 内嵌图标是否来自当前狐狸 icon.ico。

做法：解析 icon.ico 里每个 PNG 条目的原始字节，再在 exe 二进制中检索这些字节序列。
命中即说明 exe 资源段里嵌入了同一批图标数据。
"""
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICO = ROOT / "resources" / "icons" / "icon.ico"
DEFAULT_TARGETS = [
    Path(r"D:\FoxVey\win-unpacked\FoxVey.exe"),
    Path(r"D:\FoxVey\FoxVey-Setup-1.0.0-x64.exe"),
]
TARGETS = [Path(a) for a in sys.argv[1:]] or DEFAULT_TARGETS


def ico_entries(path):
    data = path.read_bytes()
    reserved, itype, count = struct.unpack_from("<HHH", data, 0)
    if reserved != 0 or itype != 1:
        raise SystemExit(f"{path} 不是标准 ICO 文件")
    out = []
    for i in range(count):
        off = 6 + i * 16
        w, h, colors, _r, planes, bpp, size, offset = struct.unpack_from("<BBBBHHII", data, off)
        blob = data[offset:offset + size]
        out.append({
            "w": w or 256,
            "h": h or 256,
            "bpp": bpp,
            "size": size,
            "blob": blob,
            "png": blob[:8] == b"\x89PNG\r\n\x1a\n",
        })
    return out


def main():
    if not ICO.exists():
        raise SystemExit(f"缺少 {ICO}")
    entries = ico_entries(ICO)
    print(f"[ico] {ICO}")
    print(f"[ico] 条目数={len(entries)} 尺寸={[e['w'] for e in entries]} PNG编码={[e['png'] for e in entries]}")

    ok = True
    for exe in TARGETS:
        if not exe.exists():
            print(f"[exe] 缺失 {exe}")
            ok = False
            continue
        blob = exe.read_bytes()
        hits = []
        for e in entries:
            found = blob.find(e["blob"]) != -1
            hits.append((e["w"], found))
        matched = sum(1 for _, f in hits if f)
        print(f"[exe] {exe.name} 大小={len(blob):,}B 命中图标条目={matched}/{len(entries)} -> {hits}")
        if matched != len(entries):
            ok = False
    print("[result]", "PASS 全部图标条目已内嵌" if ok else "FAIL 存在未内嵌的图标条目")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
