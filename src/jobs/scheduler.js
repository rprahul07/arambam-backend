import cron from 'node-cron';
import { queryAll, query } from '../database/index.js';
import env from '../config/env.js';
import { RENEWAL_WINDOW_DAYS } from '../config/constants.js';
import { releaseExpiredHolds } from '../modules/registrations/registrations.service.js';
import { releaseAbandonedPurchases } from '../modules/subscriptions/subscriptions.js';
import { pushMany } from '../services/notification.service.js';
import { sendTemplate } from '../services/email.service.js';
import logger from '../utils/logger.js';

/**
 * Scheduled work.
 *
 * Each job is written so that running it twice changes nothing the second
 * time — a `reminder_sent_at` stamp or a status transition guards every one.
 * That is what makes them safe on a host that restarts, or on two instances.
 */

const tasks = [];

/** Frees seats, and closes memberships, whose payment never completed. */
const holdSweep = async () => {
  const released = await releaseExpiredHolds();
  if (released) logger.info(`Seat sweep released ${released} holds`);

  const abandoned = await releaseAbandonedPurchases();
  if (abandoned) logger.info(`Closed ${abandoned} abandoned membership purchases`);
};

/** Moves finished events and lapsed memberships into their end state. */
const lapseSweep = async () => {
  const events = await query(
    `UPDATE events SET lifecycle = 'completed'
     WHERE lifecycle = 'published'
       AND (date + end_time::time) < (now() AT TIME ZONE 'UTC')
     RETURNING id`,
  );

  const subscriptions = await query(
    `UPDATE subscriptions SET status = 'expired'
     WHERE status = 'active' AND end_date < CURRENT_DATE
     RETURNING id, member_id`,
  );

  // A term that has come round is promoted before anyone is marked lapsed, so
  // a member who renewed early never spends an hour reading as expired.
  const promoted = await query(
    `UPDATE subscriptions SET status = 'active'
     WHERE status = 'scheduled'
       AND start_date <= CURRENT_DATE
       AND end_date >= CURRENT_DATE
       AND NOT EXISTS (
         SELECT 1 FROM subscriptions other
         WHERE other.member_id = subscriptions.member_id
           AND other.status = 'active'
           AND other.end_date >= CURRENT_DATE
       )
     RETURNING id, member_id`,
  );

  if (promoted.rowCount) {
    await query(
      `UPDATE members m SET status = 'active', current_subscription_id = s.id
       FROM subscriptions s
       WHERE s.member_id = m.id AND s.status = 'active' AND s.end_date >= CURRENT_DATE
         AND (m.current_subscription_id IS DISTINCT FROM s.id)`,
    );
  }

  // Only members with nothing left to run are lapsed.
  if (subscriptions.rowCount) {
    await query(
      `UPDATE members m SET status = 'expired', current_subscription_id = NULL
       WHERE m.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.member_id = m.id
             AND s.status IN ('active','scheduled')
             AND s.end_date >= CURRENT_DATE
         )`,
    );
  }

  if (events.rowCount || subscriptions.rowCount || promoted.rowCount) {
    logger.info(
      `Lapse sweep: ${events.rowCount} events completed, ${subscriptions.rowCount} memberships expired, ` +
        `${promoted.rowCount} promoted from scheduled`,
    );
  }
};

