# Desktop companion

Settings → Appearance → Desktop companion imports a local sprite pet and
turns its floating window on or off. The companion is optional and disabled
until a package has been selected. It does not require an AI login.

Use **Import pet** to choose a `pet.json` file. For example, an existing custom
Codex pet (including Angry Dario) can be imported from its local package folder.
Lattice copies the manifest's artwork into its own application data; it never
modifies the source package. Personal artwork is not bundled with Lattice.

```json
{
  "id": "my-pet",
  "displayName": "My pet",
  "spriteVersionNumber": 1,
  "spritesheetPath": "spritesheet.webp"
}
```

The optional version defaults to 1 for existing packages. Version 1 uses a
1536 × 1872 atlas (eight columns and nine rows); version 2 uses 1536 × 2288
(eleven rows). Each cell is 192 × 208 pixels. Both PNG and WebP are accepted,
up to 8 MiB. The spritesheet must resolve inside the selected package folder,
including when the path contains a symlink. No SVG, remote URL or script is
accepted. Extra manifest metadata is ignored.

The standard animation rows are idle, right, left, wave, jump, failed,
waiting, running and review. Lattice uses idle while ready, running during
LaTeX builds and review while an agent turn is active. Click the pet to wave.
Build activity takes priority over agent activity. The version 2 look-direction
rows are accepted as part of the atlas but are not used yet.

Hover or focus the companion to reveal its drag and hide buttons. Dragging
moves its native window. Hide also turns off the saved setting; enabling it
again is explicit. An enabled pet is restored on the next desktop launch,
without bringing the workspace into focus. Window position is not persisted.
The operating system's reduced-motion preference shows a still idle frame and
stops animation scheduling, including when changed while the pet is open.

The companion is a separate transparent native window, loaded from `pet.html`.
It does not mount App, open a project or start an agent. Its capability grants
only core window operations and dragging, with no clipboard, file picker,
opener, updater or process plugin access. Import and enable commands validate
their calling workspace window. The companion itself can hide and read its
copied artwork and activity status. Browser and headless clients do not show
the native companion setting.

## Verification

Frontend consumer tests import, toggle, cancel and reject a package through the
real settings component, and mount the companion entry to exercise its art,
activity, reduced-motion, dragging, hiding and cleanup behavior. Rust tests
cover legacy/v2 manifests, PNG and lossless WebP headers, copied persistence,
invalid layouts, unsupported versions/formats, and path/symlink escape.

Native smoke checklist: import a real package, enable it, move the floating
window, click to wave, run a build, start/end an agent turn, change reduced
motion, hide it, reopen it, and restart the app with it enabled. No provider
login is necessary to check import, dragging or build activity.
