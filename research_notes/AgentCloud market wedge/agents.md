# AI coding agent platforms, September 2026

## What is actually shipped?

### Takeaway
Multi-agent coordination, isolated execution, task boards, and human review are already shipped by major coding platforms. A claim that AgentCloud is simply a place to run several agents and see their tasks would be weak.

### Cited Findings
- Devin's Dynamic Workflows orchestrate multiple Devin sessions with a deterministic Python script, structured stage outputs, progress panel, recorded results, and resumability. Child agents run on their own VMs by default; separate VMs exchange code through git branches. [Devin Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- Devin also supports handoff from its CLI and other coding agents, including Claude Code and Codex, to cloud sessions with a VM, shell, browser, and repo access. [Devin Handoff](https://docs.devin.ai/work-with-devin/devin-handoff)
- Replit Agent has a task board with drafts, active/queued, ready, and done; tasks run in isolated copies, can have dependencies, and require applying reviewed changes to the main version. [Replit Task Board](https://docs.replit.com/features/agent/task-board)
- Claude Code agent teams have independent agent sessions, shared tasks with dependencies, peer messaging, and a lead. The feature is experimental and disabled by default. [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- OpenAI Agents API supports durable Codex sessions with sandbox execution, subagents, orchestration, recovery, and app-supplied execution environments; Codex app supports parallel threads, worktrees, automations, and reviews. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [Codex long tasks](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)

### Inferences
- AgentCloud should not present multi-agent task lists, dependency gating, isolated worktrees/VMs, or execution visibility as unique. Devin and Replit are especially close on those dimensions.
- A plausible differentiation is model/provider neutral coordination around a shared *running* project environment, if agents can discover and use each other's private live development services reliably. This is an inference about positioning, not proof of market demand or that competitors lack it.

### Gaps
- The docs do not quantify adoption, customer satisfaction, or how well these features work in practice.
- I did not find evidence in these sources of cross-provider agent coordination as a first-class product across all platforms; absence of documentation is not proof of absence.

## Which comparable workflows combine multiple agents and persistent environments?

### Takeaway
Replit is particularly close to the proposed run-box/artifact-home split, and Devin now has a narrower native deployment path. This weakens a generic "agents build, then publish persistent websites/APIs" claim.

### Cited Findings
- Replit publishes a snapshot from its project editor into a separate running cloud instance that stays available independent of the editor. It offers static, autoscale, reserved VM, and scheduled deployments, plus custom domains, access controls, monitoring, databases, and storage. [Replit Publishing](https://docs.replit.com/learn/projects-and-artifacts/replit-deployments)
- Replit's task board provides isolated agent task copies, dependency queuing, previews, test output, review, and apply-to-main while Replit Publishing provides durable deployment. These are documented within the same product. [Replit Task Board](https://docs.replit.com/features/agent/task-board), [Replit Publishing](https://docs.replit.com/learn/projects-and-artifacts/replit-deployments)
- Devin can publish small standalone apps that stay reachable after the session ends: static frontends on devinapps.com and FastAPI backends on Fly.io. Its native deploy requires explicit approval and is unavailable to enterprise organizations and sessions with enforced network policy; existing applications use the customer's own CI/CD or deployment tooling. [Devin App Deployments](https://docs.devin.ai/product-guides/deployment-capabilities)
- Devin sessions start from an organization snapshot containing repos, dependencies, and tools; session changes do not persist to that snapshot. [Devin Environment](https://docs.devin.ai/onboard-devin/environment)
- Claude Code agent teams are centered on task/message coordination; its docs warn of limitations in resumption, task coordination, and shutdown. [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)

### Inferences
- Replit provides the closest functional benchmark for the complete build-to-live-artifact story, even if its product targets a different audience. AgentCloud would need a more specific workflow, such as cross-provider agents collaborating on a private org network with stable ownership and release provenance, to stand apart.
- Devin's native deploy limitations leave room for internal, policy-controlled, durable artifact homes, but users may already deploy through their own infrastructure. Integration with that infrastructure may beat competing as a general hosting platform.

### Gaps
- The reviewed official pages do not demonstrate whether Replit isolated task copies can call each other's live preview endpoints; a competitive test would need hands-on access.
- These pages do not establish whether Devin Dynamic Workflow agents can discover each other's live dev services across VMs. They explicitly describe git-branch exchange for separate VMs.

## Which claims are weak or undifferentiated?

### Takeaway
"Coder spaces for agents," "multi-agent dashboard," "parallel execution," "handoffs," and "publish agent-built apps" overlap existing products. The sharper hypothesis is an org-private integration lab for heterogeneous agents building connected components, with a controlled promotion into durable artifacts.

### Cited Findings
- Devin provides a live workflow panel showing phases and individual agent statuses, with access to each child session. [Devin Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- Replit's task board provides visibility into plans, queued dependencies, work logs, test output, preview, and applying agent work. [Replit Task Board](https://docs.replit.com/features/agent/task-board)
- OpenAI offers a documented multi-agent Codex/Agents SDK example with project manager, designer, frontend/backend developers, tester, gated handoffs, and traces of prompts/tool calls/agent transfers. [OpenAI multi-agent Codex workflow](https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk)
- Claude Code offers agent team task assignment, peer-to-peer messages, and direct steering of teammates. [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- Replit already separates ephemeral editor state from published app snapshots and provides access controls for published apps. [Replit Publishing](https://docs.replit.com/learn/projects-and-artifacts/replit-deployments)

### Inferences
- The value proposition should be tested on a concrete two-agent frontend/backend workflow: one agent starts a private API, another consumes it through service discovery, both verify a shared integration contract, and a human promotes known revisions to durable artifact homes. Measure setup time, failed handoffs, integration time, and whether teams use it repeatedly.
- In product messaging, distinguish a planned org-private networking/security boundary from the current URL registry. Calling registered endpoints "private" before ingress/egress enforcement would be misleading.
- Multi-provider support is only a wedge if it removes real coordination friction beyond what existing agents' handoff plugins and task tools provide.

### Gaps
- No official source here measures demand for cross-agent live-service collaboration; validate through interviews and a working pilot.
- No apples-to-apples reliability, security, or cost benchmark was found for these products.
