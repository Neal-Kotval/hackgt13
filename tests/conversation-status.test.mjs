import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexSessionService } from '../lib/codex-sessions.mjs';
import { projectChatRuns } from '../lib/chat-runs.mjs';

test('manual conversation status persists independently of execution and records attribution', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'conversation-status-'));
  let db=new Database(path.join(dir,'test.db'));
  const create=()=>createCodexSessionService({db,dataDir:dir,sweepMs:0,runtimeFactory:()=>{throw Error('unexpected model connection');}});
  let service=create();
  try {
    const stamp=new Date().toISOString();
    db.prepare('INSERT INTO codex_session(id,project_id,agent_id,created_by,status,created_at,updated_at,run_box_id) VALUES(?,?,?,?,?,?,?,?)').run('chat','project','agent','owner','stopped',stamp,stamp,'box');
    assert.equal(service.get('chat').workflowStatus,'todo');
    assert.equal(service.get('chat').workflowUpdatedAt,null);
    const actor={id:'employee',name:'Sam'};
    for(const status of ['in_progress','needs_attention','done','todo']) {
      const result=service.setConversationStatus('chat',{projectId:'project',status,actor});
      assert.equal(result.workflowStatus,status);
      assert.equal(result.workflowUpdatedBy,'Sam');
    }
    const previous=service.get('chat');
    service.setConversationStatus('chat',{projectId:'project',status:'todo',actor});
    assert.equal(service.get('chat').workflowUpdatedAt,previous.workflowUpdatedAt,'no-op retains attribution');
    assert.equal(service.get('chat').status,'stopped');
    assert.equal(service.get('chat').updatedAt,stamp,'model timestamp stays unchanged');
    assert.deepEqual(service.snapshot('chat').events,[]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM codex_conversation_status_change').get().count,4);
    const last=db.prepare('SELECT * FROM codex_conversation_status_change ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(last.previous_status,'done');assert.equal(last.status,'todo');assert.equal(last.actor_id,'employee');
    service.setConversationStatus('chat',{projectId:'project',status:'done',actor});
    service.close();db.close();db=new Database(path.join(dir,'test.db'));service=create();
    assert.equal(service.get('chat').workflowStatus,'done');
    assert.equal(service.get('chat').workflowUpdatedBy,'Sam');
    const projected=projectChatRuns({session:service.get('chat'),events:[{id:'message',kind:'user',text:'Do work',createdAt:stamp}]});
    assert.equal(projected[0].workflowStatus,'done');assert.equal(projected[0].status,'unknown');
    assert.throws(()=>service.setConversationStatus('chat',{projectId:'other',status:'todo',actor}),e=>e.status===404);
    assert.throws(()=>service.setConversationStatus('chat',{projectId:'project',status:'completed',actor}),e=>e.status===400);
    assert.equal(service.get('chat').workflowStatus,'done');
  } finally {service.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
