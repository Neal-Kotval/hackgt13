"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { SkeletonRegion, SkeletonRows } from "@/components/ui/skeleton";
import { environmentHref, environmentLabel, type NamedJob } from "./codex";

type Fact = { id: string | null; content: string; createdAt: string | null; score: number | null };
type MemoryView = { available: false } | { available: true; created: boolean; query: string; memories: Fact[] };
type Defaults = { machineId: string | null; visibility: "private" | "public"; sharedMemory: boolean };

/**
 * Backboard shared memory for this project: the default for new environments, which running
 * environments have it on, and a read-only view of the facts agents saved.
 */
export function ProjectMemory({ projectId, defaults, editable, jobs, onDefaultsSaved }: {
  projectId: string;
  defaults: Defaults;
  editable: boolean;
  jobs: NamedJob[] | null;
  onDefaultsSaved: () => Promise<unknown>;
}) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  // Reflect the click at once; revert if the save fails.
  const [memoryDefault, setMemoryDefault] = useState(defaults.sharedMemory);
  useEffect(() => setMemoryDefault(defaults.sharedMemory), [defaults.sharedMemory]);

  async function load(q = "") {
    setSearching(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not load shared memory.");
      setView(data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load shared memory.");
    } finally {
      setSearching(false);
    }
  }
  useEffect(() => { void load(); }, [projectId]);

  async function toggleDefault(sharedMemory: boolean) {
    setSaving(true);
    setNotice("");
    setMemoryDefault(sharedMemory);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environmentDefaults: { ...defaults, sharedMemory } }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save the shared memory default.");
      await onDefaultsSaved();
      setNotice(sharedMemory ? "New environments will start with shared memory on." : "New environments will start with shared memory off.");
    } catch (cause) {
      setMemoryDefault(defaults.sharedMemory);
      setNotice(cause instanceof Error ? cause.message : "Could not save the shared memory default.");
    } finally {
      setSaving(false);
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(query.trim());
  }

  const running = jobs?.filter((job) => job.state !== "stopped") ?? [];
  const withMemory = running.filter((job) => job.memory?.enabled);
  const available = view?.available;

  return <div className="project-settings-memory">
    <div className="resource-panel project-settings-panel">
      {!view && !error && <SkeletonRegion label="Loading shared memory status"><SkeletonRows count={1} /></SkeletonRegion>}
      {view && <p className="project-settings-status" role="status">
        <span className={`resource-badge ${available ? "resource-badge--ready" : ""}`}>{available ? "Configured" : "Not configured"}</span>
        {available
          ? "Backboard is configured on this server. Environments with shared memory on recall and save facts for this project."
          : "Backboard is not configured on this server, so no environment can use shared memory. An administrator needs to add the Backboard key."}
      </p>}
      {available && jobs && <div className="project-settings-memory-environments">
        <h3>Environments with shared memory on</h3>
        {withMemory.length
          ? <ul>{withMemory.map((job) => <li key={job.id}><Link href={environmentHref(projectId, job.id)}>{environmentLabel(job)}</Link></li>)}</ul>
          : <p className="project-settings-note">{running.length ? "None of this project's environments have it on. Turn it on from an environment's page." : "This project has no running environments."}</p>}
      </div>}
      <label className="project-settings-check">
        <input type="checkbox" checked={memoryDefault} disabled={!editable || saving} onChange={(event) => void toggleDefault(event.target.checked)} aria-describedby="settings-memory-default-help" />
        <span><strong>Turn on shared memory for new environments</strong>
          <small id="settings-memory-default-help">{editable ? "People can still turn it off for each environment." : "Only project owners can change this default."}</small>
        </span>
      </label>
      {notice && <p className="project-settings-note" role="status">{notice}</p>}
    </div>
    {available && <div className="resource-panel project-settings-panel">
      <h3>Saved facts</h3>
      <form className="project-settings-row" role="search" onSubmit={search}>
        <label><span className="visually-hidden">Search saved facts</span>
          <input type="search" value={query} maxLength={500} placeholder="Search saved facts" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button className="button" disabled={searching}>{searching ? "Searching…" : "Search"}</button>
        {view.query && <button className="button ghost" type="button" disabled={searching} onClick={() => { setQuery(""); void load(); }}>Show all</button>}
      </form>
      {!view.created
        ? <p className="project-settings-note">No facts yet. The project's memory is created the first time an environment with shared memory runs a Codex turn.</p>
        : view.memories.length === 0
          ? <p className="project-settings-note">{view.query ? `No saved facts match “${view.query}”.` : "No saved facts yet."}</p>
          : <ul className="project-settings-list" aria-label={view.query ? `Facts matching ${view.query}` : "Saved facts"}>
            {view.memories.map((fact, index) => <li key={fact.id ?? index}>
              <div><p className="project-settings-fact">{fact.content}</p>{fact.createdAt && <p>{new Date(fact.createdAt).toLocaleString()}</p>}</div>
            </li>)}
          </ul>}
      <p className="project-settings-note">Read-only. Facts are what agents saved; they are not a view of anyone's computer.</p>
    </div>}
    {error && <div className="resource-feedback resource-feedback--error" role="alert">{error}<button className="button" type="button" onClick={() => void load(query.trim())}>Try again</button></div>}
  </div>;
}
