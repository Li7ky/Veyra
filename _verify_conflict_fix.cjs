/**
 * conflict-guard 误报修复的确定性验证（独立于运行中的应用，不修改用户设置）。
 * 覆盖：
 *   1. 「其它代理软件」检测对真实外部 mihomo.exe 仍能命中（未破坏真阳性）
 *   2. setOwnCorePids 后，自家 mihomo.exe 不再被误报
 *   3. 混合场景：一个自家 + 一个外部 mihomo.exe 时仍报警（不能漏报真外部）
 *   4. 单实例互斥：标记文件 PID == 自身 → 不报；PID == 其他存活进程 → 照报
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const guard = require(path.join(__dirname, "src", "electron", "conflict-guard.cjs"));

const markerPath = path.join(os.tmpdir(), "veyra-omini-id", "instance.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS |", name); }
  else { fail++; console.log("FAIL |", name, extra !== undefined ? "=> " + JSON.stringify(extra) : ""); }
}

async function scanProcs() {
  const { conflicts } = await guard.fullScan({ includeSystem: false });
  return conflicts.map((c) => c.label);
}

async function main() {
  // 备份现有 marker（运行中的应用可能在用）
  let backup = null;
  try { backup = fs.readFileSync(markerPath, "utf8"); } catch {}

  // 造一个名叫 mihomo.exe 的长跑进程（复制 node.exe）
  const dir = path.join(os.tmpdir(), "cg-test");
  fs.mkdirSync(dir, { recursive: true });
  const fake = path.join(dir, "mihomo.exe");
  if (!fs.existsSync(fake)) fs.copyFileSync(process.execPath, fake);
  const child = spawn(fake, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  const ownPid = child.pid;
  await sleep(1200);

  try {
    // 1) 无自家 PID 信息 → 外部 mihomo.exe 被检出
    guard.setOwnCorePids([]);
    let labels = await scanProcs();
    check("外部 mihomo.exe 被检出（真阳性保持）", labels.includes("mihomo (外部)"), labels);

    // 2) 声明该 PID 是自家内核 → 不再误报
    guard.setOwnCorePids([ownPid]);
    labels = await scanProcs();
    check("自家 mihomo.exe 不再被误报", !labels.includes("mihomo (外部)"), labels);

    // 3) 混合：再加一个不属于自家的 mihomo.exe → 必须仍报警
    const child2 = spawn(fake, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    await sleep(900);
    labels = await scanProcs();
    check("自家+外部混合时仍报警（不漏报外部）", labels.includes("mihomo (外部)"), labels);
    child2.kill();

    // 4) 单实例互斥：标记 PID == 自身 → 不报
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ app: "Veyra-omini", pid: process.pid }), "utf8");
    const selfHit = await guard.detectSelfConflict();
    check("标记=自身 PID 时不报单实例冲突", selfHit === null, selfHit);

    // 5) 标记 PID == 另一个存活进程（假内核）→ 照报（真阳性保持）
    fs.writeFileSync(markerPath, JSON.stringify({ app: "Veyra-omini", pid: ownPid }), "utf8");
    const otherHit = await guard.detectSelfConflict();
    check("标记=其他存活进程时照报", !!otherHit, otherHit);

    // 6) 标记 PID 已死 → 视为过期，清理并不报
    fs.writeFileSync(markerPath, JSON.stringify({ app: "Veyra-omini", pid: 999999 }), "utf8");
    const staleHit = await guard.detectSelfConflict();
    check("标记 PID 已退出的过期清理", staleHit === null, staleHit);
  } finally {
    // 还原 marker 与清理
    try {
      if (backup !== null) fs.writeFileSync(markerPath, backup, "utf8");
      else fs.rmSync(markerPath, { force: true });
    } catch {}
    child.kill();
    try { fs.rmSync(fake, { force: true }); } catch {}
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
