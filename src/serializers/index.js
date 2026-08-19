/**
 * Row → API shape.
 *
 * Each function here returns exactly the interface of the same name in
 * `arambham-frontend/src/types/index.ts` — same field names, same casing, same
 * value vocabulary. Optional fields are *omitted* rather than sent as `null`,
 * because the front end types them as `T | undefined` and renders on
 * `if (value)`. Nothing that is not in the front-end interface is sent: no
 * password hash, no token, no internal bookkeeping column.
 */
import { mediaUrl } from '../services/storage.service.js';

/**
 * A private image, as a link the front end can put in an `img` tag.
 *
 * Member photographs and payment screenshots are stored as a bare object path
 * rather than a URL, because there is no URL that would work — the bucket
 * serves nothing to the public. What goes out instead is a link to `/media`,
 * which checks who is asking and then redirects to a signed URL that expires.
 *
 * Anything already absolute is passed through untouched: public images, and
 * photographs stored before this changed.
 */
const media = (value) => {
  if (!value) return undefined;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  return mediaUrl(value);
};

/** ISO-8601 with a `Z`, which is what `Dates are ISO-8601 strings` means here. */
const iso = (value) => {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  // `date` columns arrive as 'yyyy-MM-dd' and must stay that way.
  if (typeof value === 'string') return value;
  return new Date(value).toISOString();
};

/** Plain calendar date, never shifted into a timezone. */
const day = (value) => {
  if (!value) return undefined;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
};

const num = (value) => (value === null || value === undefined ? 0 : Number(value));

/** Drops keys whose value is null/undefined so optional fields stay optional. */
const compact = (object) => {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
};

const jsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

/* -------------------------------------------------------------------- user */

export const toUser = (row, extra = {}) =>
  row &&
  compact({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? '',
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified),
    avatarUrl: row.avatar_url,
    createdAt: iso(row.created_at),
    lastLoginAt: iso(row.last_login_at),
    assignedEventIds: extra.assignedEventIds,
  });

/**
 * What a visitor may know about someone who is not them: the organiser's name
 * on an event card, and nothing else. Contact details never leave this way.
 */
export const toPublicUser = (row) =>
  row &&
  compact({
    id: row.id,
    name: row.name,
    email: '',
    phone: '',
    role: row.role,
    status: row.status,
    emailVerified: true,
    avatarUrl: row.avatar_url,
    createdAt: iso(row.created_at),
  });

/* ------------------------------------------------------------------ member */

export const toMember = (row) =>
  row &&
  compact({
    id: row.id,
    userId: row.user_id,
    memberId: row.member_id,

    fullName: row.full_name,
    age: num(row.age),
    dateOfBirth: day(row.date_of_birth),
    gender: row.gender,
    photoUrl: media(row.photo_url),

    email: row.email,
    phone: row.phone,
    whatsappNumber: row.whatsapp_number ?? '',
    whatsappGroupConsent: Boolean(row.whatsapp_group_consent),

    addressLine1: row.address_line1 ?? '',
    addressLine2: row.address_line2,
    city: row.city ?? '',
    district: row.district ?? '',
    state: row.state ?? '',
    pincode: row.pincode ?? '',

    guardianName: row.guardian_name,
    guardianRelation: row.guardian_relation,
    guardianPhone: row.guardian_phone,

    idProofType: row.id_proof_type,
    idProofNumber: row.id_proof_number ?? '',

    hasMedicalConditions: Boolean(row.has_medical_conditions),
    medicalNotes: row.medical_notes,

    mediaConsent: Boolean(row.media_consent),
    declarationAccepted: Boolean(row.declaration_accepted),

    status: row.status,
    joinedAt: iso(row.joined_at),
    currentSubscriptionId: row.current_subscription_id,
  });

/**
 * The community counters on the public site — "1,240 members", "since 2019" —
 * are real counts, so a visitor has to be able to count members without being
 * able to read any of them. This is the whole of what a non-staff caller sees
 * about somebody else's membership.
 */
export const toMemberCounter = (row) => ({
  id: row.id,
  userId: '',
  memberId: '',
  fullName: '',
  age: 0,
  gender: 'other',
  email: '',
  phone: '',
  whatsappNumber: '',
  whatsappGroupConsent: false,
  addressLine1: '',
  city: '',
  district: '',
  state: '',
  pincode: '',
  idProofType: 'aadhaar',
  idProofNumber: '',
  hasMedicalConditions: false,
  mediaConsent: false,
  declarationAccepted: false,
  status: row.status,
  joinedAt: iso(row.joined_at),
});

/* -------------------------------------------------------------------- plan */

export const toPlan = (row) =>
  row &&
  compact({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    price: num(row.price),
    durationMonths: num(row.duration_months),
    benefits: jsonArray(row.benefits),
    active: Boolean(row.active),
    recommended: row.recommended ? true : undefined,
    sortOrder: num(row.sort_order),
  });

/* ------------------------------------------------------------ subscription */

export const toSubscription = (row) =>
  row &&
  compact({
    id: row.id,
    memberId: row.member_id,
    planId: row.plan_id,
    startDate: day(row.start_date),
    endDate: day(row.end_date),
    amount: num(row.amount),
    status: row.status,
    paymentId: row.payment_id,
    kind: row.kind,
    createdAt: iso(row.created_at),
  });

/* ---------------------------------------------------------------- category */

export const toCategory = (row) =>
  row && {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? '',
    color: row.color,
    active: Boolean(row.active),
  };

