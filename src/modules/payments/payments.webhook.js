import { queryOne } from '../../database/index.js';
import { PAYMENT_STATUS } from '../../config/constants.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { verifyWebhook } from '../../services/gateway.service.js';
import { settle } from './payments.service.js';
import logger from '../../utils/logger.js';

/**
 * POST /payments/webhook
 *
 * The gateway's own account of what happened, and the one that survives a
 * browser being closed mid-payment. Mounted before the JSON body parser so the
 * raw bytes are still available for the HMAC check.
 *
 * It always answers 200 once the signature verifies: a gateway that receives
 * anything else will keep retrying, and the settlement path is idempotent, so
 * there is nothing to gain from reporting a downstream problem here.
 */
export const handleWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];

  if (!verifyWebhook(req.rawBody, signature)) {
    logger.warn('Rejected a payment webhook with an invalid signature');
    return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
  }

  const event = req.body?.event;
  const entity = req.body?.payload?.payment?.entity ?? {};
  const orderId = entity.order_id;

  if (!orderId) return res.json({ success: true, message: 'Ignored — no order reference' });

  const payment = await queryOne(`SELECT id, status FROM payments WHERE gateway_order_id = $1`, [orderId]);
  if (!payment) {
    logger.warn(`Webhook for an unknown order: ${orderId}`);
    return res.json({ success: true, message: 'Ignored — unknown order' });
  }

  const outcome =
    event === 'payment.captured'
      ? PAYMENT_STATUS.SUCCESSFUL
      : event === 'payment.failed'
        ? PAYMENT_STATUS.FAILED
        : null;

  if (!outcome) return res.json({ success: true, message: `Ignored — ${event}` });

  try {
    await settle({
      paymentId: payment.id,
      outcome,
      gatewayPaymentId: entity.id,
      // The signature has already been verified over the whole body; the
      // per-payment check would be a second, weaker test of the same fact.
      signature: undefined,
      trusted: true,
    });
  } catch (error) {
    logger.error(`Webhook settlement failed for ${payment.id}:`, error.message);
  }

  return res.json({ success: true, message: 'Processed' });
});

export default handleWebhook;
