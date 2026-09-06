import { dateOnly, today } from './today.js';

/**
 * How old a member is, and whether a plan will have them.
 *
 * The "Under 18" plan was under-18 in its name and nowhere else: a nineteen
 * year old could pick it and pay a hundred rupees rather than three hundred,
 * and neither the form, the API nor the database objected. The bound now lives
 * on the plan row, and this is where it is read.
 */

/**
 * A member's age today.
 *
 * `members.age` is what somebody typed on the day they joined and it is never
 * revised — a member who signed up at seventeen still reads seventeen on their
 * nineteenth birthday. Date of birth is the durable fact, so it wins wherever
 * it is recorded; the stored number is a fallback for older records that have
 * none.
 *
 * Reckoned against the organisation's own date rather than the server's. A
 * birthday in Coonoor turns at midnight IST, and the box this runs on is UTC.
 *
 * Returns `null` when there is nothing to go on.
 */
export function currentAge(member, on = today()) {
  const born = member?.date_of_birth ?? member?.dateOfBirth ?? null;

  if (born) {
    const [by, bm, bd] = dateOnly(born).split('-').map(Number);
    const [ny, nm, nd] = dateOnly(on).split('-').map(Number);
    if (by && bm && bd && ny) {
      /* Subtract a year when this year's birthday has not come round yet. */
      const years = ny - by - (nm < bm || (nm === bm && nd < bd) ? 1 : 0);
      if (years >= 0 && years <= 120) return years;
    }
  }

  const stated = Number(member?.age);
  return Number.isFinite(stated) && stated > 0 && stated <= 120 ? stated : null;
}

/** Reads the bounds off a plan row or a serialised plan — either shape. */
const bounds = (plan) => ({
  min: plan?.min_age ?? plan?.minAge ?? null,
  max: plan?.max_age ?? plan?.maxAge ?? null,
});

/** True when the plan restricts who may take it. */
export const isAgeRestricted = (plan) => {
  const { min, max } = bounds(plan);
  return min !== null || max !== null;
};

/**
 * Why this member may not take this plan, or `null` if they may.
 *
 * The message is the one the member sees, so it says what the rule is rather
 * than that a rule exists.
 */
export function planAgeProblem(plan, age) {
  const { min, max } = bounds(plan);
  if (min === null && max === null) return null;

  if (age === null) {
    return `The ${plan.name} plan has an age limit — add your date of birth to your profile first`;
  }

  if (min !== null && age < min) {
    return `The ${plan.name} plan is for members aged ${min} and over. You are ${age}.`;
  }
  if (max !== null && age > max) {
    return `The ${plan.name} plan is for members aged ${max} and under. You are ${age}.`;
  }
  return null;
}

export default { currentAge, isAgeRestricted, planAgeProblem };
