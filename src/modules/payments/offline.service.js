import { queryOne, withTransaction } from '../../database/index.js';
import {
  OFFLINE_PAYMENT_METHODS,
  PAYMENT_STATUS,
  REGISTRATION_STATUS,
  SUBSCRIPTION_STATUS,
} from '../../config/constants.js';
import ApiError from '../../utils/ApiError.js';
import { toPayment } from '../../serializers/index.js';
import { push } from '../../services/notification.service.js';
import { recordQuietly } from '../../services/activity.service.js';
import { settle } from './payments.service.js';

/**
 * Payments made outside the system.
 *
 * The Trust takes money by QR or through SBI Collect, and neither tells this
 * application anything. So a payment here has three steps rather than one:
 *
 *   claim    the payer says they have paid and quotes the bank reference
 *   check    an administrator finds that reference on the statement
 *   settle   only then is the seat or membership confirmed
 *
 * Everything that makes this trustworthy is in the gap between the first step
 * and the third:
 *
 *   · the payer cannot move their own payment to successful — no route lets
 *     them, and `settle` is reached only from `verify` below
 *   · a bank reference settles exactly one payment, enforced by a unique
 *     index, so the same transfer cannot be claimed for two seats
 *   · the amount expected is recorded when the payment is opened, so the
 *     administrator is comparing against a figure the payer never chose
 *   · who approved what, and when, is written to the activity log
 */

export const isOffline = (method) => OFFLINE_PAYMENT_METHODS.includes(method);

/** Normalised for comparison: banks are inconsistent about case and spacing. */
const normaliseReference = (value) => value.trim().replace(/\s+/g, '').toUpperCase();

/**
 * The payer's claim that they have paid.
 *
 * Moves the payment to `awaiting_verification`. It confirms nothing: the seat
 * stays held and the membership stays pending until an administrator agrees.
 */
