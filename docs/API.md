# Aarambam API

Base URL: `http://localhost:5000/api/v1`

The front end is the contract. Every payload below is exactly a type declared
in `arambham-frontend/src/types/index.ts` — same field names, same casing, same
value vocabulary. If a field is not in that file, the API does not send it.

---

## Conventions

**Envelope.** Every response is one of:

```jsonc
{ "success": true,  "message": "Success", "data": <T>, "meta": { … } }   // meta on lists only
{ "success": false, "message": "…", "code": "…", "errors": { "field": "…" } }
```

`code` is a stable machine-readable string (`EMAIL_NOT_VERIFIED`,
`ALREADY_REGISTERED`, `LAST_ADMINISTRATOR`, …). `errors` maps a field name to a
message and is what a form shows against its inputs.

**Status codes.** `200` read or update · `201` created · `204` deleted ·
`400` malformed · `401` not signed in or token expired · `403` signed in but
not permitted · `404` absent · `409` conflicts with existing state ·
`422` validation failed · `429` rate limited · `503` a dependency is down.

**Dates.** ISO-8601 with `Z` for instants. `Event.date`, `Subscription.startDate`
and `Subscription.endDate` are plain `yyyy-MM-dd` calendar dates and are never
shifted into a timezone — "Saturday 18:30" means that at the venue.

**Optional fields** are omitted, never sent as `null`.

**Money** is a number in rupees.

**Sessions.** The refresh token is an httpOnly cookie; the short-lived access
token comes back in the body and is sent as `Authorization: Bearer …`. Send
`credentials: 'include'` so the cookie travels. On `401` the client exchanges
the cookie at `POST /auth/refresh` and replays the request once.

**Client-supplied ids.** `POST /events`, `/members`, `/event-categories`,
`/plans`, `/registrations` and `/subscriptions` accept an optional `id` (and
`paymentId` where a payment is opened alongside). The interface needs a
record's id in the same tick it saves one, and supplying the id also makes a
retry after a dropped connection idempotent rather than duplicating. Ids are
opaque UUIDs; they grant nothing, and every read is authorised on its own.

**Pagination.** `?page=1&pageSize=20` → `meta: { page, pageSize, total, pageCount }`.

---

## Roles

`administrator` · `organizer` · `member` — exactly the front end's `Role` union.

| | administrator | organizer | member | anonymous |
|---|---|---|---|---|
| Events | all, edit any | own events | published only | published only |
| Members | all | participants on own events | self | counters only |
| Registrations | all | own events | own | counters only |
| Payments | all | own events' | own | — |
| Users & roles | yes | — | — | — |
| Settings | yes | — | — | organisation profile only |

"Counters" is the projection used for rows a caller may count but not read: an
id, a status and a date, blank in every field that identifies a person. It is
what lets the public site say "1,240 members" and "12 of 60 seats remain"
without exposing a single member or booking.

---

## `GET /bootstrap`

The whole application snapshot the interface renders from, cut to the caller's
role. This is the only read the front end needs to draw any screen.

```jsonc
{
  "users": [User],                    // self + staff; all users for an administrator
  "members": [Member],                // self in full; others as counters
  "subscriptions": [Subscription],    // own; all for an administrator
  "events": [Event],                  // published; + own drafts for staff
  "registrations": [Registration],    // own in full; others as counters
  "payments": [Payment],              // own; all for an administrator
  "notifications": [AppNotification], // own only, newest first, max 200
  "categories": [EventCategory],
  "plans": [MembershipPlan],
  "organisation": OrganisationSettings,
  "emailTemplates": [EmailTemplate],
  "demo": { "adminUserId", "organizerUserId", "secondOrganizerUserId",
            "memberUserId", "memberId" },
  "scope": "public" | "member" | "organizer" | "administrator",
  "serverTime": "2026-08-06T13:00:00.000Z"
}
```

Optional auth. `Cache-Control: private, no-store`.

---

## Authentication — `/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | — | Create an account, send the verification link |
| POST | `/auth/login` | — | Exchange credentials for a session |
| POST | `/auth/demo-login` | — | One-click role sign-in (`DEMO_LOGIN_ENABLED`) |
| POST | `/auth/refresh` | cookie | Rotate the session |
| POST | `/auth/logout` | — | Revoke this session |
| GET | `/auth/me` | yes | The signed-in identity |
| POST | `/auth/verify-email` | — | Confirm an address, or ask for a new link |
| POST | `/auth/resend-verification` | — | Send the link again |
| POST | `/auth/forgot-password` | — | Begin a password reset |
| POST | `/auth/reset-password` | — | Finish a password reset |
| POST | `/auth/change-password` | yes | Change it while signed in |
| POST | `/auth/change-email` | yes | Begin an email change |

**`POST /auth/login`** — `{ email, password }` →

```jsonc
{ "data": { "user": User, "member": Member | null,
            "session": { "userId", "role", "memberId"? },
            "accessToken": "…" } }
```

Sets the `refreshToken` cookie. A wrong password and an address with no account
give the same message and take the same time. `403 EMAIL_NOT_VERIFIED` when the
address is unconfirmed; `403 ACCOUNT_INACTIVE` when the account is deactivated.

**`POST /auth/forgot-password`** answers identically whether or not the address
exists. On a deployment where mail is preview-only and `NODE_ENV` is not
production it also returns `resetLink`, so the flow can be walked without a
mail server. Never in production.

Rate limits: sign-in and reset are keyed on IP *and* the address being tried,
so one noisy network cannot lock an account out and one attacker cannot spray
a password across many accounts.

---

