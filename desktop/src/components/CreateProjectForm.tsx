import { useId, useState } from "react";
import { ArrowRight, HardDrives } from "@phosphor-icons/react";
import { Select } from "./ui/Select";
import "./CreateProjectForm.css";

export type CreateProjectValues = {
  name: string;
  repo: string;
  template: string;
  compute: string;
  host?: string;
};

type CreateProjectFormProps = {
  busy: boolean;
  error: string | null;
  onCreate: (values: CreateProjectValues) => void;
};

export function CreateProjectForm({ busy, error, onCreate }: CreateProjectFormProps) {
  const [compute, setCompute] = useState("Hosted Linux");
  const id = useId();
  return (
    <section className="desktop-create-project" aria-labelledby={`${id}-heading`}>
      <header>
        <h2 id={`${id}-heading`}>Create a project</h2>
        <p>Add your repository and choose a compute source.</p>
      </header>
      <form aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const data = new FormData(event.currentTarget);
        onCreate({
          name: String(data.get("name") ?? "").trim(),
          repo: String(data.get("repo") ?? "").trim(),
          template: String(data.get("template") ?? "Next.js + Node API"),
          compute,
          ...(compute === "SSH machine" ? { host: String(data.get("host") ?? "").trim() } : {}),
        });
      }}>
        <div className="desktop-project-fields">
          <label htmlFor={`${id}-name`}>Project name
            <input id={`${id}-name`} name="name" placeholder="my-next-big-thing" required maxLength={60} pattern=".*\S.*" disabled={busy} />
          </label>
          <label htmlFor={`${id}-repo`}>Git repository
            <input id={`${id}-repo`} name="repo" type="url" placeholder="https://github.com/your-team/project" required pattern="https://.*" disabled={busy} autoCapitalize="none" spellCheck={false} />
          </label>
          <label htmlFor={`${id}-template`}>Template
            <Select id={`${id}-template`} name="template" disabled={busy}>
              <option>Next.js + Node API</option>
              <option>React + Python API</option>
              <option>Empty workspace</option>
            </Select>
          </label>
        </div>
        <fieldset disabled={busy} className="desktop-project-compute">
          <legend>Compute source</legend>
          <div className="desktop-project-compute-options">
            {["Hosted Linux", "SSH machine"].map((choice) => (
              <label key={choice} data-selected={compute === choice}>
                <input type="radio" name="compute" value={choice} checked={compute === choice} onChange={() => setCompute(choice)} />
                <HardDrives aria-hidden="true" />
                <span>{choice}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {compute === "SSH machine" && <label className="desktop-project-host" htmlFor={`${id}-host`}>SSH host
          <input id={`${id}-host`} name="host" placeholder="user@your-server" required maxLength={300} disabled={busy} autoCapitalize="none" spellCheck={false} />
        </label>}
        <p className="desktop-project-note">Saves project details. Repository cloning and environment setup happen separately.</p>
        {error && <p className="desktop-project-error" role="alert">{error}</p>}
        <div className="desktop-project-submit"><button type="submit" className="button primary" disabled={busy}>{busy ? "Creating…" : "Create project"}<ArrowRight aria-hidden="true" /></button></div>
      </form>
    </section>
  );
}
