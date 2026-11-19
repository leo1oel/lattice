# Publishing a plugin

The plugin market in **Settings › Plugins › Browse** lists plugins from the Lattice registry, a GitHub repository where each plugin is one small entry added by pull request. The entry pins a tag of your source repository and the SHA-256 of your plugin folder packed at that tag. The registry never takes a zip you built: its CI packs your tagged folder itself and publishes that zip only when the hashes match, so what a reviewer read is byte for byte what people install.

This page takes the Hello plugin from [Your first plugin](plugin-development.md) to the market. Themes go through the same registry; see [Making a theme](theme-development.md).

## Registry addresses

This table and the commands under [Signing](#6-signing) are the only places in this guide that name the registry, so they are what changes when the registry moves to the lattice-writer GitHub organization.

| What | Where |
|---|---|
| The registry repository | [lattice-writer/lattice-plugins][registry] |
| Its README: entry format and CI checks | [README.md][registry-readme] |
| The review checklist | [REVIEW.md][review] |
| The pull request checklist | [pull_request_template.md][pr-template] |
| The kill switch | [blocked.json][blocked] |
| The signed index Lattice reads | [index.json][index], with [index.json.minisig][index-sig] |
| The public signing key | [keys/primary.pub][primary-key] |

## Before you publish

The registry checks these, and a reviewer reads the rest:

- The plugin is a `node` plugin whose scripts are readable source: no minified or generated code (no line over 1,000 characters), no `eval`, `new Function` or `vm`, and no fetching and running remote code. Vendor any dependency as readable source inside the folder.
- The manifest has a `description` and a `license` Lattice accepts (see [the manifest](plugin-reference.md#the-manifest)).
- The folder has a `README.md` and a `LICENSE` file. The README names every `network` origin and `network-local` port with the reason, says what each secret is for, and says plainly if the plugin sends project content off the Mac.
- The `id` is yours and doesn't impersonate anyone: no "Lattice" or "Overleaf" names without permission, no look-alike ids.
- You ran every command in Lattice from a folder install.

For Hello, add a `README.md`:

```markdown
# Hello

A Lattice plugin that greets you and counts the words you selected.

## What it reads

- `project-read = ["context"]`: the project's name, the active file and the selected text, to put them in its answers.

It makes no network connections and sends nothing off your Mac.
```

and a `LICENSE` with the MIT licence text and your name.

## 1. Tag your source

Push the plugin folder to a public GitHub repository, here `https://github.com/yourname/lattice-hello` with the plugin at its root, then tag the commit you want listed:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The plugin can also live in a subfolder of a bigger repository; the entry's `path` then names that folder.

## 2. Pack it and get its hash

Pack a clean checkout of the tag with Lattice's pack script:

```sh
curl -fsSLO https://raw.githubusercontent.com/leo1oel/lattice/main/plugin-sdk/scripts/pack-plugin.mjs
git clone --quiet --depth 1 --branch v0.1.0 https://github.com/yourname/lattice-hello release
node pack-plugin.mjs release dist/hello-0.1.0.zip
```

It prints the zip's path and its SHA-256:

```text
/Users/you/dist/hello-0.1.0.zip
sha256 c6d59e1c411f807169880145090894fb684ecdf624f13351a97f60e48399db87
```

The pack is reproducible: the same files give the same bytes on any Mac or CI runner, whatever their timestamps, owners or the order the disk lists them in. It takes the regular files under the folder, sorted by path, leaves out tests (`*.test.mjs`) and anything whose name starts with a dot (so `.git` stays out), and stores each one uncompressed with a fixed 1980-01-01 time and permissions 0644, or 0755 for an executable. Entries are stored rather than compressed because compressed bytes differ between zlib versions, so a compressed zip would hash differently on your Mac and in the registry's CI. `unzip -v dist/hello-0.1.0.zip` lists every entry as `Stored`.

Pack the clean clone, not your working folder. CI packs exactly what git has at the tag, so an untracked file in your folder, or a file whose executable bit git doesn't record, gives a hash CI won't reproduce. Packing twice gives the same hash; if it doesn't, something in the folder is changing.

## 3. Add the entry

Fork the registry ([addresses](#registry-addresses)), and in your fork add `plugins/<id>/entry.json`, here `plugins/io.github.yourname.hello/entry.json`:

```json
{
  "id": "io.github.yourname.hello",
  "version": "0.1.0",
  "repository": "https://github.com/yourname/lattice-hello",
  "tag": "v0.1.0",
  "commit": "<the full 40-character sha the tag points at>",
  "path": ".",
  "sha256": "c6d59e1c411f807169880145090894fb684ecdf624f13351a97f60e48399db87",
  "author": "Your Name",
  "categories": ["writing"]
}
```

- `id` and `version` equal the manifest's, and the folder name equals `id`.
- `commit` is what `git rev-parse "v0.1.0^{commit}"` prints in your repository.
- `path` is the plugin folder inside the repository, or `"."` for its root.
- `sha256` is what `pack-plugin.mjs` printed.
- `categories` lists up to four lower-case words, such as `citations`, `bibliography` or `writing`.

Run the same checks as CI before you open the pull request. In your fork's checkout, with its `main` up to date and Node 22 or later:

```sh
npm ci
node scripts/validate.mjs --base origin/main
```

For a new plugin it prints:

```text
ok   plugins/io.github.yourname.hello/entry.json
     note: asks for: {"projectRead":["context"],"networkLocal":[],"network":[],"secrets":[]}
     note: new plugin: needs a human review per REVIEW.md (first submission)
```

A wrong hash fails with `sha256 mismatch: the entry says …, the pack of . at <commit> is …`. Then open the pull request, one entry per pull request, and fill in its checklist.

## 4. What CI checks

On every pull request, the registry's `validate.mjs` fetches only your tag, requires it to point at `commit`, and reads the folder from git's object store at that commit. Then it:

- refuses symlinks and submodules, and keeps within Lattice's limits: 10,000 files, 200 MiB unpacked, a 50 MiB zip;
- packs the folder and compares the SHA-256 with the entry's;
- checks the manifest as Lattice does (schema, id, version, API level, name, permissions and commands), plus the market's rules: runtime `node`, a description, an accepted licence, a README and a licence file;
- rejects scripts with lines over 1,000 characters or that use `eval`, `new Function` or `vm`;
- for an update, checks that `version` went up, prints what the new version asks for beyond the published one, and flags a changed repository or runtime;
- checks that `blocked.json` is well formed.

## 5. Review

CI does the mechanical half; a maintainer (today, Leo) does the rest with [REVIEW.md][review] and writes the answers in the pull request. A human reviews every first submission, and any update that changes the repository or owner, grows the permissions, or changes the runtime. Other updates merge after green CI and a 24-hour cooling period, during which any maintainer can hold them.

The reviewer reads your source at the pinned commit and asks:

1. Is the id or name impersonating someone?
2. Is the description accurate, the licence present, and the repository real and public? A port credits its original author.
3. Do the permissions fit the stated purpose, with every origin, port and secret explained in the README?
4. Does it send project content off the Mac, and if so, do the README and description say so plainly?
5. Is the source readable, with no fetching and running remote code, and no dependencies that aren't vendored as readable source?
6. Does it duplicate a built-in feature in a misleading way?

## 6. Signing

You don't sign anything. Once your pull request merges, the registry's publish workflow packs every entry, builds `index.json` and `blocked.json`, signs both with the registry's minisign key, and publishes them with the zips to GitHub Pages. The signing job runs only from `main` and waits for Leo's approval on every run, and the private key exists only as a secret of that job's protected environment.

Lattice checks both signatures against public keys built into the app, refuses an index older than the last one it verified, and checks every zip's SHA-256 and manifest against the index before installing it. So neither a compromised download server nor someone with access to your GitHub account can change what people install. To check the published index yourself:

```sh
curl -fsSLO https://leo1oel.github.io/lattice-plugins/index.json
curl -fsSLO https://leo1oel.github.io/lattice-plugins/index.json.minisig
curl -fsSLO https://raw.githubusercontent.com/lattice-writer/lattice-plugins/main/keys/primary.pub
minisign -V -p primary.pub -m index.json
```

It prints `Signature and comment signature verified` and a trusted comment like `lattice-plugins file:index.json serial:2`. (`brew install minisign` installs minisign.)

Your plugin shows in **Browse** after the next publish, marked **Reviewed** once installed.

## Updates and permission changes

To ship a new version:

1. Raise `version` in `lattice-plugin.toml`, commit, and tag the commit (`v0.2.0`).
2. Pack the clean tag again, as in step 2.
3. In your entry, change `version`, `tag`, `commit` and `sha256`, and open a pull request.

Versions only go up, and the repository should stay the same: a move needs a human review. When an update asks for more, CI says exactly what is new, for example:

```text
ok   plugins/io.github.yourname.hello/entry.json
     note: asks for: {"projectRead":["context"],"networkLocal":[],"network":["https://api.crossref.org"],"secrets":[]}
     note: new network: https://api.crossref.org
     note: permissions grew: needs a human review
```

What people see in **Settings › Plugins**:

- An update that asks for nothing new is applied by **Update all**, and the plugin stays on.
- An update that asks for more waits on its own card, which lists only what is new, with **Allow and update** or keep the version they have.

So keep permissions stable, and when you need a new one, explain it in the README and in the pull request. A folder install behaves the same way while you develop: a new permission stops the plugin until you choose **Review…** and turn it on again.

## The kill switch

If a published version turns out to be harmful or broken, the registry can turn it off on every Mac. [blocked.json][blocked] lists blocked versions and is signed and published with the index:

```json
[
  {
    "id": "io.github.yourname.hello",
    "versions": "<=0.1.0",
    "action": "disable",
    "reason": "Crashes on projects without a main document; update to 0.1.1.",
    "url": "https://github.com/yourname/lattice-hello/issues/1"
  }
]
```

- `versions` is a semver range, or `"*"` for every version.
- `"disable"` turns installed copies off, refuses new installs of those versions, and shows the reason on the plugin's card with **Learn more** linking to `url`. `"warn"` keeps the plugin working and shows the reason as a warning.
- Lattice never deletes the plugin's files or data folder, and it never touches folder installs.
- Removing an entry from `plugins/` only stops new installs. Installed copies keep working unless they are also blocked.

To pull one of your own versions, open a pull request that adds an item to `blocked.json` and publish a fixed version beside it; anyone who finds a harmful plugin can open an issue or pull request the same way. It takes effect on the next signed publish.

[registry]: https://github.com/lattice-writer/lattice-plugins
[registry-readme]: https://github.com/lattice-writer/lattice-plugins#readme
[review]: https://github.com/lattice-writer/lattice-plugins/blob/main/REVIEW.md
[pr-template]: https://github.com/lattice-writer/lattice-plugins/blob/main/.github/pull_request_template.md
[blocked]: https://github.com/lattice-writer/lattice-plugins/blob/main/blocked.json
[index]: https://leo1oel.github.io/lattice-plugins/index.json
[index-sig]: https://leo1oel.github.io/lattice-plugins/index.json.minisig
[primary-key]: https://github.com/lattice-writer/lattice-plugins/blob/main/keys/primary.pub
