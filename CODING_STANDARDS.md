# Coding standards for review

Reviewer judgement that no lint rule or test can enforce. Mechanical rules live
in their checks (the design-token tests, the bundle budget, the source-text test
guard); this file covers what a reviewer has to trace by hand.

## Transition ownership

When a change detaches, hides, replaces, or virtualizes a surface, trace
ownership of every affected live range, focus target, document identity,
pending result, saved viewport, and iframe host. Check the state after the
transition and after the next input. Exercise intermediate nodes and
pending/offscreen states; endpoint-only assertions are insufficient. Require a
red counterfactual through the production consumer for the changed invariant.

For example: a selection spanning PDF pages 1–3 must still copy page 2's text
after page 2 scrolls out of the page window; a Markdown jump to an undrawn
heading must land on the right viewport after it draws and accept typing
immediately.

## Performance evidence

Confirm that before/after use comparable fixtures, readiness definitions and
engine measurements, and that interleaving/load confounds are disclosed.
Counts, browser thread time, frame rate and paint readiness are distinct
metrics. Require source-backed attribution before crediting a speedup.
