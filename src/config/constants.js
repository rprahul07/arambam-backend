/**
 * Vocabulary shared by the database, the API and the front end.
 *
 * Every value here is exactly what `arambham-frontend/src/types/index.ts`
 * declares. The front end is the contract: nothing in this file may drift
 * from it without the interface breaking.
 */

/* ------------------------------------------------------------------ roles */

export const ROLES = {
  ADMIN: 'administrator',
  ORGANIZER: 'organizer',
  MEMBER: 'member',
};

export const ROLE_VALUES = Object.values(ROLES);

/* --------------------------------------------------------------- accounts */

export const ACCOUNT_STATUS = { ACTIVE: 'active', INACTIVE: 'inactive' };
export const ACCOUNT_STATUS_VALUES = Object.values(ACCOUNT_STATUS);

/* ---------------------------------------------------------------- members */

export const MEMBERSHIP_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  PENDING: 'pending',
  SUSPENDED: 'suspended',
};
export const MEMBERSHIP_STATUS_VALUES = Object.values(MEMBERSHIP_STATUS);

export const GENDER_VALUES = ['male', 'female', 'other'];
export const ID_PROOF_VALUES = ['aadhaar', 'voter_id', 'driving_licence'];
export const GUARDIAN_RELATION_VALUES = ['father', 'mother', 'guardian'];

/** Under this age the guardian block on the registration form is required. */
export const MINOR_AGE = 18;

/* ---------------------------------------------------------- subscriptions */

export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  /** Paid for, but its term has not started yet. */
  SCHEDULED: 'scheduled',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  PENDING: 'pending',
};
export const SUBSCRIPTION_STATUS_VALUES = Object.values(SUBSCRIPTION_STATUS);

/** Statuses that mean the member has paid for that period. */
export const SUBSCRIPTION_PAID_STATUSES = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.SCHEDULED,
];

export const SUBSCRIPTION_KIND = {
  NEW: 'new',
  RENEWAL: 'renewal',
  UPGRADE: 'upgrade',
  DOWNGRADE: 'downgrade',
};
export const SUBSCRIPTION_KIND_VALUES = Object.values(SUBSCRIPTION_KIND);

/* ----------------------------------------------------------------- events */

export const EVENT_LIFECYCLE = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
};
export const EVENT_LIFECYCLE_VALUES = Object.values(EVENT_LIFECYCLE);

export const EVENT_TYPE_VALUES = ['free', 'paid'];

/** Below this proportion of free seats an event reads as "few seats left". */
export const FEW_SEATS_THRESHOLD = 0.12;

/* ---------------------------------------------------------- registrations */

export const REGISTRATION_STATUS = {
  CONFIRMED: 'confirmed',
  PENDING_PAYMENT: 'pending_payment',
  CANCELLED: 'cancelled',
};
export const REGISTRATION_STATUS_VALUES = Object.values(REGISTRATION_STATUS);

/** A seat is held by both of these; only a cancellation releases it. */
export const OCCUPYING_STATUSES = [
  REGISTRATION_STATUS.CONFIRMED,
  REGISTRATION_STATUS.PENDING_PAYMENT,
];

export const ATTENDANCE = {
  NOT_CHECKED_IN: 'not_checked_in',
  ATTENDED: 'attended',
  ABSENT: 'absent',
};
export const ATTENDANCE_VALUES = Object.values(ATTENDANCE);

/* --------------------------------------------------------------- payments */

export const PAYMENT_STATUS = {
  SUCCESSFUL: 'successful',
  PENDING: 'pending',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS);

export const PAYMENT_PURPOSE = { MEMBERSHIP: 'membership', EVENT: 'event' };
export const PAYMENT_PURPOSE_VALUES = Object.values(PAYMENT_PURPOSE);

export const PAYMENT_METHOD_VALUES = ['upi', 'card', 'netbanking', 'wallet'];

/* ---------------------------------------------------------- notifications */

export const NOTIFICATION_TYPE_VALUES = [
  'account_registered',
  'email_verification',
  'payment_confirmation',
  'event_registration',
  'event_reminder',
  'membership_activated',
  'membership_upgraded',
  'membership_renewal_due',
  'event_cancelled',
  'event_rescheduled',
];

/* --------------------------------------------------------------- settings */

export const EMAIL_TEMPLATE_KEYS = [
  'account_registration',
  'payment_confirmation',
  'event_confirmation',
  'event_reminder',
  'renewal_reminder',
  'event_cancellation',
];

export const SETTINGS_KEYS = { ORGANISATION: 'organisation' };

/* ---------------------------------------------------------- miscellaneous */

/** Renewal nudges begin this many days before a membership lapses. */
export const RENEWAL_WINDOW_DAYS = 30;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

export default {
  ROLES,
  ROLE_VALUES,
  ACCOUNT_STATUS,
  MEMBERSHIP_STATUS,
  EVENT_LIFECYCLE,
  REGISTRATION_STATUS,
  PAYMENT_STATUS,
  PAYMENT_PURPOSE,
  ATTENDANCE,
  OCCUPYING_STATUSES,
};