export async function claim({ paymentId, reference, note, proofUrl }, actor) {
  const payment = await queryOne(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
  if (!payment) throw ApiError.notFound('That payment no longer exists');

  /* A member may only speak for their own payment. */
  if (actor.role === 'member' && payment.member_id !== actor.member_id) {
    throw ApiError.forbidden('That is not your payment');
  }

  if (payment.status === PAYMENT_STATUS.SUCCESSFUL) {
    throw ApiError.conflict('That payment has already been confirmed', undefined, 'ALREADY_SETTLED');
  }
  if (![PAYMENT_STATUS.PENDING, PAYMENT_STATUS.AWAITING_VERIFICATION].includes(payment.status)) {
    throw ApiError.conflict('That payment is closed and cannot be claimed', undefined, 'PAYMENT_CLOSED');
  }
  if (!isOffline(payment.method)) {
    throw ApiError.badRequest('That payment is not one made outside the system');
  }

  const normalised = normaliseReference(reference);

  /* Checked here for a courteous message; the unique index is what actually
     guarantees it when two people submit the same reference at once. */
  const taken = await queryOne(
    `SELECT id FROM payments WHERE lower(claim_reference) = lower($1) AND id <> $2`,
    [normalised, paymentId],
  );
  if (taken) {
    throw ApiError.conflict(
      'That reference has already been used for another payment. Check the number and try again.',
      { reference: 'Already used' },
      'REFERENCE_ALREADY_CLAIMED',
    );
  }

  const updated = await queryOne(
    `UPDATE payments
     SET status = $1,
         claim_reference = $2,
         claim_note = $3,
         claim_proof_url = $4,
         claimed_at = now(),
         rejection_reason = NULL
     WHERE id = $5
     RETURNING *`,
    [PAYMENT_STATUS.AWAITING_VERIFICATION, normalised, note ?? null, proofUrl ?? null, paymentId],
  );

  recordQuietly({
    actorId: actor.id,
    subjectType: 'payment',
    subjectId: paymentId,
    action: 'claim',
    description: `Payment claimed with reference ${normalised}`,
    meta: { amount: Number(payment.amount), reference: normalised },
  });

  return toPayment(updated);
}

/**
 * An administrator's decision on a claim.
 *
 * Approving hands over to the ordinary settlement path, so a payment verified
 * by hand confirms a seat, issues a receipt and sends the same emails as any
 * other. Rejecting records why and releases what was being held.
 */
export async function verify({ paymentId, approved, reason }, actor) {
  const payment = await queryOne(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
  if (!payment) throw ApiError.notFound('That payment no longer exists');

  if (payment.status === PAYMENT_STATUS.SUCCESSFUL) {
    return { payment: toPayment(payment), alreadySettled: true };
  }
  if (payment.status !== PAYMENT_STATUS.AWAITING_VERIFICATION) {
    throw ApiError.conflict(
      'That payment is not waiting to be checked',
      undefined,
      'NOT_AWAITING_VERIFICATION',
    );
  }

  if (approved) {
    await queryOne(
      `UPDATE payments SET verified_by = $1, verified_at = now() WHERE id = $2 RETURNING id`,
      [actor.id, paymentId],
    );

    /* `trusted` says the outcome has been established outside the gateway —
       which for this payment is exactly what an administrator has just done
       by finding the reference on the statement. */
    const result = await settle(
      { paymentId, outcome: PAYMENT_STATUS.SUCCESSFUL, trusted: true },
      actor,
    );

    recordQuietly({
      actorId: actor.id,
      subjectType: 'payment',
      subjectId: paymentId,
      action: 'verify:approved',
      description: `Payment ${payment.claim_reference} verified against the statement`,
      meta: { amount: Number(payment.amount), reference: payment.claim_reference },
    });

    return result;
  }

  if (!reason) {
    throw ApiError.unprocessable('Say why the payment could not be verified — the payer is told', {
      reason: 'A reason is required',
    });
  }

  const rejected = await withTransaction(async (tx) => {
    const row = await tx.queryOne(
      `UPDATE payments
       SET status = $1,
           failure_reason = $2,
           rejection_reason = $2,
           verified_by = $3,
           verified_at = now(),
           /* Freeing the reference: the payer may have simply mistyped it,
              and the number itself may belong to a genuine payment. */
           claim_reference = NULL
       WHERE id = $4
       RETURNING *`,
      [PAYMENT_STATUS.FAILED, reason, actor.id, paymentId],
    );

    if (payment.registration_id) {
      await tx.query(
        `UPDATE registrations
         SET status = $1, cancelled_at = now(), cancellation_reason = $2, hold_expires_at = NULL
         WHERE id = $3`,
        [REGISTRATION_STATUS.CANCELLED, `Payment could not be verified: ${reason}`, payment.registration_id],
      );
    }
    if (payment.subscription_id) {
      await tx.query(`UPDATE subscriptions SET status = $1 WHERE id = $2`, [
        SUBSCRIPTION_STATUS.CANCELLED,
        payment.subscription_id,
      ]);
    }

    const member = await tx.queryOne(`SELECT user_id FROM members WHERE id = $1`, [payment.member_id]);
    if (member) {
      await push({
        client: tx,
        userId: member.user_id,
        type: 'payment_confirmation',
        title: 'We could not verify your payment',
        body: `${reason} Please check the reference and try again, or contact the office.`,
        href: '/member/payments',
      });
    }

    return row;
  });

  recordQuietly({
    actorId: actor.id,
    subjectType: 'payment',
    subjectId: paymentId,
    action: 'verify:rejected',
    description: `Payment claim rejected: ${reason}`,
    meta: { amount: Number(payment.amount), reference: payment.claim_reference },
  });

  return { payment: toPayment(rejected), alreadySettled: false };
}

/** The administrator's queue, oldest claim first — nobody waits for ever. */
export async function pending() {
  const { queryAll } = await import('../../database/index.js');
  const rows = await queryAll(
    `SELECT p.*, m.full_name AS member_name, m.email AS member_email,
            e.title AS event_title, pl.name AS plan_name
     FROM payments p
     JOIN members m               ON m.id = p.member_id
     LEFT JOIN registrations r    ON r.id = p.registration_id
     LEFT JOIN events e           ON e.id = r.event_id
     LEFT JOIN subscriptions s    ON s.id = p.subscription_id
     LEFT JOIN membership_plans pl ON pl.id = s.plan_id
     WHERE p.status = $1
     ORDER BY p.claimed_at ASC`,
    [PAYMENT_STATUS.AWAITING_VERIFICATION],
  );

  return rows.map((row) => ({
    ...toPayment(row),
    memberName: row.member_name,
    memberEmail: row.member_email,
    forWhat: row.event_title ?? row.plan_name ?? row.description,
  }));
}

export default { claim, verify, pending, isOffline };
