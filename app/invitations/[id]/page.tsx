import { Invitation } from "@/components/invitation";
import { getAuth } from "@/lib/auth.mjs";
import { headers } from "next/headers";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const {id}=await params;
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({headers:requestHeaders});
  return <Invitation id={id} signedIn={!!session?.user.emailVerified} />;
}
