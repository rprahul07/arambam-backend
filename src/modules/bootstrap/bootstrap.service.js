import { queryAll, queryOne } from '../../database/index.js';
import { ROLES, SETTINGS_KEYS } from '../../config/constants.js';
import {
  toCategory,
  toEmailTemplate,
  toEvent,
  toMember,
  toMemberCounter,
  toNotification,
  toOrganisation,
  toPayment,
  toPlan,
  toPublicUser,
  toRegistration,
  toRegistrationCounter,
  toSubscription,
  toUser,
} from '../../serializers/index.js';

/**
 * The application snapshot.
 *
 * The interface derives everything it shows — seat counts, event status,
 * revenue splits, the twelve-month chart, the community counters — from whole
 * collections held in one client-side store. This endpoint is that store,
 * assembled server-side and cut to what the caller is allowed to know.
 *
 * The cut is the interesting part. A visitor has to be told "12 of 60 seats
 * remain" and "1,240 members", which means counting rows they may not read.
 * Rather than exposing those rows or inventing a parallel statistics API the
 * interface does not call, non-staff callers receive their own records in full
 * and *counters* for everyone else's: an id, a status, a date, and blanks in
 * every field that identifies a person. Counting works; reading does not.
 */

const ORDERED = {
  users: `SELECT * FROM users ORDER BY created_at DESC`,
  members: `SELECT * FROM members ORDER BY joined_at DESC`,
  events: `SELECT * FROM events ORDER BY date DESC`,
  categories: `SELECT * FROM event_categories ORDER BY name`,
  plans: `SELECT * FROM membership_plans ORDER BY sort_order, name`,
  templates: `SELECT * FROM email_templates ORDER BY sort_order, key`,
};

const STAFF_ROLES = [ROLES.ADMIN, ROLES.ORGANIZER];

/** Organiser names appear on event cards, so staff identities are public. */
const staffUsers = () =>
  queryAll(`SELECT * FROM users WHERE role = ANY($1) ORDER BY created_at`, [STAFF_ROLES]);

const organisationSettings = async () => {
  const row = await queryOne(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEYS.ORGANISATION]);
  return toOrganisation(row?.value ?? {});
};

/** The accounts behind the three demonstration buttons on the sign-in screen. */
const demoAccounts = async () => {
  const rows = await queryAll(
    `SELECT u.id, u.role, u.created_at, m.id AS member_id
     FROM users u
     LEFT JOIN members m ON m.user_id = u.id
     WHERE u.status = 'active' AND u.email_verified = true
     ORDER BY u.created_at`,
  );
  const byRole = (role) => rows.filter((row) => row.role === role);
  const organizers = byRole(ROLES.ORGANIZER);
  const member = byRole(ROLES.MEMBER).find((row) => row.member_id) ?? byRole(ROLES.MEMBER)[0];

  return {
    adminUserId: byRole(ROLES.ADMIN)[0]?.id ?? '',
    organizerUserId: organizers[0]?.id ?? '',
    secondOrganizerUserId: organizers[1]?.id ?? organizers[0]?.id ?? '',
    memberUserId: member?.id ?? '',
    memberId: member?.member_id ?? '',
  };
};

/** Shared by every scope: the catalogue and the organisation profile. */
async function commonCatalogue() {
  const [categories, plans, organisation, emailTemplates, demo] = await Promise.all([
    queryAll(ORDERED.categories),
    queryAll(ORDERED.plans),
    organisationSettings(),
    queryAll(ORDERED.templates),
    demoAccounts(),
  ]);

  return {
    categories: categories.map(toCategory),
    plans: plans.map(toPlan),
    organisation,
    emailTemplates: emailTemplates.map(toEmailTemplate),
    demo,
  };
}

const notificationsFor = async (userId) =>
  userId
    ? (
        await queryAll(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [
          userId,
        ])
      ).map(toNotification)
    : [];

/* --------------------------------------------------------------- the scopes */

async function administratorScope(user) {
  const [users, members, subscriptions, events, registrations, payments, notifications, organizerRows] =
    await Promise.all([
      queryAll(ORDERED.users),
      queryAll(ORDERED.members),
      queryAll(`SELECT * FROM subscriptions ORDER BY created_at DESC`),
      queryAll(ORDERED.events),
      queryAll(`SELECT * FROM registrations ORDER BY registered_at DESC`),
      queryAll(`SELECT * FROM payments ORDER BY created_at DESC`),
      notificationsFor(user.id),
      queryAll(`SELECT organizer_id, id FROM events WHERE organizer_id IS NOT NULL`),
    ]);

  const assigned = new Map();
  for (const row of organizerRows) {
    if (!assigned.has(row.organizer_id)) assigned.set(row.organizer_id, []);
    assigned.get(row.organizer_id).push(row.id);
  }

  return {
    users: users.map((row) =>
      toUser(row, {
        assignedEventIds: row.role === ROLES.ORGANIZER ? (assigned.get(row.id) ?? []) : undefined,
      }),
    ),
    members: members.map(toMember),
    subscriptions: subscriptions.map(toSubscription),
    events: events.map(toEvent),
    registrations: registrations.map(toRegistration),
    payments: payments.map(toPayment),
    notifications,
  };
}

