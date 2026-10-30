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

## Component state

New code does not call `useState`; `lattice/no-use-state` rejects it.

- State one component owns uses React's `useReducer`, so every transition is a
  named action handled in one reducer.
- State several components read or change lives in a shared Zustand store
  rather than being lifted and passed down.
- Only where a state change must itself trigger a side effect, use a
  useEffectReducer-style reducer that returns the effects to run alongside
  the next state, instead of a `useEffect` that watches the state.

Files that used `useState` when the rule landed are listed in the last
override in `.oxlintrc.json`. Migrating a file means deleting its entry;
`scripts/check-use-state-allowlist.mjs` fails on a new entry or on one whose
file no longer uses `useState`.
