"use client";

import { animate } from "motion/mini";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import "./site-motion.css";

// Explicit surfaces avoid animating live task text or every streamed state update.
const surfaces = "main, .organization-panel, .project-row, .agent-card, .service-card, .review-card, .welcome-panel, .auth-panel, .toast, .alert, .select-menu";

export function SiteMotion({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const seen = new WeakSet<Element>();
    const running = new Map<HTMLElement, { animation: ReturnType<typeof animate>; restore: () => void }>();
    function stopAll() {
      for (const [element, { animation, restore }] of running) {
        animation.cancel();
        restore();
        element.removeAttribute("data-motion-active");
      }
      running.clear();
    }
    function enter(element: HTMLElement, kind: "surface" | "drawer" | "dialog" = "surface") {
      if (preference.matches || !element.isConnected || !element.getClientRects().length) return;
      const tokens = getComputedStyle(document.documentElement);
      const read = (name: string) => tokens.getPropertyValue(name).trim();
      const duration = parseFloat(read("--duration-enter")) / 1000;
      const easing = read("--ease-standard").match(/-?\d*\.?\d+/g)?.map(Number);
      if (!duration || easing?.length !== 4) return;
      const previous = running.get(element);
      previous?.animation.cancel();
      previous?.restore();
      const fadeOnly = element.matches(".select-menu, .toast");
      const originals = (fadeOnly ? ["opacity"] : ["opacity", "transform"]).map(property => ({property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property)}));
      const restore = () => originals.forEach(({property, value, priority}) => {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      });
      const opacity = [Number(read("--opacity-reveal-start")), Number(read("--opacity-visible"))];
      // Radix owns menu positioning; fade its surface without changing its transform.
      const transform = fadeOnly ? undefined : [
        kind === "drawer"
          ? `translateX(calc(-1 * ${read("--motion-drawer-distance")}))`
          : `translateY(${read("--motion-enter-distance")})`,
        "none",
      ];
      const animation = animate(element, { opacity, ...(transform ? { transform } : {}) }, {
        duration,
        ease: easing as [number, number, number, number],
      });
      running.set(element, { animation, restore });
      element.setAttribute("data-motion-active", kind);
      void animation.finished.then(() => {
        if (running.get(element)?.animation !== animation) return;
        // Remove runtime transforms so sticky positioning and portals remain native.
        animation.cancel();
        restore();
        running.delete(element);
        element.removeAttribute("data-motion-active");
      }).catch(() => {});
    }
    function discover(root: ParentNode) {
      const candidates = [
        ...(root instanceof HTMLElement && root.matches(surfaces) ? [root] : []),
        ...root.querySelectorAll<HTMLElement>(surfaces),
      ];
      const fresh = candidates.filter(element => !seen.has(element));
      fresh.forEach(element => seen.add(element));
      // Animate the containing surface once instead of compounding nested fades.
      for (const element of fresh) {
        if (!fresh.some(parent => parent !== element && parent.contains(element))) enter(element);
      }
    }
    discover(document);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "childList") {
          record.addedNodes.forEach(node => {if (node instanceof HTMLElement) discover(node);});
        } else if (record.target instanceof HTMLDialogElement && record.target.open) {
          const inner = record.target.querySelector<HTMLElement>(".modal-inner");
          if (inner) enter(inner, "dialog");
        } else if (record.target instanceof HTMLElement && record.target.matches('.site-sidebar[data-open="true"]')) {
          enter(record.target, "drawer");
        }
      }
      // Detached surfaces cannot finish visibly; release their animations immediately.
      for (const [element, { animation, restore }] of running) {
        if (!element.isConnected) {animation.cancel(); restore(); element.removeAttribute("data-motion-active"); running.delete(element);}
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "data-open"] });
    const reduce = () => {if (preference.matches) stopAll();};
    preference.addEventListener("change", reduce);
    return () => {observer.disconnect(); preference.removeEventListener("change", reduce); stopAll();};
  }, [pathname]);
  return children;
}
