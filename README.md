# Aarambam — API

The REST API behind the Aarambam event and membership application.

Its job is to implement, exactly, the contract the front end declares in
`arambham-frontend/src/types/index.ts`. Field names, casing and enum members
are the interface's, not the database's — a mapper at the edge translates, and
nothing above it has to know that `venue_name` and `venueName` are the same
thing.

## Running it

```bash
npm install
npm run db:seed     # creates the schema and the demonstration community
npm start           # http://localhost:5000
```

No database server, no mail server and no payment account are needed. The
defaults use an embedded PostgreSQL 16 (PGlite, persisted to `.data/`), write
emails to the log, and run payments through a simulated gateway that produces
real rows, real receipts and real state changes — it simply does not talk to a
bank.

Sign in with any seeded account, password `Aarambam@2026`:

| Role | Email |
|---|---|
| Administrator | `revathi@aarambam.org` |
| Organizer | `aravind@aarambam.org` · `senthil@aarambam.org` |
| Member | `divya.bharathi@gmail.com` (ARM-1042) |

The sign-in screen's three one-click buttons use the same accounts through
`POST /auth/demo-login`.

## Going to production

Set these and nothing else changes:

```bash
DATABASE_URL=postgresql://…      # switches to the `postgres` driver
JWT_ACCESS_SECRET=…              # the API refuses to start with the defaults
JWT_REFRESH_SECRET=…
NODE_ENV=production
CORS_ORIGINS=https://aarambam.org
CLIENT_URL=https://aarambam.org
SMTP_HOST=…                      # emails start being sent rather than logged
PAYMENT_PROVIDER=razorpay        # settlements now require a verified signature
RAZORPAY_KEY_ID=… RAZORPAY_KEY_SECRET=… RAZORPAY_WEBHOOK_SECRET=…
DEMO_LOGIN_ENABLED=false
COOKIE_SAME_SITE=none            # if the SPA is on a different site
```

The schema and every query are identical on both engines. `.env.example`
documents the rest.

## Scripts

| | |
|---|---|
| `npm start` | Run the API |
| `npm run dev` | Run it with reload |
| `npm run db:migrate` | Apply the schema (`-- --reset` drops first) |
| `npm run db:seed` | Reset, migrate and seed |
| `npm run verify` | 124 end-to-end checks against a scratch database |

`npm run verify` boots the API for real and drives every flow the interface
performs — all three roles, the snapshot each receives, booking and paying,
membership purchase, check-in, the administrative screens, and the
authorisation boundaries between them. It also asserts the things that are easy
to get quietly wrong: that two people racing for the last seat produce exactly
one winner, that a settlement replayed twice does not issue two receipts, that
a member cannot read another member, and that a SQL-shaped search term is
treated as text.

## Layout

```
src/
  config/       env, and the vocabulary shared with the front end
  database/     driver abstraction (postgres | pglite), schema, migration, seed
  middleware/   auth, validation, rate limits, uploads, the error funnel
  modules/      one directory per resource: routes, validation, service
  serializers/  row → the exact shape the front end declares
  services/     email, notifications, activity log, payment gateway
  jobs/         seat-hold sweep, lapses, reminders, token purge
  utils/        errors, responses, tokens, passwords, code generation
```

Four ideas carry most of the weight:

**One snapshot.** The interface derives everything it shows — seat counts,
event status, revenue splits, the twelve-month chart — from whole collections
held in one client-side store. `GET /bootstrap` is that store, assembled
server-side and cut to what the caller may know. Rows a caller may count but
not read come back as *counters*: an id, a status, a date, and blanks in every
field that identifies a person.

**Derived status.** The only status stored on an event is the administrator's
`lifecycle`. Whether registration is open, closed, nearly full or sold out is
computed from the clock and the live seat count every time it is asked for.

**One place money moves.** A seat becomes confirmed and a membership becomes
active in exactly one function, in one transaction with the payment row, only
after the gateway result has been verified server-side.

**Refusals are constraints, not conventions.** A minor without a guardian, a
second live booking on one event, a successful payment without a receipt, a
free event with a price — each is a `CHECK` or a partial unique index, so the
database refuses them even if a code path forgets to.

## Security

JWT access tokens (30 minutes) with rotating refresh tokens stored as SHA-256
digests in an httpOnly cookie; re-presenting a spent token revokes the whole
family. bcrypt passwords. Role checks re-read the live account on every
request, so a deactivation takes effect at once rather than when a token
expires. Zod at every edge, with unknown keys stripped before anything reaches
an `UPDATE`. Parameterised SQL throughout — no string interpolation anywhere.
Helmet, CORS on an explicit origin list, and rate limits keyed on IP *and* the
address being tried on the credential endpoints.
