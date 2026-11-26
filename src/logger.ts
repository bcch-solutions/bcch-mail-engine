// ============================================================
// BCCH MAIL ENGINE — Logger estructurado (pino)
// Nunca registra contraseñas ni tokens.
// ============================================================
import pino from "pino";
import { config } from "./config.js";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.secret_value",
  "*.credential_secret",
  "*.serviceHmacSecret",
  "*.credentialEncKey",
  "*.builderSupabaseKey",
  "*.imap_password",
  "*.smtp_password",
];

export const log = pino({
  level: config.logLevel,
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  base: { service: "bcch-mail-engine", version: "1.0.0" },
});

export type Logger = typeof log;