import { z } from 'zod';
import {
  ATTENDANCE_VALUES,
  PAYMENT_METHOD_VALUES,
  REGISTRATION_STATUS_VALUES,
} from '../../config/constants.js';

export const createRegistrationSchema = z.object({
  eventId: z.string().min(1, 'Choose an event'),
  /** Administrators may book on someone's behalf; a member may only book themselves. */
  memberId: z.string().optional(),
  method: z.enum(PAYMENT_METHOD_VALUES).default('upi'),
  /** Optional client-supplied IDs. */
  id: z.string().optional(),
  paymentId: z.string().optional(),
});

export const cancelSchema = z.object({
  reason: z.string().trim().min(1, 'Say why the seat is being released').max(300),
});

export const markAttendanceSchema = z.object({
  /* Optional: the gate marks today, but an organiser correcting the register
     afterwards names the day they are correcting. */
  sessionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-14')
    .optional(),
});

/* Unmarking always names the day — there is no "today" default, because a
   correction is deliberate and guessing which day to erase is not. */
export const unmarkAttendanceParams = z.object({
  id: z.string().uuid('That is not a valid id'),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-14'),
});

export const attendanceSchema = z.object({
  attendance: z.enum(ATTENDANCE_VALUES),
});

export const checkInSchema = z.object({
  eventId: z.string().uuid('Choose an event'),
  /* Long enough for the whole QR payload, not just the bare code:
     "AARAMBAM:<8-char code>:<36-char uuid>" is 54 characters, and the old cap
     of 40 refused every camera scan with a validation error before the
     resolver ever saw it. */
  code: z.string().trim().min(4, 'Enter a ticket code').max(200),
});

export const listSchema = z.object({
  eventId: z.string().uuid().optional(),
  memberId: z.string().uuid().optional(),
  status: z.enum(REGISTRATION_STATUS_VALUES).optional(),
  attendance: z.enum(ATTENDANCE_VALUES).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const idParam = z.object({ id: z.string().uuid('Unknown registration') });
