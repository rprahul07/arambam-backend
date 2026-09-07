/**
 * End-to-end verification.
 *
 * Boots the API against a throwaway database, seeds it, and drives every flow
 * the front end performs — sign-in for all three roles, the bootstrap payload
 * each of them receives, registration and payment, membership purchase,
 * check-in, the admin screens, and the authorisation boundaries between them.
 *
 *   node scripts/verify.js
 *
 * Exits non-zero on the first failed expectation, with the response that
 * caused it.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMAIL_TEMPLATE_KEYS } from '../src/config/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// A scratch database, so verifying never touches the development data.
const scratch = path.join(root, '.data', 'verify');
fs.rmSync(scratch, { recursive: true, force: true });
process.env.DATABASE_DRIVER = 'pglite';
process.env.PGLITE_DATA_DIR = scratch;
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';
process.env.PORT = process.env.VERIFY_PORT || '5199';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_PREVIEW_ONLY = 'true';
process.env.PAYMENT_PROVIDER = 'simulated';
/* Set here rather than inherited from `.env`: this suite exercises the
   one-click role buttons, and a deployment that has switched them off — as
   production rightly has — would otherwise fail the run for a reason that has
   nothing to do with the code under test. */
process.env.DEMO_LOGIN_ENABLED = 'true';

const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/database/index.js');
const { seed } = await import('../src/database/seed/index.js');
const { default: env } = await import('../src/config/env.js');

/* --------------------------------------------------------------- harness */

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

const BASE = `http://127.0.0.1:${env.port}${env.apiPrefix}`;

/**
 * A wall-clock time in the organisation's zone, as an instant.
 *
 * Written explicitly rather than via `new Date('...T20:00')`, which resolves in
 * whatever zone the runner happens to be in. That difference is not academic:
 * these checks passed on a developer's machine set to IST and the same code
 * was wrong in production, where the server runs in UTC — which is exactly the
 * bug they exist to catch. Run this suite with TZ=UTC and it still holds.
 */
const istInstant = (day, time) => new Date(`${day}T${time}:00+05:30`).toISOString();

/**
 * A HH:MM reading, `minutes` from now, in the organisation's zone.
 *
 * The door only admits around a session, so a check-in test has to put the
 * session around the moment the suite runs. Hard-coding 18:00 meant the scans
 * passed or failed depending on the hour the suite happened to be run at.
 */
const clockFromNow = (minutes) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(Date.now() + minutes * 60_000));

/**
 * Today, as the organisation reckons it.
 *
 * Not `new Date().toLocaleDateString()`, which is the date in whatever zone
 * the *suite* happens to run in. Between 18:30 and midnight UTC it is already
 * tomorrow in Coonoor, so a run with TZ=UTC in that window built its events
 * for yesterday and then wondered why the door would not admit anyone. The
 * server answers in the organisation's zone; the tests have to ask in it.
 */
const istToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

/** Minutes since midnight, in the organisation's zone. */
const istMinutesNow = () => {
  const [h, m] = clockFromNow(0).split(':').map(Number);
  return h * 60 + m;
};

const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * A session window `offset` minutes from now, of `length` minutes.
 *
 * Returns `null` when the window would fall outside today — an event's start
 * and end are times on a date, so a window running past midnight is not a
 * shorter event, it is a different day. Near midnight there is genuinely no
 * room for "five hours ago", and a check that cannot be set up is skipped
 * rather than reported as a failure of the thing it was meant to test.
 */
const windowFromNow = (offset, length) => {
  const start = istMinutesNow() + offset;
  const end = start + length;
  if (start < 0 || end > 24 * 60 - 1) return null;
  return { startTime: hhmm(start), endTime: hhmm(end) };
};

/** A window that contains this moment, clamped so it never crosses midnight. */
const windowAroundNow = (before, after) => {
  const now = istMinutesNow();
  return {
    startTime: hhmm(Math.max(0, now - before)),
    endTime: hhmm(Math.min(24 * 60 - 1, now + after)),
  };
};

