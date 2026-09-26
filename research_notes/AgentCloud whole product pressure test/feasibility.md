# AgentCloud execution feasibility, economics, and go-to-market

## What is the smallest credible product, given the current implementation?

### Takeaway
The smallest credible product is a verified integration workflow for two real agents using one private development service, with an evidenced handoff and human-controlled release to an existing host. Building proprietary workspace infrastructure, multiple artifact types, and multi-tenant SaaS first would put several unvalidated products on the critical path.

### Cited Findings
- The repository's current executable boundary is a loopback, single-user Next.js app with a JSON store, CLI heartbeat, service registration, handoffs, and sample replay. It does not launch agents, create worktrees, probe registered services, provision compute, or publish artifacts. — [AgentCloud architecture](/Users/nealkotval/hackgt13/ARCHITECTURE.md)
- The repository roadmap sequences one run-box implementation, then one Codex integration, then independent Claude/worktree/private-service collaboration, then artifact publication. — [AgentCloud roadmap](/Users/nealkotval/hackgt13/ROADMAP.md)
- Coder Community says it supports unlimited self-hosted workspaces and third-party agents including Claude Code and Codex, while its premium offerings add access governance and AI orchestration. This means a basic multi-agent box manager overlaps an existing provider. — [Coder pricing/features](https://coder.com/pricing)
- Render private services have no public internet ingress and are reachable by services on the same private network. Its compute and workspace plans are billed separately, and static sites do not need service compute. — [Render private services](https://render.com/docs/private-services), [Render pricing](https://render.com/pricing), [Render compute plans](https://render.com/docs/compute-plans)

### Inferences
- For a constrained pilot, treat the user's or partner's existing workspace and host as implementation substrates. AgentCloud's essential new behavior is binding *producer run + private service identity + contract revision + consumer test evidence + release revision* in one reviewable timeline. First prove that users need this timeline.
- Launch only one durable output type, preferably a static site or simple API with no durable user data. An editable wiki and stateful API introduce backup, restore, retention, migration, and data ownership promises independent of the collaboration thesis.
- A demo can use attached trusted SSH and two verified worktrees if it is labeled honestly. A paid SaaS needs a different security architecture before exposing a multi-tenant dashboard or arbitrary repository execution.

### Gaps
- No direct user evidence yet shows that teams have recurring cross-agent live-service handoff failures or would pay for a separate coordination product.
- No measured end-to-end success rate exists for the proposed Codex-to-Claude workflow in this repository.

## What will make the full architecture difficult and expensive to operate?

### Takeaway
The main difficulty is the interaction of trust boundaries: untrusted code and agent tool actions, project-private connectivity, deployment credentials, and durable user data. Compute cost can be metered, but security operations and support grow sharply if AgentCloud owns all four layers.

### Cited Findings
- GitHub Codespaces lists a 2-core box at $0.18 per active hour and storage at $0.07/GB-month. Organizations have no personal-account free quota. — [GitHub Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)
- Railway lists resource pricing of $10/GB-month RAM, $20/vCPU-month, $0.05/GB egress, and $0.15/GB-month volume storage for services, in addition to its base plan structure. Its beta VM sandbox rates differ. — [Railway pricing](https://docs.railway.com/pricing/plans)
- Render charges a workspace subscription, metered bandwidth/build features, and per-service compute; paid compute is prorated while running. — [Render pricing](https://render.com/pricing)
- OpenAI and Anthropic API pricing are token based and vary by model, output volume, caching, and tools. Thus model inference is a separate variable from box and artifact runtime cost. — [OpenAI API pricing](https://developers.openai.com/api/docs/pricing), [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- GitHub describes Codespaces forwarded ports as internet-reachable URLs even when GitHub authentication restricts who can open them. Its private-network guide says Codespaces cannot currently restrict public internet egress. An “org-only endpoint” therefore does not itself satisfy “no public ingress/egress.” — [Codespaces security](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces), [Codespaces private networks](https://docs.github.com/en/codespaces/developing-in-a-codespace/connecting-to-a-private-network)
- OWASP identifies prompt injection, tool abuse, exfiltration, excessive autonomy, cross-agent propagation, and denial of wallet as agent-system risks; it recommends tool-level least privilege and separate authorization for sensitive actions. — [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- AgentCloud's current human dashboard API is unauthenticated, state is held by a single-process JSON store, and agent tokens are not a filesystem or network sandbox. — [AgentCloud architecture](/Users/nealkotval/hackgt13/ARCHITECTURE.md)

### Inferences
- Illustrative floor, **not a forecast**: two 2-core Codespaces running 8 hours each workday for 20 days would be 320 active hours × $0.18 = $57.60/month of box compute, before storage, model usage, artifact runtime, bandwidth, observability, and support. Always-on artifact APIs continue to cost money after run boxes stop. A static site is materially cheaper than a continuously supervised API.
- Pricing should expose at least separate meters or pass-throughs for run-box hours, model use, always-on artifact compute/storage/egress, and higher-governance seats. A flat unlimited-agent or unlimited-artifact tier risks negative margins from idle boxes, agent loops, and always-on APIs.
- Customer-owned cloud/model accounts or bring-your-own-hosting reduce AgentCloud cash exposure and procurement friction, though they increase setup complexity. If AgentCloud resells all usage, it must implement budgets, limits, suspension, usage attribution, and billing dispute workflows earlier.
- Strictly private development networking requires an enforceable ingress and egress design, org/project identity, revocation, unauthorized-request tests, observability, and incident response. Calling an authenticated internet endpoint “local to the org” would violate the product promise as phrased.
- Publishing must occur through a separate, narrow permission and immutable package/revision; an agent with unrestricted shell access to the artifact home defeats review and isolation. State-bearing artifacts additionally require restore drills and migration strategy, not only persistent volumes.
- Integration with one agent at a time limits adapter maintenance. Each additional model tool adds version drift, auth flows, process lifecycle, event normalization, and attribution edge cases; a protocol-level integration may be more resilient than trying to drive every tool's UI.

### Gaps
- No benchmark of actual monthly token consumption, average box lifetime, artifact uptime requirements, or storage growth exists for target users; pricing cannot be set responsibly from infrastructure list prices alone.
- No quantified engineering or on-call cost estimate exists. It depends on host choice, isolation boundary, service levels, and customer segment.
- Need to confirm the exact contractual right and supported deployment mode for unattended Codex and Claude execution for the intended buyer and provider accounts before selling a managed-runner product.

## What dependency order and pilot would falsify the business thesis in 30–90 days?

### Takeaway
Prove a repeatable workflow improvement with real users before broadening infrastructure ownership. A 90-day plan should stop if teams do not repeat the workflow, if their existing stack solves it nearly as well, or if isolation and cost controls cannot be demonstrated.

### Cited Findings
- The current product contract calls for two independent agents, separate worktrees, one live private API consumed by the other, attributed real events, and reconnect after restart; seeded replay does not meet that gate. — [AgentCloud product specification](/Users/nealkotval/hackgt13/PRODUCT.md), [AgentCloud roadmap](/Users/nealkotval/hackgt13/ROADMAP.md)
- The existing market-wedge analysis argues that Coder/workspace tooling and Replit/publishing overlap the broad box-plus-host concept, leaving a narrower cross-agent integration hypothesis. — [AgentCloud market wedge](/Users/nealkotval/hackgt13/reports/AgentCloud%20market%20wedge.md)
- Coder's free self-hosted plan supports agent workspaces, and Render supports private services and durable deployments, so a pilot can use existing infrastructure for these commodity layers. — [Coder pricing/features](https://coder.com/pricing), [Render private services](https://render.com/docs/private-services)

### Inferences
- **Days 0–30, discovery and concierge baseline:** Recruit 5–10 teams with an actual recent two-component project and multiple coding agents. Reconstruct their last integration: time to first consumer request, handoff messages, schema drift, dead endpoints, release steps, and incidents. Run 2–3 comparable tasks using their current GitHub/workspace/host stack. Count demonstrated pain, not expressions of excitement.
- **Days 31–60, narrow functional pilot:** Implement or orchestrate one trusted Linux workspace provider, two real agent sessions with separate worktrees, a project-private API, contract/revision records, and real consumer-request evidence. Test a denied outsider request and show model action separately from transport heartbeat. At this stage, human review may be manual and deployment can be a scripted operation into an existing host.
- **Days 61–90, repeat use and economics:** Let at least 3 teams each run a second real project without founder assistance. Publish one identified site/API version with an explicit human approval, stop both run boxes, verify the artifact remains reachable, and measure fully loaded infrastructure/model spend plus support time. Compare against the baseline.
- Proposed pre-registered go/no-go gates (to negotiate with pilot teams): at least a 30% reduction in median elapsed time from backend-ready to first successful frontend request **or** a clearly meaningful drop in stale endpoint/schema handoffs, with no increase in release incidents; ≥3 teams independently repeat the flow; no unauthorized access in boundary tests; positive stated willingness to pay at a price above measured service cost. If the baseline is already smooth, or only a founder-operated demo succeeds, narrow the product to a workflow integration or stop.
- Dependency order: identify repeat pain → real session attribution and reproducible two-agent workflow → enforce private network and permission boundaries → prove handoff benefit → publish through existing host → measure economics/retention → only then consider owned hosting, wiki storage, and multi-tenant cloud control plane.

### Gaps
- The 30% gate and sample sizes are proposed experimental thresholds, not industry benchmarks or validated statistical power calculations.
- The target buyer, budget owner, compliance level, and switching constraints are not specified; willingness to pay and sales motion remain unknown.
