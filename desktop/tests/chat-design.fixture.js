// Isolated renderer verification fixture. Never imported by application code.
(() => {
  const now = new Date().toISOString();
  const sessions = [{id:'s1',projectId:'p1',agentId:'a1',status:'ready',error:null,updatedAt:now},{id:'s2',projectId:'p1',agentId:'a2',status:'ready',error:null,updatedAt:new Date(Date.now()-86400000).toISOString()},{id:'s3',projectId:'p2',agentId:'a3',status:'ready',error:null,updatedAt:now}];
  for (const item of sessions) item.target = { kind: 'runBox', runBoxId: 'box-1', provider: 'docker-local', profileId: 'cpu-workspace', state: 'ready' };
  sessions.unshift({ id: 'legacy', projectId: 'p1', agentId: 'old', status: 'ready', error: null });
  const state={projects:[{id:'p1',name:'UI verification',agents:[{id:'a1',name:'desktop-chat',client:'codex'},{id:'a2',name:'review-agent'}],tasks:[],resources:[],resourceRequests:[]},{id:'p2',name:'Second project',agents:[{id:'a3',name:'build-agent'}],tasks:[],resources:[],resourceRequests:[]}]};
  const event=(id,kind,text)=>({id,kind,text,updatedAt:now});
  const events={s1:[event('setup','status','Codex is ready in the environment.')],s2:[],s3:[]};
  if (location.search.includes("no-projects")) state.projects = [];
  if (location.search.includes("new-environment")) sessions.splice(0, sessions.length);
  const test=window.__test={sessions,events,state,sends:[],fail:false,loseResponse:false,deepLink:null};
  const response=body=>({ok:true,status:200,body:JSON.stringify(body)});
  window.agentcloudDesktop={
    authStatus:async()=>({signedIn:true,baseUrl:'http://127.0.0.1:3000',user:{id:'test',name:'UI test',email:'test@example.invalid'},secureStorage:true}),
    signOut:async()=>({signedIn:false,baseUrl:'http://127.0.0.1:3000',secureStorage:true}),
    onDeepLink:cb=>{test.deepLink=cb;return ()=>{}},takePendingDeepLink:async()=>null,
    getState:async()=>structuredClone(state),
    listRunBoxes:async projectId=>[{id:'box-1',projectId,provider:'docker-local',profileId:'cpu-workspace',state:'ready',rawState:'ready',ssh:{host:'127.0.0.1',port:2222,username:'test'},stopRequested:false,codex:{state:'ready',reason:null}},{id:'box-failed',projectId,profileId:'failed-box',state:'failed',ssh:null}],
    openChatGptSignIn:async url=>{test.openedUrl=url;},
    fetchHuman:async(path,options)=>{
      const url=new URL(path,'http://localhost');
      if(url.pathname==='/api/codex-sessions' && options){const body=JSON.parse(options.body);test.created=body;if(!body.runBoxId)throw Error('Creation requires an environment');const session={id:'remote-created',projectId:body.projectId,agentId:body.agentId,status:'auth_required',error:null,target:{kind:'runBox',runBoxId:body.runBoxId,provider:'docker-local',profileId:'cpu-workspace',state:'ready'}};sessions.push(session);events[session.id]=[];return response({session});}
      if(url.pathname==='/api/codex-sessions')return response({enabled:true,sessions:sessions.filter(s=>s.projectId===url.searchParams.get('projectId'))});
      const id=url.pathname.split('/').at(-1);const session=sessions.find(s=>s.id===id);
      if(!session)return {ok:false,status:404,body:'{"error":"Missing test session"}'};
      if(options){const body=JSON.parse(options.body);test.sends.push({id,...body});
        if(test.loseResponse){test.loseResponse=false;throw new Error('Test response lost');}
        if(test.fail)return {ok:false,status:502,body:'{"error":"Could not confirm the turn.","code":"ambiguous_turn"}'};
        if(body.action==='login')return response({session,login:{verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'}});
        if(body.action==='message'){events[id].push(event('u'+test.sends.length,'user',body.text),event('a'+test.sends.length,'assistant','Implemented **the requested change** with `limit`.\n\n```ts\n// bounded results\nconst message = "ready";\n```\n\n- Preserves existing behavior\n- Checks input limits'));session.status='ready';}
        if(body.action==='interrupt'){session.status='ready';events[id].push(event('stop','status','Turn interrupted'));}
        if(body.action==='resume'){session.status='ready';}
        return response({session});
      }
      return response({session,events:events[id]});
    },
    onTerminalEvent:()=>()=>{},terminalOpen:async()=>{throw Error('Test SSH unavailable')},terminalWrite:()=>{},terminalResize:()=>{},terminalClose:async()=>{},deviceKeyStatus:async()=>({state:'registered',message:'Test device',fingerprint:'test',persistent:true}),
  };
})();
