#!/usr/bin/env python3
"""Score a workspace against this task: `python3 -I verify.py --workspace DIR [--out DIR]`."""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lattice_verifier.cli import main  # noqa: E402

sys.exit(main(tests_dir=HERE))
