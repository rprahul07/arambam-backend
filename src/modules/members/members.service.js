import crypto from 'node:crypto';
import { query, queryAll, queryOne, withTransaction } from '../../database/index.js';
import env from '../../config/env.js';
import { MEMBERSHIP_STATUS, ROLES } from '../../config/constants.js';
import ApiError from '../../utils/ApiError.js';
import { memberCode } from '../../utils/codes.js';
import { hashPassword } from '../../utils/password.js';
import { randomToken } from '../../utils/jwt.js';
import { toMember } from '../../serializers/index.js';
import { sendTemplate } from '../../services/email.service.js';
import { push } from '../../services/notification.service.js';
import { recordQuietly } from '../../services/activity.service.js';
import logger from '../../utils/logger.js';

/**
 * Member profiles.
 *
 * A member is always a user plus a profile. Creating one from the admin screen
 * creates both in a single transaction and emails the person a link to set
 * their own password — the administrator never chooses it, and never sees it.
 */

const WRITABLE = {
  fullName: 'full_name',
  age: 'age',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  photoUrl: 'photo_url',
  email: 'email',
  phone: 'phone',
  whatsappNumber: 'whatsapp_number',
  whatsappGroupConsent: 'whatsapp_group_consent',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  district: 'district',
  state: 'state',
  pincode: 'pincode',
  guardianName: 'guardian_name',
  guardianRelation: 'guardian_relation',
  guardianPhone: 'guardian_phone',
  idProofType: 'id_proof_type',
  idProofNumber: 'id_proof_number',
  hasMedicalConditions: 'has_medical_conditions',
  medicalNotes: 'medical_notes',
  mediaConsent: 'media_consent',
  declarationAccepted: 'declaration_accepted',
};

export const findById = (id) => queryOne(`SELECT * FROM members WHERE id = $1`, [id]);
export const findByUserId = (userId) => queryOne(`SELECT * FROM members WHERE user_id = $1`, [userId]);

/**
 * The next `ARM-####`. A sequence rather than `MAX(...) + 1`, so two
 * administrators saving at the same moment cannot mint the same id.
 */
async function nextMemberCode(client) {
  const row = await client.queryOne(`SELECT nextval('member_number_seq')::int AS n`);
  return memberCode(row.n);
}

/** Only the member themselves, or staff, may read or write a profile. */
export function assertMayAccess(user, member) {
  if (user.role === ROLES.ADMIN) return;
  if (member.user_id === user.id) return;
  if (user.role === ROLES.ORGANIZER) return; // door lists are part of the job
  throw ApiError.forbidden('That is not your profile');
}

export function assertMayEdit(user, member) {
  if (user.role === ROLES.ADMIN) return;
  if (member.user_id === user.id) return;
  throw ApiError.forbidden('That is not your profile');
}

/* ----------------------------------------------------------------- reading */