/* ------------------------------------------------------------------- event */

export const toEvent = (row) =>
  row &&
  compact({
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? '',
    description: row.description ?? '',
    categoryId: row.category_id,
    coverImageUrl: row.cover_image_url,

    venueName: row.venue_name ?? '',
    venueAddress: row.venue_address ?? '',
    city: row.city ?? '',

    date: day(row.date),
    startTime: row.start_time,
    endTime: row.end_time,

    registrationOpensAt: iso(row.registration_opens_at),
    registrationClosesAt: iso(row.registration_closes_at),

    capacity: num(row.capacity),
    lifecycle: row.lifecycle,

    type: row.type,
    memberPrice: num(row.member_price),
    nonMemberPrice: num(row.non_member_price),

    organizerId: row.organizer_id,
    /* Whose QR this event's money is collected on. */
    paymentQrMode: row.payment_qr_mode ?? 'trust',
    paymentQrUrl: row.payment_qr_url,
    createdAt: iso(row.created_at),
    publishedAt: iso(row.published_at),
    cancellationReason: row.cancellation_reason,
  });

/* ------------------------------------------------------------ registration */

export const toRegistration = (row) =>
  row &&
  compact({
    id: row.id,
    reference: row.reference,
    eventId: row.event_id,
    memberId: row.member_id,
    participantName: row.participant_name,
    ticketCode: row.ticket_code,
    status: row.status,
    attendance: row.attendance,
    pricedAsMember: Boolean(row.priced_as_member),
    amount: num(row.amount),
    paymentId: row.payment_id,
    registeredAt: iso(row.registered_at),
    checkedInAt: iso(row.checked_in_at),
    cancelledAt: iso(row.cancelled_at),
    cancellationReason: row.cancellation_reason,
  });

/**
 * Seats on other people's bookings. The event page has to say "12 of 60 seats
 * remain", which means counting rows a visitor may not read — so they get the
 * three fields the count is made of and blanks everywhere else.
 */
export const toRegistrationCounter = (row) => ({
  id: row.id,
  reference: '',
  eventId: row.event_id,
  memberId: '',
  participantName: '',
  ticketCode: '',
  status: row.status,
  attendance: row.attendance,
  pricedAsMember: false,
  amount: 0,
  registeredAt: iso(row.registered_at),
});

/* ----------------------------------------------------------------- payment */

export const toPayment = (row) =>
  row &&
  compact({
    id: row.id,
    reference: row.reference,
    receiptNo: row.receipt_no,
    memberId: row.member_id,
    payerName: row.payer_name,
    purpose: row.purpose,
    subscriptionId: row.subscription_id,
    registrationId: row.registration_id,
    description: row.description ?? '',
    amount: num(row.amount),
    method: row.method,
    status: row.status,
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
    failureReason: row.failure_reason,

    /* Paid outside the system. The reference is shown back to the payer so
       they can see what was recorded, and to the administrator so they can
       find it on the statement. */
    claimReference: row.claim_reference,
    claimNote: row.claim_note,
    payerPan: row.payer_pan,
    claimProofUrl: media(row.claim_proof_url),
    claimedAt: iso(row.claimed_at),
    verifiedAt: iso(row.verified_at),
    rejectionReason: row.rejection_reason,
  });

/* ------------------------------------------------------------ notification */

export const toNotification = (row) =>
  row &&
  compact({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body ?? '',
    read: Boolean(row.read),
    createdAt: iso(row.created_at),
    href: row.href,
  });

/* ---------------------------------------------------------------- settings */

export const toOrganisation = (value) => ({
  name: value?.name ?? '',
  tagline: value?.tagline ?? '',
  addressLine1: value?.addressLine1 ?? '',
  addressLine2: value?.addressLine2 ?? '',
  city: value?.city ?? '',
  state: value?.state ?? '',
  pincode: value?.pincode ?? '',
  email: value?.email ?? '',
  phone: value?.phone ?? '',
  website: value?.website ?? '',
  paymentUpiId: value?.paymentUpiId ?? '',
  paymentQrUrl: value?.paymentQrUrl ?? '',
  paymentInstructions: value?.paymentInstructions ?? '',

  mapsUrl: value?.mapsUrl ?? '',
  directionsNote: value?.directionsNote ?? '',
  officeDays: value?.officeDays ?? '',
  officeHours: value?.officeHours ?? '',
  holidayNote: value?.holidayNote ?? '',
  responseTime: value?.responseTime ?? '',
  registrationNumber: value?.registrationNumber ?? '',
  foundedYear: value?.foundedYear ?? undefined,
  instagramUrl: value?.instagramUrl ?? '',
  facebookUrl: value?.facebookUrl ?? '',
  whatsappUrl: value?.whatsappUrl ?? '',
  youtubeUrl: value?.youtubeUrl ?? '',
});

export const toEmailTemplate = (row) =>
  row && {
    key: row.key,
    name: row.name,
    description: row.description ?? '',
    subject: row.subject,
    body: row.body,
    enabled: Boolean(row.enabled),
    variables: jsonArray(row.variables),
  };

export default {
  toUser,
  toPublicUser,
  toMember,
  toMemberCounter,
  toPlan,
  toSubscription,
  toCategory,
  toEvent,
  toRegistration,
  toRegistrationCounter,
  toPayment,
  toNotification,
  toOrganisation,
  toEmailTemplate,
};
