import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const base=process.env.DESKTOP_TEST_URL||'http://127.0.0.1:5174';
const fixture=await readFile(new URL('./chat-design.fixture.js',import.meta.url),'utf8');
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  for(const width of [375,768,1440]) {
    const context=await browser.newContext({viewport:{width,height:1000}});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript({content:fixture+`;(() => {
      const original=window.agentcloudDesktop.listRunBoxes;
      window.agentcloudDesktop.listRunBoxes=async id=>window.__test.allStopped
        ? [{id:'stopped-only',projectId:id,state:'stopped',profileId:'Stopped example'}]
        : [...await original(id),{id:'stopped-example',projectId:id,state:'stopped',profileId:'Stopped example'},{id:'stopping-example',projectId:id,state:'stopping',profileId:'Stopping example'}];
      window.__motionCount=0;
      new MutationObserver(records=>{window.__motionCount+=records.filter(r=>r.type==='attributes'&&r.attributeName==='data-motion-active'&&r.target.hasAttribute('data-motion-active')).length;}).observe(document,{subtree:true,attributes:true,attributeFilter:['data-motion-active']});
    })();`});
    await page.goto(base);
    async function navigation(label){const button=page.getByRole('button',{name:label,exact:true});if(!await button.isVisible())await page.getByRole('button',{name:'Open navigation',exact:true}).click();await button.click();}
    async function select(name,label){await page.getByRole('combobox',{name,exact:true}).first().click();await page.getByRole('option').filter({hasText:label}).click();}
    async function settled(){await expect(page.locator('[data-motion-active]')).toHaveCount(0);}
    await select('Environment','cpu-workspace');await settled();
    const input=page.getByRole('textbox',{name:'Message',exact:true});await input.fill('Keep this draft');
    const before=await page.evaluate(()=>window.__motionCount);
    await navigation('Environments');await expect(page.getByRole('switch',{name:'Hide stopped environments'})).toHaveAttribute('aria-checked','true');await settled();
    expect(await page.evaluate(()=>window.__motionCount)).toBeGreaterThan(before);
    await expect(page.getByText(/1 stopped hidden/)).toBeVisible();
    await expect(page.getByRole('list',{name:'Environments'})).not.toContainText('Stopped example');
    await expect(page.getByRole('list',{name:'Environments'})).toContainText('Stopping example');
    await expect(page.getByRole('list',{name:'Environments'})).toContainText('failed-box');
    await page.getByRole('switch',{name:'Hide stopped environments'}).press('Space');
    await expect(page.getByRole('list',{name:'Environments'})).toContainText('Stopped example');
    await navigation('Project chat');await expect(input).toHaveValue('Keep this draft');await settled();
    const count=await page.evaluate(()=>window.__motionCount);
    await page.evaluate(()=>window.__test.events.s1.push({id:'streamed',kind:'assistant',text:'Live response',updatedAt:new Date().toISOString()}));
    await expect(page.getByText('Live response',{exact:true})).toBeVisible();await settled();
    expect(await page.evaluate(()=>window.__motionCount)).toBe(count);
    const otherChat=page.locator('.chat-history-item').nth(1);
    if(!await otherChat.isVisible())await page.getByRole('button',{name:'Open navigation',exact:true}).click();
    await otherChat.click();await settled();
    expect(await page.evaluate(()=>window.__motionCount)).toBeGreaterThan(count);
    await select('Environment','second-workspace');await settled();
    expect(await page.evaluate(()=>window.__motionCount)).toBeGreaterThan(count);
    await select('Project','Second project');await settled();
    await navigation('Environments');await select('Project','Second project');await settled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.reload();await navigation('Environments');await expect(page.getByRole('switch',{name:'Hide stopped environments'})).toHaveAttribute('aria-checked','false');
    await page.evaluate(()=>window.__test.allStopped=true);await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('switch',{name:'Hide stopped environments'}).click();await expect(page.getByText('No environments available',{exact:true})).toBeVisible();
    await page.getByRole('switch',{name:'Hide stopped environments'}).click();await expect(page.getByRole('list',{name:'Environments'})).toContainText('Stopped example');
    await page.emulateMedia({reducedMotion:'reduce'});await navigation('Project chat');await expect(page.locator('[data-motion-active]')).toHaveCount(0);await navigation('Environments');await expect(page.locator('[data-motion-active]')).toHaveCount(0);
    expect(errors).toEqual([]);await context.close();
  }
  console.log('Desktop navigation motion, preserved draft, no stream animation, reduced motion, responsive layouts and stopped filter persistence passed at 375/768/1440.');
}finally{await browser.close();}
