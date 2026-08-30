import env from '../config/env.js';

/**
 * Today, where the organisation actually is.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, and Aarambam is in
 * IST — five and a half hours ahead. Between midnight and 05:30 local, UTC is
 * still on yesterday, so a door opened at 01:00 for an event dated today was
 * told the event does not run "today" and refused every ticket. The same slip
 * the other way files an arrival at 05:00 against the previous day's session.
 *
 * A register is a record of local days: the afternoon class on the 31st is the
 * 31st to everybody in the room, whatever UTC thinks. So every date this
 * application decides for itself — which session is being admitted, which day
 * an attendance row belongs to — comes from here.
 *
 * `en-CA` is used because it formats as YYYY-MM-DD, which is the shape the
 * `date` columns and every comparison in this codebase already use.
 */
export function today(timeZone = env.timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * A `date` column as a plain YYYY-MM-DD string.
 *
 * `pg` hands back a Date for a `date` column and PGlite hands back a string,
 * so anything comparing them has to agree on one. Taking the ISO slice of the
 * Date is safe here — a `date` has no time, so `pg` builds it at local
 * midnight and the slice is the same calendar day it came from.
 */
export const dateOnly = (value) =>
  value instanceof Date
    ? new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
    : String(value).slice(0, 10);

export default { today, dateOnly };
