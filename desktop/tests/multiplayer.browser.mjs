// Generated after exploring these flows through headless Playwright MCP.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, realpath, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const desktop=fileURLToPath(new URL('..',import.meta.url));
const root=path.dirname(desktop.replace(/\/$/,''));
const artifacts=path.join(root,'artifacts/multiplayer');
await mkdir(artifacts,{recursive:true});
const server=await createServer({configFile:false,root:desktop,publicDir:path.join(root,'public'),resolve:{dedupe:['react','react-dom','@radix-ui/react-select','@phosphor-icons/react'],alias:{'@agentcloud-tokens':path.join(root,'app/tokens.css')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,await realpath(path.join(root,'node_modules')),await realpath(path.join(desktop,'node_modules'))]}},esbuild:{jsx:'automatic'}});
let browser;
try {
 await server.listen();
 const base=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.addInitScript({path:path.join(desktop,'tests/chat-design.fixture.js')});

 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1440,height:900});
 await page.goto(base);
 await page.evaluate(source=>eval(source), await readFile(path.join(desktop, 'tests/multiplayer.fixture.js'), 'utf8'));
 await page.getByRole('combobox',{name:'Environment',exact:true}).first().click();
 await page.getByRole('option').filter({hasText:'cpu-workspace'}).click();
 await page.getByRole('region',{name:'You · Alex',exact:true}).waitFor();
 const owners=await page.locator('.chat-history-owner h3').allTextContents();
 const input=page.getByRole('textbox',{name:'Message',exact:true});await input.fill('Keep my chat draft');
 await page.getByRole('button',{name:'Agent notifications Open',exact:true}).click();
 await page.getByRole('combobox',{name:'Recipient',exact:true}).click();
 await page.getByRole('option').filter({hasText:'Sam · Review API'}).click();
 await page.getByRole('textbox',{name:'Notification message',exact:true}).fill('Please review the API change');
 await page.getByRole('button',{name:'Send notification',exact:true}).click();
 await page.getByText('Notification recorded for 1 conversation.',{exact:true}).waitFor();
 await page.evaluate(()=>{window.__test.peerMessages[0].status='acknowledged';});
 await page.getByText('Accepted by agent',{exact:true}).waitFor({timeout:10000});
 await page.evaluate(()=>{window.__test.loseNotification=true;});
 await page.getByRole('textbox',{name:'Notification message',exact:true}).fill('Idempotent retry check');
 await page.getByRole('button',{name:'Send notification',exact:true}).click();
 await page.getByRole('button',{name:'Retry notification',exact:true}).click();
 await page.getByRole('button',{name:'Send notification',exact:true}).waitFor();
 const delivery=await page.evaluate(()=>({requests:window.__test.peerRequests.map(x=>x.requestId),count:window.__test.peerMessages.length}));
 if(delivery.count!==2||delivery.requests[1]!==delivery.requests[2])throw Error('Notification retry duplicated');
 await page.getByRole('button',{name:'Agent notifications Hide',exact:true}).click();
 await page.getByRole('button',{name:'Chat + shell',exact:true}).click();
 await page.getByText('Connected · fixture@127.0.0.1:2222',{exact:true}).waitFor(); const initialShell=await page.evaluate(()=>({opens:window.__test.shellOpens.length,closes:window.__test.shellCloses.length}));
 await page.getByRole('button',{name:'Shell',exact:true}).click();
 if(await input.isVisible())throw Error('Shell mode did not hide chat');
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 if(await input.inputValue()!=='Keep my chat draft')throw Error('Lost chat draft');
 await page.getByRole('button',{name:'Chat + shell',exact:true}).click();
 const shell=await page.evaluate(()=>({opens:window.__test.shellOpens.length,closes:window.__test.shellCloses.length}));
 if(shell.opens!==initialShell.opens||shell.closes!==initialShell.closes)throw Error('Shell reconnected on mode change '+JSON.stringify({initialShell,shell}));
 const layouts=[];for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Overflow at '+width);await page.getByRole('button',{name:'Chat',exact:true}).click();if(!await input.isVisible())throw Error('Chat inaccessible');layouts.push(width);}
 await page.getByRole('button',{name:'Shell',exact:true}).click();await page.getByRole('button',{name:'Close terminal',exact:true}).click();
 const closed=await page.evaluate(()=>window.__test.shellCloses.length);if(closed!==initialShell.closes+1)throw Error('Terminal close not forwarded');
 await page.screenshot({path:path.join(artifacts,'multiplayer-1440.png'),fullPage:true});
 if(errors.length)throw Error(errors.join('\n')); console.log('PASS multiplayer identity sections, notification delivery/retry, shell mode lifecycle and responsive views', {owners,delivery,shell,closed,layouts});

} finally {await browser?.close();await server.close();}
