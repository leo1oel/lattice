// Lattice's own lint rules, loaded by Oxlint as a JS plugin (.oxlintrc.json
// `jsPlugins`). Rules use the ESLint rule API, which Oxlint implements.
import { appTestUtilsFirst } from "./eslint-app-test-utils-first.mjs";
import { awaitChangedAlert } from "./eslint-await-changed-alert.mjs";
import { moduleClock } from "./eslint-module-clock.mjs";
import { noUseState } from "./eslint-no-use-state.mjs";

// `lattice/visible-attribute-text`: Lingui's no-unlocalized-strings trusts
// every attribute of a native DOM element except `placeholder`, `alt`,
// `aria-label`, and `value`, so the other user-visible attributes need their
// own check. ESLint ran this as `no-restricted-syntax` with these selectors;
// Oxlint has no native no-restricted-syntax.
const VISIBLE_ATTRIBUTE = "JSXAttribute[name.name=/^(?:title|label|aria-description|aria-roledescription|aria-valuetext|aria-placeholder)$/]";

const visibleAttributeText = {
  meta: {
    type: "problem",
    docs: { description: "Require translated text in user-visible JSX attributes" },
    messages: { untranslated: "Visible attribute text must be translated: use t`…` from useLingui()." },
    schema: [],
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: "untranslated" });
    return {
      [`${VISIBLE_ATTRIBUTE} > Literal[value=/[A-Za-z]{2}/]`]: report,
      [`${VISIBLE_ATTRIBUTE} > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]{2}/]`]: report,
    };
  },
};

export default {
  meta: { name: "lattice" },
  rules: {
    "app-test-utils-first": appTestUtilsFirst,
    "await-changed-alert": awaitChangedAlert,
    "module-clock": moduleClock,
    "no-use-state": noUseState,
    "visible-attribute-text": visibleAttributeText,
  },
};
