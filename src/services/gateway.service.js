import crypto from 'node:crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { gatewayReference } from '../utils/codes.js';

/**
 * The payment gateway boundary.
 *
 * Two providers, one interface:
 *
 *   simulated — the walkthrough build. The client asks for an outcome and gets
 *               it. Nothing here is a stub: a real row is written, a real
 *               receipt number is issued and the seat or membership really is
 *               settled. What it does not do is talk to a bank.
 *
 *   razorpay  — production. An order is opened at the gateway and a settlement
 *               is only accepted once its HMAC signature verifies against the
 *               key secret, which is exactly why the front end's payment
 *               dialog shows a separate "verifying" step: the browser's word
 *               is never taken for whether money moved.
 */

export const isSimulated = () => env.payment.provider === 'simulated';

const requireRazorpayKeys = () => {
  const { keyId, keySecret } = env.payment.razorpay;
  if (!keyId || !keySecret) {
    throw ApiError.unavailable(
      'Card payments are not available right now. Please try again later.',
      undefined,
      'GATEWAY_NOT_CONFIGURED',
    );
  }
  return { keyId, keySecret };
};

let razorpayClient = null;
const getRazorpay = async () => {
  const { keyId, keySecret } = requireRazorpayKeys();
  if (!razorpayClient) {
    const { default: Razorpay } = await import('razorpay');
    razorpayClient = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return razorpayClient;
};

/**
 * Opens a transaction with the gateway.
 * @returns {Promise<{reference: string, orderId: string|null, gateway: string, keyId?: string}>}
 */
export async function createOrder({ amount, currency = env.payment.currency, receipt, notes = {} }) {
  if (isSimulated()) {
    return { reference: gatewayReference(), orderId: null, gateway: 'simulated' };
  }

  const client = await getRazorpay();
  const order = await client.orders.create({
    amount: Math.round(amount * 100), // paise
    currency,
    receipt: receipt.slice(0, 40),
    notes,
  });

  return {
    reference: order.id,
    orderId: order.id,
    gateway: 'razorpay',
    keyId: env.payment.razorpay.keyId,
  };
}

/**
 * Decides whether a settlement may be believed.
 *
 * In simulated mode the requested outcome is accepted. In Razorpay mode the
 * signature must verify — a caller who simply posts `{outcome:'successful'}`
 * is refused, which is the entire point of doing this server-side.
 */
export function verifySettlement({ payment, outcome, gatewayPaymentId, signature, trusted = false }) {
  if (isSimulated()) {
    return { accepted: true, gatewayPaymentId: gatewayPaymentId ?? gatewayReference('sim'), outcome };
  }

  // A webhook body has already been verified against the webhook secret over
  // the whole payload; re-checking the per-payment signature would only be a
  // weaker test of the same fact.
  if (trusted) return { accepted: true, gatewayPaymentId: gatewayPaymentId ?? null, outcome };

  const { keySecret } = requireRazorpayKeys();

  // A failure or an abandonment carries no signature and needs none — nothing
  // is credited by believing a payment did not succeed.
  if (outcome !== 'successful') {
    return { accepted: true, gatewayPaymentId: gatewayPaymentId ?? null, outcome };
  }

  if (!payment.gateway_order_id || !gatewayPaymentId || !signature) {
    throw ApiError.badRequest('The payment could not be verified', undefined, 'SIGNATURE_MISSING');
  }

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${payment.gateway_order_id}|${gatewayPaymentId}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  const accepted = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!accepted) {
    throw ApiError.badRequest(
      'The payment signature did not verify. Nothing has been charged.',
      undefined,
      'SIGNATURE_INVALID',
    );
  }

  return { accepted: true, gatewayPaymentId, outcome: 'successful' };
}

/** Verifies a webhook body against the shared webhook secret. */
export function verifyWebhook(rawBody, signature) {
  const secret = env.payment.razorpay.webhookSecret;
  if (!secret) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default { createOrder, verifySettlement, verifyWebhook, isSimulated };
