import { queryAll, queryOne, withTransaction } from '../../database/index.js';
import {
  MEMBERSHIP_STATUS,
  PAYMENT_PURPOSE,
  PAYMENT_STATUS,
  REGISTRATION_STATUS,
  SUBSCRIPTION_STATUS,
} from '../../config/constants.js';
import ApiError from '../../utils/ApiError.js';
import { receiptNumber } from '../../utils/codes.js';
import { toPayment } from '../../serializers/index.js';
import { verifySettlement } from '../../services/gateway.service.js';
import { push } from '../../services/notification.service.js';
import { recordQuietly } from '../../services/activity.service.js';
import { sendTemplate } from '../../services/email.service.js';
import logger from '../../utils/logger.js';

/**
 * Settlement.
 *
 * This is the only place a seat becomes confirmed or a membership becomes
 * active, and it does both in one transaction with the payment row. The
 * front end's payment dialog shows a "verifying" step precisely because this
 * step exists: the gateway result is checked here, server-side, and only then
 * does anything change.
 */

const money = (amount) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);

const FAILURE_REASON = {
  [PAYMENT_STATUS.FAILED]: 'The bank declined the transaction',
  [PAYMENT_STATUS.CANCELLED]: 'Cancelled by the payer',
};

export const findById = (id) => queryOne(`SELECT * FROM payments WHERE id = $1`, [id]);

/**
 * Applies a verified outcome.
 *
 * Idempotent: replaying a settlement for a payment that already succeeded
 * returns the same row rather than issuing a second receipt or activating a
 * membership twice. That matters because a gateway webhook and the browser's
 * own callback routinely both arrive.
 */
