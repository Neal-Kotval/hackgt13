import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
const desktop=fileURLToPath(new URL('..',import.meta.url));
const root=path.dirname(desktop.replace(/\/$/,''));
const server=await createServer({configFile:false,root:desktop,publicDir:path.join(root,'public'),resolve:{dedupe:['react','react-dom','@radix-ui/react-select','@phosphor-icons/react'],alias:{'@agentcloud-tokens':path.join(root,'app/tokens.css')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},esbuild:{jsx:'automatic'}});
await server.listen();
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  for (const width of [375,768,1440]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    await page.addInitScript({path:path.join(desktop,'tests/chat-design.fixture.js')});
    await page.addInitScript(()=>{
      let pending={ok:true,target:{projectId:'p1',runBoxId:'box-2',panel:'codex'}};
      window.agentcloudDesktop.takePendingDeepLink=async()=>{const next=pending;pending=null;return next;};
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    const picker=page.getByRole('combobox',{name:'Environment',exact:true}).first();
    await expect(picker).toContainText('second-workspace');
    await page.evaluate(()=>window.__test.deepLink({ok:true,target:{projectId:'p1',runBoxId:'box-failed',panel:'codex'}}));
    await expect(picker).toContainText('failed-box');
    await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
    await page.evaluate(()=>window.__test.deepLink({ok:true,target:{projectId:'p1',runBoxId:'box-1',panel:'codex'}}));
    await expect(picker).toContainText('cpu-workspace');
    await page.evaluate(()=>window.__test.deepLink({ok:true,target:{projectId:'p1',runBoxId:'box-2',panel:'codex'}}));
    await expect(picker).toContainText('second-workspace');
    await page.evaluate(()=>window.__test.deepLink({ok:true,target:{projectId:'p1',runBoxId:'missing-box',panel:'codex'}}));
    await expect(page.getByRole('alert')).toContainText('was not found');
    await expect(picker).toContainText('Choose environment');
    await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.close();
  }
  console.log('Cold startup, warm environment switching, unavailable selection and responsive handoffs passed.');
} finally {await browser.close();await server.close();}
