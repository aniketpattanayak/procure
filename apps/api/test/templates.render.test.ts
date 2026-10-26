/**
 * Templates & PDF (Phase 6): the sandboxed Handlebars engine and the fixed helper set — Indian formats, amount in
 * words, QR codes, escaping, prototype access, size and time limits. Pure unit tests (no app boot).
 */
import { describe, expect, it } from 'vitest';
import { TemplateEngine } from '../src/modules/templates/engine';
import { amountInWords, formatDate, formatMoney, formatNumber, groupIndian, indianWords, internationalWords, qrSvg } from '../src/modules/templates/format';
import { htmlDocument, unescapeText } from '../src/modules/templates/templates.service';
import { displayValue } from '../src/modules/templates/context.service';
import { pdfFilename } from '../src/modules/templates/pdf.service';

const engine = new TemplateEngine();
const r = (src: string, ctx: Record<string, unknown> = {}) => engine.render(src, ctx);

describe('amountInWords (Indian numbering)', () => {
  it('handles zero, one lakh and crores with paise', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords('100000')).toBe('Rupees One Lakh Only');
    expect(amountInWords('123456789.50')).toBe('Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Fifty Paise Only');
  });
  it('covers teens, tens, hundreds, rounding, negatives and very large values', () => {
    expect(amountInWords(11)).toBe('Rupees Eleven Only');
    expect(amountInWords(90)).toBe('Rupees Ninety Only');
    expect(amountInWords(1005)).toBe('Rupees One Thousand Five Only');
    expect(amountInWords('0.5')).toBe('Rupees Zero and Fifty Paise Only');
    expect(amountInWords('99.999')).toBe('Rupees One Hundred Only');
    expect(amountInWords('-250')).toBe('Minus Rupees Two Hundred Fifty Only');
    expect(amountInWords('10000000000')).toBe('Rupees One Thousand Crore Only');
    expect(amountInWords('2500000')).toBe('Rupees Twenty Five Lakh Only');
    expect(amountInWords('abc')).toBe('');
    expect(amountInWords(null)).toBe('');
  });
  it('uses international numbering for other currencies', () => {
    expect(amountInWords('1250000.25', 'USD')).toBe('US Dollars One Million Two Hundred Fifty Thousand and Twenty Five Cents Only');
    expect(amountInWords('7', 'XYZ')).toBe('XYZ Seven Only');
    expect(internationalWords(0n)).toBe('Zero');
    expect(indianWords(0n)).toBe('Zero');
  });
});

describe('number, money and date formats', () => {
  it('groups Indian style', () => {
    expect(groupIndian('123')).toBe('123');
    expect(groupIndian('1234')).toBe('1,234');
    expect(groupIndian('123456789')).toBe('12,34,56,789');
    expect(formatNumber('1234567.891', 2)).toBe('12,34,567.89');
    expect(formatNumber('1234567', 0, false)).toBe('1,234,567');
    expect(formatNumber('-0.001', 2)).toBe('0.00');
    expect(formatNumber('-1500', 2)).toBe('-1,500.00');
    expect(formatNumber('x')).toBe('');
    expect(formatNumber(12.5, 99)).toBe('12.50');
  });
  it('formats money in INR with en-IN grouping and other currencies', () => {
    expect(formatMoney('100000')).toBe('₹1,00,000.00');
    expect(formatMoney('123456789.5')).toBe('₹12,34,56,789.50');
    expect(formatMoney(-42.005)).toBe('-₹42.01');
    expect(formatMoney('1234567.5', 'USD')).toBe('$1,234,567.50');
    expect(formatMoney('10', 'CHF')).toBe('CHF 10.00');
    expect(formatMoney('1000', 'JPY')).toBe('¥1,000');
    expect(formatMoney('')).toBe('');
  });
  it('formats dates (date-only strings never shift) and timestamps in the tenant zone', () => {
    expect(formatDate('2026-10-05')).toBe('05-Oct-2026');
    expect(formatDate('2026-10-05', 'D MMMM YYYY')).toBe('5 October 2026');
    expect(formatDate('2026-10-05T20:00:00Z', 'DD/MM/YY HH:mm')).toBe('06/10/26 01:30');
    expect(formatDate('2026-10-05T08:05:00Z', 'hh:mm A', 'UTC')).toBe('08:05 AM');
    expect(formatDate('2026-10-05T08:05:00Z', 'DD-MMM-YYYY', 'Not/AZone')).toBe('05-Oct-2026');
    expect(formatDate(new Date('2026-01-01T00:00:00Z'), 'M/D', 'UTC')).toBe('1/1');
    expect(formatDate('garbage')).toBe('');
    expect(formatDate(null)).toBe('');
  });
  it('draws QR codes as self-contained SVG', () => {
    const svg = qrSvg('https://app.example/docs/po/1', 120);
    expect(svg).toMatch(/^<svg [^>]*width="120"/);
    expect(svg).not.toMatch(/href|<script|<image/);
    expect(qrSvg('')).toBe('');
    expect(qrSvg('x', 5000)).toContain('width="96"');
  });
});

