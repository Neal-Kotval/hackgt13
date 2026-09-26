"use client";
import { Select } from "@/components/ui/select";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { authClient as client } from "@/lib/auth-client";
import { EmployeeMenu } from "./employee-auth";
type Org = { id: string; name: string; slug: string; role: string };
type Member = { id: string; userId: string; role: string; name: string; email: string };
type Invitation = { id: string; email: string; role: "member" | "admin"; status: string; expiresAt: string | number; delivery: string | null };
type Project = { id: string; name: string };
type Snapshot = { id: string; organizations: Org[]; activeOrganization: Org | null; members: Member[]; invitations: Invitation[]; projects: Project[]; legacyProjects: Project[]; assignments: { userId: string; projectId: string }[]; mailMode: string };
export function OrganizationDashboard() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch("/api/organizations");
    if (response.status === 401 || response.status === 403) {window.location.assign("/sign-in"); return;}
    if (!response.ok) throw Error("Could not load organizations");
    setData(await response.json());
  }
  useEffect(() => {void load().catch(e => setError(e.message));}, []);
  async function run(operation: () => Promise<unknown>, message: string) {
    setBusy(true);setError("");setNotice("");
    try { await operation(); await load();setNotice(message); }
    catch(e) {setError(e instanceof Error ? e.message : "The request failed. Please try again.");}
    finally{setBusy(false);}
  }
  function checked(result: { error?: { message?: string } | null }) {if(result.error)throw Error(result.error.message || "Request failed");}
  async function mutate(body: Record<string, unknown>) {const r=await fetch("/api/organizations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error || "Request failed");}
  const active=data?.activeOrganization; const manage=!!active && ["owner","admin"].includes(active.role);
  function create(event: FormEvent<HTMLFormElement>) {event.preventDefault();const form=event.currentTarget;const values=new FormData(form);void run(async()=>{const result=await client.organization.create({name:String(values.get("name")),slug:String(values.get("slug"))});checked(result);form.reset();},"Organization created. You are its owner.");}
  function invite(event: FormEvent<HTMLFormElement>) {event.preventDefault();const form=event.currentTarget;const values=new FormData(form);void run(async()=>{checked(await client.organization.inviteMember({email:String(values.get("email")).trim(),role:values.get("role") as "member" | "admin",organizationId:active!.id}));form.reset();},data?.mailMode==="local"?"Invitation captured in the local mailbox. No external email was sent.":"Invitation submitted to the email provider.");}
  return <><header className="organization-header"><Link className="brand" href="/projects">agentcloud_</Link><div className="organization-header-actions"><EmployeeMenu /></div></header>
  <main className="organization-page"><div className="section-heading"><h1>People & organizations</h1><a className="button" href="#create-organization">New organization</a></div>
    {error && <p className="auth-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!data ? <p>Loading organizations…</p> : <>
      <section className="organization-panel"><h2>Your organizations</h2>
        {data.organizations.length===0 ? <p>Create your first organization, or open an invitation from your email.</p> : <ul className="organization-list">{data.organizations.map(org=><li key={org.id}><div><strong>{org.name}</strong><p>{org.role}{active?.id===org.id ? " · Active" : ""}</p></div><button className="button" disabled={busy || active?.id===org.id} onClick={()=>void run(async()=>{checked(await client.organization.setActive({organizationId:org.id}));},"Active organization changed.")}>Switch to {org.name}</button></li>)}</ul>}
        {active && <Link className="button primary" href="/projects">Open projects</Link>}
      </section>
      {active && <section className="organization-panel"><h2>{active.name} · People</h2><p>Your role: {active.role}. Owners and admins manage all organization projects; members receive explicit project access.</p>
        {manage && <><h3>Invite a teammate</h3><p>{data.mailMode==="local"?"Development mailbox: messages are captured locally, not delivered to external inboxes.":"Invitations are submitted through your configured email provider."}</p><form className="organization-form" onSubmit={invite}>
          <label>Teammate email<input name="email" type="email" required /></label><label><span className="visually-hidden">Invitation role</span><Select name="role"><option value="member">Member</option><option value="admin">Admin</option></Select></label><button className="button primary" disabled={busy}>Send invitation</button>
        </form></>}
        <h3>Members</h3><ul className="organization-list">{data.members.map(member=><li key={member.id}><div><strong>{member.name}</strong><p>{member.email} · {member.role}</p></div>
          {manage && (active.role==="owner" || member.role!=="owner") && <div className="auth-actions"><label><span className="visually-hidden">Role for {member.name}</span><Select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy} onChange={e=>void run(async()=>{checked(await client.organization.updateMemberRole({memberId:member.id,organizationId:active.id,role:e.target.value as "owner"|"admin"|"member"}));},"Member role updated.")}>
            <option value="member">Member</option><option value="admin">Admin</option>{active.role==="owner"&&<option value="owner">Owner</option>}</Select></label>
            <button className="button ghost" disabled={busy || member.userId===data.id} onClick={()=>{if(window.confirm(`Remove ${member.name} from ${active.name}?`))void run(async()=>{checked(await client.organization.removeMember({memberIdOrEmail:member.id,organizationId:active.id}));},"Member removed. Project access revoked.");}}>Remove</button></div>}
        </li>)}</ul>
        {manage && <><h3>Invitations</h3>{data.invitations.length===0?<p>No invitations yet.</p>:<ul className="organization-list">{data.invitations.map(invitation=>{
          const status=invitation.status==="pending" && new Date(invitation.expiresAt).getTime()<Date.now()?"expired":invitation.status;
          const delivery=invitation.delivery==="captured"?"Captured locally":invitation.delivery==="submitted"?"Submitted to email provider":invitation.delivery==="failed"?"Email failed":"Email status unavailable";
          return <li key={invitation.id}><div><strong>{invitation.email}</strong><p>{invitation.role} · {status} · {delivery}</p></div><div className="auth-actions">{["pending","expired","canceled"].includes(status)&&<button className="button" disabled={busy} onClick={()=>void run(async()=>{checked(await client.organization.inviteMember({email:invitation.email,role:invitation.role,organizationId:active.id}));},"Replacement invitation created; the previous pending link is invalid.")}>Reissue</button>}{status==="pending"&&<button className="button ghost" disabled={busy} onClick={()=>void run(async()=>{checked(await client.organization.cancelInvitation({invitationId:invitation.id}));},"Invitation revoked.")}>Revoke</button>}</div></li>;
        })}</ul>}</>}
      </section>}
      {manage && <section className="organization-panel"><h2>Project access</h2>{data.projects.length===0?<p>Create a project to assign access.</p>:<form className="organization-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(()=>mutate({type:"setProjectAccess",projectId:f.get("project"),userId:f.get("member"),allowed:true}),"Project access granted.");}}>
        <label><span className="visually-hidden">Project</span><Select name="project" required><option value="">Choose project</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label><label><span className="visually-hidden">Member</span><Select name="member" required><option value="">Choose member</option>{data.members.filter(m=>m.role==="member").map(m=><option key={m.id} value={m.userId}>{m.email}</option>)}</Select></label><button className="button primary" disabled={busy}>Grant project access</button>
      </form>}
      <ul className="organization-list">{data.assignments.flatMap(a=>{const m=data.members.find(m=>m.userId===a.userId && m.role==="member"),p=data.projects.find(p=>p.id===a.projectId);return m&&p?[<li key={`${a.userId}-${a.projectId}`}><span>{m.email} → {p.name}</span><button className="button ghost" disabled={busy} onClick={()=>void run(()=>mutate({type:"setProjectAccess",...a,allowed:false}),"Project access revoked.")}>Revoke project access</button></li>]:[];})}</ul>
      {data.legacyProjects.length>0&&<><h3>Existing projects</h3><p>Move projects you own into this organization. Previous collaborators must join the organization and receive project access.</p><ul className="organization-list">{data.legacyProjects.map(p=><li key={p.id}><strong>{p.name}</strong><button className="button" disabled={busy} onClick={()=>{if(window.confirm(`Move ${p.name} into ${active!.name}? Existing collaborators will need organization membership.`))void run(()=>mutate({type:"adoptProject",projectId:p.id}),"Project moved into this organization.");}}>Move into {active!.name}</button></li>)}</ul></>}
      </section>}
      <section className="organization-panel" id="create-organization" aria-labelledby="create-organization-heading"><h2 id="create-organization-heading">Create an organization</h2><p>Start a separate organization for another team.</p><form className="organization-form" onSubmit={create}>
        <label>Organization name<input name="name" maxLength={100} required /></label><label>Organization URL name<input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={80} placeholder="your-team" required /></label><button className="button primary" disabled={busy}>Create organization</button>
      </form></section>
    </>}
  </main></>;
}
