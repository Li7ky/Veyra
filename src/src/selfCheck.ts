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
    value: info ? `${info.platform}/${info.arch} · ${info.electron}` : "读取失败",
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
      // 硬编码 "ok" 会在未安装时也显示通过，用户按「已安装」预期去切换到
      // sing-box 时才失败，自检却没给过任何预警。可选不等于已就绪，用 warn。
      value: b?.installed ? `已安装 ${b.version || ""}`.trim() : "未安装（可选）",
      state: b?.installed ? "ok" : "warn",
      hint: b?.installed ? undefined : "未安装备用内核，无法切换到 sing-box",
      go: b?.installed ? undefined : { section: "core", label: "去「内核」安装" },
    });
  }

  // ── 端口 ─────────────────────────────────────────────────
  if (ports) {
    // 兼容旧主进程：没有 running 字段时退回渲染层已知的运行状态
    const isRunning = ports.running ?? running;
    // 运行中端口本来就该被自家内核占着 —— 不能再把「bind 不上」直接判成
    // 「可能已漂移」：那样只要内核在跑，自检就永远挂两条橙色告警，
    // 真正的漂移反而被噪音淹没。主进程现在会区分 running / drifted，
    // 只有「运行时端口 ≠ 首选端口」才是异常。
    const portItem = (
      id: string,
      label: string,
      port: number,
      free: boolean,
      preferred: number,
      section = "network"
    ): SelfCheckItem => {
      if (free) {
        return { id, label, value: "可用", state: "ok" };
      }
      if (isRunning) {
        if (ports.drifted && port !== preferred) {
          return {
            id,
            label,
            value: `已漂移到 ${port}（首选 ${preferred} 被占用）`,
            state: "warn",
            hint: "内核改用了备用端口；界面与系统代理都跟随实际端口，功能可用，但建议把首选端口改回空闲端口",
            go: { section, label: "去「网络」改端口" },
          };
        }
        return {
          id,
          label,
          value: "由本程序内核占用",
          state: "ok",
        };
      }
      return {
        id,
        label,
        value: "被其它程序占用",
        state: "fail",
        hint: "端口被别的程序占用，内核无法监听",
        go: { section, label: "去「网络」改端口" },
      };
    };

    push(
      portItem(
        "port-mixed",
        `混合端口 ${ports.mixedPort}`,
        ports.mixedPort,
        ports.mixedFree,
        ports.preferredMixedPort ?? ports.mixedPort
      )
    );
    push(
      portItem(
        "port-ctrl",
        `控制端口 ${ports.controllerPort}`,
        ports.controllerPort,
        ports.ctrlFree,
        ports.preferredControllerPort ?? ports.controllerPort
      )
    );
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
  // conflict-guard 会把所有进程命中项强制刷成 "medium"（冲突分级只对端口有效），
  // 所以判 critical/high 恒为假、这个分支永远不可达 —— 检测到别的代理软件在跑
  // 也会静默通过。改为看是否存在进程命中本身，或退一步看 port 级冲突。
  const hasProcWithConflict = procs.length > 0;
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