describe('helpers inside templates', () => {
  const ctx = { tenant: { currency: 'INR', timezone: 'Asia/Kolkata' }, n: '123456789.50', d: '2026-03-31', s: 'Mixed Case', a: '10.00', b: 10 };
  it('exposes the fixed helper set', () => {
    expect(r('{{formatMoney n}}', ctx)).toBe('₹12,34,56,789.50');
    expect(r('{{formatMoney n "USD"}}', ctx)).toBe('$123,456,789.50');
    expect(r('{{formatNumber n 0}}', ctx)).toBe('12,34,56,790');
    expect(r('{{formatNumber n}}', ctx)).toBe('12,34,56,789.50');
    expect(r('{{formatDate d}}', ctx)).toBe('31-Mar-2026');
    expect(r('{{formatDate d "YYYY"}}', ctx)).toBe('2026');
    expect(r('{{upper s}} {{lower s}}', ctx)).toBe('MIXED CASE mixed case');
    expect(r('{{#if (eq a b)}}same{{/if}}', ctx)).toBe('same');
    expect(r('{{#ifEq s "Mixed Case"}}yes{{else}}no{{/ifEq}}', ctx)).toBe('yes');
    expect(r('{{#ifEq s "other"}}yes{{else}}no{{/ifEq}}', ctx)).toBe('no');
    expect(r('{{amountInWords n}}', ctx)).toContain('Twelve Crore');
    expect(r('{{qrCode "hello" size=64}}', ctx)).toMatch(/^<svg[^>]*width="64"/);
    expect(r('{{#each list}}{{@index}}{{/each}}', { list: [1, 2] })).toBe('01');
  });
  it('rejects unknown helpers and partials at compile time', () => {
    expect(() => engine.check('{{evil "x"}}')).toThrow(/error/);
    expect(() => engine.check('{{> header}}')).toThrow();
    expect(() => engine.check('{{#if}}')).toThrow();
    expect(() => engine.check('{{log "x"}}')).toThrow();
  });
});

