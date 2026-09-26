import { CloudApp } from "@/components/cloud-app";
import { getAuth, organizations } from "@/lib/auth.mjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
export default async function Page() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session || !session.user.emailVerified) redirect("/sign-in");
  if (!organizations(session.user.id).some((org: { id: string }) => org.id === session.session.activeOrganizationId)) redirect("/organizations");
  return <CloudApp />;
}
