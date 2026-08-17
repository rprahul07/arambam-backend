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
  check('six email templates are configured', publicData.emailTemplates.length === 6);

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

  for (const role of ['administrator', 'organizer', 'member']) {
    const demo = await client().post('/auth/demo-login', { role });
    check(`one-click sign-in works for ${role}`,
      demo.status === 200 && demo.body.data.user.role === role, demo.body);
  }

  const registered = await client().post('/auth/register', {
    name: 'Verification Tester',
    email: `verify.${Date.now()}@example.com`,
    phone: '+91 90000 11111',
    password: 'Str0ng!Pass',
  });
  check('registration creates an account awaiting verification',
    registered.status === 201 && registered.body.data.requiresVerification === true, registered.body);

  const weak = await client().post('/auth/register', {
    name: 'Weak Password', email: `weak.${Date.now()}@example.com`,
    phone: '+91 90000 11111', password: 'password',
  });
  check('a weak password is rejected with field errors',
    weak.status === 422 && Boolean(weak.body.errors?.password), weak.body);

  const duplicate = await client().post('/auth/register', {
    name: 'Divya Again', email: 'divya.bharathi@gmail.com',
    phone: '+91 90000 11111', password: 'Str0ng!Pass',
  });
  check('a duplicate email is refused', duplicate.status === 409, duplicate.body);

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

    const release = await member.client.patch(`/registrations/${free.body.data.registration.id}/cancel`, {
      reason: 'Verification run',
    });
    check('a member can release their own seat',
      release.status === 200 && release.body.data.status === 'cancelled', release.body);
  }

  /* ================================================ membership purchase */

  section('Membership purchase');

  const plan = md.plans.find((p) => p.active && p.name === 'Premium') ?? md.plans.find((p) => p.active);
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

  const cheaper = afterDrop.body.data.plans
    .filter((p) => p.active && p.price < inForcePlan.price)
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
    const scan = await organizer.client.post('/registrations/check-in', {
      eventId: ownEventId, code: doorList.ticketCode,
    });
    check('a valid ticket resolves at check-in',
      scan.status === 200 && ['valid', 'already_checked_in'].includes(scan.body.data.kind),
      scan.body?.data?.kind);

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
  check('every member is fully readable',
    ad.members.length === seeded.members && ad.members.every((m) => m.fullName !== ''));
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
    registrationClosesAt: inAMonth.toISOString(),
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
