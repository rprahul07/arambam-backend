/**
 * Edges, errors and the awkward cases.
 *
 * `verify.js` walks the flows a person performs and `integration.js` walks the
 * surface. This one leans on the corners: the boundary value either side of
 * every rule, the input nobody sane would send, the second request that
 * arrives while the first is still running, and what comes back when something
 * genuinely goes wrong.
 *
 *   node scripts/edges.js
 *
 * The standard every case here is held to:
 *
 *   · bad input is refused with a 4xx and a sentence a person could act on —
 *     never accepted, never a 500, never a stack trace
 *   · a boundary is decided consistently on both sides, and the case exactly
 *     *on* it is stated rather than left to chance
 *   · an answer that leaks somebody else's data is a failure even when the
 *     status code is right
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const scratch = path.join(root, '.data', 'edges');
fs.rmSync(scratch, { recursive: true, force: true });
process.env.DATABASE_DRIVER = 'pglite';
process.env.PGLITE_DATA_DIR = scratch;
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';
process.env.PORT = process.env.EDGES_PORT || '5202';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_PREVIEW_ONLY = 'true';
process.env.PAYMENT_PROVIDER = 'simulated';
process.env.DEMO_LOGIN_ENABLED = 'true';
/* Lifted, as in the other suites: the limiters have their own checks and
   would otherwise answer 429 halfway through and mask everything after. */
process.env.RATE_LIMIT_MAX = '1000000';
process.env.AUTH_RATE_LIMIT_MAX = '1000000';
process.env.WRITE_RATE_LIMIT_MAX = '1000000';
process.env.RATE_LIMIT_WINDOW_MINUTES = '120';

const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/database/index.js');
const { seed } = await import('../src/database/seed/index.js');
const { default: env } = await import('../src/config/env.js');

/* ------------------------------------------------------------- harness -- */

let passed = 0;
const failures = [];
let group = '';

const section = (name) => {
  group = name;
  process.stdout.write(`\n${name}\n`);
};

function check(label, condition, context) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    failures.push({ group, label, context });
    process.stdout.write(`  FAIL  ${label}\n`);
    if (context !== undefined) {
      process.stdout.write(`        ${JSON.stringify(context).slice(0, 400)}\n`);
    }
  }
}

/** Many cases, one line — only the failures are printed. */
function checkAll(label, results) {
  const bad = results.filter((r) => !r.ok);
  check(`${label} (${results.length} cases)`, bad.length === 0, bad.slice(0, 5));
}

const BASE = `http://127.0.0.1:${env.port}${env.apiPrefix}`;

