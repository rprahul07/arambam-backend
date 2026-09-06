import { Router } from 'express';
import crypto from 'node:crypto';
import { query, queryAll, queryOne } from '../../database/index.js';
import env from '../../config/env.js';
import { ROLES } from '../../config/constants.js';
import { dateOnly, instantAt } from '../../utils/today.js';
import asyncHandler from '../../utils/asyncHandler.js';
import ApiError from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { authenticate } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';

/**
 * Calendar subscription.
 *
 * Asked for so members, organisers and administrators can see Aarambam in the
 * calendar they already use rather than remembering to open this one. It is a
 * *subscription* rather than a one-off export: the feed is fetched again every
 * few hours by the calendar itself, so a rescheduled event moves in everyone's
 * diary without anybody re-importing anything.
 *
 * Calendar clients cannot log in — they fetch a URL, with no cookie and no
 * bearer token — so the feed is authorised by an unguessable token in the path
 * instead. That makes the URL itself the secret:
 *
 *   · 32 bytes from `crypto.randomBytes`, so it cannot be enumerated
 *   · issued only to the account it belongs to, and never listed anywhere else
 *   · rotatable, which is the remedy if somebody shares theirs by accident
 *   · it discloses titles, dates and venues — never payments, contact details
 *     or anybody else's registrations
 *
 * What the feed contains depends on who it belongs to: a member sees the
 * events they hold a ticket for, an organiser the ones they run, an
 * administrator everything published.
 */

const router = Router();

/* ------------------------------------------------------------ ICS format */

/**
 * RFC 5545 escaping: commas, semicolons and backslashes are separators in this
 * format, and a venue called "Studio 2, Coonoor" would otherwise split a line
 * into two fields and produce a file some clients refuse outright.
 */
const esc = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** `20260315T183000Z` — the format every calendar client agrees on. */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * Lines are folded at 75 octets.
 *
 * Not 75 characters: the limit is on bytes, and a Tamil event title is three
 * bytes per character. Folding by character length produced lines that were
 * legal to look at and rejected by Outlook.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out = [];
  let start = 0;
  while (start < bytes.length) {
    const width = out.length === 0 ? 75 : 74; // continuations carry a leading space
    let end = Math.min(start + width, bytes.length);
    /* Never split a multi-byte character: back up to a lead byte. */
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push((out.length === 0 ? '' : ' ') + bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return out.join('\r\n');
}

/** One VEVENT. A multi-day event repeats daily rather than running overnight. */
function vevent(event, origin) {
  const start = instantAt(event.date, event.start_time);
  const end = instantAt(event.date, event.end_time);
  if (Number.isNaN(start) || Number.isNaN(end)) return [];

  const lastDay = dateOnly(event.end_date || event.date);
  const multiDay = lastDay > dateOnly(event.date);

  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.id}@aarambam`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(event.title)}`,
  ];

  if (multiDay) {
    /* The whole of the last day, so a course that ends on the 9th includes the
       9th. UNTIL is inclusive but compared against the start instant. */
    lines.push(`RRULE:FREQ=DAILY;UNTIL=${stamp(instantAt(lastDay, event.start_time))}`);
  }

  const where = [event.venue_name, event.venue_address, event.city].filter(Boolean).join(', ');
  if (where) lines.push(`LOCATION:${esc(where)}`);
  if (event.summary) lines.push(`DESCRIPTION:${esc(event.summary)}`);
  if (event.slug) lines.push(`URL:${esc(`${origin}/events/${event.slug}`)}`);
  if (event.lifecycle === 'cancelled') lines.push('STATUS:CANCELLED');

  lines.push('END:VEVENT');
  return lines;
}

function calendar(events, name, origin) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Aarambam//Events//EN',
    'CALSCALE:GREGORIAN',
    /* Not a to-do list or a shared editable diary: a feed to read. */
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-PUBLISHED-TTL:PT6H',
    ...events.flatMap((event) => vevent(event, origin)),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------------- routes */

const EVENT_COLUMNS = `id, slug, title, summary, date, end_date, start_time, end_time,
  venue_name, venue_address, city, lifecycle`;

/** What this account should see in its own diary. */
async function eventsFor(user) {
  if (user.role === ROLES.ADMIN) {
    return queryAll(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE lifecycle <> 'draft' ORDER BY date`,
    );
  }

  if (user.role === ROLES.ORGANIZER) {
    return queryAll(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE organizer_id = $1 AND lifecycle <> 'draft' ORDER BY date`,
      [user.id],
    );
  }

  /* A member sees what they hold a ticket for — not the whole programme, which
     is what the public site is for. */
  return queryAll(
    `SELECT DISTINCT ${EVENT_COLUMNS.split(',').map((c) => `e.${c.trim()}`).join(', ')}
     FROM events e
     JOIN registrations r ON r.event_id = e.id
     JOIN members m       ON m.id = r.member_id
     WHERE m.user_id = $1 AND r.status <> 'cancelled' AND e.lifecycle <> 'draft'
     ORDER BY e.date`,
    [user.id],
  );
}

/**
 * GET /calendar/:token.ics
 *
 * Deliberately unauthenticated — a calendar client cannot sign in. The token
 * is the authorisation, which is why it is 32 random bytes and why rotating it
 * is offered below.
 */
router.get(
  '/:token.ics',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || '');
    /* Length-checked before the query so a short or empty token cannot become
       a probe against the index. */
    if (token.length !== 64) throw ApiError.notFound('No such calendar');

    const user = await queryOne(
      `SELECT id, name, role FROM users WHERE calendar_token = $1 AND status = 'active'`,
      [token],
    );
    if (!user) throw ApiError.notFound('No such calendar');

    const events = await eventsFor(user);
    const body = calendar(events, `${env.appName} — ${user.name}`, env.clientUrl);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="aarambam.ics"');
    /* The URL is a secret; a shared cache holding the response is not wanted. */
    res.setHeader('Cache-Control', 'private, max-age=900');
    return res.send(body);
  }),
);

/**
 * POST /calendar/token
 *
 * Returns this account's subscription URL, creating one on first ask.
 * `{ rotate: true }` issues a new one and invalidates the old — the remedy
 * when somebody has shared theirs.
 */
router.post(
  '/token',
  authenticate,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const rotate = req.body?.rotate === true;
    let row = await queryOne(`SELECT calendar_token FROM users WHERE id = $1`, [req.user.id]);

    if (rotate || !row?.calendar_token) {
      const token = crypto.randomBytes(32).toString('hex');
      await query(`UPDATE users SET calendar_token = $1 WHERE id = $2`, [token, req.user.id]);
      row = { calendar_token: token };
    }

    return ok(
      res,
      {
        token: row.calendar_token,
        url: `${env.serverUrl}${env.apiPrefix}/calendar/${row.calendar_token}.ics`,
      },
      rotate ? 'A new calendar link has been issued — the old one no longer works' : undefined,
    );
  }),
);

export default router;
