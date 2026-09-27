import test from "node:test";
import assert from "node:assert/strict";
import { detectDesktopPlatform } from "../lib/desktop-downloads.mjs";

test("Mac Intel UA leaves chip unknown; explicit architecture hints select matching build", () => {
  const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel" };
  assert.equal(detectDesktopPlatform(mac), "mac");
  assert.equal(detectDesktopPlatform({ ...mac, architecture: "arm" }), "mac-arm64");
  assert.equal(detectDesktopPlatform({ ...mac, architecture: "x86" }), "mac-intel");
});
test("OS recommendations preserve unavailable Windows and Linux platforms", () => {
  assert.equal(detectDesktopPlatform({ platform: "Windows" }), "windows");
  assert.equal(detectDesktopPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(detectDesktopPlatform({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64)", platform: "Linux" }), "unknown");
  assert.equal(detectDesktopPlatform(), "unknown");
});
test("mobile and iPad desktop UAs do not recommend a desktop binary", () => {
  assert.equal(detectDesktopPlatform({ platform: "Linux", userAgent: "Android 14" }), "mobile");
  assert.equal(detectDesktopPlatform({ platform: "MacIntel", maxTouchPoints: 5 }), "mobile");
  assert.equal(detectDesktopPlatform({ userAgent: "iPhone" }), "mobile");
  assert.equal(detectDesktopPlatform({ platform: "Windows", mobile: true }), "mobile");
});