export async function list(filters) {
  const where = [];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.q) {
    const q = bind(filters.q);
    where.push(
      `(m.full_name ILIKE '%' || ${q} || '%' OR m.email ILIKE '%' || ${q} || '%'
        OR m.phone ILIKE '%' || ${q} || '%' OR m.member_id ILIKE '%' || ${q} || '%')`,
    );
  }
  if (filters.status) where.push(`m.status = ${bind(filters.status)}`);
  if (filters.planId) where.push(`s.plan_id = ${bind(filters.planId)}`);

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.pageSize;

  const rows = await queryAll(
    `SELECT m.*, COUNT(*) OVER ()::int AS total_count
     FROM members m
     LEFT JOIN subscriptions s ON s.id = m.current_subscription_id
     ${clause}
     ORDER BY m.joined_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.pageSize, offset],
  );

  const total = rows[0]?.total_count ?? 0;
  return {
    rows: rows.map(toMember),
    meta: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

/* ----------------------------------------------------------------- writing */

export async function create(input, actor) {
  const clash = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1)`, [input.email]);
  if (clash) {
    throw ApiError.conflict('An account already uses this email address', {
      email: 'An account already uses this email address',
    });
  }

  if (input.planId) {
    const plan = await queryOne(`SELECT id FROM membership_plans WHERE id = $1 AND active = true`, [
      input.planId,
    ]);
    if (!plan) throw ApiError.badRequest('That plan is not available', { planId: 'Unknown plan' });
  }

  const setupToken = randomToken();
  // A password nobody knows: the account is unusable until the person follows
  // the emailed link and chooses one.
  const placeholder = await hashPassword(crypto.randomBytes(24).toString('hex'));

  const member = await withTransaction(async (tx) => {
    const user = await tx.queryOne(
      `INSERT INTO users (name, email, phone, password_hash, role, status, email_verified,
                          reset_token, reset_expires)
       VALUES ($1,$2,$3,$4,'member','active',false,$5,$6)
       RETURNING *`,
      [
        input.fullName,
        input.email,
        input.phone,
        placeholder,
        setupToken,
        new Date(Date.now() + env.security.emailVerifyTtlHours * 3600 * 1000),
      ],
    );

    const code = await nextMemberCode(tx);
    const row = await tx.queryOne(
      `INSERT INTO members (
         id, user_id, member_id, full_name, age, date_of_birth, gender, photo_url,
         email, phone, whatsapp_number, whatsapp_group_consent,
         address_line1, address_line2, city, district, state, pincode,
         guardian_name, guardian_relation, guardian_phone,
         id_proof_type, id_proof_number,
         has_medical_conditions, medical_notes,
         media_consent, declaration_accepted, status)
       VALUES (COALESCE($26::uuid, gen_random_uuid()),
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,true,'pending')
       RETURNING *`,
      [
        user.id,
        code,
        input.fullName,
        input.age,
        input.dateOfBirth ?? null,
        input.gender,
        input.photoUrl ?? null,
        input.email,
        input.phone,
        input.whatsappNumber,
        input.whatsappGroupConsent,
        input.addressLine1,
        input.addressLine2 ?? null,
        input.city,
        input.district,
        input.state,
        input.pincode,
        input.guardianName ?? null,
        input.guardianRelation ?? null,
        input.guardianPhone ?? null,
        input.idProofType,
        input.idProofNumber,
        input.hasMedicalConditions,
        input.hasMedicalConditions ? (input.medicalNotes ?? null) : null,
        input.mediaConsent,
        input.id ?? null,
      ],
    );

    await push({
      client: tx,
      userId: user.id,
      type: 'account_registered',
      title: `Welcome to Aarambam, ${input.fullName.split(' ')[0]}`,
      body: `Your member id is ${code}. Set a password from the link in your email to sign in.`,
      href: '/member/dashboard',
    });

    return row;
  });

  sendTemplate('account_registration', input.email, {
    member_name: input.fullName,
    verification_link: `${env.clientUrl}/reset-password?token=${setupToken}&email=${encodeURIComponent(input.email)}`,
  }).catch((error) => logger.error('Welcome email failed:', error.message));

  recordQuietly({
    actorId: actor.id,
    subjectType: 'member',
    subjectId: member.id,
    action: 'create',
    description: `Added ${member.full_name} as ${member.member_id}`,
  });

  return toMember(member);
}

