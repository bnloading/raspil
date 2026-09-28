import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return () => {};
  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
  return () => {
    vv.removeEventListener("resize", onChange);
    vv.removeEventListener("scroll", onChange);
  };
};

const measure = () => {
  const vv = window.visualViewport;
  return vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
};

/**
 * How many px of the bottom of the screen the on-screen keyboard is covering right now (0 when
 * there is none, and always 0 on a desktop).
 *
 * iOS does not shrink the page when its keyboard opens — it slides the keyboard over it — so a
 * bottom sheet pinned with `position: fixed; bottom: 0` ends up behind the keyboard with only its
 * top edge showing. The visual viewport is the part still visible; the gap between it and the
 * layout viewport is the keyboard, and lifting the sheet by that much keeps its field and buttons
 * in view.
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, measure, () => 0);
}
