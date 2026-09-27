export const desktopRelease = {
  version: "0.1.1",
  macArm64Url: "https://github.com/Neal-Kotval/hackgt13/releases/download/desktop-v0.1.1/alto-0.1.1-macos-arm64.dmg",
};

/** Browser platform hints can identify an OS; a legacy Mac Intel UA cannot identify its chip.
 * @param {{userAgent?: string, platform?: string, maxTouchPoints?: number, architecture?: string, mobile?: boolean}} hints
 */
export function detectDesktopPlatform(hints = {}) {
  const ua = hints.userAgent || "";
  const platform = hints.platform || "";
  if (hints.mobile || /Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && (hints.maxTouchPoints || 0) > 1)) return "mobile";
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    if (/^(arm|arm64|aarch64)$/i.test(hints.architecture || "")) return "mac-arm64";
    if (/^(x86|x86_64|x64)$/i.test(hints.architecture || "")) return "mac-intel";
    return "mac";
  }
  if (/Windows|Win32|Win64/i.test(`${platform} ${ua}`)) return "windows";
  if (/CrOS/i.test(ua)) return "unknown";
  if (/Linux/i.test(`${platform} ${ua}`)) return "linux";
  return "unknown";
}
