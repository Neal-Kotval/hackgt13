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
  const owner=await browser.newContext({reducedMotion:'reduce'});
  await owner.addCookies(fixture.users[0].cookie.split('; ').map(c=>{const i=c.indexOf('=');return {name:c.slice(0,i),value:c.slice(i+1),url:base};}));
  const response=await owner.request.post(`${base}/api/state`,{headers:{origin:base},data:{type:'createProject',name:'Overview check',repo:'https://github.com/example/overview',template:'Empty workspace',compute:'Hosted Linux'}});
  expect(response.ok()).toBe(true);const project=await response.json();
  const overview=await owner.newPage();overview.on('pageerror',e=>errors.push(e.message));
  for (const width of [375,768,1440]) {
    await overview.setViewportSize({width,height:900});
    for (const payload of [
      {contentType:'text/html',body:'<html>Sign in</html>'},
      {json:{}},
      {json:{project:{id:project.id}}},
    ]) {
      await overview.route('**/api/projects/*/settings', route => route.fulfill({status:200,...payload}));
      await overview.goto(`${base}/projects/${project.id}/settings`);
      await expect(overview.locator('.project-settings').getByRole('alert')).toContainText('Project settings are unavailable');
      await expect(overview.getByRole('button',{name:'Save changes'})).toHaveCount(0);
      await overview.unroute('**/api/projects/*/settings');
      await overview.getByRole('button',{name:'Try again'}).click();
      await expect(overview.getByRole('heading',{name:'General',exact:true})).toBeVisible();
      await expect(overview.locator('.project-settings').getByRole('alert')).toHaveCount(0);
    }
    expect(await overview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await overview.screenshot({path:`artifacts/settings-recovery-${width}.png`});
    await overview.goto(`${base}/projects/${project.id}`);
    await expect(overview.getByRole('heading',{name:'Agent activity',exact:true})).toBeVisible();
    await expect(overview.locator('.section-heading h2').filter({hasText:'Agent activity'}).locator('.count')).toHaveCount(0);
    await expect(overview.getByRole('heading',{name:'Task progress'})).toHaveCount(0);
    expect(await overview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
  console.log('PASS: HTML and incomplete settings responses show retry, real backend retry recovers, no stale activity badge or Tasks, no browser errors or overflow at 375/768/1440.');
} finally {await browser?.close();await stop();await rm(directory,{recursive:true,force:true});}
