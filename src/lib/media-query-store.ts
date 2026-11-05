/**
 * One media query as a `useSyncExternalStore` source. Make it once, at module
 * level, so `subscribe` keeps its identity and React does not resubscribe on
 * every render.
 */
export function mediaQueryStore(query: string) {
  return {
    subscribe(onChange: () => void) {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    matches: () => window.matchMedia(query).matches,
  };
}
