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
/**
 * A PAN, as printed: five letters, four digits, a letter.
 *
 * The only identity document asked for now, and it is optional. Aadhaar, Voter
 * ID and Driving Licence were dropped at the organisation's request — along
 * with the numbers already collected, which is why there is no `ID_PROOF_*`
 * here any more rather than an unused constant left behind.
 */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
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
  /** Paid outside the system; a reference is quoted and awaits checking. */
  AWAITING_VERIFICATION: 'awaiting_verification',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS);

export const PAYMENT_PURPOSE = { MEMBERSHIP: 'membership', EVENT: 'event' };
export const PAYMENT_PURPOSE_VALUES = Object.values(PAYMENT_PURPOSE);

export const PAYMENT_METHOD_VALUES = [
  'upi',
  'card',
  'netbanking',
  'wallet',
  /** A QR scanned and paid in any UPI app. */
  'qr_upi',
];

/** Methods settled by a person checking a bank statement, not a gateway. */
export const OFFLINE_PAYMENT_METHODS = ['qr_upi'];

/**
 * Whose QR an event's money is collected on.
 *
 *   trust — the Trust's own QR, set in administrator settings
 *   own   — a QR the facilitator uploaded for this event
 *
 * Membership income is never a facilitator's, so it always uses the Trust's.
 */
export const EVENT_QR_MODE = { TRUST: 'trust', OWN: 'own' };
export const EVENT_QR_MODE_VALUES = Object.values(EVENT_QR_MODE);

/**
 * How long a seat or membership is held while a payment made outside the
 * system is claimed and checked. Longer than a gateway hold because a person
 * has to look at a bank statement, but not so long that abandoned claims keep
 * a popular event showing as sold out.
 */
export const OFFLINE_HOLD_HOURS = 24;

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
  /* Its own template. A password reset used to borrow the registration one,
     so somebody who had forgotten their password was sent "Confirm your email
     to finish joining Aarambam" — and an administrator switching that
     template off in the settings screen silently turned resets off with it. */
  'password_reset',
  'payment_confirmation',
  'event_confirmation',
  'event_reminder',
  'renewal_reminder',
  'event_cancellation',
];

export const SETTINGS_KEYS = {
  ORGANISATION: 'organisation',
  /* The bilingual wording of the member registration form. */
  REGISTRATION_FORM: 'registration_form',
};

/* ---------------------------------------------------------- miscellaneous */

/**
 * How long either side of a session the door will admit somebody.
 *
 * A scan used to be checked against the *date* only, so a ticket for a
 * 14:30–15:30 class was accepted at 20:09 that evening, and at 00:34 — fourteen
 * hours before the session it was marking. Both were recorded as attendance at
 * a class nobody was in.
 *
 * An hour before covers people who arrive early and a desk that opens ahead of
 * time; an hour after covers a queue still being cleared and a volunteer
 * catching up. Anything further out is not somebody arriving, and an organiser
 * correcting the register afterwards has the register itself for that.
 */
export const DOOR_OPENS_MINUTES_BEFORE = 60;
export const DOOR_CLOSES_MINUTES_AFTER = 60;

/**
 * How long a just-rotated refresh token is still tolerated.
 *
 * Rotation is strict: presenting a spent token revokes every session for the
 * account, on the assumption it was stolen. That is right for a token turning
 * up a week later and wrong for the ordinary case it was also catching — the
 * SPA refreshes on every cold start, so two tabs reloading together, a double
 * reload, or a reload racing a request in flight all present the same token
 * twice within a second or two. Members were signed out mid-payment and told
 * their session was invalid.
 *
 * Inside this window a repeat is treated as the duplicate it almost certainly
 * is: a fresh pair is issued and nothing is revoked. Outside it, the original
 * reasoning stands.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 60;

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
