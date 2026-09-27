"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { Select } from "./ui/select";
import { desktopRelease, detectDesktopPlatform } from "@/lib/desktop-downloads.mjs";

type Platform = ReturnType<typeof detectDesktopPlatform>;
type NavigatorHints = Navigator & { userAgentData?: { platform?: string; mobile?: boolean; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> } };
const messages: Record<Platform, string> = {
  unknown: "Choose your platform below. Only the macOS Apple Silicon build is available today.",
  mobile: "You’re on a mobile device. Open this page on your computer, or choose a platform below.",
  mac: "macOS detected. Choose your Mac’s chip below; your browser does not identify it reliably.",
  "mac-arm64": "Recommended for this Mac: macOS · Apple Silicon.",
  "mac-intel": "macOS · Intel detected. An Intel build is not available yet.",
  windows: "Windows detected. A Windows build is not available yet.",
  linux: "Linux detected. A Linux build is not available yet.",
};

export function DesktopDownloads() {
  const [detected, setDetected] = useState<Platform>("unknown");
  const [selected, setSelected] = useState("");
  const chosen = useRef(false);
  useEffect(() => {
    let active = true;
    const browser = navigator as NavigatorHints;
    const hints = { userAgent: browser.userAgent, platform: browser.userAgentData?.platform || browser.platform, maxTouchPoints: browser.maxTouchPoints, mobile: browser.userAgentData?.mobile };
    const apply = (architecture?: string) => {
      if (!active) return;
      const result = detectDesktopPlatform({ ...hints, architecture });
      setDetected(result);
      if (!chosen.current) setSelected(["mac-arm64", "mac-intel", "windows", "linux"].includes(result) ? result : "");
    };
    apply();
    browser.userAgentData?.getHighEntropyValues?.(["architecture"]).then(values => apply(values.architecture)).catch(() => {});
    return () => { active = false; };
  }, []);

  return <section className="desktop-download-card" aria-labelledby="desktop-download-title">
    <div><p className="desktop-download-eyebrow">Version {desktopRelease.version}</p><h2 id="desktop-download-title">Download alto</h2></div>
    <p role="status">{messages[detected]}</p>
    <div className="desktop-download-choice">
      <label htmlFor="desktop-platform">Choose a platform</label>
      <Select id="desktop-platform" value={selected} onChange={event => { chosen.current = true; setSelected(event.target.value); }}>
        <option value="">Select your computer</option>
        <option value="mac-arm64">macOS · Apple Silicon</option>
        <option value="mac-intel">macOS · Intel — unavailable</option>
        <option value="windows">Windows — unavailable</option>
        <option value="linux">Linux — unavailable</option>
      </Select>
    </div>
    {(detected === "mac" || selected.startsWith("mac")) && <p className="desktop-download-detail">To check your chip, open Apple menu → About This Mac. A chip named Apple M1, M2, or later is Apple Silicon.</p>}
    <div aria-live="polite">
      {selected === "mac-arm64" ? <div className="desktop-download-action"><a className="button primary" href={desktopRelease.macArm64Url}><DownloadSimple aria-hidden="true" />Download for macOS · Apple Silicon</a><p className="desktop-download-detail">DMG · Version {desktopRelease.version} · Includes alto ssh</p></div> : selected ? <p className="desktop-download-unavailable">This build is not available yet. Choose macOS · Apple Silicon only if you have a compatible Mac.</p> : <p className="desktop-download-detail">Select a platform to see its download availability.</p>}
    </div>
    <p className="desktop-download-notice">Development release: ad-hoc signed, not Apple notarized. macOS may block opening the app.</p>
  </section>;
}
