import { PlatformAwsApprovals } from "@/components/platform-aws-approvals";
import { remoteBackendURL, remoteFetch } from "@/lib/remote-backend.mjs";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page() {
  const requestHeaders = await headers();
  let email: string | undefined;

  if (remoteBackendURL()) {
    const response = await remoteFetch("/api/employee", requestHeaders);
    if (response.status === 401 || response.status === 403) redirect("/sign-in");
    if (!response.ok) throw new Error("The shared alto backend is unavailable. Please try again.");
    const employee = await response.json();
    email = employee.email;
  } else {
    const { getAuth } = await import("@/lib/auth.mjs");
    const session = await getAuth().api.getSession({ headers: requestHeaders });
    if (!session?.user.emailVerified) redirect("/sign-in");
    email = session.user.email;
  }

  const adminEmail = process.env.AGENTCLOUD_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail || email?.trim().toLowerCase() !== adminEmail) notFound();

  return <PlatformAwsApprovals />;
}
