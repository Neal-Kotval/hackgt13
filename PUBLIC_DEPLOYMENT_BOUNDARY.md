# Public multi-organization deployment boundary (HAC-137)

**Status: design and launch gate, not an implemented security claim.** AgentCloud's current self-hosted application is a local organization-aware coordination system. The separate AWS deployment is a staging/demo installation. Neither is approved for untrusted public multi-organization use. A working login, organization URL slug, project membership check, CloudFront HTTPS endpoint, or private staging tunnel does not by itself establish tenant isolation.

This document defines the boundary and the evidence required before a public service accepts unrelated organizations. It does not authorize exposing the current application, allocating a shared runner for untrusted tenants, or migrating production data. The HackGT single-organization GPU demo has different acceptance gates in [MVP_SPEC.md](MVP_SPEC.md).

## Assets, actors, and trust boundaries

| Asset or actor | Public-service boundary |
| --- | --- |
| Employee browser and desktop client | Untrusted request origin. The server derives identity and organization membership from a verified session, never from a project ID, URL slug, desktop state, or forwarded header supplied by the client. |
| Organization, project, invitation, and membership records | Tenant-scoped control-plane data. A person may belong to multiple organizations, but every project operation resolves one organization and its current role at request time. |
| Agent bearer credential | Separate machine identity, scoped to one project and agent. It is not an employee session, an organization administrator, or a cloud credential. |
| Control-plane datastore and event stream | Confidential tenant data and authoritative authorization state. Readers, writers, exports, backups, search, SSE, and background jobs must use the same tenant boundary. |
| Job queue, provider worker, and run box | Privileged execution plane. A queued request is untrusted intent; only a fresh server-side decision may authorize allocation. An agent's shell or container is an adversarial boundary when tenants are unrelated. |
| SSH keys, model/provider credentials, session secrets, and invite links | Secrets with distinct scope and lifecycle. No plaintext value belongs in a project snapshot, command log, support bundle, or tenant-readable audit event. |
| Public ingress and private service endpoints | Public HTTPS reaches the control plane through a trusted proxy configuration. Worker control and temporary development services require private, authenticated ingress with tenant-aware routing. |

The main attack paths are an employee joining or guessing another organization's URL, a stale member retaining a saved endpoint or session, a compromised agent token submitting cross-project actions, a malicious task causing the runner to read host or other tenant data, a background job acting on stale approval, and an operator or log pipeline exposing secrets. Assume IDs, slugs, invitation links, command output, repository contents, and user-supplied endpoints are attacker-controlled. A transport heartbeat, registered endpoint, or successful provider API response is not evidence of a safe execution boundary.

## Launch blockers and acceptance evidence

All gates below are required for **public multi-organization** launch. A check box or design review alone is insufficient; the release record must name the tested revision, environment, command or scenario, observed denial/success, and owner of any remaining risk. Tests use two unrelated organizations, at least two employees with different roles in each, and independent agent identities. Run them against the deployment shape intended for public traffic, including its proxy, database, worker, and runner.

### 1. Identity, sessions, and invitations

- Use a supported production identity path with verified email or enterprise identity, MFA for privileged users and operators, strong session signing keys, HTTPS-only secure cookies, explicit trusted origins/proxies, CSRF defense, rate limits, and abuse controls for signup, login, recovery, and invitations. Deliver verification and invitation links through an approved mail service; local file capture is not a public delivery path. Define key rotation, session expiry, logout, and account recovery procedures.
- Resolve the active organization server-side on every human route. Reject an unverified account, removed member, expired or revoked invite, forged cookie, wrong recipient, or wrong organization. An organization slug is a display/routing identifier, not an access token.
- **Evidence:** browser and direct HTTP tests show allowed owner/admin/member actions and denied anonymous, wrong-recipient, removed-member, and cross-organization actions. A removed member loses existing sessions' effective project access without waiting for a new login; invitation resend and failed delivery do not silently create a usable access path or destroy the only known valid link.

### 2. Tenant authorization across every data path

- Define one authoritative organization-to-project relationship and role policy. Enforce it before reads, writes, SSE subscriptions, downloads, exports, search, chat, analytics, resource requests, and administrative operations. Workers and agent routes must carry and recheck the same scope. Avoid hidden legacy assignments becoming active when a project moves organizations.
- Migrate legacy project ownership and assignments explicitly. Make ownership transfer, project adoption, member removal, and organization deletion transactional or compensating with an audited recovery path. Never trust a client-supplied organization ID without checking its relation to the resource.
- **Evidence:** a route inventory maps every tenant-data route and worker operation to its policy check. Two-organization tests attempt ID substitution and direct requests for each route, replay an old SSE connection after removal, adopt a legacy project, and prove no foreign record or event is returned or changed. Review logs for denied decisions without secret values.

