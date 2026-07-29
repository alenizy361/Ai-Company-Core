// Bidirectional text helpers. Technical content (ids, paths, URLs, code)
// keeps LTR inside RTL layouts via isolation; user prose gets dir="auto".
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function isArabic(text) {
  return ARABIC_RE.test(text);
}

/** Dominant language of a text: 'ar' when Arabic letters outnumber Latin. */
export function langOf(text) {
  const arabic = (text.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin ? 'ar' : 'en';
}
