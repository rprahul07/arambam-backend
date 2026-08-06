import { z } from 'zod';
import {
  ATTENDANCE_VALUES,
  PAYMENT_METHOD_VALUES,
  REGISTRATION_STATUS_VALUES,
} from '../../config/constants.js';

export const createRegistrationSchema = z.object({
  eventId: z.string().uuid('Choose an event'),
  /** Administrators may book on someone's behalf; a member may only book themselves. */
  memberId: z.string().uuid().optional(),
  method: z.enum(PAYMENT_METHOD_VALUES).default('upi'),
  /** Optional client-supplied UUIDs — see `events.validation.js`. */
  id: z.string().uuid('Invalid id').optional(),
  paymentId: z.string().uuid('Invalid id').optional(),
});

export const cancelSchema = z.object({
  reason: z.string().trim().min(1, 'Say why the seat is being released').max(300),
});

export const attendanceSchema = z.object({
  attendance: z.enum(ATTENDANCE_VALUES),
});

export const checkInSchema = z.object({
  eventId: z.string().uuid('Choose an event'),
  code: z.string().trim().min(4, 'Enter a ticket code').max(40),
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
