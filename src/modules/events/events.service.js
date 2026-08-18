import { query, queryAll, queryOne, withTransaction } from '../../database/index.js';
import { EVENT_LIFECYCLE, OCCUPYING_STATUSES, ROLES } from '../../config/constants.js';
import ApiError from '../../utils/ApiError.js';
import { slugify } from '../../utils/codes.js';
import { toEvent } from '../../serializers/index.js';
import { pushMany } from '../../services/notification.service.js';
import { recordQuietly } from '../../services/activity.service.js';
import { sendTemplate } from '../../services/email.service.js';
import logger from '../../utils/logger.js';

/**
 * Events.
 *
 * The only status written down is the administrator's `lifecycle`. Whether
 * registration is open, closed, nearly full or sold out is computed from the
 * clock and the live seat count every time it is asked for — the same rule the
 * interface applies in `lib/domain.ts`, so the two can never disagree.
 */

/** Column ↔ field map. Only these may be written, whatever the body contains. */
const WRITABLE = {
  title: 'title',
  summary: 'summary',
  description: 'description',
  categoryId: 'category_id',
  coverImageUrl: 'cover_image_url',
  venueName: 'venue_name',
  venueAddress: 'venue_address',
  city: 'city',
  date: 'date',
  startTime: 'start_time',
  endTime: 'end_time',
  registrationOpensAt: 'registration_opens_at',
  registrationClosesAt: 'registration_closes_at',
  capacity: 'capacity',
  type: 'type',
  memberPrice: 'member_price',
  nonMemberPrice: 'non_member_price',
  organizerId: 'organizer_id',
  lifecycle: 'lifecycle',
  paymentQrMode: 'payment_qr_mode',
  paymentQrUrl: 'payment_qr_url',
};

export const findById = (id) => queryOne(`SELECT * FROM events WHERE id = $1`, [id]);

export const findByIdOrSlug = (idOrSlug) =>
  queryOne(
    `SELECT * FROM events WHERE slug = $1 OR (id::text = $1) LIMIT 1`,
    [idOrSlug],
  );

