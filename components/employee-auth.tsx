"use client";
import { Select } from "@/components/ui/select";
import Link from "next/link";
import { SignOut, User } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { authClient as client } from "@/lib/auth-client";
export function SignIn({ signup = false, invite = "", verified = false, verificationError = false }: { signup?: boolean; invite?: string; verified?: boolean; verificationError?: boolean }) {
  const [error, setError] = useState(verificationError ? "This verification link is invalid or expired. Request another email below." : "");
  const [pending, setPending] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState(verified ? "Email verified. You can sign in now." : "");
  const suffix = invite ? `?invite=${encodeURIComponent(invite)}` : "";
  const callbackURL = `/sign-in?verified=1${invite ? `&invite=${encodeURIComponent(invite)}` : ""}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    setPending(true); setError(""); setNotice("");
    try {
      const credentials = { email: email.trim(), password: String(data.get("password")) };
      const result = signup
        ? await client.signUp.email({ ...credentials, name: String(data.get("name")).trim(), callbackURL })
        : await client.signIn.email(credentials);
      if (result.error) {
        setError(result.error.status === 429 ? "Too many attempts. Wait a moment, then try again." : result.error.code === "EMAIL_NOT_VERIFIED" ? "Verify your email first. You can resend the verification email below." : signup ? "Account creation failed. Try signing in or request a verification email." : "Sign-in failed. Check your email and password.");
      } else if (signup) setCheckEmail(true);
      else window.location.assign(invite ? `/invitations/${encodeURIComponent(invite)}` : "/organizations");
    } catch { setError("Unable to complete this request. Please try again."); }
    finally { setPending(false); }
  }
  async function resend() {
    setPending(true); setError("");
    try {
      const result = await client.sendVerificationEmail({ email: email.trim(), callbackURL });
      if (result.error) setError("Could not send verification email. Wait a moment and retry.");
      else setNotice("If this account needs verification, a new email is on its way.");
    } catch { setError("Unable to send verification email. Please try again."); }
    finally { setPending(false); }
  }
  return <main className="auth-page"><section className="auth-panel">
    <p className="eyebrow auth-brand">alto</p>
    <h1>{checkEmail ? "Check your email" : signup ? "Create your account" : "Sign in"}</h1>
    <p>{checkEmail ? "Open the verification link, then return here to sign in." : invite ? "Use the email address that received the invitation. You’ll review it after signing in." : signup ? "Verify your email to create an organization or join your team." : "Continue to your organizations and projects."}</p>
    {!checkEmail && <form onSubmit={submit}>
      {signup && <><label htmlFor="name">Your name</label><input id="name" name="name" autoComplete="name" maxLength={100} required /></>}
      <label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
      <label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 12 : undefined} required />
      {signup && <p>Use at least 12 characters.</p>}
      <button className="button primary" disabled={pending}>{pending ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
    </form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="auth-actions"><button className="button ghost" type="button" disabled={pending || !email.includes("@")} onClick={resend}>Resend verification email</button>
    <Link href={`${signup || checkEmail ? "/sign-in" : "/sign-up"}${suffix}`}>{signup || checkEmail ? "Back to sign in" : "Create an account"}</Link></div>
  </section></main>;
}
export function EmployeeMenu({ navigation = true }: { navigation?: boolean }) {
  const { data } = client.useSession();
  const { data: organizations } = client.useListOrganizations();
  const { data: active } = client.useActiveOrganization();
  const name = data?.user?.name?.trim() || "employee";
  const initials = name.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join("").toLocaleUpperCase();
  const [error, setError] = useState("");
  return <>
    {organizations && organizations.length > 0 && <label className="organization-switcher"><span className="visually-hidden"><span>Organization</span></span><Select aria-label="Active organization" value={active?.id || ""} onChange={async e => {
      const result = await client.organization.setActive({ organizationId: e.target.value });
      if (result.error) setError("Could not switch organization"); else window.location.assign("/projects");
    }}><option value="" disabled>Select organization</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</Select></label>}
    {navigation && <Link className="button ghost" href="/organizations">Organizations</Link>}
    <div className="account-identity"><span className="account-avatar" aria-hidden="true">{data?.user ? initials : <User />}</span><div className="account-details"><strong className="local-label">{name}</strong>{data?.user?.email && <span className="account-email" title={data.user.email}>{data.user.email}</span>}</div></div>
    <button className="button ghost" onClick={async () => {try {const result=await client.signOut();if(result.error)setError("Sign-out failed");else window.location.assign("/sign-in");}catch{setError("Sign-out failed");}}}><SignOut aria-hidden="true" />Sign out</button>
    {error && <span role="alert">{error}</span>}
  </>;
}
