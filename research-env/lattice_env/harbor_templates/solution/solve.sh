#!/bin/sh
# The oracle: apply the reference repair (fix.json) to the workspace.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
python3 -I - "$here/fix.json" "${LATTICE_WORKSPACE:-/app}" <<'PY'
import json, sys
from pathlib import Path
fix, workspace = Path(sys.argv[1]), Path(sys.argv[2])
for edit in json.loads(fix.read_text("utf-8")):
    path = workspace / edit["path"]
    text = path.read_text("utf-8")
    if text.count(edit["old"]) != 1:
        sys.exit(f"the repair does not apply to {edit['path']}")
    path.write_text(text.replace(edit["old"], edit["new"], 1), "utf-8")
PY
