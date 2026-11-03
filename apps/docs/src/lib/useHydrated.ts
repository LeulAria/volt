import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in the server's HTML and during hydration, true after. Decorative drawings (large inline SVGs)
 * render only then, so they stay out of the HTML that crawlers and agents read; nothing visible changes,
 * since their animations start hidden.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
