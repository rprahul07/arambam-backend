import { queryAll, queryOne, withTransaction } from '../../database/index.js';
import env from '../../config/env.js';
import {
  ATTENDANCE,
  EVENT_LIFECYCLE,
  MEMBERSHIP_STATUS,
  OCCUPYING_STATUSES,
  OFFLINE_HOLD_HOURS,
  OFFLINE_PAYMENT_METHODS,
  PAYMENT_PURPOSE,
  PAYMENT_STATUS,
  REGISTRATION_STATUS,
  ROLES,
} from '../../config/constants.js';
import ApiError from '../../utils/ApiError.js';
import { registrationReference, ticketCode } from '../../utils/codes.js';
import { toEvent, toPayment, toRegistration } from '../../serializers/index.js';
import { createOrder } from '../../services/gateway.service.js';
import { push } from '../../services/notification.service.js';
import { recordQuietly } from '../../services/activity.service.js';
import { sendTemplate } from '../../services/email.service.js';
import logger from '../../utils/logger.js';

/**
 * Seats.
 *
 * The rule the interface states, enforced here: a seat is occupied by a
 * confirmed booking *and* by one waiting for payment. A free event confirms
 * straight away. A paid one holds the seat while the gateway runs and confirms
 * it only when the settlement has been verified — the browser saying "paid"
 * is not what confirms anything.
 */

export const findById = (id) => queryOne(`SELECT * FROM registrations WHERE id = $1`, [id]);

/** What a member would pay right now, given whether their membership is live. */
export const priceFor = (event, isActiveMember) => {
  if (event.type === 'free') return 0;
  return Number(isActiveMember ? event.member_price : event.non_member_price);
};

/**
 * How long the seat is held.
 *
 * A gateway payment either completes in the next few minutes or does not, so
 * twenty of them is generous. Paying by QR or through SBI Collect means
 * leaving the site, opening a banking app and coming back with a reference —
 * and possibly doing it after the bank's own delay — so that hold is counted
 * in hours instead.
 */
function holdMillis(method) {
  return OFFLINE_PAYMENT_METHODS.includes(method)
    ? OFFLINE_HOLD_HOURS * 60 * 60 * 1000
    : env.payment.holdMinutes * 60 * 1000;
}

/**
 * The same derivation the front end runs in `lib/domain.ts`. Kept here so the
 * server can refuse a booking the interface would never have offered.
 */
export function registrationOpen(event, seats, now = new Date()) {
  if (event.lifecycle === EVENT_LIFECYCLE.CANCELLED) return { open: false, reason: 'This event has been cancelled' };
  if (event.lifecycle === EVENT_LIFECYCLE.DRAFT) return { open: false, reason: 'This event is not published' };
  if (event.lifecycle === EVENT_LIFECYCLE.COMPLETED) return { open: false, reason: 'This event has ended' };
  if (now < new Date(event.registration_opens_at)) {
    return { open: false, reason: 'Registration has not opened yet' };
  }
  if (now > new Date(event.registration_closes_at)) {
    return { open: false, reason: 'Registration has closed for this event' };
  }
  if (seats.remaining <= 0) return { open: false, reason: 'This event is sold out' };
  return { open: true };
}

/**
 * Opens a booking.
 *
 * Everything that decides whether the seat exists happens inside one
 * transaction, and the event row is locked first. Two people clicking Register
 * on the last seat at the same moment queue behind that lock, so the second
 * one is told it is sold out rather than both being told it is theirs.
 */
