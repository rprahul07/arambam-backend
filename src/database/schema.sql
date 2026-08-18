-- ===========================================================================
-- Aarambam — Event & Membership Management
-- PostgreSQL schema
--
-- Every table, column and CHECK constraint here mirrors a declaration in
-- `arambham-frontend/src/types/index.ts`. The front end is the contract: a
-- column name maps to its camelCase field, and an enum's members are exactly
-- the union's members. Nothing is stored that the interface cannot show, and
-- nothing the interface shows is derived from a column that does not exist.
--
-- Safe to run repeatedly. Runs identically on Supabase and on the embedded
-- PGlite engine, so `gen_random_uuid()` (core since PG 13) is used rather
-- than the pgcrypto extension.
-- ===========================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- USERS — the login. `Role`, `AccountStatus` and `User` in the front end.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  email                text NOT NULL,
  phone                text NOT NULL DEFAULT '',
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'member'
                         CHECK (role IN ('administrator','organizer','member')),
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','inactive')),
  email_verified       boolean NOT NULL DEFAULT false,
  avatar_url           text,
  last_login_at        timestamptz,
  email_verify_token   text,
  email_verify_expires timestamptz,
  reset_token          text,
  reset_expires        timestamptz,
  pending_email        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Email is the login identifier and is matched case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key       ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_role_idx               ON users (role);
CREATE INDEX IF NOT EXISTS users_status_idx             ON users (status);
CREATE INDEX IF NOT EXISTS users_created_at_idx         ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS users_verify_token_idx       ON users (email_verify_token)
  WHERE email_verify_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_reset_token_idx        ON users (reset_token)
  WHERE reset_token IS NOT NULL;

DROP TRIGGER IF EXISTS users_touch ON users;
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- REFRESH TOKENS — rotating sessions, revocable per device.
-- Only a SHA-256 digest is stored, so the table is inert if it leaks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  ip_address text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- MEMBERS — the profile from the bilingual registration form (v0.2):
-- personal, contact, address, guardian, ID proof, medical and consents.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS member_number_seq START 1043;

