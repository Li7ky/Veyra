"""检查 Windows 外壳关键窗口是否存在且可见：任务栏 / 桌面。"""
import ctypes

user32 = ctypes.windll.user32
for label, cls in [("任务栏 Shell_TrayWnd", "Shell_TrayWnd"), ("桌面 Progman", "Progman")]:
    hwnd = user32.FindWindowW(cls, None)
    if not hwnd:
        print(f"{label}: 不存在")
    else:
        print(f"{label}: hwnd=0x{hwnd:X} 可见={bool(user32.IsWindowVisible(hwnd))}")