### 3. Transactional datastore and recovery

- Replace the process-local JSON coordination queue and split JSON/SQLite writes as authoritative public state with a transactional, multi-process-safe store. Define schema migrations, tenant keys and indexes, uniqueness/idempotency constraints, row-level or equivalent policy defense, durable event cursors, and an outbox for provider jobs. Keep existing local data readable through a tested migration, then reconcile partial cross-store states before cutover.
- Encrypt backups, restrict database and backup access by role, define retention and deletion, and restore the database together with required encryption/session key material. Avoid sensitive payloads in query logs and replicas.
- **Evidence:** concurrent replicas cannot duplicate a decision, invite acceptance, allocation, or agent event; crash/retry tests reconcile a committed decision with an interrupted job; backup restore on a separate environment preserves tenant isolation and revocations. A failed migration rolls back or has a documented forward repair with no lost project ownership.

### 4. Worker, runner, and network isolation

- Workers accept only authorized, idempotent jobs from the control plane; recheck membership/policy and expiry before each provider action. Record provider resource identity, execution account, workspace, and actual stop/revoke result. Reconcile resources found at the provider but missing or failed in local state.
- Treat unrelated tenant code and agents as hostile. Use a reviewed execution boundary with per-tenant credentials, filesystem/process/network isolation, resource limits, egress policy, image provenance, and no control-plane or provider secrets in the workspace. Unrestricted SSH is **trusted shell access** and cannot be sold as isolation. A stopped API token must not leave a live SSH key or saved endpoint usable.
- **Evidence:** a tenant's runner cannot read another tenant's files, process environment, metadata credentials, network service, or workspace; an allowed command still works. Key/member revocation is tested from an existing SSH client against a running box. Restart, duplicate delivery, expired allocation, failed stop, and orphan resource scenarios leave accurate states and do not leak or duplicate capacity. Tests run at the actual OS/network boundary claimed in the product.

### 5. Secrets and sensitive output

- Store session, SMTP, model, cloud, and SSH credentials in a scoped secret manager, with rotation and incident revocation. Separate employee, agent, provider, and execution identities. Do not put plaintext bearer tokens, private keys, invite links, cookies, command arguments, or raw command output in general application logs. If command evidence is retained for an authorized viewer, use a separate scoped store with explicit redaction, retention, and deletion. Treat user and agent messages as potentially sensitive under the same policy.
- **Evidence:** seeded canary secrets in command output, error paths, request headers, and provider responses do not appear in tenant APIs, activity, application logs, traces, or support exports. Rotation invalidates old credentials at the boundary that uses them. An audit names any retained sensitive store, its readers, encryption, retention, and deletion behavior.

### 6. Public and private ingress

- Terminate TLS at an approved edge, enforce canonical host/origin and trusted forwarded headers, secure cookies, request size limits, timeouts, and denial of unintended administrative or worker routes. Protect temporary development services and agent connections with authenticated private ingress and project scope; registering a URL does not make it reachable or private.
- **Evidence:** staging tests through the real edge reject forged `Host`/forwarded headers, cross-site mutations, direct origin bypass, unauthenticated worker APIs, and cross-tenant service discovery. Valid browser, desktop, CLI, webhook, and invitation flows succeed through their documented endpoints. TLS and proxy configuration are included in the release review.

### 7. Operations, monitoring, and incident response

- Define owners for deploys, schema changes, key rotation, backup/restore, provider reconciliation, vulnerability response, and tenant deletion. Alert on repeated denied access, unusual token use, orphan boxes, failed stops, allocation drift, secret exposure, and backup failure. Preserve an immutable, access-limited audit trail of actor, organization, decision, resource, and outcome without recording secrets.
- **Evidence:** an operator drills a compromised employee session, agent token, and SSH key; a failed worker allocation and stop; an accidental cross-tenant query; and a database restore. Each drill shows containment time, affected resources, user-visible state, and recovery. Release review confirms dependencies, image scans, infrastructure plan, and rollback procedure for the exact deployment revision.

## Release decision

Public multi-organization launch is blocked while any gate lacks deployment-level evidence or has an unresolved cross-tenant data/execution path. The release owner records explicit sign-off from engineering and security after the evidence above is reviewed. The launch decision must identify whether the service offers trusted SSH access or an enforced tenant execution boundary; it cannot infer the latter from API checks, container labels, or a successful SSH probe.

Until then, keep the application on loopback or a controlled private staging origin with known test users. Do not describe that deployment as a production tenant-isolated service. A separately verified single-organization GPU demo may proceed under its own [MVP_SPEC.md](MVP_SPEC.md) gates without satisfying this public launch gate.
