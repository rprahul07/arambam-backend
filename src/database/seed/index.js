import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import db from '../index.js';
import { migrate, reset } from '../migrate.js';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import { hashPassword } from '../../utils/password.js';
import { EMAIL_TEMPLATES, EVENT_CATEGORIES, MEMBERSHIP_PLANS, ORGANISATION } from './catalog.js';
import { buildDatabase } from './generate.js';

/**
 * Seeds the database with the demonstration community.
 *
 * Everything comes from the generator ported from the front end, so a freshly
 * seeded API serves exactly the events, members and history the prototype
 * showed. The one difference is that it is now real: the rows have foreign
 * keys, the payments have receipts, and signing in actually authenticates.
 *
 * Every seeded account shares one password (SEED_PASSWORD, default
 * `Aarambam@2026`) so the demonstration can be driven by hand as well as by
 * the one-click role buttons.
 */

/** Multi-row INSERT in chunks — one round trip per chunk rather than per row. */
async function insertMany(table, columns, rows, { chunk = 250, casts = {} } = {}) {
  if (!rows.length) return 0;
  let written = 0;

  for (let start = 0; start < rows.length; start += chunk) {
    const slice = rows.slice(start, start + chunk);
    const params = [];
    const tuples = slice.map((row) => {
      const placeholders = columns.map((column) => {
        params.push(row[column] ?? null);
        return casts[column] ? `$${params.length}${casts[column]}` : `$${params.length}`;
      });
      return `(${placeholders.join(',')})`;
    });

    await db.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,
      params,
    );
    written += slice.length;
  }
  return written;
}

