import { remoteBackendURL, remoteFetch } from "./remote-backend.mjs";

/** Use the same identity source as the browser API requests. */
export async function pageAuth(requestHeaders: Headers) {
  if (remoteBackendURL()) {
    const response = await remoteFetch("/api/employee", requestHeaders);
    if (response.status === 401 || response.status === 403)
      return { verified: false, hasActiveOrganization: false, user: null, organizations: [] };
    if (!response.ok) throw new Error("The shared alto backend is unavailable. Please try again.");
    const employee = await response.json();
    return { verified: true, hasActiveOrganization: !!employee.activeOrganization,
      user: { name: employee.name, email: employee.email },
      organizations: employee.organizations as { id: string; name: string; slug: string; role: string }[] };
  }

  const { getAuth, organizations } = await import("./auth.mjs");
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  const verified = !!session?.user.emailVerified;
  const available = verified ? organizations(session!.user.id) as { id: string; name: string; slug: string; role: string }[] : [];
  return {
    verified,
    user: verified ? { name: session!.user.name, email: session!.user.email } : null,
    organizations: available,
    hasActiveOrganization: verified && available.some(
      (org: { id: string }) => org.id === session!.session.activeOrganizationId,
    ),
  };
}