/** Nudges members whose membership is about to lapse. */
const renewalReminders = async () => {
  const rows = await queryAll(
    `SELECT s.id, s.end_date, m.user_id, m.email, m.full_name, p.name AS plan_name,
            (s.end_date - CURRENT_DATE) AS days_remaining
     FROM subscriptions s
     JOIN members m           ON m.id = s.member_id
     JOIN membership_plans p  ON p.id = s.plan_id
     WHERE s.status = 'active'
       AND s.end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + $1::int)
       AND s.reminder_sent_at IS NULL
       -- Nobody who has already renewed should be told to renew.
       AND NOT EXISTS (
         SELECT 1 FROM subscriptions queued
         WHERE queued.member_id = s.member_id AND queued.status = 'scheduled'
       )`,
    [RENEWAL_WINDOW_DAYS],
  );
  if (!rows.length) return;

  await pushMany({
    recipients: rows.map((row) => ({
      userId: row.user_id,
      type: 'membership_renewal_due',
      title: 'Your membership ends soon',
      body: `Your ${row.plan_name} membership is valid until ${row.end_date}. Renew any time before then to keep member pricing.`,
      href: '/member/membership',
    })),
  });

  for (const row of rows) {
    await sendTemplate('renewal_reminder', row.email, {
      member_name: row.full_name,
      plan_name: row.plan_name,
      expiry_date: row.end_date,
      days_remaining: row.days_remaining,
      renewal_link: `${env.clientUrl}/member/membership`,
    });
  }

  await query(`UPDATE subscriptions SET reminder_sent_at = now() WHERE id = ANY($1)`, [
    rows.map((row) => row.id),
  ]);
  logger.info(`Sent ${rows.length} renewal reminders`);
};

/** Reminds everyone holding a ticket for tomorrow. */
const eventReminders = async () => {
  const events = await queryAll(
    `SELECT * FROM events
     WHERE lifecycle = 'published'
       AND reminder_sent_at IS NULL
       AND (date + start_time::time) BETWEEN (now() AT TIME ZONE 'UTC')
                                         AND ((now() AT TIME ZONE 'UTC') + ($1 || ' hours')::interval)`,
    [String(env.jobs.eventReminderHours)],
  );
  if (!events.length) return;

  for (const event of events) {
    const attendees = await queryAll(
      `SELECT r.reference, r.participant_name, m.user_id, m.email
       FROM registrations r
       JOIN members m ON m.id = r.member_id
       WHERE r.event_id = $1 AND r.status = 'confirmed'`,
      [event.id],
    );

    if (attendees.length) {
      await pushMany({
        recipients: attendees.map((row) => ({
          userId: row.user_id,
          type: 'event_reminder',
          title: `${event.title} is coming up`,
          body: `${event.date} at ${event.start_time}, ${event.venue_name}. Your ticket is ready.`,
          href: '/member/tickets',
        })),
      });

      for (const row of attendees) {
        await sendTemplate('event_reminder', row.email, {
          participant_name: row.participant_name,
          event_title: event.title,
          event_time: `${event.start_time}–${event.end_time}`,
          venue_name: event.venue_name,
          venue_address: event.venue_address,
          registration_reference: row.reference,
        });
      }
    }

    await query(`UPDATE events SET reminder_sent_at = now() WHERE id = $1`, [event.id]);
    logger.info(`Reminded ${attendees.length} people about "${event.title}"`);
  }
};

/** Deletes refresh tokens that can no longer be used for anything. */
const tokenSweep = async () => {
  const { rowCount } = await query(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - INTERVAL '30 days'`,
  );
  if (rowCount) logger.info(`Purged ${rowCount} expired refresh tokens`);
};

const guard = (name, job) => async () => {
  try {
    await job();
  } catch (error) {
    logger.error(`Job '${name}' failed:`, error.message);
  }
};

const schedule = (name, expression, job) => {
  tasks.push(cron.schedule(expression, guard(name, job)));
};

export function startJobs() {
  if (!env.jobs.enabled) {
    logger.info('Scheduled jobs are switched off (ENABLE_CRON=false)');
    return;
  }

  schedule('seat-holds', '*/5 * * * *', holdSweep); // every 5 minutes
  schedule('lapse-sweep', '10 * * * *', lapseSweep); // hourly, at :10
  schedule('renewal-reminders', '0 9 * * *', renewalReminders); // 09:00 daily
  schedule('event-reminders', '0 * * * *', eventReminders); // hourly
  schedule('token-sweep', '30 3 * * *', tokenSweep); // 03:30 daily

  logger.info(`Started ${tasks.length} scheduled jobs`);
}

export function stopJobs() {
  for (const task of tasks) task.stop();
  tasks.length = 0;
}

export default { startJobs, stopJobs };
