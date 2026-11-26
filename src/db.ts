// ============================================================
// BCCH MAIL ENGINE — Cliente PostgreSQL (pg)
// Soporta una base de datos externa (p. ej. Cloud PostgreSQL)
// usando un esquema dedicado (DB_SCHEMA, por defecto "mail_engine")
// para mantener separación estricta de datos y permisos.
// ============================================================
import pg from "pg";
import { config } from "./config.js";
import { log } from "./logger.js";

export const DB_SCHEMA = config.dbSchema;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl || undefined,
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || "bcch_mail_engine",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: config.dbSsl ? { rejectUnauthorized: true } : undefined,
});

// Asegurar que cada conexión use el esquema dedicado del motor.
pool.on("connect", (client) => {
  client.query(`SET search_path TO ${DB_SCHEMA}, public`).catch(() => {});
});

pool.on("error", (err) => {
  log.error({ err: err.message }, "pool error pg");
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const dur = Date.now() - start;
  if (dur > 500) {
    log.warn({ text: text.slice(0, 120), dur }, "slow query");
  }
  return res;
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Crear esquema del motor en primera ejecución (idempotente)
export async function ensureSchema(): Promise<void> {
  // Crear el esquema dedicado si no existe (solo si el rol tiene permiso).
  await query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  await query(`SET search_path TO ${DB_SCHEMA}, public`);
  await query(`
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
  `);
  await query(`
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
  `);
  await query(`
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
  `);
  await query(`CREATE INDEX IF NOT EXISTS engine_messages_account_uid_idx ON engine_messages (account_id, uid);`);
  await query(`
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
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS engine_scheduled (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES engine_accounts(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      send_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'scheduled',
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS engine_event_log (
      id bigserial PRIMARY KEY,
      account_id uuid,
      event text NOT NULL,
      detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS engine_metadata_cache (
      key text PRIMARY KEY,
      value jsonb,
      expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS engine_key_versions (
      version int PRIMARY KEY,
      active boolean NOT NULL DEFAULT false,
      key_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS engine_queue (
      id bigserial PRIMARY KEY,
      queue text NOT NULL,
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0,
      visible_at timestamptz NOT NULL DEFAULT now(),
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS engine_queue_claim_idx ON engine_queue (queue, status, visible_at);`);
  log.info("schema ensured");
}