/** A browser-like client: keeps the refresh cookie and the access token. */
function client() {
  const jar = new Map();
  let accessToken = null;

  const call = async (method, url, body, options = {}) => {
    const headers = { Origin: 'http://localhost:5173' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken && !options.anonymous) headers.Authorization = `Bearer ${accessToken}`;
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const response = await fetch(`${BASE}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

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
      payload = { raw: text.slice(0, 200) };
    }
    return { status: response.status, body: payload };
  };

  return {
    get: (url, options) => call('GET', url, undefined, options),
    post: (url, body, options) => call('POST', url, body ?? {}, options),
    patch: (url, body) => call('PATCH', url, body ?? {}),
    del: (url) => call('DELETE', url),
    setToken: (token) => {
      accessToken = token;
    },
    token: () => accessToken,
    /* Reading and seeding the jar, so one client can be handed the cookie
       another was holding — which is what a second browser tab is. */
    cookie: (name) => jar.get(name),
    setCookie: (name, value) => jar.set(name, value),
  };
}

async function signIn(email, password = env.seedPassword) {
  const c = client();
  const res = await c.post('/auth/login', { email, password });
  if (res.status === 200) c.setToken(res.body.data.accessToken);
  return { client: c, res };
}

/* ------------------------------------------------------------------ run */

const server = app.listen(env.port);
await new Promise((resolve) => server.once('listening', resolve));

try {
  await db.connect();
  process.stdout.write('Seeding a scratch database…\n');
  const seeded = await seed({ fresh: true });

  /* ============================================================== public */

  section('Public surface (no session)');

  const anon = client();

  const boot = await anon.get('/bootstrap');
  check('GET /bootstrap answers 200', boot.status === 200, boot.body);
  const publicData = boot.body?.data ?? {};
  check('scope is public', publicData.scope === 'public', publicData.scope);
  check(
    'every collection the store holds is present',
    ['users', 'members', 'subscriptions', 'events', 'registrations', 'payments', 'notifications',
     'categories', 'plans', 'organisation', 'emailTemplates', 'demo'].every((key) => key in publicData),
    Object.keys(publicData),
  );
  check('no draft events are exposed', publicData.events.every((e) => e.lifecycle !== 'draft'));
  check('events carry the front end\'s field names',
    publicData.events.every((e) =>
      typeof e.slug === 'string' && typeof e.startTime === 'string' &&
      typeof e.memberPrice === 'number' && 'registrationOpensAt' in e && 'lifecycle' in e),
    publicData.events[0]);
  check('event date is a plain calendar date',
    /^\d{4}-\d{2}-\d{2}$/.test(publicData.events[0].date), publicData.events[0].date);
  check('members are counted but not readable',
    publicData.members.length === seeded.members &&
    publicData.members.every((m) => m.fullName === '' && m.email === '' && m.phone === ''),
    publicData.members[0]);
  check('registrations are counted but not readable',
    publicData.registrations.length === seeded.registrations &&
    publicData.registrations.every((r) => r.participantName === '' && r.ticketCode === ''),
    publicData.registrations[0]);
  check('no payments leak to anonymous callers', publicData.payments.length === 0);
  check('organiser names are public, contact details are not',
    publicData.users.length > 0 && publicData.users.every((u) => u.name && u.email === ''),
    publicData.users[0]);
  check('plans carry durationMonths and benefits',
    publicData.plans.every((p) => typeof p.durationMonths === 'number' && Array.isArray(p.benefits)),
    publicData.plans[0]);
  check('categories use `color`, not `colour`',
    publicData.categories.every((c) => typeof c.color === 'string' && !('colour' in c)),
    publicData.categories[0]);
  check('organisation profile is populated', publicData.organisation.name === 'Aarambam');
  check('every email template is configured',
    publicData.emailTemplates.length === EMAIL_TEMPLATE_KEYS.length,
    { got: publicData.emailTemplates.map((t) => t.key), want: EMAIL_TEMPLATE_KEYS });
  check('a password reset has a template of its own',
    publicData.emailTemplates.some((t) => t.key === 'password_reset'),
    publicData.emailTemplates.map((t) => t.key));

  const eventsList = await anon.get('/events?page=1&pageSize=5');
  check('GET /events is paged', eventsList.status === 200 && eventsList.body.meta.pageSize === 5,
    eventsList.body?.meta);
  const someSlug = publicData.events.find((e) => e.lifecycle === 'published')?.slug;
  const detail = await anon.get(`/events/${someSlug}`);
  check('GET /events/:slug resolves by slug and returns live seats',
    detail.status === 200 && typeof detail.body.data.seats.remaining === 'number', detail.body?.data?.seats);

  const guarded = await anon.get('/members');
  check('GET /members refuses an anonymous caller', guarded.status === 401, guarded.body);

  /* =============================================================== auth */

  section('Authentication');

  const badLogin = await client().post('/auth/login', {
    email: 'divya.bharathi@gmail.com',
    password: 'WrongPassword1!',
  });
  check('a wrong password is refused', badLogin.status === 401, badLogin.body);

  const unknownLogin = await client().post('/auth/login', {
    email: 'nobody@example.com',
    password: 'WrongPassword1!',
  });
  check('an unknown address gives the same answer as a wrong password',
    unknownLogin.status === 401 && unknownLogin.body.message === badLogin.body.message,
    { unknown: unknownLogin.body.message, wrong: badLogin.body.message });

  const member = await signIn('divya.bharathi@gmail.com');
  check('a member can sign in', member.res.status === 200, member.res.body);
  check('sign-in returns user, member and session',
    Boolean(member.res.body.data.user && member.res.body.data.member && member.res.body.data.session.memberId),
    Object.keys(member.res.body.data ?? {}));
  check('no password hash is ever serialised',
    !JSON.stringify(member.res.body).includes('passwordHash') &&
    !JSON.stringify(member.res.body).includes('password_hash'));

  const me = await member.client.get('/auth/me');
  check('GET /auth/me returns the identity', me.status === 200 && me.body.data.user.role === 'member');

  const refreshed = await member.client.post('/auth/refresh');
  check('the session refreshes from the httpOnly cookie',
    refreshed.status === 200 && typeof refreshed.body.data.accessToken === 'string', refreshed.body);

  /* Two tabs, reloading together.

     The front end refreshes on every cold start, so the same refresh token
     really does get presented twice within a second or two — two tabs open,
     a double reload, a reload racing a request in flight. Rotation used to
     call that theft and revoke every session the account had, so people were
     signed out by reloading the page, and a payment the office had just
     verified only showed up after signing in again. */
  {
    const tabA = client();
    const signedIn = await tabA.post('/auth/demo-login', { role: 'member' });
    tabA.setToken(signedIn.body.data.accessToken);

    /* Exactly what the second tab holds: the cookie as it was before the
       first tab rotated it. */
    const shared = tabA.cookie('refreshToken');
    const tabB = client();
    tabB.setCookie('refreshToken', shared);

    const first = await tabA.post('/auth/refresh');
    check('the first tab refreshes normally', first.status === 200, first.body);
    check('and is issued a different token than it presented',
      tabA.cookie('refreshToken') !== shared, 'cookie unchanged');

    const second = await tabB.post('/auth/refresh');
    check('the other tab, holding the token just rotated, is not treated as theft',
      second.status === 200 && typeof second.body?.data?.accessToken === 'string', second.body);

    const stillA = await tabA.post('/auth/refresh');
    const stillB = await tabB.post('/auth/refresh');
    check('and neither tab has been signed out by the other',
      stillA.status === 200 && stillB.status === 200,
      { a: stillA.status, b: stillB.status });

    /* The window is a tolerance, not an amnesty: a token from a session that
       was deliberately ended stays dead however recently it was used. */
    const endMe = client();
    const ended = await endMe.post('/auth/demo-login', { role: 'member' });
    endMe.setToken(ended.body.data.accessToken);
    const spent = endMe.cookie('refreshToken');
    await endMe.post('/auth/logout');

    const afterLogout = client();
    afterLogout.setCookie('refreshToken', spent);
    const revived = await afterLogout.post('/auth/refresh');
    check('a token from a session that was signed out cannot be revived',
      revived.status === 401, revived.body);
  }

  for (const role of ['administrator', 'organizer', 'member']) {
    const demo = await client().post('/auth/demo-login', { role });
    check(`one-click sign-in works for ${role}`,
      demo.status === 200 && demo.body.data.user.role === role, demo.body);
  }

  /* Joining is one submission: the registration form and the sign-in details
     together. There is no verification stage to wait behind, so what is
     checked here is that one request leaves a member, a member id and a
     working session behind it. */
  const joining = {
    email: `joiner.${Date.now()}@example.com`,
    phone: '+91 90000 11111',
    password: 'Str0ng!Pass',
    fullName: 'Verification Tester',
    age: 34,
    gender: 'female',
    address: '12 Example Street, Coonoor',
    city: 'Coonoor',
    district: 'Nilgiris',
    state: 'Tamil Nadu',
    whatsappNumber: '+91 90000 11111',
    whatsappGroupConsent: true,
    idProofType: 'aadhaar',
    idProofNumber: '1234 5678 9012',
    hasMedicalConditions: false,
    mediaConsent: true,
    declarationAccepted: true,
  };

  const registered = await client().post('/auth/register', joining);
  check('joining creates the account and the member in one request',
    registered.status === 201 && Boolean(registered.body.data.member), registered.body);
  check('a member id is issued on the spot',
    /^ARM-\d+$/.test(registered.body.data?.member?.memberId ?? ''), registered.body.data?.member);
  check('the new member is signed in without confirming anything',
    Boolean(registered.body.data?.accessToken), Object.keys(registered.body.data ?? {}));
  check('the form answers are on the record',
    registered.body.data?.member?.addressLine1 === joining.address &&
    registered.body.data?.member?.declarationAccepted === true,
    registered.body.data?.member);

  /* And they can come back tomorrow with the same details. */
  /* Every answer the form collects, read back off the record.
     
     Checked field by field rather than "did it 201?", because a field quietly
     dropped between the form and the INSERT looks exactly like success — the
     member is created, and nobody notices the missing WhatsApp consent until
     somebody goes looking for it a month later. */
  const stored = registered.body.data?.member ?? {};
  const mismatches = Object.entries({
    fullName: joining.fullName,
    age: joining.age,
    gender: joining.gender,
    email: joining.email,
    phone: joining.phone,
    whatsappNumber: joining.whatsappNumber,
    whatsappGroupConsent: joining.whatsappGroupConsent,
    addressLine1: joining.address,
    /* The columns the office sorts and filters by. Sign-up did not ask for
       them, so the member list showed an empty City against nearly everybody
       who had joined themselves. */
    city: joining.city,
    district: joining.district,
    state: joining.state,
    hasMedicalConditions: joining.hasMedicalConditions,
    mediaConsent: joining.mediaConsent,
    declarationAccepted: joining.declarationAccepted,
  }).filter(([field, expected]) => stored[field] !== expected);
  check('every answer on the form reaches the record', mismatches.length === 0,
    mismatches.map(([f, e]) => `${f}: expected ${JSON.stringify(e)}, got ${JSON.stringify(stored[f])}`));

  /* PAN is optional, so both shapes have to work. */
  const withPan = await client().post('/auth/register',
    { ...joining, email: `pan.${Date.now()}@example.com`, panNumber: 'abcde1234f' });
  check('an optional PAN is stored, upper-cased',
    withPan.body.data?.member?.panNumber === 'ABCDE1234F', withPan.body.data?.member?.panNumber);

  check('a member with no PAN is accepted', !stored.panNumber, stored.panNumber);

  const badPan = await client().post('/auth/register',
    { ...joining, email: `badpan.${Date.now()}@example.com`, panNumber: 'NOTAPAN' });
  check('a malformed PAN is refused',
    badPan.status === 422 && Boolean(badPan.body.errors?.panNumber), badPan.body?.errors);

  const returning = await client().post('/auth/login',
    { email: joining.email, password: joining.password });
  check('they can sign in again with no verification step',
    returning.status === 200, returning.body);

  /* The paper form makes the guardian block mandatory under 18; so does this. */
  const joiningMinor = await client().post('/auth/register',
    { ...joining, email: `minor.${Date.now()}@example.com`, age: 12 });
  check('a member under 18 cannot join without a guardian',
    joiningMinor.status === 422 && Boolean(joiningMinor.body.errors?.guardianName), joiningMinor.body);

  const weak = await client().post('/auth/register',
    { ...joining, email: `weak.${Date.now()}@example.com`, password: 'password' });
  check('a weak password is rejected with field errors',
    weak.status === 422 && Boolean(weak.body.errors?.password), weak.body);

  const duplicate = await client().post('/auth/register',
    { ...joining, email: 'divya.bharathi@gmail.com' });
  check('a duplicate email is refused', duplicate.status === 409, duplicate.body);

  /* Promoting a member used to be refused outright while their membership was
     live: "suspend it before changing the role". That protected against
     leaving a membership nobody could act on — true when an account could
     reach exactly one portal, and false now that staff keep the member portal
     alongside their own. It was telling an administrator to break a paid-up
     membership to grant a role. */
  const roleDesk = await signIn('revathi@aarambam.org');
  const roleBoot = (await roleDesk.client.get('/bootstrap')).body.data;
  const liveMember = roleBoot.members.find((m) => m.status === 'active');
  const liveUser = roleBoot.users.find((u) => u.id === liveMember.userId);
  const promoteMember = await roleDesk.client.patch(`/users/${liveUser.id}/role`, { role: 'organizer' });
  check('a member with a live membership can be given the organiser role',
    promoteMember.status === 200, promoteMember.body?.message);
  const afterPromotion = (await roleDesk.client.get('/bootstrap')).body.data.members
    .find((m) => m.id === liveMember.id);
  check('and the membership itself is untouched',
    afterPromotion.status === 'active', afterPromotion.status);
  await roleDesk.client.patch(`/users/${liveUser.id}/role`, { role: 'member' });

  /* No screen sends a non-member price any more. The column is NOT NULL and
     holds real figures for events priced before the rule changed, so the
     server has to keep it level with the member price on its own — otherwise
     creating an event answers a constraint violation, and editing one leaves a
     figure that contradicts what is actually charged. */
  const priceDesk = await signIn('revathi@aarambam.org');
  const priced = await priceDesk.client.post('/events', {
    title: `One Price Evening ${Date.now()}`,
    summary: 'Created without a non-member price, as every screen now does.',
    description: 'Exists to prove the server fills in the column nothing sends any more.',
    categoryId: (await priceDesk.client.get('/bootstrap')).body.data.categories[0].id,
    venueName: 'Aarambam Learning Centre',
    venueAddress: '48, Belmont 1st Floor',
    city: 'Coonoor',
    date: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10),
    startTime: '18:00',
    endTime: '20:00',
    registrationOpensAt: new Date().toISOString(),
    registrationClosesAt: new Date(Date.now() + 19 * 864e5).toISOString(),
    capacity: 30,
    type: 'paid',
    memberPrice: 250,
    organizerId: (await priceDesk.client.get('/bootstrap')).body.data.users
      .find((u) => u.role === 'organizer').id,
    lifecycle: 'published',
  });
  check('an event saves with no non-member price supplied', priced.status === 201, priced.body);
  check('and the unused column is kept level with the price',
    priced.body.data?.nonMemberPrice === 250, priced.body.data?.nonMemberPrice);

  const repriced = await priceDesk.client.patch(`/events/${priced.body.data.id}`, { memberPrice: 400 });
  check('changing the price moves both figures together',
    repriced.body.data?.memberPrice === 400 && repriced.body.data?.nonMemberPrice === 400,
    { member: repriced.body.data?.memberPrice, other: repriced.body.data?.nonMemberPrice });

  const forgot = await client().post('/auth/forgot-password', { email: 'nobody@example.com' });
  check('password reset does not reveal whether an address exists', forgot.status === 200, forgot.body);

  /* ============================================================ member */

  section('Member scope');

  const memberBoot = await member.client.get('/bootstrap');
  const md = memberBoot.body.data;
  const memberId = member.res.body.data.session.memberId;

  check('scope is member', md.scope === 'member');
  check('own profile is complete',
    md.members.find((m) => m.id === memberId)?.email === 'divya.bharathi@gmail.com');
  check('other members stay counters',
    md.members.filter((m) => m.id !== memberId).every((m) => m.email === ''));
  check('own registrations are readable',
    md.registrations.filter((r) => r.memberId === memberId).every((r) => r.ticketCode !== '') &&
    md.registrations.some((r) => r.memberId === memberId));
  check('other people\'s registrations stay counters',
    md.registrations.filter((r) => r.memberId !== memberId).every((r) => r.ticketCode === ''));
  check('only own payments are returned', md.payments.every((p) => p.memberId === memberId));
  check('only own subscriptions are returned', md.subscriptions.every((s) => s.memberId === memberId));
  check('own notifications arrive', md.notifications.length > 0 &&
    md.notifications.every((n) => n.userId === member.res.body.data.user.id));

  // Seat counts have to be computable from what a member receives.
  const anyEvent = md.events.find((e) => e.lifecycle === 'published');
  const booked = md.registrations.filter(
    (r) => r.eventId === anyEvent.id && r.status !== 'cancelled',
  ).length;
  check('seat counts are computable from the payload', booked >= 0 && anyEvent.capacity > 0,
    { event: anyEvent.title, booked, capacity: anyEvent.capacity });

  const forbidden = await member.client.get('/members');
  check('a member cannot list the register', forbidden.status === 403, forbidden.body);

  const otherMember = md.members.find((m) => m.id !== memberId);
  const peek = await member.client.get(`/members/${otherMember.id}`);
  check('a member cannot read another member', peek.status === 403, peek.body);

  const roleAttempt = await member.client.patch(
    `/users/${member.res.body.data.user.id}/role`, { role: 'administrator' });
  check('a member cannot promote themselves', roleAttempt.status === 403, roleAttempt.body);

  /* ================================================== booking & payment */

  section('Registration and payment');

  const bookable = md.events.find(
    (e) =>
      e.lifecycle === 'published' &&
      e.type === 'paid' &&
      new Date(e.registrationOpensAt) <= new Date() &&
      new Date(e.registrationClosesAt) >= new Date() &&
      !md.registrations.some((r) => r.eventId === e.id && r.memberId === memberId && r.status !== 'cancelled'),
  );
  check('a bookable paid event exists in the seed data', Boolean(bookable),
    md.events.map((e) => `${e.title}:${e.lifecycle}:${e.type}`).slice(0, 5));

  let paidRegistrationId = null;
  if (bookable) {
    const booking = await member.client.post('/registrations', { eventId: bookable.id, method: 'upi' });
    check('a paid booking holds a seat and opens a payment',
      booking.status === 201 &&
      booking.body.data.registration.status === 'pending_payment' &&
      booking.body.data.payment?.status === 'pending',
      booking.body);

    const reg = booking.body.data.registration;
    paidRegistrationId = reg.id;
    check('the booking reference is human-quotable',
      /^REG-\d{8}-\d{4}$/.test(reg.reference), reg.reference);
    check('a ticket code is issued and has no ambiguous characters',
      /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(reg.ticketCode), reg.ticketCode);
    check('member pricing was applied', reg.pricedAsMember === true && reg.amount === bookable.memberPrice,
      { amount: reg.amount, memberPrice: bookable.memberPrice });

    const twice = await member.client.post('/registrations', { eventId: bookable.id, method: 'upi' });
    check('re-entering the payment dialog returns the same held seat',
      twice.status === 201 && twice.body.data.registration.id === reg.id, twice.body?.data?.registration?.id);

    const paymentId = booking.body.data.payment.id;
    const settled = await member.client.post(`/payments/${paymentId}/settle`, { outcome: 'successful' });
    check('settling the payment succeeds', settled.status === 200 &&
      settled.body.data.status === 'successful', settled.body);
    check('a receipt number is issued on success',
      /^RCP-\d{4}-\d{4}$/.test(settled.body.data?.receiptNo ?? ''), settled.body.data?.receiptNo);

    const after = await member.client.get(`/registrations/${reg.id}`);
    check('the seat is confirmed once the payment settles',
      after.body.data?.status === 'confirmed', after.body.data);

    const replay = await member.client.post(`/payments/${paymentId}/settle`, { outcome: 'successful' });
    check('settling twice is idempotent',
      replay.status === 200 && replay.body.data?.receiptNo === settled.body.data?.receiptNo,
      { first: settled.body.data?.receiptNo, second: replay.body.data?.receiptNo });

    const notifications = await member.client.get('/notifications?unreadOnly=true');
    check('the member is notified of the confirmed seat',
      (notifications.body.data ?? []).some((n) => n.type === 'event_registration'),
      (notifications.body.data ?? []).map((n) => n.type).slice(0, 5));
  }

  // A free event confirms immediately, with no payment.
  const freeEvent = md.events.find(
    (e) =>
      e.lifecycle === 'published' &&
      e.type === 'free' &&
      new Date(e.registrationOpensAt) <= new Date() &&
      new Date(e.registrationClosesAt) >= new Date() &&
      !md.registrations.some((r) => r.eventId === e.id && r.memberId === memberId && r.status !== 'cancelled'),
  );
  if (freeEvent) {
    const free = await member.client.post('/registrations', { eventId: freeEvent.id, method: 'upi' });
    check('a free event confirms straight away with no payment',
      free.status === 201 && free.body.data.registration.status === 'confirmed' && !free.body.data.payment,
      free.body?.data);

    /* There is no cancellation policy, so there is no cancellation route.
       Checked rather than assumed: a member finding a working endpoint would
       be releasing a seat the organisation says cannot be released. */
    const release = await member.client.patch(`/registrations/${free.body.data.registration.id}/cancel`, {
      reason: 'Verification run',
    });
    check('a member cannot release their own seat — there is no cancellation policy',
      release.status === 403, release.body);

    /* Staff still can: correcting a duplicate or a booking taken in error is a
       different act from a member changing their mind, and has to stay
       possible or a wrong row is stuck on the register for good. */
    const office = await signIn('revathi@aarambam.org');
    const byOffice = await office.client.patch(
      `/registrations/${free.body.data.registration.id}/cancel`,
      { reason: 'Entered twice by mistake' },
    );
    check('the office can still cancel a booking made in error',
      byOffice.status === 200 && byOffice.body.data.status === 'cancelled', byOffice.body);
  }

  /* ================================================== calendar feeds */

  section('Calendar subscription');
  {
    /* A calendar client cannot sign in, so the URL is the authorisation.
       These check that it is unguessable, that it shows the right person the
       right events, and that rotating it kills the old one. */
    const issued = await member.client.post('/calendar/token');
    check('a member can be issued a calendar link',
      issued.status === 200 && typeof issued.body.data.url === 'string', issued.body);
    check('the token is long enough not to be guessed',
      (issued.body.data?.token ?? '').length === 64, issued.body.data?.token?.length);

    const again = await member.client.post('/calendar/token');
    check('asking twice returns the same link rather than a new one',
      again.body.data.token === issued.body.data.token);

    /* Fetched the way a calendar client would: no cookie, no bearer token. */
    const feedUrl = `/calendar/${issued.body.data.token}.ics`;
    const feed = await client().get(feedUrl, { anonymous: true });
    const ics = typeof feed.body?.raw === 'string' ? feed.body.raw : JSON.stringify(feed.body);
    check('the feed is served to a client that cannot sign in',
      feed.status === 200 && ics.includes('BEGIN:VCALENDAR'), ics.slice(0, 120));
    check('and it carries the events this member holds a ticket for',
      ics.includes('BEGIN:VEVENT'), ics.slice(0, 200));
    check('but never anything about money',
      !/amount|payment|receipt/i.test(ics));

    const madeUp = await client().get(`/calendar/${'a'.repeat(64)}.ics`, { anonymous: true });
    check('a made-up token gets nothing', madeUp.status === 404, madeUp.status);

    const tooShort = await client().get('/calendar/abc.ics', { anonymous: true });
    check('and so does a short one', tooShort.status === 404, tooShort.status);

    const rotated = await member.client.post('/calendar/token', { rotate: true });
    check('rotating issues a different link',
      rotated.body.data.token !== issued.body.data.token, rotated.body);
    const dead = await client().get(feedUrl, { anonymous: true });
    check('and the old link stops working', dead.status === 404, dead.status);
  }

  /* ================================================ membership purchase */

  section('Membership purchase');

  /* The member's age as the server reckons it: date of birth wins, the stored
     number is the fallback. Plans carry age bounds now, so several checks
     below have to know which plans this member is actually allowed. */
  const myAge = (() => {
    const me = md.members.find((m) => m.id === memberId);
    if (me?.dateOfBirth) {
      const [by, bm, bd] = me.dateOfBirth.slice(0, 10).split('-').map(Number);
      const now = new Date();
      return now.getFullYear() - by -
        (now.getMonth() + 1 < bm || (now.getMonth() + 1 === bm && now.getDate() < bd) ? 1 : 0);
    }
    return me?.age ?? 30;
  })();

  /* The dearest active plan, found by price rather than by name. Naming one
     ("Premium") is what broke this check when the organisation replaced the
     invented plans with their own: the lookup missed, fell back to the
     cheapest plan, and the server correctly called the result a downgrade —
     so the upgrade assertions below failed for a reason that had nothing to do
     with upgrades. */
  const plan = [...md.plans]
    .filter((p) => p.active)
    .filter((p) => (p.minAge === undefined || myAge >= p.minAge) &&
                   (p.maxAge === undefined || myAge <= p.maxAge))
    .sort((a, b) => Number(b.price) - Number(a.price))[0];
  const heldBefore = md.subscriptions.find(
    (s) => s.memberId === memberId && s.status === 'active',
  );
  const heldPlan = md.plans.find((p) => p.id === heldBefore?.planId);

  const purchase = await member.client.post('/subscriptions', {
    planId: plan.id,
    kind: 'upgrade',
    method: 'card',
  });
  check('a membership purchase opens a pending subscription and payment',
    purchase.status === 201 &&
    purchase.body.data.subscription.status === 'pending' &&
    purchase.body.data.payment.status === 'pending',
    purchase.body);

  // Moving to a dearer plan is charged at the difference and inherits the end
  // date already paid for; a first purchase runs the plan's full duration.
  check('an upgrade costs the difference, not the whole plan again', (() => {
    const s = purchase.body.data.subscription;
    if (!s) return false;
    if (!heldBefore || !heldPlan) return s.amount === plan.price;
    return s.kind === 'upgrade' && s.amount === plan.price - heldPlan.price;
  })(), { subscription: purchase.body?.data?.subscription, heldPlan: heldPlan?.name });

  check('an upgrade keeps the end date the member already holds', (() => {
    const s = purchase.body.data.subscription;
    if (!s) return false;
    if (!heldBefore) {
      const months =
        (new Date(s.endDate).getFullYear() - new Date(s.startDate).getFullYear()) * 12 +
        (new Date(s.endDate).getMonth() - new Date(s.startDate).getMonth());
      return months === plan.durationMonths;
    }
    return s.endDate === heldBefore.endDate;
  })(), { got: purchase.body?.data?.subscription?.endDate, expected: heldBefore?.endDate });

  const subSettled = await member.client.post(
    `/payments/${purchase.body.data.payment.id}/settle`, { outcome: 'successful' });
  check('settling activates the membership', subSettled.status === 200, subSettled.body);

  const afterPurchase = await member.client.get('/bootstrap');
  const mine = afterPurchase.body.data.members.find((m) => m.id === memberId);
  check('the member is active and points at the new subscription',
    mine.status === 'active' && mine.currentSubscriptionId === purchase.body.data.subscription.id,
    { status: mine.status, current: mine.currentSubscriptionId });
  check('exactly one subscription is active',
    afterPurchase.body.data.subscriptions.filter((s) => s.status === 'active').length === 1,
    afterPurchase.body.data.subscriptions.map((s) => s.status));

  const failing = await member.client.post('/subscriptions', {
    planId: plan.id, kind: 'renewal', method: 'upi',
  });
  const declined = await member.client.post(
    `/payments/${failing.body.data.payment.id}/settle`, { outcome: 'failed' });
  check('a declined payment cancels the subscription it was for',
    declined.status === 200 && declined.body.data.status === 'failed', declined.body);
  check('a failed payment carries a reason and no receipt',
    Boolean(declined.body.data.failureReason) && !declined.body.data.receiptNo, declined.body.data);

  /* ================================== renewing, queuing and downgrading */

  section('Renewals and plan changes');

  const beforeRenewal = await member.client.get('/bootstrap');
  const inForce = beforeRenewal.body.data.subscriptions.find(
    (s) => s.memberId === memberId && s.status === 'active',
  );
  const inForcePlan = beforeRenewal.body.data.plans.find((p) => p.id === inForce?.planId);
  const dayAfter = (iso) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

  const renewal = await member.client.post('/subscriptions', {
    planId: inForce.planId,
    method: 'upi',
  });
  check('renewing the same plan is recognised as a renewal',
    renewal.status === 201 && renewal.body.data.subscription.kind === 'renewal',
    renewal.body?.data?.subscription);
  check('a renewal begins the day the current term ends, so no paid day is lost',
    renewal.body.data.subscription.startDate === dayAfter(inForce.endDate),
    { start: renewal.body?.data?.subscription?.startDate, currentEnd: inForce.endDate });
  check('a renewal is charged the full plan price',
    renewal.body.data.subscription.amount === inForcePlan.price,
    { amount: renewal.body?.data?.subscription?.amount, price: inForcePlan.price });

  const renewalSettled = await member.client.post(
    `/payments/${renewal.body.data.payment.id}/settle`, { outcome: 'successful' });
  check('the renewal payment settles', renewalSettled.status === 200, renewalSettled.body);

  const afterRenewal = await member.client.get('/bootstrap');
  const renewedRow = afterRenewal.body.data.subscriptions.find(
    (s) => s.id === renewal.body.data.subscription.id,
  );
  const oldRow = afterRenewal.body.data.subscriptions.find((s) => s.id === inForce.id);
  const meAfter = afterRenewal.body.data.members.find((m) => m.id === memberId);

  check('a term that has not started is scheduled, not active',
    renewedRow.status === 'scheduled', renewedRow);
  check('the membership in force is left alone by a future renewal',
    oldRow.status === 'active', oldRow);
  check('the member still points at the membership actually covering today',
    meAfter.currentSubscriptionId === inForce.id,
    { points: meAfter.currentSubscriptionId, inForce: inForce.id });
  check('still exactly one active subscription after renewing',
    afterRenewal.body.data.subscriptions.filter(
      (s) => s.memberId === memberId && s.status === 'active').length === 1,
    afterRenewal.body.data.subscriptions
      .filter((s) => s.memberId === memberId).map((s) => s.status));

  const stacked = await member.client.post('/subscriptions', {
    planId: inForce.planId,
    method: 'upi',
  });
  check('a second membership cannot be stacked on top of a queued one',
    stacked.status === 409 && stacked.body.code === 'SUBSCRIPTION_ALREADY_QUEUED',
    stacked.body);

  // Clearing the queue: cancelling a term that never started must not touch
  // the membership the member is actually holding today. (The administrator
  // signs in properly further down; this is only to reach the cancel route.)
  const office = await signIn('revathi@aarambam.org');
  const dropQueued = await office.client.patch(`/subscriptions/${renewedRow.id}/cancel`);
  check('an administrator can cancel a queued membership', dropQueued.status === 200, dropQueued.body);

  const afterDrop = await member.client.get('/bootstrap');
  const meAfterDrop = afterDrop.body.data.members.find((m) => m.id === memberId);
  check('cancelling a queued term leaves the member active',
    meAfterDrop.status === 'active' && meAfterDrop.currentSubscriptionId === inForce.id,
    { status: meAfterDrop.status, current: meAfterDrop.currentSubscriptionId });

  /* Cheaper *and* one this member may hold. The cheapest plan the
     organisation sells is "Under 18", so picking on price alone chose a plan
     the member is too old for and the downgrade was correctly refused — a
     failure about age dressed up as a failure about downgrades. */
  const eligible = (p) =>
    (p.minAge === undefined || myAge >= p.minAge) &&
    (p.maxAge === undefined || myAge <= p.maxAge);

  const cheaper = afterDrop.body.data.plans
    .filter((p) => p.active && p.price < inForcePlan.price && eligible(p))
    .sort((a, b) => a.price - b.price)[0];

  if (cheaper) {
    const downgrade = await member.client.post('/subscriptions', {
      planId: cheaper.id,
      method: 'upi',
    });
    check('moving to a cheaper plan is recognised as a downgrade',
      downgrade.status === 201 && downgrade.body.data.subscription.kind === 'downgrade',
      downgrade.body?.data?.subscription);
    check('a downgrade waits for the dearer term to finish, so nothing paid for is lost',
      downgrade.body.data.subscription.startDate === dayAfter(inForce.endDate),
      { start: downgrade.body?.data?.subscription?.startDate, currentEnd: inForce.endDate });
    check('a downgrade is charged the cheaper plan in full, not a difference',
      downgrade.body.data.subscription.amount === cheaper.price,
      { amount: downgrade.body?.data?.subscription?.amount, price: cheaper.price });

    const downSettled = await member.client.post(
      `/payments/${downgrade.body.data.payment.id}/settle`, { outcome: 'successful' });
    check('the downgrade settles as a scheduled term',
      downSettled.status === 200 &&
      downSettled.body.data.status === 'successful', downSettled.body);

    const afterDown = await member.client.get('/bootstrap');
    const downRow = afterDown.body.data.subscriptions.find(
      (s) => s.id === downgrade.body.data.subscription.id);
    check('the cheaper plan is queued rather than taking effect immediately',
      downRow.status === 'scheduled', downRow);
    check('the dearer membership keeps running until its end date',
      afterDown.body.data.subscriptions.find((s) => s.id === inForce.id).status === 'active',
      afterDown.body.data.subscriptions.find((s) => s.id === inForce.id));
  }

  /* ========================================================== organizer */

  section('Organizer scope');

  const organizer = await signIn('aravind@aarambam.org');
  check('an organizer can sign in', organizer.res.status === 200, organizer.res.body);

  const orgBoot = await organizer.client.get('/bootstrap');
  const od = orgBoot.body.data;
  const ownEventIds = new Set(orgBoot.body.data.users
    .find((u) => u.id === organizer.res.body.data.user.id)?.assignedEventIds ?? []);

  check('scope is organizer', od.scope === 'organizer');
  check('assigned events are listed on the account', ownEventIds.size > 0, [...ownEventIds].length);
  check('participants on their own events are readable',
    od.registrations.filter((r) => ownEventIds.has(r.eventId)).every((r) => r.participantName !== '') &&
    od.registrations.some((r) => ownEventIds.has(r.eventId)));
  check('other events\' participants stay counters',
    od.registrations.filter((r) => !ownEventIds.has(r.eventId)).every((r) => r.participantName === ''));
  check('member records behind their own door lists are readable',
    od.members.some((m) => m.fullName !== ''));

  const ownEventId = [...ownEventIds][0];
  const doorList = od.registrations.find(
    (r) => r.eventId === ownEventId && r.status !== 'cancelled' && r.ticketCode,
  );

  if (doorList) {
    /* A scan is always a scan *of a particular day* now, so the event has to
       be running today for one to resolve. Widened through the API rather than
       the database, which also proves an administrator can turn a one-day
       event into a run of them. */
    /* The organisation's date, the same way the server reckons it. Using the
       UTC date here encoded the very bug this checks for: between midnight and
       05:30 IST the two disagree, and the test would demand the server mark
       yesterday's session. */
    const today = istToday();
    const nextMonth = new Date(Date.now() + 30 * 864e5).toLocaleDateString('en-CA');
    const staff = await signIn('revathi@aarambam.org');
    /* The session brackets right now, so the door is open for the scans below. */
    /* Around now, but never spilling over midnight. */
    const { startTime: sessionStart, endTime: sessionEnd } = windowAroundNow(30, 30);
    const widened = await staff.client.patch(`/events/${ownEventId}`, {
      date: today,
      endDate: nextMonth,
      startTime: sessionStart,
      endTime: sessionEnd,
      registrationClosesAt: istInstant(nextMonth, sessionEnd),
    });
    check('an event can run across a range of days',
      widened.status === 200 && widened.body.data.endDate === nextMonth,
      { date: widened.body?.data?.date, endDate: widened.body?.data?.endDate });

    /* A free event, edited while its prices are in the patch. This is the
       shape every save from the administrator's form has — the form sends the
       prices whether or not they changed — and it used to produce two
       assignments to `member_price` in one UPDATE, which Postgres refuses. So
       every edit to a free event answered 500, including simply giving it a
       last day. */
    const freeEvent = od.events.find((e) => e.type === 'free' && ownEventIds.has(e.id));
    if (freeEvent) {
      const freeEdit = await staff.client.patch(`/events/${freeEvent.id}`, {
        date: today,
        endDate: nextMonth,
        startTime: '18:00',
        endTime: '20:00',
        /* Moved with the dates. Leaving the old deadline behind would strand it
           after the new end, which is refused — correctly. */
        registrationClosesAt: istInstant(nextMonth, '20:00'),
        type: 'free',
        memberPrice: 0,
        nonMemberPrice: 0,
      });
      check('a free event can be given a last day',
        freeEdit.status === 200 && freeEdit.body.data.endDate === nextMonth,
        freeEdit.body?.message ?? freeEdit.body);
    }

    /* Registration has to be allowed to stay open past the *first* day of a
       run. Measured against the opening day, a course meeting daily for two
       months could only accept people before its second session — which makes
       a recurring event impossible to fill. */
    const lateClose = await staff.client.patch(`/events/${ownEventId}`, {
      date: today,
      endDate: nextMonth,
      startTime: '18:00',
      endTime: '20:00',
      /* Built from local time, as the form does — a bare `Z` here would compare
         20:00 UTC against 20:00 local and fail for the wrong reason. */
      registrationClosesAt: istInstant(nextMonth, '20:00'),
    });
    check('registration may close on the last day of a run, not the first',
      lateClose.status === 200, lateClose.body?.errors ?? lateClose.body?.message);

    const tooLate = await staff.client.patch(`/events/${ownEventId}`, {
      date: today,
      endDate: nextMonth,
      registrationClosesAt: `${new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10)}T20:00:00.000Z`,
    });
    check('but not after the run has finished',
      tooLate.status === 422 && Boolean(tooLate.body.errors?.registrationClosesAt),
      tooLate.body?.errors);

    /* A single day, to the minute. Registration may run right up to the moment
       the doors close and not past it — a date-only rule let an event finishing
       at 20:00 accept a booking at 23:00 the same evening. */
    const oneDay = await staff.client.patch(`/events/${ownEventId}`, {
      date: today, endDate: today, startTime: '18:00', endTime: '20:00',
      registrationClosesAt: istInstant(today, '20:00'),
    });
    check('a one-day event may take bookings until the moment it ends',
      oneDay.status === 200, oneDay.body?.errors ?? oneDay.body?.message);

    const pastTheEnd = await staff.client.patch(`/events/${ownEventId}`, {
      date: today, endDate: today, startTime: '18:00', endTime: '20:00',
      registrationClosesAt: istInstant(today, '23:00'),
    });
    check('but not after its end time that evening',
      pastTheEnd.status === 422 && Boolean(pastTheEnd.body.errors?.registrationClosesAt),
      pastTheEnd.body?.errors);

    /* And closing after the event has *begun* is fine — seats at the door. */
    const midEvent = await staff.client.patch(`/events/${ownEventId}`, {
      date: today, endDate: today, startTime: '18:00', endTime: '20:00',
      registrationClosesAt: istInstant(today, '19:30'),
    });
    check('registration may close after the event has started',
      midEvent.status === 200, midEvent.body?.errors ?? midEvent.body?.message);

    /* Back to the run, with the session around now — the scans below need both
       more than one day and an open door. */
    await staff.client.patch(`/events/${ownEventId}`, {
      date: today, endDate: nextMonth, startTime: sessionStart, endTime: sessionEnd,
      registrationClosesAt: istInstant(nextMonth, sessionEnd),
    });

    const backwards = await staff.client.patch(`/events/${ownEventId}`, {
      date: today, endDate: '2020-01-01',
    });
    check('a range that ends before it starts is refused',
      backwards.status === 422 && Boolean(backwards.body.errors?.endDate), backwards.body?.errors);

    /* Scanned the way the camera actually sends it — the whole QR payload,
       `AARAMBAM:<code>:<eventId>`, not the bare code. Every earlier test typed
       the code by hand, which is why a server that could not read the payload
       passed all of them and still failed at a real door. */
    const scanned = await organizer.client.post('/registrations/check-in', {
      eventId: ownEventId,
      code: `AARAMBAM:${doorList.ticketCode}:${ownEventId}`,
    });
    check('a QR payload from the camera resolves',
      scanned.status === 200 && scanned.body.data.kind === 'valid', scanned.body?.data);

    /* A payload whose code and event have been separated is doctored. */
    const doctored = await organizer.client.post('/registrations/check-in', {
      eventId: ownEventId,
      code: `AARAMBAM:${doorList.ticketCode}:00000000-0000-0000-0000-000000000000`,
    });
    check('a payload naming the wrong event is refused',
      doctored.body?.data?.kind === 'invalid', doctored.body);

    const scan = await organizer.client.post('/registrations/check-in', {
      eventId: ownEventId, code: doorList.ticketCode,
    });
    check('a valid ticket resolves at check-in',
      scan.status === 200 && scan.body.data.kind === 'valid', scan.body?.data?.kind);
    check('the scan names the day it is marking',
      scan.body.data.sessionDate === today, scan.body?.data?.sessionDate);

    /* Marking the day, then the same day again — the second is a no-op rather
       than a second row, which is what stops two volunteers double-marking. */
    const marked = await organizer.client.post(`/registrations/${doorList.id}/attendance/mark`, {});
    check('a scan marks today on the register',
      marked.status === 200 && marked.body.data.sessionDate === today, marked.body?.data);

    const rescan = await organizer.client.post('/registrations/check-in', {
      eventId: ownEventId, code: doorList.ticketCode,
    });
    check('the same ticket on the same day is already checked in',
      rescan.body.data.kind === 'already_checked_in', rescan.body?.data?.kind);

    const twice = await organizer.client.post(`/registrations/${doorList.id}/attendance/mark`, {});
    check('marking the same day twice leaves one entry', twice.status === 200, twice.body);

    const outside = await organizer.client.post(`/registrations/${doorList.id}/attendance/mark`, {
      sessionDate: '2019-05-05',
    });
    check('a day outside the event cannot be marked', outside.status === 400, outside.body);

    /* Corrections. The door marks; this is the day somebody was missed, or
       the wrong ticket was scanned. Without it a mistake is permanent. */
    /* Yesterday, which is inside the run: the event was widened to start today
       and end next month, so a day before today is not a session — the day
       after is. Marking a future session is legitimate: an organiser filling
       in the register for a class they have just taught. */
    const otherDay = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const backfill = await organizer.client.post(
      `/registrations/${doorList.id}/attendance/mark`, { sessionDate: otherDay });
    check('a session can be marked for a day other than today', backfill.status === 200, backfill.body);

    const undo = await organizer.client.del(
      `/registrations/${doorList.id}/attendance/${otherDay}`);
    check('a mark made in error can be removed', undo.status === 200, undo.body);

    /* Removing the *only* day attended has to put them back to not checked in
       — a summary that still says "attended" contradicts the register. */
    const stripAll = await organizer.client.del(
      `/registrations/${doorList.id}/attendance/${today}`);
    check('removing the last day resets them to not checked in',
      stripAll.status === 200 && stripAll.body.data.registration.attendance === 'not_checked_in',
      stripAll.body?.data?.registration?.attendance);

    /* Put the day back, so the register check below still has something. */
    await organizer.client.post(`/registrations/${doorList.id}/attendance/mark`, {});

    const overview = await organizer.client.get('/registrations/attendance/overview');
    check('the register overview lists the run',
      overview.status === 200 && overview.body.data.some((e) => e.id === ownEventId),
      overview.body?.data?.length);

    /* The right day is not the right time. A ticket for an afternoon class was
       being accepted at twenty past eight that evening, and at half past
       midnight for a session still fourteen hours off — each one written into
       the register as though somebody had walked in. */
    const laterToday = windowFromNow(240, 60);
    if (laterToday) {
      await staff.client.patch(`/events/${ownEventId}`, {
        date: today, endDate: nextMonth, ...laterToday,
        registrationClosesAt: istInstant(nextMonth, laterToday.endTime),
      });
      const tooEarly = await organizer.client.post('/registrations/check-in', {
        eventId: ownEventId, code: doorList.ticketCode,
      });
      check('the door refuses a scan hours before the session',
        tooEarly.body.data.kind === 'outside_hours', tooEarly.body?.data?.kind);
    }

    const earlierToday = windowFromNow(-300, 60);
    if (earlierToday) {
      await staff.client.patch(`/events/${ownEventId}`, {
        date: today, endDate: nextMonth, ...earlierToday,
        registrationClosesAt: istInstant(nextMonth, earlierToday.endTime),
      });
      const tooLateScan = await organizer.client.post('/registrations/check-in', {
        eventId: ownEventId, code: doorList.ticketCode,
      });
      check('and a scan hours after it finished',
        tooLateScan.body.data.kind === 'outside_hours', tooLateScan.body?.data?.kind);
    }

    /* An hour either side is still admitted — early arrivals, and a queue
       still being cleared after the end. */
    const soon = windowFromNow(30, 60);
    if (soon) {
      await staff.client.patch(`/events/${ownEventId}`, {
        date: today, endDate: nextMonth, ...soon,
        registrationClosesAt: istInstant(nextMonth, soon.endTime),
      });
      const early = await organizer.client.post('/registrations/check-in', {
        eventId: ownEventId, code: doorList.ticketCode,
      });
      check('but half an hour early is fine',
        ['valid', 'already_checked_in'].includes(early.body.data.kind), early.body?.data?.kind);
    }

    /* Put the session back around now for the register check below. */
    await staff.client.patch(`/events/${ownEventId}`, {
      date: today, endDate: nextMonth, startTime: sessionStart, endTime: sessionEnd,
      registrationClosesAt: istInstant(nextMonth, sessionEnd),
    });

    const register = await organizer.client.get(`/registrations/event/${ownEventId}/attendance`);
    const mine = (register.body.data ?? []).filter((a) => a.registrationId === doorList.id ||
      a.registration_id === doorList.id);
    check('the register lists exactly one day for that person',
      register.status === 200 && mine.length === 1, { rows: mine.length, sample: register.body?.data?.[0] });

    const wrongEventId = od.events.find((e) => e.id !== ownEventId && ownEventIds.has(e.id))?.id;
    if (wrongEventId) {
      const mismatch = await organizer.client.post('/registrations/check-in', {
        eventId: wrongEventId, code: doorList.ticketCode,
      });
      check('a ticket for another event is reported as wrong_event',
        mismatch.body.data.kind === 'wrong_event', mismatch.body?.data?.kind);
    }

    const nonsense = await organizer.client.post('/registrations/check-in', {
      eventId: ownEventId, code: 'ZZZZ9999',
    });
    check('an unknown code is reported as invalid', nonsense.body.data.kind === 'invalid',
      nonsense.body?.data);

    const admit = await organizer.client.patch(`/registrations/${doorList.id}/attendance`, {
      attendance: 'attended',
    });
    check('an organizer can admit someone on their own event',
      admit.status === 200 && admit.body.data.attendance === 'attended' && admit.body.data.checkedInAt,
      admit.body?.data);
  }

  /* ---------------- an event that is not running has no door ------------- */

  const futureDay = new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
  const draft = await organizer.client.post('/events', {
    title: 'Draft — not for the public yet',
    categoryId: od.categories[0].id,
    date: futureDay,
    startTime: '10:00',
    endTime: '13:00',
    registrationOpensAt: new Date().toISOString(),
    registrationClosesAt: new Date(Date.now() + 86_400_000 * 29).toISOString(),
    capacity: 20,
    type: 'free',
    organizerId: organizer.res.body.data.user.id,
    lifecycle: 'draft',
  });
  check('an organizer can draft a future event', draft.status === 201, draft.body);

  if (draft.status === 201 && doorList) {
    const earlyScan = await organizer.client.post('/registrations/check-in', {
      eventId: draft.body.data.id,
      code: doorList.ticketCode,
    });
    // The ticket belongs to another event, so wrong_event is also a refusal —
    // what matters is that it is never reported as admissible.
    check('a ticket cannot be checked in against an unpublished event',
      earlyScan.body.data.kind !== 'valid', earlyScan.body?.data?.kind);
  }

  /* ---------------- an event in the past cannot be created -------------- */

  const yesterday = new Date(Date.now() - 86_400_000 * 2).toISOString().slice(0, 10);
  const backdated = await organizer.client.post('/events', {
    title: 'An event that already happened',
    categoryId: od.categories[0].id,
    date: yesterday,
    startTime: '10:00',
    endTime: '13:00',
    registrationOpensAt: new Date(Date.now() - 86_400_000 * 5).toISOString(),
    registrationClosesAt: new Date(Date.now() - 86_400_000 * 3).toISOString(),
    capacity: 20,
    type: 'free',
    organizerId: organizer.res.body.data.user.id,
    lifecycle: 'draft',
  });
  check('an event cannot be created in the past', backdated.status === 422, backdated.body);

  const lateClose = await organizer.client.post('/events', {
    title: 'Registration closing after the event',
    categoryId: od.categories[0].id,
    date: futureDay,
    startTime: '10:00',
    endTime: '13:00',
    registrationOpensAt: new Date().toISOString(),
    registrationClosesAt: new Date(Date.now() + 86_400_000 * 60).toISOString(),
    capacity: 20,
    type: 'free',
    organizerId: organizer.res.body.data.user.id,
    lifecycle: 'draft',
  });
  check('registration cannot stay open past the event date', lateClose.status === 422, lateClose.body);

  const backwards = await organizer.client.post('/events', {
    title: 'Ends before it starts',
    categoryId: od.categories[0].id,
    date: futureDay,
    startTime: '15:00',
    endTime: '09:00',
    registrationOpensAt: new Date().toISOString(),
    registrationClosesAt: new Date(Date.now() + 86_400_000 * 29).toISOString(),
    capacity: 20,
    type: 'free',
    organizerId: organizer.res.body.data.user.id,
    lifecycle: 'draft',
  });
  check('an event cannot end before it starts', backwards.status === 422, backwards.body);

  const otherEvent = od.events.find((e) => !ownEventIds.has(e.id));
  const trespass = await organizer.client.patch(`/events/${otherEvent.id}`, { title: 'Hijacked' });
  check('an organizer cannot edit another organizer\'s event', trespass.status === 403, trespass.body);

  const userList = await organizer.client.get('/users');
  check('an organizer cannot manage accounts', userList.status === 403, userList.body);

  /* ====================================================== administrator */

  section('Administrator scope');

  const admin = await signIn('revathi@aarambam.org');
  check('an administrator can sign in', admin.res.status === 200, admin.res.body);

  const adminBoot = await admin.client.get('/bootstrap');
  const ad = adminBoot.body.data;
  check('scope is administrator', ad.scope === 'administrator');
  /* At least the seeded ones, not exactly them: joining is exercised earlier
     in this run and leaves a real member behind, exactly as it would in life.
     The payment and event checks below already allow for the same thing. */
  check('every member is fully readable',
    ad.members.length >= seeded.members && ad.members.every((m) => m.fullName !== ''),
    { got: ad.members.length, seeded: seeded.members });
  check('every payment is visible', ad.payments.length >= seeded.payments);
  check('draft and cancelled events are included',
    ad.events.length >= seeded.events, { got: ad.events.length, seeded: seeded.events });
  check('organizers carry their assigned event ids',
    ad.users.filter((u) => u.role === 'organizer').every((u) => Array.isArray(u.assignedEventIds)));

  /* — event lifecycle — */
  const category = ad.categories[0];
  const organizerUser = ad.users.find((u) => u.email === 'aravind@aarambam.org');
  const tomorrow = new Date(Date.now() + 86_400_000);
  const inAMonth = new Date(Date.now() + 30 * 86_400_000);

  const createdEvent = await admin.client.post('/events', {
    title: `Verification Event ${Date.now()}`,
    summary: 'Created by the verification run.',
    description: 'Created by the verification run.',
    categoryId: category.id,
    venueName: 'Aarambam Community Hall',
    venueAddress: '18, Sastri Nagar 3rd Cross',
    city: 'Chennai',
    date: inAMonth.toISOString().slice(0, 10),
    startTime: '18:30',
    endTime: '21:00',
    registrationOpensAt: tomorrow.toISOString(),
    /* Pinned to the event's own end time rather than "now, a month hence",
       whose time of day drifts with the clock the suite happens to run at —
       and could land either side of the event's finish. */
    registrationClosesAt: istInstant(inAMonth.toISOString().slice(0, 10), '21:00'),
    capacity: 40,
    type: 'paid',
    memberPrice: 200,
    nonMemberPrice: 400,
    organizerId: organizerUser.id,
    lifecycle: 'draft',
  });
  check('an administrator can create an event',
    createdEvent.status === 201 && createdEvent.body.data.lifecycle === 'draft', createdEvent.body);
  check('a slug is generated from the title',
    /^verification-event-\d+$/.test(createdEvent.body.data.slug ?? ''), createdEvent.body?.data?.slug);

  const newEventId = createdEvent.body.data.id;

  const draftHidden = await anon.get(`/events/${createdEvent.body.data.slug}`);
  check('a draft event is invisible to the public', draftHidden.status === 404, draftHidden.status);

  const published = await admin.client.patch(`/events/${newEventId}/lifecycle`, { lifecycle: 'published' });
  check('publishing sets publishedAt',
    published.status === 200 && published.body.data.lifecycle === 'published' && published.body.data.publishedAt,
    published.body?.data);

  const badWindow = await admin.client.patch(`/events/${newEventId}`, {
    registrationOpensAt: inAMonth.toISOString(),
    registrationClosesAt: tomorrow.toISOString(),
  });
  check('a registration window that closes before it opens is rejected',
    badWindow.status === 422, badWindow.body);

  const freePriced = await admin.client.patch(`/events/${newEventId}`, { type: 'free', memberPrice: 500 });
  check('a free event cannot be given a price', freePriced.status === 422, freePriced.body);

  const cancelReasonMissing = await admin.client.patch(`/events/${newEventId}/lifecycle`, {
    lifecycle: 'cancelled',
  });
  check('cancelling requires a reason', cancelReasonMissing.status === 422, cancelReasonMissing.body);

  /* — cancelling an event releases every seat — */
  const busyEvent = ad.events.find(
    (e) => e.lifecycle === 'published' &&
      ad.registrations.filter((r) => r.eventId === e.id && r.status !== 'cancelled').length > 3,
  );
  if (busyEvent) {
    const seatsBefore = ad.registrations.filter(
      (r) => r.eventId === busyEvent.id && r.status !== 'cancelled').length;
    const cancelled = await admin.client.patch(`/events/${busyEvent.id}/lifecycle`, {
      lifecycle: 'cancelled', reason: 'Verification run',
    });
    check('an event can be cancelled with a reason',
      cancelled.status === 200 && cancelled.body.data.cancellationReason === 'Verification run',
      cancelled.body?.data);

    const afterCancel = await admin.client.get(`/registrations?eventId=${busyEvent.id}&pageSize=200`);
    check(`cancelling released all ${seatsBefore} live seats`,
      afterCancel.body.data.every((r) => r.status === 'cancelled'),
      afterCancel.body.data.filter((r) => r.status !== 'cancelled').length);
  }

  /* — capacity cannot drop below seats sold — */
  // Re-read: the cancellation above released every seat on that event, so the
  // pre-cancellation snapshot is no longer a safe place to pick from.
  const fresh = (await admin.client.get('/bootstrap')).body.data;
  const soldEvent = fresh.events.find(
    (e) =>
      e.lifecycle !== 'cancelled' &&
      fresh.registrations.filter((r) => r.eventId === e.id && r.status !== 'cancelled').length > 2,
  );
  check('an event with live seats exists to test capacity against', Boolean(soldEvent));
  if (soldEvent) {
    const shrink = await admin.client.patch(`/events/${soldEvent.id}`, { capacity: 1 });
    check('capacity cannot fall below the seats already taken', shrink.status === 422, shrink.body);
  }

  /* — categories and plans — */
  const newCategory = await admin.client.post('/event-categories', {
    name: `Verification ${Date.now()}`, description: 'temp', color: '#123456', active: true,
  });
  check('a category can be created', newCategory.status === 201, newCategory.body);
  const catUpdated = await admin.client.patch(`/event-categories/${newCategory.body.data.id}`, {
    active: false,
  });
  check('a category can be deactivated', catUpdated.body.data.active === false, catUpdated.body);
  const catInUse = await admin.client.del(`/event-categories/${category.id}`);
  check('a category in use cannot be deleted', catInUse.status === 409, catInUse.body);

  const newPlan = await admin.client.post('/plans', {
    name: `Verification Plan ${Date.now()}`,
    description: 'temp', price: 100, durationMonths: 6,
    benefits: ['One', 'Two'], active: true, recommended: true, sortOrder: 9,
  });
  check('a plan can be created with benefits',
    newPlan.status === 201 && newPlan.body.data.benefits.length === 2, newPlan.body);
  const recommendedCount = (await admin.client.get('/plans')).body.data.filter((p) => p.recommended).length;
  check('only one plan is ever recommended', recommendedCount === 1, recommendedCount);
  const planInUse = await admin.client.del(`/plans/${plan.id}`);
  check('a plan with subscriptions cannot be deleted', planInUse.status === 409, planInUse.body);

  /* — age-restricted plans —
     The "Under 18" plan enforced nothing: a nineteen-year-old could pick it
     and pay a hundred rupees rather than three hundred. The bound is a
     property of the plan now, so these bracket the member's own age rather
     than hard-coding eighteen. */
  {
    const age = myAge;

    const stamp = Date.now();
    const makePlan = (suffix, bounds) => admin.client.post('/plans', {
      name: `Age Check ${suffix} ${stamp}`,
      description: 'temp', price: 100, durationMonths: 12,
      benefits: ['One'], active: true, recommended: false, sortOrder: 90,
      ...bounds,
    });

    const tooOld = await makePlan('max', { maxAge: Math.max(age - 1, 0) });
    const tooYoung = await makePlan('min', { minAge: age + 1 });
    check('a plan can carry an age range',
      tooOld.status === 201 && tooOld.body.data.maxAge === Math.max(age - 1, 0) &&
      tooYoung.status === 201 && tooYoung.body.data.minAge === age + 1,
      { tooOld: tooOld.body, tooYoung: tooYoung.body });

    const inverted = await makePlan('inverted', { minAge: 40, maxAge: 20 });
    check('a plan whose oldest age is below its youngest is refused',
      inverted.status === 400, inverted.body);

    const boughtTooYoung = await member.client.post('/subscriptions', {
      planId: tooYoung.body.data.id, method: 'upi',
    });
    check('a member below a plan’s minimum age cannot buy it',
      boughtTooYoung.status === 400 && /aged \d+ and over/.test(boughtTooYoung.body.message ?? ''),
      boughtTooYoung.body);

    const boughtTooOld = await member.client.post('/subscriptions', {
      planId: tooOld.body.data.id, method: 'upi',
    });
    check('and a member above its maximum age cannot either',
      boughtTooOld.status === 400 && /aged \d+ and under/.test(boughtTooOld.body.message ?? ''),
      boughtTooOld.body);

    /* Selling somebody the wrong plan at the counter is the same mistake as
       buying it yourself, so the counter is not exempt. */
    const soldByAdmin = await admin.client.post('/subscriptions', {
      memberId, planId: tooYoung.body.data.id, method: 'upi',
    });
    check('an administrator cannot sell it to them either',
      soldByAdmin.status === 400, soldByAdmin.body);

    /* The bound can come back off — sending null clears it, which is why the
       PATCH schema distinguishes null from an absent field. */
    const lifted = await admin.client.patch(`/plans/${tooYoung.body.data.id}`, { minAge: null });
    check('an age bound can be lifted again',
      lifted.status === 200 && lifted.body.data.minAge === undefined, lifted.body.data);

    /* By now this member has a term queued from the downgrade checks above,
       so the purchase is stopped for that reason instead. What matters is
       that age is no longer the objection. */
    const nowAllowed = await member.client.post('/subscriptions', {
      planId: tooYoung.body.data.id, method: 'upi',
    });
    check('and then their age is no longer what stands in the way',
      nowAllowed.status === 201 || nowAllowed.body.code !== 'PLAN_AGE_MISMATCH',
      nowAllowed.body);
    if (nowAllowed.body?.data?.payment?.id) {
      await member.client.post(`/payments/${nowAllowed.body.data.payment.id}/settle`,
        { outcome: 'failed' });
    }

    /* Housekeeping: neither was bought, so neither leaves a trace. */
    await admin.client.del(`/plans/${tooOld.body.data.id}`);
    await admin.client.del(`/plans/${tooYoung.body.data.id}`);

    const shipped = (await admin.client.get('/plans')).body.data
      .find((p) => String(p.name).toLowerCase() === 'under 18');
    check('the organisation’s own Under 18 plan carries the bound it is named for',
      !shipped || shipped.maxAge === 17, shipped);
  }

  /* — members — */
  const createdMember = await admin.client.post('/members', {
    fullName: 'Verification Member',
    email: `member.${Date.now()}@example.com`,
    phone: '+91 90000 22222',
    whatsappNumber: '+91 90000 22222',
    age: 34, gender: 'female',
    addressLine1: '1, Test Street', city: 'Chennai', district: 'Chennai',
    state: 'Tamil Nadu', pincode: '600040',
    idProofType: 'aadhaar', idProofNumber: '1234 5678 9012',
    hasMedicalConditions: false, whatsappGroupConsent: true, mediaConsent: true,
  });
  check('an administrator can add a member',
    createdMember.status === 201 && createdMember.body.data.status === 'pending', createdMember.body);
  check('a member id is generated in the ARM-#### form',
    /^ARM-\d+$/.test(createdMember.body.data.memberId ?? ''), createdMember.body?.data?.memberId);

  const minor = await admin.client.post('/members', {
    fullName: 'Under Age', email: `minor.${Date.now()}@example.com`,
    phone: '+91 90000 33333', whatsappNumber: '+91 90000 33333',
    age: 15, gender: 'male',
    addressLine1: '1, Test Street', city: 'Chennai', district: 'Chennai',
    state: 'Tamil Nadu', pincode: '600040',
    idProofType: 'aadhaar', idProofNumber: '1234 5678 9012',
    hasMedicalConditions: false, whatsappGroupConsent: false, mediaConsent: false,
  });
  check('a member under 18 needs guardian details',
    minor.status === 422 && Boolean(minor.body.errors?.guardianName), minor.body);

  const suspended = await admin.client.patch(`/members/${createdMember.body.data.id}/status`, {
    status: 'suspended', reason: 'Verification run',
  });
  check('suspending a membership works', suspended.body.data.status === 'suspended', suspended.body);

  const detailView = await admin.client.get(`/members/${memberId}`);
  check('the member detail view joins their history',
    detailView.status === 200 &&
    Array.isArray(detailView.body.data.subscriptions) &&
    Array.isArray(detailView.body.data.payments) &&
    Array.isArray(detailView.body.data.registrations),
    Object.keys(detailView.body?.data ?? {}));

  /* — users and roles — */
  const selfDemote = await admin.client.patch(`/users/${admin.res.body.data.user.id}/role`, {
    role: 'member',
  });
  check('an administrator cannot change their own role', selfDemote.status === 403, selfDemote.body);

  const selfDeactivate = await admin.client.patch(`/users/${admin.res.body.data.user.id}/status`, {
    status: 'inactive',
  });
  check('an administrator cannot deactivate themselves', selfDeactivate.status === 403, selfDeactivate.body);

  const promote = await admin.client.patch(`/users/${organizerUser.id}/role`, { role: 'administrator' });
  check('an administrator can change someone else\'s role',
    promote.status === 200 && promote.body.data.role === 'administrator', promote.body);
  await admin.client.patch(`/users/${organizerUser.id}/role`, { role: 'organizer' });

  const deactivated = await admin.client.patch(`/users/${organizerUser.id}/status`, { status: 'inactive' });
  check('an account can be deactivated', deactivated.body.data.status === 'inactive', deactivated.body);
  const lockedOut = await client().post('/auth/login', {
    email: 'aravind@aarambam.org', password: env.seedPassword,
  });
  check('a deactivated account cannot sign in', lockedOut.status === 403, lockedOut.body);
  await admin.client.patch(`/users/${organizerUser.id}/status`, { status: 'active' });

  /* — settings — */
  const org = await admin.client.patch('/settings/organisation', { tagline: 'Verified tagline' });
  check('the organisation profile can be edited',
    org.status === 200 && org.body.data.tagline === 'Verified tagline', org.body);
  check('editing one field leaves the rest intact', org.body.data.name === 'Aarambam', org.body.data);

  const template = await admin.client.patch('/settings/email-templates/event_reminder', {
    subject: 'Tomorrow: {{event_title}}!', enabled: false,
  });
  check('an email template can be edited and switched off',
    template.status === 200 && template.body.data.enabled === false, template.body);

  /* — notifications — */
  const unread = await admin.client.get('/notifications?unreadOnly=true');
  check('unread notifications are listed', unread.status === 200 && unread.body.data.length > 0);
  const readOne = await admin.client.patch(`/notifications/${unread.body.data[0].id}/read`, { read: true });
  check('a notification can be marked read', readOne.body.data.read === true, readOne.body);
  await admin.client.post('/notifications/read-all');
  const count = await admin.client.get('/notifications/unread-count');
  check('mark-all-read clears the badge', count.body.data.count === 0, count.body);

  const crossAccount = await member.client.patch(`/notifications/${unread.body.data[0].id}/read`, {
    read: false,
  });
  check('a notification cannot be touched by another account', crossAccount.status === 404, crossAccount.body);

  /* ================================================== capacity & limits */

  section('Concurrency and validation');

  const tiny = await admin.client.post('/events', {
    title: `Single Seat ${Date.now()}`,
    summary: 'One seat only.', description: 'One seat only.',
    categoryId: category.id, venueName: 'Hall', venueAddress: 'Somewhere', city: 'Chennai',
    date: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    startTime: '10:00', endTime: '12:00',
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
    registrationClosesAt: new Date(Date.now() + 9 * 86_400_000).toISOString(),
    capacity: 1, type: 'free', memberPrice: 0, nonMemberPrice: 0,
    organizerId: organizerUser.id, lifecycle: 'published',
  });
  const tinyId = tiny.body.data.id;

  const twoMembers = ad.members.filter((m) => m.status === 'active').slice(0, 2);
  const [first, second] = await Promise.all([
    admin.client.post('/registrations', { eventId: tinyId, memberId: twoMembers[0].id }),
    admin.client.post('/registrations', { eventId: tinyId, memberId: twoMembers[1].id }),
  ]);
  const statuses = [first.status, second.status].sort();
  check('two people racing for one seat: exactly one wins',
    statuses[0] === 201 && statuses[1] === 409, {
      first: { status: first.status, message: first.body?.message },
      second: { status: second.status, message: second.body?.message },
    });

  const soldOut = await admin.client.post('/registrations', {
    eventId: tinyId, memberId: ad.members.find((m) => m.status === 'active' &&
      !twoMembers.some((t) => t.id === m.id)).id,
  });
  check('a sold-out event refuses further bookings', soldOut.status === 409, soldOut.body);

  /* The member holding the last seat must still be able to get back to their
     own payment. Their hold is part of the seat count, so the event reads as
     sold out to them too — which used to lock them out of finishing the
     payment they had already begun, leaving it pending indefinitely. */
  const paidTiny = await admin.client.post('/events', {
    title: `Single Paid Seat ${Date.now()}`,
    summary: 'One seat only.', description: 'One seat only.',
    categoryId: category.id, venueName: 'Hall', venueAddress: 'Somewhere', city: 'Chennai',
    date: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    startTime: '10:00', endTime: '12:00',
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
    registrationClosesAt: new Date(Date.now() + 9 * 86_400_000).toISOString(),
    capacity: 1, type: 'paid', memberPrice: 250, nonMemberPrice: 400,
    organizerId: organizerUser.id, lifecycle: 'published',
  });

  const soloMember = ad.members.find(
    (m) => m.status === 'active' && !twoMembers.some((t) => t.id === m.id),
  );
  const held = await admin.client.post('/registrations', {
    eventId: paidTiny.body.data.id, memberId: soloMember.id, method: 'upi',
  });
  check('the last seat on a paid event can be held', held.status === 201, held.body);

  const resumed = await admin.client.post('/registrations', {
    eventId: paidTiny.body.data.id, memberId: soloMember.id, method: 'upi',
  });
  check('the holder of the last seat can return to their own payment',
    resumed.status === 201 &&
    resumed.body.data.registration.id === held.body.data.registration.id &&
    resumed.body.data.payment.id === held.body.data.payment.id,
    { status: resumed.status, message: resumed.body?.message });

  const resumedSettle = await admin.client.post(
    `/payments/${held.body.data.payment.id}/settle`, { outcome: 'successful' });
  check('that payment then settles and confirms the seat',
    resumedSettle.status === 200 && resumedSettle.body.data.status === 'successful',
    resumedSettle.body);

  const badUuid = await admin.client.get('/events/../../etc/passwd');
  check('a traversal-shaped path does not resolve an event',
    [400, 404].includes(badUuid.status), badUuid.status);

  const injection = await admin.client.get(
    `/members?q=${encodeURIComponent("'; DROP TABLE users; --")}`);
  check('a SQL-shaped search term is treated as text', injection.status === 200, injection.body?.message);
  const usersIntact = await db.queryOne('SELECT COUNT(*)::int AS n FROM users');
  check('the users table is still there', usersIntact.n > 50, usersIntact);

  const overLong = await admin.client.post('/event-categories', { name: 'x'.repeat(500) });
  check('an over-long field is rejected', overLong.status === 422, overLong.status);

  const unknownField = await admin.client.patch(`/events/${newEventId}`, {
    title: 'Renamed by verification', isSuperUser: true, capacity: 41,
  });
  check('unknown fields are stripped rather than written',
    unknownField.status === 200 && unknownField.body.data.capacity === 41 &&
    !('isSuperUser' in unknownField.body.data), unknownField.body?.data);

  /* ============================================================ sign-out */

  section('Sign-out');

  const signedOut = await member.client.post('/auth/logout');
  check('sign-out succeeds', signedOut.status === 200, signedOut.body);
  const staleRefresh = await member.client.post('/auth/refresh');
  check('the session cannot be refreshed after signing out',
    staleRefresh.status === 401, staleRefresh.body);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await db.close().catch(() => undefined);
}

/* --------------------------------------------------------------- report */

process.stdout.write(`\n${'-'.repeat(64)}\n`);
if (failures.length === 0) {
  process.stdout.write(`All ${passed} checks passed.\n`);
  process.exit(0);
}
process.stdout.write(`${passed} passed, ${failures.length} FAILED\n\n`);
for (const failure of failures) {
  process.stdout.write(`  [${failure.group}] ${failure.label}\n`);
  if (failure.context !== undefined) {
    process.stdout.write(`      ${JSON.stringify(failure.context).slice(0, 500)}\n`);
  }
}
process.exit(1);
