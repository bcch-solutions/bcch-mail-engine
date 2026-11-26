// ============================================================
// BCCH MAIL ENGINE — Motor SMTP (Nodemailer)
// Puerto 465 TLS, 587 STARTTLS, colas, idempotencia, reintentos,
// distingue: queued/processing/smtp_accepted/rejected/uncertain/delivered.
// ============================================================
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { config } from "./config.js";
import { log } from "./logger.js";
import { query, withTx } from "./db.js";
import { fetchAccountMeta } from "./builder-client.js";
import { resolveAndValidate } from "./network.js";
import { decryptCredential } from "./crypto.js";
import { enqueue, QUEUES } from "./queue.js";

export interface OutgoingMessage {
  account_id: string;
  user_id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  idempotencyKey?: string;
  scheduledSendAt?: string;
}

export type OutgoingStatus = "queued" | "processing" | "smtp_accepted" | "rejected" | "uncertain" | "delivered";

function hashStr(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function enqueueOutgoing(msg: OutgoingMessage): Promise<{ id: string; status: OutgoingStatus }> {
  if (!msg.idempotencyKey) {
    msg.idempotencyKey = hashStr(JSON.stringify({ a: msg.account_id, f: msg.from, t: msg.to, s: msg.subject, body: msg.text || msg.html }));
  }
  return await withTx(async (tx) => {
    const existing = await tx.query("SELECT id, status FROM engine_outgoing WHERE message_id_hash=$1", [msg.idempotencyKey]);
    if (existing.rows[0]) {
      return { id: existing.rows[0].id, status: existing.rows[0].status as OutgoingStatus };
    }
    if (msg.scheduledSendAt) {
      const ins = await tx.query(
        "INSERT INTO engine_scheduled (account_id, user_id, send_at, status, payload) VALUES ($1,$2,$3,'scheduled',$4) RETURNING id",
        [msg.account_id, msg.user_id, msg.scheduledSendAt, JSON.stringify(msg)],
      );
      return { id: ins.rows[0].id, status: "queued" as OutgoingStatus };
    }
    const ins = await tx.query(
      "INSERT INTO engine_outgoing (account_id, user_id, status, payload, message_id_hash) VALUES ($1,$2,'queued',$3,$4) RETURNING id",
      [msg.account_id, msg.user_id, JSON.stringify(msg), msg.idempotencyKey],
    );
    const id = ins.rows[0].id;
    return { id, status: "queued" as OutgoingStatus };
  });
}

export async function processOutgoing(): Promise<void> {
  const { rows } = await query(
    `UPDATE engine_outgoing SET status='processing', updated_at=now()
     WHERE id IN (SELECT id FROM engine_outgoing WHERE status='queued' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, account_id, payload, attempt`,
    [1],
  );
  if (!rows.length) return;
  const item = rows[0];
  const msg: OutgoingMessage = JSON.parse(item.payload);
  try {
    const result = await sendNow(msg);
    await query(
      "UPDATE engine_outgoing SET status=$1, smtp_message_id=$2, updated_at=now() WHERE id=$3",
      [result.status, result.messageId, item.id],
    );
  } catch (err: any) {
    await handleSendError(item.id, msg, item.attempt, err);
  }
}

export async function sendNow(msg: OutgoingMessage): Promise<{ status: OutgoingStatus; messageId?: string }> {
  const meta = await fetchAccountMeta(msg.account_id);
  await resolveAndValidate(meta.smtp_server, meta.smtp_port);
  const { rows } = await query("SELECT credential_blob FROM engine_accounts WHERE builder_account_id=$1", [msg.account_id]);
  if (!rows[0]?.credential_blob) throw new Error("Credencial SMTP no encontrada");
  const pass = decryptCredential({
    iv: rows[0].credential_blob.iv,
    tag: rows[0].credential_blob.tag,
    ciphertext: rows[0].credential_blob.ciphertext,
  });
  const transport = nodemailer.createTransport({
    host: meta.smtp_server,
    port: meta.smtp_port,
    secure: meta.smtp_port === 465,
    requireTLS: meta.smtp_port === 587,
    auth: { user: meta.smtp_username || msg.from, pass },
    tls: { rejectUnauthorized: true, servername: meta.smtp_server },
    pool: true,
    maxConnections: config.smtpMaxConcurrency,
    rateLimit: config.smtpRateLimitPerMin / 60,
  });
  const info = await transport.sendMail({
    from: msg.from,
    to: msg.to.join(", "),
    cc: msg.cc?.join(", "),
    bcc: msg.bcc?.join(", "),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    replyTo: msg.replyTo,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    attachments: msg.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
  // SMTP aceptó el mensaje. Distingue aceptación de entrega.
  await transport.close();
  return {
    status: "smtp_accepted",
    messageId: info.messageId,
  };
}

async function handleSendError(id: string, msg: OutgoingMessage, attempt: number, err: any): Promise<void> {
  const m = String(err?.message || err).toLowerCase();
  const isUncertain = m.includes("timeout") || m.includes("econnreset") || m.includes("disconnected") || m.includes("greeting never received");
  if (attempt < config.smtpMaxRetries) {
    const delay = config.smtpRetryBackoffMs * Math.pow(2, attempt);
    await query(
      "UPDATE engine_outgoing SET status='queued', error=$1, attempt=$2, updated_at=now() WHERE id=$3",
      [String(err?.message || err).slice(0, 500), attempt + 1, id],
    );
    log.warn({ id, attempt, delay }, "reintento SMTP programado");
  } else {
    await query(
      "UPDATE engine_outgoing SET status=$1, error=$2, updated_at=now() WHERE id=$3",
      [isUncertain ? "uncertain" : "rejected", String(err?.message || err).slice(0, 500), id],
    );
    log.error({ id, err: err.message }, "envío SMTP rechazado");
  }
}

export async function processScheduled(): Promise<void> {
  const { rows } = await query(
    `UPDATE engine_scheduled SET status='processing'
     WHERE id IN (SELECT id FROM engine_scheduled WHERE status='scheduled' AND send_at <= now() LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, account_id, user_id, payload`,
  );
  if (!rows.length) return;
  const item = rows[0];
  const msg: OutgoingMessage = JSON.parse(item.payload);
  try {
    const result = await sendNow(msg);
    await query(
      "INSERT INTO engine_outgoing (account_id, user_id, status, payload, smtp_message_id, message_id_hash) VALUES ($1,$2,$3,$4,$5,$6)",
      [msg.account_id, msg.user_id, result.status, JSON.stringify(msg), result.messageId, hashStr(JSON.stringify(msg))],
    );
    await query("UPDATE engine_scheduled SET status='sent' WHERE id=$1", [item.id]);
  } catch (err: any) {
    await query("UPDATE engine_scheduled SET status='failed' WHERE id=$1", [item.id]);
    log.error({ id: item.id, err: err.message }, "envío programado fallido");
  }
}

export async function testSmtpConnection(accountId: string): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  try {
    const meta = await fetchAccountMeta(accountId);
    await resolveAndValidate(meta.smtp_server, meta.smtp_port);
    const { rows } = await query("SELECT credential_blob FROM engine_accounts WHERE builder_account_id=$1", [accountId]);
    if (!rows[0]?.credential_blob) throw new Error("Credencial SMTP no encontrada");
    const pass = decryptCredential({
      iv: rows[0].credential_blob.iv,
      tag: rows[0].credential_blob.tag,
      ciphertext: rows[0].credential_blob.ciphertext,
    });
    const start = Date.now();
    const transport = nodemailer.createTransport({
      host: meta.smtp_server,
      port: meta.smtp_port,
      secure: meta.smtp_port === 465,
      requireTLS: meta.smtp_port === 587,
      auth: { user: meta.smtp_username || accountId, pass },
      tls: { rejectUnauthorized: true },
    });
    await transport.verify();
    const latency = Date.now() - start;
    await transport.close();
    return { ok: true, latencyMs: latency };
  } catch (err: any) {
    return { ok: false, error: mapSmtpError(err) };
  }
}

function mapSmtpError(err: any): string {
  const m = String(err?.message || err).toLowerCase();
  if (m.includes("auth") || m.includes("535") || m.includes("invalid login")) return "Credenciales SMTP incorrectas.";
  if (m.includes("econnrefused") || m.includes("econnreset")) return "Servidor SMTP inaccesible o puerto bloqueado.";
  if (m.includes("cert") || m.includes("tls")) return "Certificado inválido o TLS no compatible.";
  if (m.includes("timeout")) return "Tiempo de espera agotado.";
  return `Error SMTP: ${err?.message || "desconocido"}`;
}