import { useSyncExternalStore, useCallback } from "react";

export type Route = "home" | "features" | "download" | "about";

const ROUTES: Route[] = ["home", "features", "download", "about"];

function currentRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0] as Route;
  return ROUTES.includes(hash) ? hash : "home";
}

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function useRoute(): [Route, (route: Route) => void] {
  const route = useSyncExternalStore(subscribe, currentRoute, () => "home" as Route);

  const navigate = useCallback((next: Route) => {
    if (currentRoute() !== next) {
      window.location.hash = `/${next}`;
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  return [route, navigate];
}