function client() {
  const jar = new Map();
  let accessToken = null;

  const call = async (method, url, body, options = {}) => {
    const headers = { Origin: 'http://localhost:5173', ...(options.headers ?? {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken && !options.anonymous) headers.Authorization = `Bearer ${accessToken}`;
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    let response;
    try {
      response = await fetch(`${BASE}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : (options.raw ? body : JSON.stringify(body)),
      });
    } catch (error) {
      return { status: 599, body: { message: `transport: ${error.cause?.code ?? error.message}` } };
    }

    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { status: response.status, body: payload, text };
  };

  return {
    get: (url, options) => call('GET', url, undefined, options),
    post: (url, body, options) => call('POST', url, body ?? {}, options),
    patch: (url, body) => call('PATCH', url, body ?? {}),
    del: (url) => call('DELETE', url),
    setToken: (token) => { accessToken = token; },
    cookie: (name) => jar.get(name),
    setCookie: (name, value) => jar.set(name, value),
  };
}

async function signIn(email, password = env.seedPassword) {
  const c = client();
  const res = await c.post('/auth/login', { email, password });
  if (res.status === 200) c.setToken(res.body.data.accessToken);
  return { client: c, user: res.body?.data?.user, member: res.body?.data?.member };
}

/** Refused politely: a 4xx, a message, and nothing that looks like a stack. */
const refused = (res) => {
  const message = res.body?.message;
  return (
    res.status >= 400 && res.status < 500 &&
    typeof message === 'string' && message.length > 0 &&
    !/\bat\s+\w+\s+\(/.test(message) && !message.includes('node:internal')
  );
};

const istToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const istMinutes = () => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).split(':').map(Number);
  return h * 60 + m;
};

const hhmm = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

const dayFrom = (days) =>
  new Date(Date.parse(`${istToday()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The inputs no sane client sends, which is exactly why they get sent.
 *
 * `__proto__` and `constructor` are in here because a schema that merges an
 * object into another can be talked into writing onto Object.prototype, and
 * the symptom shows up somewhere else entirely a week later.
 */
const HOSTILE = [
  { label: 'null', value: null },
  { label: 'a number where a string goes', value: 12345 },
  { label: 'an array', value: ['a', 'b'] },
  { label: 'an object', value: { nested: true } },
  { label: 'a boolean', value: true },
  { label: 'NaN, as JSON null', value: Number.NaN },
  { label: 'Infinity, as JSON null', value: Number.POSITIVE_INFINITY },
  { label: 'an empty string', value: '' },
  { label: 'whitespace only', value: '   \t\n  ' },
  { label: 'a very long string', value: 'x'.repeat(20_000) },
  { label: 'a NUL byte', value: 'before\u0000after' },
  { label: 'script tags', value: '<script>alert(1)</script>' },
  { label: 'a SQL fragment', value: "'; DROP TABLE users; --" },
  { label: 'a path traversal', value: '../../../../etc/passwd' },
  { label: 'prototype pollution', value: { __proto__: { polluted: true } } },
  { label: 'emoji and RTL marks', value: '🎪‮txt.exe' },
];

/* ------------------------------------------------------------------ run -- */

const server = app.listen(env.port);
await new Promise((resolve) => server.once('listening', resolve));

try {
  await db.connect();
  process.stdout.write('Seeding a scratch database…\n');
  await seed({ fresh: true });

  const anon = client();
  const member = await signIn('divya.bharathi@gmail.com');
  const organizer = await signIn('aravind@aarambam.org');
  const admin = await signIn('revathi@aarambam.org');

  const boot = await admin.client.get('/bootstrap');
  const data = boot.body.data;
  const anEvent = data.events.find((e) => e.lifecycle === 'published');
  const aPlan = data.plans.find((p) => p.active);

  /* ============================================ 1. hostile input, refused */

  section('Input nobody sane would send');

  {
    /* One field at a time, on the endpoints that write. Each has to be
       refused with a sentence, and nothing may 500. */
    const targets = [
      ['a plan name', (v) => admin.client.post('/plans', {
        name: v, description: 'x', price: 10, durationMonths: 1, benefits: [], sortOrder: 1,
      })],
      ['a plan price', (v) => admin.client.post('/plans', {
        name: `Edge ${Date.now()}${Math.random()}`, description: 'x', price: v,
        durationMonths: 1, benefits: [], sortOrder: 1,
      })],
      ['a plan minimum age', (v) => admin.client.post('/plans', {
        name: `Edge ${Date.now()}${Math.random()}`, description: 'x', price: 10,
        durationMonths: 1, benefits: [], sortOrder: 1, minAge: v,
      })],
      ['an event title', (v) => admin.client.post('/events', {
        title: v, summary: 'x', description: 'x', categoryId: data.categories[0].id,
        venueName: 'v', venueAddress: 'a', city: 'c', date: dayFrom(10),
        startTime: '10:00', endTime: '11:00', capacity: 5, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
        registrationOpensAt: new Date().toISOString(),
        registrationClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
      })],
      ['an event capacity', (v) => admin.client.post('/events', {
        title: `Edge ${Date.now()}${Math.random()}`, summary: 'x', description: 'x',
        categoryId: data.categories[0].id, venueName: 'v', venueAddress: 'a', city: 'c',
        date: dayFrom(10), startTime: '10:00', endTime: '11:00', capacity: v,
        type: 'free', memberPrice: 0, organizerId: organizer.user.id,
        registrationOpensAt: new Date().toISOString(),
        registrationClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
      })],
      ['a check-in code', (v) => organizer.client.post('/registrations/check-in', {
        eventId: anEvent.id, code: v,
      })],
      ['a plan id at purchase', (v) => member.client.post('/subscriptions', {
        planId: v, method: 'upi',
      })],
    ];

    for (const [what, send] of targets) {
      const results = [];
      for (const { label, value } of HOSTILE) {
        const res = await send(value);
        /* A hostile value may legitimately be *accepted* when it is merely an
           odd but valid string — a title of emoji is a fine title. What must
           never happen is a 5xx, a crash, or a leaked stack. */
        const ok = res.status < 500 &&
          (res.status < 400 || refused(res)) &&
          !JSON.stringify(res.body ?? '').includes('node:internal');
        results.push({ ok, why: label, status: res.status, message: res.body?.message?.slice(0, 90) });
      }
      checkAll(`${what} survives every hostile value`, results);
    }
  }

  check('the prototype was not polluted by any of that',
    ({}).polluted === undefined && Object.prototype.polluted === undefined);

  {
    /* A body that is not JSON at all, and one that is JSON but not an object. */
    const cases = [
      ['not JSON', 'this is not json{'],
      ['a bare string', '"just a string"'],
      ['a bare number', '42'],
      ['a JSON array', '[1,2,3]'],
      ['JSON null', 'null'],
      ['an empty body', ''],
    ];
    const results = [];
    for (const [label, raw] of cases) {
      const res = await admin.client.post('/plans', raw, { raw: true });
      results.push({
        ok: res.status >= 400 && res.status < 500,
        why: label, status: res.status, message: res.body?.message?.slice(0, 80),
      });
    }
    checkAll('a malformed request body is refused rather than crashed on', results);
  }

  /* ==================================================== 2. who may do what */

  section('Authorisation on the newer endpoints');

  {
    const cases = [
      ['issue a calendar token', () => anon.post('/calendar/token')],
      ['create a plan', () => anon.post('/plans', { name: 'x', price: 1, durationMonths: 1 })],
      ['read an attendance register', () => anon.get(`/registrations/event/${anEvent.id}/attendance`)],
      ['check somebody in', () => anon.post('/registrations/check-in', { eventId: anEvent.id, code: 'X' })],
    ];
    const results = [];
    for (const [what, send] of cases) {
      const res = await send();
      results.push({ ok: res.status === 401 || res.status === 403, why: what, status: res.status });
    }
    checkAll('a signed-out visitor is turned away', results);
  }

  {
    const cases = [
      ['create a plan', () => member.client.post('/plans', {
        name: `Nope ${Date.now()}`, description: '', price: 1, durationMonths: 1, benefits: [], sortOrder: 1,
      })],
      ['change a plan', () => member.client.patch(`/plans/${aPlan.id}`, { price: 1 })],
      ['delete a plan', () => member.client.del(`/plans/${aPlan.id}`)],
      ['read a register', () => member.client.get(`/registrations/event/${anEvent.id}/attendance`)],
      ['change somebody else’s role', () => member.client.patch(`/users/${admin.user.id}/role`, { role: 'member' })],
    ];
    const results = [];
    for (const [what, send] of cases) {
      const res = await send();
      results.push({ ok: res.status === 403 || res.status === 401, why: what, status: res.status });
    }
    checkAll('a member cannot do staff things', results);
  }

  {
    /* An organiser may read the register for their own events and no others. */
    const mine = data.events.find((e) => e.organizerId === organizer.user.id);
    const theirs = data.events.find((e) => e.organizerId && e.organizerId !== organizer.user.id);
    if (mine && theirs) {
      const own = await organizer.client.get(`/registrations/event/${mine.id}/attendance`);
      const other = await organizer.client.get(`/registrations/event/${theirs.id}/attendance`);
      check('an organiser reads the register for their own event',
        own.status === 200, own.status);
      check('and is refused somebody else’s', other.status === 403, other.status);
    }
  }

  /* ============================================== 3. ages, exactly at the line */

  section('Age limits, at the boundary');

  {
    const stamp = Date.now();
    const strict = await admin.client.post('/plans', {
      name: `Exactly eighteen ${stamp}`, description: 'x', price: 10, durationMonths: 12,
      benefits: [], sortOrder: 95, minAge: 18, maxAge: 18,
    });
    check('a plan may admit exactly one age', strict.status === 201, strict.body);

    /* Somebody whose eighteenth birthday is today, yesterday and tomorrow. */
    const birthday = (yearsAgo, dayShift) => {
      const [y, m, d] = dayFrom(dayShift).split('-').map(Number);
      return `${String(y - yearsAgo).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };

    const cases = [
      ['eighteen today', birthday(18, 0), true],
      ['eighteen tomorrow (still seventeen)', birthday(18, 1), false],
      ['eighteen yesterday', birthday(18, -1), true],
      ['nineteen', birthday(19, 0), false],
    ];

    const results = [];
    for (const [label, dob, shouldPass] of cases) {
      const email = `edge.${label.replace(/\W+/g, '')}.${stamp}@example.com`;
      const created = await admin.client.post('/members', {
        fullName: 'Edge Case', email, phone: '+91 90000 00001',
        whatsappNumber: '+91 90000 00001', age: 18, gender: 'other',
        dateOfBirth: dob,
        addressLine1: '1 Road', city: 'Coonoor', district: 'Nilgiris',
        state: 'Tamil Nadu', pincode: '643101',
        hasMedicalConditions: false, whatsappGroupConsent: true, mediaConsent: true,
      });
      if (created.status !== 201) {
        results.push({ ok: false, why: `${label}: member not created`, status: created.status,
          message: created.body?.message });
        continue;
      }
      const bought = await admin.client.post('/subscriptions', {
        memberId: created.body.data.id, planId: strict.body.data.id, method: 'upi',
      });
      const allowed = bought.status === 201;
      results.push({
        ok: allowed === shouldPass,
        why: `${label} (dob ${dob}) expected ${shouldPass ? 'allowed' : 'refused'}`,
        status: bought.status, message: bought.body?.message?.slice(0, 90),
      });
    }
    checkAll('the age is reckoned to the day, not the year', results);

    await admin.client.del(`/plans/${strict.body.data.id}`);
  }

  {
    const stamp = Date.now();
    const cases = [
      ['a minimum below zero', { minAge: -1 }, false],
      ['a minimum of zero', { minAge: 0 }, true],
      ['a maximum of 120', { maxAge: 120 }, true],
      ['a maximum of 121', { maxAge: 121 }, false],
      ['a fractional age', { minAge: 17.5 }, false],
      ['a minimum above the maximum', { minAge: 40, maxAge: 20 }, false],
      ['equal bounds', { minAge: 30, maxAge: 30 }, true],
      ['an age as a string', { minAge: '18' }, true],
      ['an age as nonsense', { minAge: 'eighteen' }, false],
    ];
    const results = [];
    for (const [label, bounds, shouldPass] of cases) {
      const res = await admin.client.post('/plans', {
        name: `Bound ${label} ${stamp}`, description: 'x', price: 10, durationMonths: 12,
        benefits: [], sortOrder: 96, ...bounds,
      });
      const created = res.status === 201;
      results.push({ ok: created === shouldPass, why: label, status: res.status,
        message: res.body?.message?.slice(0, 80) });
      if (created) await admin.client.del(`/plans/${res.body.data.id}`);
    }
    checkAll('a plan’s age bounds are validated at both ends', results);
  }

  /* ================================================= 4. dates and durations */

  section('Dates at the awkward end of the calendar');

  {
    const base = {
      summary: 'x', description: 'x', categoryId: data.categories[0].id,
      venueName: 'v', venueAddress: 'a', city: 'c', capacity: 5, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
    };
    const window = (start, end) => ({
      registrationOpensAt: new Date().toISOString(),
      registrationClosesAt: new Date(`${end}T23:59:00+05:30`).toISOString(),
      startTime: start, endTime: end === start ? '23:59' : '11:00',
    });

    const cases = [
      ['spanning a month boundary', '2027-01-30', '2027-02-02', true],
      ['spanning a year boundary', '2027-12-30', '2028-01-02', true],
      ['over a leap day', '2028-02-27', '2028-03-01', true],
      ['a single day', '2027-05-05', '2027-05-05', true],
      ['ending before it starts', '2027-05-05', '2027-05-04', false],
    ];

    const results = [];
    for (const [label, date, endDate, shouldPass] of cases) {
      const res = await admin.client.post('/events', {
        ...base, title: `Span ${label} ${Date.now()}${Math.random()}`,
        date, endDate,
        startTime: '10:00', endTime: '11:00',
        registrationOpensAt: new Date().toISOString(),
        registrationClosesAt: new Date(`${date}T09:00:00+05:30`).toISOString(),
      });
      const created = res.status === 201;
      results.push({ ok: created === shouldPass, why: label, status: res.status,
        errors: res.body?.errors, message: res.body?.message?.slice(0, 60) });
    }
    checkAll('an event’s range is accepted or refused on its own merits', results);
    void window;
  }

  {
    /* A session that starts at midnight and one that ends a minute before it. */
    const results = [];
    for (const [label, startTime, endTime, shouldPass] of [
      ['midnight to one', '00:00', '01:00', true],
      ['the last minute of the day', '23:00', '23:59', true],
      ['ending before it starts', '15:00', '14:00', false],
      ['starting and ending together', '15:00', '15:00', false],
      ['a nonsense clock reading', '25:00', '26:00', false],
      ['minutes out of range', '10:75', '11:00', false],
    ]) {
      const res = await admin.client.post('/events', {
        title: `Clock ${label} ${Date.now()}${Math.random()}`, summary: 'x', description: 'x',
        categoryId: data.categories[0].id, venueName: 'v', venueAddress: 'a', city: 'c',
        date: dayFrom(30), startTime, endTime, capacity: 5, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
        registrationOpensAt: new Date().toISOString(),
        registrationClosesAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      });
      const created = res.status === 201;
      results.push({ ok: created === shouldPass, why: label, status: res.status,
        errors: res.body?.errors, message: res.body?.message?.slice(0, 60) });
    }
    checkAll('session times are checked as times, not just strings', results);
  }

  /* ================================================== 5. the door, minute by minute */

  section('The door, at the minute');

  /* Shared with the concurrency section further down, which needs an event
     that is genuinely on rather than one seeded into last year. */
  let liveEventId = null;
  let liveRegistrationId = null;

  {
    const now = istMinutes();
    /* A window this run sits inside, clamped so it cannot cross midnight. */
    const start = Math.max(0, now - 10);
    const end = Math.min(24 * 60 - 1, now + 10);

    const doorEvent = await admin.client.post('/events', {
      title: `Door ${Date.now()}`, summary: 'x', description: 'x',
      categoryId: data.categories[0].id, venueName: 'v', venueAddress: 'a', city: 'c',
      date: istToday(), endDate: istToday(),
      startTime: hhmm(start), endTime: hhmm(end),
      capacity: 10, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
      registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      /* A minute before the session ends, worked out the way the rule works it
         out. An hour from now drifts past the end of a twenty-minute window,
         which is the rule doing its job rather than a bug to test around. */
      registrationClosesAt: new Date(
        `${istToday()}T${hhmm(Math.max(start, end - 1))}:00+05:30`,
      ).toISOString(),
    });
    check('an event can be created around this very minute', doorEvent.status === 201, doorEvent.body);

    if (doorEvent.status === 201) {
      const eventId = doorEvent.body.data.id;
      await admin.client.patch(`/events/${eventId}`, { lifecycle: 'published' });

      liveEventId = eventId;
      const booked = await member.client.post('/registrations', { eventId });
      check('a seat can be booked on it', booked.status === 201, booked.body?.message);
      const ticket = booked.body?.data?.registration?.ticketCode ?? booked.body?.data?.ticketCode;

      if (ticket) {
        const scan = await organizer.client.post('/registrations/check-in', { eventId, code: ticket });
        check('a scan inside the session is valid', scan.body?.data?.kind === 'valid',
          scan.body?.data?.kind);

        /* Same ticket, an event it does not belong to. */
        const elsewhere = await organizer.client.post('/registrations/check-in', {
          eventId: anEvent.id, code: ticket,
        });
        check('the same ticket at another event is wrong_event',
          elsewhere.body?.data?.kind === 'wrong_event', elsewhere.body?.data?.kind);

        /* A code that is well-formed and belongs to nobody. */
        const nobody = await organizer.client.post('/registrations/check-in', {
          eventId, code: 'ZZZZZZZZ',
        });
        check('an unknown code is invalid rather than an error',
          nobody.body?.data?.kind === 'invalid' || refused(nobody), nobody.body);

        /* The QR payload shape, and mangled versions of it. */
        const payloads = [
          [`AARAMBAM:${ticket}:${eventId}`, 'the full payload'],
          [`aarambam:${ticket}:${eventId}`, 'lower case'],
          [`  AARAMBAM:${ticket}:${eventId}  `, 'padded with spaces'],
          [ticket, 'the bare code'],
          [`AARAMBAM:${ticket}`, 'truncated payload'],
          [`AARAMBAM:${ticket}:${eventId}:extra`, 'an extra segment'],
        ];
        const results = [];
        for (const [code, label] of payloads) {
          const res = await organizer.client.post('/registrations/check-in', { eventId, code });
          const kind = res.body?.data?.kind;
          results.push({
            ok: res.status < 500 && ['valid', 'already_checked_in'].includes(kind),
            why: label, status: res.status, kind,
          });
        }
        checkAll('every shape of the scanned payload resolves to the same ticket', results);

        /* Marking a day the event does not run. */
        const registrationId = booked.body?.data?.registration?.id ?? booked.body?.data?.id;
        liveRegistrationId = registrationId;
        const outside = await organizer.client.post(
          `/registrations/${registrationId}/attendance/mark`,
          { sessionDate: dayFrom(30) },
        );
        check('attendance cannot be marked for a day the event does not run',
          refused(outside), { status: outside.status, message: outside.body?.message });

        const twice = await organizer.client.post(
          `/registrations/${registrationId}/attendance/mark`, { sessionDate: istToday() },
        );
        const twiceAgain = await organizer.client.post(
          `/registrations/${registrationId}/attendance/mark`, { sessionDate: istToday() },
        );
        check('marking the same day twice is idempotent, not an error',
          twice.status < 400 && twiceAgain.status < 400,
          { first: twice.status, second: twiceAgain.status });

        const register = await organizer.client.get(`/registrations/event/${eventId}/attendance`);
        const rows = (register.body?.data ?? []).filter((r) =>
          (r.registrationId ?? r.registration_id) === registrationId);
        check('and leaves exactly one row for that day', rows.length === 1, rows.length);
      }
    }
  }

  /* ================================================ 6. the calendar feed */

  section('The calendar feed, closely read');

  {
    const issued = await member.client.post('/calendar/token');
    const token = issued.body?.data?.token;
    check('a token is issued', typeof token === 'string' && token.length === 64, issued.body);

    const feed = await client().get(`/calendar/${token}.ics`, { anonymous: true });
    const ics = feed.text ?? '';

    check('the feed is a calendar', ics.startsWith('BEGIN:VCALENDAR'), ics.slice(0, 60));
    check('every line ends CRLF, as the format requires',
      ics.includes('\r\n') && !/[^\r]\n/.test(ics), JSON.stringify(ics.slice(0, 120)));
    check('BEGIN and END are balanced', (() => {
      const begins = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
      const ends = (ics.match(/END:VEVENT/g) ?? []).length;
      return begins === ends && ics.trimEnd().endsWith('END:VCALENDAR');
    })());
    check('no line exceeds 75 octets unfolded', (() => {
      return ics.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75);
    })(), ics.split('\r\n').filter((l) => Buffer.byteLength(l, 'utf8') > 75).slice(0, 2));
    check('it carries nothing about money or contact details',
      !/amount|receipt|payment|@|phone/i.test(ics.replace(/@aarambam/g, '')),
      (ics.match(/amount|receipt|payment|phone/i) ?? []).slice(0, 2));

    /* A title full of separators and Tamil, to exercise escaping and folding. */
    const nasty = await admin.client.post('/events', {
      title: 'Semi;colon, comma and \\backslash — கலை நிகழ்ச்சி மற்றும் இசை நிகழ்ச்சி',
      summary: 'Line one\nline two, with a comma', description: 'x',
      categoryId: data.categories[0].id,
      venueName: 'Studio 2, Coonoor', venueAddress: 'A; B; C', city: 'Coonoor',
      date: dayFrom(5), endDate: dayFrom(7), startTime: '10:00', endTime: '11:00',
      capacity: 5, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
      registrationOpensAt: new Date().toISOString(),
      registrationClosesAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    });
    if (nasty.status === 201) {
      await admin.client.patch(`/events/${nasty.body.data.id}`, { lifecycle: 'published' });
      const adminToken = (await admin.client.post('/calendar/token')).body.data.token;
      const adminFeed = await client().get(`/calendar/${adminToken}.ics`, { anonymous: true });
      const text = adminFeed.text ?? '';

      check('separators in a title are escaped rather than splitting the line',
        text.includes('Semi\\;colon\\, comma and \\\\backslash'),
        (text.match(/SUMMARY:.{0,70}/) ?? [])[0]);
      check('a newline in a description becomes an escaped one',
        !/DESCRIPTION:[^\r\n]*\r\n[a-z]/.test(text) && text.includes('\\n'),
        (text.match(/DESCRIPTION:.{0,70}/) ?? [])[0]);
      check('a Tamil title survives folding, still valid UTF-8',
        text.includes('கலை') &&
        text.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75),
        text.split('\r\n').filter((l) => Buffer.byteLength(l, 'utf8') > 75).slice(0, 1));
      check('a run of days repeats daily rather than running overnight',
        /RRULE:FREQ=DAILY;UNTIL=\d{8}T\d{6}Z/.test(text.replace(/\r\n /g, '')),
        (text.match(/RRULE:.{0,40}/) ?? [])[0]);
    }

    /* Tokens that are the wrong shape, or somebody else's problem. */
    const results = [];
    for (const [label, value] of [
      ['empty', ''],
      ['short', 'abc'],
      ['64 characters of the wrong alphabet', 'z'.repeat(64)],
      ['a path traversal', '../'.repeat(10) + 'etc/passwd'],
      ['a SQL fragment', "' OR '1'='1"],
      ['the token with one character changed', token.slice(0, 63) + (token[63] === 'a' ? 'b' : 'a')],
      ['upper case', token.toUpperCase()],
    ]) {
      const res = await client().get(`/calendar/${encodeURIComponent(value)}.ics`, { anonymous: true });
      results.push({ ok: res.status === 404 || res.status === 400, why: label, status: res.status });
    }
    checkAll('a token that is not exactly right gets nothing', results);

    /* One member's feed must never carry another's registrations. */
    const otherFeedToken = (await organizer.client.post('/calendar/token')).body.data.token;
    const otherFeed = await client().get(`/calendar/${otherFeedToken}.ics`, { anonymous: true });
    check('an organiser’s feed is their own events, not the members’',
      (otherFeed.text ?? '').startsWith('BEGIN:VCALENDAR'), otherFeed.status);
  }

  /* ================================================= 7. sessions and rotation */

  section('Sessions under pressure');

  {
    /* Several refreshes at once, from one client, as a page with parallel
       requests produces. */
    const tabs = client();
    const signedIn = await tabs.post('/auth/demo-login', { role: 'member' });
    tabs.setToken(signedIn.body.data.accessToken);

    const shared = tabs.cookie('refreshToken');
    const many = Array.from({ length: 5 }, () => {
      const c = client();
      c.setCookie('refreshToken', shared);
      return c.post('/auth/refresh');
    });
    const answers = await Promise.all(many);
    check('five simultaneous refreshes of the same token all succeed',
      answers.every((r) => r.status === 200), answers.map((r) => r.status));

    const after = await tabs.post('/auth/refresh');
    check('and the account is still signed in afterwards', after.status === 200, after.status);

    /* A deactivated account cannot refresh, grace window or not. */
    const doomed = client();
    const dRes = await doomed.post('/auth/demo-login', { role: 'member' });
    doomed.setToken(dRes.body.data.accessToken);
    const doomedCookie = doomed.cookie('refreshToken');
    const deactivated = await admin.client.patch(
      `/users/${dRes.body.data.user.id}/status`, { status: 'inactive' },
    );
    check('the account was actually deactivated',
      deactivated.status === 200 && deactivated.body?.data?.status === 'inactive',
      { status: deactivated.status, got: deactivated.body?.data?.status });
    const revived = client();
    revived.setCookie('refreshToken', doomedCookie);
    const denied = await revived.post('/auth/refresh');
    check('a deactivated account cannot refresh even within the grace window',
      denied.status === 401, { status: denied.status, message: denied.body?.message });
    await admin.client.patch(`/users/${dRes.body.data.user.id}/status`, { status: 'active' });
  }

  /* ================================================ 8. two at once */

  section('Two things happening at once');

  {
    /* Fired at the event created above, which is running now. A seeded event
       from last year would be refused for an unrelated reason and prove
       nothing about what two scans landing together actually do. */
    check('there is a live event to race on', Boolean(liveEventId && liveRegistrationId),
      { liveEventId, liveRegistrationId });

    if (liveEventId && liveRegistrationId) {
      const day = istToday();
      const both = await Promise.all([
        admin.client.post(`/registrations/${liveRegistrationId}/attendance/mark`, { sessionDate: day }),
        admin.client.post(`/registrations/${liveRegistrationId}/attendance/mark`, { sessionDate: day }),
      ]);
      check('two simultaneous check-ins for one session are both answered without error',
        both.every((r) => r.status < 400), both.map((r) => r.status));

      const register = await admin.client.get(`/registrations/event/${liveEventId}/attendance`);
      const forThisOne = (register.body?.data ?? []).filter(
        (r) => (r.registrationId ?? r.registration_id) === liveRegistrationId &&
          String(r.sessionDate ?? r.session_date).slice(0, 10) === day,
      );
      check('and the register holds exactly one row for it, not two',
        forThisOne.length === 1, { rows: forThisOne.length, statuses: both.map((r) => r.status) });
    }

    /* Two calendar tokens asked for at once must not leave two live. */
    const c = client();
    const s = await c.post('/auth/demo-login', { role: 'member' });
    c.setToken(s.body.data.accessToken);
    const [a, b] = await Promise.all([c.post('/calendar/token'), c.post('/calendar/token')]);
    check('two token requests at once settle on one token',
      a.body?.data?.token === b.body?.data?.token,
      { a: a.body?.data?.token?.slice(0, 8), b: b.body?.data?.token?.slice(0, 8) });
  }

  /* ================================================= 9. nothing there yet */

  section('Empty, missing and just created');

  {
    const fresh = await admin.client.post('/events', {
      title: `Nobody booked ${Date.now()}`, summary: 'x', description: 'x',
      categoryId: data.categories[0].id, venueName: 'v', venueAddress: 'a', city: 'c',
      date: dayFrom(20), endDate: dayFrom(25), startTime: '10:00', endTime: '11:00',
      capacity: 5, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
      registrationOpensAt: new Date().toISOString(),
      registrationClosesAt: new Date(Date.now() + 19 * 86_400_000).toISOString(),
    });
    const id = fresh.body?.data?.id;
    check('an event with nobody on it can be created', fresh.status === 201,
      { status: fresh.status, errors: fresh.body?.errors });

    const register = await admin.client.get(`/registrations/event/${id}/attendance`);
    check('its register is an empty list rather than an error',
      register.status === 200 && Array.isArray(register.body.data) && register.body.data.length === 0,
      { status: register.status, data: register.body?.data });

    const missing = [
      ['an event', () => admin.client.get('/events/00000000-0000-0000-0000-000000000000')],
      ['a register', () => admin.client.get('/registrations/event/00000000-0000-0000-0000-000000000000/attendance')],
      ['a plan', () => admin.client.patch('/plans/00000000-0000-0000-0000-000000000000', { price: 1 })],
      ['a member', () => admin.client.get('/members/00000000-0000-0000-0000-000000000000')],
    ];
    const results = [];
    for (const [what, send] of missing) {
      const res = await send();
      results.push({ ok: res.status === 404 && refused(res), why: what, status: res.status });
    }
    checkAll('something that does not exist answers 404 with a sentence', results);

    const malformedIds = [
      ['not a uuid', 'banana'],
      ['a uuid with a suffix', '00000000-0000-0000-0000-000000000000x'],
      ['a path traversal', '..%2f..%2fetc%2fpasswd'],
      ['a very long id', 'a'.repeat(500)],
    ];
    const idResults = [];
    for (const [what, value] of malformedIds) {
      const res = await admin.client.get(`/registrations/event/${value}/attendance`);
      idResults.push({ ok: res.status >= 400 && res.status < 500, why: what, status: res.status });
    }
    checkAll('a malformed id is refused, not queried', idResults);
  }

  /* ================================================== 10. the last features */

  section('The newest features, pushed at their edges');

  {
    /* Duplicating: the API has no notion of it, so what is checked here is
       that creating an event from another one's values is accepted, and that
       the slug is made unique rather than colliding. */
    const original = data.events.find((e) => e.lifecycle === 'published');
    const copy = await admin.client.post('/events', {
      title: original.title, summary: original.summary, description: original.description,
      categoryId: original.categoryId, venueName: original.venueName,
      venueAddress: original.venueAddress, city: original.city,
      date: dayFrom(40), endDate: dayFrom(40),
      startTime: original.startTime, endTime: original.endTime,
      capacity: original.capacity, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
      registrationOpensAt: new Date().toISOString(),
      registrationClosesAt: new Date(Date.now() + 39 * 86_400_000).toISOString(),
    });
    check('an event can be created with a title already in use',
      copy.status === 201, { status: copy.status, errors: copy.body?.errors });
    check('and is given a slug of its own',
      copy.body?.data?.slug && copy.body.data.slug !== original.slug,
      { original: original.slug, copy: copy.body?.data?.slug });

    /* The lapse sweep marks events completed. A course still running must not
       be swept while it is on. */
    const running = await admin.client.post('/events', {
      title: `Still running ${Date.now()}`, summary: 'x', description: 'x',
      categoryId: data.categories[0].id, venueName: 'v', venueAddress: 'a', city: 'c',
      date: dayFrom(-2), endDate: dayFrom(2), startTime: '10:00', endTime: '11:00',
      capacity: 5, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
      registrationOpensAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      registrationClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (running.status === 201) {
      await admin.client.patch(`/events/${running.body.data.id}`, { lifecycle: 'published' });
      const read = await admin.client.get(`/events/${running.body.data.id}`);
      check('an event part way through its run is not marked completed',
        read.body?.data?.lifecycle === 'published', read.body?.data?.lifecycle);
    }

    /* Registration closing after the first session but before the last is
       allowed; after the last day is not. */
    const results = [];
    for (const [label, closesAt, shouldPass] of [
      ['before it starts', `${dayFrom(9)}T10:00:00+05:30`, true],
      ['after the first session', `${dayFrom(11)}T10:00:00+05:30`, true],
      ['on the last day', `${dayFrom(12)}T10:00:00+05:30`, true],
      ['after the last day', `${dayFrom(20)}T10:00:00+05:30`, false],
    ]) {
      const res = await admin.client.post('/events', {
        title: `Deadline ${label} ${Date.now()}${Math.random()}`, summary: 'x', description: 'x',
        categoryId: data.categories[0].id, venueName: 'v', venueAddress: 'a', city: 'c',
        date: dayFrom(10), endDate: dayFrom(12), startTime: '10:00', endTime: '11:00',
        capacity: 5, type: 'free', memberPrice: 0, organizerId: organizer.user.id,
        registrationOpensAt: new Date().toISOString(),
        registrationClosesAt: new Date(closesAt).toISOString(),
      });
      const created = res.status === 201;
      results.push({ ok: created === shouldPass, why: label, status: res.status,
        errors: res.body?.errors, message: res.body?.message?.slice(0, 60) });
    }
    checkAll('a registration deadline may outlast the first session but not the event', results);
  }

  /* ==================================================== 11. nothing 5xx'd */

  section('Summary');
  check('no case in this run produced a 5xx',
    !failures.some((f) => JSON.stringify(f.context ?? '').includes('"status":5')),
    failures.filter((f) => JSON.stringify(f.context ?? '').includes('"status":5')).slice(0, 3));
} catch (error) {
  failures.push({ group: group || 'run', label: 'the suite itself threw', context: error.message });
  process.stdout.write(`\n  FAIL  the suite itself threw: ${error.message}\n${error.stack}\n`);
} finally {
  process.stdout.write(`\n${'-'.repeat(64)}\n`);
  if (failures.length === 0) {
    process.stdout.write(`All ${passed} checks passed.\n\n`);
  } else {
    process.stdout.write(`${passed} passed, ${failures.length} FAILED\n\n`);
    for (const failure of failures) {
      process.stdout.write(`  [${failure.group}] ${failure.label}\n`);
      if (failure.context !== undefined) {
        process.stdout.write(`      ${JSON.stringify(failure.context).slice(0, 600)}\n`);
      }
    }
    process.stdout.write('\n');
  }

  await db.close().catch(() => undefined);
  server.close(() => process.exit(failures.length === 0 ? 0 : 1));
}
