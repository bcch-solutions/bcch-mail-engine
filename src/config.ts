// ============================================================
// BCCH MAIL ENGINE — Configuración central
// ============================================================
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

function bool(key: string, def = false): boolean {
  const v = process.env[key];
  if (v === undefined) return def;
  return v === "true" || v === "1";
}
function num(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}
function str(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : def;
}
function strArr(key: string, def: string[]): string[] {
  const v = process.env[key];
  if (!v) return def;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// Los secretos se leen de forma perezosa (getter) para que los cambios en
// process.env (tests, rotación en caliente) se reflejen sin reiniciar.
export const config = {
  port: num("PORT", 8443),
  publicUrl: str("ENGINE_PUBLIC_URL", "https://mail-api.bcch.solutions"),
  logLevel: str("LOG_LEVEL", "info"),
  env: str("NODE_ENV", "development"),
  isProd: str("NODE_ENV", "development") === "production",

  // Servicio (lazy)
  get serviceHmacSecret() {
    return str("SERVICE_HMAC_SECRET", "dev-only-secret-replace-me");
  },
  tokenTtlMs: num("TOKEN_TTL_MS", 5 * 60 * 1000),

  // DB
  databaseUrl: str("DATABASE_URL", ""),
  // Esquema dedicado del motor (separación de datos en una BD compartida)
  dbSchema: str("DB_SCHEMA", "mail_engine"),
  dbSsl: bool("DB_SSL", true),

  // Colas: postgres (SiteGround, sin Redis) o redis (VPS/Docker)
  queueProvider: str("QUEUE_PROVIDER", "postgres") as "postgres" | "redis",
  redisUrl: str("REDIS_URL", "redis://127.0.0.1:6379/0"),

  // Sincronización: persistent (workers + IDLE) o periodic (cron / corta duración)
  syncMode: str("SYNC_MODE", "periodic") as "persistent" | "periodic",

  // Builder / Cloud (lazy)
  get builderSupabaseUrl() {
    return str("BUILDER_SUPABASE_URL", "");
  },
  get builderSupabaseKey() {
    return str("BUILDER_SUPABASE_PUBLISHABLE_KEY", "");
  },

  // Cifrado AES-256-GCM (lazy)
  get credentialEncKey() {
    return str("CREDENTIAL_ENC_KEY", "");
  },

  // Restricciones de red (SSRF) — lazy para que los tests puedan cambiar ALLOWED_PORTS
  get allowedMailDomains() {
    return strArr("ALLOWED_MAIL_DOMAINS", []);
  },
  get allowedPorts() {
    return strArr("ALLOWED_PORTS", ["993", "465", "587"]).map(Number);
  },
  get blockPrivateNetworks() {
    return bool("BLOCK_PRIVATE_NETWORKS", true);
  },

  // Sincronización
  syncInitialDays: num("SYNC_INITIAL_DAYS", 30),
  syncMaxConcurrency: num("SYNC_MAX_CONCURRENCY", 4),
  idleEnabled: bool("SYNC_IDLE_ENABLED", true),
  idleReconnectMs: num("SYNC_IDLE_RECONNECT_MS", 30000),

  // SMTP
  smtpMaxConcurrency: num("SMTP_MAX_CONCURRENCY", 2),
  smtpMaxRetries: num("SMTP_MAX_RETRIES", 5),
  smtpRetryBackoffMs: num("SMTP_RETRY_BACKOFF_MS", 2000),
  smtpRateLimitPerMin: num("SMTP_RATE_LIMIT_PER_MIN", 30),

  // Retención
  attachmentRetentionDays: num("ATTACHMENT_RETENTION_DAYS", 30),
  tempDir: str("TEMP_DIR", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tmp")),

  // CORS
  corsAllowedOrigin: str("CORS_ALLOWED_ORIGIN", "*"),
};

export type Config = typeof config;
