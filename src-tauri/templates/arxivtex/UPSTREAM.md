# arXivTeX template

This directory vendors `main/main.cls` from [wanghao9610/arXivTeX](https://github.com/wanghao9610/arXivTeX) at commit `a38b642dd4ff671e5315bac1bd7ecd6db291b981` under its MIT license.

Lattice adds a `\providecommand` compatibility declaration for `\theHALG@line` so the class compiles with TeX Live versions where `hyperref` has not defined that command before the algorithm setup runs.
