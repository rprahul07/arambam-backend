import crypto from 'node:crypto';

/**
 * Human-facing identifiers. Every format here is one the front end already
 * renders or parses — the ticket code is read aloud at a gate, the booking
 * reference is quoted on the phone, the receipt number goes on a PDF.
 */

/** No O/0 and no I/1, so a code can be dictated without ambiguity. */
const TICKET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const randomFrom = (alphabet, length) => {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

/** e.g. `K7QP2M9A` — printed into the QR and shown on the ticket. */
export const ticketCode = (length = 8) => randomFrom(TICKET_ALPHABET, length);

const GATEWAY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Razorpay-shaped placeholder used until a live gateway id arrives. */
export const gatewayReference = (prefix = 'pay') => `${prefix}_${randomFrom(GATEWAY_ALPHABET, 14)}`;

const pad = (value, width) => String(value).padStart(width, '0');

/** e.g. `REG-20260814-0031` */
export const registrationReference = (date, sequence) => {
  const d = date instanceof Date ? date : new Date(date);
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
  return `REG-${ymd}-${pad(sequence, 4)}`;
};

/** e.g. `RCP-2026-0184` */
export const receiptNumber = (date, sequence) => {
  const d = date instanceof Date ? date : new Date(date);
  return `RCP-${d.getFullYear()}-${pad(sequence, 4)}`;
};

/** e.g. `ARM-1042` — the member id quoted on the membership card. */
export const memberCode = (sequence) => `ARM-${sequence}`;

/** URL-safe slug used for event addresses. Matches the front end's rule. */
export const slugify = (value) =>
  String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120) || 'event';

export const newId = () => crypto.randomUUID();

/** Accepts the ids the API mints; anything else is rejected at the boundary. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

export default {
  ticketCode,
  gatewayReference,
  registrationReference,
  receiptNumber,
  memberCode,
  slugify,
  newId,
  isUuid,
};
