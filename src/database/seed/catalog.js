/*
 * Ported verbatim from the front end (`src/data/catalog.ts`).
 *
 * The demonstration dataset is part of the product, not scaffolding: the
 * event copy, the plan benefits and the category colours are all content the
 * client reviews. Keeping one copy of it — the front end’s — and seeding the
 * database from that is what makes the connected application look exactly
 * like the prototype it replaces.
 */

/* ------------------------------------------------------------ organisation */

/**
 * The real organisation details, as supplied in "Design Corrections".
 *
 * Everything here is editable from the administrator's settings screen; these
 * are the values a fresh database starts with, so a new install is correct
 * before anyone touches it.
 */
export const ORGANISATION = {
  name: 'Aarambam',
  /* Written with the symbol, as asked — not the word "Infinity". */
  tagline: 'Zero · One · ∞',
  addressLine1: 'Aarambam, 48, Belmont 1st Floor',
  addressLine2: 'Upasi Road',
  city: 'Coonoor',
  state: 'Tamil Nadu',
  pincode: '643101',
  email: 'aarambam.nilgiris@gmail.com',
  phone: '+91 423 223 0592',
  website: 'www.bemybuddy.in',

  /* The pin drops on the Lemon Tree at street level; Aarambam is the first
     floor of the same building, which the directions note says out loud
     rather than leaving a visitor looking at the wrong door. */
  mapsUrl: 'https://maps.app.goo.gl/GcCUkKZ6M9cqc3gW7?g_st=iw',
  directionsNote: 'We are on the first floor, above Lemon Tree.',

  officeDays: 'Monday – Saturday',
  officeHours: '9am to 7pm',
  holidayNote: 'Closed on public holidays',
  /* Quoted publicly in three places, so it is the promise actually made. */
  responseTime: 'within 3 hours',

  registrationNumber: '80G: AADTB4839M25BL01',
  foundedYear: 2018,

  instagramUrl:
    'https://www.instagram.com/aarambam.tn43?igsh=MTJ3MmpiaGV2M3RjeQ%3D%3D&utm_source=qr',
  facebookUrl: 'https://www.facebook.com/share/1AswzMiaZu/',
  whatsappUrl: '',
  youtubeUrl: '',

  /* Payment details are set by the administrator, not seeded: a QR belongs to
     a real account and must never arrive as a default. */
  paymentUpiId: '',
  paymentQrUrl: '',
  paymentInstructions: '',
};

/* --------------------------------------------------------------- categories */

/**
 * Colours are drawn from the category token set in the theme so the calendar,
 * the chips and the reports all agree on what "Cultural" looks like.
 */
export const EVENT_CATEGORIES = [
  {
    id: 'cat-cultural',
    name: 'Cultural',
    slug: 'cultural',
    description: 'Festivals, music, dance and the evenings that fill the hall.',
    color: 'var(--color-cat-cultural)',
    active: true,
  },
  {
    id: 'cat-learning',
    name: 'Learning',
    slug: 'learning',
    description: 'Courses and certifications that run over several sessions.',
    color: 'var(--color-cat-learning)',
    active: true,
  },
  {
    id: 'cat-workshop',
    name: 'Workshop',
    slug: 'workshop',
    description: 'Single-session, hands-on, usually capped at a small group.',
    color: 'var(--color-cat-workshop)',
    active: true,
  },
  {
    id: 'cat-sports',
    name: 'Sports',
    slug: 'sports',
    description: 'Leagues, runs and everything that needs a ground.',
    color: 'var(--color-cat-sports)',
    active: true,
  },
  {
    id: 'cat-wellness',
    name: 'Wellness',
    slug: 'wellness',
    description: 'Yoga, health checks and the quieter side of the calendar.',
    color: 'var(--color-cat-wellness)',
    active: true,
  },
  {
    id: 'cat-community',
    name: 'Community',
    slug: 'community',
    description: 'Members’ meets, the AGM and how Aarambam runs itself.',
    color: 'var(--color-cat-community)',
    active: true,
  },
  {
    id: 'cat-youth',
    name: 'Youth',
    slug: 'youth',
    description: 'Programmes for school and college members.',
    color: 'var(--color-cat-youth)',
    active: true,
  },
  {
    id: 'cat-outreach',
    name: 'Outreach',
    slug: 'outreach',
    description: 'Work Aarambam does outside its own four walls.',
    color: 'var(--color-cat-outreach)',
    active: true,
  },
];

export const categoryById = (id) =>
  EVENT_CATEGORIES.find((c) => c.id === id) ?? EVENT_CATEGORIES[0];

export const categoryBySlug = (slug) => EVENT_CATEGORIES.find((c) => c.slug === slug);

/* ----------------------------------------------------------- membership */

/**
 * The proposal describes tiers as administrator-configurable and offers
 * "Basic, Standard, Premium" as its own example, so those names are used
 * here. Pricing and benefits are placeholders pending the client's Week 1
 * input and are editable from /admin/membership-plans.
 */
