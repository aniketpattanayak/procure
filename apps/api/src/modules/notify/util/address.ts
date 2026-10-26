/** Recipient address checks per channel. */
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const E164 = /^\+[1-9]\d{7,14}$/;

export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);
export const isE164 = (s: string) => E164.test(s);

/**
 * Normalises a phone number to E.164. Spaces, dashes, dots and brackets are dropped; `00` becomes `+`; a bare
 * 10-digit number gets the default country code (tenants are Indian today: 91). Returns null when not a phone.
 */
export function normalisePhone(raw: string, defaultCc = '91'): string | null {
  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    if (/^0\d{10}$/.test(s)) s = s.slice(1);
    if (/^\d{10}$/.test(s)) s = `+${defaultCc}${s}`;
    else if (/^\d{11,15}$/.test(s)) s = `+${s}`;
  }
  return isE164(s) ? s : null;
}

export function normaliseAddress(channel: 'email' | 'whatsapp', raw: string): { address: string; valid: boolean; reason?: string } {
  const v = raw.trim();
  if (channel === 'email') {
    const e = v.toLowerCase();
    return isEmail(e) ? { address: e, valid: true } : { address: v, valid: false, reason: 'Not a valid email address' };
  }
  const p = normalisePhone(v);
  return p ? { address: p, valid: true } : { address: v, valid: false, reason: 'Not a valid phone number (use +<country code><number>)' };
}

export function monthPeriod(timezone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(at);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  return `${y}-${m}`;
}
