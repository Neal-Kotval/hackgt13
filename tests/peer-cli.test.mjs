import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('peer CLI forwards explicit conversation audiences and rejects invalid ones',async()=>{
 const calls=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  calls.push({url:req.url,body:JSON.parse(body)});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({messages:[]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const env={...process.env,AGENTCLOUD_TOKEN:'test-token',AGENTCLOUD_URL:`http://127.0.0.1:${server.address().port}`};
  const base=[new URL('../cli/agentcloud.mjs',import.meta.url).pathname,'peer','project','--agent','agent','--from-session','source','--all','true','--text','Coordinate ports'];
  await exec(process.execPath,[...base,'--audience','conversations'],{env});
  assert.equal(calls[0].url,'/api/agent-peer-messages');assert.equal(calls[0].body.audience,'conversations');
  assert.equal(calls[0].body.broadcast,true);
  await assert.rejects(exec(process.execPath,[...base,'--audience','everyone'],{env}));
  assert.equal(calls.length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
