# Artifact homes and workspace-to-publish competition

## Is the run-box / artifact-home separation technically sensible?

### Takeaway
Yes. Separating mutable development compute from independently deployed output is a mature pattern. The value has to come from making the transition and agent-to-agent development workflow clearer or safer, because the separation alone is not novel.

### Cited Findings
- Replit distinguishes the Project Editor and its development database from the published app and its production database; Replit says the Agent can modify development tables but cannot modify production data directly. — [Replit development and production databases](https://docs.replit.com/features/data-and-storage/development-and-production)
- Replit's published apps can be public, password protected, workspace only, or invite only. The last two use Replit sign-in to enforce access. — [Replit published-app access](https://docs.replit.com/features/publishing/private-deployments)
- Vercel distinguishes local, preview, and production environments; its CLI can deploy a preview URL before a separate production deploy. — [Vercel deployment overview](https://vercel.com/docs/deployments/overview); [Vercel CLI flow](https://vercel.com/docs/projects/deploy-from-cli)
- Render's default service filesystem is ephemeral; durable data requires a managed datastore, custom datastore, or persistent disk. It has a build/health-based deploy sequence and retains the old instance if a new build fails. — [Render deploys](https://render.com/docs/deploys)
- Railway gives each environment an isolated private network with internal DNS. Services in different projects or environments cannot reach one another over that network. — [Railway private networking](https://docs.railway.com/networking/private-networking); [Railway domains](https://docs.railway.com/networking/domains/working-with-domains)

### Inferences
- Treat run boxes as disposable compute and artifact homes as named deployments with their own revision, access policy, health, logs, durable data, and rollback path. The publish operation should promote an immutable source revision/build, not copy the run box's mutable filesystem.
- Private development endpoints need an enforced network/access boundary, not just hidden URLs or a registry field. AgentCloud should define who may call each service, whether a browser user can open it, and how an endpoint expires when its run terminates.
- “Artifact home” is a good user-facing abstraction only if it simplifies one workflow. Websites, APIs, and editable wikis have different persistence, auth, backup, and runtime needs; bundling all three into an initial version multiplies operational burden.

### Gaps
- I found no independent reliability or cost comparison for AgentCloud's proposed infrastructure, since it is not implemented. Specific hosting architecture and price points cannot be validated from competitor documentation.

## What existing platforms already bridge workspace to deployment and private previews?

### Takeaway
The broad “agent builds an app, then publishes it” flow is crowded. Replit is the most direct integrated comparison; Coder is a direct comparison for agent workspaces and private development ports; Railway, Render, and Vercel cover deployment and previews well.

### Cited Findings
- Replit documents published deployment types for static sites, autoscaling apps, always-on reserved VMs, and scheduled jobs. Its product documentation also lists project artifacts, native Agent, publishing, monitoring, and app storage in one workspace. — [Replit deployment types](https://docs.replit.com/features/publishing/deployment-types); [Replit publishing/access documentation](https://docs.replit.com/features/publishing/private-deployments)
- Replit separates development and production databases at publish time, including different live-data permissions for its Agent. — [Replit development and production databases](https://docs.replit.com/features/data-and-storage/development-and-production)
- Coder Agents now provides a chat/API for delegated development work and provisions workspaces for tasks that need filesystem or command access. The agent loop runs in Coder's control plane and executes tools in workspaces under the user's identity and permissions. — [Coder Agents](https://coder.com/docs/ai-coder/agents)
- Coder can forward workspace ports to browsers or clients. Its documented share settings include owner, organization, authenticated users, and public; administrators can limit sharing in licensed deployments. — [Coder workspace ports](https://coder.com/beta-docs/user-guides/workspace-access/port-forwarding/)
- Coder's security guidance specifically warns about same-origin risk for workspace apps and recommends a separate wildcard domain; it also recommends restricting port-sharing levels. — [Coder security best practices](https://coder.com/docs/tutorials/best-practices/security-best-practices)
- Railway provides private service-to-service domains inside a project/environment, and PR environments can deploy copies of a base environment for previews. — [Railway private networking](https://docs.railway.com/networking/private-networking); [Railway PR environments](https://docs.railway.com/guides/preview-deployments-with-pr-environments)
- Render offers private services with no public subdomain, plus PR preview environments that replicate services/datastores from a blueprint and are deleted when the PR closes. — [Render private services](https://render.com/docs/private-services); [Render preview environments](https://render.com/docs/preview-environments)
- Vercel has protected preview and production deployment URLs with project-level access settings, though some scopes or methods depend on plan. — [Vercel deployment protection](https://vercel.com/docs/deployment-protection)

### Inferences
- “Run boxes plus stable artifact homes” is a good architecture description but a weak market wedge by itself. Replit already bundles agent building and publishing, while Coder already addresses agent workspaces and private ports. Positioning must name a workflow those products handle awkwardly, such as two independent coding agents composing a frontend and private API with explicit service contracts and approval-based promotion.
- The closest useful comparison is likely not just Coder Spaces. It is Replit for app creation/publishing, Coder for controlled agent execution, and Railway/Render/Vercel for deployment. AgentCloud would be entering the seam among all of them.
- A deployment platform integration may be a faster test than implementing artifact infrastructure. AgentCloud could own service discovery, cross-agent handoff, revision provenance, and publish approval while sending final builds to an existing host.

### Gaps
- Official docs establish feature existence, not how well multi-agent collaboration works in practice. I found no directly comparable primary-source user outcome metrics for the proposed AgentCloud workflow.
- I did not verify pricing because plan limits and usage charges change frequently and a fair workload model is not yet defined.

## What is a narrow beachhead and what would falsify it?

### Takeaway
The best initial test is a two-agent internal tool: one agent builds a small API, another builds a site against its private development endpoint, and a human publishes a reviewed version. This tests the proposed coordination advantage without first building a general hosting platform.

### Cited Findings
- Coder shows that authenticated workspace port sharing and agent workspaces are independently available. — [Coder workspace ports](https://coder.com/beta-docs/user-guides/workspace-access/port-forwarding/); [Coder Agents](https://coder.com/docs/ai-coder/agents)
- Railway and Render already provide private networking and preview/deployment primitives that could host the output. — [Railway private networking](https://docs.railway.com/networking/private-networking); [Render private services](https://render.com/docs/private-services); [Render preview environments](https://render.com/docs/preview-environments)
- Replit already offers an integrated create-to-publish path, so a single-agent site publishing demo would not isolate AgentCloud's proposed advantage. — [Replit deployment types](https://docs.replit.com/features/publishing/deployment-types); [Replit development and production databases](https://docs.replit.com/features/data-and-storage/development-and-production)

### Inferences
- Beachhead user: a small engineering or operations team that already uses two coding agents to build internal tools and repeatedly loses time coordinating API availability, interface changes, deploy revisions, and ownership. Build a single project with a site and API, one ephemeral run per agent, one private API endpoint with enforced access, a contract/version handoff, then an approved publish to an existing hosting provider.
- Measure: time from assignment to both agents making a successful integration request; handoff failures due to stale URL/schema; number of manual coordination messages; successful health check of the published artifact after both run boxes stop; and whether users choose this flow again for the next project.
- Falsify the wedge if comparable teams prefer a shared GitHub PR plus existing Coder/Replit/Railway/Render workflow; if private endpoint setup takes longer than it saves; if agent-to-agent work is too rare; if manual schema changes are the real bottleneck; or if the artifact is abandoned after the demo rather than needing a long-lived home.
- Scope the first artifact home to a stateless site plus API, with external managed storage if needed. Defer editable wikis until there is evidence that their lifecycle is the same customer job; content editing and backup semantics likely differ.

### Gaps
- These adoption thresholds are hypotheses. No user interviews, baseline workflow timing, or cohort data were provided. A credible go/no-go threshold should be set before the pilot, using the teams' present process as baseline.
