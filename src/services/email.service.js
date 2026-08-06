import nodemailer from 'nodemailer';
import { query, queryOne } from '../database/index.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Transactional email.
 *
 * Templates live in the database because the settings screen edits them, and
 * an administrator can switch any of them off — which this respects. When SMTP
 * is not configured the message is rendered and logged instead of sent, so a
 * development machine exercises the whole path without needing a mail server.
 */

let transport = null;

const getTransport = () => {
  if (env.mail.previewOnly) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: env.mail.user ? { user: env.mail.user, pass: env.mail.pass } : undefined,
    });
  }
  return transport;
};

/** `{{name}}` → value. Unknown placeholders are left untouched, not blanked. */
const render = (template, variables) =>
  String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) =>
    variables[key] === undefined || variables[key] === null ? match : String(variables[key]),
  );

const logDelivery = (to, subject, template, status, error) =>
  query(
    `INSERT INTO email_log (to_email, subject, template, status, error) VALUES ($1,$2,$3,$4,$5)`,
    [to, subject, template ?? null, status, error ?? null],
  ).catch((failure) => logger.error('Could not write to the email log:', failure.message));

/**
 * Sends one of the six configured templates.
 * Returns `false` when the template is switched off — never throws, because a
 * mail failure must not roll back the payment or registration that caused it.
 */
export async function sendTemplate(key, to, variables = {}) {
  try {
    const template = await queryOne(
      `SELECT key, subject, body, enabled FROM email_templates WHERE key = $1`,
      [key],
    );

    if (!template) {
      logger.warn(`Email template '${key}' is not configured`);
      return false;
    }
    if (!template.enabled) {
      await logDelivery(to, key, key, 'skipped', 'Template disabled by an administrator');
      return false;
    }

    const subject = render(template.subject, variables);
    const body = render(template.body, variables);
    const mailer = getTransport();

    if (!mailer) {
      logger.info(`[email:preview] to=${to} subject=${subject}\n${body}\n`);
      await logDelivery(to, subject, key, 'skipped', 'SMTP not configured — preview only');
      return true;
    }

    await mailer.sendMail({
      from: `"${env.mail.fromName}" <${env.mail.fromAddress}>`,
      to,
      subject,
      text: body,
      html: `<pre style="font:14px/1.6 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
    });

    await logDelivery(to, subject, key, 'sent');
    return true;
  } catch (error) {
    logger.error(`Email '${key}' to ${to} failed:`, error.message);
    await logDelivery(to, key, key, 'failed', error.message);
    return false;
  }
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export default { sendTemplate };