export async function seed({ fresh = true, minimal = false } = {}) {
  const started = Date.now();

  if (fresh) {
    await reset();
    await migrate();
  }

  const data = buildDatabase();

  if (minimal) {
    const coreEmails = new Set([
      'revathi@aarambam.org',
      'aravind@aarambam.org',
      'senthil@aarambam.org',
      'divya.bharathi@gmail.com',
    ]);
    data.users = data.users.filter((u) => coreEmails.has(u.email));
    data.members = data.members.filter((m) => {
      if (coreEmails.has(m.email)) {
        delete m.currentSubscriptionId;
        return true;
      }
      return false;
    });
    data.subscriptions = [];
    data.events = [];
    data.registrations = [];
    data.payments = [];
    data.notifications = [];
  }

  const passwordHash = await hashPassword(env.seedPassword);

  /* --------------------------------------------------------- categories */

  const categoryIds = new Map();
  await insertMany(
    'event_categories',
    ['id', 'name', 'slug', 'description', 'color', 'active'],
    EVENT_CATEGORIES.map((category) => {
      const uuid = crypto.randomUUID();
      categoryIds.set(category.id, uuid);
      return { ...category, id: uuid };
    }),
  );

  /* -------------------------------------------------------------- plans */

  const planIds = new Map();
  await insertMany(
    'membership_plans',
    ['id', 'name', 'description', 'price', 'duration_months', 'benefits', 'active', 'recommended', 'sort_order'],
    MEMBERSHIP_PLANS.map((plan) => {
      const uuid = crypto.randomUUID();
      planIds.set(plan.id, uuid);
      return {
        id: uuid,
        name: plan.name,
        description: plan.description,
        price: plan.price,
        duration_months: plan.durationMonths,
        benefits: JSON.stringify(plan.benefits),
        active: plan.active,
        recommended: Boolean(plan.recommended),
        sort_order: plan.sortOrder,
      };
    }),
    { casts: { benefits: '::jsonb' } },
  );

  /* -------------------------------------------------------------- users */

  await insertMany(
    'users',
    ['id', 'name', 'email', 'phone', 'password_hash', 'role', 'status', 'email_verified', 'last_login_at', 'created_at'],
    data.users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      password_hash: passwordHash,
      role: user.role,
      status: user.status,
      email_verified: user.emailVerified,
      last_login_at: user.lastLoginAt ?? null,
      created_at: user.createdAt,
    })),
  );

  /* ------------------------------------------------------------ members */

  await insertMany(
    'members',
    [
      'id', 'user_id', 'member_id', 'full_name', 'age', 'date_of_birth', 'gender',
      'email', 'phone', 'whatsapp_number', 'whatsapp_group_consent',
      'address_line1', 'address_line2', 'city', 'district', 'state', 'pincode',
      'guardian_name', 'guardian_relation', 'guardian_phone',
      'id_proof_type', 'id_proof_number', 'has_medical_conditions', 'medical_notes',
      'media_consent', 'declaration_accepted', 'status', 'joined_at', 'created_at',
    ],
    data.members.map((member) => ({
      id: member.id,
      user_id: member.userId,
      member_id: member.memberId,
      full_name: member.fullName,
      age: member.age,
      date_of_birth: member.dateOfBirth ?? null,
      gender: member.gender,
      email: member.email,
      phone: member.phone,
      whatsapp_number: member.whatsappNumber,
      whatsapp_group_consent: member.whatsappGroupConsent,
      address_line1: member.addressLine1,
      address_line2: member.addressLine2 ?? null,
      city: member.city,
      district: member.district,
      state: member.state,
      pincode: member.pincode,
      guardian_name: member.guardianName ?? null,
      guardian_relation: member.guardianRelation ?? null,
      guardian_phone: member.guardianPhone ?? null,
      id_proof_type: member.idProofType,
      id_proof_number: member.idProofNumber,
      has_medical_conditions: member.hasMedicalConditions,
      medical_notes: member.medicalNotes ?? null,
      media_consent: member.mediaConsent,
      declaration_accepted: member.declarationAccepted,
      status: member.status,
      joined_at: member.joinedAt,
      created_at: member.joinedAt,
    })),
  );

  /* ------------------------------------------------------ subscriptions */
  // Written without their payment reference: the payment rows do not exist yet.

  await insertMany(
    'subscriptions',
    ['id', 'member_id', 'plan_id', 'start_date', 'end_date', 'amount', 'status', 'kind', 'created_at'],
    data.subscriptions.map((sub) => ({
      id: sub.id,
      member_id: sub.memberId,
      plan_id: planIds.get(sub.planId),
      start_date: sub.startDate,
      end_date: sub.endDate,
      amount: sub.amount,
      status: sub.status,
      kind: sub.kind,
      created_at: sub.createdAt,
    })),
  );

  /* ------------------------------------------------------------- events */

  await insertMany(
    'events',
    [
      'id', 'slug', 'title', 'summary', 'description', 'category_id',
      'venue_name', 'venue_address', 'city', 'date', 'start_time', 'end_time',
      'registration_opens_at', 'registration_closes_at', 'capacity', 'lifecycle',
      'type', 'member_price', 'non_member_price', 'organizer_id',
      'published_at', 'cancellation_reason', 'created_at',
    ],
    data.events.map((event) => ({
      id: event.id,
      slug: event.slug,
      title: event.title,
      summary: event.summary,
      description: event.description,
      category_id: categoryIds.get(event.categoryId),
      venue_name: event.venueName,
      venue_address: event.venueAddress,
      city: event.city,
      date: event.date,
      start_time: event.startTime,
      end_time: event.endTime,
      registration_opens_at: event.registrationOpensAt,
      registration_closes_at: event.registrationClosesAt,
      capacity: event.capacity,
      lifecycle: event.lifecycle,
      type: event.type,
      member_price: event.memberPrice,
      non_member_price: event.nonMemberPrice,
      organizer_id: event.organizerId,
      published_at: event.publishedAt ?? null,
      cancellation_reason: event.cancellationReason ?? null,
      created_at: event.createdAt,
    })),
  );

  /* ------------------------------------------------------ registrations */

  await insertMany(
    'registrations',
    [
      'id', 'reference', 'event_id', 'member_id', 'participant_name', 'ticket_code',
      'status', 'attendance', 'priced_as_member', 'amount', 'registered_at',
      'checked_in_at', 'cancelled_at', 'cancellation_reason', 'created_at',
    ],
    data.registrations.map((registration) => ({
      id: registration.id,
      reference: registration.reference,
      event_id: registration.eventId,
      member_id: registration.memberId,
      participant_name: registration.participantName,
      ticket_code: registration.ticketCode,
      status: registration.status,
      attendance: registration.attendance,
      priced_as_member: registration.pricedAsMember,
      amount: registration.amount,
      registered_at: registration.registeredAt,
      checked_in_at: registration.checkedInAt ?? null,
      cancelled_at: registration.cancelledAt ?? null,
      cancellation_reason: registration.cancellationReason ?? null,
      created_at: registration.registeredAt,
    })),
  );

  /* ----------------------------------------------------------- payments */

  await insertMany(
    'payments',
    [
      'id', 'reference', 'receipt_no', 'member_id', 'payer_name', 'purpose',
      'subscription_id', 'registration_id', 'description', 'amount', 'method',
      'status', 'gateway', 'failure_reason', 'completed_at', 'created_at',
    ],
    data.payments.map((payment) => ({
      id: payment.id,
      reference: payment.reference,
      receipt_no: payment.receiptNo ?? null,
      member_id: payment.memberId,
      payer_name: payment.payerName,
      purpose: payment.purpose,
      subscription_id: payment.subscriptionId ?? null,
      registration_id: payment.registrationId ?? null,
      description: payment.description,
      amount: payment.amount,
      method: payment.method,
      status: payment.status,
      gateway: 'simulated',
      failure_reason: payment.failureReason ?? null,
      completed_at: payment.completedAt ?? null,
      created_at: payment.createdAt,
    })),
  );

  /* ------------------------------------------- the circular back-references */

  await db.query(
    `UPDATE subscriptions s SET payment_id = p.id
     FROM payments p WHERE p.subscription_id = s.id`,
  );
  await db.query(
    `UPDATE registrations r SET payment_id = p.id
     FROM payments p WHERE p.registration_id = r.id`,
  );

  const currentSubscriptions = data.members
    .filter((member) => member.currentSubscriptionId)
    .map((member) => ({ id: member.id, sub: member.currentSubscriptionId }));

  for (let start = 0; start < currentSubscriptions.length; start += 200) {
    const slice = currentSubscriptions.slice(start, start + 200);
    const params = [];
    const values = slice
      .map((row) => {
        params.push(row.id, row.sub);
        return `($${params.length - 1}::uuid, $${params.length}::uuid)`;
      })
      .join(',');
    await db.query(
      `UPDATE members m SET current_subscription_id = v.sub
       FROM (VALUES ${values}) AS v(id, sub) WHERE m.id = v.id`,
      params,
    );
  }

  /* ------------------------------------------------------ notifications */

  await insertMany(
    'notifications',
    ['id', 'user_id', 'type', 'title', 'body', 'href', 'read', 'read_at', 'created_at'],
    data.notifications.map((notification) => ({
      id: notification.id,
      user_id: notification.userId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      href: notification.href ?? null,
      read: notification.read,
      read_at: notification.read ? notification.createdAt : null,
      created_at: notification.createdAt,
    })),
  );

  /* ---------------------------------------------------------- settings */

  await db.query(
    `INSERT INTO settings (key, value) VALUES ('organisation', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(ORGANISATION)],
  );

  await insertMany(
    'email_templates',
    ['key', 'name', 'description', 'subject', 'body', 'enabled', 'variables', 'sort_order'],
    EMAIL_TEMPLATES.map((template, index) => ({
      key: template.key,
      name: template.name,
      description: template.description,
      subject: template.subject,
      body: template.body,
      enabled: template.enabled,
      variables: JSON.stringify(template.variables),
      sort_order: index,
    })),
    { casts: { variables: '::jsonb' } },
  );

  /* ------------------------------------------------- sequence alignment */
  // The generator has already used a range of member numbers, receipt numbers
  // and booking references. Move the sequences past them so the first record
  // created through the API does not collide with a seeded one.

  await db.query(`SELECT setval('member_number_seq', $1::bigint, false)`, [data.nextMemberNumber]);
  await db.query(`SELECT setval('registration_ref_seq', $1::bigint, false)`, [
    data.registrations.length + 1,
  ]);
  await db.query(`SELECT setval('receipt_no_seq', $1::bigint, false)`, [data.payments.length + 1]);

  const summary = {
    users: data.users.length,
    members: data.members.length,
    subscriptions: data.subscriptions.length,
    events: data.events.length,
    registrations: data.registrations.length,
    payments: data.payments.length,
    notifications: data.notifications.length,
    categories: EVENT_CATEGORIES.length,
    plans: MEMBERSHIP_PLANS.length,
  };

  logger.info(`Seeded in ${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(summary));
  return { ...summary, demo: data.demo };
}

async function main() {
  await db.connect();
  const minimal = process.argv.includes('--minimal');
  const result = await seed({ fresh: !process.argv.includes('--append'), minimal });

  const accounts = await db.queryAll(
    `SELECT role, email FROM users ORDER BY role, email`,
  );

  logger.info('Sign in with any of these, password: ' + env.seedPassword);
  for (const account of accounts) logger.info(`  ${account.role.padEnd(14)} ${account.email}`);

  await db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('Seeding failed:', error.stack || error.message);
      process.exit(1);
    });
}

export default { seed };
