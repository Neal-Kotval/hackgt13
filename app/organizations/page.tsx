import { OrganizationDashboard } from "@/components/organization-dashboard";
import { pageAuth } from "@/lib/page-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
export default async function Page() {
  const requestHeaders = await headers();
  const identity = await pageAuth(requestHeaders);
  if (!identity.verified) redirect("/sign-in");
  return <OrganizationDashboard />;
}
