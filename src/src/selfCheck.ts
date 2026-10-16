/**
 * 环境自检 —— 把「这台电脑现在能不能正常跑起来」拆成一组可判定的小项。
 *
 * 数据来源基本是主进程已有的 IPC；唯一新增的是 `system:checkPorts`：
 * `fullConflictScan` 只扫一份「已知代理端口」清单、而且会主动跳过自身端口，
 * 所以它测不出「用户把端口改成 7890 后被别的软件占了」这类问题——
 * 而端口能不能绑上恰恰是「能否正常运行」最关键的一条。
 */

export type SelfCheckState = "ok" | "warn" | "fail";

export type SelfCheckItem = {
  id: string;
  label: string;
  value: string;
  state: SelfCheckState;
  /** 非 ok 时给出的排查建议 */
  hint?: string;
  /** 处置入口：跳转到能修这个问题的设置分区 */
  go?: { section: string; label: string };
};

export type SelfCheckResult = {
  items: SelfCheckItem[];
  fail: number;
  warn: number;
};

type Conflict = { type: string; label: string; severity?: string; port?: number; proc?: string };

/** 把可选 / 可能抛错的 IPC 统一收敛成「成功返回值 或 null」 */
function safe<T>(p: Promise<T> | undefined | null): Promise<T | null> {
  return p ? p.catch(() => null) : Promise.resolve(null);
}

