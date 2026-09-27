"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SkeletonPanel, SkeletonRegion } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { authClient as client } from "@/lib/auth-client";
import type { Project } from "@/lib/types";
import { ProjectCodex, useProjectJobs } from "./codex";
import { ProjectMemory } from "./memory";
import "./project-settings.css";

type Visibility = "private" | "public";
type Machine = {
  id: string; kind: "cpu" | "gpu"; size: string; instanceType: string; vcpu: number; memoryGib: number;
  gpu: null | { model: string; count: number; memoryGib: number }; hourlyComputeUsd: number;
};
type Member = { userId: string; name: string; email: string; organizationRole: string; role: "owner" | "member"; implicit: boolean };
type Invitation = { id: string; email: string; role: "member" | "admin"; status: string; expiresAt: string | number; delivery: string | null };
type Settings = {
  project: { id: string; name: string; repo: string; environmentDefaults: { machineId: string | null; visibility: Visibility; sharedMemory: boolean } };
  viewer: { id: string; projectRole: "owner" | "member"; organizationRole: string };
  organization: { id: string; name: string };
  permissions: { edit: boolean; invite: boolean };
  members: Member[];
  candidates: { userId: string; name: string; email: string }[];
  invitations: Invitation[];
  mailMode: "local" | "smtp" | "unavailable";
  machines: Machine[];
};
type Feedback = { tone: "error" | "success"; text: string } | null;

const sections = [
  ["general", "General"],
  ["defaults", "Environment defaults"],
  ["members", "Members"],
  ["codex", "Codex"],
  ["memory", "Shared memory"],
] as const;

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The request failed. Please try again.");
  return data;
}

function machineLabel(machine: Machine) {
  const hardware = machine.gpu ? `${machine.gpu.model}, ${machine.vcpu} vCPU` : `${machine.vcpu} vCPU, ${machine.memoryGib} GiB`;
  return `${machine.kind === "gpu" ? "GPU" : "CPU"} ${machine.size} · ${hardware}`;
}