export async function begin({ eventId, memberId, method, id, paymentId }, actor) {
  // Read first, unlocked, to learn the price and open a gateway order. Talking
  // to the gateway while holding a row lock would stall every other person
  // trying to book the same event for as long as the network takes.
  const preview = await queryOne(
    `SELECT e.type, e.member_price, e.non_member_price, m.status AS member_status
     FROM events e, members m WHERE e.id = $1 AND m.id = $2`,
    [eventId, memberId],
  );
  if (!preview) throw ApiError.notFound('That event or member no longer exists');

  const expectedAmount = priceFor(
    { type: preview.type, member_price: preview.member_price, non_member_price: preview.non_member_price },
    preview.member_status === MEMBERSHIP_STATUS.ACTIVE,
  );

  const order =
    expectedAmount > 0
      ? await createOrder({
          amount: expectedAmount,
          receipt: `evt-${eventId.slice(0, 8)}-${Date.now().toString(36)}`,
          notes: { eventId, memberId },
          method,
        })
      : null;

  const result = await withTransaction(async (tx) => {
    const event = await tx.queryOne(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
    if (!event) throw ApiError.notFound('That event no longer exists');

    const member = await tx.queryOne(`SELECT * FROM members WHERE id = $1`, [memberId]);
    if (!member) throw ApiError.notFound('That member no longer exists');

    if (member.status === MEMBERSHIP_STATUS.SUSPENDED) {
      throw ApiError.forbidden('This membership is suspended and cannot take new bookings');
    }

    const counted = await tx.queryOne(
      `SELECT COUNT(*)::int AS booked FROM registrations WHERE event_id = $1 AND status = ANY($2)`,
      [eventId, OCCUPYING_STATUSES],
    );
    const seats = {
      capacity: Number(event.capacity),
      booked: counted.booked,
      remaining: Math.max(0, Number(event.capacity) - counted.booked),
    };

    /* A seat this member already holds is settled before capacity is
       considered at all. Returning to finish a payment is not a request for
       another seat, and their own hold is part of the count — so on a small
       event the member's own booking made the event read as sold out and
       locked them out of the payment they had already started. */
    const existing = await tx.queryOne(
      `SELECT * FROM registrations WHERE event_id = $1 AND member_id = $2 AND status <> 'cancelled'`,
      [eventId, memberId],
    );
    if (existing) {
      const payment = existing.payment_id
        ? await tx.queryOne(`SELECT * FROM payments WHERE id = $1`, [existing.payment_id])
        : null;
      if (existing.status === REGISTRATION_STATUS.PENDING_PAYMENT && payment?.status === PAYMENT_STATUS.PENDING) {
        return { registration: existing, payment, event, member, reused: true };
      }
      throw ApiError.conflict('You already hold a seat on this event', undefined, 'ALREADY_REGISTERED');
    }

    // An administrator booking someone in at the door is allowed past the
    // window, but never past the capacity.
    const isStaff = actor.role === ROLES.ADMIN || actor.role === ROLES.ORGANIZER;
    const gate = registrationOpen(event, seats);
    if (!gate.open && !(isStaff && seats.remaining > 0 && event.lifecycle !== EVENT_LIFECYCLE.CANCELLED)) {
      throw ApiError.conflict(gate.reason, undefined, 'REGISTRATION_CLOSED');
    }

    const pricedAsMember = member.status === MEMBERSHIP_STATUS.ACTIVE;
    const amount = priceFor(event, pricedAsMember);
    // The price changed between the unlocked read and the lock — an edit to
    // the event, or a membership that activated in between. Refuse rather than
    // charge an amount the gateway order was not opened for.
    if (amount !== expectedAmount) {
      throw ApiError.conflict(
        'The price for this event has just changed. Please try again.',
        undefined,
        'PRICE_CHANGED',
      );
    }
    const now = new Date();

    const sequence = await tx.queryOne(`SELECT nextval('registration_ref_seq')::int AS n`);
    const status = amount === 0 ? REGISTRATION_STATUS.CONFIRMED : REGISTRATION_STATUS.PENDING_PAYMENT;

    const registration = await tx.queryOne(
      `INSERT INTO registrations (id, reference, event_id, member_id, participant_name, ticket_code,
                                  status, attendance, priced_as_member, amount, registered_at, hold_expires_at)
       VALUES (COALESCE($11::uuid, gen_random_uuid()),
               $1,$2,$3,$4,$5,$6,'not_checked_in',$7,$8,$9,$10)
       RETURNING *`,
      [
        registrationReference(now, sequence.n),
        eventId,
        memberId,
        member.full_name,
        ticketCode(),
        status,
        pricedAsMember,
        amount,
        now,
        amount === 0 ? null : new Date(now.getTime() + holdMillis(method)),
        id ?? null,
      ],
    );

    if (amount === 0) {
      await push({
        client: tx,
        userId: member.user_id,
        type: 'event_registration',
        title: `Seat confirmed — ${event.title}`,
        body: 'Your QR ticket is ready in your tickets.',
        href: `/member/tickets/${registration.id}`,
      });
      return { registration, payment: null, event, member, reused: false };
    }

    const payment = await tx.queryOne(
      `INSERT INTO payments (id, reference, member_id, payer_name, purpose, registration_id,
                             description, amount, method, status, gateway, gateway_order_id)
       VALUES (COALESCE($11::uuid, gen_random_uuid()),
               $1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)
       RETURNING *`,
      [
        order.reference,
        memberId,
        member.full_name,
        PAYMENT_PURPOSE.EVENT,
        registration.id,
        event.title,
        amount,
        method,
        order.gateway,
        order.orderId,
        paymentId ?? null,
      ],
    );

    const linked = await tx.queryOne(
      `UPDATE registrations SET payment_id = $1 WHERE id = $2 RETURNING *`,
      [payment.id, registration.id],
    );

    return { registration: linked, payment, event, member, reused: false };
  });

  // A confirmed free seat gets its ticket email; a held one waits for payment.
  if (!result.reused && result.registration.status === REGISTRATION_STATUS.CONFIRMED) {
    sendTicketEmail(result).catch((error) => logger.error('Ticket email failed:', error.message));
  }

  if (!result.reused) {
    recordQuietly({
      actorId: actor.id,
      subjectType: 'registration',
      subjectId: result.registration.id,
      action: 'create',
      description: `${result.member.full_name} registered for "${result.event.title}"`,
      meta: { amount: Number(result.registration.amount) },
    });
  }

  return {
    registration: toRegistration(result.registration),
    payment: result.payment ? toPayment(result.payment) : undefined,
  };
}

export function sendTicketEmail({ registration, event, member }) {
  return sendTemplate('event_confirmation', member.email, {
    participant_name: registration.participant_name,
    event_title: event.title,
    event_date: event.date,
    event_time: `${event.start_time}–${event.end_time}`,
    venue_name: event.venue_name,
    venue_address: event.venue_address,
    registration_reference: registration.reference,
  });
}

/** Releases a seat. Members may release their own; staff may release any. */
export async function cancel(id, reason, actor) {
  const registration = await findById(id);
  if (!registration) throw ApiError.notFound('That registration no longer exists');
  if (registration.status === REGISTRATION_STATUS.CANCELLED) {
    throw ApiError.conflict('That seat has already been released');
  }

  await assertMayManage(actor, registration);

  const row = await queryOne(
    `UPDATE registrations
     SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $1, hold_expires_at = NULL
     WHERE id = $2
     RETURNING *`,
    [reason, id],
  );

  recordQuietly({
    actorId: actor.id,
    subjectType: 'registration',
    subjectId: id,
    action: 'cancel',
    description: `Seat ${registration.reference} released`,
    meta: { reason },
  });

  return toRegistration(row);
}

/** Marks someone present or absent. Staff only — this is the door. */
export async function setAttendance(id, attendance, actor) {
  const registration = await findById(id);
  if (!registration) throw ApiError.notFound('That registration no longer exists');
  await assertMayManage(actor, registration, { staffOnly: true });

  if (registration.status === REGISTRATION_STATUS.CANCELLED && attendance === ATTENDANCE.ATTENDED) {
    throw ApiError.conflict('That seat was released — it cannot be checked in');
  }

  // Same rule as the ticket scanner: an event that is not running has no door
  // to check anyone in at.
  if (attendance === ATTENDANCE.ATTENDED) {
    const event = await queryOne(`SELECT lifecycle, title FROM events WHERE id = $1`, [
      registration.event_id,
    ]);
    if (event?.lifecycle === EVENT_LIFECYCLE.DRAFT || event?.lifecycle === EVENT_LIFECYCLE.CANCELLED) {
      throw ApiError.conflict(
        event.lifecycle === EVENT_LIFECYCLE.DRAFT
          ? 'This event has not been published yet, so nobody can be checked in'
          : 'This event was cancelled, so nobody can be checked in',
        undefined,
        'EVENT_NOT_RUNNING',
      );
    }
  }

  const row = await queryOne(
    `UPDATE registrations
     SET attendance = $1,
         checked_in_at = CASE WHEN $1 = 'attended' THEN COALESCE(checked_in_at, now()) ELSE NULL END,
         checked_in_by = CASE WHEN $1 = 'attended' THEN $2::uuid ELSE NULL END
     WHERE id = $3
     RETURNING *`,
    [attendance, actor.id, id],
  );

  recordQuietly({
    actorId: actor.id,
    subjectType: 'registration',
    subjectId: id,
    action: `attendance:${attendance}`,
    description: `${row.participant_name} marked ${attendance.replace(/_/g, ' ')}`,
  });

  return toRegistration(row);
}

/**
 * Resolves a scanned QR or a code read out at the gate.
 *
 * The outcomes are exactly the union the check-in screen renders, so the
 * interface never has to guess what a result means.
 */
export async function checkInByCode({ eventId, code }, actor) {
  const normalised = code.trim().toUpperCase().replace(/[\s-]/g, '');

  const registration = await queryOne(
    `SELECT * FROM registrations
     WHERE upper(ticket_code) = $1 OR upper(replace(reference, '-', '')) = $1
     LIMIT 1`,
    [normalised],
  );
  if (!registration) return { kind: 'invalid', code };

  const event = await queryOne(`SELECT * FROM events WHERE id = $1`, [registration.event_id]);
  await assertMayManage(actor, registration, { staffOnly: true });

  const payload = { registration: toRegistration(registration) };

  if (registration.event_id !== eventId) {
    return { kind: 'wrong_event', ...payload, ticketEvent: toEvent(event) };
  }

  const eventPayload = { ...payload, event: toEvent(event) };

  // Nobody attends an event that is not running. A draft is still being
  // written and a cancelled one is not happening, so a ticket code typed in
  // against either is refused rather than quietly recorded as an arrival.
  if (event.lifecycle === EVENT_LIFECYCLE.DRAFT || event.lifecycle === EVENT_LIFECYCLE.CANCELLED) {
    return { kind: 'not_running', ...eventPayload };
  }

  if (registration.status === REGISTRATION_STATUS.CANCELLED) return { kind: 'cancelled', ...eventPayload };
  if (registration.attendance === ATTENDANCE.ATTENDED) {
    return { kind: 'already_checked_in', ...eventPayload };
  }
  return { kind: 'valid', ...eventPayload };
}

/** Members see their own; organisers see their events'; administrators, all. */
async function assertMayManage(actor, registration, { staffOnly = false } = {}) {
  if (actor.role === ROLES.ADMIN) return;

  if (actor.role === ROLES.ORGANIZER) {
    const event = await queryOne(`SELECT organizer_id FROM events WHERE id = $1`, [registration.event_id]);
    if (event?.organizer_id === actor.id) return;
    throw ApiError.forbidden('You can only manage registrations on your own events');
  }

  if (staffOnly) throw ApiError.forbidden('Only staff can do that');
  if (actor.member_id && registration.member_id === actor.member_id) return;
  throw ApiError.forbidden('That is not your registration');
}

/* ----------------------------------------------------------------- reading */

export async function list(filters, actor) {
  const where = [];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (actor.role === ROLES.MEMBER) {
    if (!actor.member_id) return { rows: [], meta: { page: 1, pageSize: filters.pageSize, total: 0, pageCount: 1 } };
    where.push(`r.member_id = ${bind(actor.member_id)}`);
  } else if (actor.role === ROLES.ORGANIZER) {
    where.push(`e.organizer_id = ${bind(actor.id)}`);
  }

  if (filters.eventId) where.push(`r.event_id = ${bind(filters.eventId)}`);
  if (filters.memberId) where.push(`r.member_id = ${bind(filters.memberId)}`);
  if (filters.status) where.push(`r.status = ${bind(filters.status)}`);
  if (filters.attendance) where.push(`r.attendance = ${bind(filters.attendance)}`);
  if (filters.q) {
    const q = bind(filters.q);
    where.push(
      `(r.participant_name ILIKE '%' || ${q} || '%' OR r.reference ILIKE '%' || ${q} || '%'
        OR r.ticket_code ILIKE '%' || ${q} || '%')`,
    );
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.pageSize;

  // Joined once rather than looked up per row — this is the list behind the
  // participants table and the admin registrations screen.
  const rows = await queryAll(
    `SELECT r.*, COUNT(*) OVER ()::int AS total_count,
            e.title AS event_title, e.date AS event_date, e.slug AS event_slug,
            m.member_id AS member_code, m.phone AS member_phone
     FROM registrations r
     JOIN events e  ON e.id = r.event_id
     JOIN members m ON m.id = r.member_id
     ${clause}
     ORDER BY r.registered_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offset],
  );

  const total = rows[0]?.total_count ?? 0;
  return {
    rows: rows.map((row) => ({
      ...toRegistration(row),
      eventTitle: row.event_title,
      eventDate: row.event_date,
      eventSlug: row.event_slug,
      memberCode: row.member_code,
      memberPhone: row.member_phone,
    })),
    meta: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

/**
 * Releases seats whose payment never completed. Run on a schedule so an
 * abandoned checkout does not hold a seat out of circulation for ever.
 */
export async function releaseExpiredHolds() {
  const rows = await queryAll(
    `UPDATE registrations
     SET status = 'cancelled', cancelled_at = now(),
         cancellation_reason = 'Payment was not completed in time', hold_expires_at = NULL
     WHERE status = 'pending_payment'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at < now()
       -- A payer who has paid and quoted their reference has done everything
       -- asked of them. Their seat waits for the administrator to check it,
       -- however long that takes; the hold only governs the time before a
       -- claim is made.
       AND NOT EXISTS (
         SELECT 1 FROM payments p
         WHERE p.id = registrations.payment_id AND p.status = 'awaiting_verification'
       )
     RETURNING id, payment_id`,
  );

  const paymentIds = rows.map((row) => row.payment_id).filter(Boolean);
  if (paymentIds.length) {
    await queryOne(
      `UPDATE payments
       SET status = 'cancelled', failure_reason = 'The seat hold expired before payment completed'
       WHERE id = ANY($1) AND status = 'pending'
       RETURNING id`,
      [paymentIds],
    );
  }

  if (rows.length) logger.info(`Released ${rows.length} expired seat holds`);
  return rows.length;
}

export default {
  begin,
  cancel,
  setAttendance,
  checkInByCode,
  list,
  findById,
  priceFor,
  registrationOpen,
  releaseExpiredHolds,
};
