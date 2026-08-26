/**
 * The membership plans, exactly as the organisation gave them.
 *
 *   Normal, 18 and over    Rs 300
 *   Under 18               Rs 100
 *   Patron                 Rs 3,000  — supports one student
 *
 * These replace the four we had invented (Basic 500 / Standard 1,200 /
 * Premium 2,500 / Student 300), which were placeholders and were charging
 * figures nobody had agreed to.
 *
 * The benefit lines are kept deliberately short and literally true: member
 * pricing and the twelve-month term are things the software actually does, and
 * the patron line is the organisation's own wording. Nothing else is claimed
 * here, because a benefit printed on a paid plan is a promise, and the last set
 * promised things like "reserved seating at cultural evenings" that nobody had
 * undertaken to provide.
 */
export const MEMBERSHIP_PLANS = [
  {
    id: 'plan-junior',
    name: 'Under 18',
    description: 'For members under the age of eighteen.',
    price: 100,
    durationMonths: 12,
    benefits: [
      'Member pricing on every ticketed event',
      'Twelve months from the day you join',
      'A guardian’s details are recorded with the membership',
    ],
    active: true,
    recommended: false,
    sortOrder: 1,
  },
  {
    id: 'plan-normal',
    name: 'Normal',
    description: 'For members aged eighteen and over.',
    price: 300,
    durationMonths: 12,
    benefits: ['Member pricing on every ticketed event', 'Twelve months from the day you join'],
    active: true,
    /* The one most people are expected to take. */
    recommended: true,
    sortOrder: 2,
  },
  {
    id: 'plan-patron',
    name: 'Patron',
    description: 'Membership for yourself, and a year of it for a student who could not otherwise join.',
    price: 3000,
    durationMonths: 12,
    benefits: [
      'Member pricing on every ticketed event',
      'Twelve months from the day you join',
      'Supports one student’s membership for a year',
    ],
    active: true,
    recommended: false,
    sortOrder: 3,
  },
];

export default MEMBERSHIP_PLANS;
