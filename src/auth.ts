// ============================================================
// BCCH MAIL ENGINE — Autenticación entre servicios
// Token de contexto de usuario firmado HMAC + verificación de permisos.
// ============================================================
import crypto from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";
import { fetchAccountMeta, builderClient } from "./builder-client.js";

export interface UserContext {
  userId: string;
  email: string;
  role: "superadmin" | "domain_admin" | "user";
  domainId?: string;
  companyId?: string;
  accountId?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: number;
}

const TOKEN_PREFIX = "bme.";

export function issueUserToken(ctx: {
  userId: string;
  email: string;
  role: "superadmin" | "domain_admin" | "user";
  domainId?: string;
  companyId?: string;
  accountId?: string;
}): IssuedToken {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + config.tokenTtlMs;
  const payload = {
    sub: ctx.userId,
    email: ctx.email,
    role: ctx.role,
    did: ctx.domainId,
    cid: ctx.companyId,
    aid: ctx.accountId,
    iat: issuedAt,
    exp: expiresAt,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(`${body}`);
  return { token: `${TOKEN_PREFIX}${body}.${sig}`, expiresAt };
}

export function verifyUserToken(token: string): UserContext | null {
  try {
    if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
    const rest = token.slice(TOKEN_PREFIX.length);
    const [body, sig] = rest.split(".");
    if (!body || !sig) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(body)))) {
      return null;
    }
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.exp === "number" && Date.now() > p.exp) return null;
    return {
      userId: p.sub,
      email: p.email,
      role: p.role,
      domainId: p.did,
      companyId: p.cid,
      accountId: p.aid,
      issuedAt: p.iat,
      expiresAt: p.exp,
    };
  } catch {
    return null;
  }
}

function sign(data: string): string {
  return crypto.createHmac("sha256", config.serviceHmacSecret).update(data).digest("base64url");
}

export async function requireServiceAuth(req: any, next: any): Promise<void> {
  const sig = req.headers["x-service-signature"];
  const ts = req.headers["x-service-timestamp"];
  const method = req.method;
  // Ruta absoluta sin query string (coincide con el cliente del Builder).
  const path = (req.originalUrl || req.url || "").split("?")[0];
  if (!sig || !ts) {
    throw unauthorized("Missing service signature");
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    throw unauthorized("Invalid timestamp");
  }
  const age = Math.abs(Date.now() - tsNum);
  if (age > 2 * 60 * 1000) {
    throw unauthorized("Stale service signature");
  }
  const expected = sign(`${method}|${path}|${ts}`);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw unauthorized("Invalid service signature");
  }
  return next();
}

// Verifica que el usuario (token de contexto) esté autorizado para acceder
// a una cuenta concreta de correo. No confía en el ID enviado desde el frontend.
export async function authorizeAccountAccess(
  ctx: UserContext,
  accountId: string,
  op: "read" | "write" | "sync" | "send" | "admin",
): Promise<void> {
  // Superadmin: acceso administrativo global pero NO a contenido de buzones
  // salvo asignación explícita (email_account_access).
  if (op !== "admin") {
    const sb = builderClient();
    const { data, error } = await sb
      .from("email_account_access")
      .select("user_id, account_id")
      .eq("user_id", ctx.userId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (error || !data) {
      log.warn({ ctx, accountId, op }, "acceso a cuenta no autorizado");
      throw forbidden(`No autorizado para la cuenta ${accountId}`);
    }
  }
  // Validar que la cuenta pertenece a un dominio autorizado
  const meta = await fetchAccountMeta(accountId);
  if (config.allowedMailDomains.length > 0 && !config.allowedMailDomains.includes(meta.domain_dns)) {
    throw forbidden(`Dominio no autorizado: ${meta.domain_dns}`);
  }
}

function unauthorized(msg: string) {
  const e: any = new Error(msg);
  e.statusCode = 401;
  return e;
}
function forbidden(msg: string) {
  const e: any = new Error(msg);
  e.statusCode = 403;
  return e;
}
export { forbidden, unauthorized };