/** Build preferences (automatic or manual builds, where build files go), as Settings edits them, shared by every window. */
import { BUILD_PREFERENCES_KEY, loadBuildPreferences } from "../settings/app-settings";
import { changedFields, sharedSetting, useSharedSetting } from "../settings/shared-setting";

// Each field on its own: one window's switch never undoes another's choice.
const buildPreferencesSetting = sharedSetting(BUILD_PREFERENCES_KEY, loadBuildPreferences, { merge: changedFields });

export const useBuildPreferences = () => useSharedSetting(buildPreferencesSetting);

/** Where builds put their intermediate files, read when each build starts, so a switch applies to the next one. */
export const buildAuxFiles = (): "hidden" | "beside" => (buildPreferencesSetting.get().hiddenBuildFiles ? "hidden" : "beside");
