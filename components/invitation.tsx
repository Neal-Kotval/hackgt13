"use client";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import Link from "next/link";
import { useEffect, useState } from "react";
import { authClient as client } from "@/lib/auth-client";
type Details = { organizationName: string; organizationId: string; role: string; status: string; member: boolean };
export function Invitation({ id, signedIn }: { id: string; signedIn: boolean }) {
  const [details,setDetails]=useState<Details|null>(null);const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [declined,setDeclined]=useState(false);
  useEffect(()=>{if(!signedIn)return;void fetch(`/api/invitations/${encodeURIComponent(id)}`).then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error);setDetails(data);}).catch(e=>setError(e.message));},[id,signedIn]);
  async function respond(accept:boolean){setBusy(true);setError("");try{const result=accept?await client.organization.acceptInvitation({invitationId:id}):await client.organization.rejectInvitation({invitationId:id});if(result.error)throw Error(result.error.message || "Unable to respond to invitation");if(accept)window.location.assign("/organizations");else setDeclined(true);}catch(e){setError(e instanceof Error?e.message:"Unable to respond");}finally{setBusy(false);}}
  return <main className="auth-page"><section className="auth-panel"><p className="eyebrow auth-brand">alto</p><h1>{declined?"Invitation declined":"Organization invitation"}</h1>
    {!signedIn ? <><p>Sign in or create an account using the email that received this invitation.</p><div className="auth-actions"><Link className="button primary" href={`/sign-in?invite=${encodeURIComponent(id)}`}>Sign in to review</Link><Link className="button" href={`/sign-up?invite=${encodeURIComponent(id)}`}>Create account</Link></div></> : <>
      {error&&<p role="alert">{error}</p>}{!details&&!error&&<SkeletonRegion label="Loading invitation"><Skeleton variant="title" width="60" /><Skeleton width="40" /><div className="auth-actions"><Skeleton variant="control" width="40" /><Skeleton variant="control" width="30" /></div></SkeletonRegion>}
      {details&&!declined&&<><h2>{details.organizationName}</h2><p>Invited role: {details.role}</p>{details.member?<><p>You already belong to this organization.</p><Link href="/organizations">Open organizations</Link></>:details.status==="pending"?<div className="auth-actions"><button className="button success" disabled={busy} onClick={()=>void respond(true)}>Accept invitation</button><button className="button danger" disabled={busy} onClick={()=>void respond(false)}>Decline</button></div>:<p>This invitation is {details.status}. Ask an administrator for a new invitation.</p>}</>}
      <div className="auth-actions"><Link href="/organizations">Your organizations</Link><button className="button ghost" disabled={busy} onClick={async()=>{setBusy(true);try{const result=await client.signOut();if(result.error)throw Error("Could not sign out");window.location.assign(`/sign-in?invite=${encodeURIComponent(id)}`);}catch{setError("Unable to switch accounts. Try again.");setBusy(false);}}}>Switch account</button></div>
    </>}
  </section></main>;
}
