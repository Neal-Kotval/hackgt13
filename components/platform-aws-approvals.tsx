"use client";
import { SkeletonPanel, SkeletonRegion } from "@/components/ui/skeleton";

import { useEffect, useState, type FormEvent } from "react";
import { MagnifyingGlass, ShieldCheck, Buildings } from "@phosphor-icons/react";
import "./platform-admin.css";
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
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
    setError("");
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

  const counts = {
    all: organizations?.length ?? 0,
    pending: organizations?.filter((org) => !org.approved && !org.approvedAt).length ?? 0,
    approved: organizations?.filter((org) => org.approved).length ?? 0,
    revoked: organizations?.filter((org) => !org.approved && org.approvedAt).length ?? 0,
  };
  const visible = organizations?.filter((org) => {
    const status = org.approved ? "approved" : org.approvedAt ? "revoked" : "pending";
    return (filter === "all" || filter === status) && `${org.name} ${org.slug}`.toLowerCase().includes(query.trim().toLowerCase());
  });

  return <main className="admin-page">
    <header className="admin-heading">
      <div><h1>Platform administration</h1><p>Manage AWS environments, organization access, and run limits.</p></div>
      <span className="admin-scope"><ShieldCheck aria-hidden="true" /> Platform operator</span>
    </header>
    <PlatformAwsEnvironments />
    <section className="admin-access" aria-labelledby="aws-access-title">
      <header className="admin-section-heading"><div><h2 id="aws-access-title">Organization access</h2><p>Choose who can request alto-funded AWS runs and how much they can use.</p></div>
        {organizations && <span className="admin-count">{counts.all} {counts.all === 1 ? "organization" : "organizations"}</span>}
      </header>
      {error && <div className="admin-feedback" role="alert"><p className="auth-error">{error}</p><button className="button" onClick={() => void load().catch((failure) => setError(failure.message))}>Retry loading</button></div>}
      {notice && <p className="auth-success" role="status">{notice}</p>}
      {organizations === null ? !error && <SkeletonRegion label="Loading organizations"><SkeletonPanel rows={2} /></SkeletonRegion> : organizations.length === 0 ?
        <div className="admin-empty"><Buildings aria-hidden="true" /><h3>No organizations yet</h3><p>Organizations appear here when someone creates one. You can then approve access and set run limits.</p></div> : <>
        <div className="admin-toolbar">
          <div className="admin-filters" role="group" aria-label="Filter organizations by access">
            {(["all", "pending", "approved", "revoked"] as const).map((status) => <button key={status} type="button" aria-pressed={filter === status} onClick={() => setFilter(status)}>{status === "all" ? "All" : status === "pending" ? "Pending" : status === "approved" ? "Approved" : "Revoked"}<span>{counts[status]}</span></button>)}
          </div>
          <label className="admin-search"><MagnifyingGlass aria-hidden="true" /><span className="visually-hidden">Search organizations</span><input type="search" placeholder="Search organizations…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        <div className="admin-organization-list">
          {visible?.length ? visible.map((organization) => <ApprovalForm key={organization.id} organization={organization} busy={busyId !== null} saving={busyId === organization.id} onUpdate={update} />) : <div className="admin-empty"><h3>No matching organizations</h3><p>Try a different name or access filter.</p><button className="button" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div>}
        </div>
      </>}
      <p className="admin-footnote"><ShieldCheck aria-hidden="true" /> Approval permits new requests. It does not start a machine.</p>
    </section>
  </main>;
}

function ApprovalForm({ organization, busy, saving, onUpdate }: {
  organization: Organization;
  busy: boolean;
  saving: boolean;
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

  return <section className="admin-organization" aria-labelledby={`organization-${organization.id}`}>
    <div className="admin-organization-heading"><div><h3 id={`organization-${organization.id}`}>{organization.name}</h3><p>{organization.slug}</p></div>
    <span className={`admin-status admin-status--${organization.approved ? "approved" : organization.approvedAt ? "revoked" : "pending"}`}>{organization.approved ? "Approved" : organization.approvedAt ? "Revoked" : "Pending"}</span></div>
    {organization.approved ? <div className="admin-usage"><div><span>Monthly reservation</span><strong>{usedHours} / {organization.monthlyMinutes / 60} hours</strong></div><progress value={organization.usedMinutes} max={organization.monthlyMinutes} aria-label={`Monthly reserved hours for ${organization.name}`} /><p>Reserved run time, not measured usage.{approvedAt && <> Approved <time dateTime={organization.approvedAt!}>{approvedAt}</time>.</>}</p></div> : <p className="admin-organization-description">{organization.approvedAt ? "Access was revoked. Approve again to allow new AWS requests." : "Review the limits below to enable AWS requests."}</p>}
    <form className="admin-limits-form" onSubmit={approve}>
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
        <button className="button success" disabled={busy} type="submit">{saving ? "Saving…" : organization.approved ? "Save limits" : "Approve AWS access"}</button>
        {organization.approved && <button className="button danger" disabled={busy} type="button" onClick={() => void onUpdate(organization, false, maxRunMinutes, monthlyMinutes)}>Revoke access</button>}
      </div>
    </form>
  </section>;
}
