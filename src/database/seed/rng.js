/*
 * Ported from the front end (`src/data/rng.ts`).
 *
 * A seeded generator, so the demonstration data is byte-for-byte the same on
 * every run. A client walking through the application should never see the
 * member count change because the database was reseeded.
 */

export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

/** Inclusive of both bounds. */
export function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function chance(rng, probability) {
  return rng() < probability;
}

/** Fisher–Yates, returning a new array. */
export function shuffle(rng, items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Weighted choice over `[value, weight]` pairs. */
export function weighted(rng, options) {
  const total = options.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [value, w] of options) {
    r -= w;
    if (r <= 0) return value;
  }
  return options[options.length - 1][0];
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** No O/0 and no I/1 — these get read aloud at a gate. */
export function ticketCode(rng, length = 8) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return out;
}

const GATEWAY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Razorpay-shaped payment reference. */
export function gatewayReference(rng, prefix = 'pay') {
  let out = '';
  for (let i = 0; i < 14; i += 1) out += GATEWAY_ALPHABET[Math.floor(rng() * GATEWAY_ALPHABET.length)];
  return `${prefix}_${out}`;
}
