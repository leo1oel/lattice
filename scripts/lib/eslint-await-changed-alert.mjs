// `lattice/await-changed-alert`: rejects
//
//   expect(await screen.findByRole("alert")).toHaveTextContent(...)
//
// findByRole resolves with the first alert it sees. When an alert is already
// on screen (an earlier save's error, say), it resolves with that one at once
// and the content assertion runs before React replaces the text, so the test
// passes or fails on scheduling. bib-entry-dialog.test.tsx flaked on exactly
// this under CI load. Waiting for the content itself has no such race:
//
//   await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(...))
//
// The rule is deliberately this one AST shape; widen it only when another
// shape is reproduced, not on suspicion.

const MESSAGE =
  "Wait for the alert's expected content inside `waitFor`; an existing alert can satisfy `findByRole` before its content changes.";

function isFindAlert(node) {
  if (node?.type !== "CallExpression") return false;
  const { callee } = node;
  const name = callee.type === "MemberExpression" ? callee.property.name : callee.name;
  const [role] = node.arguments;
  return name === "findByRole" && role?.type === "Literal" && role.value === "alert";
}

export const awaitChangedAlert = {
  meta: {
    type: "problem",
    docs: { description: "Disallow asserting an alert's text straight off findByRole(\"alert\")" },
    messages: { awaitChangedAlert: MESSAGE },
    schema: [],
  },
  create(context) {
    return {
      // expect(<await findByRole("alert")>).toHaveTextContent(...)
      "CallExpression[callee.type='MemberExpression'][callee.property.name='toHaveTextContent']"(node) {
        const target = node.callee.object;
        if (target.type !== "CallExpression" || target.callee.type !== "Identifier" || target.callee.name !== "expect") return;
        const [subject] = target.arguments;
        if (subject?.type === "AwaitExpression" && isFindAlert(subject.argument)) {
          context.report({ node, messageId: "awaitChangedAlert" });
        }
      },
    };
  },
};
