import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AccountSettings } from "@/components/account-settings";
import { pageAuth } from "@/lib/page-auth";

export default async function Page() {
  const identity = await pageAuth(await headers());
  if (!identity.verified) redirect("/sign-in");
  return <AccountSettings />;
}
