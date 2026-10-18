const METADATA_REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function shouldRefreshSubscriptionInfo(entry, autoNamed, now = Date.now()) {
  if (!entry || !entry.url) return false;
  const hasTraffic = entry.userinfo && Number(entry.userinfo.total) > 0;
  if (hasTraffic && !autoNamed) return false;
  const lastCheck = Number(entry.metadataCheckedAt) || 0;
  return now - lastCheck >= METADATA_REFRESH_COOLDOWN_MS;
}

module.exports = { METADATA_REFRESH_COOLDOWN_MS, shouldRefreshSubscriptionInfo };
