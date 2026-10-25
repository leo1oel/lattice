/**
 * How scripts/generate-notices.mjs judges a declared license against Lattice's
 * own Apache-2.0: permissive, or one of the findings it lists for a human.
 */

const PERMISSIVE = new Set([
  "0bsd", "apache-2.0", "blueoak-1.0.0", "bsd-2-clause", "bsd-3-clause", "bsl-1.0",
  "cc0-1.0", "cdla-permissive-2.0", "isc", "mit", "mit-0", "mit/x11", "python-2.0",
  "unicode-3.0", "unlicense", "wtfpl", "zlib",
]);

// Copyleft families in match order (LGPL and AGPL before the `gpl` they
// contain). A permissive alternative in the same expression makes any of them
// `dual` instead.
const COPYLEFT = [
  [/\blgpl/, "weak-copyleft", "LGPL (weak copyleft)", "LGPL offered as one alternative"],
  [/\bagpl/, "strong-copyleft", "AGPL (network copyleft)", "AGPL offered as one alternative"],
  [/\bgpl/, "strong-copyleft", "GPL (strong copyleft)", "GPL offered as one alternative"],
  [
    /\bmpl|\bepl-|\bcddl|\bcpl-|\bosl-|\beupl/,
    "weak-copyleft",
    "file-level copyleft",
    "file-level copyleft offered as one alternative",
  ],
];

/**
 * The alternative Lattice takes from a dual-licensed dependency: Apache-2.0,
 * Lattice's own license, when it is offered, else the first permissive one.
 */
function electedLicense(expression) {
  const offered = expression.replace(/[()]/g, " ").split(/\s+OR\s+|\s*\/\s*/i).map((part) => part.trim()).filter(Boolean);
  return offered.find((alt) => alt.toLowerCase() === "apache-2.0")
    ?? offered.find((alt) => PERMISSIVE.has(alt.toLowerCase()))
    ?? offered[0];
}

/** Rough top-level split of an SPDX-ish expression into its alternatives. */
function licenseAlternatives(expression) {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+|\s*\/\s*/i)
    .map((part) => part.trim().replace(/\s+WITH\s+.*$/i, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Flag anything that is not plainly permissive. For an Apache-2.0 project a
 * copyleft, an SSPL or a proprietary dependency is a real finding, and a
 * "SEE LICENSE IN ..." field means the terms are whatever that file says.
 */
export function classifyLicense(entry) {
  const declared = entry.declared;
  if (!declared) return { severity: "unknown", label: "no license field" };
  const value = declared.toLowerCase();
  const combined = entry.texts.map((text) => text.text).join("\n").toLowerCase();

  if (/\bsee licen[cs]e in\b|\bunlicensed\b|\bproprietary\b|\bcustom\b/.test(value)) {
    if (/all rights reserved|no license is granted/.test(combined)) {
      return { severity: "proprietary", label: "proprietary / all rights reserved" };
    }
    // The field is non-SPDX but the file it points at turns out to be an
    // ordinary permissive license. Worth listing — the declaration is
    // misleading — but it is not a source-available dependency.
    if (/permission is hereby granted, free of charge|redistribution and use in source/.test(combined)) {
      return {
        severity: "non-spdx",
        label: "non-SPDX `license` field; the file it points at is a permissive license",
      };
    }
    return { severity: "source-available", label: "non-SPDX license reference" };
  }
  if (/\bbusl|\bbsl-1\.1|\belastic-|polyform|commons clause|\bssp?l-/.test(value)) {
    return { severity: "source-available", label: "source-available license" };
  }
  const permissiveOption = licenseAlternatives(declared).some((alt) => PERMISSIVE.has(alt));
  for (const [pattern, severity, label, dualLabel] of COPYLEFT) {
    if (pattern.test(value)) {
      return permissiveOption ? { severity: "dual", label: `${dualLabel}; Lattice elects ${electedLicense(declared)}` } : { severity, label };
    }
  }
  if (/\bofl-|open font/.test(value)) {
    return { severity: "reciprocal", label: "SIL OFL (reserved-name and bundling terms)" };
  }
  return { severity: "permissive", label: declared };
}

export const SEVERITY_ORDER = [
  "proprietary", "source-available", "strong-copyleft", "weak-copyleft", "reciprocal", "dual", "non-spdx", "unknown",
];
