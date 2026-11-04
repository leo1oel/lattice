export const PRODUCTS = [
  "docs",
  "sheets",
  "slides",
  "forms",
  "calendar",
] as const;
export type Product = (typeof PRODUCTS)[number];
/* eslint-disable lingui/no-unlocalized-strings -- Google's product trademarks keep their names in both interfaces */
export const PRODUCT_NAMES = {
  docs: "Google Docs",
  sheets: "Google Sheets",
  slides: "Google Slides",
  forms: "Google Forms",
  calendar: "Google Calendar",
};
