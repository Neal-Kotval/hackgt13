import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
const directory=path.resolve(process.env.AGENTCLOUD_DATA_DIR||'.agentcloud/local-backend');
await mkdir(directory,{recursive:true,mode:0o700});
const secretFile=path.join(directory,'.auth-secret');
try{await writeFile(secretFile,randomBytes(48).toString('base64url'),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await chmod(secretFile,0o600);
const secret=(await readFile(secretFile,'utf8')).trim();
if(secret.length<32)throw new Error('Local auth secret is invalid');
const port=Number(process.env.AGENTCLOUD_CODEX_PORT||3002);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port');
const env={...process.env,AGENTCLOUD_DATA_DIR:directory,BETTER_AUTH_SECRET:secret,BETTER_AUTH_URL:`http://127.0.0.1:${port}`,AGENTCLOUD_CODEX_ENABLED:'1',AGENTCLOUD_REMOTE_BACKEND_URL:'',AGENTCLOUD_MAIL_MODE:'local'};
let child,stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;child?.kill(signal);});
function run(args){return new Promise((resolve,reject)=>{child=spawn(process.execPath,args,{env,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0||stopping?resolve():reject(new Error('Local backend exited')));});}
await run(['scripts/auth-setup.mjs']);
if(!stopping)await run(['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(port)]);
