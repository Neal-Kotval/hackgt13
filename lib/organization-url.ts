export function organizationUrl(organization: { id: string; slug: string }) {
  return `/organizations/${encodeURIComponent(organization.id)}/${encodeURIComponent(organization.slug)}`;
}

export function resolveOrganizationUrl<T extends { id: string; slug: string }>(organizations: T[], id: string, slug: string):
  { kind: "missing" } | { kind: "redirect"; url: string } | { kind: "found"; organization: T } {
  const organization = organizations.find((item) => item.id === id);
  if (!organization) return { kind: "missing" };
  if (slug !== organization.slug) return { kind: "redirect", url: organizationUrl(organization) };
  return { kind: "found", organization };
}
