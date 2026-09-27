import { OrganizationDashboard } from "@/components/organization-dashboard";
import { resolveOrganizationUrl } from "@/lib/organization-url";
import { pageAuth } from "@/lib/page-auth";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ id: string; slug: string }> }) {
  const identity = await pageAuth(await headers());
  if (!identity.verified) redirect("/sign-in");
  const { id, slug } = await params;
  const result = resolveOrganizationUrl(identity.organizations, id, slug);
  if (result.kind === "missing") notFound();
  if (result.kind === "redirect") redirect(result.url);
  return <OrganizationDashboard organizationId={result.organization.id} />;
}
