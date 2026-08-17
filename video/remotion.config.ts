/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// remocn components ship Tailwind classes, so the bundler needs the Tailwind
// loader. enableTailwind() installs a `.css` rule using @tailwindcss/webpack;
// rspack consumes webpack loaders, so this works with setRspack(true) above.
// Must be overrideBundlerConfig(): with rspack on, overrideWebpackConfig() is
// silently ignored (Remotion warns and drops it).
Config.overrideBundlerConfig((currentConfiguration) =>
  enableTailwind(currentConfiguration),
);
