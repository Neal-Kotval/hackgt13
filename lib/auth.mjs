import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { organization } from "better-auth/plugins";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { sendAuthMail } from "./mail.mjs";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

let instance;
let database;
function validateOrganizationFields(org, creating = false) {
  if (creating || org.name !== undefined) {
    if (typeof org.name !== "string" || !org.name.trim() || org.name.length > 100)
      throw new APIError("BAD_REQUEST", { message: "Use an organization name up to 100 characters" });
  }
  if (creating || org.slug !== undefined) {
    if (typeof org.slug !== "string" || org.slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(org.slug))
      throw new APIError("BAD_REQUEST", { message: "Use a short lowercase URL slug" });
  }
}
export function getDatabase() {
  if (!database) {
    const directory = path.resolve(
      process.env.AGENTCLOUD_DATA_DIR || ".agentcloud",
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, "auth.sqlite");
    database = new Database(filename);
    chmodSync(filename, 0o600);
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
  }
  return database;
}
export function authOptions() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error(
      "Set BETTER_AUTH_SECRET to at least 32 random characters before starting authentication.",
    );
  return {
    database: getDatabase(),
    secret,
    baseURL: process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000",
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      async sendVerificationEmail({ user, url }) {
        await sendAuthMail({ to: user.email, subject: "Verify your AgentCloud email", text: `Verify your email to use AgentCloud:\n\n${url}\n\nThis link expires in one hour.` });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.path.startsWith("/organization/")) return;
        // A server-only bootstrap has no request/session; HTTP calls always do.
        if (!ctx.request && !ctx.headers) return;
        const session = await getSessionFromCtx(ctx);
        if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in required" });
        if (!session.user.emailVerified) throw new APIError("FORBIDDEN", { message: "Verify your email first" });
        // Reissue creates a new opaque invitation and cancels the old one.
        if (ctx.path === "/organization/invite-member" && ctx.body?.resend)
          throw new APIError("BAD_REQUEST", { message: "Send a new invitation to replace the old link" });
        if (ctx.path === "/organization/invite-member" && !["member", "admin"].includes(ctx.body?.role))
          throw new APIError("FORBIDDEN", { message: "Invite as Member or Admin; ownership is assigned separately" });
      }),
    },
    plugins: [organization({
      requireEmailVerificationOnInvitation: true,
      cancelPendingInvitationsOnReInvite: true,
      invitationExpiresIn: 48 * 60 * 60,
      disableOrganizationDeletion: true,
      organizationHooks: {
        async beforeCreateOrganization({ user, organization: org }) {
          if (!user.emailVerified) throw new APIError("FORBIDDEN", { message: "Verify your email first" });
          validateOrganizationFields(org, true);
        },
        async beforeUpdateOrganization({ organization: org }) {
          validateOrganizationFields(org);
        },
        async beforeUpdateMemberRole({ newRole }) {
          if (!["owner", "admin", "member"].includes(newRole)) throw new APIError("BAD_REQUEST", { message: "Choose one organization role" });
        },
      },
      async sendInvitationEmail({ id, email, organization: org, inviter, role }) {
        const url = new URL(`/invitations/${encodeURIComponent(id)}`, process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000");
        let status = "failed";
        try {
          status = await sendAuthMail({ to: email, subject: `Join ${org.name} on AgentCloud`, text: `${inviter.user.name} invited you to ${org.name} as ${role}.\n\n${url}\n\nSign in with this email address to accept. This invitation expires in 48 hours.` });
        } finally {
          getDatabase().prepare("INSERT INTO invitation_delivery (invitation_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(invitation_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at").run(id, status, new Date().toISOString());
        }
      },
    })],
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    databaseHooks: {
      session: {
        create: {
          // A new session (web or desktop sign-in) starts in the employee's most
          // recently joined organization; switching remains an explicit action.
          async before(session) {
            if (session.activeOrganizationId) return;
            const row = getDatabase().prepare(
              "SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt DESC LIMIT 1",
            ).get(session.userId);
            if (row) return { data: { ...session, activeOrganizationId: row.organizationId } };
          },
        },
      },
    },
    logger: { disabled: true },
  };
}
export function getAuth() {
  return (instance ??= betterAuth(authOptions()));
}
export function migrateMemberships() {
  getDatabase().exec(`CREATE TABLE IF NOT EXISTS project_membership (
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
    PRIMARY KEY(user_id, project_id)
  );
  CREATE TABLE IF NOT EXISTS project_organization (
    project_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS invitation_delivery (
    invitation_id TEXT PRIMARY KEY REFERENCES invitation(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS member_user_organization_unique ON member(userId, organizationId);
  CREATE TRIGGER IF NOT EXISTS revoke_project_access_on_member_delete
  AFTER DELETE ON member
  BEGIN
    DELETE FROM project_membership WHERE user_id = OLD.userId
    AND project_id IN (SELECT project_id FROM project_organization WHERE organization_id = OLD.organizationId);
  END;
  `);
}
export function organizations(userId) {
  return getDatabase().prepare('SELECT o.id, o.name, o.slug, m.role FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? ORDER BY o.name').all(userId);
}
/** @param {string} userId @param {string | null} organizationId */
export function memberships(userId, organizationId = null) {
  return getDatabase().prepare(`SELECT po.project_id AS projectId,
    CASE WHEN m.role IN ('owner','admin') THEN 'owner' ELSE pm.role END AS role
    FROM project_organization po JOIN member m ON m.organizationId = po.organization_id
    LEFT JOIN project_membership pm ON pm.project_id = po.project_id AND pm.user_id = m.userId
    WHERE m.userId = ? AND (? IS NULL OR po.organization_id = ?)
    AND (m.role IN ('owner','admin') OR pm.user_id IS NOT NULL)`).all(userId, organizationId, organizationId);
}
export function attachProject(projectId, organizationId) {
  getDatabase().prepare("INSERT INTO project_organization (project_id, organization_id) VALUES (?, ?)").run(projectId, organizationId);
}
export function grantMembership(userId, projectId, role) {
  getDatabase()
    .prepare(
      "INSERT INTO project_membership (user_id, project_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role",
    )
    .run(userId, projectId, role);
}
