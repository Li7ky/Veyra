function parseWindowsProxySettings(stdout) {
  const text = String(stdout || "");
  const readSz = (name) => {
    const match = text.match(new RegExp("^[ \\t]*" + name + "[ \\t]+REG_SZ[ \\t]*(.*)$", "mi"));
    return match ? match[1].trim() : "";
  };
  const enabled = /^[ \t]*ProxyEnable[ \t]+REG_DWORD[ \t]+0x1\b/im.test(text);
  let pacUrl = readSz("AutoConfigURL");
  if (pacUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(pacUrl)) pacUrl = "";
  return { enabled, server: readSz("ProxyServer"), pacUrl };
}

function isVeyraPacUrl(pacUrl, activePort, savedPacUrl) {
  const value = String(pacUrl || "").trim();
  if (!value) return false;
  if (savedPacUrl && value === String(savedPacUrl).trim()) return true;
  const match = value.match(/^https?:\/\/(127\.0\.0\.1|localhost):(\d+)\//i);
  return !!match && Number(activePort) > 0 && Number(match[2]) === Number(activePort);
}

module.exports = { parseWindowsProxySettings, isVeyraPacUrl };