## Events — `/events`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/events` | optional | Filtered, paged listing |
| GET | `/events/:idOrSlug` | optional | One event with its live seat count |
| POST | `/events` | staff | Create |
| PATCH | `/events/:id` | staff | Edit |
| PATCH | `/events/:id/lifecycle` | staff | Publish · cancel · complete |
| DELETE | `/events/:id` | admin | Remove one that has no registrations |

Filters: `q`, `categoryId`, `lifecycle`, `organizerId`, `from`, `to`, `page`, `pageSize`.

Only `lifecycle` (`draft` · `published` · `cancelled` · `completed`) is stored.
"Sold out", "few seats left" and "registration closed" are derived from the
clock and the live seat count on every read, so an administrator never has to
remember to flip a switch and two screens can never disagree.

`PATCH /events/:id/lifecycle` with `{ lifecycle: "cancelled", reason }` releases
every live seat, notifies everyone holding one, and emails them — all in one
transaction. The reason is required, because participants are told it.

Refused: shrinking `capacity` below the seats already sold (`422`); a
registration window that closes before it opens (`422`); a price on a free
event (`422`); deleting an event with registrations (`409`).

---

## Registrations — `/registrations`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/registrations` | yes | Scoped listing |
| GET | `/registrations/:id` | yes | One booking |
| POST | `/registrations` | yes | Take a seat |
| PATCH | `/registrations/:id/cancel` | yes | Release a seat |
| PATCH | `/registrations/:id/attendance` | staff | Mark present or absent |
| POST | `/registrations/check-in` | staff | Resolve a scanned QR or typed code |

**`POST /registrations`** — `{ eventId, method, memberId?, id?, paymentId? }` →
`{ registration: Registration, payment?: Payment }`.

A free event confirms immediately and no payment is created. A paid one holds
the seat at `pending_payment` and opens a `pending` payment; the seat is
released automatically after `PAYMENT_HOLD_MINUTES` if nothing settles.

Capacity is enforced under a row lock on the event, so two people clicking
Register on the last seat at the same moment produce one `201` and one `409` —
never two winners. Re-posting for a seat already held returns that same seat
and payment rather than a second one.

**`POST /registrations/check-in`** — `{ eventId, code }` → one of
`valid` · `already_checked_in` · `wrong_event` · `cancelled` · `invalid`,
matching the union the check-in screen renders. Accepts a ticket code or a
booking reference, with or without spacing and hyphens.

---

## Payments — `/payments`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/payments` | yes | Own history; everything for an administrator |
| GET | `/payments/:id` | yes | One transaction |
| GET | `/payments/:id/receipt` | yes | What a receipt is printed from |
| POST | `/payments/:id/settle` | yes | Apply the verified gateway outcome |
| POST | `/payments/webhook` | signature | The gateway's own account |

**`POST /payments/:id/settle`** — `{ outcome, gatewayPaymentId?, signature? }`.

This is the only place a seat becomes confirmed or a membership becomes active,
and it does both in one transaction with the payment row. With
`PAYMENT_PROVIDER=razorpay` a `successful` outcome is only believed once its
HMAC signature verifies — posting `{"outcome":"successful"}` on its own is
refused. With `simulated` the requested outcome is applied, which is what the
walkthrough build drives.

Idempotent: replaying a settlement returns the same row rather than issuing a
second receipt or activating a membership twice. That matters because a webhook
and the browser's own callback routinely both arrive.

On success: a receipt number is issued, the seat is confirmed or the membership
activated, any previously active subscription is expired, the member is
notified in-app, and the receipt and ticket emails go out after the commit.

---

## Everything else

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/members` | staff | The register, filtered and paged |
| GET | `/members/:id` | self or staff | One member with their full history |
| POST | `/members` | admin | Add a member and their account |
| PATCH | `/members/:id` | self or admin | Edit a profile |
| PATCH | `/members/:id/status` | admin | Activate · suspend |
| POST | `/members/:id/photo` | self or admin | Upload a photograph |
| DELETE | `/members/:id` | admin | Remove the person entirely |
| GET | `/users` | admin | Accounts, filtered and paged |
| PATCH | `/users/:id/role` | admin | Change a role |
| PATCH | `/users/:id/status` | admin | Activate · deactivate |
| GET/POST/PATCH/DELETE | `/event-categories` | public / admin | Categories |
| GET/POST/PATCH/DELETE | `/plans` | public / admin | Membership plans |
| GET | `/subscriptions` | yes | Own; any member's for an administrator |
| POST | `/subscriptions` | yes | Open a membership purchase |
| PATCH | `/subscriptions/:id/cancel` | admin | End a membership early |
| GET | `/notifications` | yes | Own feed (`?unreadOnly=true`) |
| GET | `/notifications/unread-count` | yes | The badge |
| PATCH | `/notifications/:id/read` | yes | Mark read or unread |
| POST | `/notifications/read-all` | yes | Clear the badge |
| DELETE | `/notifications/:id` | yes | Remove one |
| GET | `/settings/organisation` | public | Footer, contact page, receipts |
| PATCH | `/settings/organisation` | admin | Edit it |
| GET | `/settings/email-templates` | admin | The six templates |
| PATCH | `/settings/email-templates/:key` | admin | Subject line and on/off |
| POST | `/uploads/event-cover` | staff | Store an image, get its URL |

Notable refusals: a member under 18 without guardian details (`422`); deleting
a category still used by events or a plan with subscriptions (`409` — deactivate
instead); changing your own role or deactivating your own account (`403`);
demoting or deactivating the last active administrator (`409`).

Uploads are `multipart/form-data` with the file under `file`, max 5 MB, JPEG ·
PNG · WebP · GIF. The stored name is generated; the client's filename is never
used on disk. Files are served from `/uploads/…`.

---

## Health

`GET /health` · `GET /health/db` · `GET /api/v1/` (endpoint index).