async function organizerScope(user) {
  const [staff, ownEventRows, allEvents, members, allRegistrations, notifications] = await Promise.all([
    staffUsers(),
    queryAll(`SELECT id FROM events WHERE organizer_id = $1`, [user.id]),
    queryAll(`SELECT * FROM events WHERE lifecycle <> 'draft' OR organizer_id = $1 ORDER BY date DESC`, [
      user.id,
    ]),
    queryAll(ORDERED.members),
    queryAll(`SELECT * FROM registrations ORDER BY registered_at DESC`),
    notificationsFor(user.id),
  ]);

  const ownEventIds = new Set(ownEventRows.map((row) => row.id));

  // The door list for an event this organiser runs — name, member id, phone —
  // is theirs to see. Every other event's seats are counters only.
  const visibleRegistrations = [];
  const visibleMemberIds = new Set();
  for (const row of allRegistrations) {
    if (ownEventIds.has(row.event_id)) {
      visibleRegistrations.push(toRegistration(row));
      visibleMemberIds.add(row.member_id);
    } else {
      visibleRegistrations.push(toRegistrationCounter(row));
    }
  }

  const registrationIds = allRegistrations
    .filter((row) => ownEventIds.has(row.event_id) && row.payment_id)
    .map((row) => row.id);

  const payments = registrationIds.length
    ? await queryAll(
        `SELECT * FROM payments WHERE registration_id = ANY($1) ORDER BY created_at DESC`,
        [registrationIds],
      )
    : [];

  const self = members.find((row) => row.user_id === user.id);
  if (self) visibleMemberIds.add(self.id);

  return {
    users: staff.map((row) =>
      row.id === user.id
        ? toUser(row, { assignedEventIds: [...ownEventIds] })
        : toPublicUser(row),
    ),
    members: members.map((row) => (visibleMemberIds.has(row.id) ? toMember(row) : toMemberCounter(row))),
    subscriptions: [],
    events: allEvents.map(toEvent),
    registrations: visibleRegistrations,
    payments: payments.map(toPayment),
    notifications,
  };
}

async function memberScope(user) {
  const memberRow = await queryOne(`SELECT * FROM members WHERE user_id = $1`, [user.id]);
  const memberId = memberRow?.id ?? null;

  const [staff, members, events, registrations, notifications] = await Promise.all([
    staffUsers(),
    queryAll(`SELECT id, status, joined_at FROM members ORDER BY joined_at DESC`),
    queryAll(`SELECT * FROM events WHERE lifecycle <> 'draft' ORDER BY date DESC`),
    queryAll(`SELECT * FROM registrations ORDER BY registered_at DESC`),
    notificationsFor(user.id),
  ]);

  const [subscriptions, payments] = memberId
    ? await Promise.all([
        queryAll(`SELECT * FROM subscriptions WHERE member_id = $1 ORDER BY created_at DESC`, [memberId]),
        queryAll(`SELECT * FROM payments WHERE member_id = $1 ORDER BY created_at DESC`, [memberId]),
      ])
    : [[], []];

  return {
    users: [toUser(user), ...staff.filter((row) => row.id !== user.id).map(toPublicUser)],
    members: members.map((row) =>
      row.id === memberId ? toMember(memberRow) : toMemberCounter(row),
    ),
    subscriptions: subscriptions.map(toSubscription),
    events: events.map(toEvent),
    registrations: registrations.map((row) =>
      row.member_id === memberId ? toRegistration(row) : toRegistrationCounter(row),
    ),
    payments: payments.map(toPayment),
    notifications,
  };
}

async function anonymousScope() {
  const [staff, members, events, registrations] = await Promise.all([
    staffUsers(),
    queryAll(`SELECT id, status, joined_at FROM members ORDER BY joined_at DESC`),
    queryAll(`SELECT * FROM events WHERE lifecycle <> 'draft' ORDER BY date DESC`),
    queryAll(
      `SELECT id, event_id, status, attendance, registered_at FROM registrations ORDER BY registered_at DESC`,
    ),
  ]);

  return {
    users: staff.map(toPublicUser),
    members: members.map(toMemberCounter),
    subscriptions: [],
    events: events.map(toEvent),
    registrations: registrations.map(toRegistrationCounter),
    payments: [],
    notifications: [],
  };
}

/** Builds the snapshot for whoever is calling. */
export async function snapshot(user) {
  const [catalogue, scoped] = await Promise.all([
    commonCatalogue(),
    !user
      ? anonymousScope()
      : user.role === ROLES.ADMIN
        ? administratorScope(user)
        : user.role === ROLES.ORGANIZER
          ? organizerScope(user)
          : memberScope(user),
  ]);

  return {
    ...scoped,
    ...catalogue,
    scope: user?.role ?? 'public',
    serverTime: new Date().toISOString(),
  };
}

export default { snapshot };
