/**
 * Integration testing.
 *
 * Where `verify.js` walks the flows a person performs, this walks the surface:
 * every route the server registers, every field every write endpoint accepts,
 * and the business rules that decide what the answers mean.
 *
 *   node scripts/integration.js
 *
 * Three things are asserted everywhere, on every request this file makes:
 *
 *   1. Nothing answers 5xx. The error handler already turns known database
 *      failures into 4xx, so a 500 that escapes is a defect by definition.
 *   2. Nothing answers a *routing* 404. A resource 404 ("that event no longer
 *      exists") is a correct answer; `No endpoint matches …` from the
 *      notFound middleware means a route is missing or mis-mounted.
 *   3. Bad input is refused with 4xx and a message, never accepted and never
 *      crashed on.
 *
 * The route list is read from Express itself and the field lists from the Zod
 * schemas, so neither can drift out of date as the API grows.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const scratch = path.join(root, '.data', 'integration');
fs.rmSync(scratch, { recursive: true, force: true });
process.env.DATABASE_DRIVER = 'pglite';
process.env.PGLITE_DATA_DIR = scratch;
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';
process.env.PORT = process.env.INTEGRATION_PORT || '5201';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_PREVIEW_ONLY = 'true';
process.env.PAYMENT_PROVIDER = 'simulated';
/* The suite fires thousands of requests in a couple of minutes. The
   production ceilings would start answering 429 part way through and mask
   what the endpoints actually do, so all three are lifted here. The limiters
   themselves are exercised deliberately in their own section instead. */
process.env.RATE_LIMIT_MAX = '1000000';
process.env.AUTH_RATE_LIMIT_MAX = '1000000';
process.env.WRITE_RATE_LIMIT_MAX = '1000000';
process.env.RATE_LIMIT_WINDOW_MINUTES = '120';

const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/database/index.js');
const { seed } = await import('../src/database/seed/index.js');
const { default: env } = await import('../src/config/env.js');
const storage = await import('../src/services/storage.service.js');

/* Real objects this run puts in the private bucket, removed before it ends. */
const temporaryObjects = [];

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
      process.stdout.write(`        ${JSON.stringify(context).slice(0, 500)}\n`);
    }
  }
}

/** Counts many assertions but only prints the ones that fail. */
function checkAll(label, results) {
  const bad = results.filter((r) => !r.ok);
  check(`${label} (${results.length} cases)`, bad.length === 0, bad.slice(0, 6));
}

const BASE = `http://127.0.0.1:${env.port}${env.apiPrefix}`;
const ORIGIN_BASE = `http://127.0.0.1:${env.port}`;

function client() {
  const jar = new Map();
  let accessToken = null;

  const call = async (method, url, body, options = {}) => {
    const headers = { Origin: 'http://localhost:5173', ...(options.headers ?? {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken && !options.anonymous) headers.Authorization = `Bearer ${accessToken}`;
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const target = options.absolute ? `${ORIGIN_BASE}${url}` : `${BASE}${url}`;

    let response;
    try {
      response = await fetch(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      /* A refused or dropped connection is a finding, not a reason to abandon
         the run — the remaining hundreds of cases still need answering. */
      return {
        status: 599,
        body: { message: `transport failure: ${error.cause?.code ?? error.message}` },
        method,
        url,
        transportFailure: true,
      };
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
      payload = { raw: text.slice(0, 200) };
    }
    return { status: response.status, body: payload, method, url };
  };

  return {
    get: (url, options) => call('GET', url, undefined, options),
    post: (url, body, options) => call('POST', url, body ?? {}, options),
    patch: (url, body) => call('PATCH', url, body ?? {}),
    del: (url) => call('DELETE', url),
    call,
    setToken: (token) => {
      accessToken = token;
    },
  };
}

async function signIn(email, password = env.seedPassword) {
  const c = client();
  const res = await c.post('/auth/login', { email, password });
  if (res.status === 200) c.setToken(res.body.data.accessToken);
  return { client: c, res, user: res.body?.data?.user };
}

/* --------------------------------------------------- response predicates -- */

const isServerError = (res) => res.status >= 500;
/** A 404 from the notFound middleware means the route itself is missing. */
const isRoutingMiss = (res) =>
  res.status === 404 && typeof res.body?.message === 'string' &&
  res.body.message.startsWith('No endpoint matches');

const describe = (res) => ({
  request: `${res.method} ${res.url}`,
  status: res.status,
  message: res.body?.message,
});

/** Every request the suite makes passes through here. */
function record(res, results) {
  if (isServerError(res)) results.push({ ok: false, why: 'server error', ...describe(res) });
  else if (isRoutingMiss(res)) results.push({ ok: false, why: 'route not found', ...describe(res) });
  else results.push({ ok: true });
  return res;
}

/* ------------------------------------------------------ route inventory -- */

/** Reads the routes out of Express rather than a hand-kept list. */
function inventory(stack, prefix = '') {
  const found = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on) found.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const mount = layer.regexp?.source
        ?.replace('^\\/', '/')
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/')
        .replace(/\$$/, '')
        .replace('(?=/|$)', '')
        .replace(/^\^/, '');
      found.push(...inventory(layer.handle.stack, prefix + (mount === '/' || !mount ? '' : mount)));
    }
  }
  return found;
}

/* --------------------------------------------------------- fuzz values -- */

const LONG = 'x'.repeat(5000);
const XSS = '<script>alert(document.cookie)</script>';
const SQL = "'; DROP TABLE users; --";
const UNICODE = '🌱 അารംഭം ‮reversed';
const NUL = 'a\u0000b';

/** Hostile values to try in place of a good one, whatever its type. */
const HOSTILE = [
  ['null', null],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['number where text expected', 12345],
  ['boolean', true],
  ['array', ['a', 'b']],
  ['object', { nested: { deep: true } }],
  ['over-long string', LONG],
  ['script tag', XSS],
  ['sql-shaped', SQL],
  ['unicode and bidi', UNICODE],
  ['null byte', NUL],
  ['negative number', -1],
  ['huge number', 9_999_999_999_999],
  ['float where integer expected', 1.5],
  ['not a date', '31-02-2026'],
  ['not a uuid', 'not-a-uuid'],
];

/** Unwraps .refine()/.default() wrappers to reach the object shape. */
function shapeOf(schema) {
  let current = schema;
  for (let i = 0; i < 10 && current; i += 1) {
    if (typeof current.shape === 'object' && current.shape !== null) return current.shape;
    if (current._def?.schema) current = current._def.schema;
    else if (current._def?.innerType) current = current._def.innerType;
    else return null;
  }
  return null;
}

/**
 * Replaces one field at a time with each hostile value and asserts the server
 * refuses it cleanly. A hostile value that happens to be legal for that field
 * (an over-long string in an unbounded field, say) is allowed to succeed —
 * what matters is that nothing 5xxs and nothing is a routing miss.
 */
