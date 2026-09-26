import Link from "next/link";
import type { Project } from "@/lib/types";

type Edge = {
  id: string;
  from: string;
  relation: string;
  to: string;
  evidence: string;
  href: string;
};

export function ResourceGraph({ project }: { project: Project }) {
  const base = `/projects/${project.id}`;
  const agent = (id: string) => project.agents.find((item) => item.id === id)?.name || "Unknown agent";
  const task = (id: string) => project.tasks.find((item) => item.id === id)?.title || "Unknown task";
  const resource = (id: string) => (project.resources ?? []).find((item) => item.id === id)?.name || "Unknown resource";
  const edges: Edge[] = [];

  for (const item of project.tasks) {
    edges.push({ id: `task-${item.id}`, from: project.name, relation: "contains task", to: item.title, evidence: item.status, href: base });
    edges.push({ id: `owner-${item.id}`, from: item.title, relation: "assigned to", to: agent(item.owner), evidence: "recorded assignment", href: base + "/agents" });
  }
  for (const item of project.resourceRequests ?? []) {
    edges.push({
      id: `request-${item.id}`,
      from: item.taskId ? task(item.taskId) : project.name,
      relation: "requests",
      to: item.resourceId ? resource(item.resourceId) : item.kind,
      evidence: `${item.status} · policy ${item.decision.status.replaceAll("_", " ")}`,
      href: base + "/requests",
    });
    if (item.agentId) edges.push({
      id: `request-agent-${item.id}`,
      from: agent(item.agentId),
      relation: "named on request",
      to: item.resourceId ? resource(item.resourceId) : item.kind,
      evidence: "requested access only",
      href: base + "/requests",
    });
  }
  for (const item of project.services) {
    edges.push({ id: `service-${item.id}`, from: agent(item.owner), relation: "registered service", to: item.name, evidence: "health unverified", href: base });
  }
  for (const item of project.handoffs) {
    edges.push({ id: `handoff-${item.id}`, from: agent(item.from), relation: "sent handoff to", to: agent(item.to), evidence: item.accepted ? "accepted" : "awaiting review", href: base + "/review" });
  }
  const unlinkedResources = (project.resources ?? []).filter(
    (item) => !(project.resourceRequests ?? []).some((request) => request.resourceId === item.id),
  );
  const unlinkedAgents = project.agents.filter(
    (item) =>
      !project.tasks.some((task) => task.owner === item.id) &&
      !project.services.some((service) => service.owner === item.id) &&
      !project.handoffs.some((handoff) => handoff.from === item.id || handoff.to === item.id) &&
      !(project.resourceRequests ?? []).some((request) => request.agentId === item.id),
  );

  return (
    <section className="graph-page" aria-labelledby="graph-title">
      <div className="graph-intro">
        <div>
          <p className="eyebrow">Persisted relationships</p>
          <h2 id="graph-title">Resource graph</h2>
          <p>Connections come from project records. A request is an intent, not an allocation or verified path to a machine.</p>
        </div>
        <span className="tag neutral">{edges.length} relationships</span>
      </div>
      {edges.length ? (
        <div className="graph-edges" role="list">
          {edges.map((edge) => (
            <div key={edge.id} role="listitem">
              <Link className="graph-edge" href={edge.href}>
                <span className="graph-node">{edge.from}</span>
                <span className="graph-relation">{edge.relation}</span>
                <span className="graph-node">{edge.to}</span>
                <span className="graph-evidence">{edge.evidence}</span>
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <h3>No relationships recorded</h3>
          <p>Add an agent and task, register a resource, or create a request to build this view from real project records.</p>
          <Link className="button secondary" href={base + "/resources"}>Open resources</Link>
        </div>
      )}
      {(unlinkedResources.length > 0 || unlinkedAgents.length > 0) && (
        <section className="graph-standalone" aria-labelledby="graph-standalone-title">
          <h3 id="graph-standalone-title">Recorded without a relationship</h3>
          <p>These records exist in the project, but no saved request, assignment, service, or handoff links them yet.</p>
          <div className="graph-node-grid">
            {unlinkedResources.map((item) => (
              <Link href={base + "/resources"} key={item.id} className="graph-standalone-node">
                <strong>{item.name}</strong>
                <span>{item.kind} · {item.status}</span>
              </Link>
            ))}
            {unlinkedAgents.map((item) => (
              <Link href={base + "/agents"} key={item.id} className="graph-standalone-node">
                <strong>{item.name}</strong>
                <span>agent identity · {item.status}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <p className="graph-footnote">Employee identities, run boxes, GPU allocations, and verified access will appear only after those systems record real evidence.</p>
    </section>
  );
}
