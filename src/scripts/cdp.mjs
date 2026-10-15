/**
 * 通过 CDP 操作 Veyra 渲染进程（本地 UI 自查用，不参与构建）。
 *
 * 依赖：应用以 --remote-debugging-port=9222 启动。
 * 用 Node 内置的全局 fetch + WebSocket（Node 22 已内置）连接，无需额外依赖。
 *
 * 用法：
 *   node scripts/cdp.mjs eval "<js表达式>"
 *   node scripts/cdp.mjs click-nav "<导航文字>"   切换左侧导航
 *   node scripts/cdp.mjs pages                    列出可调试目标
 */

const PORT = Number(process.env.CDP_PORT || 9222);
const HOST = "127.0.0.1";

async function listTargets() {
  const res = await fetch(`http://${HOST}:${PORT}/json/list`);
  return res.json();
}

/** 优先选页面（type=page 且 url 非 devtools） */
async function pickPage() {
  const targets = await listTargets();
  const page = targets.find(
    (t) => t.type === "page" && !String(t.url).startsWith("devtools://")
  );
  if (!page) throw new Error("未找到可调试页面，请确认应用已启动");
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;

    ws.addEventListener("open", () =>
      resolve({
        ws,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close: () => ws.close(),
      })
    );
    ws.addEventListener("error", (e) =>
      reject(new Error("WebSocket 连接失败: " + (e.message || "unknown")))
    );
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === "pages") {
    const t = await listTargets();
    for (const x of t) console.log(`${x.type}\t${x.title}\t${x.url}`);
    return;
  }

  const page = await pickPage();
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Runtime.enable");

  const evaluate = async (expression) => {
    const r = await c.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)
      );
    }
    return r.result?.value;
  };

  try {
    if (cmd === "eval") {
      console.log(JSON.stringify(await evaluate(arg), null, 2));
    } else if (cmd === "click-nav") {
      // 左侧导航按钮文本匹配后点击，再看切页结果
      const out = await evaluate(`(() => {
        const want = ${JSON.stringify(arg)};
        const btns = [...document.querySelectorAll('.col-sidebar button')];
        const hit = btns.find(b => (b.textContent || '').trim().includes(want));
        if (!hit) return 'not-found: ' + btns.map(b => (b.textContent||'').trim()).join('|');
        hit.click();
        return 'clicked: ' + (hit.textContent || '').trim();
      })()`);
      console.log(out);
      // 等 React 渲染
      await new Promise((r) => setTimeout(r, 800));
      const state = await evaluate(`(() => {
        const rail = document.querySelector('.col-right');
        const panes = [...document.querySelectorAll('.pane')].map(p => ({
          cls: p.className,
          hidden: p.hasAttribute('hidden'),
          display: getComputedStyle(p).display,
          visible: !!(p.offsetWidth || p.offsetHeight),
        }));
        return {
          activeNav: (document.querySelector('.col-sidebar button.active')||{}).textContent?.trim(),
          railExists: !!rail,
          railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
          railText: rail ? (rail.innerText||'').replace(/\\s+/g,' ').slice(0,300) : null,
          paneCount: panes.length,
          visiblePanes: panes.filter(p => p.visible).map(p => p.cls),
        };
      })()`);
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log("用法: cdp.mjs <pages|eval|click-nav> [arg]");
      process.exitCode = 2;
    }
  } finally {
    c.close();
  }
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
