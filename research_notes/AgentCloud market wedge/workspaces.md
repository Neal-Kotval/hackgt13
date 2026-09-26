# Developer workspace competitors (checked 2026-09-26)

## What workspace lifecycle do these products provide?

### Takeaway
Coder, GitHub Codespaces, Daytona, and Ona already provide disposable or stoppable development compute. The workspace or sandbox is a credible analogue for AgentCloud's **planned** run box; lifecycle management alone is not a wedge.

### Cited Findings
- Coder workspaces are Terraform-provisioned isolated compute, with resources that may persist across stops; deleting the workspace destroys all its resources. — [Coder workspace lifecycle](https://coder.com/docs/user-guides/workspace-lifecycle)
- Coder supports long-lived service-account-owned shared workspaces, including shared staging and QA environments; this documented pattern requires Premium. — [Coder persistent shared workspaces](https://coder.com/docs/tutorials/persistent-shared-workspaces)
- Codespaces preserve saved files across stop/restart, but stop running processes and automatically stop after inactivity (30 minutes by default); inactive spaces are deleted after 30 days by default. — [GitHub codespace lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle)
- Daytona supports stopped/paused/archived sandboxes; snapshots/forks preserve sandbox state, while independent volumes persist beyond sandbox deletion. — [Daytona persistence](https://www.daytona.io/docs/en/persistence/)
- Ona describes a fresh isolated environment per agent task and deployments in customers' VPCs; its marketing says these environments are disposable. — [Ona environment product page](https://ona.com/cases/ona-environments)

### Inferences
- Calling the planned AgentCloud run box "like a Coder workspace/Codespace" is fair at the compute layer, but Coder is the closer comparison because it includes enterprise policy, workspace sharing, and native agents.
- A long-running Coder workspace can host a staging app, but it remains a workspace lifecycle rather than an explicit immutable application publication. That is a product-model distinction, not proof that Coder cannot support the use case.

### Gaps
- I did not find an official side-by-side independent performance or cost benchmark. No cost superiority should be claimed.

## What agent support and temporary endpoint sharing do they provide?

### Takeaway
The proposed agent execution and organization-scoped preview endpoints overlap strongly with Coder and Ona. Codespaces also has organization-private forwarded ports, though it is primarily a developer workspace product.

### Cited Findings
- Coder Agents is a self-hosted chat/API coding agent: the agent loop executes in Coder's control plane, can provision workspaces, run tools there, and delegate parallel sub-agents. Coder explicitly says it is its own agent rather than a wrapper around Codex or Claude Code. — [Coder Agents](https://coder.com/docs/ai-coder/agents)
- Coder Agents' tools include workspace file edits, shell commands, background processes, file attachments, sub-agent messaging, and workspace creation; tool actions use the chat owner's permissions. — [Coder Agents](https://coder.com/docs/ai-coder/agents); [Coder Agents tools](https://coder.com/docs/ai-coder/agents/tools)
- Coder workspace ports support owner, organization, deployment-authenticated, and public sharing levels. Organization means authenticated members of the workspace's organization. — [Coder workspace ports](https://coder.com/beta-docs/user-guides/workspace-access/port-forwarding/)
- Coder shares full workspaces with users/groups; shared users can connect through SSH and apps, although path-routed apps may be inaccessible to nonowners until subdomain routing is configured. — [Coder workspace sharing](https://coder.com/docs/user-guides/shared-workspaces)
- Codespaces can forward development ports at creator-only, organization-only, or public visibility; even private and organization-only forwarded ports use an internet-reachable URL guarded by GitHub authentication. Organization policies can restrict visibility. — [GitHub Codespaces security](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces); [GitHub port forwarding](https://docs.github.com/en/enterprise-cloud%40latest/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)
- GitHub says Codespaces cannot currently be restricted from accessing the public internet, and appropriately authenticated users cannot be blocked from a forwarded port at a network layer. — [GitHub private network guide](https://docs.github.com/en/codespaces/developing-in-a-codespace/connecting-to-a-private-network)
- Ona currently documents creator-only, organization-member, and anyone access levels for shared environment ports, with an organization policy limiting the maximum level. — [Ona port sharing policy](https://ona.com/docs/ona/organizations/policies/port-sharing)
- Ona describes parallel agents in fresh isolated environments with previews; these are company product claims rather than independently verified adoption data. Its older "Ona Agent" documentation is marked deprecated in favor of Codex Agent. — [Ona parallel agents](https://ona.com/cases/parrallel-coding-agents); [Ona deprecated agent documentation](https://ona.com/docs/ona/agents/overview)
- Daytona previews expose HTTP services on sandbox ports using token-bearing preview URLs. It supports expiring, revocable signed preview URLs and optionally unauthenticated public sandboxes. — [Daytona previews](https://www.daytona.io/docs/en/preview/)

### Inferences
- "Development endpoints stay local to the org" requires precision: authenticated organization-only access over a public URL is provided by Coder, Codespaces, and Ona; a genuinely private, non-internet-routable network is a different guarantee and needs specific network enforcement. GitHub's docs illustrate that distinction explicitly.
- AgentCloud should avoid positioning "parallel agents in isolated boxes" or "org-private dev links" as unique. A possible narrower claim is the coordination contract for **different agents** to discover and depend on each other's temporary services, if the product actually enforces and demonstrates it.

### Gaps
- I did not establish whether Coder/Ona have a first-class dependency graph between separately running agents and the live dev services they produce. Absence from these pages is not evidence of absence.
- I did not independently test endpoint network isolation, availability, or revocation behavior for any vendor.

## What do they provide for durable published outputs, and is the comparison fair?

### Takeaway
The split between temporary development compute and durable published apps is already a strong Replit pattern, while Daytona offers durable storage primitives and Coder offers long-lived shared workspaces. AgentCloud's plausible wedge needs to be more specific than that split.

### Cited Findings
- Replit's official learning material describes an Agent-built development workspace with a live preview and a separate Publish action that makes the app available at a shareable URL. — [Replit Learn: Your first app](https://learn.replit.com/docs/ai-foundations/lesson-4)
- Replit's publishing monitoring docs cover published app uptime, request patterns, and resource use; monitoring starts only after publication. — [Replit monitoring](https://replit.mintlify.app/features/publishing/monitoring-a-deployment)
- Replit describes private publishing for internal apps and access tokens that can be scoped to development or production environments. — [Replit private publishing announcement, 2026-05-06](https://replit.com/blog/secure-more-apps)
- Daytona says volumes are S3-backed mounts that survive sandbox deletion; its persistence documentation does not present this as managed site/API publishing. — [Daytona persistence](https://www.daytona.io/docs/en/persistence/)
- Coder's documented long-lived staging/QA workspace is shared and retains its compute environment; Coder workspace apps can expose services through the Coder server or proxy. — [Coder persistent shared workspaces](https://coder.com/docs/tutorials/persistent-shared-workspaces); [Coder security guidance](https://coder.com/docs/tutorials/best-practices/security-best-practices)

### Inferences
- "Like Coder/Codespaces" is a fair architectural shorthand for run boxes. "Coder plus agent coordination plus a publish pipeline" is closer to the whole proposal. Replit is an important comparator for persistent site/API publication, and Ona for parallel agent environments.
- A potentially testable wedge is a project-level contract: multiple heterogeneous agents coordinate over short-lived internal services, publish separately governed durable artifacts, and preserve revision/producer/approval/health lineage end to end. This is a hypothesis, not an established competitive gap or proof of demand.
- Wikis and durable non-app artifacts might broaden the artifact-home model, but their strategic value requires specific user workflows; generic file or content storage is heavily commoditized.

### Gaps
- I found no official evidence that the major workspace vendors provide the complete proposed cross-agent development-service to durable artifact lineage in one product. This is not an exhaustive feature audit, so no exclusivity claim is warranted.
- User willingness to pay for that combined workflow, frequency of simultaneous agent-to-agent service dependencies, and relative importance of wikis versus web apps remain untested.
