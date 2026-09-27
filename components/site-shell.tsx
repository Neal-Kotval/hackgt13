"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SquaresFour, Users, List, X, House, HardDrives, Play, Gear } from "@phosphor-icons/react";
import { Select } from "./ui/select";
import { EmployeeMenu } from "./employee-auth";
import { Skeleton, SkeletonRegion } from "./ui/skeleton";
import { authClient } from "@/lib/auth-client";
import "./site-shell.css";

type ProjectLink = { id: string; name: string };
const views = [
  ["Overview", "", House],
  ["Environments", "environments", HardDrives],
  ["Runs", "runs", Play],
  ["Settings", "settings", Gear],
] as const;
const legacySections: Record<string, string> = {
  board: "",
  resources: "environments",
  requests: "environments",
  activity: "runs",
  agents: "settings",
  desktop: "settings",
};

export function WebsiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (["/", "/sign-in", "/sign-up", "/download"].includes(pathname)) return children;
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  if (!session && (pathname === "/design-system" || pathname.startsWith("/invitations/"))) return children;
  return <SiteShell>{children}</SiteShell>;
}

function SiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: activeOrganization } = authClient.useActiveOrganization();
  const [projects, setProjects] = useState<ProjectLink[] | null>(null);
  const [open, setOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pieces = pathname.split("/");
  const section = legacySections[pieces[3]] ?? pieces[3] ?? "";
  const project = projects?.find(p => p.id === pieces[2]) || (pieces[1] !== "projects" || !pieces[2] || pieces[2] === "new" ? projects?.[0] : undefined);
  useEffect(() => {setProjects(null);}, [activeOrganization?.id]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/state", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(data => setProjects(data ? data.projects : [])).catch(error => {if (error?.name !== "AbortError") setProjects([]);});
    return () => controller.abort();
  }, [pathname, activeOrganization?.id]);
  useEffect(() => {setOpen(false);}, [pathname]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    content.current?.setAttribute("inert", "");
    sidebar.current?.querySelector<HTMLButtonElement>(".site-sidebar-close")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="listbox"], [role="option"]'))) return;
      if (event.key === "Escape") {event.preventDefault(); setOpen(false);}
      if (event.key !== "Tab") return;
      const items = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') || []).filter(el => el.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    };
    const media = window.matchMedia("(max-width: 768px)");
    const resize = () => {if (!media.matches) setOpen(false);};
    document.addEventListener("keydown", keydown);
    media.addEventListener("change", resize);
    return () => {document.body.style.overflow = previousOverflow; content.current?.removeAttribute("inert"); document.removeEventListener("keydown", keydown); media.removeEventListener("change", resize); toggle.current?.focus();};
  }, [open]);
  function navLink(label: string, href: string, Icon: typeof House, active = pathname === href) {
    return <Link key={href} className="site-nav-link" href={href} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}><Icon aria-hidden="true" /><span>{label}</span></Link>;
  }
  return <div className="site-shell">
    <a className="skip-link" href="#site-content">Skip to content</a>
    <header className="site-mobile-header"><Link className="site-brand" href="/projects">alto<span className="site-brand-dot" aria-hidden="true">.</span></Link><button ref={toggle} className="button ghost site-menu-toggle" aria-label="Open navigation" aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(true)}><List /></button></header>
    {open && <button className="site-sidebar-backdrop" tabIndex={-1} aria-label="Close navigation" onClick={() => setOpen(false)} />}
    <aside ref={sidebar} id="site-navigation" className="site-sidebar" data-open={open} aria-label="Website navigation">
      <Link className="site-brand" href="/projects" onClick={() => setOpen(false)}>alto<span className="site-brand-dot" aria-hidden="true">.</span></Link>
      <button className="button ghost site-sidebar-close" aria-label="Close navigation" onClick={() => setOpen(false)}><X /></button>
      <nav className="site-navigation" aria-label="Main navigation">
        <div className="site-nav-group">{navLink("Projects", "/projects", SquaresFour, pathname === "/projects" || pathname === "/projects/new")}{navLink("Organizations", "/organizations", Users)}</div>
        {projects === null && <SkeletonRegion label="Loading projects" className="site-nav-group skeleton-nav"><Skeleton variant="control" />{views.map(([label]) => <Skeleton key={label} width="60" />)}</SkeletonRegion>}
        {projects && projects.length > 0 && <div className="site-nav-group"><div className="site-project-picker"><h2 className="site-nav-label">Project</h2><Select aria-label="Current project" value={project?.id || ""} onChange={event => {router.push(`/projects/${event.target.value}`); setOpen(false);}}><option value="" disabled>Select project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
        {project && views.map(([label, segment, Icon]) => navLink(label, `/projects/${project.id}${segment ? "/" + segment : ""}`, Icon, pieces[1] === "projects" && pieces[2] === project.id && section === segment))}</div>}
      </nav>
      <div className="site-account"><EmployeeMenu navigation={false} onNavigate={() => setOpen(false)} /></div>
    </aside>
    <div ref={content} id="site-content" className="site-content" tabIndex={-1}>{children}</div>
  </div>;
}
