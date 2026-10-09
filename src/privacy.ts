// Personal-data patterns, shared by tool visibility and trace masking. Best-effort by design:
// the real guarantee is that the model only sees fields a tool makes visible.

const PERSONAL_NAME = /e-?mail|phone|mobile|address|street|postcode|postal|zip|dob|birth|ssn|social_?security|card_?(number|num|no)|iban|pin\b|password|passcode|secret|token|passport|tax_?id|national_?id|licen[cs]e|account_?(number|num|no)|routing/i;

/** True when a field's name says it holds personal data or a secret (e.g. email, homeAddress, dob, cardNumber, pin, apiToken). */
export const isPersonalName = (key: string) => PERSONAL_NAME.test(key);

const luhn = (d: string) => [...d].reverse().reduce((s, c, i) => s + (i % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][+c] : +c), 0) % 10 === 0;

// Order matters: emails first (they may contain digits), then SSN, then the digit run that is a card (Luhn) or a
// phone (10+ digits). The digit run is deliberately greedy, so a long reference number also masks; visibility is the guarantee.
const MASKS: [RegExp, (m: string) => string][] = [
  [/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, () => "[email]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, () => "[ssn]"],
  [/\+?\d[\d\s().-]{8,}\d/g, (m) => {
    const d = m.replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return "[card]";
    return d.length >= 10 ? "[phone]" : m;
  }],
  [/\b\d{1,6}\s+(?:[A-Z][a-z]+\s)+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b\.?/gi, () => "[address]"],
];

/** Replace emails, SSNs, card numbers, phone numbers and street addresses inside text; keep the rest. */
export function maskText(text: string): string {
  return MASKS.reduce((t, [re, fn]) => t.replace(re, fn), text);
}