export const MEMBERSHIP_PLANS = [
  {
    id: 'plan-basic',
    name: 'Basic',
    description:
      'For anyone who wants to be on the list, come to the open events and see what Aarambam is about.',
    price: 500,
    durationMonths: 12,
    benefits: [
      'Member rate on every ticketed event',
      'Registration opens to you 24 hours early',
      'Digital membership card and member ID',
      'Monthly members’ meet',
    ],
    active: true,
    sortOrder: 1,
  },
  {
    id: 'plan-standard',
    name: 'Standard',
    description:
      'The plan most members choose. Everything in Basic, plus the workshops and courses that fill up fastest.',
    price: 1200,
    durationMonths: 12,
    benefits: [
      'Everything in Basic',
      'Four workshop seats included each year',
      'Registration opens to you 72 hours early',
      'Bring one guest at member rate',
      'Priority waitlist when an event is full',
    ],
    active: true,
    recommended: true,
    sortOrder: 2,
  },
  {
    id: 'plan-premium',
    name: 'Premium',
    description:
      'For members who are here most weeks — and for families who register together.',
    price: 2500,
    durationMonths: 12,
    benefits: [
      'Everything in Standard',
      'All workshops included, no per-event fee',
      'Two guests at member rate',
      'Reserved seating at cultural evenings',
      'A vote at the Annual General Meeting',
    ],
    active: true,
    sortOrder: 3,
  },
  {
    id: 'plan-student',
    name: 'Student',
    description:
      'Concession tier for members in full-time education. Withdrawn for the current year — retained here for renewals already in force.',
    price: 300,
    durationMonths: 12,
    benefits: [
      'Member rate on every ticketed event',
      'Youth programme access',
      'Valid student ID required at registration',
    ],
    active: false,
    sortOrder: 4,
  },
];

export const planById = (id) => MEMBERSHIP_PLANS.find((p) => p.id === id);

export const activePlans = () =>
  MEMBERSHIP_PLANS.filter((p) => p.active).sort((a, b) => a.sortOrder - b.sortOrder);

/* ------------------------------------------------------- email templates */

export const EMAIL_TEMPLATES = [
  {
    key: 'account_registration',
    name: 'Account registration',
    description: 'Sent the moment an account is created. Carries the verification link.',
    subject: 'Confirm your email to finish joining Aarambam',
    body:
      'Hello {{member_name}},\n\n' +
      'Thanks for starting your Aarambam registration. Confirm your email address to activate your account:\n\n' +
      '{{verification_link}}\n\n' +
      'The link is valid for 24 hours.\n\n' +
      '— Aarambam',
    enabled: true,
    variables: ['member_name', 'verification_link'],
  },
  {
    key: 'payment_confirmation',
    name: 'Payment confirmation',
    description: 'Sent on every successful payment, with the PDF receipt attached.',
    subject: 'Receipt {{receipt_no}} — ₹{{amount}} received',
    body:
      'Hello {{member_name}},\n\n' +
      'We have received ₹{{amount}} towards {{purpose}}.\n' +
      'Reference: {{payment_reference}}\n' +
      'Receipt number: {{receipt_no}}\n\n' +
      'Your receipt is attached.\n\n' +
      '— Aarambam',
    enabled: true,
    variables: ['member_name', 'amount', 'purpose', 'payment_reference', 'receipt_no'],
  },
  {
    key: 'event_confirmation',
    name: 'Event registration confirmation',
    description: 'Sent when a seat is confirmed. Carries the QR ticket.',
    subject: 'You’re registered — {{event_title}}',
    body:
      'Hello {{participant_name}},\n\n' +
      'Your seat at {{event_title}} is confirmed.\n\n' +
      '{{event_date}}, {{event_time}}\n' +
      '{{venue_name}}, {{venue_address}}\n\n' +
      'Booking reference: {{registration_reference}}\n' +
      'Your QR ticket is attached — show it at the entrance.\n\n' +
      '— Aarambam',
    enabled: true,
    variables: [
      'participant_name', 'event_title', 'event_date', 'event_time',
      'venue_name', 'venue_address', 'registration_reference',
    ],
  },
  {
    key: 'event_reminder',
    name: 'Event reminder',
    description: 'Sent 24 hours before an event to everyone holding a confirmed ticket.',
    subject: 'Tomorrow: {{event_title}}',
    body:
      'Hello {{participant_name}},\n\n' +
      '{{event_title}} is tomorrow at {{event_time}}.\n' +
      '{{venue_name}}, {{venue_address}}\n\n' +
      'Bring your QR ticket — booking reference {{registration_reference}}.\n\n' +
      '— Aarambam',
    enabled: true,
    variables: [
      'participant_name', 'event_title', 'event_time', 'venue_name',
      'venue_address', 'registration_reference',
    ],
  },
  {
    key: 'renewal_reminder',
    name: 'Membership renewal reminder',
    description: 'Sent 30, 14 and 3 days before a membership expires.',
    subject: 'Your Aarambam membership ends on {{expiry_date}}',
    body:
      'Hello {{member_name}},\n\n' +
      'Your {{plan_name}} membership ends on {{expiry_date}} — that is {{days_remaining}} days from now.\n\n' +
      'Renew here: {{renewal_link}}\n\n' +
      '— Aarambam',
    enabled: true,
    variables: ['member_name', 'plan_name', 'expiry_date', 'days_remaining', 'renewal_link'],
  },
  {
    key: 'event_cancellation',
    name: 'Event cancellation',
    description: 'Sent to every registered participant when an event is cancelled.',
    subject: 'Cancelled: {{event_title}}',
    body:
      'Hello {{participant_name}},\n\n' +
      'We are sorry — {{event_title}} on {{event_date}} has been cancelled.\n\n' +
      'Reason: {{cancellation_reason}}\n\n' +
      'If you paid for this event, the refund will be processed to your original payment method within 5–7 working days.\n\n' +
      '— Aarambam',
    enabled: true,
    variables: ['participant_name', 'event_title', 'event_date', 'cancellation_reason'],
  },
];
