"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Select } from "@/components/ui/select";
import { PlatformAwsEnvironments } from "@/components/platform-aws-environments";

type Organization = {
  id: string;
  name: string;
  slug: string;
  approved: boolean;
  maxRunMinutes: number;
  monthlyMinutes: number;
  usedMinutes: number;
  approvedBy: string | null;
  approvedAt: string | null;
};

const allowanceHours = Array.from({ length: 20 }, (_, index) => index + 1);

export function PlatformAwsApprovals() {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/admin/aws-approvals", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/sign-in");
      return;
    }
    if (!response.ok) throw new Error("Could not load AWS approvals. Reload the page to try again.");
    const result = await response.json();
    setOrganizations(result.organizations);
  }

  useEffect(() => {
    void load().catch((failure) => setError(failure instanceof Error ? failure.message : "Could not load AWS approvals."));
  }, []);

  async function update(organization: Organization, approved: boolean, maxRunMinutes: number, monthlyMinutes: number) {
    if (!approved && !window.confirm(`Revoke managed AWS access for ${organization.name}? New runs will be denied.`)) return;
    setBusyId(organization.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/aws-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: organization.id, approved, maxRunMinutes, monthlyMinutes }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The approval could not be saved.");
      await load();
      setNotice(`${organization.name}: ${approved ? "AWS access approved" : "AWS access revoked"}.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The approval could not be saved.");
    } finally {
      setBusyId(null);
    }
  }

  return <main className="organization-page organization-page--wide">
    <header className="section-heading"><div><p className="eyebrow">Platform administration</p><h1>Managed AWS access</h1></div></header>
    <PlatformAwsEnvironments />
    <p>Approve organizations and set limits before they can request alto funded AWS runs. Approval does not start a machine.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {notice && <p className="auth-success" role="status">{notice}</p>}
    {organizations === null ? <p role="status">Loading organizations…</p> : organizations.length === 0 ?
      <section className="organization-panel"><h2>No organizations yet</h2><p>Organizations will appear here after someone creates one.</p></section> :
      organizations.map((organization) => <ApprovalForm key={organization.id} organization={organization} busy={busyId !== null} onUpdate={update} />)}
  </main>;
}

function ApprovalForm({ organization, busy, onUpdate }: {
  organization: Organization;
  busy: boolean;
  onUpdate: (organization: Organization, approved: boolean, maxRunMinutes: number, monthlyMinutes: number) => Promise<void>;
}) {
  const [maxRunMinutes, setMaxRunMinutes] = useState(organization.maxRunMinutes || 60);
  const [monthlyMinutes, setMonthlyMinutes] = useState(organization.monthlyMinutes || 60);
  useEffect(() => {
    setMaxRunMinutes(organization.maxRunMinutes || 60);
    setMonthlyMinutes(organization.monthlyMinutes || 60);
  }, [organization.maxRunMinutes, organization.monthlyMinutes]);

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onUpdate(organization, true, maxRunMinutes, monthlyMinutes);
  }

  const usedHours = (organization.usedMinutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const approvedAt = organization.approvedAt ? new Date(organization.approvedAt).toLocaleString() : null;

  return <section className="organization-panel" aria-labelledby={`organization-${organization.id}`}>
    <div><h2 id={`organization-${organization.id}`}>{organization.name}</h2><p>{organization.slug}</p></div>
    <p>Status: <strong>{organization.approved ? "Approved" : organization.approvedAt ? "Revoked" : "Pending"}</strong></p>
    {organization.approved && <p>{usedHours} of {organization.monthlyMinutes / 60} run hours reserved this month{approvedAt ? ` · Approved ${approvedAt}` : ""}</p>}
    <form className="organization-form" onSubmit={approve}>
      <label>Maximum run duration
        <Select value={String(maxRunMinutes)} onChange={(event) => setMaxRunMinutes(Number(event.target.value))} disabled={busy}>
          <option value="60">1 hour</option><option value="120">2 hours</option>
        </Select>
      </label>
      <label>Monthly allowance
        <Select value={String(monthlyMinutes)} onChange={(event) => setMonthlyMinutes(Number(event.target.value))} disabled={busy}>
          {allowanceHours.map((hours) => <option key={hours} value={hours * 60}>{hours} {hours === 1 ? "hour" : "hours"}</option>)}
        </Select>
      </label>
      <div className="auth-actions">
        <button className="button success" disabled={busy} type="submit">{organization.approved ? "Save limits" : "Approve AWS access"}</button>
        {organization.approved && <button className="button danger" disabled={busy} type="button" onClick={() => void onUpdate(organization, false, maxRunMinutes, monthlyMinutes)}>Revoke access</button>}
      </div>
    </form>
  </section>;
}
