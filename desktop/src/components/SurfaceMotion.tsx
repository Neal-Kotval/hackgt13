import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from "react";
import { animate } from "motion/mini";

/** Animate navigation changes, never streamed messages or the lifetime of a session. */
export function useSurfaceMotion(ref: RefObject<HTMLElement | null>, transitionKey: string, active = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    const tokens = getComputedStyle(document.documentElement);
    const read = (name: string) => tokens.getPropertyValue(name).trim();
    const duration = read("--duration-enter");
    const seconds = parseFloat(duration) / (duration.endsWith("ms") ? 1000 : 1);
    const ease = read("--ease-standard").match(/-?\d*\.?\d+/g)?.map(Number);
    if (!seconds || ease?.length !== 4) return;
    const original = ["opacity", "transform"].map(property => ({property, value: element.style.getPropertyValue(property)}));
    const animation = animate(element, {
      opacity: [Number(read("--opacity-reveal-start")), Number(read("--opacity-visible"))],
      transform: [`translateY(${read("--motion-enter-distance")})`, "none"],
    }, { duration: seconds, ease: ease as [number, number, number, number] });
    element.dataset.motionActive = "navigation";
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      animation.cancel();
      original.forEach(({property, value}) => value ? element.style.setProperty(property, value) : element.style.removeProperty(property));
      delete element.dataset.motionActive;
    };
    void animation.finished.then(restore).catch(() => {});
    preference.addEventListener("change", restore);
    return () => { preference.removeEventListener("change", restore); restore(); };
  }, [ref, transitionKey, active]);
}

/** The div stays mounted: terminal connections, focus and drafts are not animation keys. */
export function MotionSurface({ transitionKey, hidden, ...props }: HTMLAttributes<HTMLDivElement> & { transitionKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurfaceMotion(ref, transitionKey, !hidden);
  return <div {...props} ref={ref} hidden={hidden} />;
}
