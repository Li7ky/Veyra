import { memo, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";

export type UnlockItem = {
  id: string;
  title: string;
  ok: boolean;
  fail?: boolean;
  region?: string | null;
  note: string;
  status?: number;
  testedAt?: number;
};

const IDLE: UnlockItem[] = [
  { id: "bilibili-cn", title: "哔哩哔哩大陆", ok: false, note: "" },
  { id: "bilibili-hk", title: "哔哩哔哩港澳台", ok: false, note: "" },
  { id: "bahamut", title: "Bahamut Anime", ok: false, note: "" },
  { id: "chatgpt", title: "ChatGPT Web", ok: false, note: "" },
  { id: "claude", title: "Claude", ok: false, note: "" },
  { id: "disney", title: "Disney+", ok: false, note: "" },
  { id: "gemini", title: "Gemini", ok: false, note: "" },
  { id: "netflix", title: "Netflix", ok: false, note: "" },
  { id: "prime", title: "Prime Video", ok: false, note: "" },
  { id: "spotify", title: "Spotify", ok: false, note: "" },
  { id: "tiktok", title: "TikTok", ok: false, note: "" },
  { id: "youtube", title: "YouTube Premium", ok: false, note: "" },
];

function fmtTime(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function TestsPage({
  running,
  onToast,
}: {
  running: boolean;
  onToast: (m: string) => void;
}) {
  const [items, setItems] = useState<UnlockItem[]>(IDLE);
  const [busyAll, setBusyAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    window.veyra?.unlockCatalog?.().then((list) => {
      if (list?.length) {
        setItems(
          list.map((x) => ({
            id: x.id,
            title: x.title,
            ok: false,
            fail: false,
            region: null,
            note: "",
            testedAt: 0,
          }))
        );
      }
    }).catch(() => {});
  }, []);

  function mergeOne(next: UnlockItem) {
    setItems((prev) => prev.map((p) => (p.id === next.id ? { ...p, ...next } : p)));
  }

  async function testOne(id: string) {
    if (!window.veyra?.streamingUnlockOne) {
      onToast("内核接口不可用");
      return;
    }
    setBusyId(id);
    try {
      const r = await window.veyra.streamingUnlockOne(id);
      mergeOne(r as UnlockItem);
    } catch (e) {
      mergeOne({
        id,
        title: items.find((x) => x.id === id)?.title || id,
        ok: false,
        fail: true,
        note: String((e as Error).message || e),
        testedAt: Date.now(),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function testAll() {
    setBusyAll(true);
    try {
      const list = (await window.veyra?.streamingUnlock?.()) || [];
      if (list.length) {
        setItems((prev) =>
          prev.map((p) => {
            const n = list.find((x) => x.id === p.id);
            return n ? { ...p, ...n } : p;
          })
        );
      }
      onToast("解锁测试完成");
    } catch (e) {
      onToast(String((e as Error).message || e));
    } finally {
      setBusyAll(false);
    }
  }

  return (
    <div className="pane tests-page unlock-page">
      <div className="unlock-top" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn primary" disabled={!running || busyAll} onClick={() => testAll()}>
          <RefreshCw size={14} className={busyAll ? "spin" : undefined} />
          {busyAll ? "测试中…" : "测试全部"}
        </button>
      </div>

      <div className="unlock-grid verge">
        {items.map((u) => {
          const runningThis = busyAll || busyId === u.id;
          const tested = !!(u.testedAt && u.testedAt > 0);
          const fail = !!u.fail || (tested && !u.ok && /失败|网络/i.test(u.note));
          const unsupported = tested && !u.ok && !fail;
          const supported = tested && u.ok && !fail;
          return (
            <article key={u.id} className="ul-card">
              <div className="ul-card-hd">
                <h3>{u.title}</h3>
                <button
                  type="button"
                  className="ul-refresh"
                  disabled={!running || runningThis}
                  title="单项测试"
                  onClick={() => testOne(u.id)}
                >
                  <RefreshCw size={16} className={busyId === u.id ? "spin" : undefined} />
                </button>
              </div>
              <div className="ul-status">
                {!tested && !runningThis ? <span className="ul-wait">未测试</span> : null}
                {runningThis ? <span className="ul-wait">测试中…</span> : null}
                {supported ? (
                  <span className="ul-badge ok">
                    <CheckCircle2 size={13} /> 支持
                  </span>
                ) : null}
                {unsupported ? (
                  <span className="ul-badge no">
                    <XCircle size={13} /> 不支持
                  </span>
                ) : null}
                {fail && tested && !runningThis ? (
                  <span className="ul-badge fail" title={u.note}>
                    <AlertCircle size={13} /> {/OPENSSL|BAD_DECRYPT|error:\d/i.test(u.note) ? "测试失败 (TLS)" : u.note || "测试失败"}
                  </span>
                ) : null}
                {u.region && supported ? (
                  <span className="ul-region">
                    <i />
                    {u.region}
                  </span>
                ) : null}
              </div>
              <div className="ul-time">{fmtTime(u.testedAt) || "—"}</div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default memo(TestsPage);
