import { lazy, Suspense, useEffect, useReducer } from "react";
import { autoOfferNativeApp, releaseNativeApp, type NativeAppRelease } from "./native-app";

const NativeAppDialog = lazy(() => import("./native-app-dialog").then((module) => ({ default: module.NativeAppDialog })));

/**
 * The native app's automatic offer (native-app.ts), mounted for every window
 * but loaded on demand, so none of it sits on the startup path: the dialog
 * once this launch qualifies and the check finds a release, held back while
 * What's new is open so the two sheets never stack. The dialog records how
 * it was answered.
 */
export function NativeAppOffer({ whatsNewOpen }: { whatsNewOpen: boolean }) {
  const [release, setRelease] = useReducer((_: NativeAppRelease | null, next: NativeAppRelease | null) => next, null);
  useEffect(() => {
    let cancelled = false;
    void autoOfferNativeApp().then((found) => {
      if (found && cancelled) releaseNativeApp(found);
      else if (found) setRelease(found);
    });
    return () => { cancelled = true; };
  }, []);
  if (!release || whatsNewOpen) return null;
  return (
    <Suspense fallback={null}>
      <NativeAppDialog release={release} onClose={() => setRelease(null)} />
    </Suspense>
  );
}
