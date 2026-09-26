import { remoteBackendURL, remoteFetch } from "./remote-backend.mjs";

/** Use the same identity source as the browser API requests. */
export async function pageAuth(requestHeaders: Headers) {
  if (remoteBackendURL()) {
    const response = await remoteFetch("/api/employee", requestHeaders);
    if (response.status === 401 || response.status === 403)
      return { verified: false, hasActiveOrganization: false };
    if (!response.ok) throw new Error("The shared AgentCloud backend is unavailable. Please try again.");
    const employee = await response.json();
    return { verified: true, hasActiveOrganization: !!employee.activeOrganization };
  }

  const { getAuth, organizations } = await import("./auth.mjs");
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  const verified = !!session?.user.emailVerified;
  return {
    verified,
    hasActiveOrganization: verified && organizations(session!.user.id).some(
      (org: { id: string }) => org.id === session!.session.activeOrganizationId,
    ),
  };
}
