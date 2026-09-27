import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupChatConversations } from '../lib/chat-conversations.ts';
const run = (id, sessionId, startedAt, status = 'completed') => ({id, sessionId, projectId:'p',runBoxId:'box',prompt:id,status,startedAt,finishedAt:null,actorName:'Person',environment:null,events:[]});
test('follow-ups update one stable conversation without mixing other chats on the same box', () => {
  const first=run('first','chat','2026-01-01');
  const followup=run('followup','chat','2026-01-03','running');
  const other=run('other','other-chat','2026-01-02');
  const result=groupChatConversations([followup, other, first]);
  assert.equal(result.length,2);
  assert.equal(result[0].id,'chat');
  assert.equal(result[0].title,'first');
  assert.equal(result[0].prompt,'followup');
  assert.equal(result[0].status,'running');
  assert.deepEqual(result[0].requests.map(r=>r.id),['first','followup']);
  assert.equal(groupChatConversations([first])[0].id,result[0].id);
  assert.equal(first.status,'completed');
});
test('latest response activity sorts conversations and empty history stays empty', () => {
  const a=run('first','chat','2026-01-01');
  a.events=[{id:'reply',kind:'assistant',text:'Done',createdAt:'2026-01-04'}];
  assert.equal(groupChatConversations([run('other','other-chat','2026-01-03'),a])[0].id,'chat');
  assert.deepEqual(groupChatConversations([]),[]);
});

test('manual conversation status defaults to todo and stays independent of model outcomes', () => {
  const first=run('first','chat','2026-01-01','completed');
  assert.equal(groupChatConversations([first])[0].workflowStatus,'todo');
  first.workflowStatus='in_progress';
  const next={...first,id:'next',startedAt:'2026-01-02',status:'failed'};
  const conversation=groupChatConversations([first,next])[0];
  assert.equal(conversation.workflowStatus,'in_progress');
  assert.equal(conversation.status,'failed');
});
