import { z } from 'zod';
import { EVENT_LIFECYCLE_VALUES, EVENT_QR_MODE_VALUES, EVENT_TYPE_VALUES } from '../../config/constants.js';

const time = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 18:30');

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in the form 2026-08-14');

const isoDateTime = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'That is not a valid date and time');

const money = z.coerce.number().min(0, 'A price cannot be negative').max(1_000_000);

/**
 * A client-supplied primary key.
 *
 * The interface hands the caller a record the instant they save one, so it
 * needs the id before the round trip finishes. Letting the client mint the
 * UUID makes that possible, and makes the call idempotent as a side effect: a
 * retry after a dropped connection conflicts on the key rather than creating a
 * second event. The id is opaque — it grants nothing, and every read of the
 * record is authorised on its own terms.
 */
export const clientId = z.string().uuid('Invalid id').optional();

/** Mirrors `NewEventInput` in the front end's data store, field for field. */
const base = {
  title: z.string().trim().min(3, 'Give the event a title').max(160),
  summary: z.string().trim().max(400).default(''),
  description: z.string().trim().max(20_000).default(''),
  categoryId: z.string().uuid('Choose a category'),
  venueName: z.string().trim().max(160).default(''),
  venueAddress: z.string().trim().max(400).default(''),
  city: z.string().trim().max(120).default(''),
  date: isoDate,
  startTime: time,
  endTime: time,
  registrationOpensAt: isoDateTime,
  registrationClosesAt: isoDateTime,
  capacity: z.coerce.number().int().min(0).max(1_000_000),
  type: z.enum(EVENT_TYPE_VALUES),
  memberPrice: money.default(0),
  nonMemberPrice: money.default(0),
  organizerId: z.string().uuid('Choose an organiser'),
  lifecycle: z.enum(EVENT_LIFECYCLE_VALUES).default('draft'),
  /* Whose QR collects this event's money. Defaults to the Trust's, so an
     event created without a thought about it still collects correctly. */
  paymentQrMode: z.enum(EVENT_QR_MODE_VALUES).default('trust'),
  paymentQrUrl: z.union([z.literal(''), z.string().trim().url().max(500)]).optional(),
  coverImageUrl: z.string().trim().url().max(500).optional(),
};

/**
 * Dates are compared as calendar days, never as instants.
 *
 * `date` is a plain 'YYYY-MM-DD' with no zone, while `registrationClosesAt` is
 * an instant in UTC. Parsing the first as a local time and the second as UTC
 * makes the comparison depend on where the server happens to be running, which
 * is how a rule starts failing at one time of day and passing at another.
 * Comparing the calendar day of each sidesteps the whole question.
 */
const dayOf = (isoInstant) => String(isoInstant).slice(0, 10);
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * The window has to close after it opens, and a free event cannot carry a
 * price. Both are also database constraints — this layer exists so the person
 * filling in the form gets the message against the right field.
 */
const coherent = (schema) =>
  schema
    .refine(
      (v) =>
        v.registrationOpensAt === undefined ||
        v.registrationClosesAt === undefined ||
        Date.parse(v.registrationClosesAt) >= Date.parse(v.registrationOpensAt),
      { path: ['registrationClosesAt'], message: 'Registration must close after it opens' },
    )
    .refine(
      (v) => v.type !== 'free' || ((v.memberPrice ?? 0) === 0 && (v.nonMemberPrice ?? 0) === 0),
      { path: ['memberPrice'], message: 'A free event cannot have a price' },
    )
    /* Choosing your own QR means supplying one — otherwise the payer is shown
       nothing to scan. */
    .refine((v) => v.paymentQrMode !== 'own' || Boolean(v.paymentQrUrl), {
      path: ['paymentQrUrl'],
      message: 'Upload the QR you want this event collected on, or use the Trust QR',
    })
    .refine(
      (v) => v.date === undefined || v.startTime === undefined || v.endTime === undefined ||
        v.endTime > v.startTime,
      { path: ['endTime'], message: 'The event has to end after it starts' },
    )
    /* Registration that is still open after the event has happened sells seats
       to something already over. This was only caught on the member's side,
       where the event simply read as finished. */
    .refine(
      (v) =>
        v.date === undefined || v.registrationClosesAt === undefined ||
        dayOf(v.registrationClosesAt) <= v.date,
      {
        path: ['registrationClosesAt'],
        message: 'Registration must close by the day the event takes place',
      },
    );

/**
 * A new event cannot be in the past.
 *
 * Only applied on creation: an existing event's date is left alone so that a
 * past event can still be corrected or cancelled after the fact. Today counts
 * as valid — an event added on the morning of the day it runs is ordinary.
 */
const notInThePast = (schema) =>
  schema.refine((v) => v.date === undefined || v.date >= todayUtc(), {
    path: ['date'],
    message: 'That date has already passed — choose a date in the future',
  });

export const createEventSchema = notInThePast(coherent(z.object({ ...base, id: clientId })));

export const updateEventSchema = coherent(
  z.object(Object.fromEntries(Object.entries(base).map(([key, value]) => [key, value.optional()]))),
);

export const lifecycleSchema = z
  .object({
    lifecycle: z.enum(EVENT_LIFECYCLE_VALUES),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.lifecycle !== 'cancelled' || Boolean(v.reason), {
    path: ['reason'],
    message: 'Say why the event is being cancelled — participants are told',
  });

export const listEventsSchema = z.object({
  q: z.string().trim().max(120).optional(),
  categoryId: z.string().uuid().optional(),
  lifecycle: z.enum(EVENT_LIFECYCLE_VALUES).optional(),
  organizerId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const idParam = z.object({ id: z.string().uuid('Unknown event') });
export const idOrSlugParam = z.object({ idOrSlug: z.string().trim().min(1).max(160) });
