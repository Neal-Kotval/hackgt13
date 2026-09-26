"use client";

import { useState } from "react";
import {
  Pulse as ActivityIcon,
  Clock,
  Command,
  Info,
  PlugsConnected,
  TerminalWindow,
  Warning,
} from "@phosphor-icons/react";
import type { Activity, Agent, Project } from "@/lib/types";
import styles from "./run-control.module.css";

const executionKinds = new Set([
  "run-started",
  "run-completed",
  "run-failed",
  "command-started",
  "command-result",
  "model-output",
]);

function timestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function actorName(project: Project, actor: string) {
  if (actor === "human") return "Local administrator";
  return project.agents.find((agent) => agent.id === actor)?.name ?? actor;
}

function AgentCard({ agent, project }: { agent: Agent; project: Project }) {
  const assigned = project.tasks.filter((task) => task.owner === agent.id);
  const active = assigned.find((task) => task.status === "in progress");
  const connected = agent.status === "connected";
  return (
    <article className={styles.agentCard}>
      <div className={styles.agentTop}>
        <div>
          <h3>{agent.name}</h3>
          <p>{agent.role}</p>
        </div>
        <span className={`${styles.status} ${connected ? styles.connected : ""}`}>
          {connected ? <PlugsConnected aria-hidden="true" /> : <Warning aria-hidden="true" />}
          {connected ? "Transport connected" : "Transport disconnected"}
        </span>
      </div>
      <dl className={styles.agentFacts}>
        <div>
          <dt>Client identity</dt>
          <dd>{agent.client}</dd>
        </div>
        <div>
          <dt>Last heartbeat</dt>
          <dd>{agent.lastSeen ? <time dateTime={agent.lastSeen}>{timestamp(agent.lastSeen)}</time> : "None recorded"}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{active ? `${active.title} · in progress` : assigned.length ? `${assigned.length} assigned; none in progress` : "No task assigned"}</dd>
        </div>
      </dl>
      <p className={styles.agentCaveat}>A heartbeat confirms the coordination client is reachable. It does not confirm a model session or remote shell.</p>
    </article>
  );
}

function EventRow({ event, project }: { event: Activity; project: Project }) {
  const execution = executionKinds.has(event.kind);
  return (
    <li className={styles.eventRow}>
      <span className={`${styles.eventIcon} ${execution ? styles.executionIcon : ""}`} aria-hidden="true">
        {execution ? <Command /> : <ActivityIcon />}
      </span>
      <div className={styles.eventContent}>
        <div className={styles.eventMeta}>
          <strong>{actorName(project, event.actor)}</strong>
          <span>{event.kind.replaceAll("-", " ")}</span>
          <time dateTime={event.time}>{timestamp(event.time)}</time>
        </div>
        <p>{event.text}</p>
        {execution && event.detail && <pre className={styles.commandOutput}>{event.detail}</pre>}
      </div>
    </li>
  );
}

export function RunControl({ project }: { project: Project }) {
  const [selectedAgent, setSelectedAgent] = useState("all");
  const events = project.events.filter((event) => selectedAgent === "all" || event.actor === selectedAgent);
  const executionEvents = project.events.filter((event) => executionKinds.has(event.kind));

  return (
    <section className={styles.root} aria-labelledby="runs-heading">
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Run control / {project.name}</p>
          <h2 id="runs-heading">Agent runs</h2>
          <p>Observe connected identities and persisted activity. Remote execution will appear here when a runner reports it.</p>
        </div>
        <span className={styles.localBoundary}>Local coordination only</span>
      </header>

      <div className={styles.summaryGrid}>
        <section className={styles.summaryCard} aria-labelledby="transport-heading">
          <PlugsConnected aria-hidden="true" />
          <div>
            <h2 id="transport-heading">Transport</h2>
            <strong>{project.agents.filter((agent) => agent.status === "connected").length} of {project.agents.length} connected</strong>
            <p>Based on coordination-client heartbeat.</p>
          </div>
        </section>
        <section className={styles.summaryCard} aria-labelledby="execution-heading">
          <TerminalWindow aria-hidden="true" />
          <div>
            <h2 id="execution-heading">Model execution</h2>
            <strong>{executionEvents.length ? `${executionEvents.length} execution events` : "No run reported"}</strong>
            <p>{executionEvents.length ? "Events reported by the connected runner." : "No agent adapter or remote runner is connected."}</p>
          </div>
        </section>
        <section className={styles.summaryCard} aria-labelledby="task-heading">
          <Clock aria-hidden="true" />
          <div>
            <h2 id="task-heading">Task progress</h2>
            <strong>{project.tasks.filter((task) => task.status === "in progress").length} in progress</strong>
            <p>Task status is a coordination record, not command evidence.</p>
          </div>
        </section>
      </div>

      <section className={styles.section} aria-labelledby="identities-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Identities</p>
            <h2 id="identities-heading">Agent identities</h2>
          </div>
          <span>{project.agents.length} registered</span>
        </div>
        {project.agents.length ? (
          <div className={styles.agentGrid}>
            {project.agents.map((agent) => <AgentCard key={agent.id} agent={agent} project={project} />)}
          </div>
        ) : (
          <div className={styles.empty}>
            <PlugsConnected aria-hidden="true" />
            <h3>No agent identities yet</h3>
            <p>Connect an agent identity to this project to see its transport status and assigned work.</p>
          </div>
        )}
      </section>

      <div className={styles.lowerGrid}>
        <section className={styles.section} aria-labelledby="activity-heading">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Persisted events</p>
              <h2 id="activity-heading">Run activity</h2>
            </div>
            <label className={styles.filterLabel}>
              Identity
              <select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>
                <option value="all">All identities</option>
                <option value="human">Local administrator</option>
                {project.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
          </div>
          {events.length ? (
            <ol className={styles.eventList} aria-live="polite">
              {events.map((event) => <EventRow key={event.id} event={event} project={project} />)}
            </ol>
          ) : (
            <div className={styles.empty}>
              <ActivityIcon aria-hidden="true" />
              <h3>No activity for this identity</h3>
              <p>Events will appear when the coordination API records an action.</p>
            </div>
          )}
        </section>

        <section className={styles.section} aria-labelledby="console-heading">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Execution evidence</p>
              <h2 id="console-heading">Command results</h2>
            </div>
            <span>{executionEvents.length ? "Reported" : "Unavailable"}</span>
          </div>
          {executionEvents.length ? (
            <ol className={styles.executionList}>
              {executionEvents.map((event) => <EventRow key={event.id} event={event} project={project} />)}
            </ol>
          ) : (
            <div className={styles.consoleEmpty}>
              <Command aria-hidden="true" />
              <h3>No remote command results</h3>
              <p>A run box and agent adapter must report real command start, result, and bounded output before they can be shown here.</p>
            </div>
          )}
          <div className={styles.boundaryNote}>
            <Info aria-hidden="true" />
            <span>Only persisted events are displayed. Transport heartbeats are not model execution.</span>
          </div>
        </section>
      </div>
    </section>
  );
}
