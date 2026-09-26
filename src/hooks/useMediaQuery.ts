import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches right now, re-rendering when that changes (a phone rotated,
 * a desktop window narrowed). For the cases where a phone should get a different page rather than
 * the same page squeezed — CSS can hide a block, but it still renders, listens and computes.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