/** A slug is unique; a repeated title gets `-2`, `-3`, and so on. */
async function uniqueSlug(title, excludeId = null) {
  const base = slugify(title);
  const { rows } = await query(
    `SELECT slug FROM events WHERE slug = $1 OR slug LIKE $2 || '-%' ${excludeId ? 'AND id <> $3' : ''}`,
    excludeId ? [base, base, excludeId] : [base, base],
  );
  if (!rows.some((row) => row.slug === base)) return base;

  const taken = new Set(rows.map((row) => row.slug));
  for (let suffix = 2; suffix < 500; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Occupied seats for one event: confirmed plus holds, cancellations excluded. */
export async function seatCount(eventId, client = null) {
  const run = client ? client.queryOne.bind(client) : queryOne;
  const row = await run(
    `SELECT e.capacity,
            COUNT(r.id) FILTER (WHERE r.status = ANY($2))::int AS booked
     FROM events e
     LEFT JOIN registrations r ON r.event_id = e.id
     WHERE e.id = $1
     GROUP BY e.capacity`,
    [eventId, OCCUPYING_STATUSES],
  );
  if (!row) throw ApiError.notFound('That event no longer exists');
  const capacity = Number(row.capacity);
  const booked = Number(row.booked);
  return { capacity, booked, remaining: Math.max(0, capacity - booked) };
}

/** Organisers may only touch the events they run; administrators, all of them. */
export function assertMayManage(user, event) {
  if (user.role === ROLES.ADMIN) return;
  if (user.role === ROLES.ORGANIZER && event.organizer_id === user.id) return;
  throw ApiError.forbidden('You can only manage the events you are assigned to');
}

/* ----------------------------------------------------------------- reading */

export async function list(filters, user) {
  const where = [];
  const params = [];
  /** Binds one value and returns its placeholder, so numbering cannot drift. */
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  // Drafts belong to their organiser and to administrators. Nobody else is
  // told they exist.
  if (!user || user.role === ROLES.MEMBER) {
    where.push(`e.lifecycle <> 'draft'`);
  } else if (user.role === ROLES.ORGANIZER) {
    where.push(`(e.lifecycle <> 'draft' OR e.organizer_id = ${bind(user.id)})`);
  }

  if (filters.q) {
    const q = bind(filters.q);
    where.push(`(e.title ILIKE '%' || ${q} || '%' OR e.summary ILIKE '%' || ${q} || '%')`);
  }
  if (filters.categoryId) where.push(`e.category_id = ${bind(filters.categoryId)}`);
  if (filters.lifecycle) where.push(`e.lifecycle = ${bind(filters.lifecycle)}`);
  if (filters.organizerId) where.push(`e.organizer_id = ${bind(filters.organizerId)}`);
  if (filters.from) where.push(`e.date >= ${bind(filters.from)}::date`);
  if (filters.to) where.push(`e.date <= ${bind(filters.to)}::date`);

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.pageSize;

  const rows = await queryAll(
    `SELECT e.*,
            COUNT(*) OVER ()::int AS total_count,
            COUNT(r.id) FILTER (WHERE r.status = ANY($${params.length + 1}))::int AS booked
     FROM events e
     LEFT JOIN registrations r ON r.event_id = e.id
     ${clause}
     GROUP BY e.id
     ORDER BY e.date DESC
     LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
    [...params, OCCUPYING_STATUSES, filters.pageSize, offset],
  );

  const total = rows[0]?.total_count ?? 0;
  return {
    rows: rows.map((row) => ({
      ...toEvent(row),
      seats: {
        capacity: Number(row.capacity),
        booked: Number(row.booked),
        remaining: Math.max(0, Number(row.capacity) - Number(row.booked)),
      },
    })),
    meta: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

/* ----------------------------------------------------------------- writing */

export async function create(input, user) {
  // An organiser can create an event, and it is automatically assigned to themselves.
  if (user.role === ROLES.ORGANIZER) {
    input.organizerId = user.id;
  }

  const organizer = await queryOne(`SELECT id, role FROM users WHERE id = $1`, [input.organizerId]);
  if (!organizer || organizer.role === ROLES.MEMBER) {
    throw ApiError.badRequest('Choose an administrator or organiser to run this event', {
      organizerId: 'That account cannot run events',
    });
  }

  const slug = await uniqueSlug(input.title);
  const publishedAt = input.lifecycle === EVENT_LIFECYCLE.PUBLISHED ? new Date() : null;

  const row = await queryOne(
    `INSERT INTO events (id, slug, title, summary, description, category_id, cover_image_url,
                         venue_name, venue_address, city, date, start_time, end_time,
                         registration_opens_at, registration_closes_at, capacity, lifecycle,
                         type, member_price, non_member_price, organizer_id, published_at,
                         payment_qr_mode, payment_qr_url)
     VALUES (COALESCE($24::uuid, gen_random_uuid()),
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING *`,
    [
      slug,
      input.title,
      input.summary,
      input.description,
      input.categoryId,
      input.coverImageUrl ?? null,
      input.venueName,
      input.venueAddress,
      input.city,
      input.date,
      input.startTime,
      input.endTime,
      input.registrationOpensAt,
      input.registrationClosesAt,
      input.capacity,
      input.lifecycle,
      input.type,
      input.type === 'free' ? 0 : input.memberPrice,
      input.type === 'free' ? 0 : input.nonMemberPrice,
      input.organizerId,
      publishedAt,
      input.paymentQrMode ?? 'trust',
      input.paymentQrMode === 'own' ? (input.paymentQrUrl || null) : null,
      input.id ?? null,
    ],
  );

  recordQuietly({
    actorId: user.id,
    subjectType: 'event',
    subjectId: row.id,
    action: 'create',
    description: `Created "${row.title}"`,
    meta: { lifecycle: row.lifecycle },
  });

  return toEvent(row);
}

export async function update(id, patch, user) {
  const event = await findById(id);
  if (!event) throw ApiError.notFound('That event no longer exists');
  assertMayManage(user, event);

  if (user.role === ROLES.ORGANIZER && patch.organizerId && patch.organizerId !== user.id) {
    throw ApiError.forbidden('Only an administrator can reassign an event');
  }

  // Shrinking capacity below the seats already sold would put the event into a
  // state the interface cannot describe honestly.
  if (patch.capacity !== undefined) {
    const seats = await seatCount(id);
    if (patch.capacity < seats.booked) {
      throw ApiError.unprocessable(
        `${seats.booked} seats are already taken — capacity cannot go below that`,
        { capacity: `At least ${seats.booked}` },
      );
    }
  }

  const sets = [];
  const params = [];
  for (const [field, column] of Object.entries(WRITABLE)) {
    if (patch[field] === undefined) continue;
    params.push(patch[field]);
    sets.push(`${column} = $${params.length}`);
  }

  if (patch.title) {
    params.push(await uniqueSlug(patch.title, id));
    sets.push(`slug = $${params.length}`);
  }

  // Free is free, whatever the form sent.
  const nextType = patch.type ?? event.type;
  if (nextType === 'free') {
    sets.push(`member_price = 0`, `non_member_price = 0`);
  }

  if (patch.lifecycle === EVENT_LIFECYCLE.PUBLISHED && !event.published_at) {
    sets.push(`published_at = now()`);
  }

  if (!sets.length) return toEvent(event);

  params.push(id);
  const row = await queryOne(
    `UPDATE events SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  recordQuietly({
    actorId: user.id,
    subjectType: 'event',
    subjectId: id,
    action: 'update',
    description: `Updated "${row.title}"`,
    meta: { fields: Object.keys(patch) },
  });

  return toEvent(row);
}

/**
 * Moves an event through its lifecycle.
 *
 * Cancelling is the consequential one: every live seat is released in the same
 * transaction, everyone holding one is notified in-app, and the cancellation
 * email goes out afterwards. Doing the releases and the notices together is
 * what stops a participant seeing a valid ticket for an event that is off.
 */
export async function setLifecycle(id, { lifecycle, reason }, user) {
  const event = await findById(id);
  if (!event) throw ApiError.notFound('That event no longer exists');
  assertMayManage(user, event);

  const result = await withTransaction(async (tx) => {
    const updated = await tx.queryOne(
      `UPDATE events
       SET lifecycle = $1,
           cancellation_reason = CASE WHEN $1 = 'cancelled' THEN $2::text ELSE NULL END,
           published_at = CASE WHEN $1 = 'published' AND published_at IS NULL THEN now() ELSE published_at END
       WHERE id = $3
       RETURNING *`,
      [lifecycle, reason ?? null, id],
    );

    if (lifecycle !== EVENT_LIFECYCLE.CANCELLED) return { event: updated, affected: [] };

    const affected = await tx.queryAll(
      `UPDATE registrations
       SET status = 'cancelled',
           cancelled_at = now(),
           cancellation_reason = 'Event cancelled by the organiser'
       WHERE event_id = $1 AND status <> 'cancelled'
       RETURNING id, member_id, participant_name`,
      [id],
    );

    if (affected.length) {
      const recipients = await tx.queryAll(
        `SELECT m.id AS member_id, m.user_id, m.email, m.full_name
         FROM members m WHERE m.id = ANY($1)`,
        [affected.map((row) => row.member_id)],
      );

      await pushMany({
        client: tx,
        recipients: recipients.map((row) => ({
          userId: row.user_id,
          type: 'event_cancelled',
          title: `${updated.title} has been cancelled`,
          body: reason ?? 'The organiser has cancelled this event.',
          href: `/events/${updated.slug}`,
        })),
      });

      return { event: updated, affected: recipients };
    }

    return { event: updated, affected: [] };
  });

  // Email is outside the transaction: a mail server having a bad afternoon
  // must not undo a cancellation that has already been decided.
  for (const person of result.affected) {
    sendTemplate('event_cancellation', person.email, {
      participant_name: person.full_name,
      event_title: result.event.title,
      event_date: result.event.date,
      cancellation_reason: reason ?? 'The organiser has cancelled this event.',
    }).catch((error) => logger.error('Cancellation email failed:', error.message));
  }

  recordQuietly({
    actorId: user.id,
    subjectType: 'event',
    subjectId: id,
    action: `lifecycle:${lifecycle}`,
    description: `"${result.event.title}" moved to ${lifecycle}`,
    meta: { reason, seatsReleased: result.affected.length },
  });

  return toEvent(result.event);
}

export async function remove(id, user) {
  const event = await findById(id);
  if (!event) throw ApiError.notFound('That event no longer exists');

  const seats = await seatCount(id);
  if (seats.booked > 0) {
    throw ApiError.conflict(
      'This event has registrations — cancel it instead so participants are told and refunded',
      undefined,
      'EVENT_HAS_REGISTRATIONS',
    );
  }

  await query(`DELETE FROM events WHERE id = $1`, [id]);
  recordQuietly({
    actorId: user.id,
    subjectType: 'event',
    subjectId: id,
    action: 'delete',
    description: `Deleted "${event.title}"`,
  });
}

export default {
  list,
  create,
  update,
  setLifecycle,
  remove,
  findById,
  findByIdOrSlug,
  seatCount,
  assertMayManage,
};
