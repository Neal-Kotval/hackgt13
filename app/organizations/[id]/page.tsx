import { organizationUrl } from "@/lib/organization-url";
import { pageAuth } from "@/lib/page-auth";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const identity = await pageAuth(await headers());
  if (!identity.verified) redirect("/sign-in");
  const { id } = await params;
  const organization = identity.organizations.find((item) => item.id === id);
  if (!organization) notFound();
  redirect(organizationUrl(organization));
}
