// ============================================================
// BCCH MAIL ENGINE — Motor IMAP (ImapFlow)
// TLS en 993, IDLE, reconexión, sincronización incremental,
// UID/UIDVALIDITY, prevención de duplicados, carpetas.
// ============================================================
import crypto from "node:crypto";
import { ImapFlow, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "./config.js";
import { log } from "./logger.js";
import { query, withTx } from "./db.js";
import { fetchAccountMeta } from "./builder-client.js";
import { resolveAndValidate } from "./network.js";
import { decryptCredential } from "./crypto.js";

const activeConnections = new Map<string, ImapFlow>();

export interface AccountImapConfig {
  accountId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

async function loadAccountConfig(accountId: string): Promise<AccountImapConfig & { meta: any }> {
  const meta = await fetchAccountMeta(accountId);
  const { rows } = await query(
    "SELECT credential_blob FROM engine_accounts WHERE builder_account_id = $1",
    [accountId],
  );
  const blob = rows[0]?.credential_blob;
  if (!blob) throw new Error(`Credencial cifrada no encontrada para la cuenta ${accountId}`);
  const pass = decryptCredential({
    iv: blob.iv,
    tag: blob.tag,
    ciphertext: blob.ciphertext,
  });
  await resolveAndValidate(meta.imap_server, meta.imap_port);
  return {
    accountId,
    host: meta.imap_server,
    port: meta.imap_port,
    secure: meta.imap_security === "ssl_tls",
    user: meta.imap_username || meta.email_address,
    pass,
    meta,
  };
}

export async function testImapConnection(accountId: string): Promise<{
  ok: boolean;
  error?: string;
  latencyMs?: number;
}> {
  let client: ImapFlow | null = null;
  try {
    const cfg = await loadAccountConfig(accountId);
    const start = Date.now();
    client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false as any,
      tls: { rejectUnauthorized: true, servername: cfg.host },
    });
    await client.connect();
    const latency = Date.now() - start;
    await client.logout();
    return { ok: true, latencyMs: latency };
  } catch (err: any) {
    return { ok: false, error: mapImapError(err) };
  } finally {
    if (client) {
      try {
        await client?.logout();
      } catch {}
    }
  }
}

export async function connectAccount(accountId: string): Promise<void> {
  if (activeConnections.has(accountId)) {
    log.info({ accountId }, "cuenta ya conectada");
    return;
  }
  const cfg = await loadAccountConfig(accountId);
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false as any,
    tls: { rejectUnauthorized: true, servername: cfg.host },
  });
  client.on("error", (err: any) => {
    log.error({ accountId, err: err.message }, "imap error");
    activeConnections.delete(accountId);
  });
  client.on("close", () => {
    log.info({ accountId }, "imap closed");
    activeConnections.delete(accountId);
  });
  await client.connect();
  activeConnections.set(accountId, client);
  await query(
    "UPDATE engine_accounts SET connection_state = 'connected', updated_at = now() WHERE builder_account_id = $1",
    [accountId],
  );
  log.info({ accountId }, "cuenta conectada IMAP");
  if (config.idleEnabled) {
    startIdleWatch(accountId, client).catch((e) => log.error({ accountId, err: e.message }, "idle watch error"));
  }
}

export async function disconnectAccount(accountId: string): Promise<void> {
  const c = activeConnections.get(accountId);
  if (c) {
    try {
      await c.logout();
    } catch {}
    activeConnections.delete(accountId);
  }
  await query(
    "UPDATE engine_accounts SET connection_state = 'disconnected', updated_at = now() WHERE builder_account_id = $1",
    [accountId],
  );
  log.info({ accountId }, "cuenta desconectada");
}

export async function getImapClient(accountId: string): Promise<ImapFlow> {
  const c = activeConnections.get(accountId);
  if (c && c.usable) return c;
  await connectAccount(accountId);
  return activeConnections.get(accountId)!;
}

async function startIdleWatch(accountId: string, client: ImapFlow): Promise<void> {
  // IDLE en INBOX con reconexión automática.
  const lock = await client.getMailboxLock("INBOX");
  try {
    client.on("exists", (info: any) => {
      log.info({ accountId, info }, "nuevos mensajes detectados (IDLE)");
      syncAccount(accountId, { incremental: true }).catch((e) =>
        log.error({ accountId, err: e.message }, "sync desde IDLE"),
      );
    });
    while (activeConnections.has(accountId) && config.idleEnabled) {
      await new Promise((r) => setTimeout(r, config.idleReconnectMs));
    }
  } finally {
    lock.release();
  }
}

