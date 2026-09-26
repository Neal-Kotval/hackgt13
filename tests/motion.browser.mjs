import { chromium, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { prepareAuth } from "./auth-fixture.mjs";
const directory = await mkdtemp("/tmp/agentcloud-motion-");
process.env.AGENTCLOUD_DATA_DIR = directory + "/data";
await writeFile(directory + "/package.json", '{"type":"module"}');
const fixture = await prepareAuth(directory);
const origin = "http://127.0.0.1:3183";
process.env.BETTER_AUTH_URL = origin;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3183"], {env: process.env, stdio: "ignore"});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {if ((await fetch(origin + "/sign-in")).ok) {ready = true; break;}} catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw Error("Motion test server did not start");
  browser = await chromium.launch({channel: "chrome", headless: true});
  for (const reducedMotion of ["no-preference", "reduce"]) {
    for (const width of [375, 768, 1440]) {
      const context = await browser.newContext({viewport: {width, height: 900}, reducedMotion});
      await context.addCookies(fixture.users[0].cookie.split("; ").map(cookie => ({name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: origin})));
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => {
        window.motionEvents = [];
        window.motionDurations = [];
        const nativeAnimate = Element.prototype.animate;
        Element.prototype.animate = function (keyframes, options) {
          window.motionDurations.push(typeof options === "number" ? options : options?.duration);
          return nativeAnimate.call(this, keyframes, options);
        };
        new MutationObserver(records => records.forEach(record => {
          if (record.target instanceof HTMLElement && record.target.hasAttribute("data-motion-active")) window.motionEvents.push(record.target.getAttribute("data-motion-active"));
        })).observe(document, {subtree: true, attributes: true, attributeFilter: ["data-motion-active"]});
      });
      await page.goto(origin + "/organizations");
      await page.getByRole("button", {name: "New organization", exact: true}).click();
      await expect(page.locator("[data-motion-active]")).toHaveCount(0);
      await expect(page.locator(".modal-inner")).not.toHaveAttribute("style", /transform|opacity/);
      await page.keyboard.press("Escape");
      if (width <= 768) {
        await page.getByRole("button", {name: "Open navigation"}).click();
        await page.getByRole("combobox", {name: "Active organization"}).click();
        await page.keyboard.press("Escape");
        await expect(page.locator(".site-sidebar")).toBeVisible();
        await page.keyboard.press("Escape");
      }
      // Isolated DOM specimen protects the toast's CSS centering transform.
      await page.evaluate(() => {const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = "Motion test notification"; document.body.append(toast);});
      await expect(page.locator("[data-motion-active]")).toHaveCount(0);
      await expect(page.locator(".toast")).not.toHaveAttribute("style", /transform|opacity/);
      expect(await page.locator(".toast").evaluate(element => getComputedStyle(element).transform)).not.toBe("none");
      const events = await page.evaluate(() => window.motionEvents);
      if (reducedMotion === "reduce") expect(events).toEqual([]);
      else {
        expect(events).toContain("dialog");
        const durations = await page.evaluate(() => window.motionDurations);
        // Catch CSS time normalization (.42s versus 420ms) making entrances instantaneous.
        expect(durations.length).toBeGreaterThan(0);
        expect(durations.every(duration => duration >= 300 && duration <= 600)).toBeTruthy();
      }
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe(reducedMotion === "reduce" ? "auto" : "smooth");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.locator(".toast").evaluate(element => element.remove());
      if (reducedMotion === "no-preference") {
        await page.getByRole("button", {name: "New organization", exact: true}).click();
        await page.emulateMedia({reducedMotion: "reduce"});
        await expect(page.locator("[data-motion-active]")).toHaveCount(0);
        await expect(page.locator(".modal-inner")).not.toHaveAttribute("style", /transform|opacity/);
      }
      expect(errors).toEqual([]);
      console.log(`PASS ${width}px ${reducedMotion}: entrances, cleanup, centered toast, drawer/dropdown Escape, reduced motion`);
      await context.close();
    }
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) {server.kill(); await new Promise(resolve => server.once("exit", resolve));}
  fixture.getDatabase().close();
  await rm(directory, {recursive: true, force: true});
}
