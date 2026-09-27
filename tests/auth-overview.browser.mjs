import { chromium, expect } from "@playwright/test";
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
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3124";
let server;
const start = async () => {
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3124",
    ],
    { env: process.env, stdio: "ignore" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3124/sign-in")).ok) return;
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
const base='http://127.0.0.1:3124';
try {
  await start();
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/sign-in`);
  const resend=page.getByRole('button',{name:'Resend confirmation',exact:true});
  await expect(resend).toHaveCount(0);
  await page.getByLabel('Email',{exact:true}).fill('confirmation@example.test');
  await expect(resend).toHaveCount(0);
  await page.getByRole('link',{name:'Create an account',exact:true}).click();
  await page.getByLabel('Your name').fill('Confirmation Test');
  await page.getByLabel('Email',{exact:true}).fill('confirmation@example.test');
  await page.getByLabel('Password',{exact:true}).fill(fixture.password);
  await expect(resend).toHaveCount(0);
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Check your email'})).toBeVisible();
  await expect(resend).toBeVisible();
  await page.getByRole('link',{name:'Back to sign in'}).click();
  await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  await expect(page.getByLabel('Email',{exact:true})).toHaveValue('confirmation@example.test');
  for (const width of [375,768,1440]) {
    await page.setViewportSize({width,height:900});
    const left=await resend.boundingBox();const right=await page.getByRole('link',{name:'Create an account',exact:true}).boundingBox();
    expect(left.x+left.width).toBeLessThanOrEqual(right.x);
    expect(Math.abs((left.y+left.height/2)-(right.y+right.height/2))).toBeLessThan(2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await resend.focus();await page.keyboard.press('Tab');
    await expect(page.getByRole('link',{name:'Create an account',exact:true})).toBeFocused();
    await page.screenshot({path:`artifacts/auth-confirmation-${width}.png`});
  }
  await page.getByLabel('Email',{exact:true}).fill('another@example.test');await expect(resend).toHaveCount(0);
  await page.getByLabel('Email',{exact:true}).fill('confirmation@example.test');await expect(resend).toBeVisible();
  await page.reload();await expect(resend).toBeVisible();
  await page.route('**/api/auth/send-verification-email',route=>route.fulfill({status:429,json:{code:'TOO_MANY_REQUESTS',message:'Wait'}}));
  await resend.click();await expect(page.locator('.auth-panel').getByRole('alert')).toContainText('Could not send');
  await page.unroute('**/api/auth/send-verification-email');await resend.click();
  await expect(page.getByRole('status')).toContainText('confirmation email is on its way');
  await page.goto(`${base}/sign-in?verified=1`);await expect(resend).toHaveCount(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('alto:pending-email-confirmation'))).toBeNull();
  await page.getByLabel('Email',{exact:true}).fill('confirmation@example.test');
  await page.getByLabel('Password',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const initial=page.getByRole('button',{name:'Send confirmation email',exact:true});
  await expect(initial).toBeVisible();await expect(resend).toHaveCount(0);
  await initial.click();await expect(resend).toBeVisible();
  await page.evaluate(()=>sessionStorage.clear());
  await page.goto(`${base}/sign-in?error=TOKEN_EXPIRED&invite=test-invite`);
  await page.getByLabel('Email',{exact:true}).fill('confirmation@example.test');
  await expect(initial).toBeVisible();await expect(resend).toHaveCount(0);
  await initial.click();await expect(resend).toBeVisible();
  await expect(page.getByRole('link',{name:'Create an account',exact:true})).toHaveAttribute('href','/sign-up?invite=test-invite');
  const owner=await browser.newContext({reducedMotion:'reduce'});
  await owner.addCookies(fixture.users[0].cookie.split('; ').map(c=>{const i=c.indexOf('=');return {name:c.slice(0,i),value:c.slice(i+1),url:base};}));
  const response=await owner.request.post(`${base}/api/state`,{headers:{origin:base},data:{type:'createProject',name:'Overview check',repo:'https://github.com/example/overview',template:'Empty workspace',compute:'Hosted Linux'}});
  expect(response.ok()).toBe(true);const project=await response.json();
  const overview=await owner.newPage();overview.on('pageerror',e=>errors.push(e.message));
  for(const width of [375,768,1440]) {
    await overview.setViewportSize({width,height:900});await overview.goto(`${base}/projects/${project.id}`);
    await expect(overview.getByRole('heading',{name:'Task progress'})).toHaveCount(0);
    await expect(overview.getByText('No tasks yet',{exact:true})).toHaveCount(0);
    await expect(overview.getByRole('heading',{name:/Agent activity/})).toBeVisible();
    await expect(overview.getByRole('heading',{name:'Environments',exact:true})).toBeVisible();
    expect(await overview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await overview.screenshot({path:`artifacts/overview-without-tasks-${width}.png`});
  }
  expect(errors).toEqual([]);
  console.log('PASS: confirmation gating, email scope, navigation persistence, left/right placement, keyboard order, resend failure/recovery, expired links, and Overview without Tasks at 375/768/1440.');
} finally {await browser?.close();await stop();await rm(directory,{recursive:true,force:true});}