function Status({ feedback }: { feedback: Feedback }) {
  if (!feedback) return <p className="visually-hidden" role="status" />;
  return <p className={`resource-feedback resource-feedback--${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>;
}

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return <section id={`settings-${id}`} className="project-settings-section" aria-labelledby={`settings-${id}-title`} tabIndex={-1}>
    <header>
      <h2 id={`settings-${id}-title`}>{title}</h2>
      <p>{description}</p>
    </header>
    {children}
  </section>;
}

/** Project Settings: the project itself. Per-environment setup lives on each environment's page. */
export function ProjectSettings({ project, onProjectChange }: { project: Project; onProjectChange?: () => Promise<void> | void }) {
  const [data, setData] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState("");
  const environments = useProjectJobs(project.id);
  async function load() {
    const next = await readJson(await fetch(`/api/projects/${encodeURIComponent(project.id)}/settings`, { cache: "no-store" }));
    setData(next);
    setLoadError("");
    return next as Settings;
  }
  useEffect(() => {
    setData(null);
    load().catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Could not load project settings."));
  // Reload when the selected project changes.
  }, [project.id]);

  return <div className="project-settings">
    <nav className="project-settings-nav" aria-label="Settings sections">
      {sections.map(([id, label]) => <a key={id} href={`#settings-${id}`}>{label}</a>)}
    </nav>
    {loadError && <div className="resource-feedback resource-feedback--error" role="alert">{loadError}<button className="button" type="button" onClick={() => void load().catch((cause) => setLoadError(cause.message))}>Try again</button></div>}
    {!data && !loadError && <SkeletonRegion label="Loading project settings" className="project-settings-skeleton"><SkeletonPanel rows={2} icon={false} action /><SkeletonPanel rows={2} icon={false} /><SkeletonPanel rows={2} icon={false} /></SkeletonRegion>}
    {data && <>
      <General data={data} onSaved={async () => { await load(); await onProjectChange?.(); }} />
      <Defaults data={data} onSaved={load} />
      <Members data={data} reload={load} />
    </>}
    <Section id="codex" title="Codex" description="Codex for this project's environments. Each environment signs in to ChatGPT separately; chats in that environment share its account and workspace.">
      <ProjectCodex projectId={project.id} owner={data ? data.permissions.edit : false} {...environments} />
    </Section>
    {data && <Section id="memory" title="Shared memory" description="Backboard lets agents in different environments share short facts about this project. It is chosen per environment.">
      <ProjectMemory projectId={project.id} defaults={data.project.environmentDefaults} editable={data.permissions.edit} jobs={environments.jobs} onDefaultsSaved={load} />
    </Section>}
  </div>;
}

function OwnerNote({ show, children }: { show: boolean; children: ReactNode }) {
  return show ? <p className="project-settings-note">{children}</p> : null;
}

function General({ data, onSaved }: { data: Settings; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(data.project.name);
  const [repo, setRepo] = useState(data.project.repo);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const editable = data.permissions.edit;
  const changed = name.trim() !== data.project.name || repo.trim() !== data.project.repo;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await readJson(await fetch(`/api/projects/${encodeURIComponent(data.project.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), repo: repo.trim() }),
      }));
      await onSaved();
      setFeedback({ tone: "success", text: "Project details saved." });
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "Could not save project details." });
    } finally {
      setBusy(false);
    }
  }
  return <Section id="general" title="General" description="The project name and the repository new environments clone.">
    <form className="resource-panel project-settings-form" onSubmit={save} aria-describedby={editable ? undefined : "settings-general-owner"}>
      <OwnerNote show={!editable}><span id="settings-general-owner">Only project owners can change these details.</span></OwnerNote>
      <label>Project name
        <input name="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} disabled={!editable || busy} />
      </label>
      <label>Repository URL
        <input name="repo" type="url" value={repo} onChange={(event) => setRepo(event.target.value)} required pattern="https://.+" maxLength={500} disabled={!editable || busy} aria-describedby="settings-repo-help" />
        <small id="settings-repo-help">An HTTPS URL without credentials. Environments that already exist keep the repository they cloned.</small>
      </label>
      <Status feedback={feedback} />
      {editable && <div className="project-settings-actions">
        <button className="button primary" disabled={!changed || busy}>{busy ? "Saving…" : "Save details"}</button>
        {changed && !busy && <button className="button ghost" type="button" onClick={() => { setName(data.project.name); setRepo(data.project.repo); setFeedback(null); }}>Discard changes</button>}
      </div>}
    </form>
  </Section>;
}

function Defaults({ data, onSaved }: { data: Settings; onSaved: () => Promise<unknown> }) {
  const saved = data.project.environmentDefaults;
  const [machineId, setMachineId] = useState(saved.machineId ?? "");
  const [visibility, setVisibility] = useState<Visibility>(saved.visibility);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const editable = data.permissions.edit;
  const changed = machineId !== (saved.machineId ?? "") || visibility !== saved.visibility;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await readJson(await fetch(`/api/projects/${encodeURIComponent(data.project.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environmentDefaults: { machineId: machineId || null, visibility } }),
      }));
      await onSaved();
      setFeedback({ tone: "success", text: "Environment defaults saved." });
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "Could not save environment defaults." });
    } finally {
      setBusy(false);
    }
  }
  return <Section id="defaults" title="Environment defaults" description="What the new environment form starts with. People can still change them for each environment.">
    <form className="resource-panel project-settings-form" onSubmit={save}>
      <OwnerNote show={!editable}>Only project owners can change the defaults.</OwnerNote>
      <label>Default machine size
        <Select name="machineId" value={machineId} disabled={!editable || busy} onChange={(event) => setMachineId(event.target.value)} aria-describedby="settings-machine-help">
          <option value="">No default</option>
          {data.machines.map((machine) => <option key={machine.id} value={machine.id}>{machineLabel(machine)}</option>)}
        </Select>
        <small id="settings-machine-help">AWS sizes. Hourly prices are shown when an environment is requested.</small>
      </label>
      <fieldset className="project-settings-choice" disabled={!editable || busy}>
        <legend>Default visibility</legend>
        {([
          ["private", "Private", "Only the person who starts an environment can see and use it."],
          ["public", "Project", "Everyone in this project can see, open, and use it. Only its creator or an owner can rename or delete it."],
        ] as const).map(([value, label, help]) => <label key={value} className={visibility === value ? "chosen" : ""}>
          <input type="radio" name="visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} />
          <span><strong>{label}</strong><small>{help}</small></span>
        </label>)}
      </fieldset>
      <Status feedback={feedback} />
      {editable && <div className="project-settings-actions">
        <button className="button primary" disabled={!changed || busy}>{busy ? "Saving…" : "Save defaults"}</button>
      </div>}
    </form>
  </Section>;
}

