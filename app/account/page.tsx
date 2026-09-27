import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { pageAuth } from "@/lib/page-auth";
import { organizationUrl } from "@/lib/organization-url";

export default async function Page() {
  const identity = await pageAuth(await headers());
  if (!identity.verified) redirect("/sign-in");
  return <main className="organization-page">
    <div className="section-heading"><h1>Account</h1></div>
    <section className="organization-panel" aria-labelledby="account-profile-heading">
      <h2 id="account-profile-heading">Profile</h2>
      <p><strong>Name:</strong> {identity.user?.name}</p>
      <p><strong>Email:</strong> {identity.user?.email}</p>
    </section>
    <section className="organization-panel" aria-labelledby="account-organizations-heading">
      <h2 id="account-organizations-heading">Your organizations</h2>
      {identity.organizations.length ? <ul className="organization-list">{identity.organizations.map((org) =>
        <li key={org.id}><div><strong>{org.name}</strong><p>{org.role}</p></div>
          <Link className="button" href={organizationUrl(org)}>Open {org.name}</Link></li>)}</ul>
        : <p>You do not belong to an organization yet.</p>}
      <Link className="button ghost" href="/organizations">Manage organizations</Link>
    </section>
  </main>;
}
