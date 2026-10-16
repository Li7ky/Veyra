"""渲染层截图：CDP 直连（不用 Playwright 的 page.screenshot——它会卡在 waiting fonts）。

用法：
    python _shot_review.py <输出路径> [宽] [高] [注入JS文件]

前置：vite dev 已在 5173 运行；headless chromium 已在 9224 开着调试端口。
"""
import base64
import json
import os
import sys
import time
import urllib.request

import websocket

PORT = 9224
OUT = sys.argv[1] if len(sys.argv) > 1 else "_shots/ui_after.png"
W = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
H = int(sys.argv[3]) if len(sys.argv) > 3 else 860
INJECT = sys.argv[4] if len(sys.argv) > 4 else None


def list_targets():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=10) as r:
        return json.load(r)


target = None
for _ in range(40):
    try:
        pages = [t for t in list_targets() if t.get("type") == "page"]
        for t in pages:
            if "5173" in (t.get("url") or ""):
                target = t
                break
        if target is None and pages:
            target = pages[0]
        if target:
            break
    except Exception:
        pass
    time.sleep(1)

if not target:
    print("NO_TARGET")
    sys.exit(1)

ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=60)
_seq = 0


def send(method, params=None):
    global _seq
    _seq += 1
    mid = _seq
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg


send("Page.enable")
send("Runtime.enable")
send(
    "Emulation.setDeviceMetricsOverride",
    {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False},
)

if INJECT and os.path.exists(INJECT):
    with open(INJECT, "r", encoding="utf-8") as f:
        js = f.read()
    send("Runtime.evaluate", {"expression": js, "awaitPromise": True})

time.sleep(3.5)

# headless=new 下 fromSurface:false 会返回空白，必须用 True。
# （Electron 环境相反：那里 fromSurface:false 才拿得到内容，按环境切换。）
res = send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
data = res.get("result", {}).get("data")
if not data:
    print("CAPTURE_FAILED", json.dumps(res)[:300])
    sys.exit(1)

outdir = os.path.dirname(OUT)
if outdir:
    os.makedirs(outdir, exist_ok=True)
with open(OUT, "wb") as f:
    f.write(base64.b64decode(data))
print("SAVED", OUT, "bytes=", len(data))
