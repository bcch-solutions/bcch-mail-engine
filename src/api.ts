// ============================================================
// BCCH MAIL ENGINE — Aplicación Express + API REST /api/v1
// ============================================================
import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import { config } from "./config.js";
import { log } from "./logger.js";
import { requireServiceAuth, verifyUserToken, authorizeAccountAccess, issueUserToken } from "./auth.js";
import {
  testImapConnection,
  connectAccount,
  disconnectAccount,
  syncAccount,
  listMessages,
  getMessage,
  setFlags,
  moveMessage,
  deleteMessage,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  getActiveImapConnections,
  fetchAttachment,
} from "./imap.js";
import { enqueueOutgoing, processOutgoing, testSmtpConnection, sendNow } from "./smtp.js";
import { getWorkerStats } from "./workers.js";
import { storeCredential } from "./credentials.js";
import { query } from "./db.js";
import { queueStats } from "./queue.js";
import { diagnoseHost } from "./diagnostics.js";
import { z } from "zod";

export const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());
app.use(express.json({ limit: "25mb" }));
app.use(
  cors({
    origin: config.corsAllowedOrigin === "*" ? true : config.corsAllowedOrigin,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Service-Signature", "X-Service-Timestamp", "X-User-Token"],
    credentials: false,
  }),
);

// Rate limiting global
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/api/v1/health",
});
app.use("/api/", limiter);

// Middleware de autenticación de servicio + contexto de usuario.
// IMPORTANTE: la firma HMAC se calcula sobre la ruta ABSOLUTA de la petición
// (incluye el prefijo /api/v1), que es la que el Builder usa al firmar.
// Express hace que req.path sea relativo al punto de montaje del router,
// por lo que usamos req.originalUrl (sin query string) para reconstruir la
// ruta absoluta y que la verificación coincida con el cliente.
async function serviceAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const sig = req.headers["x-service-signature"] as string;
    const ts = req.headers["x-service-timestamp"] as string;
    if (!sig || !ts) {
      return res.status(401).json({ error: "Falta firma de servicio" });
    }
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return res.status(401).json({ error: "Timestamp inválido" });
    }
    const age = Math.abs(Date.now() - tsNum);
    if (age > 2 * 60 * 1000) {
      return res.status(401).json({ error: "Firma caducada" });
    }
    // Ruta absoluta sin query string: req.originalUrl incluye /api/v1/...
    const path = (req.originalUrl || req.url || "").split("?")[0];
    const expected = crypto
      .createHmac("sha256", config.serviceHmacSecret)
      .update(`${req.method}|${path}|${ts}`)
      .digest("base64url");
    // timingSafeEqual requiere buffers de igual longitud.
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      log.warn({ method: req.method, path, msg: "firma de servicio inválida" }, "auth");
      return res.status(401).json({ error: "Firma inválida" });
    }
    next();
  } catch (err) {
    res.status(401).json({ error: "No autorizado" });
  }
}

function userContext(req: Request): any | null {
  const token = req.headers["x-user-token"] as string;
  if (!token) return null;
  return verifyUserToken(token);
}

function requireUser(req: Request, res: Response, next: NextFunction) {
  const ctx = userContext(req);
  if (!ctx) return res.status(401).json({ error: "Token de usuario requerido" });
  (req as any).userCtx = ctx;
  next();
}

const v1 = express.Router();
app.use("/api/v1", v1);

// ---- SISTEMA ----
v1.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

v1.get("/version", serviceAuth, (_req, res) => {
  res.json({ name: "BCCH MAIL ENGINE", version: "1.0.0", node: process.version });
});

v1.get("/status", serviceAuth, requireUser, async (_req, res) => {
  const stats = getWorkerStats();
  let dbOk = true;
  try {
    await query("SELECT 1");
  } catch {
    dbOk = false;
  }
  res.json({
    engine: { name: "BCCH MAIL ENGINE", version: "1.0.0", uptime: process.uptime() },
    workers: stats,
    imapConnections: getActiveImapConnections(),
    dbOk,
    lastHeartbeat: new Date().toISOString(),
  });
});

// ---- Emisión de token de usuario (solo servicio) ----
v1.post("/auth/issue-token", serviceAuth, async (req, res) => {
  const schema = z.object({
    userId: z.string(),
    email: z.string(),
    role: z.enum(["superadmin", "domain_admin", "user"]),
    domainId: z.string().optional(),
    companyId: z.string().optional(),
    accountId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "payload inválido" });
  const t = issueUserToken(parsed.data);
  res.json({ token: t.token, expiresAt: t.expiresAt });
});

