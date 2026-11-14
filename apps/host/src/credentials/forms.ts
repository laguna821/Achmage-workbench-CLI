// The shapes a stored value takes when it turns up in text: as typed, and as tools and engines
// encode it on the way (a URL, a Basic-auth header, a JSON document, base64 of a file).

/** Values shorter than this are not looked for: hiding them would blank ordinary words and numbers. */
export const MIN_VALUE = 8;

/** Characters that do not show: a value split by one of them is still the value. */
export const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/;

const escapeNonAscii = (json: string, upper: boolean) => json.replace(/[\u0080-￿]/g, (char) => {
  const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
  return `\\u${upper ? hex.toUpperCase() : hex}`;
});

/**
 * Every form of a value: as written; URL-encoded (either case of escape, and as a form field);
 * base64 and base64url (padded or not), also the stable middle of the base64 of a longer text such
 * as `user:value`; hex; JSON-escaped (as JavaScript writes it, with non-ASCII as \u escapes as
 * Python writes it, with `/` escaped, and escaped twice); a card number however it was typed:
 * its digits alone and in the common groupings (4-4-4-4, and 4-6-5 for 15 digits), with spaces or dashes.
 */
export function formsOf(value: string): string[] {
  if (value.length < MIN_VALUE) return [];
  const card = cardDigits(value);
  if (card && card !== value) return [...new Set([value, ...formsOf(card)])].filter((form) => form.length >= MIN_VALUE);
  const bytes = Buffer.from(value, "utf8");
  const uri = encodeURIComponent(value);
  const forms = [value, uri, uri.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()), new URLSearchParams({ v: value }).toString().slice(2)];
  for (const b64 of [bytes.toString("base64"), bytes.toString("base64url")]) forms.push(b64, b64.replace(/=+$/, ""));
  for (let shift = 0; shift < 3; shift += 1) {
    const whole = Math.floor((bytes.length - shift) / 3) * 3;
    if (whole < 6) continue;
    const aligned = bytes.subarray(shift, shift + whole);
    forms.push(aligned.toString("base64"), aligned.toString("base64url"));
  }
  forms.push(bytes.toString("hex"), bytes.toString("hex").toUpperCase());
  const json = JSON.stringify(value).slice(1, -1);
  for (const escaped of [json, escapeNonAscii(json, false), escapeNonAscii(json, true)]) forms.push(escaped, escaped.replace(/\//g, "\\/"), JSON.stringify(escaped).slice(1, -1));
  if (card) for (const groups of cardGroups(card)) forms.push(groups.join(" "), groups.join("-"));
  return [...new Set(forms)].filter((form) => form.length >= MIN_VALUE);
}

/** The digits of a card number (13–19 digits, typed with or without spaces or dashes), else null. */
export function cardDigits(value: string): string | null {
  if (!/^[\d][\d -]*$/.test(value)) return null;
  const digits = value.replace(/[ -]/g, "");
  return /^\d{13,19}$/.test(digits) ? digits : null;
}

/** The groupings card numbers are written in. */
function cardGroups(digits: string): string[][] {
  const groups = [digits.match(/.{1,4}/g)!];
  if (digits.length === 15) groups.push([digits.slice(0, 4), digits.slice(4, 10), digits.slice(10)]);
  return groups;
}
