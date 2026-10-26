import Decimal from 'decimal.js';
import QRCode from 'qrcode';

/**
 * Pure formatting functions behind the fixed Handlebars helper set (notify.ts): Indian number grouping, money,
 * dates, amount in words (lakh / crore) and QR codes as inline SVG. No I/O.
 */

const toDecimal = (v: unknown): Decimal | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return null;
  try {
    const d = new Decimal(typeof v === 'number' || typeof v === 'string' ? v : String(v));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};

/** "1234567.5" → "12,34,567.5" (Indian grouping: last 3 digits, then pairs). */
export function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  const rest = intDigits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** International grouping (thousands). */
export function groupInternational(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Number with fixed places and grouping (Indian for INR / default, international otherwise). Empty for non-numbers. */
export function formatNumber(v: unknown, places = 2, indian = true): string {
  const d = toDecimal(v);
  if (!d) return '';
  const p = Number.isInteger(places) && places >= 0 && places <= 10 ? places : 2;
  const fixed = d.abs().toFixed(p, Decimal.ROUND_HALF_UP);
  const [int, frac] = fixed.split('.');
  const grouped = indian ? groupIndian(int!) : groupInternational(int!);
  const neg = d.isNegative() && !new Decimal(fixed).isZero();
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

const SYMBOLS: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥', AED: 'AED ', SGD: 'S$' };

/** Money: "₹1,00,000.00" for INR (en-IN grouping), "$1,000.00" for USD, "CHF 10.00" for others. */
export function formatMoney(v: unknown, currency = 'INR'): string {
  const d = toDecimal(v);
  if (!d) return '';
  const cur = (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency : 'INR').toUpperCase();
  const places = cur === 'JPY' ? 0 : 2;
  const body = formatNumber(d.abs(), places, cur === 'INR');
  const sym = SYMBOLS[cur] ?? `${cur} `;
  const neg = d.isNegative() && body.replace(/[0,.]/g, '') !== '';
  return `${neg ? '-' : ''}${sym}${body}`;
}

// ------------------------------------------------------------------ amount in words

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n]!;
  return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : '');
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

/** Whole number in Indian words (thousand, lakh, crore; crores above 99 recurse: "One Thousand Crore"). */
export function indianWords(n: bigint): string {
  if (n === 0n) return 'Zero';
  const parts: string[] = [];
  const crore = n / 10_000_000n;
  let rest = n % 10_000_000n;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  const lakh = rest / 100_000n;
  rest %= 100_000n;
  if (lakh) parts.push(`${below100(Number(lakh))} Lakh`);
  const thousand = rest / 1000n;
  rest %= 1000n;
  if (thousand) parts.push(`${below100(Number(thousand))} Thousand`);
  if (rest) parts.push(below1000(Number(rest)));
  return parts.join(' ');
}

/** Whole number in international words (thousand, million, billion, trillion). */
export function internationalWords(n: bigint): string {
  if (n === 0n) return 'Zero';
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion', 'Quadrillion'];
  const parts: string[] = [];
  let i = 0;
  while (n > 0n && i < scales.length) {
    const chunk = Number(n % 1000n);
    if (chunk) parts.unshift([below1000(chunk), scales[i]].filter(Boolean).join(' '));
    n /= 1000n;
    i++;
  }
  if (n > 0n) parts.unshift(`${internationalWords(n)} Quintillion`);
  return parts.join(' ');
}

const CURRENCY_WORDS: Record<string, [string, string]> = {
  INR: ['Rupees', 'Paise'], USD: ['US Dollars', 'Cents'], EUR: ['Euros', 'Cents'], GBP: ['Pounds', 'Pence'],
  AED: ['Dirhams', 'Fils'], SGD: ['Singapore Dollars', 'Cents'],
};

/**
 * "Rupees One Lakh Only", "Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and
 * Fifty Paise Only". Rounds to 2 places (half up). Indian numbering for INR, international for other currencies.
 */
export function amountInWords(v: unknown, currency = 'INR'): string {
  const d = toDecimal(v);
  if (!d) return '';
  const cur = (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency : 'INR').toUpperCase();
  const [major, minor] = CURRENCY_WORDS[cur] ?? [cur, 'Cents'];
  const fixed = d.abs().toFixed(2, Decimal.ROUND_HALF_UP);
  const [intPart, fracPart] = fixed.split('.') as [string, string];
  const words = cur === 'INR' ? indianWords : internationalWords;
  const whole = BigInt(intPart);
  const frac = Number(fracPart);
  let out = `${major} ${words(whole)}`;
  if (frac) out += ` and ${below100(frac)} ${minor}`;
  const neg = d.isNegative() && (whole > 0n || frac > 0);
  return `${neg ? 'Minus ' : ''}${out} Only`;
}

// ------------------------------------------------------------------ dates

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface DateParts { y: number; m: number; d: number; hh: number; mi: number; hasTime: boolean }

function partsOf(v: unknown, timeZone: string): DateParts | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    return { y, m, d, hh: 0, mi: 0, hasTime: false };
  }
  const date = v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  } catch {
    tz = 'Asia/Kolkata';
  }
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mi: Number(p.minute), hasTime: true };
}

/**
 * Formats a date ('YYYY-MM-DD', ISO timestamp or Date) with tokens YYYY YY MMMM MMM MM M DD D HH hh mm A.
 * Default 'DD-MMM-YYYY' (e.g. 05-Oct-2026). Timestamps are shown in the tenant time zone.
 */
export function formatDate(v: unknown, fmt = 'DD-MMM-YYYY', timeZone = 'Asia/Kolkata'): string {
  const p = partsOf(v, timeZone);
  if (!p) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const h12 = p.hh % 12 === 0 ? 12 : p.hh % 12;
  const map: Record<string, string> = {
    YYYY: String(p.y), YY: String(p.y).slice(-2), MMMM: MONTHS_LONG[p.m - 1]!, MMM: MONTHS[p.m - 1]!, MM: pad(p.m), M: String(p.m),
    DD: pad(p.d), D: String(p.d), HH: pad(p.hh), hh: pad(h12), mm: pad(p.mi), A: p.hh < 12 ? 'AM' : 'PM',
  };
  const format = typeof fmt === 'string' && fmt.length <= 40 ? fmt : 'DD-MMM-YYYY';
  return format.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|hh|mm|A/g, t => map[t] ?? t);
}

// ------------------------------------------------------------------ QR

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** QR code as a self-contained inline SVG (one path, no external references). Text is capped at 1000 chars. */
export function qrSvg(text: unknown, sizePx = 96): string {
  const value = String(text ?? '').slice(0, 1000);
  if (!value) return '';
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const quiet = 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (data[y * n + x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  const dim = n + quiet * 2;
  const size = Number.isFinite(sizePx) && sizePx >= 32 && sizePx <= 400 ? Math.round(sizePx) : 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="qr" width="${size}" height="${size}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${escAttr(`QR code: ${value}`)}"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}
