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
 * The benefit lines are kept short and literally true. A benefit printed on a
 * paid plan is a promise, and an earlier set promised things like "reserved
 * seating at cultural evenings" that nobody had undertaken to provide.
 *
 * "Member pricing on every ticketed event" was removed for the same reason: the
 * organisation confirmed there is no special ticket price for members, and
 * there could not be — everybody who comes to the centre is a member, so there
 * is one price and nothing to be preferential about. The software agrees; see
 * `priceFor`, which reads `member_price` for everyone.
 *
 * The patron line is the organisation's own wording, replacing ours. They
 * asked what "supports one student's membership for a year" meant, which is a
 * fair question about a sentence we wrote and they had not.
 */
export const MEMBERSHIP_PLANS = [
  {
    id: 'plan-junior',
    name: 'Under 18',
    description: 'For members under the age of eighteen.',
    price: 100,
    durationMonths: 12,
    benefits: [
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
    benefits: ['Twelve months from the day you join'],
    active: true,
    /* The one most people are expected to take. */
    recommended: true,
    sortOrder: 2,
  },
  {
    id: 'plan-patron',
    name: 'Patron',
    description: 'Membership for yourself, and for a student.',
    price: 3000,
    durationMonths: 12,
    benefits: [
      'Twelve months from the day you join',
      'Supports one student to participate in workshops at Aarambam',
    ],
    active: true,
    recommended: false,
    sortOrder: 3,
  },
];

export default MEMBERSHIP_PLANS;
