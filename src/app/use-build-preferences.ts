/** Build preferences (automatic or manual builds), as Settings edits them, shared by every window. */
import { BUILD_PREFERENCES_KEY, loadBuildPreferences } from "../settings/app-settings";
import { sharedSetting, useSharedSetting } from "../settings/shared-setting";

const buildPreferencesSetting = sharedSetting(BUILD_PREFERENCES_KEY, loadBuildPreferences);

export const useBuildPreferences = () => useSharedSetting(buildPreferencesSetting);
