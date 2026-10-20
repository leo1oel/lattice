#!/usr/bin/env python3
"""Run this task's self-tests: `python3 -I selftest.py`, from anywhere."""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lattice_verifier.selftest import main  # noqa: E402

sys.exit(main([], task_dir=HERE.parent))
