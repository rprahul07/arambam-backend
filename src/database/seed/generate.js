/*
 * Ported from the front end (`src/data/generate.ts`).
 *
 * Builds the demonstration community: three staff accounts, fifty-five
 * members with the subscription history their status implies, the hand-written
 * events, the registrations that fill them, the payments behind those, and the
 * notification feed each account would actually have.
 *
 * Ids are UUIDs here rather than the prototype's `mem-001` strings, because
 * these rows go into a real database with real foreign keys. Everything else —
 * names, dates, proportions, the deliberate tail of failed payments and
 * withdrawn seats — is the same.
 */

import crypto from 'node:crypto';
import { MEMBERSHIP_PLANS } from './catalog.js';
import { EVENT_SEEDS } from './eventSeeds.js';
import {
  EMAIL_DOMAINS,
  FEMALE_FIRST_NAMES,
  LOCALITIES,
  MALE_FIRST_NAMES,
  STREET_NAMES,
  SURNAMES,
} from './pools.js';
import { chance, gatewayReference, intBetween, makeRng, pick, shuffle, ticketCode, weighted } from './rng.js';

/* ------------------------------------------------------------------ clock */

const DAY = 86_400_000;

export const NOW = new Date();

const addDays = (date, days) => new Date(date.getTime() + days * DAY);

const addMonths = (date, months) => {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
};

const pad = (value, width = 2) => String(value).padStart(width, '0');

/** `yyyy-MM-dd` in local time — a calendar date, not an instant. */
const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const dayISO = (offset) => dayOf(addDays(NOW, offset));