export async function settle(
  { paymentId, outcome, gatewayPaymentId, signature, trusted = false },
  actor = null,
) {
  const payment = await findById(paymentId);
  if (!payment) throw ApiError.notFound('That payment no longer exists');

  if (payment.status === PAYMENT_STATUS.SUCCESSFUL) {
    return { payment: toPayment(payment), alreadySettled: true };
  }
  if (payment.status !== PAYMENT_STATUS.PENDING && outcome === PAYMENT_STATUS.SUCCESSFUL) {
    throw ApiError.conflict(
      'That payment was already closed and cannot be marked successful',
      undefined,
      'PAYMENT_CLOSED',
    );
  }

  const verified = verifySettlement({ payment, outcome, gatewayPaymentId, signature, trusted });
  const settledAt = new Date();

  const result = await withTransaction(async (tx) => {
    const succeeded = verified.outcome === PAYMENT_STATUS.SUCCESSFUL;

    let receiptNo = payment.receipt_no;
    if (succeeded && !receiptNo) {
      const sequence = await tx.queryOne(`SELECT nextval('receipt_no_seq')::int AS n`);
      receiptNo = receiptNumber(settledAt, sequence.n);
    }

    const updated = await tx.queryOne(
      // Every parameter inside a CASE is cast explicitly: with a NULL in the
      // other branch, Postgres has nothing to infer the type from.
      `UPDATE payments
       SET status = $1,
           completed_at = CASE WHEN $1 = 'successful' THEN $2::timestamptz ELSE NULL END,
           receipt_no = $3::text,
           gateway_payment_id = COALESCE($4::text, gateway_payment_id),
           failure_reason = $5::text
       WHERE id = $6
       RETURNING *`,
      [
        verified.outcome,
        settledAt,
        succeeded ? receiptNo : null,
        verified.gatewayPaymentId ?? null,
        succeeded ? null : (FAILURE_REASON[verified.outcome] ?? null),
        paymentId,
      ],
    );

    const member = await tx.queryOne(`SELECT * FROM members WHERE id = $1`, [payment.member_id]);

    /* ------------------------------------------------------ a booked seat */
    if (payment.registration_id) {
      const status = succeeded
        ? REGISTRATION_STATUS.CONFIRMED
        : verified.outcome === PAYMENT_STATUS.PENDING
          ? REGISTRATION_STATUS.PENDING_PAYMENT
          : REGISTRATION_STATUS.CANCELLED;

      const registration = await tx.queryOne(
        `UPDATE registrations
         SET status = $1,
             hold_expires_at = CASE WHEN $1 = 'pending_payment' THEN hold_expires_at ELSE NULL END,
             cancelled_at = CASE WHEN $1 = 'cancelled' THEN $2::timestamptz ELSE NULL END,
             cancellation_reason = CASE WHEN $1 = 'cancelled' THEN $3::text ELSE NULL END
         WHERE id = $4
         RETURNING *`,
        [
          status,
          settledAt,
          verified.outcome === PAYMENT_STATUS.FAILED
            ? 'Payment was not completed'
            : 'Payment cancelled by the member',
          payment.registration_id,
        ],
      );

      const event = await tx.queryOne(`SELECT * FROM events WHERE id = $1`, [registration.event_id]);

      if (succeeded) {
        await push({
          client: tx,
          userId: member.user_id,
          type: 'event_registration',
          title: `Seat confirmed — ${event.title}`,
          body: 'Your QR ticket is ready in your tickets.',
          href: `/member/tickets/${registration.id}`,
        });
      }

      return { payment: updated, member, registration, event, subscription: null, plan: null, succeeded };
    }

    /* ------------------------------------------------------ a membership */
    const status = succeeded
      ? SUBSCRIPTION_STATUS.ACTIVE
      : verified.outcome === PAYMENT_STATUS.PENDING
        ? SUBSCRIPTION_STATUS.PENDING
        : SUBSCRIPTION_STATUS.CANCELLED;

    const subscription = await tx.queryOne(
      `UPDATE subscriptions SET status = $1 WHERE id = $2 RETURNING *`,
      [status, payment.subscription_id],
    );
    const plan = await tx.queryOne(`SELECT * FROM membership_plans WHERE id = $1`, [subscription.plan_id]);

    if (succeeded) {
      // Whatever was active becomes history, and the membership the payment
      // bought becomes the one in force. Doing it in this order means there is
      // never a moment with two active subscriptions on one member.
      await tx.query(
        `UPDATE subscriptions SET status = 'expired'
         WHERE member_id = $1 AND id <> $2 AND status = 'active'`,
        [subscription.member_id, subscription.id],
      );
      await tx.query(
        `UPDATE members SET status = $1, current_subscription_id = $2 WHERE id = $3`,
        [MEMBERSHIP_STATUS.ACTIVE, subscription.id, subscription.member_id],
      );
      await tx.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'inactive'`, [
        member.user_id,
      ]);

      await push({
        client: tx,
        userId: member.user_id,
        type: subscription.kind === 'upgrade' ? 'membership_upgraded' : 'membership_activated',
        title: `${plan.name} membership active`,
        body: `Valid until ${formatDay(subscription.end_date)}.`,
        href: '/member/membership',
      });
    }

    return { payment: updated, member, registration: null, event: null, subscription, plan, succeeded };
  });

  // Receipts and confirmations go out after the transaction has committed, so
  // a slow mail server cannot roll back a payment that has already settled.
  if (result.succeeded) {
    await push({
      userId: result.member.user_id,
      type: 'payment_confirmation',
      title: `Receipt for ${money(Number(result.payment.amount))}`,
      body: `Payment for ${result.payment.description} was successful.`,
      href: '/member/payments',
    }).catch((error) => logger.error('Receipt notification failed:', error.message));

    sendTemplate('payment_confirmation', result.member.email, {
      member_name: result.member.full_name,
      amount: Number(result.payment.amount).toLocaleString('en-IN'),
      purpose: result.payment.description,
      payment_reference: result.payment.reference,
      receipt_no: result.payment.receipt_no,
    }).catch((error) => logger.error('Receipt email failed:', error.message));

    if (result.registration) {
      sendTemplate('event_confirmation', result.member.email, {
        participant_name: result.registration.participant_name,
        event_title: result.event.title,
        event_date: result.event.date,
        event_time: `${result.event.start_time}–${result.event.end_time}`,
        venue_name: result.event.venue_name,
        venue_address: result.event.venue_address,
        registration_reference: result.registration.reference,
      }).catch((error) => logger.error('Ticket email failed:', error.message));
    }
  }

  recordQuietly({
    actorId: actor?.id ?? null,
    subjectType: 'payment',
    subjectId: paymentId,
    action: `settle:${verified.outcome}`,
    description: `${result.payment.description} — ${verified.outcome}`,
    meta: { amount: Number(result.payment.amount), receiptNo: result.payment.receipt_no },
  });

  return { payment: toPayment(result.payment), alreadySettled: false };
}

const formatDay = (value) =>
  new Date(`${String(value).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** The payment history behind the member's receipts and the admin's ledger. */
export async function list(filters, actor) {
  const where = [];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (actor.role !== 'administrator') {
    if (!actor.member_id) {
      return { rows: [], meta: { page: 1, pageSize: filters.pageSize, total: 0, pageCount: 1 } };
    }
    where.push(`p.member_id = ${bind(actor.member_id)}`);
  } else if (filters.memberId) {
    where.push(`p.member_id = ${bind(filters.memberId)}`);
  }

  if (filters.status) where.push(`p.status = ${bind(filters.status)}`);
  if (filters.purpose) where.push(`p.purpose = ${bind(filters.purpose)}`);
  if (filters.from) where.push(`COALESCE(p.completed_at, p.created_at) >= ${bind(filters.from)}::date`);
  if (filters.to) {
    where.push(`COALESCE(p.completed_at, p.created_at) < (${bind(filters.to)}::date + INTERVAL '1 day')`);
  }
  if (filters.q) {
    const q = bind(filters.q);
    where.push(
      `(p.reference ILIKE '%' || ${q} || '%' OR p.receipt_no ILIKE '%' || ${q} || '%'
        OR p.payer_name ILIKE '%' || ${q} || '%' OR p.description ILIKE '%' || ${q} || '%')`,
    );
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.pageSize;

  const rows = await queryAll(
    `SELECT p.*, COUNT(*) OVER ()::int AS total_count
     FROM payments p
     ${clause}
     ORDER BY p.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offset],
  );

  const total = rows[0]?.total_count ?? 0;
  return {
    rows: rows.map(toPayment),
    meta: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

export default { settle, list, findById };
