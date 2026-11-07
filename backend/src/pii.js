// PII / secret scrubbing used before any user-history data enters a training dataset.
// Mirrors training/approx_data/pii.py so server export and offline pipeline agree.
const RULES = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['API_KEY', /\b(?:sk|pk|apx|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['CNIC', /\b\d{5}-\d{7}-\d\b/g],                       // Pakistan CNIC
  ['IBAN', /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g],
  ['CARD', /\b(?:\d[ -]?){13,19}\b/g],
  ['PHONE', /(?:\+92|0092|\b0)3\d{2}[ -]?\d{7}\b|\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g],
  ['IP', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['PASSWORD', /\b(password|passwd|pwd|pass)\s*[:=]\s*\S+/gi],
];

export function scrubPii(text) {
  let count = 0;
  let out = String(text);
  for (const [label, re] of RULES) out = out.replace(re, () => { count++; return `[${label}]`; });
  return { text: out, count };
}

export function qualityOk(user, assistant) {
  if (user.trim().length < 4 || assistant.trim().length < 8) return false;
  if (assistant.length > 20000 || user.length > 20000) return false;
  if (/^I can't help with that\./.test(assistant)) return false; // refusals are not SFT targets here
  const redactions = (assistant.match(/\[(EMAIL|PHONE|CARD|CNIC|API_KEY|PASSWORD|PRIVATE_KEY|JWT|IBAN|IP)\]/g) || []).length;
  return redactions <= 5;
}