// ---- CUENTAS ----
v1.post("/accounts", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  if (ctx.role !== "superadmin" && ctx.role !== "domain_admin") {
    return res.status(403).json({ error: "Permisos insuficientes" });
  }
  const schema = z.object({
    account_id: z.string(),
    credential_secret: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "payload inválido" });
  if (ctx.role === "domain_admin" && parsed.data.account_id) {
    try {
      await authorizeAccountAccess(ctx, parsed.data.account_id, "admin");
    } catch (e: any) {
      return res.status(403).json({ error: e.message });
    }
  }
  if (parsed.data.credential_secret) {
    await storeCredential(parsed.data.account_id, parsed.data.credential_secret);
  }
  res.json({ ok: true, account_id: parsed.data.account_id });
});

v1.post("/accounts/test", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const schema = z.object({ account_id: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "payload inválido" });
  try {
    await authorizeAccountAccess(ctx, parsed.data.account_id, "sync");
  } catch (e: any) {
    return res.status(403).json({ error: e.message });
  }
  const [imap, smtp] = await Promise.all([
    testImapConnection(parsed.data.account_id),
    testSmtpConnection(parsed.data.account_id),
  ]);
  res.json({ imap, smtp });
});

v1.post("/accounts/connect", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const schema = z.object({ account_id: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "payload inválido" });
  try {
    await authorizeAccountAccess(ctx, parsed.data.account_id, "sync");
    await connectAccount(parsed.data.account_id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.post("/accounts/disconnect", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const schema = z.object({ account_id: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "payload inválido" });
  try {
    await authorizeAccountAccess(ctx, parsed.data.account_id, "admin");
    await disconnectAccount(parsed.data.account_id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.get("/accounts/:id/status", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  try {
    await authorizeAccountAccess(ctx, req.params.id, "read");
  } catch (e: any) {
    return res.status(403).json({ error: e.message });
  }
  const { rows } = await query(
    "SELECT builder_account_id, email_address, connection_state, last_sync_at, last_error, updated_at FROM engine_accounts WHERE builder_account_id=$1",
    [req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "cuenta no registrada en el motor" });
  res.json(rows[0]);
});

// ---- SINCRONIZACIÓN ----
v1.post("/accounts/:id/sync", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const schema = z.object({ days: z.number().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "payload inválido" });
  try {
    await authorizeAccountAccess(ctx, req.params.id, "sync");
    const result = await syncAccount(req.params.id, { incremental: false, days: parsed.data.days });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.get("/accounts/:id/sync-status", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  try {
    await authorizeAccountAccess(ctx, req.params.id, "read");
  } catch (e: any) {
    return res.status(403).json({ error: e.message });
  }
  const { rows } = await query("SELECT last_sync_at, connection_state, last_error FROM engine_accounts WHERE builder_account_id=$1", [req.params.id]);
  res.json(rows[0] || { last_sync_at: null, connection_state: "disconnected", last_error: null });
});

// ---- MENSAJES ----
v1.get("/accounts/:id/messages", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  try {
    await authorizeAccountAccess(ctx, req.params.id, "read");
  } catch (e: any) {
    return res.status(403).json({ error: e.message });
  }
  const result = await listMessages(req.params.id, {
    folder: req.query.folder as string | undefined,
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 50,
    search: req.query.search as string | undefined,
    unread: req.query.unread === "true",
  });
  res.json(result);
});

v1.get("/messages/:id", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_messages WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "mensaje no encontrado" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "read");
  } catch (e: any) {
    return res.status(403).json({ error: e.message });
  }
  const msg = await getMessage(rows[0].account_id, req.params.id);
  res.json(msg);
});

v1.post("/messages/send", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const schema = z.object({
    account_id: z.string(),
    from: z.string().email(),
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().min(1).max(500),
    text: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(z.any()).optional(),
    scheduledSendAt: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "payload inválido", details: parsed.error.errors });
  try {
    await authorizeAccountAccess(ctx, parsed.data.account_id, "send");
    const result = await enqueueOutgoing({ ...parsed.data, user_id: ctx.userId });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.post("/messages/:id/reply", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_messages WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "mensaje no encontrado" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "send");
    const result = await enqueueOutgoing({ ...(req.body as any), account_id: rows[0].account_id, user_id: ctx.userId, inReplyTo: req.params.id });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.post("/messages/:id/forward", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_messages WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "mensaje no encontrado" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "send");
    const result = await enqueueOutgoing({ ...(req.body as any), account_id: rows[0].account_id, user_id: ctx.userId, references: req.params.id });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.patch("/messages/:id/flags", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_messages WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "mensaje no encontrado" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "write");
    await setFlags(rows[0].account_id, req.params.id, req.body);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.post("/messages/:id/move", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_messages WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "mensaje no encontrado" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "write");
    await moveMessage(rows[0].account_id, req.params.id, req.body.destFolder);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.delete("/messages/:id", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_messages WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "mensaje no encontrado" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "write");
    await deleteMessage(rows[0].account_id, req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ---- CARPETAS ----
v1.get("/accounts/:id/folders", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  try {
    await authorizeAccountAccess(ctx, req.params.id, "read");
  } catch (e: any) {
    return res.status(403).json({ error: e.message });
  }
  const folders = await listFolders(req.params.id);
  res.json({ items: folders });
});

v1.post("/accounts/:id/folders", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  try {
    await authorizeAccountAccess(ctx, req.params.id, "write");
    await createFolder(req.params.id, req.body.path);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.patch("/folders/:id", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_folders WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "carpeta no encontrada" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "write");
    await renameFolder(rows[0].account_id, req.params.id, req.body.newPath);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

v1.delete("/folders/:id", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const { rows } = await query("SELECT account_id FROM engine_folders WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "carpeta no encontrada" });
  try {
    await authorizeAccountAccess(ctx, rows[0].account_id, "write");
    await deleteFolder(rows[0].account_id, req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ---- ADJUNTOS ----
// Descarga bajo demanda desde el servidor IMAP original.
// El identificador es "<engineAccountId>:<messageUid>:<attachmentIndex>".
v1.get("/attachments/:id", serviceAuth, requireUser, async (req, res) => {
  const ctx = (req as any).userCtx;
  const parts = String(req.params.id).split(":");
  if (parts.length < 3) return res.status(400).json({ error: "Identificador de adjunto inválido" });
  const [engineAccountId, uidStr, idxStr] = parts;
  const uid = Number(uidStr);
  const idx = Number(idxStr);
  if (!Number.isFinite(uid) || !Number.isFinite(idx)) {
    return res.status(400).json({ error: "Identificador de adjunto inválido" });
  }
  // Resolver el builder_account_id para validar el acceso del usuario
  const { rows } = await query("SELECT builder_account_id FROM engine_accounts WHERE id=$1", [engineAccountId]);
  if (!rows[0]) return res.status(404).json({ error: "cuenta no registrada en el motor" });
  try {
    await authorizeAccountAccess(ctx, rows[0].builder_account_id, "read");
  } catch (e: any) {
    return res.status(403).json({ error: e.message });
  }
  try {
    const attachment = await fetchAttachment(rows[0].builder_account_id, uid, idx);
    if (!attachment) return res.status(404).json({ error: "adjunto no encontrado" });
    res.setHeader("Content-Type", attachment.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(attachment.filename || "adjunto")}"`);
    if (attachment.size) res.setHeader("Content-Length", String(attachment.size));
    res.send(attachment.content);
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ---- Diagnóstico ----
v1.get("/diagnostics", serviceAuth, requireUser, async (_req, res) => {
  const stats = getWorkerStats();
  const { rows: accounts } = await query("SELECT count(*)::int AS c, count(*) FILTER (WHERE connection_state='connected')::int AS connected FROM engine_accounts");
  const qStats = await queueStats().catch(() => null);
  res.json({
    engine: { version: "1.0.0", uptime: process.uptime() },
    workers: stats,
    imap: { active: getActiveImapConnections() },
    accounts: { total: accounts[0]?.c || 0, connected: accounts[0]?.connected || 0 },
    queues: qStats,
    syncMode: config.syncMode,
  });
});

// Diagnóstico de conectividad real: DNS → TCP → TLS por puerto autorizado.
// Solo hosts de dominios autorizados; sin conexiones simuladas.
v1.post("/diagnostics/connectivity", serviceAuth, requireUser, async (req, res) => {
  const schema = z.object({ host: z.string().min(3).max(255) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "payload inválido" });
  const host = parsed.data.host.toLowerCase();
  const domainAllowed = config.allowedMailDomains.length === 0 || config.allowedMailDomains.some((d) => host === d || host.endsWith(`.${d}`) || host.includes(d));
  if (!domainAllowed) {
    return res.status(403).json({ error: `Host fuera de los dominios autorizados (${config.allowedMailDomains.join(", ")})` });
  }
  try {
    const result = await diagnoseHost(host);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Manejo de errores
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err: err.message, stack: err.stack?.split("\n").slice(0, 3) }, "unhandled");
  res.status(err.statusCode || 500).json({ error: err.message || "Error interno" });
});

export default app;