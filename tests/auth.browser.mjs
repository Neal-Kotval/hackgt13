import { chromium } from "@playwright/test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { prepareAuth } from "./auth-fixture.mjs";
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-browser-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const fixture = await prepareAuth(directory);
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
let server;
const start = async () => {
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ],
    { env: process.env, stdio: "ignore" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3100/sign-in")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Server did not start");
};
const stop = async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGKILL");
    await new Promise((r) => server.once("exit", r));
  }
};
let browser;
try {
  await start();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const width of [375, 768, 1440]) {
    if (width !== 375) {
      await stop();
      await start();
    }
    for (const [index, user] of fixture.users.entries()) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("http://127.0.0.1:3100/projects");
      await page.waitForURL("**/sign-in");
      await page.getByLabel("Email", { exact: true }).focus();
      await page.keyboard.press("Tab");
      if (await page.locator(":focus").getAttribute("id") !== "password")
        throw Error("Password is not keyboard reachable");
      await page.keyboard.press("Tab");
      if (await page.locator(":focus").textContent() !== "Sign in")
        throw Error("Submit is not keyboard reachable");
      await page.getByLabel("Email", { exact: true }).fill(user.email);
      await page.getByLabel("Password", { exact: true }).fill(fixture.password);
      const loginResponse = page.waitForResponse((r) =>
        r.url().endsWith("/api/auth/sign-in/email"),
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      if ((await loginResponse).status() !== 200)
        throw Error("Sign-in HTTP request failed");
      await page.waitForURL("**/organizations");
      await page.getByRole("button", { name: "Switch to Test organization", exact: true }).click();
      await page.getByText("Active organization changed.").waitFor();
      await page.getByRole("link", { name: "Open projects", exact: true }).click();
      await page.waitForURL("**/projects");
      await page.reload();
      await page.getByRole("button", { name: "Sign out" }).waitFor({ state: "attached" });
      // Session refetches must not crash the dashboard if user data is absent.
      await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: {} }));
      await page.reload();
      await page.locator(".local-label").filter({ hasText: /^employee$/ }).waitFor({ state: "attached" });
      if (pageErrors.length) throw Error(pageErrors.join("; "));
      await page.unroute("**/api/auth/get-session**");
      await page.reload();
      await page.locator(".local-label").filter({ hasText: user.email }).waitFor({ state: "attached" });
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        )
      )
        throw Error("Dashboard horizontal overflow");
      if (width === 375 && index === 0) {
        await stop();
        await start();
        await page.reload();
        await page.getByRole("button", { name: "Sign out" }).waitFor({ state: "attached" });
      }
      const employee = await page.request.get(
        "http://127.0.0.1:3100/api/employee",
      );
      if ((await employee.json()).id !== user.id)
        throw Error("Identity mismatch");
      if (width <= 768) await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForURL("**/sign-in");
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        )
      )
        throw Error("Horizontal overflow");
      await page.screenshot({ path: `artifacts/auth-${width}-${index}.png` });
      await page.goto("http://127.0.0.1:3100/projects");
      await page.waitForURL("**/sign-in");
      console.log(
        `PASS employee ${index + 1}, ${width}px: redirect, login, refresh, identity, logout, no sign-in overflow`,
      );
      await context.close();
    }
  }
  console.log("PASS server restart retained authenticated browser session");
} finally {
  await browser?.close();
  await stop();
  fixture.getDatabase().close();
  await rm(directory, { recursive: true, force: true });
}