export async function listFolders(accountId: string): Promise<any[]> {
  const client = await getImapClient(accountId);
  const lock = await client.getMailboxLock("INBOX");
  try {
    const list = await client.list();
    return list.map((f) => ({
      path: f.path,
      name: f.path,
      delimiter: f.delimiter,
      flags: f.flags,
      specialUse: f.specialUse,
    }));
  } finally {
    lock.release();
  }
}

export async function createFolder(accountId: string, path: string): Promise<void> {
  const client = await getImapClient(accountId);
  await client.mailboxOpen("INBOX");
  await client.mailboxCreate(path);
}

export async function renameFolder(accountId: string, oldPath: string, newPath: string): Promise<void> {
  const client = await getImapClient(accountId);
  await client.mailboxRename(oldPath, newPath);
}

export async function deleteFolder(accountId: string, path: string): Promise<void> {
  const client = await getImapClient(accountId);
  await client.mailboxDelete(path);
}

export interface SyncOptions {
  incremental?: boolean;
  days?: number;
}

export async function syncAccount(accountId: string, opts: SyncOptions = {}): Promise<{
  messagesSynced: number;
  folders: number;
}> {
  const cfg = await loadAccountConfig(accountId);
  const client = await getImapClient(accountId);
  const days = opts.days ?? (opts.incremental ? 1 : config.syncInitialDays);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  let messagesSynced = 0;
  let folders = 0;
  const lock = await client.getMailboxLock("INBOX");
  try {
    const foldersList = await client.list();
    folders = foldersList.length;
    for (const folder of foldersList) {
      await syncFolder(accountId, client, folder.path, since, cfg.meta);
      messagesSynced++;
    }
    await query(
      "UPDATE engine_accounts SET last_sync_at = now(), connection_state='connected', last_error=NULL WHERE builder_account_id=$1",
      [accountId],
    );
  } finally {
    lock.release();
  }
  return { messagesSynced, folders };
}

