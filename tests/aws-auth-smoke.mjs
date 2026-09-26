import { chromium } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const base = (process.env.AGENTCLOUD_AUTH_SMOKE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const baseURL = new URL(base);
if (baseURL.protocol !== "https:" && !(baseURL.protocol === "http:" && ["localhost", "127.0.0.1"].includes(baseURL.hostname)))
  throw Error("Auth smoke target must use HTTPS or loopback HTTP");
const mode = process.env.AGENTCLOUD_AUTH_SMOKE_MODE || "signup";
if (!["signup", "signin"].includes(mode)) throw Error("Choose signup or signin smoke mode");
const email = process.env.AGENTCLOUD_AUTH_SMOKE_EMAIL || `smoke-${randomUUID()}@example.test`;
const password = process.env.AGENTCLOUD_AUTH_SMOKE_PASSWORD || randomBytes(24).toString("base64url");
const name = process.env.AGENTCLOUD_AUTH_SMOKE_NAME || "Auth smoke test";
if (mode === "signin" && (!process.env.AGENTCLOUD_AUTH_SMOKE_EMAIL || !process.env.AGENTCLOUD_AUTH_SMOKE_PASSWORD))
  throw Error("Signin mode requires AGENTCLOUD_AUTH_SMOKE_EMAIL and AGENTCLOUD_AUTH_SMOKE_PASSWORD");

let browser;
try {
  // This is a live check of the configured endpoint, not an isolated fixture server.
  const ready = await fetch(`${base}/sign-in`, { signal: AbortSignal.timeout(5000) });
  if (!ready.ok) throw Error("The configured endpoint is not serving the app");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(15000);

  await page.goto(`${base}/projects`);
  await page.waitForURL(`${base}/sign-in`);
  if (mode === "signup") {
    if (base !== "http://127.0.0.1:3000") throw Error("Captured-mail signup smoke requires the local SSM tunnel; use signin mode for other endpoints");
    await page.goto(`${base}/sign-up`);
    await page.getByLabel("Your name").fill(name);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    const signupResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-up/email"));
    await page.getByRole("button", { name: "Create account" }).click();
    if (!(await signupResponse).ok()) throw Error("Signup request failed");
    await page.getByRole("heading", { name: "Check your email" }).waitFor();

    const { stdout } = await execFileAsync(path.resolve("scripts/aws-auth/mail-link.sh"), [email], { timeout: 30000 });
    const verificationURL = stdout.trim();
    const parsed = new URL(verificationURL);
    if (parsed.origin !== base || !parsed.pathname.startsWith("/api/auth/verify-email"))
      throw Error("Captured verification link has an unexpected origin or path");
    await page.goto(verificationURL);
    await page.waitForURL((url) => url.origin === base && url.pathname === "/sign-in" && url.searchParams.get("verified") === "1");
  }

  await page.goto(`${base}/sign-in`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const signinResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (!(await signinResponse).ok()) throw Error("Signin request failed");
  await page.waitForURL(`${base}/organizations`);
  const employee = await page.request.get(`${base}/api/employee`);
  if (!employee.ok() || (await employee.json()).email !== email) throw Error("Authenticated employee identity mismatch");
  await page.reload();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
  if (pageErrors.length) throw Error(`Browser error: ${pageErrors.join("; ")}`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${base}/sign-in`);
  if ((await page.request.get(`${base}/api/employee`)).status() !== 401) throw Error("Session remained valid after signout");
  console.log(`PASS live endpoint auth: ${mode}, verified identity, session refresh, signout`);
} finally {
  await browser?.close();
}