describe('rendering safety', () => {
  it('escapes HTML in field values (XSS)', () => {
    const out = r('<p>{{document.values.remarks}}</p>', { document: { values: { remarks: '<script>alert(1)</script><img src=x onerror=alert(2)>' } } });
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src&#x3D;x onerror&#x3D;alert(2)&gt;</p>');
    // Text channels turn entities back into characters (no HTML is interpreted there).
    expect(unescapeText(out)).toContain('<script>');
  });
  it('blocks prototype access and pollution attempts', () => {
    const before = ({} as Record<string, unknown>).polluted;
    expect(r('{{constructor.name}}', {})).toBe('');
    expect(r('{{#with this.constructor}}{{name}}{{/with}}', {})).toBe('');
    expect(r('{{__proto__.toString}}', {})).toBe('');
    expect(r('{{lookup (lookup this "constructor") "prototype"}}', {})).toBe('');
    expect(r('{{#with __proto__}}{{polluted}}{{/with}}', JSON.parse('{"__proto__": {"polluted": "yes"}}'))).not.toContain('yes');
    expect(r('{{#each this}}{{@key}}{{/each}}', JSON.parse('{"__proto__": {"x": 1}, "a": 1}'))).not.toContain('constructor');
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(r('{{lines.length}}', { lines: [1, 2, 3] })).toBe('3');
  });
  it('enforces the 200 KB template limit', () => {
    expect(() => engine.check('x'.repeat(200_001))).toThrow(/200 KB/);
    expect(() => engine.check('x'.repeat(199_000))).not.toThrow();
  });
  it('stops renders that take longer than the time limit', () => {
    const big = Array.from({ length: 300 }, (_, i) => i);
    const src = '{{#each a}}{{#each ../a}}{{#each ../../a}}{{formatMoney this}}{{/each}}{{/each}}{{/each}}';
    const t = Date.now();
    expect(() => engine.render(src, { a: big }, 'body', 150)).toThrow(/longer than/);
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it('reports syntax errors with the field path', () => {
    try {
      engine.check('{{#each x}}', 'subject');
      expect.unreachable();
    } catch (e) {
      expect((e as { errors: { path: string }[] }).errors[0]!.path).toBe('subject');
    }
  });
});

describe('small utilities', () => {
  it('wraps fragments into a document and names PDF files safely', () => {
    expect(htmlDocument('<p>x</p>', 'A <b>')).toContain('<title>A &lt;b&gt;</title>');
    expect(htmlDocument('<html><body>y</body></html>', 't')).toBe('<html><body>y</body></html>');
    expect(pdfFilename('PO/26-27/00001')).toBe('PO-26-27-00001.pdf');
    expect(pdfFilename('  ')).toBe('document.pdf');
  });
  it('displays field values for every field type', () => {
    const o = { currency: 'INR', timezone: 'Asia/Kolkata' };
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(displayValue({ type: 'lookup' }, [id], { [id]: 'Vendor A' }, o)).toBe('Vendor A');
    expect(displayValue({ type: 'lookup' }, 'not-a-uuid', {}, o)).toBe('');
    expect(displayValue({ type: 'select', options: [{ value: 'u', label: 'Urgent' }] }, 'u', undefined, o)).toBe('Urgent');
    expect(displayValue({ type: 'multiselect', options: [{ value: 'a', label: 'A' }] }, ['a', 'b'], undefined, o)).toBe('A, b');
    expect(displayValue({ type: 'date' }, '2026-01-02', undefined, o)).toBe('02-Jan-2026');
    expect(displayValue({ type: 'datetime' }, '2026-01-02T00:00:00Z', undefined, o)).toBe('02-Jan-2026 05:30');
    expect(displayValue({ type: 'daterange' }, ['2026-01-02', '2026-01-05'], undefined, o)).toBe('02-Jan-2026 – 05-Jan-2026');
    expect(displayValue({ type: 'currency' }, '1500', undefined, o)).toBe('₹1,500.00');
    expect(displayValue({ type: 'percentage', precision: 1 }, '12.5', undefined, o)).toBe('12.5%');
    expect(displayValue({ type: 'number' }, '1500', undefined, o)).toBe('1,500');
    expect(displayValue({ type: 'decimal', precision: 3 }, '1.5', undefined, o)).toBe('1.500');
    expect(displayValue({ type: 'formula', precision: 2 }, '7', undefined, o)).toBe('7.00');
    expect(displayValue({ type: 'formula', resultType: 'boolean' }, true, undefined, o)).toBe('Yes');
    expect(displayValue({ type: 'formula', resultType: 'date' }, '2026-01-02', undefined, o)).toBe('02-Jan-2026');
    expect(displayValue({ type: 'formula', resultType: 'text' }, 'x', undefined, o)).toBe('x');
    expect(displayValue({ type: 'toggle' }, false, undefined, o)).toBe('No');
    expect(displayValue({ type: 'grid' }, [{}, {}], undefined, o)).toBe('2 rows');
    expect(displayValue({ type: 'image' }, 'id', undefined, o)).toBe('');
    expect(displayValue({ type: 'text' }, { a: 1 }, undefined, o)).toBe('');
    expect(displayValue({ type: 'text' }, '', undefined, o)).toBe('');
  });
});
