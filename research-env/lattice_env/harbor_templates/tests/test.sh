#!/bin/bash
# Harbor's verifier entry. Harbor uploads tests/ to /tests once the agent is
# done and runs this from the task's working directory; the workspace path is
# absolute because Tinker's runner starts it from /root instead.
set -u
mkdir -p /logs/verifier
exec python3 -I /tests/verify.py --workspace "${LATTICE_WORKSPACE:-/app}" --out /logs/verifier
