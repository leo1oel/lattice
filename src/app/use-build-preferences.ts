/** Build preferences (automatic or manual builds), as Settings edits them, kept in storage as they change. */
import { useEffect, useState } from "react";
import { BUILD_PREFERENCES_KEY, loadBuildPreferences, type BuildPreferences } from "../settings/app-settings";

export function useBuildPreferences() {
  const [buildPreferences, setBuildPreferences] = useState<BuildPreferences>(loadBuildPreferences);
  useEffect(() => {
    try {
      localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify(buildPreferences));
    } catch {
      // Build preferences still apply for the current session without storage.
    }
  }, [buildPreferences]);
  return [buildPreferences, setBuildPreferences] as const;
}
