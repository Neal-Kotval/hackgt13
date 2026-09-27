// Isolated test transport only. Never loaded by production.
(() => {
  if (!window.__test) return;
  const test=window.__test, api=window.agentcloudDesktop;
  const base=api.fetchHuman;
  Object.assign(test.sessions.find(s=>s.id==='s1'),{createdBy:'test',createdByName:'Alex',title:'API implementation',isSetupSession:false});
  Object.assign(test.sessions.find(s=>s.id==='s2'),{createdBy:'sam',createdByName:'Sam',title:'Review API',isSetupSession:false});
  test.sessions.push({...test.sessions.find(s=>s.id==='s2'),id:'s4',createdBy:'sam-two',createdByName:'Sam',title:'Build client'});
  test.events.s4=[];
  test.peerMessages=[];test.peerRequests=[];test.shellOpens=[];test.shellCloses=[];test.shellWrites=[];
  const reply=body=>({ok:true,status:200,body:JSON.stringify(body)});
  api.fetchHuman=async(path,options)=>{
    const url=new URL(path,'http://localhost');
    if(!url.pathname.endsWith('/peer-messages')) return base(path,options);
    const sessionId=url.pathname.split('/').at(-2);
    if(!options) return reply({messages:test.peerMessages.filter(m=>m.fromSessionId===sessionId||m.toSessionId===sessionId).map(m=>({...m,direction:m.fromSessionId===sessionId?'outgoing':'incoming'})),nextBeforeSequence:null});
    const body=JSON.parse(options.body);test.peerRequests.push({sessionId,...body});
    const recipients=body.broadcast?test.sessions.filter(s=>s.id!==sessionId&&s.target?.runBoxId==='box-1'&&s.projectId==='p1'&&s.isSetupSession===false).map(s=>s.id):[body.toSessionId];
    const messages=recipients.map(toSessionId=>{
      const prior=test.peerMessages.find(m=>m.fromSessionId===sessionId&&m.toSessionId===toSessionId&&m.requestId===body.requestId);
      if(prior)return prior;
      const message={id:`n${test.peerMessages.length+1}`,sequence:test.peerMessages.length+1,requestId:body.requestId,fromSessionId:sessionId,toSessionId,text:body.text,status:'queued',actorId:'test',actorName:'Alex',createdAt:new Date().toISOString(),deliveredAt:null,acknowledgedAt:null};test.peerMessages.push(message);return message;
    });
    if(test.loseNotification){test.loseNotification=false;throw Error('Test lost notification response');}
    return reply(body.broadcast?{messages}:{message:messages[0]});
  };
  const listeners=new Set();
  api.onTerminalEvent=callback=>{listeners.add(callback);return()=>listeners.delete(callback);};
  api.terminalOpen=async(sessionId,runBoxId)=>{test.shellOpens.push({sessionId,runBoxId});return {host:'127.0.0.1',port:2222,username:'fixture'};};
  api.terminalWrite=(sessionId,data)=>{test.shellWrites.push({sessionId,data});for(const callback of listeners)callback({type:'data',sessionId,data});};
  api.terminalClose=async sessionId=>{test.shellCloses.push(sessionId);};
})();
