import { SignIn } from "@/components/employee-auth";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const invite = typeof query.invite === "string" && /^[\w-]{1,128}$/.test(query.invite) ? query.invite : "";
  return <SignIn signup invite={invite} />;
}