async function fuzzFields({ label, request, schema, valid, skip = [] }) {
  const shape = shapeOf(schema);
  const results = [];
  if (!shape) {
    results.push({ ok: false, why: 'could not read schema shape', label });
    return results;
  }

  const fields = Object.keys(shape).filter((f) => !skip.includes(f));

  for (const field of fields) {
    for (const [name, value] of HOSTILE) {
      const payload = { ...valid, [field]: value };
      const res = await request(payload);

      if (isServerError(res)) {
        results.push({ ok: false, why: '5xx', field, hostile: name, ...describe(res) });
      } else if (isRoutingMiss(res)) {
        results.push({ ok: false, why: 'routing 404', field, hostile: name, ...describe(res) });
      } else if (res.status >= 200 && res.status < 300 && value === null) {
        /* Accepting an explicit null for a declared field is worth knowing
           about even when it does not crash. */
        results.push({ ok: true });
      } else {
        results.push({ ok: true });
      }
    }
  }

  /* Every field removed entirely, one at a time. */
  for (const field of fields) {
    const payload = { ...valid };
    delete payload[field];
    const res = await request(payload);
    if (isServerError(res) || isRoutingMiss(res)) {
      results.push({ ok: false, why: 'missing field', field, ...describe(res) });
    } else {
      results.push({ ok: true });
    }
  }

  /* Shapes the endpoint never asked for. */
  for (const [name, payload] of [
    ['empty object', {}],
    ['array body', []],
    ['string body', 'hello'],
    ['number body', 42],
    ['null body', null],
    ['unknown fields only', { nonsense: true, __proto__: { polluted: true } }],
    ['prototype pollution', { ...valid, __proto__: { isAdmin: true }, constructor: { x: 1 } }],
    ['deeply nested', { ...valid, deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } }],
  ]) {
    const res = await request(payload);
    if (isServerError(res) || isRoutingMiss(res)) {
      results.push({ ok: false, why: `body shape: ${name}`, ...describe(res) });
    } else {
      results.push({ ok: true });
    }
  }

  return results;
}

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
  const aMember = data.members.find((m) => m.status === 'active');
  const aPlan = data.plans.find((p) => p.active);
  const aCategory = data.categories[0];
  const aRegistration = data.registrations.find((r) => r.status !== 'cancelled');
  const aPayment = data.payments[0];
  const aNotification = data.notifications[0];

  /* ============================================ 1. every route answers ==== */

  section('Route reachability — no 5xx, no routing 404');

  const routes = inventory(app._router.stack);
  check('the router exposes routes to walk', routes.length > 40, routes.length);

  const UUID = '00000000-0000-4000-8000-000000000000';
  const fill = (p) =>
    p
      .replace(':idOrSlug', anEvent?.slug ?? UUID)
      .replace(':id', UUID)
      .replace(':key', 'payment_confirmation');

  for (const actor of [
    { name: 'anonymous', c: anon },
    { name: 'member', c: member.client },
    { name: 'organizer', c: organizer.client },
    { name: 'administrator', c: admin.client },
  ]) {
    const results = [];
    for (const route of routes) {
      /* Signing out would invalidate the session the rest of the sweep needs. */
      if (route.path.endsWith('/auth/logout')) continue;
      const url = fill(route.path).replace(env.apiPrefix, '');
      const absolute = !route.path.startsWith(env.apiPrefix);
      const res = await actor.c.call(
        route.method,
        absolute ? route.path : url,
        route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
        { absolute },
      );
      record(res, results);
    }
    checkAll(`${actor.name} can reach every route without a crash`, results);
  }

  /* Paths that genuinely do not exist must still answer 404 cleanly. */
  const missing = [];
  for (const url of [
    '/nope',
    '/events/../../etc/passwd',
    '/events/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/members/00000000-0000-4000-8000-000000000000/nope',
    '/a'.repeat(200),
  ]) {
    const res = await anon.get(url);
    missing.push(
      isServerError(res)
        ? { ok: false, why: 'unknown path crashed', ...describe(res) }
        : { ok: true },
    );
  }
  checkAll('unknown paths answer without crashing', missing);

  /* ================================================== 2. the auth matrix == */

  section('Authorisation matrix');

  const guarded = [
    ['GET', '/members', ['administrator', 'organizer']],
    ['GET', '/users', ['administrator']],
    ['POST', '/events', ['administrator', 'organizer']],
    ['POST', '/plans', ['administrator']],
    ['POST', '/event-categories', ['administrator']],
    ['PATCH', '/settings/organisation', ['administrator']],
    ['GET', '/settings/email-templates', ['administrator']],
  ];

  const authResults = [];
  for (const [method, url, allowed] of guarded) {
    const anonRes = await anon.call(method, url, method === 'GET' ? undefined : {});
    record(anonRes, authResults);
    authResults.push(
      anonRes.status === 401
        ? { ok: true }
        : { ok: false, why: 'anonymous was not challenged', ...describe(anonRes) },
    );

    for (const [role, actor] of [
      ['member', member],
      ['organizer', organizer],
      ['administrator', admin],
    ]) {
      const res = await actor.client.call(method, url, method === 'GET' ? undefined : {});
      record(res, authResults);
      const permitted = allowed.includes(role);
      /* A permitted caller may still be refused on the merits (422 for an
         empty body); what matters is that it is not a 403. */
      const correct = permitted ? res.status !== 403 : res.status === 403;
      authResults.push(
        correct ? { ok: true } : { ok: false, why: `${role} on ${method} ${url}`, ...describe(res) },
      );
    }
  }
  checkAll('every guarded route answers the right way to each role', authResults);

  /* A member must not be able to lift their own role. */
  const escalation = [];
  for (const [method, url, body] of [
    ['PATCH', `/users/${member.user.id}/role`, { role: 'administrator' }],
    ['PATCH', `/users/${member.user.id}/status`, { status: 'active' }],
    ['PATCH', `/members/${aMember.id}/status`, { status: 'active' }],
    ['DELETE', `/members/${aMember.id}`, undefined],
    ['POST', '/plans', { name: 'Free for me', price: 0, durationMonths: 12, benefits: [] }],
  ]) {
    const res = await member.client.call(method, url, body);
    record(res, escalation);
    escalation.push(
      [401, 403].includes(res.status)
        ? { ok: true }
        : { ok: false, why: 'member was allowed', ...describe(res) },
    );
  }
  checkAll('a member cannot escalate their own privileges', escalation);

  /* A token must actually be checked. */
  const tampered = client();
  tampered.setToken('not.a.real.token');
  const badToken = await tampered.get('/members');
  check('a malformed bearer token is rejected, not crashed on',
    badToken.status === 401, describe(badToken));

  const noneAlg = client();
  noneAlg.setToken(
    `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.` +
    `${Buffer.from(JSON.stringify({ sub: admin.user.id, role: 'administrator' })).toString('base64url')}.`,
  );
  const forged = await noneAlg.get('/users');
  check('an unsigned "alg: none" token is refused', forged.status === 401, describe(forged));

  /* ================================================= 3. the field matrix == */

  section('Field validation — every field of every write endpoint');

  const v = await import('../src/modules/auth/auth.validation.js');
  const mv = await import('../src/modules/members/members.validation.js');
  const ev = await import('../src/modules/events/events.validation.js');
  const rv = await import('../src/modules/registrations/registrations.validation.js');

  const futureDay = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

  const validEvent = {
    title: 'A perfectly ordinary event',
    summary: 'Short summary.',
    description: 'Longer description.',
    categoryId: aCategory.id,
    venueName: 'Hall',
    venueAddress: 'Somewhere',
    city: 'Chennai',
    date: futureDay,
    startTime: '10:00',
    endTime: '12:00',
    registrationOpensAt: new Date().toISOString(),
    registrationClosesAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
    capacity: 25,
    type: 'free',
    memberPrice: 0,
    nonMemberPrice: 0,
    organizerId: organizer.user.id,
    lifecycle: 'draft',
  };

  const validMember = {
    fullName: 'Test Person',
    email: `fuzz.${Date.now()}@example.org`,
    phone: '9000000000',
    whatsappNumber: '9000000000',
    age: 30,
    gender: 'female',
    addressLine1: '1 Street',
    city: 'Chennai',
    district: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600001',
    idProofType: 'aadhaar',
    idProofNumber: '123412341234',
  };

  const matrices = [
    {
      label: 'POST /auth/register',
      schema: v.registerSchema,
      valid: { name: 'Test Person', email: `reg.${Date.now()}@example.org`, phone: '9000000000', password: 'Str0ng!Pass' },
      request: (body) => anon.post('/auth/register', body),
    },
    {
      label: 'POST /auth/login',
      schema: v.loginSchema,
      valid: { email: 'divya.bharathi@gmail.com', password: env.seedPassword },
      request: (body) => client().post('/auth/login', body),
    },
    {
      label: 'POST /auth/forgot-password',
      schema: v.emailOnlySchema,
      valid: { email: 'divya.bharathi@gmail.com' },
      request: (body) => anon.post('/auth/forgot-password', body),
    },
    {
      label: 'POST /auth/reset-password',
      schema: v.resetPasswordSchema,
      valid: { token: 'a'.repeat(40), password: 'Str0ng!Pass' },
      request: (body) => anon.post('/auth/reset-password', body),
    },
    {
      label: 'POST /auth/change-password',
      schema: v.changePasswordSchema,
      valid: { currentPassword: env.seedPassword, newPassword: 'An0ther!Pass' },
      /* A fresh session each time: a successful change would end this one. */
      request: async (body) => (await signIn('aravind@aarambam.org')).client.post('/auth/change-password', body),
    },
    {
      label: 'POST /events',
      schema: ev.createEventSchema,
      valid: validEvent,
      request: (body) => admin.client.post('/events', body),
    },
    {
      label: 'PATCH /events/:id',
      schema: ev.updateEventSchema,
      valid: { title: 'A renamed event' },
      request: (body) => admin.client.patch(`/events/${anEvent.id}`, body),
    },
    {
      label: 'PATCH /events/:id/lifecycle',
      schema: ev.lifecycleSchema,
      valid: { lifecycle: 'published' },
      request: (body) => admin.client.patch(`/events/${anEvent.id}/lifecycle`, body),
    },
    {
      label: 'POST /members',
      schema: mv.createMemberSchema,
      valid: validMember,
      request: (body) => admin.client.post('/members', body),
    },
    {
      label: 'PATCH /members/:id',
      schema: mv.updateMemberSchema,
      valid: { city: 'Madurai' },
      request: (body) => admin.client.patch(`/members/${aMember.id}`, body),
    },
    {
      label: 'PATCH /members/:id/status',
      schema: mv.statusSchema,
      valid: { status: 'active' },
      request: (body) => admin.client.patch(`/members/${aMember.id}/status`, body),
    },
    {
      label: 'POST /registrations',
      schema: rv.createRegistrationSchema,
      valid: { eventId: anEvent.id, memberId: aMember.id, method: 'upi' },
      request: (body) => admin.client.post('/registrations', body),
    },
    {
      label: 'POST /registrations/check-in',
      schema: rv.checkInSchema,
      valid: { eventId: anEvent.id, code: 'ZZZZ0000' },
      request: (body) => admin.client.post('/registrations/check-in', body),
    },
    {
      label: 'PATCH /registrations/:id/attendance',
      schema: rv.attendanceSchema,
      valid: { attendance: 'not_checked_in' },
      request: (body) => admin.client.patch(`/registrations/${aRegistration.id}/attendance`, body),
    },
    {
      label: 'POST /subscriptions',
      schema: null,
      valid: { planId: aPlan.id, method: 'upi', memberId: aMember.id },
      fields: ['planId', 'method', 'memberId', 'kind'],
      request: (body) => admin.client.post('/subscriptions', body),
    },
    {
      label: 'POST /payments/:id/settle',
      schema: null,
      valid: { outcome: 'failed' },
      fields: ['outcome', 'gatewayPaymentId', 'signature'],
      request: (body) => admin.client.post(`/payments/${aPayment.id}/settle`, body),
    },
    {
      label: 'PATCH /settings/organisation',
      schema: null,
      valid: { name: 'Aarambam' },
      fields: ['name', 'email', 'phone', 'addressLine1', 'city', 'website'],
      request: (body) => admin.client.patch('/settings/organisation', body),
    },
    {
      label: 'POST /plans',
      schema: null,
      valid: { name: `Plan ${Date.now()}`, price: 500, durationMonths: 12, benefits: ['One'] },
      fields: ['name', 'price', 'durationMonths', 'benefits', 'description', 'active', 'recommended', 'sortOrder'],
      request: (body) => admin.client.post('/plans', body),
    },
    {
      label: 'POST /event-categories',
      schema: null,
      valid: { name: `Category ${Date.now()}`, color: '#123456' },
      fields: ['name', 'color', 'description', 'active', 'slug'],
      request: (body) => admin.client.post('/event-categories', body),
    },
  ];

  for (const matrix of matrices) {
    const shape = matrix.schema ? shapeOf(matrix.schema) : null;
    const fields = shape ? Object.keys(shape) : (matrix.fields ?? []);
    const results = await fuzzFields({
      label: matrix.label,
      request: matrix.request,
      schema: matrix.schema ?? { shape: Object.fromEntries(fields.map((f) => [f, true])) },
      valid: matrix.valid,
    });
    checkAll(`${matrix.label} — ${fields.length} fields survive hostile input`, results);
  }

  /* Query strings are input too. */
  section('Query parameters');

  const queryResults = [];
  for (const url of [
    '/events?page=0',
    '/events?page=-5',
    '/events?page=99999999',
    '/events?pageSize=0',
    '/events?pageSize=-1',
    '/events?pageSize=100000',
    '/events?page=abc&pageSize=abc',
    '/events?page=1.5',
    `/events?q=${encodeURIComponent(SQL)}`,
    `/events?q=${encodeURIComponent(XSS)}`,
    `/events?q=${encodeURIComponent(LONG)}`,
    `/events?q=${encodeURIComponent(UNICODE)}`,
    '/events?lifecycle=nonsense',
    '/events?categoryId=not-a-uuid',
    '/events?organizerId=not-a-uuid',
    '/members?status=nonsense',
    '/members?page=1&pageSize=999999',
    '/registrations?attendance=nonsense',
    '/payments?status=nonsense&purpose=nonsense',
    '/payments?from=not-a-date&to=also-not',
    '/payments?from=2026-13-45',
    '/subscriptions?status=nonsense',
    '/subscriptions?memberId=not-a-uuid',
    '/events?' + 'a=1&'.repeat(500),
  ]) {
    const res = await admin.client.get(url);
    record(res, queryResults);
  }
  checkAll('hostile query strings are handled, not crashed on', queryResults);

  /* ================================================ 4. the business rules = */

  section('Business rules');

  /* -- pagination is honest -- */
  const paged = await admin.client.get('/events?page=1&pageSize=3');
  check('a page returns no more rows than it promises',
    paged.body.data.length <= 3 && paged.body.meta.pageSize === 3, paged.body?.meta);

  const beyond = await admin.client.get('/events?page=9999&pageSize=10');
  check('a page beyond the end is empty rather than an error',
    beyond.status === 200 && beyond.body.data.length === 0, describe(beyond));

  /* -- an unpublished event is not public -- */
  const draftEvent = await admin.client.post('/events', {
    ...validEvent,
    title: `Hidden draft ${Date.now()}`,
    lifecycle: 'draft',
  });
  check('a draft event can be created', draftEvent.status === 201, draftEvent.body);

  const publicBoot = await anon.get('/bootstrap');
  check('a draft event is absent from the anonymous payload',
    !publicBoot.body.data.events.some((e) => e.id === draftEvent.body.data.id),
    draftEvent.body?.data?.id);

  const draftBySlug = await anon.get(`/events/${draftEvent.body.data.slug}`);
  check('a draft event cannot be fetched by slug anonymously',
    [403, 404].includes(draftBySlug.status), describe(draftBySlug));

  /* -- a free event cannot carry a price -- */
  const pricedFree = await admin.client.post('/events', {
    ...validEvent,
    title: `Free but priced ${Date.now()}`,
    type: 'free',
    memberPrice: 500,
    nonMemberPrice: 900,
  });
  check('a free event cannot be given a price', pricedFree.status === 422, describe(pricedFree));

  /* -- capacity is a hard limit -- */
  const oneSeat = await admin.client.post('/events', {
    ...validEvent,
    title: `Exactly one seat ${Date.now()}`,
    capacity: 1,
    lifecycle: 'published',
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  check('a one-seat event can be created', oneSeat.status === 201, describe(oneSeat));
  const seatId = oneSeat.body?.data?.id;
  const members = data.members.filter((m) => m.status === 'active').slice(0, 3);

  if (seatId && members.length >= 3) {
    const firstSeat = await admin.client.post('/registrations', {
      eventId: seatId, memberId: members[0].id,
    });
    check('the only seat can be taken', firstSeat.status === 201, describe(firstSeat));

    const secondSeat = await admin.client.post('/registrations', {
      eventId: seatId, memberId: members[1].id,
    });
    check('the second person is refused, not seated', secondSeat.status === 409, describe(secondSeat));

    const sameAgain = await admin.client.post('/registrations', {
      eventId: seatId, memberId: members[0].id,
    });
    check('booking twice does not produce a second seat',
      [200, 201, 409].includes(sameAgain.status) &&
      (sameAgain.body?.data?.registration?.id === firstSeat.body?.data?.registration?.id ||
        sameAgain.status === 409),
      describe(sameAgain));

    const seatCount = await db.queryOne(
      `SELECT COUNT(*)::int AS n FROM registrations WHERE event_id = $1 AND status <> 'cancelled'`,
      [seatId],
    );
    check('the database holds exactly one live seat for a one-seat event',
      seatCount.n === 1, seatCount);

    /* -- cancelling releases the seat -- */
    const heldId = firstSeat.body?.data?.registration?.id;
    if (heldId) {
      const released = await admin.client.patch(`/registrations/${heldId}/cancel`, { reason: 'Testing' });
      check('a seat can be released', released.status === 200, describe(released));

      const rebooked = await admin.client.post('/registrations', {
        eventId: seatId, memberId: members[1].id,
      });
      check('the released seat becomes available again', rebooked.status === 201, describe(rebooked));
    }

    /* -- a cancelled event takes no bookings -- */
    const cancelled = await admin.client.patch(`/events/${seatId}/lifecycle`, {
      lifecycle: 'cancelled', reason: 'Testing the rule',
    });
    check('an event can be cancelled with a reason', cancelled.status === 200, describe(cancelled));

    const afterCancel = await admin.client.post('/registrations', {
      eventId: seatId, memberId: members[2].id,
    });
    check('a cancelled event refuses new bookings', afterCancel.status === 409, describe(afterCancel));
  }

  const cancelNoReason = await admin.client.patch(`/events/${anEvent.id}/lifecycle`, {
    lifecycle: 'cancelled',
  });
  check('cancelling without a reason is refused', cancelNoReason.status === 422, describe(cancelNoReason));

  /* -- settlement is idempotent and cannot be replayed backwards -- */
  const payFor = await admin.client.post('/registrations', {
    eventId: anEvent.id, memberId: members[2].id, method: 'card',
  });
  if (payFor.status === 201 && payFor.body.data.payment) {
    const payId = payFor.body.data.payment.id;
    const settled = await admin.client.post(`/payments/${payId}/settle`, { outcome: 'successful' });
    check('a payment settles', settled.status === 200, describe(settled));

    const replay = await admin.client.post(`/payments/${payId}/settle`, { outcome: 'successful' });
    check('settling the same payment twice changes nothing',
      replay.status === 200 && replay.body.data.receiptNo === settled.body.data.receiptNo,
      { first: settled.body?.data?.receiptNo, second: replay.body?.data?.receiptNo });

    const reverse = await admin.client.post(`/payments/${payId}/settle`, { outcome: 'failed' });
    check('a settled payment cannot then be marked failed',
      reverse.status === 409 || reverse.body?.data?.status === 'successful', describe(reverse));

    const receipt = await admin.client.get(`/payments/${payId}/receipt`);
    check('a receipt is available once paid', receipt.status === 200, describe(receipt));
  }

  /* ============================== paying outside the system (QR / SBI) ==== */

  section('Payments made outside the system');

  const qrEvent = await admin.client.post('/events', {
    ...validEvent,
    title: `Paid by QR ${Date.now()}`,
    type: 'paid',
    memberPrice: 300,
    nonMemberPrice: 500,
    capacity: 10,
    lifecycle: 'published',
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  check('a paid event for offline payment can be created', qrEvent.status === 201, describe(qrEvent));

  const booking = await member.client.post('/registrations', {
    eventId: qrEvent.body?.data?.id,
    method: 'qr_upi',
  });
  check('a member can book a seat to pay by QR', booking.status === 201, describe(booking));

  const offlinePaymentId = booking.body?.data?.payment?.id;
  const bookedSeatId = booking.body?.data?.registration?.id;

  if (offlinePaymentId) {
    check('the seat is held, not confirmed, before any money is claimed',
      booking.body.data.registration.status === 'pending_payment',
      booking.body?.data?.registration?.status);

    /* What the payer is shown before paying: which QR, how much, and the
       reference to quote. */
    const inst = await member.client.get(`/payments/${offlinePaymentId}/instructions`);
    check('a payer is told which QR to pay and how much',
      inst.status === 200 && inst.body.data.amount > 0 && Boolean(inst.body.data.reference),
      { status: inst.status, amount: inst.body?.data?.amount, source: inst.body?.data?.qrSource });
    check('an event with no QR of its own falls back to the Trust QR',
      inst.body?.data?.qrSource === 'trust', inst.body?.data?.qrSource);
    check('PAN is asked for but never insisted on',
      inst.body?.data?.panRequested === true && inst.body?.data?.panOptional === true,
      inst.body?.data);

    const strangersInstructions = await organizer.client.get(
      `/payments/${offlinePaymentId}/instructions`);
    check('staff can read the instructions too', strangersInstructions.status === 200,
      describe(strangersInstructions));

    /* The whole point: a payer cannot confirm their own payment. */
    const selfSettle = await member.client.post(`/payments/${offlinePaymentId}/settle`, {
      outcome: 'successful',
    });
    check('a member cannot settle their own offline payment',
      selfSettle.status === 403 && selfSettle.body?.code === 'REQUIRES_VERIFICATION',
      describe(selfSettle));

    const adminShortcut = await admin.client.post(`/payments/${offlinePaymentId}/settle`, {
      outcome: 'successful',
    });
    check('not even an administrator can shortcut the settle route for an offline payment',
      adminShortcut.status === 403, describe(adminShortcut));

    const selfVerify = await member.client.post(`/payments/${offlinePaymentId}/verify`, {
      approved: true,
    });
    check('a member cannot verify their own payment', selfVerify.status === 403, describe(selfVerify));

    /* The event above belongs to `organizer`, so they may rule on its money —
       and only its money. A facilitator confirming another facilitator's
       event, or any membership income, is refused. */
    const strangerEvent = await admin.client.post('/events', {
      ...validEvent,
      title: `Someone else's event ${Date.now()}`,
      type: 'paid',
      memberPrice: 100,
      nonMemberPrice: 100,
      lifecycle: 'published',
      organizerId: admin.user.id,
      registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const strangerBooking = await admin.client.post('/registrations', {
      eventId: strangerEvent.body?.data?.id, memberId: members[2].id, method: 'qr_upi',
    });
    if (strangerBooking.status === 201 && strangerBooking.body.data.payment) {
      const strangerPaymentId = strangerBooking.body.data.payment.id;
      await admin.client.post(`/payments/${strangerPaymentId}/claim`, {
        reference: `OTHER${Date.now()}`,
      });
      const poach = await organizer.client.post(`/payments/${strangerPaymentId}/verify`, {
        approved: true,
      });
      check('a facilitator cannot verify money for an event that is not theirs',
        poach.status === 403, describe(poach));

      const strangerQueue = await organizer.client.get('/payments/awaiting-verification');
      check('nor does that claim appear in their queue',
        strangerQueue.status === 200 &&
        !strangerQueue.body.data.some((p) => p.id === strangerPaymentId),
        { count: strangerQueue.body?.data?.length });
    }

    /* Claiming */
    const shortRef = await member.client.post(`/payments/${offlinePaymentId}/claim`, { reference: 'abc' });
    check('a reference too short to be real is refused', shortRef.status === 422, describe(shortRef));

    const utr = `UTR${Date.now()}`;
    const badPan = await member.client.post(`/payments/${offlinePaymentId}/claim`, {
      reference: `PANTEST${Date.now()}`,
      pan: 'NOTAPAN',
    });
    check('a PAN that is not shaped like one is refused', badPan.status === 422, describe(badPan));

    const claimed = await member.client.post(`/payments/${offlinePaymentId}/claim`, {
      reference: utr,
      note: 'Paid by UPI',
      pan: 'ABCDE1234F',
      proofUrl: 'https://example.org/proof.png',
    });
    check('a payer can claim they have paid, quoting the reference',
      claimed.status === 200 && claimed.body.data.status === 'awaiting_verification',
      describe(claimed));

    check('claiming does not confirm the seat', await (async () => {
      const row = await db.queryOne(`SELECT status FROM registrations WHERE id = $1`, [bookedSeatId]);
      return row.status === 'pending_payment';
    })(), 'the seat should still only be held');

    check('claiming issues no receipt',
      !claimed.body.data.receiptNo, claimed.body?.data?.receiptNo);
    check('the proof and the optional PAN are kept with the claim',
      claimed.body.data.claimProofUrl === 'https://example.org/proof.png' &&
      claimed.body.data.payerPan === 'ABCDE1234F',
      { proof: claimed.body?.data?.claimProofUrl, pan: claimed.body?.data?.payerPan });

    /* The reference is the thing that must not be reusable. */
    const secondBooking = await admin.client.post('/registrations', {
      eventId: qrEvent.body.data.id, memberId: aMember.id, method: 'qr_upi',
    });
    if (secondBooking.status === 201 && secondBooking.body.data.payment) {
      const reused = await admin.client.post(
        `/payments/${secondBooking.body.data.payment.id}/claim`, { reference: utr });
      check('the same bank reference cannot be claimed twice',
        reused.status === 409 && reused.body.code === 'REFERENCE_ALREADY_CLAIMED',
        describe(reused));

      const caseVariant = await admin.client.post(
        `/payments/${secondBooking.body.data.payment.id}/claim`,
        { reference: utr.toLowerCase() });
      check('nor the same reference in different case or spacing',
        caseVariant.status === 409, describe(caseVariant));
    }

    /* The queue, and the decision */
    const queue = await admin.client.get('/payments/awaiting-verification');
    check('the claim appears in the administrator queue',
      queue.status === 200 && queue.body.data.some((p) => p.id === offlinePaymentId),
      { status: queue.status, count: queue.body?.data?.length });

    const memberQueue = await member.client.get('/payments/awaiting-verification');
    check('a member cannot read the verification queue', memberQueue.status === 403, describe(memberQueue));

    const ownQueue = await organizer.client.get('/payments/awaiting-verification');
    check('the facilitator running the event sees the claim in their own queue',
      ownQueue.status === 200 && ownQueue.body.data.some((p) => p.id === offlinePaymentId),
      { status: ownQueue.status, count: ownQueue.body?.data?.length });

    const noReason = await admin.client.post(`/payments/${offlinePaymentId}/verify`, { approved: false });
    check('rejecting without a reason is refused', noReason.status === 422, describe(noReason));

    const approved = await organizer.client.post(`/payments/${offlinePaymentId}/verify`, {
      approved: true,
    });
    check('the facilitator running the event can verify its payment',
      approved.status === 200, describe(approved));
    check('verifying issues a receipt', Boolean(approved.body?.data?.receiptNo), approved.body?.data);

    const seatAfter = await db.queryOne(`SELECT status FROM registrations WHERE id = $1`, [bookedSeatId]);
    check('the seat is confirmed only once the payment is verified',
      seatAfter.status === 'confirmed', seatAfter);

    const audit = await db.queryOne(
      `SELECT verified_by, verified_at, claim_reference FROM payments WHERE id = $1`,
      [offlinePaymentId],
    );
    check('who verified it and when is recorded against the payment',
      Boolean(audit.verified_by) && Boolean(audit.verified_at) && Boolean(audit.claim_reference), audit);

    const reVerify = await admin.client.post(`/payments/${offlinePaymentId}/verify`, { approved: true });
    check('verifying an already verified payment changes nothing',
      reVerify.status === 200, describe(reVerify));
  }

  /* Rejection releases the seat. */
  const doomed = await admin.client.post('/registrations', {
    eventId: qrEvent.body?.data?.id, memberId: members[1]?.id, method: 'qr_upi',
  });
  if (doomed.status === 201 && doomed.body.data.payment) {
    const doomedPayment = doomed.body.data.payment.id;
    await admin.client.post(`/payments/${doomedPayment}/claim`, { reference: `REJ${Date.now()}` });
    const rejected = await admin.client.post(`/payments/${doomedPayment}/verify`, {
      approved: false,
      reason: 'No matching credit on the statement',
    });
    check('a claim can be rejected with a reason', rejected.status === 200, describe(rejected));

    const releasedSeat = await db.queryOne(
      `SELECT status FROM registrations WHERE id = $1`, [doomed.body.data.registration.id]);
    check('rejecting a claim releases the seat', releasedSeat.status === 'cancelled', releasedSeat);
  }

  /* The facilitator's choice of QR. */
  const ownQrEvent = await organizer.client.post('/events', {
    ...validEvent,
    title: `Collected on my own QR ${Date.now()}`,
    type: 'paid',
    memberPrice: 150,
    nonMemberPrice: 150,
    lifecycle: 'published',
    organizerId: organizer.user.id,
    paymentQrMode: 'own',
    paymentQrUrl: 'https://example.org/facilitator-qr.png',
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  check('a facilitator can choose to collect on their own QR',
    ownQrEvent.status === 201 && ownQrEvent.body.data.paymentQrMode === 'own',
    describe(ownQrEvent));

  const noQr = await organizer.client.post('/events', {
    ...validEvent,
    title: `Own QR but none given ${Date.now()}`,
    type: 'paid',
    memberPrice: 150,
    nonMemberPrice: 150,
    organizerId: organizer.user.id,
    paymentQrMode: 'own',
  });
  check('choosing your own QR without supplying one is refused',
    noQr.status === 422, describe(noQr));

  if (ownQrEvent.status === 201) {
    const ownBooking = await admin.client.post('/registrations', {
      eventId: ownQrEvent.body.data.id, memberId: members[2].id, method: 'qr_upi',
    });
    if (ownBooking.status === 201 && ownBooking.body.data.payment) {
      const ownInst = await admin.client.get(
        `/payments/${ownBooking.body.data.payment.id}/instructions`);
      check("that event's payer is shown the facilitator's QR, not the Trust's",
        ownInst.body?.data?.qrSource === 'event' &&
        ownInst.body?.data?.qrUrl === 'https://example.org/facilitator-qr.png',
        ownInst.body?.data);
    }
  }

  /* Membership money is never a facilitator's. */
  const memberSub = await admin.client.post('/subscriptions', {
    planId: aPlan.id, memberId: members[2].id, method: 'qr_upi',
  });
  if (memberSub.status === 201) {
    const subInst = await admin.client.get(
      `/payments/${memberSub.body.data.payment.id}/instructions`);
    check('a membership is always collected on the Trust QR',
      subInst.body?.data?.qrSource === 'trust', subInst.body?.data?.qrSource);

    await admin.client.post(`/payments/${memberSub.body.data.payment.id}/claim`, {
      reference: `SUB${Date.now()}`,
    });
    const facilitatorTriesMembership = await organizer.client.post(
      `/payments/${memberSub.body.data.payment.id}/verify`, { approved: true });
    check('a facilitator cannot verify membership income',
      facilitatorTriesMembership.status === 403, describe(facilitatorTriesMembership));
  }

  /* An unfinished purchase must never become a dead end: the member closed the
     payment window, and the next attempt has to go somewhere. */
  const stuckMember = members[0];
  const firstTry = await admin.client.post('/subscriptions', {
    planId: aPlan.id, memberId: stuckMember.id, method: 'qr_upi',
  });
  if (firstTry.status === 201) {
    const resumed = await admin.client.post('/subscriptions', {
      planId: aPlan.id, memberId: stuckMember.id, method: 'qr_upi',
    });
    check('choosing the same plan again resumes the purchase instead of refusing',
      resumed.status === 201 &&
      resumed.body.data.payment.id === firstTry.body.data.payment.id,
      describe(resumed));

    const otherPlan = data.plans.find((p) => p.active && p.id !== aPlan.id);
    if (otherPlan) {
      const switched = await admin.client.post('/subscriptions', {
        planId: otherPlan.id, memberId: stuckMember.id, method: 'qr_upi',
      });
      check('choosing a different plan supersedes the unfinished one',
        switched.status === 201 &&
        switched.body.data.payment.id !== firstTry.body.data.payment.id,
        describe(switched));

      const supersededPayment = await db.queryOne(
        `SELECT status FROM payments WHERE id = $1`, [firstTry.body.data.payment.id]);
      check('the unfinished payment is stood down, not left pending for ever',
        supersededPayment.status === 'cancelled', supersededPayment);

      /* Once money is claimed against it, it is real and cannot be brushed
         aside by picking another plan. */
      await admin.client.post(`/payments/${switched.body.data.payment.id}/claim`, {
        reference: `STUCK${Date.now()}`,
      });
      const blocked = await admin.client.post('/subscriptions', {
        planId: aPlan.id, memberId: stuckMember.id, method: 'qr_upi',
      });
      check('a claimed payment blocks a new purchase, and says why',
        blocked.status === 409 && blocked.body.code === 'PURCHASE_AWAITING_VERIFICATION',
        describe(blocked));
    }
  }

  /* -- one member cannot read another's things -- */
  const otherMember =
    data.members.find((m) => m.id !== member.user?.memberId && m.status === 'active') ?? aMember;
  const peekResults = [];
  for (const url of [
    `/members/${otherMember.id}`,
    `/payments?memberId=${otherMember.id}`,
    `/subscriptions?memberId=${otherMember.id}`,
  ]) {
    const res = await member.client.get(url);
    record(res, peekResults);
    const leaked =
      res.status === 200 &&
      (res.body?.data?.email || res.body?.data?.some?.((row) => row.memberId === otherMember.id));
    peekResults.push(leaked ? { ok: false, why: 'leaked another member', url } : { ok: true });
  }
  checkAll('a member cannot read another member through any route', peekResults);

  /* -- plan prices cannot go negative -- */
  const negativePlan = await admin.client.post('/plans', {
    name: `Negative ${Date.now()}`, price: -100, durationMonths: 12, benefits: [],
  });
  check('a plan cannot have a negative price', negativePlan.status === 422, describe(negativePlan));

  const zeroDuration = await admin.client.post('/plans', {
    name: `Zero months ${Date.now()}`, price: 100, durationMonths: 0, benefits: [],
  });
  check('a plan cannot run for zero months', zeroDuration.status === 422, describe(zeroDuration));

  /* -- duplicate email is refused, not crashed on -- */
  const dupe = await anon.post('/auth/register', {
    name: 'Duplicate Person',
    email: 'divya.bharathi@gmail.com',
    phone: '9000000000',
    password: 'Str0ng!Pass',
  });
  check('registering an address already in use is refused cleanly',
    dupe.status === 409 || dupe.status === 422, describe(dupe));

  /* -- a weak password is refused -- */
  /* Each of these breaks one stated rule: length, a capital, a digit, a
     symbol. `ALLUPPERCASE1!` is deliberately absent — the policy asks for a
     capital, a digit and a symbol but never for a lower-case letter, so that
     password is legal and asserting otherwise would test a rule that does not
     exist. Worth a conversation, not a failing test. */
  const weakResults = [];
  for (const password of ['short', 'nocapitals1!', 'NoNumbers!!', 'NoSymbol123', 'Aa1!', '']) {
    const res = await anon.post('/auth/register', {
      name: 'Weak Password', email: `weak.${Date.now()}.${Math.random()}@example.org`,
      phone: '9000000000', password,
    });
    record(res, weakResults);
    weakResults.push(res.status === 422 ? { ok: true } : { ok: false, password, ...describe(res) });
  }
  checkAll('every weak password is refused', weakResults);

  /* -- the body size limit holds -- */
  const huge = await admin.client.post('/events', { ...validEvent, description: 'y'.repeat(3_000_000) });
  check('an oversized body is refused rather than swallowed',
    huge.status >= 400 && huge.status < 500, describe(huge));

  /* -- content type is enforced -- */
  const wrongType = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'http://localhost:5173' },
    body: 'email=x&password=y',
  });
  check('a non-JSON body does not crash the JSON endpoint',
    wrongType.status < 500, { status: wrongType.status });

  const brokenJson = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: '{"email": "unterminated',
  });
  check('malformed JSON is answered with 4xx, not 500',
    brokenJson.status >= 400 && brokenJson.status < 500, { status: brokenJson.status });

  /* -- health endpoints -- */
  const health = await anon.get('/health', { absolute: true });
  check('the health endpoint answers', health.status === 200, describe(health));
  const dbHealth = await anon.get('/health/db', { absolute: true });
  check('the database health endpoint answers', dbHealth.status === 200, describe(dbHealth));

  /* ======================================== 4a. stored image addresses ==== */

  /* An image URL used to be written into the database with whatever origin the
     uploading machine happened to have, so a QR uploaded from a laptop was
     stored as `http://localhost:5000/...` and was a broken image — and a
     mixed-content refusal — everywhere else for ever. What is stored now is a
     path, resolved per request. These pin that down. */

  section('Stored image addresses');

  const { toEvent: serializeEvent } = await import('../src/serializers/index.js');
  const resolved = (stored) => serializeEvent({ id: 'e', payment_qr_url: stored }).paymentQrUrl;

  const addressCases = [
    ['a dead localhost row is rewritten to this server',
      'http://localhost:5000/uploads/qr/abc.png', `${env.serverUrl}/uploads/qr/abc.png`],
    ['so is one naming a loopback address',
      'http://127.0.0.1:5000/uploads/qr/abc.png', `${env.serverUrl}/uploads/qr/abc.png`],
    ['a path written by local storage is made absolute',
      'uploads/qr/abc.png', `${env.serverUrl}/uploads/qr/abc.png`],
    ['a real remote URL is left exactly alone',
      'https://example.supabase.co/storage/v1/object/public/b/payment-qr/x.png',
      'https://example.supabase.co/storage/v1/object/public/b/payment-qr/x.png'],
    ['no image stays no image', null, undefined],
  ];

  checkAll('a stored image resolves to an address that works from anywhere',
    addressCases.map(([why, stored, want]) => {
      const got = resolved(stored);
      return got === want ? { ok: true } : { ok: false, why, stored, want, got };
    }));

  check('nothing served to a client points at a developer machine',
    !addressCases.some(([, stored]) => {
      const got = resolved(stored);
      return typeof got === 'string' && /localhost|127\.0\.0\.1/.test(got) &&
        !env.serverUrl.includes('localhost');
    }), env.serverUrl);

  /* ============================================ 4b. private images ======== */

  /* Member photographs and payment screenshots are not public. They are
     reached through `/media`, which decides who may see each one. These check
     the deciding, which is the part that has to be right — that the object is
     unguessable is a nice extra, not the protection. */

  section('Private images');

  /* Real objects in the real private bucket, so the checks below prove a link
     is actually issued rather than merely that the door was not slammed. They
     are removed again at the end of the run. Where storage is not configured
     — a laptop with no keys — a name of the right shape stands in, and the
     checks fall back to asserting the door rather than the link. */
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  const OBJECT = async (folder) => {
    if (!storage.isRemote()) {
      return `${folder}/${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}.png`;
    }
    const stored = await storage.store(
      { buffer: png, mimetype: 'image/png', size: png.length },
      folder,
    );
    temporaryObjects.push(stored);
    return stored;
  };

  /* With a real object behind it an entitled caller gets a link; without one,
     the most that can be said is that they were not turned away. */
  const opened = (res) =>
    storage.isRemote()
      ? res.status === 200 && typeof res.body?.data?.url === 'string'
      : ![401, 403, 404].includes(res.status);

  /* What the API actually hands out — built from the same setting the
     serializer uses, so a mismatch here would be a real mismatch. */
  const mediaLink = (objectPath) => `${env.serverUrl}${env.apiPrefix}/media/${objectPath}`;
  const asJson = { headers: { Accept: 'application/json' } };

  /* An account with no membership and no business with any of this. Signing in
     needs a confirmed address, so the confirmation is done here too. */
  const strangerEmail = `stranger.${Date.now()}@example.org`;
  const registered = await anon.post('/auth/register', {
    name: 'Passing Stranger', email: strangerEmail, phone: '9000000123', password: 'Str0ng!Pass',
  });
  const token = new URL(registered.body?.data?.verificationLink ?? 'http://x/?token=')
    .searchParams.get('token');
  if (token) await anon.post('/auth/verify-email', { token, email: strangerEmail });
  const stranger = await signIn(strangerEmail, 'Str0ng!Pass');
  check('a bystander account can be created to test against',
    Boolean(stranger.user), { register: registered.status, verified: Boolean(token) });

  /* ---- a payment screenshot ---- */

  /* Deliberately an event of the administrator's, so `organizer` is a
     stranger to it and the ownership rule is actually exercised. */
  const proofEvent = await admin.client.post('/events', {
    ...validEvent,
    title: `Proof of payment ${Date.now()}`,
    type: 'paid',
    memberPrice: 150,
    nonMemberPrice: 150,
    capacity: 5,
    lifecycle: 'published',
    organizerId: admin.user.id,
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  const proofBooking = await member.client.post('/registrations', {
    eventId: proofEvent.body?.data?.id, method: 'qr_upi',
  });

  if (proofBooking.status === 201 && proofBooking.body?.data?.payment) {
    const proofPath = await OBJECT('payment-proofs');
    const proofClaim = await member.client.post(
      `/payments/${proofBooking.body.data.payment.id}/claim`,
      { reference: `PROOF${Date.now()}`, proofUrl: mediaLink(proofPath) },
    );

    check('a screenshot is stored as a link that has to be asked for, not a public address',
      proofClaim.status === 200 && proofClaim.body?.data?.claimProofUrl === mediaLink(proofPath),
      { status: proofClaim.status, url: proofClaim.body?.data?.claimProofUrl });

    const route = `/media/${proofPath}`;

    const bySelf = await member.client.get(route, asJson);
    check('the payer can open their own screenshot', opened(bySelf), describe(bySelf));

    const byAdmin = await admin.client.get(route, asJson);
    check('an administrator can open it, because they are the one confirming it',
      opened(byAdmin), describe(byAdmin));

    if (storage.isRemote() && bySelf.body?.data?.url) {
      const expiry = Number(bySelf.body.data.expiresIn);
      check('the link expires, rather than lasting for ever',
        expiry > 0 && expiry <= 3600, expiry);

      const fetched = await fetch(bySelf.body.data.url);
      check('the link serves the image while it is good',
        fetched.ok && (fetched.headers.get('content-type') ?? '').startsWith('image/'),
        { status: fetched.status, type: fetched.headers.get('content-type') });

      const unsigned = bySelf.body.data.url.split('?')[0];
      const stripped = await fetch(unsigned);
      check('the same address without the signature serves nothing',
        !stripped.ok, { status: stripped.status });
    }

    const byOtherStaff = await organizer.client.get(route, asJson);
    check('a facilitator cannot open a screenshot for an event that is not theirs',
      byOtherStaff.status === 404, describe(byOtherStaff));

    const byStranger = await stranger.client.get(route, asJson);
    check('another member cannot open it at all', byStranger.status === 404, describe(byStranger));

    const byNobody = await anon.get(route, asJson);
    check('signed out, it is not served', byNobody.status === 401, describe(byNobody));
  }

  /* ---- a member photograph ---- */

  const myMemberId = member.user?.memberId;
  if (myMemberId) {
    const photoPath = await OBJECT('member-photos');
    const setPhoto = await member.client.patch(`/members/${myMemberId}`, {
      photoUrl: mediaLink(photoPath),
    });
    check('a photograph is kept as a private object, not a public URL',
      setPhoto.status === 200 && setPhoto.body?.data?.photoUrl === mediaLink(photoPath),
      { status: setPhoto.status, url: setPhoto.body?.data?.photoUrl });

    const route = `/media/${photoPath}`;

    const own = await member.client.get(route, asJson);
    check('a member can see their own photograph', opened(own), describe(own));

    const staff = await organizer.client.get(route, asJson);
    check('staff can see it, because they check people in', opened(staff), describe(staff));

    const nosy = await stranger.client.get(route, asJson);
    check('another member cannot browse the register for faces',
      nosy.status === 404, describe(nosy));
  }

  /* ---- nothing else is reachable through this door ---- */

  const mediaProbes = [];
  for (const [why, path] of [
    ['a public folder is not exposed through the private route', `event-covers/${crypto.randomBytes(12).toString('hex')}.png`],
    ['an unknown folder is refused', `secrets/${crypto.randomBytes(12).toString('hex')}.png`],
    ['an object nobody owns is refused', `payment-proofs/${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}.png`],
    ['a name of the wrong shape is refused', 'payment-proofs/anything.png'],
    ['a name with an extension we never write is refused', `payment-proofs/${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}.svg`],
  ]) {
    const res = await admin.client.get(`/media/${path}`, asJson);
    record(res, mediaProbes);
    mediaProbes.push(res.status === 404 ? { ok: true } : { ok: false, why, status: res.status });
  }
  checkAll('the media route opens nothing it should not', mediaProbes);

  /* Traversal is answered by the route matcher, not by the guard, so it is
     worth confirming it never reaches the guard at all. */
  const traversal = await admin.client.get('/media/payment-proofs/..%2F..%2Fetc%2Fpasswd', asJson);
  check('a traversal-shaped object name resolves to nothing',
    traversal.status === 404, describe(traversal));

  /* ================================================== 5. no stray 500s ==== */

  section('Summary sweep');

  check('no request in this run produced a 5xx',
    failures.every((f) => !JSON.stringify(f.context ?? '').includes('"why":"5xx"')),
    failures.filter((f) => JSON.stringify(f.context ?? '').includes('5xx')).slice(0, 3));
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
