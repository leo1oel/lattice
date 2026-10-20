"""The verifier every task ships: gates, grading and the pinned TeX build.

Standard library only, with relative imports throughout, because task
packages carry a copy of this folder into their `tests/` and run it inside a
TeX Live container that has nothing else installed.
"""
