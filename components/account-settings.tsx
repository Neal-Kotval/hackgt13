"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import "./account-settings.css";

type Settings = { maxActiveEnvironments: number; activeEnvironments: number };

async function readSettings(response: Response): Promise<Settings> {
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not update account settings. Please try again.");
  return body;
}

export function AccountSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [limit, setLimit] = useState(1);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch("/api/account/settings", { signal: controller.signal, cache: "no-store" })
      .then(readSettings)
      .then(value => {
        if (controller.signal.aborted) return;
        setSettings(value);
        setLimit(value.maxActiveEnvironments);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load account settings. Please try again.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !settings || limit === settings.maxActiveEnvironments) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const value = await readSettings(await fetch("/api/account/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxActiveEnvironments: limit }),
      }));
      setSettings(value);
      setLimit(value.maxActiveEnvironments);
      setNotice("Account settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save account settings. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const dirty = settings !== null && limit !== settings.maxActiveEnvironments;

  return <main className="account-settings-page">
    <header className="account-settings-heading">
      <h1>Account settings</h1>
      <p>Manage cloud environment limits for your account.</p>
    </header>
    <section className="account-settings-panel" aria-labelledby="cloud-environments-heading">
      <h2 id="cloud-environments-heading">Cloud environments</h2>
      <p>This limit applies to AWS and Runpod environments you create across all your projects and organizations.</p>
      {loading ? <SkeletonRegion label="Loading account settings" className="account-settings-loading">
        <Skeleton width="50" /><Skeleton variant="control" /><Skeleton width="90" /><Skeleton variant="control" width="50" />
      </SkeletonRegion> : settings ? <form className="account-settings-form" onSubmit={save} aria-busy={pending}>
        <div className="account-settings-field">
          <label htmlFor="max-active-environments">Maximum active cloud environments</label>
          <Select id="max-active-environments" name="maxActiveEnvironments" value={limit} disabled={pending}
            aria-describedby="environment-limit-help environment-limit-usage"
            onChange={event => { setLimit(Number(event.target.value)); setNotice(""); setError(""); }}>
            {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} {value === 1 ? "environment" : "environments"}</option>)}
          </Select>
        </div>
        <p id="environment-limit-usage"><strong>{settings.activeEnvironments} of {settings.maxActiveEnvironments} slots in use</strong> at last refresh.</p>
        <div id="environment-limit-help" className="account-settings-help">
          <p>Queued, starting, and running environments count toward your limit. AWS frees a slot when it accepts termination; other providers and failed environments count until cleanup finishes.</p>
          <p>Lowering the limit leaves existing environments running. New environments must wait for a free slot. Organization budgets and approvals still apply.</p>
        </div>
        <div className="account-settings-actions">
          <button className="button primary" type="submit" disabled={pending || !dirty}>{pending ? "Saving…" : "Save changes"}</button>
          {dirty && !pending && <span className="muted">Unsaved changes</span>}
        </div>
      </form> : <button className="button" type="button" onClick={() => setAttempt(value => value + 1)}>Retry loading settings</button>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="auth-success" role="status">{notice}</p>}
    </section>
  </main>;
}