CREATE TABLE IF NOT EXISTS members (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  member_id                text NOT NULL UNIQUE,          -- ARM-1042

  -- personal
  full_name                text NOT NULL,
  age                      integer NOT NULL CHECK (age >= 0 AND age <= 120),
  date_of_birth            date,
  gender                   text NOT NULL CHECK (gender IN ('male','female','other')),
  photo_url                text,

  -- contact
  email                    text NOT NULL,
  phone                    text NOT NULL,
  whatsapp_number          text NOT NULL DEFAULT '',
  whatsapp_group_consent   boolean NOT NULL DEFAULT false,

  -- address
  address_line1            text NOT NULL DEFAULT '',
  address_line2            text,
  city                     text NOT NULL DEFAULT '',
  district                 text NOT NULL DEFAULT '',
  state                    text NOT NULL DEFAULT '',
  pincode                  text NOT NULL DEFAULT '',

  -- guardian: required by the form when age is under 18
  guardian_name            text,
  guardian_relation        text CHECK (guardian_relation IN ('father','mother','guardian')),
  guardian_phone           text,

  -- identity
  id_proof_type            text NOT NULL DEFAULT 'aadhaar'
                             CHECK (id_proof_type IN ('aadhaar','voter_id','driving_licence')),
  id_proof_number          text NOT NULL DEFAULT '',

  -- medical
  has_medical_conditions   boolean NOT NULL DEFAULT false,
  medical_notes            text,

  -- consent
  media_consent            boolean NOT NULL DEFAULT false,
  declaration_accepted     boolean NOT NULL DEFAULT false,

  -- membership
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('active','expired','pending','suspended')),
  joined_at                timestamptz NOT NULL DEFAULT now(),
  current_subscription_id  uuid,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- The form makes the guardian block mandatory for minors; the database
  -- refuses to hold a minor's record without it rather than trusting the UI.
  CONSTRAINT members_guardian_required CHECK (
    age >= 18 OR (guardian_name IS NOT NULL AND guardian_phone IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS members_status_idx    ON members (status);
CREATE INDEX IF NOT EXISTS members_joined_idx    ON members (joined_at DESC);
CREATE INDEX IF NOT EXISTS members_name_idx      ON members (lower(full_name));
CREATE INDEX IF NOT EXISTS members_email_idx     ON members (lower(email));
CREATE INDEX IF NOT EXISTS members_code_idx      ON members (lower(member_id));
CREATE INDEX IF NOT EXISTS members_user_idx      ON members (user_id);

DROP TRIGGER IF EXISTS members_touch ON members;
CREATE TRIGGER members_touch BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- MEMBERSHIP PLANS — administrator-configurable tiers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS membership_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  price           numeric(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  duration_months integer NOT NULL CHECK (duration_months > 0),
  benefits        jsonb NOT NULL DEFAULT '[]'::jsonb,
  active          boolean NOT NULL DEFAULT true,
  recommended     boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS membership_plans_name_key ON membership_plans (lower(name));
CREATE INDEX IF NOT EXISTS membership_plans_active_idx      ON membership_plans (active, sort_order);

DROP TRIGGER IF EXISTS membership_plans_touch ON membership_plans;
CREATE TRIGGER membership_plans_touch BEFORE UPDATE ON membership_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- SUBSCRIPTIONS — a member's plan with a validity window.
-- `startDate` / `endDate` are plain calendar dates, as the front end stores.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES membership_plans(id) ON DELETE RESTRICT,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  amount      numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  -- 'scheduled' is paid for but not yet in force: an early renewal, or a
  -- downgrade that takes effect when the current term ends. Keeping it
  -- distinct from 'active' is what stops a future term from being treated as
  -- the membership in force.
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('active','scheduled','expired','cancelled','pending')),
  kind        text NOT NULL DEFAULT 'new'
                CHECK (kind IN ('new','renewal','upgrade','downgrade')),
  payment_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS subscriptions_member_idx  ON subscriptions (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscriptions_plan_idx    ON subscriptions (plan_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx  ON subscriptions (status);
CREATE INDEX IF NOT EXISTS subscriptions_end_idx     ON subscriptions (end_date);
-- Supports the renewal-reminder job without scanning the table.
CREATE INDEX IF NOT EXISTS subscriptions_active_end_idx ON subscriptions (end_date)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS subscriptions_touch ON subscriptions;
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_current_subscription_fk') THEN
    ALTER TABLE members ADD CONSTRAINT members_current_subscription_fk
      FOREIGN KEY (current_subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- The CREATE TABLE above only runs on a fresh database, so widening the
-- vocabulary has to be stated separately for one that already exists.
DO $$
BEGIN
  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
  ALTER TABLE subscriptions ADD  CONSTRAINT subscriptions_status_check
    CHECK (status IN ('active','scheduled','expired','cancelled','pending'));

  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_kind_check;
  ALTER TABLE subscriptions ADD  CONSTRAINT subscriptions_kind_check
    CHECK (kind IN ('new','renewal','upgrade','downgrade'));
END $$;

-- Rows written before the rule below existed may already break it: stacking
-- was possible, so a member can hold several 'active' subscriptions at once.
-- They are sorted out here, or the unique indexes cannot be created.
--
-- Nobody loses coverage: a term already finished becomes history, a term not
-- yet begun becomes 'scheduled', and where several still overlap the one
-- running longest is kept — it covers every day the others did.
DO $$
DECLARE
  repaired integer;
BEGIN
  UPDATE subscriptions SET status = 'expired'
   WHERE status = 'active' AND end_date < CURRENT_DATE;

  UPDATE subscriptions SET status = 'scheduled'
   WHERE status = 'active' AND start_date > CURRENT_DATE;

  WITH ranked AS (
    SELECT id, row_number() OVER (
             PARTITION BY member_id ORDER BY end_date DESC, created_at DESC, id
           ) AS seq
      FROM subscriptions WHERE status = 'active'
  )
  UPDATE subscriptions s SET status = 'expired'
    FROM ranked WHERE ranked.id = s.id AND ranked.seq > 1;
  GET DIAGNOSTICS repaired = ROW_COUNT;
  IF repaired > 0 THEN
    RAISE NOTICE 'Superseded % overlapping active subscription(s)', repaired;
  END IF;

  WITH ranked AS (
    SELECT id, row_number() OVER (
             PARTITION BY member_id ORDER BY start_date, created_at, id
           ) AS seq
      FROM subscriptions WHERE status = 'scheduled'
  )
  UPDATE subscriptions s SET status = 'expired'
    FROM ranked WHERE ranked.id = s.id AND ranked.seq > 1;
  GET DIAGNOSTICS repaired = ROW_COUNT;
  IF repaired > 0 THEN
    RAISE NOTICE 'Superseded % stacked future subscription(s)', repaired;
  END IF;
END $$;

-- A member may hold one membership in force and one queued behind it, never
-- two of either. This is the guarantee the purchase rules rely on; enforcing
-- it here means a race between two requests cannot produce a stack.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_idx
  ON subscriptions (member_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_scheduled_idx
  ON subscriptions (member_id) WHERE status = 'scheduled';
-- Finding the end of a member's paid-up chain.
CREATE INDEX IF NOT EXISTS subscriptions_member_end_idx
  ON subscriptions (member_id, end_date DESC)
  WHERE status IN ('active','scheduled');

-- ---------------------------------------------------------------------------
-- EVENT CATEGORIES — drive calendar colour coding and the category chips.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  color       text NOT NULL DEFAULT 'var(--color-lilac-500)',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS event_categories_name_key ON event_categories (lower(name));
CREATE INDEX IF NOT EXISTS event_categories_active_idx      ON event_categories (active);

DROP TRIGGER IF EXISTS event_categories_touch ON event_categories;
CREATE TRIGGER event_categories_touch BEFORE UPDATE ON event_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- EVENTS
--
-- `date` + `startTime` + `endTime` are stored exactly as the front end models
-- them — a calendar date and two wall-clock times. Collapsing them into a
-- timestamptz would move an evening event across a date boundary for anyone
-- viewing it from another timezone, which is not what a venue means by
-- "Saturday, 18:30".
--
-- `lifecycle` is the only status stored. "Sold out" and "registration closed"
-- are derived from the clock and the seat count, never written down.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text NOT NULL UNIQUE,
  title                  text NOT NULL,
  summary                text NOT NULL DEFAULT '',
  description            text NOT NULL DEFAULT '',
  category_id            uuid REFERENCES event_categories(id) ON DELETE SET NULL,
  cover_image_url        text,

  venue_name             text NOT NULL DEFAULT '',
  venue_address          text NOT NULL DEFAULT '',
  city                   text NOT NULL DEFAULT '',

  date                   date NOT NULL,
  start_time             text NOT NULL CHECK (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  end_time               text NOT NULL CHECK (end_time   ~ '^[0-2][0-9]:[0-5][0-9]$'),

  registration_opens_at  timestamptz NOT NULL,
  registration_closes_at timestamptz NOT NULL,

  capacity               integer NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  lifecycle              text NOT NULL DEFAULT 'draft'
                           CHECK (lifecycle IN ('draft','published','cancelled','completed')),

  type                   text NOT NULL DEFAULT 'free' CHECK (type IN ('free','paid')),
  member_price           numeric(10,2) NOT NULL DEFAULT 0 CHECK (member_price >= 0),
  non_member_price       numeric(10,2) NOT NULL DEFAULT 0 CHECK (non_member_price >= 0),

  organizer_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at           timestamptz,
  cancellation_reason    text,
  reminder_sent_at       timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT events_registration_window CHECK (registration_closes_at >= registration_opens_at),
  CONSTRAINT events_free_is_free CHECK (
    type = 'paid' OR (member_price = 0 AND non_member_price = 0)
  )
);

CREATE INDEX IF NOT EXISTS events_lifecycle_idx      ON events (lifecycle);
CREATE INDEX IF NOT EXISTS events_date_idx           ON events (date);
CREATE INDEX IF NOT EXISTS events_category_idx       ON events (category_id);
CREATE INDEX IF NOT EXISTS events_organizer_idx      ON events (organizer_id);
CREATE INDEX IF NOT EXISTS events_title_idx          ON events (lower(title));
-- The public event list is always "published, ordered by date".
CREATE INDEX IF NOT EXISTS events_lifecycle_date_idx ON events (lifecycle, date);

DROP TRIGGER IF EXISTS events_touch ON events;
CREATE TRIGGER events_touch BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- REGISTRATIONS — a seat on an event, with its ticket and attendance.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS registration_ref_seq START 1;

CREATE TABLE IF NOT EXISTS registrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE,           -- REG-20260814-0031
  event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id           uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  participant_name    text NOT NULL,
  ticket_code         text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'pending_payment'
                        CHECK (status IN ('confirmed','pending_payment','cancelled')),
  attendance          text NOT NULL DEFAULT 'not_checked_in'
                        CHECK (attendance IN ('not_checked_in','attended','absent')),
  priced_as_member    boolean NOT NULL DEFAULT false,
  amount              numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  payment_id          uuid,
  registered_at       timestamptz NOT NULL DEFAULT now(),
  checked_in_at       timestamptz,
  checked_in_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at        timestamptz,
  cancellation_reason text,
  hold_expires_at     timestamptz,       -- unpaid seats are released after this
  reminder_sent_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One live seat per member per event. Cancelled rows stay for the history, so
-- the constraint is partial. This is the race-condition guard for a member who
-- double-submits: the second insert loses on the index, not on a read-then-write.
CREATE UNIQUE INDEX IF NOT EXISTS registrations_one_live_seat_idx
  ON registrations (event_id, member_id) WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS registrations_event_idx    ON registrations (event_id);
CREATE INDEX IF NOT EXISTS registrations_member_idx   ON registrations (member_id, registered_at DESC);
CREATE INDEX IF NOT EXISTS registrations_status_idx   ON registrations (status);
CREATE INDEX IF NOT EXISTS registrations_ticket_idx   ON registrations (ticket_code);
CREATE INDEX IF NOT EXISTS registrations_ref_idx      ON registrations (reference);
-- Counting occupied seats for an event is the hottest read in the product.
CREATE INDEX IF NOT EXISTS registrations_seat_count_idx ON registrations (event_id)
  WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS registrations_hold_idx     ON registrations (hold_expires_at)
  WHERE status = 'pending_payment';

DROP TRIGGER IF EXISTS registrations_touch ON registrations;
CREATE TRIGGER registrations_touch BEFORE UPDATE ON registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- PAYMENTS — one row per transaction attempt, for a membership or a seat.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 1;

CREATE TABLE IF NOT EXISTS payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,       -- gateway reference
  receipt_no         text UNIQUE,                -- issued on success only
  member_id          uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  payer_name         text NOT NULL,
  purpose            text NOT NULL CHECK (purpose IN ('membership','event')),
  subscription_id    uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  registration_id    uuid REFERENCES registrations(id) ON DELETE SET NULL,
  description        text NOT NULL DEFAULT '',
  amount             numeric(10,2) NOT NULL CHECK (amount >= 0),
  method             text NOT NULL DEFAULT 'upi'
                       CHECK (method IN ('upi','card','netbanking','wallet','qr_upi')),
  -- 'awaiting_verification' is the state a payment made outside the system
  -- sits in: the payer says they have paid and has quoted a reference, and
  -- an administrator has not yet checked it against the bank. Nothing is
  -- confirmed on the payer's word alone.
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('successful','pending','awaiting_verification','failed','cancelled')),

  /* ---- payment made outside the system (QR / SBI Collect) ---- */
  -- The UTR or SBI Collect reference the payer quotes. Unique across the
  -- table: one bank reference can settle exactly one thing, which is what
  -- stops the same transfer being claimed twice.
  claim_reference    text,
  claim_note         text,
  -- Optional, and asked for before paying rather than after: some payers need
  -- it on the receipt, most do not.
  payer_pan          text,
  claim_proof_url    text,
  claimed_at         timestamptz,
  verified_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at        timestamptz,
  rejection_reason   text,
  gateway            text NOT NULL DEFAULT 'simulated',
  gateway_order_id   text,
  gateway_payment_id text,
  gateway_response   jsonb,
  failure_reason     text,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- A payment settles exactly one thing, and a successful one always has a
  -- receipt. Both are invariants the receipts and reports rely on.
  CONSTRAINT payments_single_target CHECK (
    (purpose = 'membership' AND subscription_id IS NOT NULL AND registration_id IS NULL) OR
    (purpose = 'event'      AND registration_id IS NOT NULL AND subscription_id IS NULL)
  ),
  CONSTRAINT payments_receipt_on_success CHECK (
    status <> 'successful' OR (receipt_no IS NOT NULL AND completed_at IS NOT NULL)
  ),
  -- A claim is a claim: it has to carry the reference being claimed.
  CONSTRAINT payments_claim_has_reference CHECK (
    status <> 'awaiting_verification' OR claim_reference IS NOT NULL
  )
);

-- One bank reference settles one payment. Enforced here rather than in code
-- so two administrators approving at the same moment cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS payments_claim_reference_key
  ON payments (lower(claim_reference)) WHERE claim_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_member_idx       ON payments (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_status_idx       ON payments (status);
CREATE INDEX IF NOT EXISTS payments_purpose_idx      ON payments (purpose);
CREATE INDEX IF NOT EXISTS payments_created_idx      ON payments (created_at DESC);
CREATE INDEX IF NOT EXISTS payments_subscription_idx ON payments (subscription_id);
CREATE INDEX IF NOT EXISTS payments_registration_idx ON payments (registration_id);
-- Revenue reporting always filters on successful payments by settlement date.
CREATE INDEX IF NOT EXISTS payments_revenue_idx      ON payments (completed_at)
  WHERE status = 'successful';
CREATE UNIQUE INDEX IF NOT EXISTS payments_gateway_order_idx ON payments (gateway_order_id)
  WHERE gateway_order_id IS NOT NULL;

DROP TRIGGER IF EXISTS payments_touch ON payments;
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_payment_fk') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_payment_fk
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'registrations_payment_fk') THEN
    ALTER TABLE registrations ADD CONSTRAINT registrations_payment_fk
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Paying outside the system: the columns above only appear on a fresh
-- database, so an existing one is brought up to the same shape here.
DO $$
BEGIN
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS claim_reference  text;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS claim_note       text;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_pan        text;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS claim_proof_url  text;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS claimed_at       timestamptz;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_by      uuid;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_at      timestamptz;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS rejection_reason text;

  ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
  ALTER TABLE payments ADD  CONSTRAINT payments_status_check
    CHECK (status IN ('successful','pending','awaiting_verification','failed','cancelled'));

  ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
  ALTER TABLE payments ADD  CONSTRAINT payments_method_check
    CHECK (method IN ('upi','card','netbanking','wallet','qr_upi'));

  ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_claim_has_reference;
  ALTER TABLE payments ADD  CONSTRAINT payments_claim_has_reference
    CHECK (status <> 'awaiting_verification' OR claim_reference IS NOT NULL);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_verified_by_fk') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_verified_by_fk
      FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  -- Where the money for an event is collected. Only an administrator may set
  -- it, and it is recorded on the event so a reconciliation years later can
  -- still say which account took the money.
  ALTER TABLE events ADD COLUMN IF NOT EXISTS payment_qr_url text;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS payment_qr_mode text NOT NULL DEFAULT 'trust';
  ALTER TABLE events DROP CONSTRAINT IF EXISTS events_qr_mode_check;
  ALTER TABLE events ADD  CONSTRAINT events_qr_mode_check
    CHECK (payment_qr_mode IN ('trust','own'));
  -- Choosing your own QR means supplying one.
  ALTER TABLE events DROP CONSTRAINT IF EXISTS events_own_qr_has_url;
  ALTER TABLE events ADD  CONSTRAINT events_own_qr_has_url
    CHECK (payment_qr_mode <> 'own' OR payment_qr_url IS NOT NULL);
END $$;

CREATE INDEX IF NOT EXISTS payments_awaiting_idx ON payments (claimed_at)
  WHERE status = 'awaiting_verification';

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS — the in-app notification centre.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN (
               'account_registered','email_verification','payment_confirmation',
               'event_registration','event_reminder','membership_activated',
               'membership_upgraded','membership_renewal_due','event_cancelled',
               'event_rescheduled')),
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  href       text,
  read       boolean NOT NULL DEFAULT false,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx   ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read = false;

-- ---------------------------------------------------------------------------
-- EMAIL TEMPLATES — the six templates the settings screen edits.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  key         text PRIMARY KEY CHECK (key IN (
                'account_registration','payment_confirmation','event_confirmation',
                'event_reminder','renewal_reminder','event_cancellation')),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  subject     text NOT NULL,
  body        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  variables   jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order  integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS email_templates_touch ON email_templates;
CREATE TRIGGER email_templates_touch BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- SETTINGS — singleton configuration documents, keyed by name.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- EMAIL LOG — a delivery trail for support.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email   text NOT NULL,
  subject    text NOT NULL,
  template   text,
  status     text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped')),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_log_created_idx ON email_log (created_at DESC);

-- ---------------------------------------------------------------------------
-- ACTIVITY LOG — who changed what. Written for every administrative action.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_type text NOT NULL,
  subject_id  uuid,
  action      text NOT NULL,
  description text NOT NULL DEFAULT '',
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_log_subject_idx ON activity_log (subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_actor_idx   ON activity_log (actor_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seat counts, as one indexed read instead of a per-event query. This is what
-- keeps the event list off an N+1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW event_seat_counts AS
SELECT
  e.id                                            AS event_id,
  e.capacity                                      AS capacity,
  COALESCE(COUNT(r.id) FILTER (
    WHERE r.status IN ('confirmed','pending_payment')
  ), 0)::int                                      AS booked
FROM events e
LEFT JOIN registrations r ON r.event_id = e.id
GROUP BY e.id, e.capacity;