function Members({ data, reload }: { data: Settings; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const invite = data.permissions.invite;
  const mailUnavailable = data.mailMode === "unavailable";
  async function run(operation: () => Promise<unknown>, message: string) {
    setBusy(true);
    setFeedback(null);
    try {
      await operation();
      await reload();
      setFeedback({ tone: "success", text: message });
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : "The request failed. Please try again." });
    } finally {
      setBusy(false);
    }
  }
  function checked(result: { error?: { message?: string } | null }) {
    if (result.error) throw new Error(result.error.message || "Request failed");
  }
  async function access(userId: string, allowed: boolean) {
    await readJson(await fetch("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "setProjectAccess", projectId: data.project.id, userId, allowed }),
    }));
  }
  function sendInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mailUnavailable) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    void run(async () => {
      checked(await client.organization.inviteMember({ email: String(values.get("email")).trim(), role: "member", organizationId: data.organization.id }));
      form.reset();
    }, data.mailMode === "local" ? "Invitation captured in the local mailbox. No external email was sent." : "Invitation sent.");
  }
  const deliveryNote = mailUnavailable
    ? "Email delivery is unavailable. Ask an administrator to configure SMTP before inviting people."
    : data.mailMode === "local"
      ? "Development mailbox: invitations are captured locally, not delivered."
      : `Invitations are emailed and add people to ${data.organization.name}. Give them access to this project once they accept.`;
  return <Section id="members" title="Members" description={`People who can open this project. Owners and admins of ${data.organization.name} can open every project.`}>
    <div className="resource-panel project-settings-panel">
      <ul className="project-settings-list" aria-label="Project members">
        {data.members.map((member) => <li key={member.userId}>
          <div>
            <strong>{member.name}{member.userId === data.viewer.id ? " (you)" : ""}</strong>
            <p>{member.email}</p>
          </div>
          <span className="project-settings-role">{member.implicit ? `Owner · organization ${member.organizationRole}` : member.role === "owner" ? "Owner" : "Member"}</span>
          {invite && !member.implicit && <button className="button danger" type="button" disabled={busy} onClick={() => {
            if (window.confirm(`Remove ${member.name}'s access to this project? They stay in ${data.organization.name}.`))
              void run(() => access(member.userId, false), "Project access removed.");
          }}>Remove access</button>}
        </li>)}
      </ul>
    </div>
    {!invite && <p className="project-settings-note">Only owners and admins of {data.organization.name} can invite people or change project access. Your organization role: {data.viewer.organizationRole}.</p>}
    {invite && data.candidates.length > 0 && <form className="resource-panel project-settings-form project-settings-inline" onSubmit={(event) => {
      event.preventDefault();
      const userId = String(new FormData(event.currentTarget).get("userId") || "");
      if (userId) void run(() => access(userId, true), "Project access granted.");
    }}>
      <h3>Add from {data.organization.name}</h3>
      <div className="project-settings-row">
        <label><span className="visually-hidden">Organization member</span>
          <Select name="userId" required aria-label="Organization member"><option value="">Choose a person</option>{data.candidates.map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.name} · {candidate.email}</option>)}</Select>
        </label>
        <button className="button success" disabled={busy}>Grant access</button>
      </div>
    </form>}
    {invite && <form className="resource-panel project-settings-form project-settings-inline" onSubmit={sendInvite}>
      <h3>Invite by email</h3>
      <p className="project-settings-note" id="settings-invite-delivery">{deliveryNote}</p>
      <div className="project-settings-row">
        <label><span className="visually-hidden">Email address</span>
          <input name="email" type="email" placeholder="teammate@company.com" required autoComplete="off" disabled={busy || mailUnavailable} aria-describedby="settings-invite-delivery" />
        </label>
        <button className="button primary" disabled={busy || mailUnavailable}>Send invitation</button>
      </div>
    </form>}
    {invite && data.invitations.length > 0 && <div className="resource-panel project-settings-panel project-settings-inline">
        <h3>Pending invitations</h3>
        <ul className="project-settings-list" aria-label="Pending invitations">
          {data.invitations.map((invitation) => {
            const expired = new Date(invitation.expiresAt).getTime() < Date.now();
            const delivery = invitation.delivery === "captured" ? "Captured locally" : invitation.delivery === "submitted" ? "Sent" : invitation.delivery === "failed" ? "Email failed" : "Email status unavailable";
            return <li key={invitation.id}>
              <div><strong>{invitation.email}</strong><p>{invitation.role} · {expired ? "expired" : "pending"} · {delivery}</p></div>
              <div className="project-settings-actions">
                <button className="button" type="button" disabled={busy || mailUnavailable} onClick={() => void run(async () => {
                  checked(await client.organization.inviteMember({ email: invitation.email, role: invitation.role, organizationId: data.organization.id }));
                }, "Invitation resent. The previous link no longer works.")}>Resend</button>
                <button className="button danger" type="button" disabled={busy} onClick={() => void run(async () => {
                  checked(await client.organization.cancelInvitation({ invitationId: invitation.id }));
                }, "Invitation revoked.")}>Revoke</button>
              </div>
            </li>;
          })}
        </ul>
    </div>}
    <Status feedback={feedback} />
  </Section>;
}