async function syncFolder(
  accountId: string,
  client: ImapFlow,
  folderPath: string,
  since: Date,
  meta: any,
): Promise<void> {
  let folderRow = (
    await query("SELECT id, uidvalidity, last_uid FROM engine_folders WHERE account_id=$1 AND path=$2", [
      (await getEngineAccountId(accountId)),
      folderPath,
    ])
  ).rows[0];

  await client.mailboxOpen(folderPath);
  const status = await client.status(folderPath, { uidValidity: true, messages: true, unseen: true });
  const uidvalidity = status.uidValidity;

  const searchObj: SearchObject = { since };
  const uids = await client.search(searchObj, { uid: true });
  if (!uids || !uids.length) return;

  let lastUid = folderRow?.last_uid || 0;
  const newUids = uids.filter((u) => u > lastUid);

  for (const uid of newUids.slice(0, 200)) {
    const msg = await client.fetchOne(uid, { source: true, internalDate: true, flags: true }, { uid: true });
    if (!msg || !msg.source) continue;
    const parsed = await simpleParser(msg.source as any);
    const messageId = parsed.messageId || `${uid}`;
    const hash = hashStr(messageId + accountId);
    const bodyText = parsed.text || "";
    const bodyHtml = parsed.html ? String(parsed.html) : "";
    const addrText = (a: any) => (a ? String(Array.isArray(a) ? a.map((x: any) => x.text).join(", ") : a.text) : "");
    const flagList = Array.isArray(msg.flags) ? msg.flags : Array.from((msg.flags as Set<string>) || []);
    const priority = String((parsed as any).priority || (parsed.headers as any)?.get?.("priority") || "");
    await withTx(async (tx) => {
      await tx.query(
        `INSERT INTO engine_messages (account_id, folder_id, uid, message_id_hash, from_address, to_addresses, cc_addresses, subject, preview, has_attachments, is_read, is_flagged, is_important, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (account_id, uid) DO NOTHING`,
        [
          await getEngineAccountId(accountId),
          folderRow?.id || null,
          uid,
          hash,
          addrText(parsed.from),
          addrText(parsed.to),
          addrText(parsed.cc),
          String(parsed.subject || ""),
          bodyText.slice(0, 250),
          (parsed.attachments || []).length > 0,
          flagList.includes("\\Seen"),
          flagList.includes("\\Flagged"),
          Boolean(priority && Number(priority) >= 2),
          parsed.date || msg.internalDate,
        ],
      );
    });
    lastUid = Math.max(lastUid, uid);
  }

  if (!folderRow) {
    const engineAccountId = await getEngineAccountId(accountId);
    const r = await query(
      `INSERT INTO engine_folders (account_id, path, name, uidvalidity, last_uid, unread_count) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [engineAccountId, folderPath, folderPath, uidvalidity, lastUid, status.unseen || 0],
    );
    folderRow = r.rows[0];
  } else {
    await query(
      "UPDATE engine_folders SET uidvalidity=$1, last_uid=$2, unread_count=$3, last_synced_at=now() WHERE id=$4",
      [uidvalidity, lastUid, status.unseen || 0, folderRow.id],
    );
  }
}

export async function listMessages(
  accountId: string,
  params: { folder?: string; page?: number; limit?: number; search?: string; unread?: boolean },
): Promise<{ items: any[]; total: number }> {
  const engineAccountId = await getEngineAccountId(accountId);
  const limit = Math.min(params.limit || 50, 200);
  const offset = (Math.max(1, params.page || 1) - 1) * limit;
  let where = "WHERE m.account_id = $1";
  const args: any[] = [engineAccountId];
  if (params.folder) {
    args.push(params.folder);
    where += ` AND f.path = $${args.length}`;
  }
  if (params.unread) {
    where += ` AND m.is_read = false`;
  }
  if (params.search) {
    args.push(`%${params.search}%`);
    where += ` AND (m.subject ILIKE $${args.length} OR m.from_address ILIKE $${args.length} OR m.preview ILIKE $${args.length})`;
  }
  const totalRes = await query(`SELECT count(*)::int AS c FROM engine_messages m LEFT JOIN engine_folders f ON f.id=m.folder_id ${where}`, args);
  const total = totalRes.rows[0]?.c || 0;
  args.push(limit, offset);
  const res = await query(
    `SELECT m.*, f.path AS folder_path FROM engine_messages m LEFT JOIN engine_folders f ON f.id=m.folder_id ${where} ORDER BY m.received_at DESC NULLS LAST LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );
  return { items: res.rows, total };
}

export async function getMessage(accountId: string, msgId: string): Promise<any | null> {
  const engineAccountId = await getEngineAccountId(accountId);
  const res = await query("SELECT * FROM engine_messages WHERE id=$1 AND account_id=$2", [msgId, engineAccountId]);
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  // Carga perezosa del cuerpo completo desde IMAP bajo demanda.
  try {
    const client = await getImapClient(accountId);
    const lock = await client.getMailboxLock("INBOX");
    try {
      const folder = await getFolderPath(accountId, row.folder_id);
      await client.mailboxOpen(folder);
      const msg = await client.fetchOne(row.uid, { source: true }, { uid: true });
      const source = (msg as any)?.source;
      if (source) {
        const parsed = await simpleParser(source as any);
        return {
          ...row,
          body_text: parsed.text || "",
          body_html: parsed.html ? String(parsed.html) : "",
          attachments: (parsed.attachments || []).map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          })),
        };
      }
    } finally {
      lock.release();
    }
  } catch (err: any) {
    log.error({ accountId, msgId, err: err.message }, "carga perezosa fallida");
  }
  return row;
}

export async function setFlags(accountId: string, msgId: string, flags: Partial<{ read: boolean; flagged: boolean; important: boolean }>): Promise<void> {
  const engineAccountId = await getEngineAccountId(accountId);
  await query(
    "UPDATE engine_messages SET is_read=$1, is_flagged=$2, is_important=$3 WHERE id=$4 AND account_id=$5",
    [flags.read ?? false, flags.flagged ?? false, flags.important ?? false, msgId, engineAccountId],
  );
  const row = (await query("SELECT uid, folder_id FROM engine_messages WHERE id=$1", [msgId])).rows[0];
  if (row) {
    try {
      const client = await getImapClient(accountId);
      const folder = await getFolderPath(accountId, row.folder_id);
      const lock = await client.getMailboxLock(folder);
      try {
        const flagsArr: string[] = [];
        if (flags.read) flagsArr.push("\\Seen");
        if (flags.flagged) flagsArr.push("\\Flagged");
        if (flags.important) flagsArr.push("$Important");
        await client.messageFlagsAdd(row.uid, flagsArr, { uid: true });
        if (flags.read === false) await client.messageFlagsRemove(row.uid, ["\\Seen"], { uid: true });
        if (flags.flagged === false) await client.messageFlagsRemove(row.uid, ["\\Flagged"], { uid: true });
      } finally {
        lock.release();
      }
    } catch (err: any) {
      log.warn({ accountId, msgId, err: err.message }, "sync de flags con IMAP falló");
    }
  }
}

