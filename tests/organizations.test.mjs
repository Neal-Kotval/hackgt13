import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";
const directory=await mkdtemp(path.join(os.tmpdir(),"agentcloud-org-"));
process.env.AGENTCLOUD_DATA_DIR=path.join(directory,"data");
await writeFile(path.join(directory,"package.json"),'{"type":"module"}');
for(const name of ["store","http","resource-profiles"]) {
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),"utf8");
 await writeFile(path.join(directory,`${name}.js`),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/from ["']\.\/([\w-]+)["']/g,"from './$1.js'"));
}
const fixture=await prepareAuth(directory,{mailModuleSource:`import * as real from "./mail-real.mjs";
export const mailMode=real.mailMode;
export const mailDeliveryStatus=real.mailDeliveryStatus;
export const sendAuthMail=(message)=>globalThis.__agentcloudTestMail ? globalThis.__agentcloudTestMail(message,real.sendAuthMail) : real.sendAuthMail(message);
`}); const db=fixture.getDatabase(); const auth=fixture.getAuth();
const store=await import(path.join(directory,"store.js"));
const routes={};
for(const name of ["organizations","state","events","resources"]) {
 const source=await readFile(new URL(`../app/api/${name}/route.ts`,import.meta.url),"utf8");
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/from ["']\.\.\/\.\.\/\.\.\/lib\/([\w-]+)["']/g,"from './$1.js'").replaceAll("../../../lib/auth.mjs","./auth.mjs").replaceAll("../../../lib/mail.mjs","./mail.mjs");
 await writeFile(path.join(directory,`${name}-route.js`),code);routes[name]=await import(path.join(directory,`${name}-route.js`));
}
const request=(route,body,cookie)=>new Request(`http://localhost:3000/api/${route}`,{method:body?"POST":"GET",headers:{"content-type":"application/json",origin:"http://localhost:3000",...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
const call=(route,body,cookie)=>auth.handler(request(`auth/${route}`,body,cookie));
const cookieFrom=r=>r.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
async function signup(email,verify=true) {
 const password=randomBytes(24).toString("base64url");
 const response=await call("sign-up/email",{email,password,name:email});assert.equal(response.status,200);
 if(verify){const files=await readdir(path.join(process.env.AGENTCLOUD_DATA_DIR,"mail"));for(const file of files){const mail=JSON.parse(await readFile(path.join(process.env.AGENTCLOUD_DATA_DIR,"mail",file),"utf8"));if(mail.to===email&&mail.subject.startsWith("Verify"))await auth.handler(new Request(mail.text.match(/http[^\s]+/)[0]));}}
 const login=await call("sign-in/email",{email,password});
 return {email,password,cookie:cookieFrom(login),status:login.status,id:db.prepare("SELECT id FROM user WHERE email=?").get(email).id};
}
const owner=fixture.users[0], member=fixture.users[1], org=fixture.organization;
let outsider, org2, projectId, acceptedUser;
after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
test("signup requires verified email, organization creation assigns the authenticated owner",async()=>{
 const unverified=await signup("unverified@example.test",false);assert.equal(unverified.status,403);
 const denied=await call("organization/create",{name:"Denied",slug:"denied",userId:owner.id});assert.equal(denied.status,401);
 outsider=await signup("outsider@example.test");assert.equal(outsider.status,200);
 const create=await call("organization/create",{name:"Other organization",slug:"other-organization",userId:owner.id},outsider.cookie);assert.equal(create.status,200);org2=await create.json();
 assert.equal(db.prepare('SELECT userId FROM member WHERE organizationId=?').get(org2.id).userId,outsider.id);
 assert.equal((await call("organization/set-active",{organizationId:org.id},outsider.cookie)).ok,false);
});
test("project operations enforce organization and explicit project membership",async()=>{
 for(const route of ["organizations","state","resources"])assert.equal((await routes[route].POST(request(route,{type:"createProject"}))).status,401);
 const created=await routes.state.POST(request("state",{type:"createProject",name:"Scoped project",repo:"https://example.com/repo",compute:"Hosted Linux",template:"blank"},owner.cookie));assert.equal(created.status,200);projectId=(await created.json()).id;
 assert.equal(db.prepare("SELECT organization_id FROM project_organization WHERE project_id=?").get(projectId).organization_id,org.id);
 assert.deepEqual((await (await routes.state.GET(request("state",null,member.cookie))).json()).projects,[]);
 assert.equal((await routes.organizations.POST(request("organizations",{type:"setProjectAccess",projectId,userId:member.id,allowed:true},outsider.cookie))).status,403);
 assert.equal((await routes.organizations.POST(request("organizations",{type:"setProjectAccess",projectId,userId:outsider.id,allowed:true},owner.cookie))).status,403);
 assert.equal((await routes.organizations.POST(request("organizations",{type:"setProjectAccess",projectId,userId:member.id,allowed:true},owner.cookie))).status,200);
 assert.equal((await (await routes.state.GET(request("state",null,member.cookie))).json()).projects[0].id,projectId);
 assert.equal((await routes.resources.POST(request("resources",{type:"requestResource",projectId,kind:"gpu",purpose:"Attempt foreign project"},outsider.cookie))).status,403);
 assert.equal((await call("organization/invite-member",{email:"denied@example.test",role:"member",organizationId:org.id},member.cookie)).ok,false);
});
test("existing-account invitation checks recipient and role, and repeated acceptance creates one membership",async()=>{
 const issued=await call("organization/invite-member",{email:outsider.email,role:"member",organizationId:org.id},owner.cookie);assert.equal(issued.status,200);const invitation=await issued.json();
 assert.equal(db.prepare("SELECT status FROM invitation_delivery WHERE invitation_id=?").get(invitation.id).status,"captured");
 assert.equal((await call("organization/accept-invitation",{invitationId:invitation.id},member.cookie)).status,403);
 const accept=await call("organization/accept-invitation",{invitationId:invitation.id,role:"owner",userId:owner.id},outsider.cookie);assert.equal(accept.status,200);
 assert.equal(db.prepare('SELECT role FROM member WHERE organizationId=? AND userId=?').get(org.id,outsider.id).role,"member");
 await call("organization/accept-invitation",{invitationId:invitation.id},outsider.cookie);
 assert.equal(db.prepare('SELECT count(*) AS n FROM member WHERE organizationId=? AND userId=?').get(org.id,outsider.id).n,1);
 assert.equal((await call("organization/update-member-role",{organizationId:org.id,memberId:db.prepare('SELECT id FROM member WHERE organizationId=? AND userId=?').get(org.id,outsider.id).id,role:"owner"},outsider.cookie)).ok,false);
});
test("new invitee can verify, accept, and see no projects until explicitly assigned",async()=>{
 const issued=await call("organization/invite-member",{email:"new-invitee@example.test",role:"member",organizationId:org.id},owner.cookie);assert.equal(issued.status,200);const invitation=await issued.json();
 acceptedUser=await signup("new-invitee@example.test");
 assert.equal((await call("organization/accept-invitation",{invitationId:invitation.id},acceptedUser.cookie)).status,200);
 assert.deepEqual((await (await routes.state.GET(request("state",null,acceptedUser.cookie))).json()).projects,[]);
 const files=await readdir(path.join(process.env.AGENTCLOUD_DATA_DIR,"mail"));
 for(const file of files)assert.equal((await stat(path.join(process.env.AGENTCLOUD_DATA_DIR,"mail",file))).mode & 0o777,0o600);
});
test("reissued, revoked, expired and declined invitations cannot be accepted",async()=>{
 const recipient=await signup("lifecycle@example.test");
 const issue=async()=>{const r=await call("organization/invite-member",{email:recipient.email,role:"member",organizationId:org.id},owner.cookie);assert.equal(r.status,200);return r.json();};
 const first=await issue();
 assert.equal((await call("organization/invite-member",{email:recipient.email,role:"member",organizationId:org.id},member.cookie)).status,403);
 assert.equal(db.prepare("SELECT status FROM invitation WHERE id=?").get(first.id).status,"pending");
 const second=await issue();assert.notEqual(first.id,second.id);
 assert.equal((await call("organization/accept-invitation",{invitationId:first.id},recipient.cookie)).ok,false);
 assert.equal((await call("organization/cancel-invitation",{invitationId:second.id},owner.cookie)).status,200);
 assert.equal((await call("organization/accept-invitation",{invitationId:second.id},recipient.cookie)).ok,false);
 const expired=await issue();db.prepare("UPDATE invitation SET expiresAt=? WHERE id=?").run(Date.now()-1000,expired.id);
 assert.equal((await call("organization/accept-invitation",{invitationId:expired.id},recipient.cookie)).ok,false);
 const declined=await issue();assert.equal((await call("organization/reject-invitation",{invitationId:declined.id},recipient.cookie)).status,200);
 assert.equal((await call("organization/accept-invitation",{invitationId:declined.id},recipient.cookie)).ok,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM member WHERE userId=? AND organizationId=?').get(recipient.id,org.id).n,0);
});
test("failed SMTP reissue preserves the previously usable invitation",async()=>{
 const recipient=await signup("delivery-failure@example.test");
 const issued=await call("organization/invite-member",{email:recipient.email,role:"member",organizationId:org.id},owner.cookie);
 assert.equal(issued.status,200);
 const original=await issued.json();
 const mode=process.env.AGENTCLOUD_MAIL_MODE;
 const host=process.env.SMTP_HOST;
 const port=process.env.SMTP_PORT;
 const from=process.env.SMTP_FROM;
 try {
  process.env.AGENTCLOUD_MAIL_MODE="smtp";
  process.env.SMTP_HOST="127.0.0.1";
  process.env.SMTP_PORT="1";
  process.env.SMTP_FROM="AgentCloud <hello@example.test>";
  const failed=await call("organization/invite-member",{email:recipient.email,role:"member",organizationId:org.id},owner.cookie);
  assert.equal(failed.status,503);
  assert.equal(db.prepare("SELECT status FROM invitation WHERE id=?").get(original.id).status,"pending");
  assert.equal(db.prepare("SELECT count(*) AS n FROM invitation WHERE organizationId=? AND email=? AND status='pending'").get(org.id,recipient.email).n,1);
  assert.equal(db.prepare("SELECT d.status AS delivery, i.status FROM invitation i JOIN invitation_delivery d ON d.invitation_id=i.id WHERE i.organizationId=? AND i.email=? AND i.id<>?").get(org.id,recipient.email,original.id).delivery,"failed");
  const firstFailure=await call("organization/invite-member",{email:"first-failure@example.test",role:"member",organizationId:org.id},owner.cookie);
  assert.equal(firstFailure.status,503);
  assert.equal(db.prepare("SELECT count(*) AS n FROM invitation WHERE organizationId=? AND email=? AND status='pending'").get(org.id,"first-failure@example.test").n,0);
 } finally {
  if(mode===undefined)delete process.env.AGENTCLOUD_MAIL_MODE;else process.env.AGENTCLOUD_MAIL_MODE=mode;
  if(host===undefined)delete process.env.SMTP_HOST;else process.env.SMTP_HOST=host;
  if(port===undefined)delete process.env.SMTP_PORT;else process.env.SMTP_PORT=port;
  if(from===undefined)delete process.env.SMTP_FROM;else process.env.SMTP_FROM=from;
 }
 const failedId=db.prepare("SELECT i.id FROM invitation i JOIN invitation_delivery d ON d.invitation_id=i.id WHERE i.organizationId=? AND i.email=? AND d.status='failed' ORDER BY i.createdAt DESC LIMIT 1").get(org.id,recipient.email).id;
 assert.equal((await call("organization/accept-invitation",{invitationId:failedId},recipient.cookie)).ok,false);
 assert.equal((await call("organization/accept-invitation",{invitationId:original.id},recipient.cookie)).status,200);
});
test("concurrent reissue waits for delivery before invalidating the previous link",async()=>{
 const recipient=await signup("concurrent-invite@example.test");
 const original=await (await call("organization/invite-member",{email:recipient.email,role:"member",organizationId:org.id},owner.cookie)).json();
 let signalStarted,releaseMail;
 const started=new Promise(resolve=>{signalStarted=resolve;});
 const blocked=new Promise(resolve=>{releaseMail=resolve;});
 globalThis.__agentcloudTestMail=async(message,real)=>{
  if(message.to===recipient.email&&message.subject.startsWith("Join")) {signalStarted();await blocked;}
  return real(message);
 };
 const firstCall=call("organization/invite-member",{email:recipient.email,role:"member",organizationId:org.id},owner.cookie);
 await started;
 try {
  assert.equal(db.prepare("SELECT status FROM invitation WHERE id=?").get(original.id).status,"pending");
  const concurrent=await call("organization/invite-member",{email:recipient.email,role:"member",organizationId:org.id},owner.cookie);
  assert.equal(concurrent.status,409);
  assert.equal(db.prepare("SELECT status FROM invitation WHERE id=?").get(original.id).status,"pending");
 } finally {releaseMail();delete globalThis.__agentcloudTestMail;}
 const replacementResponse=await firstCall;
 assert.equal(replacementResponse.status,200);
 const replacement=await replacementResponse.json();
 assert.notEqual(replacement.id,original.id);
 assert.equal(db.prepare("SELECT status FROM invitation WHERE id=?").get(original.id).status,"canceled");
 assert.equal(db.prepare("SELECT status FROM invitation_delivery WHERE invitation_id=?").get(replacement.id).status,"captured");
 assert.equal((await call("organization/accept-invitation",{invitationId:original.id},recipient.cookie)).ok,false);
 assert.equal((await call("organization/accept-invitation",{invitationId:replacement.id},recipient.cookie)).status,200);
});
test("member removal revokes current project access and last owner cannot be demoted",async()=>{
 const id=db.prepare('SELECT id FROM member WHERE userId=? AND organizationId=?').get(member.id,org.id).id;
 const stream=await routes.events.GET(request("events",null,member.cookie));const reader=stream.body.getReader();
 assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6)).projects.length,1);
 assert.equal((await call("organization/remove-member",{organizationId:org.id,memberIdOrEmail:id},owner.cookie)).status,200);
 assert.equal(db.prepare("SELECT count(*) AS n FROM project_membership WHERE user_id=?").get(member.id).n,0);
 assert.deepEqual((await (await routes.state.GET(request("state",null,member.cookie))).json()).projects,[]);
 assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6)).projects.length,0);await reader.cancel();
 const ownerId=db.prepare('SELECT id FROM member WHERE userId=? AND organizationId=?').get(owner.id,org.id).id;
 assert.equal((await call("organization/update-member-role",{organizationId:org.id,memberId:ownerId,role:"member"},owner.cookie)).ok,false);
 assert.equal((await call("organization/remove-member",{organizationId:org.id,memberIdOrEmail:ownerId},owner.cookie)).ok,false);
});
test("leaving and rejoining an organization does not restore previous project assignments",async()=>{
 assert.equal((await routes.organizations.POST(request("organizations",{type:"setProjectAccess",projectId,userId:acceptedUser.id,allowed:true},owner.cookie))).status,200);
 assert.equal((await call("organization/leave",{organizationId:org.id},acceptedUser.cookie)).status,200);
 assert.equal(db.prepare("SELECT count(*) AS n FROM project_membership WHERE user_id=? AND project_id=?").get(acceptedUser.id,projectId).n,0);
 const invitation=await (await call("organization/invite-member",{email:acceptedUser.email,role:"member",organizationId:org.id},owner.cookie)).json();
 assert.equal((await call("organization/accept-invitation",{invitationId:invitation.id},acceptedUser.cookie)).status,200);
 await call("organization/set-active",{organizationId:org.id},acceptedUser.cookie);
 assert.deepEqual((await (await routes.state.GET(request("state",null,acceptedUser.cookie))).json()).projects,[]);
});
test("legacy projects require their existing owner to move them into an organization",async()=>{
 const p=await store.action({type:"createProject",name:"Existing work",repo:"https://example.com/repo",compute:"Hosted Linux",template:"blank"});
 db.prepare("INSERT INTO project_membership (user_id,project_id,role) VALUES (?,?,'owner')").run(owner.id,p.id);
 db.prepare("INSERT INTO project_membership (user_id,project_id,role) VALUES (?,?,'member')").run(outsider.id,p.id);
 await call("organization/set-active",{organizationId:org2.id},outsider.cookie);
 assert.equal((await routes.organizations.POST(request("organizations",{type:"adoptProject",projectId:p.id},outsider.cookie))).status,403);
 assert.equal((await routes.organizations.POST(request("organizations",{type:"adoptProject",projectId:p.id},owner.cookie))).status,200);
 assert.equal(db.prepare("SELECT role FROM project_membership WHERE user_id=? AND project_id=?").get(owner.id,p.id).role,"owner");
 assert.equal(db.prepare("SELECT role FROM project_membership WHERE user_id=? AND project_id=?").get(outsider.id,p.id),undefined);
 await call("organization/set-active",{organizationId:org.id},outsider.cookie);
 assert.deepEqual((await (await routes.state.GET(request("state",null,outsider.cookie))).json()).projects,[]);
 assert.equal((await routes.organizations.POST(request("organizations",{type:"setProjectAccess",projectId:p.id,userId:outsider.id,allowed:true},owner.cookie))).status,200);
 assert.equal((await (await routes.state.GET(request("state",null,outsider.cookie))).json()).projects[0].id,p.id);
 assert.equal((await routes.organizations.POST(request("organizations",{type:"adoptProject",projectId:p.id},owner.cookie))).status,409);
});
test("public local-mail configuration keeps authenticated organization reads available",async()=>{
 const previous=process.env.BETTER_AUTH_URL;
 const mode=process.env.AGENTCLOUD_MAIL_MODE;
 try{
  process.env.BETTER_AUTH_URL="https://shared.example.test";
  process.env.AGENTCLOUD_MAIL_MODE="local";
  const response=await routes.organizations.GET(request("organizations",null,owner.cookie));
  assert.equal(response.status,200);
  assert.equal((await response.json()).mailMode,"unavailable");
 }finally{
  if(previous===undefined)delete process.env.BETTER_AUTH_URL;else process.env.BETTER_AUTH_URL=previous;
  if(mode===undefined)delete process.env.AGENTCLOUD_MAIL_MODE;else process.env.AGENTCLOUD_MAIL_MODE=mode;
 }
});
test("a fresh sign-in (e.g. the desktop app) starts in the employee's organization",async()=>{
 const person=await signup("fresh-session@example.test");
 const create=await call("organization/create",{name:"Fresh session org",slug:"fresh-session-org"},person.cookie);assert.equal(create.status,200);
 const created=await create.json();
 const again=await call("sign-in/email",{email:person.email,password:person.password});assert.equal(again.status,200);
 const session=await auth.api.getSession({headers:new Headers({cookie:cookieFrom(again)})});
 assert.equal(session.session.activeOrganizationId,created.id);
 const loner=await signup("no-org-session@example.test");
 const lonerSession=await auth.api.getSession({headers:new Headers({cookie:loner.cookie})});
 assert.equal(lonerSession.session.activeOrganizationId ?? null,null);
});
