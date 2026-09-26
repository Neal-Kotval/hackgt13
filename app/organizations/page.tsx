import { OrganizationDashboard } from "@/components/organization-dashboard";
import { getAuth } from "@/lib/auth.mjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
export default async function Page() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session || !session.user.emailVerified) redirect("/sign-in");
  return <OrganizationDashboard />;
}
