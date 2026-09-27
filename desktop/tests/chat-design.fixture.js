// Isolated renderer verification fixture. Never imported by application code.
(() => {
  const now = new Date().toISOString();
  const sessions = [{id:'s1',projectId:'p1',agentId:'a1',status:'ready',error:null,updatedAt:now},{id:'s2',projectId:'p1',agentId:'a2',status:'ready',error:null,updatedAt:new Date(Date.now()-86400000).toISOString()},{id:'s3',projectId:'p2',agentId:'a3',status:'ready',error:null,updatedAt:now}];
  for (const item of sessions) item.target = { kind: 'runBox', runBoxId: 'box-1', provider: 'docker-local', profileId: 'cpu-workspace', state: 'ready' };
  sessions.unshift({ id: 'legacy', projectId: 'p1', agentId: 'old', status: 'ready', error: null });
  const state={projects:[{id:'p1',name:'UI verification',agents:[{id:'a1',name:'desktop-chat',client:'codex'},{id:'a2',name:'review-agent'}],tasks:[],resources:[],resourceRequests:[]},{id:'p2',name:'Second project',agents:[{id:'a3',name:'build-agent'}],tasks:[],resources:[],resourceRequests:[]}]};
  const event=(id,kind,text)=>({id,kind,text,updatedAt:now});
  const events={s1:[event('old-error-1','error','Codex connection to the environment failed. Reconnect to continue.'),event('old-error-2','error','Codex connection to the environment failed. Reconnect to continue.'),event('setup','status','Codex is ready in the environment workspace /home/agentcloud/workspace/repo.')],s2:[],s3:[]};
  if (location.search.includes("no-projects")) state.projects = [];
  if (location.search.includes("new-environment")) sessions.splice(0, sessions.length);
  if (!location.search) {
    const saved = JSON.parse(sessionStorage.getItem('chat-fixture-server') || 'null');
    if (saved) { sessions.splice(0,sessions.length,...saved.sessions); Object.assign(events,saved.events); }
    addEventListener('beforeunload', () => sessionStorage.setItem('chat-fixture-server',JSON.stringify({sessions,events})));
  }
  const test=window.__test={sessions,events,state,sends:[],fail:false,loseResponse:false,deepLink:null};
  const response=body=>({ok:true,status:200,body:JSON.stringify(body)});
  window.agentcloudDesktop={
    authStatus:async()=>({signedIn:true,baseUrl:'http://127.0.0.1:3000',user:{id:'test',name:'UI test',email:'test@example.invalid'},secureStorage:true}),
    signOut:async()=>({signedIn:false,baseUrl:'http://127.0.0.1:3000',secureStorage:true}),
    onDeepLink:cb=>{test.deepLink=cb;return ()=>{}},takePendingDeepLink:async()=>null,
    getState:async()=>structuredClone(state),
    postAction:async body=>{
      if(body.type!=='createProject')throw Error('Unexpected action');
      test.projectRequests=(test.projectRequests||[]);test.projectRequests.push(body);
      if(test.projectFailure)throw Error('Organization admin access required to create a project.');
      const project={id:'created-project',name:body.name,repo:body.repo,agents:[],tasks:[],resources:[],resourceRequests:[]};
      state.projects.push(project);return {state:structuredClone(state),raw:{id:project.id}};
    },
    listRunBoxes:async projectId=>[{id:'box-1',projectId,provider:'docker-local',profileId:'cpu-workspace',state:'ready',rawState:'ready',ssh:{host:'127.0.0.1',port:2222,username:'test'},stopRequested:false,codex:{state:'ready',reason:null}},{id:'box-2',projectId,provider:'docker-local',profileId:'second-workspace',state:'ready',rawState:'ready',ssh:{host:'127.0.0.1',port:2223,username:'test'},stopRequested:false,codex:{state:'ready',reason:null}},{id:'box-failed',projectId,profileId:'failed-box',state:'failed',ssh:null}],
    openChatGptSignIn:async url=>{test.openedUrl=url;},
    onChatGptSignInEvent:()=>()=>{},
    startChatGptBrowserSignIn:async()=>{test.loginCalls=(test.loginCalls||[]);test.loginCalls.push('tunnel:start');return {callbackPort:1455};},
    stopChatGptBrowserSignIn:async()=>{test.loginCalls=(test.loginCalls||[]);test.loginCalls.push('tunnel:stop');},
    fetchHuman:async(path,options)=>{
      const url=new URL(path,'http://localhost');
      if(url.pathname.endsWith('/peer-messages') && options){
        const body=JSON.parse(options.body);
        test.broadcasts ||= [];
        test.broadcasts.push({path:url.pathname,...body});
        return response({messages:[{id:'peer-1'}]});
      }
      if(url.pathname==='/api/codex-sessions' && options){const body=JSON.parse(options.body);test.created=body;if(test.setupRequired)return {ok:false,status:409,body:JSON.stringify({error:'Complete web setup first',code:'environment_setup_required'})};if(!body.runBoxId)throw Error('Creation requires an environment');if(!body.newChat){const existing=sessions.find(s=>s.isSetupSession&&s.target?.runBoxId===body.runBoxId);if(existing)return response({session:existing});const session={id:`setup-${body.runBoxId}`,projectId:body.projectId,agentId:'a1',status:'auth_required',error:null,isSetupSession:true,title:'Codex setup',target:{kind:'runBox',runBoxId:body.runBoxId,provider:'docker-local',profileId:'cpu-workspace',state:'ready'}};sessions.push(session);events[session.id]=[];return response({session});}if(!body.requestId)throw Error("Native creation must be an independent idempotent chat");const prior=sessions.find(s=>s.requestId===body.requestId);if(prior)return response({session:prior});const session={requestId:body.requestId,title:"New chat",isSetupSession:false,id:`remote-created-${sessions.length}`,projectId:body.projectId,agentId:body.agentId,status:'ready',error:null,target:{kind:'runBox',runBoxId:body.runBoxId,provider:'docker-local',profileId:'cpu-workspace',state:'ready'}};sessions.push(session);events[session.id]=[];return response({session});}
      if(url.pathname==='/api/codex-sessions')return response({enabled:true,sessions:sessions.filter(s=>s.projectId===url.searchParams.get('projectId'))});
      const id=url.pathname.split('/').at(-1);const session=sessions.find(s=>s.id===id);
      if(!session)return {ok:false,status:404,body:'{"error":"Missing test session"}'};
      if(options){const body=JSON.parse(options.body);test.sends.push({id,...body});
        if(test.loseResponse){test.loseResponse=false;throw new Error('Test response lost');}
        if(test.fail)return {ok:false,status:502,body:'{"error":"Could not confirm the turn.","code":"ambiguous_turn"}'};
        if(body.action==='login'){if(body.method!=='browser')throw Error('Desktop sign-in uses the browser');test.loginCalls=(test.loginCalls||[]);test.loginCalls.push(body.method);return response({login:{method:'browser',loginId:'login1',callbackPort:1455,authUrl:'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'}});}
        if(body.action==='message'){session.title=body.text.split('\n')[0];events[id].push(event('u'+test.sends.length,'user',body.text),event('a'+test.sends.length,'assistant','Implemented **the requested change** with `limit`.\n\n```ts\n// bounded results\nconst message = "ready";\n```\n\n- Preserves existing behavior\n- Checks input limits'));session.status='ready';}
        if(body.action==='interrupt'){session.status='ready';events[id].push(event('stop','status','Turn interrupted'));}
        if(body.action==='resume'){session.status='ready';}
        return response({session});
      }
      return response({session,events:events[id]});
    },
    onTerminalEvent:()=>()=>{},terminalOpen:async()=>{throw Error('Test SSH unavailable')},terminalWrite:()=>{},terminalResize:()=>{},terminalClose:async()=>{},deviceKeyStatus:async()=>({state:'registered',message:'Test device',fingerprint:'test',persistent:true}),
  };
})();
