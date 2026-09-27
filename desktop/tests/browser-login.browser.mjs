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
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript({path:path.join(desktop,'tests/chat-design.fixture.js')});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForFunction(()=>Boolean(window.__test?.deepLink));
  await page.evaluate(()=>{
    const api=window.agentcloudDesktop, old=api.fetchHuman;
    window.__test.loginCalls=[];
    window.__test.sessions.find(s=>s.id==='s1').status='auth_required';
    api.onChatGptSignInEvent=()=>()=>{};
    api.startChatGptBrowserSignIn=async()=>{window.__test.loginCalls.push('tunnel:start');return {callbackPort:1455};};
    api.stopChatGptBrowserSignIn=async()=>{window.__test.loginCalls.push('tunnel:stop');};
    api.fetchHuman=async(p,o)=>{
      const body=o?.body?JSON.parse(o.body):null;
      if(body?.action==='login'){window.__test.loginCalls.push(body.method);return {ok:true,status:200,body:JSON.stringify({login:{method:'browser',loginId:'login1',callbackPort:1455,authUrl:'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'}})};}
      if(body?.action==='cancelLogin'){window.__test.loginCalls.push('cancel');return {ok:true,status:200,body:'{}'};}
      return old(p,o);
    };
    window.__test.deepLink({ok:true,target:{projectId:'p1',runBoxId:'box-1',codexSessionId:'s1',panel:'codex-login',serverUrl:'http://127.0.0.1:3000'}});
  });
  await expect(page.getByText(/Finish signing in to ChatGPT/)).toBeVisible();
  for(const width of [375,768,1440]){
    await page.setViewportSize({width,height:900});
    await expect(page.getByRole('button',{name:'Cancel sign-in'})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.getByRole('button',{name:'Cancel sign-in'}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Connect your ChatGPT account'})).toHaveCount(0);
  expect(await page.evaluate(()=>window.__test.loginCalls)).toContain('cancel');
  await page.evaluate(()=>window.__test.deepLink({ok:true,target:{projectId:'p1',runBoxId:'box-1',codexSessionId:'s1',panel:'codex-login'}}));
  await expect(page.getByText(/Finish signing in to ChatGPT/)).toBeVisible();
  await page.evaluate(()=>{window.__test.sessions.find(s=>s.id==='s1').status='ready';});
  await expect(page.getByRole('heading',{name:'Connect your ChatGPT account'})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'Message',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  console.log('Browser login: responsive 375/768/1440, keyboard cancel, retry, success to chat passed; no page errors.');
} finally {await browser.close();await server.close();}
