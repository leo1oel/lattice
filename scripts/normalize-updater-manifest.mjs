import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Public downloads must not consume GitHub's anonymous REST API quota.
// Resolve against release metadata rather than guessing platform filenames.
export function normalizeUpdaterManifest(manifest, release) {
  if (release.tag_name !== `v${manifest.version}`) {
    throw new Error("Updater version does not match the release tag");
  }
  if (!manifest.platforms || Object.keys(manifest.platforms).length === 0) {
    throw new Error("Updater manifest has no platforms");
  }
  const platforms = Object.fromEntries(Object.entries(manifest.platforms).map(([platform, entry]) => {
    const asset = release.assets.find((candidate) => (
      candidate.url === entry.url || candidate.browser_download_url === entry.url
    ));
    if (!asset || asset.state !== "uploaded" || !entry.signature) {
      throw new Error(`Missing uploaded, signed asset for ${platform}`);
    }
    const url = new URL(asset.browser_download_url);
    // Draft assets use a temporary tag until publication, even when the real
    // Git tag already exists. Only rewrite the temporary tag of this release.
    if (release.draft && release.html_url) {
      const draftTag = new URL(release.html_url).pathname.split("/").at(-1);
      if (draftTag.startsWith("untagged-")) {
        url.pathname = url.pathname.replace(`/releases/download/${draftTag}/`, `/releases/download/${release.tag_name}/`);
      }
    }
    if (url.origin !== "https://github.com" || !url.pathname.includes(`/releases/download/${release.tag_name}/`)) {
      throw new Error(`Invalid public download URL for ${platform}`);
    }
    return [platform, { ...entry, url: url.href }];
  }));
  return { ...manifest, platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , manifestPath, releasePath] = process.argv;
  if (!manifestPath || !releasePath) {
    throw new Error("Usage: node scripts/normalize-updater-manifest.mjs <latest.json> <release.json>");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify(normalizeUpdaterManifest(manifest, release), null, 2)}\n`);
}
