"""抓取指定进程主窗口截图（仅用于本地 UI 自查，不参与构建）。

用法：python scripts/shot-window.py <pid> <out.png> [--full]
未指定 --full 时只截窗口区域；窗口坐标通过 ctypes 调 user32 获取，
不依赖 pywin32（本机未安装）。
"""

import ctypes
import sys
from ctypes import wintypes

from PIL import ImageGrab

user32 = ctypes.WinDLL("user32", use_last_error=True)


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


def find_window(pid: int) -> int:
    """返回该 pid 下第一个可见且有标题的顶层窗口句柄。"""
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        wpid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid and user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                found.append(hwnd)
                return False
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else 0


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: shot-window.py <pid> <out.png> [--full]")
        return 2

    pid = int(sys.argv[1])
    out = sys.argv[2]
    full = "--full" in sys.argv

    if full:
        img = ImageGrab.grab()
        img.save(out)
        print(f"saved fullscreen {img.size} -> {out}")
        return 0

    hwnd = find_window(pid)
    if not hwnd:
        print(f"no visible window for pid {pid}")
        return 1

    # 若窗口最小化，先还原
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)

    r = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        print("GetWindowRect failed:", ctypes.get_last_error())
        return 1

    box = (r.left, r.top, r.right, r.bottom)
    print(f"hwnd={hwnd} box={box} size={r.right - r.left}x{r.bottom - r.top}")

    img = ImageGrab.grab(bbox=box, all_screens=True)
    img.save(out)
    print(f"saved {img.size} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
