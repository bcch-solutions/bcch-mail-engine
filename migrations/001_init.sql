-- ============================================================
-- BCCH MAIL ENGINE — Migración inicial de base de datos
-- Se aplica automáticamente en Docker Compose (postgres initdb)
-- o manualmente con: npm run migrate
-- ============================================================

CREATE TABLE IF NOT EXISTS engine_accounts (
  id uuid PRIMARY KEY,
  builder_account_id uuid NOT NULL UNIQUE,
  email_address text NOT NULL,
  domain_dns text NOT NULL,
  imap_server text NOT NULL,
  imap_port int NOT NULL,
  imap_security text NOT NULL,
  smtp_server text NOT NULL,
  smtp_port int NOT NULL,
  smtp_security text NOT NULL,
  auth_method text NOT NULL,
  connection_state text NOT NULL DEFAULT 'disconnected',
  last_sync_at timestamptz,
  last_error text,
  credential_blob jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES engine_accounts(id) ON DELETE CASCADE,
  path text NOT NULL,
  name text NOT NULL,
  uidvalidity bigint,
  last_uid bigint,
  unread_count int NOT NULL DEFAULT 0,
  last_synced_at timestamptz,
  UNIQUE (account_id, path)
);

CREATE TABLE IF NOT EXISTS engine_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES engine_accounts(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES engine_folders(id) ON DELETE CASCADE,
  uid bigint,
  message_id_hash text,
  from_address text,
  to_addresses text,
  cc_addresses text,
  subject text,
  preview text,
  has_attachments boolean NOT NULL DEFAULT false,
  is_read boolean NOT NULL DEFAULT false,
  is_flagged boolean NOT NULL DEFAULT false,
  is_important boolean NOT NULL DEFAULT false,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, uid),
  UNIQUE (account_id, message_id_hash)
);

CREATE INDEX IF NOT EXISTS engine_messages_account_uid_idx ON engine_messages (account_id, uid);

CREATE TABLE IF NOT EXISTS engine_outgoing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES engine_accounts(id) ON DELETE CASCADE,
  user_id uuid,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL,
  message_id_hash text,
  smtp_message_id text,
  error text,
  attempt int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id_hash)
);

CREATE TABLE IF NOT EXISTS engine_scheduled (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES engine_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_event_log (
  id bigserial PRIMARY KEY,
  account_id uuid,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_metadata_cache (
  key text PRIMARY KEY,
  value jsonb,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_key_versions (
  version int PRIMARY KEY,
  active boolean NOT NULL DEFAULT false,
  key_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);