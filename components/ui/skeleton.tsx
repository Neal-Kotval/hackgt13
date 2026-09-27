import type { ReactNode } from "react";
import "./skeleton.css";

type Width = "20" | "30" | "40" | "50" | "60" | "75" | "90";
type Variant = "text" | "title" | "hero" | "control" | "block" | "icon" | "avatar" | "chip";

// A decorative placeholder; the surrounding SkeletonRegion announces the loading state.
export function Skeleton({ variant = "text", width, className }: { variant?: Variant; width?: Width; className?: string }) {
  return <span className={`skeleton skeleton--${variant}${className ? " " + className : ""}`} data-width={width} aria-hidden="true" />;
}

export function SkeletonRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <div className={`skeleton-region${className ? " " + className : ""}`} role="status" aria-busy="true" aria-live="polite">
    <span className="visually-hidden">{label}</span>
    {children}
  </div>;
}

export function SkeletonRows({ count = 3, icon = true, trailing = true }: { count?: number; icon?: boolean; trailing?: boolean }) {
  const widths: Width[] = ["40", "60", "30", "50"];
  return <>{Array.from({ length: count }, (_, index) => <div className="skeleton-row" key={index}>
    {icon && <Skeleton variant="icon" />}
    <div className="skeleton-row-text"><Skeleton width={widths[index % widths.length]} /><Skeleton width="75" /></div>
    {trailing && <Skeleton variant="chip" />}
  </div>)}</>;
}

export function SkeletonPanel({ rows = 3, icon = true, lines = 0, action = false }: { rows?: number; icon?: boolean; lines?: number; action?: boolean }) {
  return <div className="skeleton-panel">
    <div className="skeleton-panel-heading"><Skeleton variant="title" width="30" /><Skeleton variant="chip" /></div>
    {Array.from({ length: lines }, (_, index) => <Skeleton key={index} width={index === lines - 1 ? "60" : "90"} />)}
    {rows > 0 && <div><SkeletonRows count={rows} icon={icon} /></div>}
    {action && <Skeleton variant="control" width="20" />}
  </div>;
}

export function SkeletonHeading({ action = true }: { action?: boolean }) {
  return <div className="skeleton-heading">
    <div className="skeleton-heading-text"><Skeleton width="20" /><Skeleton variant="hero" width="40" /><Skeleton width="50" /></div>
    {action && <Skeleton variant="control" />}
  </div>;
}
