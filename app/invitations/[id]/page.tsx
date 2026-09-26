import { Invitation } from "@/components/invitation";
import { pageAuth } from "@/lib/page-auth";
import { headers } from "next/headers";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const {id}=await params;
  const requestHeaders = await headers();
  const identity = await pageAuth(requestHeaders);
  return <Invitation id={id} signedIn={identity.verified} />;
}