export async function update(id, patch, actor) {
  const member = await findById(id);
  if (!member) throw ApiError.notFound('That member no longer exists');
  assertMayEdit(actor, member);

  if (patch.email && patch.email.toLowerCase() !== member.email.toLowerCase()) {
    const clash = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2`, [
      patch.email,
      member.user_id,
    ]);
    if (clash) throw ApiError.conflict('That email address is already in use', { email: 'Already in use' });
  }

  const sets = [];
  const params = [];
  for (const [field, column] of Object.entries(WRITABLE)) {
    if (patch[field] === undefined) continue;
    params.push(patch[field]);
    sets.push(`${column} = $${params.length}`);
  }

  // Clearing the flag clears the note with it, rather than leaving a stale
  // medical detail on a record that says there is none.
  if (patch.hasMedicalConditions === false) sets.push(`medical_notes = NULL`);

  if (!sets.length) return toMember(member);

  const updated = await withTransaction(async (tx) => {
    params.push(id);
    const row = await tx.queryOne(
      `UPDATE members SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );

    // The account and the profile must not disagree about a person's name,
    // email or phone number — they are shown side by side on the settings page.
    const mirror = [];
    const mirrorParams = [];
    if (patch.fullName !== undefined) {
      mirrorParams.push(patch.fullName);
      mirror.push(`name = $${mirrorParams.length}`);
    }
    if (patch.email !== undefined) {
      mirrorParams.push(patch.email);
      mirror.push(`email = $${mirrorParams.length}`);
    }
    if (patch.phone !== undefined) {
      mirrorParams.push(patch.phone);
      mirror.push(`phone = $${mirrorParams.length}`);
    }
    if (mirror.length) {
      mirrorParams.push(member.user_id);
      await tx.query(`UPDATE users SET ${mirror.join(', ')} WHERE id = $${mirrorParams.length}`, mirrorParams);
    }

    return row;
  });

  recordQuietly({
    actorId: actor.id,
    subjectType: 'member',
    subjectId: id,
    action: 'update',
    description: `Updated ${updated.full_name}`,
    meta: { fields: Object.keys(patch) },
  });

  return toMember(updated);
}

/**
 * Suspending a membership deactivates the account with it — the front end's
 * status toggle means "this person cannot use Aarambam", not "this row says
 * suspended".
 */
export async function setStatus(id, { status, reason }, actor) {
  const member = await findById(id);
  if (!member) throw ApiError.notFound('That member no longer exists');

  const updated = await withTransaction(async (tx) => {
    const row = await tx.queryOne(`UPDATE members SET status = $1 WHERE id = $2 RETURNING *`, [
      status,
      id,
    ]);
    await tx.query(`UPDATE users SET status = $1 WHERE id = $2`, [
      status === MEMBERSHIP_STATUS.SUSPENDED ? 'inactive' : 'active',
      member.user_id,
    ]);
    if (status === MEMBERSHIP_STATUS.SUSPENDED) {
      await tx.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [member.user_id],
      );
    }
    return row;
  });

  recordQuietly({
    actorId: actor.id,
    subjectType: 'member',
    subjectId: id,
    action: `status:${status}`,
    description: `${updated.full_name} set to ${status}`,
    meta: { reason },
  });

  return toMember(updated);
}

/**
 * Removes a member and the account behind it. Registrations, subscriptions,
 * payments and notifications cascade with it, which is what "remove this
 * person's record" has to mean under data-protection rules.
 */
export async function remove(id, actor) {
  const member = await findById(id);
  if (!member) throw ApiError.notFound('That member no longer exists');

  await query(`DELETE FROM users WHERE id = $1`, [member.user_id]);

  recordQuietly({
    actorId: actor.id,
    subjectType: 'member',
    subjectId: id,
    action: 'delete',
    description: `Removed ${member.full_name} (${member.member_id})`,
  });
}

/** Everything the member detail screen shows about one person. */
export async function detail(id) {
  const member = await findById(id);
  if (!member) throw ApiError.notFound('That member no longer exists');

  const [subscriptions, payments, registrations] = await Promise.all([
    queryAll(`SELECT * FROM subscriptions WHERE member_id = $1 ORDER BY created_at DESC`, [id]),
    queryAll(`SELECT * FROM payments WHERE member_id = $1 ORDER BY created_at DESC`, [id]),
    queryAll(`SELECT * FROM registrations WHERE member_id = $1 ORDER BY registered_at DESC`, [id]),
  ]);

  return { member, subscriptions, payments, registrations };
}

export default { list, create, update, setStatus, remove, detail, findById, findByUserId, assertMayAccess };
