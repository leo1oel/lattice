// `lattice/module-clock`: rejects reading the wall clock at module level in a
// test file,
//
//   const NOW = Date.now();
//
// unless the file pins the clock with `vi.setSystemTime`. The value is taken
// once, when the file loads, while the code under test reads the live clock
// whenever it runs, so the two can fall on either side of a day boundary.
// overleaf-history.test.tsx flaked on exactly this: a CI run at 00:00:04Z
// built its "today" fixture from a NOW two minutes earlier, and the panel
// rendered "Yesterday". Read the clock inside the test, or pin it.
//
// Only module level is checked: a `describe` body runs at load too, but no
// flake has come from one yet. Widen the rule when one does, not on suspicion.

const MESSAGE =
  "Read the clock inside the test, or pin it with vi.setSystemTime: a module-level clock read is taken at file load and can straddle a day boundary against the code under test.";

function isFunction(node) {
  return node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
}

function isModuleLevel(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    // A class field initializer or method runs per instance, not at load.
    if (isFunction(parent) || parent.type === "PropertyDefinition" || parent.type === "StaticBlock") return false;
  }
  return true;
}

function isMember(node, object, property) {
  return node.type === "MemberExpression" && !node.computed &&
    node.object.type === "Identifier" && node.object.name === object && node.property.name === property;
}

export const moduleClock = {
  meta: {
    type: "problem",
    docs: { description: "Disallow module-level wall-clock reads in tests that do not pin the clock" },
    messages: { moduleClock: MESSAGE },
    schema: [],
  },
  create(context) {
    const reads = [];
    let pinned = false;
    return {
      // Date.now()
      CallExpression(node) {
        if (isMember(node.callee, "vi", "setSystemTime")) pinned = true;
        else if (isMember(node.callee, "Date", "now") && isModuleLevel(node)) reads.push(node);
      },
      // new Date() with no argument; a Date from a literal is deterministic.
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0 && isModuleLevel(node)) {
          reads.push(node);
        }
      },
      "Program:exit"() {
        if (pinned) return;
        for (const node of reads) context.report({ node, messageId: "moduleClock" });
      },
    };
  },
};