export async function runSelfCheck(running: boolean): Promise<SelfCheckResult> {
  const api = window.veyra;
  if (!api) throw new Error("未连接到主进程");

  const [info, vc, cores, sysProxy, profiles, scan, ports] = await Promise.all([
    safe(api.appInfo()),
    safe(api.vcRuntime?.()),
    safe(api.coreList()),
    safe(api.systemProxyStatus()),
    safe(api.listProfilesRich?.()),
    safe(api.fullConflictScan?.()),
    safe(api.checkPorts?.()),
  ]);

  const conflicts: Conflict[] = scan?.conflicts ?? [];
  const of = (t: string) => conflicts.filter((c) => c.type === t);
  const items: SelfCheckItem[] = [];
  const push = (it: SelfCheckItem) => items.push(it);

  // ── 运行环境 ──────────────────────────────────────────────
  push({
    id: "platform",
    label: "运行平台",
    value: info ? `${info.platform}/${info.arch} · Electron ${info.electron}` : "读取失败",
    state: info ? "ok" : "warn",
  });

  if (vc) {
    push({
      id: "vcrt",
      label: "VC++ 运行库",
      value: vc.installed ? "已安装" : "未安装",
      state: vc.installed ? "ok" : "fail",
      hint: vc.installed
        ? undefined
        : "Mihomo 内核依赖 vcruntime140.dll，缺失时内核会直接启动失败",
      go: vc.installed ? undefined : { section: "about", label: "去「关于」下载" },
    });
  }

  // ── 内核 ─────────────────────────────────────────────────
  if (cores) {
    const active = cores.active === "singbox" ? "singbox" : "mihomo";
    const alt = active === "mihomo" ? "singbox" : "mihomo";
    const nameOf = (k: string) => (k === "singbox" ? "sing-box" : "Mihomo");
    const a = cores[active as "mihomo" | "singbox"];
    const b = cores[alt as "mihomo" | "singbox"];

    push({
      id: "core-active",
      label: `当前内核 · ${nameOf(active)}`,
      value: a?.installed ? `已安装 ${a.version || ""}`.trim() : "未安装",
      state: a?.installed ? "ok" : "fail",
      hint: a?.installed ? undefined : "未安装内核无法启动代理服务",
      go: a?.installed ? undefined : { section: "core", label: "去「内核」安装" },
    });
    push({
      id: "core-alt",
      label: `备用内核 · ${nameOf(alt)}`,
      value: b?.installed ? `已安装 ${b.version || ""}`.trim() : "未安装（可选）",
      state: "ok",
    });
  }

  // ── 端口 ─────────────────────────────────────────────────
  if (ports) {
    // 内核在运行时，这两个端口本来就该被自己占着，不算冲突
    const mixedOk = running || ports.mixedFree;
    push({
      id: "port-mixed",
      label: `混合端口 ${ports.mixedPort}`,
      value: running ? "由本程序内核占用" : ports.mixedFree ? "可用" : "被其它程序占用",
      state: mixedOk ? "ok" : "fail",
      hint: mixedOk ? undefined : "端口被别的程序占用，内核无法监听",
      go: mixedOk ? undefined : { section: "network", label: "去「网络」改端口" },
    });
    const ctrlOk = running || ports.ctrlFree;
    push({
      id: "port-ctrl",
      label: `控制端口 ${ports.controllerPort}`,
      value: running ? "由本程序内核占用" : ports.ctrlFree ? "可用" : "被其它程序占用",
      state: ctrlOk ? "ok" : "fail",
      hint: ctrlOk ? undefined : "控制端口被占用时读不到内核状态和节点列表",
      go: ctrlOk ? undefined : { section: "network", label: "去「网络」改端口" },
    });
  }

  // ── 冲突（来自 fullConflictScan） ─────────────────────────
  const sysp = of("system-proxy");
  push({
    id: "sysproxy",
    label: "系统代理",
    value: sysp.length
      ? sysp[0].label
      : sysProxy?.enabled
        ? `已开启 → ${sysProxy.server || "本机"}`
        : "未被占用",
    state: sysp.length ? "warn" : "ok",
    hint: sysp.length ? "其它软件正在接管系统代理，两边同时开启会互相覆盖" : undefined,
    go: sysp.length ? { section: "system", label: "去「系统」查看" } : undefined,
  });

  const procs = of("process");
  // 仅当严重度为 critical/high 或存在 port 级别冲突时才算 warn，medium 级别（仅进程存在、无端口冲突）为 ok
  const hasProcWithConflict = procs.length > 0 && procs.some((c) => c.severity === "critical" || c.severity === "high");
  const hasPort = of("port").length > 0;
  const procState: SelfCheckState = hasProcWithConflict || (procs.length > 0 && hasPort) ? "warn" : "ok";
  push({
    id: "process",
    label: "其它代理软件",
    value: procs.length
      ? (procState === "warn"
          ? procs.map((c) => c.label).join("、") + "（有端口冲突风险）"
          : procs.map((c) => c.label).join("、") + "（进程存在，端口未冲突）")
      : "未检测到",
    state: procState,
    hint: procState === "warn"
      ? "其它代理软件正在占用端口，请关闭避免冲突"
      : (procs.length ? "检测到其它代理软件但端口未冲突，可和平共处" : undefined),
    go: procState === "warn" ? { section: "system", label: "去「系统」设置互斥" } : undefined,
  });

  const dns = of("dns");
  push({
    id: "dns",
    label: "本地 DNS（53）",
    value: dns.length ? "被占用" : "正常",
    state: dns.length ? "warn" : "ok",
    hint: dns.length ? "127.0.0.1:53 被占用时域名解析可能异常" : undefined,
  });

  const route = of("route");
  push({
    id: "route",
    label: "默认路由",
    value: route.length ? route[0].label : "正常",
    state: route.length ? "warn" : "ok",
    hint: route.length ? "检测到疑似 VPN 隧道，开启 TUN 时可能互相抢占路由" : undefined,
  });

  const selfHit = of("self");
  push({
    id: "self",
    label: "单实例互斥",
    value: selfHit.length ? selfHit[0].label : "正常",
    state: selfHit.length ? "warn" : "ok",
    hint: selfHit.length ? "已有另一个实例在运行，重复启动会导致端口争抢" : undefined,
  });

  // ── 配置 ─────────────────────────────────────────────────
  if (profiles) {
    const usable = profiles.filter((p) => p.enabled && (p.type === "remote" || p.type === "local"));
    push({
      id: "profile",
      label: "可用配置文件",
      value: usable.length ? `${usable.length} 个` : "无",
    state: usable.length ? "ok" : "warn",
    hint: usable.length ? undefined : "没有可用配置时内核即使启动也连不出去，请先到「订阅」导入",
  });  }

  return {
    items,
    fail: items.filter((i) => i.state === "fail").length,
    warn: items.filter((i) => i.state === "warn").length,
  };
}
