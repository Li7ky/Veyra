const METADATA_REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function shouldRefreshSubscriptionInfo(entry, autoNamed, now = Date.now()) {
  if (!entry || !entry.url) return false;
  // 这里原本还有 `if (hasTraffic && !autoNamed) return false;`。
  // 它的本意是「手动改过名的订阅不要被自动改名」，但改名与否其实由调用方的
  // autoNamed 单独控制（main.cjs 里 headerName 的写入挂在 autoNamed 上），
  // 于是这个提前返回变成了纯粹的功能缺陷：手动改过名的订阅只要有过一次流量数据，
  // 剩余流量 / 到期时间就永远不再刷新（信息一直停在首次获取时的快照）。
  // 刷新信息本身不涉及改名，因此不再看 autoNamed / hasTraffic，只受冷却时间约束。
  const lastCheck = Number(entry.metadataCheckedAt) || 0;
  return now - lastCheck >= METADATA_REFRESH_COOLDOWN_MS;
}

module.exports = { METADATA_REFRESH_COOLDOWN_MS, shouldRefreshSubscriptionInfo };