export async function moveMessage(accountId: string, msgId: string, destFolder: string): Promise<void> {
  const engineAccountId = await getEngineAccountId(accountId);
  const row = (await query("SELECT uid, folder_id FROM engine_messages WHERE id=$1 AND account_id=$2", [msgId, engineAccountId])).rows[0];
  if (!row) throw new Error("mensaje no encontrado");
  const client = await getImapClient(accountId);
  const srcFolder = await getFolderPath(accountId, row.folder_id);
  await client.mailboxOpen(srcFolder);
  await (client as any).messageMove(row.uid, destFolder, { uid: true });
}

export async function deleteMessage(accountId: string, msgId: string): Promise<void> {
  const engineAccountId = await getEngineAccountId(accountId);
  const row = (await query("SELECT uid, folder_id FROM engine_messages WHERE id=$1 AND account_id=$2", [msgId, engineAccountId])).rows[0];
  if (!row) throw new Error("mensaje no encontrado");
  const client = await getImapClient(accountId);
  const folder = await getFolderPath(accountId, row.folder_id);
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageFlagsAdd(row.uid, ["\\Deleted"], { uid: true });
    await (client as any).messageDelete(row.uid, { uid: true });
  } finally {
    lock.release();
  }
}

async function getEngineAccountId(accountId: string): Promise<string> {
  const r = await query("SELECT id FROM engine_accounts WHERE builder_account_id=$1", [accountId]);
  if (!r.rows[0]) {
    const meta = await fetchAccountMeta(accountId);
    const ins = await query(
      `INSERT INTO engine_accounts (builder_account_id, email_address, domain_dns, imap_server, imap_port, imap_security, smtp_server, smtp_port, smtp_security, auth_method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [accountId, meta.email_address, meta.domain_dns, meta.imap_server, meta.imap_port, meta.imap_security, meta.smtp_server, meta.smtp_port, meta.smtp_security, meta.auth_method],
    );
    return ins.rows[0].id;
  }
  return r.rows[0].id;
}

async function getFolderPath(accountId: string, folderId: string | null): Promise<string> {
  if (!folderId) return "INBOX";
  const r = await query("SELECT path FROM engine_folders WHERE id=$1", [folderId]);
  return r.rows[0]?.path || "INBOX";
}

function hashStr(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function mapImapError(err: any): string {
  const m = String(err?.message || err).toLowerCase();
  if (m.includes("auth") || m.includes("invalid credentials") || m.includes("login failed")) return "Credenciales incorrectas.";
  if (m.includes("econnrefused") || m.includes("econnreset")) return "Servidor inaccesible o puerto bloqueado.";
  if (m.includes("cert") || m.includes("tls") || m.includes("authorization")) return "Certificado inválido o método de autenticación no compatible.";
  if (m.includes("timeout") || m.includes("timed out")) return "Tiempo de espera agotado.";
  return `Error IMAP: ${err?.message || "desconocido"}`;
}

export function getActiveImapConnections(): number {
  return activeConnections.size;
}

// Descarga bajo demanda de un adjunto concreto desde el servidor IMAP original.
// uid = UID del mensaje en su carpeta; idx = índice del adjunto dentro del mensaje.
export async function fetchAttachment(
  accountId: string,
  uid: number,
  idx: number,
): Promise<{ filename: string; contentType: string; size: number; content: Buffer } | null> {
  const client = await getImapClient(accountId);
  // Localizar la carpeta del mensaje por su UID
  const { rows } = await query("SELECT folder_id FROM engine_messages WHERE account_id=$1 AND uid=$2", [
    (await getEngineAccountId(accountId)),
    uid,
  ]);
  const folder = await getFolderPath(accountId, rows[0]?.folder_id || null);
  const lock = await client.getMailboxLock(folder);
  try {
    await client.mailboxOpen(folder);
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    const source = (msg as any)?.source;
    if (!source) return null;
    const parsed = await simpleParser(source as any);
    const attachments = parsed.attachments || [];
    const att = attachments[idx];
    if (!att) return null;
    return {
      filename: att.filename || `adjunto-${idx}`,
      contentType: att.contentType || "application/octet-stream",
      size: att.size || 0,
      content: Buffer.from(att.content || ""),
    };
  } finally {
    lock.release();
  }
}