const stamp = (offset, hour = 10, minute = 0) => {
  const d = addDays(NOW, offset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

/* --------------------------------------------------------------- helpers */

const id = () => crypto.randomUUID();

const slugify = (value) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '.');

const phone = (rng) =>
  `+91 ${intBetween(rng, 70, 99)}${intBetween(rng, 100, 999)} ${intBetween(rng, 10000, 99999)}`;

const aadhaar = (rng) =>
  `${intBetween(rng, 2000, 9999)} ${intBetween(rng, 1000, 9999)} ${intBetween(rng, 1000, 9999)}`;

const year = (iso) => new Date(iso).getFullYear();

/* ========================================================================= */

export function buildDatabase() {
  const rng = makeRng(20260801);

  const users = [];
  const members = [];
  const subscriptions = [];
  const registrations = [];
  const payments = [];
  const notifications = [];

  /* ------------------------------------------------------------- staff -- */

  const admin = {
    id: id(),
    name: 'Revathi Krishnan',
    email: 'revathi@aarambam.org',
    phone: '+91 98410 22187',
    role: 'administrator',
    status: 'active',
    emailVerified: true,
    createdAt: stamp(-1120, 9),
    lastLoginAt: stamp(0, 8, 42),
  };

  const organizer = {
    id: id(),
    name: 'Aravind Natarajan',
    email: 'aravind@aarambam.org',
    phone: '+91 90031 55420',
    role: 'organizer',
    status: 'active',
    emailVerified: true,
    createdAt: stamp(-830, 11),
    lastLoginAt: stamp(0, 7, 15),
  };

  const organizer2 = {
    id: id(),
    name: 'Senthil Nathan',
    email: 'senthil@aarambam.org',
    phone: '+91 94440 71903',
    role: 'organizer',
    status: 'active',
    emailVerified: true,
    createdAt: stamp(-610, 14),
    lastLoginAt: stamp(-1, 19, 5),
  };

  users.push(admin, organizer, organizer2);

  /* ----------------------------------------------------------- members -- */

  const MEMBER_COUNT = 54;
  const usedEmails = new Set([admin.email, organizer.email, organizer2.email]);
  let memberNumber = 1042;

  /** The account the demonstration signs in as. Crafted, not generated. */
  const demoLocality = LOCALITIES[0];
  const demoUserId = id();
  const demoMember = {
    id: id(),
    userId: demoUserId,
    memberId: `ARM-${memberNumber}`,
    fullName: 'Divya Bharathi',
    age: 29,
    dateOfBirth: dayOf(addMonths(NOW, -29 * 12 - 4)),
    gender: 'female',
    email: 'divya.bharathi@gmail.com',
    phone: '+91 98846 30219',
    whatsappNumber: '+91 98846 30219',
    whatsappGroupConsent: true,
    addressLine1: 'Flat 3B, Sundaram Apartments',
    addressLine2: '12, Sastri Nagar 3rd Cross',
    city: demoLocality.city,
    district: demoLocality.district,
    state: 'Tamil Nadu',
    pincode: demoLocality.pincode,
    idProofType: 'aadhaar',
    idProofNumber: '6421 8890 3317',
    hasMedicalConditions: true,
    medicalNotes: 'Mild dust allergy — carries an inhaler.',
    mediaConsent: true,
    declarationAccepted: true,
    status: 'active',
    joinedAt: stamp(-742, 10),
  };

  users.push({
    id: demoUserId,
    name: demoMember.fullName,
    email: demoMember.email,
    phone: demoMember.phone,
    role: 'member',
    status: 'active',
    emailVerified: true,
    createdAt: demoMember.joinedAt,
    lastLoginAt: stamp(0, 7, 58),
  });
  members.push(demoMember);
  usedEmails.add(demoMember.email);

  for (let i = 0; i < MEMBER_COUNT; i += 1) {
    const gender = weighted(rng, [
      ['female', 48],
      ['male', 49],
      ['other', 3],
    ]);
    const first = gender === 'male' ? pick(rng, MALE_FIRST_NAMES) : pick(rng, FEMALE_FIRST_NAMES);
    const last = pick(rng, SURNAMES);
    const fullName = `${first} ${last}`;

    let email = `${slugify(first)}.${slugify(last)}@${pick(rng, EMAIL_DOMAINS)}`;
    let suffix = 1;
    while (usedEmails.has(email)) {
      suffix += 1;
      email = `${slugify(first)}.${slugify(last)}${suffix}@${pick(rng, EMAIL_DOMAINS)}`;
    }
    usedEmails.add(email);

    const locality = pick(rng, LOCALITIES);
    const age = weighted(rng, [
      [intBetween(rng, 14, 17), 9],
      [intBetween(rng, 18, 29), 34],
      [intBetween(rng, 30, 45), 33],
      [intBetween(rng, 46, 62), 18],
      [intBetween(rng, 63, 78), 6],
    ]);
    const isMinor = age < 18;

    // Join dates cluster towards the recent past — the organisation is growing.
    const joinedDaysAgo = Math.round(
      weighted(rng, [
        [intBetween(rng, 1, 90), 30],
        [intBetween(rng, 91, 365), 38],
        [intBetween(rng, 366, 900), 24],
        [intBetween(rng, 901, 1600), 8],
      ]),
    );

    const memberPhone = phone(rng);
    const status = weighted(rng, [
      ['active', 70],
      ['expired', 16],
      ['pending', 9],
      ['suspended', 5],
    ]);

    const idProofType = weighted(rng, [
      ['aadhaar', 76],
      ['voter_id', 16],
      ['driving_licence', 8],
    ]);

    const hasMedical = chance(rng, 0.18);
    const userId = id();
    memberNumber += 1;

    const record = {
      id: id(),
      userId,
      memberId: `ARM-${memberNumber}`,
      fullName,
      age,
      gender,
      email,
      phone: memberPhone,
      whatsappNumber: chance(rng, 0.85) ? memberPhone : phone(rng),
      whatsappGroupConsent: chance(rng, 0.78),
      addressLine1: `${intBetween(rng, 1, 180)}, ${pick(rng, STREET_NAMES)}`,
      addressLine2: locality.area,
      city: locality.city,
      district: locality.district,
      state: 'Tamil Nadu',
      pincode: locality.pincode,
      guardianName: isMinor ? `${pick(rng, MALE_FIRST_NAMES)} ${last}` : undefined,
      guardianRelation: isMinor ? pick(rng, ['father', 'mother', 'guardian']) : undefined,
      guardianPhone: isMinor ? phone(rng) : undefined,
      idProofType,
      idProofNumber:
        idProofType === 'aadhaar'
          ? aadhaar(rng)
          : idProofType === 'voter_id'
            ? `TN/${intBetween(rng, 10, 99)}/${intBetween(rng, 100, 999)}/${intBetween(rng, 100000, 999999)}`
            : `TN${intBetween(rng, 10, 99)} ${intBetween(rng, 20100000000, 20239999999)}`,
      hasMedicalConditions: hasMedical,
      medicalNotes: hasMedical
        ? pick(rng, [
            'Asthma — carries an inhaler.',
            'Diabetic. Prefers an early lunch slot.',
            'Penicillin allergy.',
            'Knee injury — avoids kneeling activities.',
            'Peanut allergy. Please check catering.',
          ])
        : undefined,
      mediaConsent: chance(rng, 0.88),
      declarationAccepted: true,
      status,
      joinedAt: stamp(-joinedDaysAgo, intBetween(rng, 9, 19)),
    };

    members.push(record);

    users.push({
      id: userId,
      name: fullName,
      email,
      phone: memberPhone,
      role: 'member',
      status: status === 'suspended' ? 'inactive' : 'active',
      emailVerified: status !== 'pending',
      createdAt: record.joinedAt,
      lastLoginAt: chance(rng, 0.8) ? stamp(-intBetween(rng, 0, 60), intBetween(rng, 7, 22)) : undefined,
    });
  }

  /* ----------------------------------------------------- subscriptions -- */

  const pushMembershipPayment = (sub, member, status, daysAgo) => {
    const method = weighted(rng, [
      ['upi', 62],
      ['card', 20],
      ['netbanking', 12],
      ['wallet', 6],
    ]);
    const createdAt = stamp(-daysAgo, intBetween(rng, 9, 21));
    const payment = {
      id: id(),
      reference: gatewayReference(rng),
      receiptNo:
        status === 'successful'
          ? `RCP-${year(createdAt)}-${String(payments.length + 1).padStart(4, '0')}`
          : undefined,
      memberId: member.id,
      payerName: member.fullName,
      purpose: 'membership',
      subscriptionId: sub.id,
      description: `${MEMBERSHIP_PLANS.find((p) => p.id === sub.planId)?.name ?? 'Membership'} membership — ${
        sub.kind === 'renewal' ? 'renewal' : sub.kind === 'upgrade' ? 'upgrade' : '12 months'
      }`,
      amount: sub.amount,
      method,
      status,
      createdAt,
      completedAt: status === 'successful' ? createdAt : undefined,
      failureReason:
        status === 'failed'
          ? pick(rng, ['Insufficient funds', 'Bank declined the transaction', 'UPI request timed out'])
          : undefined,
    };
    payments.push(payment);
    return payment;
  };

  // The demonstration member: Standard, active, expiring soon enough to matter.
  const demoHistory = [
    { planId: 'plan-basic', startOffset: -742, kind: 'new' },
    { planId: 'plan-basic', startOffset: -377, kind: 'renewal' },
    { planId: 'plan-standard', startOffset: -327, kind: 'upgrade' },
  ];

  demoHistory.forEach((entry, index) => {
    const plan = MEMBERSHIP_PLANS.find((p) => p.id === entry.planId);
    const isCurrent = index === demoHistory.length - 1;
    const start = addDays(NOW, entry.startOffset);
    const sub = {
      id: id(),
      memberId: demoMember.id,
      planId: plan.id,
      startDate: dayOf(start),
      endDate: dayOf(addMonths(start, plan.durationMonths)),
      amount: entry.kind === 'upgrade' ? plan.price - 500 : plan.price,
      status: isCurrent ? 'active' : 'expired',
      kind: entry.kind,
      createdAt: stamp(entry.startOffset, 11),
    };
    subscriptions.push(sub);
    sub.paymentId = pushMembershipPayment(sub, demoMember, 'successful', -entry.startOffset).id;
    if (isCurrent) demoMember.currentSubscriptionId = sub.id;
  });

  for (const member of members) {
    if (member.id === demoMember.id) continue;

    const joinedDaysAgo = Math.round((NOW.getTime() - new Date(member.joinedAt).getTime()) / DAY);

    if (member.status === 'pending') {
      // Registered but never paid: the subscription exists and stays pending.
      const plan = pick(rng, MEMBERSHIP_PLANS.filter((p) => p.active));
      const start = addDays(NOW, -joinedDaysAgo);
      const sub = {
        id: id(),
        memberId: member.id,
        planId: plan.id,
        startDate: dayOf(start),
        endDate: dayOf(addMonths(start, plan.durationMonths)),
        amount: plan.price,
        status: 'pending',
        kind: 'new',
        createdAt: member.joinedAt,
      };
      subscriptions.push(sub);
      member.currentSubscriptionId = sub.id;
      const outcome = weighted(rng, [
        ['pending', 55],
        ['failed', 30],
        ['cancelled', 15],
      ]);
      sub.paymentId = pushMembershipPayment(sub, member, outcome, joinedDaysAgo).id;
      continue;
    }

    // One subscription per completed year, ending in the member's current status.
    const years = Math.max(1, Math.min(4, Math.ceil(joinedDaysAgo / 365)));
    for (let y = 0; y < years; y += 1) {
      const isCurrent = y === years - 1;
      const plan = pick(rng, MEMBERSHIP_PLANS.filter((p) => p.active || chance(rng, 0.15)));
      const startOffset = -joinedDaysAgo + y * 365;
      const start = addDays(NOW, startOffset);

      const status = isCurrent
        ? member.status === 'expired'
          ? 'expired'
          : member.status === 'suspended'
            ? 'cancelled'
            : 'active'
        : 'expired';

      const sub = {
        id: id(),
        memberId: member.id,
        planId: plan.id,
        startDate: dayOf(start),
        endDate: dayOf(addMonths(start, plan.durationMonths)),
        amount: plan.price,
        status,
        kind: y === 0 ? 'new' : 'renewal',
        createdAt: stamp(startOffset, intBetween(rng, 9, 20)),
      };
      subscriptions.push(sub);
      sub.paymentId = pushMembershipPayment(sub, member, 'successful', -startOffset).id;
      if (isCurrent) member.currentSubscriptionId = sub.id;
    }
  }

  /* ------------------------------------------------------------ events -- */

  const events = EVENT_SEEDS.map((seed) => {
    const opensBefore = seed.opensBefore ?? 30;
    const closesBefore = seed.closesBefore ?? 1;
    const lifecycle = seed.lifecycle ?? (seed.dayOffset < 0 ? 'completed' : 'published');

    // Sports and community go to Senthil; everything else to Aravind.
    const organizerId =
      seed.categoryId === 'cat-sports' || seed.categoryId === 'cat-community' ? organizer2.id : organizer.id;

    return {
      id: id(),
      slug: seed.slug,
      title: seed.title,
      summary: seed.summary,
      description: seed.description,
      categoryId: seed.categoryId,
      venueName: seed.venue.venueName,
      venueAddress: seed.venue.venueAddress,
      city: seed.venue.city,
      date: dayISO(seed.dayOffset),
      startTime: seed.startTime,
      endTime: seed.endTime,
      registrationOpensAt: stamp(seed.dayOffset - opensBefore, 10),
      registrationClosesAt: stamp(seed.dayOffset - closesBefore, 23, 59),
      capacity: seed.capacity,
      lifecycle,
      type: seed.type,
      memberPrice: seed.memberPrice,
      nonMemberPrice: seed.nonMemberPrice,
      organizerId,
      createdAt: stamp(seed.dayOffset - opensBefore - intBetween(rng, 5, 25), 12),
      publishedAt: lifecycle === 'draft' ? undefined : stamp(seed.dayOffset - opensBefore, 10),
      cancellationReason: seed.cancellationReason,
    };
  });

  /* ----------------------------------------------------- registrations -- */

  const eligible = members.filter((m) => m.status === 'active' || m.status === 'expired');

  /** Events the demonstration member is deliberately booked onto. */
  const demoEventSlugs = new Set([
    'weekend-yoga-breathwork',
    'first-aid-cpr-certification',
    'bharatanatyam-evening-2026',
    'photography-walk-george-town',
    'aarambam-10k-2026',
    'spoken-english-batch-6',
    'beach-cleanup-elliots-feb',
    'pongal-thiruvizha-2026',
    'heritage-walk-mylapore',
  ]);

  let counter = 0;

  for (const event of events) {
    const seed = EVENT_SEEDS.find((s) => s.slug === event.slug);
    if (event.lifecycle === 'draft') continue;

    const target = Math.min(event.capacity, Math.round(event.capacity * seed.fill));
    if (target === 0) continue;

    const isPast = seed.dayOffset < 0;
    const forcedDemo = demoEventSlugs.has(event.slug);

    const pool = shuffle(rng, eligible.filter((m) => m.id !== demoMember.id)).slice(
      0,
      forcedDemo ? target - 1 : target,
    );
    const attendees = forcedDemo ? [demoMember, ...pool] : pool;

    for (const member of attendees) {
      counter += 1;

      const opensOffset = seed.dayOffset - (seed.opensBefore ?? 30);
      const closesOffset = seed.dayOffset - (seed.closesBefore ?? 1);
      const bookedOffset = Math.min(
        0,
        Math.round(opensOffset + rng() * Math.max(1, closesOffset - opensOffset)),
      );

      const pricedAsMember = member.status === 'active';
      const amount = event.type === 'free' ? 0 : pricedAsMember ? event.memberPrice : event.nonMemberPrice;

      // A small, realistic tail of bookings that never completed or were
      // withdrawn — the interface has to represent these honestly.
      const status =
        event.lifecycle === 'cancelled'
          ? 'cancelled'
          : weighted(rng, [
              ['confirmed', 92],
              ['pending_payment', amount > 0 && !isPast ? 5 : 0],
              ['cancelled', 4],
            ]);

      const attendance =
        isPast && status === 'confirmed'
          ? weighted(rng, [
              ['attended', 84],
              ['absent', 16],
            ])
          : 'not_checked_in';

      const bookedOn = addDays(NOW, bookedOffset);
      const registration = {
        id: id(),
        reference: `REG-${bookedOn.getFullYear()}${pad(bookedOn.getMonth() + 1)}${pad(bookedOn.getDate())}-${String(counter).padStart(4, '0')}`,
        eventId: event.id,
        memberId: member.id,
        participantName: member.fullName,
        ticketCode: ticketCode(rng),
        status,
        attendance,
        pricedAsMember,
        amount,
        registeredAt: stamp(bookedOffset, intBetween(rng, 8, 22), intBetween(rng, 0, 59)),
        checkedInAt:
          attendance === 'attended'
            ? stamp(seed.dayOffset, Number(event.startTime.slice(0, 2)), intBetween(rng, 0, 45))
            : undefined,
        cancelledAt:
          status === 'cancelled' ? stamp(Math.min(0, bookedOffset + intBetween(rng, 1, 10)), 15) : undefined,
        cancellationReason:
          status === 'cancelled'
            ? event.lifecycle === 'cancelled'
              ? 'Event cancelled by the organiser'
              : pick(rng, [
                  'Withdrawn by the member',
                  'Unable to attend — travel',
                  'Withdrawn by the member',
                  'Duplicate registration removed',
                ])
            : undefined,
      };

      registrations.push(registration);

      if (amount > 0 && status !== 'cancelled') {
        const paymentStatus =
          status === 'pending_payment'
            ? weighted(rng, [
                ['pending', 60],
                ['failed', 40],
              ])
            : 'successful';

        const payment = {
          id: id(),
          reference: gatewayReference(rng),
          receiptNo:
            paymentStatus === 'successful'
              ? `RCP-${bookedOn.getFullYear()}-${String(payments.length + 1).padStart(4, '0')}`
              : undefined,
          memberId: member.id,
          payerName: member.fullName,
          purpose: 'event',
          registrationId: registration.id,
          description: event.title,
          amount,
          method: weighted(rng, [
            ['upi', 66],
            ['card', 18],
            ['netbanking', 10],
            ['wallet', 6],
          ]),
          status: paymentStatus,
          createdAt: registration.registeredAt,
          completedAt: paymentStatus === 'successful' ? registration.registeredAt : undefined,
          failureReason:
            paymentStatus === 'failed'
              ? pick(rng, ['Bank declined the transaction', 'UPI request timed out'])
              : undefined,
        };
        payments.push(payment);
        registration.paymentId = payment.id;
      }
    }
  }

  /* ----------------------------------------------------- notifications -- */

  const nextDemo = registrations
    .filter((r) => r.memberId === demoMember.id && r.status === 'confirmed')
    .map((r) => ({ r, e: events.find((e) => e.id === r.eventId) }))
    .filter(({ e }) => new Date(e.date) >= NOW)
    .sort((a, b) => a.e.date.localeCompare(b.e.date))[0];

  const demoSub = subscriptions.find((s) => s.id === demoMember.currentSubscriptionId);
  const demoPlan = MEMBERSHIP_PLANS.find((p) => p.id === demoSub.planId);

  const longDate = (value) =>
    new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const shortDate = (value) =>
    new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const weekday = (value) =>
    new Date(value).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

  const demoFeed = [
    {
      type: 'event_reminder',
      title: nextDemo ? `${nextDemo.e.title} is coming up` : 'An event you booked is coming up',
      body: nextDemo
        ? `${weekday(nextDemo.e.date)} at ${nextDemo.e.startTime}, ${nextDemo.e.venueName}. Your ticket is ready.`
        : 'Your ticket is ready in the tickets section.',
      read: false,
      createdAt: stamp(-1, 9, 0),
      href: nextDemo ? `/member/tickets/${nextDemo.r.id}` : '/member/tickets',
    },
    {
      type: 'membership_renewal_due',
      title: 'Your membership ends soon',
      body: `Your ${demoPlan.name} membership is valid until ${longDate(demoSub.endDate)}. Renew any time before then to keep member pricing.`,
      read: false,
      createdAt: stamp(-3, 8, 30),
      href: '/member/membership',
    },
    {
      type: 'event_cancelled',
      title: 'Heritage Walk — Mylapore has been cancelled',
      body: 'The tank desilting work has closed the route. Your payment will be refunded to the original method within 5–7 working days.',
      read: false,
      createdAt: stamp(-5, 16, 12),
      href: '/events/heritage-walk-mylapore',
    },
    {
      type: 'payment_confirmation',
      title: 'Receipt for ₹200',
      body: 'We received ₹200 towards Bharatanatyam Evening. Your receipt is available to download.',
      read: true,
      createdAt: stamp(-9, 11, 4),
      href: '/member/payments',
    },
    {
      type: 'event_registration',
      title: 'Seat confirmed — First Aid & CPR Certification',
      body: 'Your seat is confirmed. The QR ticket is in your tickets.',
      read: true,
      createdAt: stamp(-12, 19, 41),
      href: '/member/tickets',
    },
    {
      type: 'membership_activated',
      title: `${demoPlan.name} membership activated`,
      body: `Valid from ${shortDate(demoSub.startDate)} to ${shortDate(demoSub.endDate)}.`,
      read: true,
      createdAt: demoSub.createdAt,
      href: '/member/membership',
    },
  ];

  for (const item of demoFeed) notifications.push({ ...item, id: id(), userId: demoUserId });

  /* A short operational feed for the two staff roles. */
  const staffFeed = [
    [
      admin,
      [
        {
          type: 'payment_confirmation',
          title: 'Daily settlement summary',
          body: `${payments.filter((p) => p.status === 'successful').length} successful transactions recorded to date.`,
          read: false,
          createdAt: stamp(0, 7, 0),
          href: '/admin/payments',
        },
        {
          type: 'account_registered',
          title: 'New member registrations pending payment',
          body: `${members.filter((m) => m.status === 'pending').length} members have registered but not completed payment.`,
          read: false,
          createdAt: stamp(-1, 7, 0),
          href: '/admin/members?status=pending',
        },
        {
          type: 'membership_renewal_due',
          title: 'Memberships expiring in the next 30 days',
          body: 'Review the subscription report before the renewal reminders go out.',
          read: true,
          createdAt: stamp(-4, 9, 20),
          href: '/admin/reports',
        },
      ],
    ],
    [
      organizer,
      [
        {
          type: 'event_registration',
          title: 'First Aid & CPR Certification is filling up',
          body: 'Registrations have passed 85% of capacity.',
          read: false,
          createdAt: stamp(-1, 12, 30),
          href: '/organizer/events',
        },
        {
          type: 'event_cancelled',
          title: 'Heritage Walk — Mylapore cancelled',
          body: 'Participants have been notified and refunds are in progress.',
          read: true,
          createdAt: stamp(-5, 16, 10),
          href: '/organizer/events',
        },
      ],
    ],
    [
      organizer2,
      [
        {
          type: 'event_reminder',
          title: 'Kabaddi League opening in four weeks',
          body: 'Team registrations close two days before the opening evening.',
          read: false,
          createdAt: stamp(-2, 10, 0),
          href: '/organizer/events',
        },
      ],
    ],
  ];

  for (const [user, items] of staffFeed) {
    for (const item of items) notifications.push({ ...item, id: id(), userId: user.id });
  }

  notifications.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  payments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  registrations.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));

  return {
    users,
    members,
    subscriptions,
    events,
    registrations,
    payments,
    notifications,
    nextMemberNumber: memberNumber + 1,
    demo: {
      adminUserId: admin.id,
      organizerUserId: organizer.id,
      secondOrganizerUserId: organizer2.id,
      memberUserId: demoUserId,
      memberId: demoMember.id,
    },
  };
}

export default { buildDatabase, NOW };
