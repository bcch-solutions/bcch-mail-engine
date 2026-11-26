// ============================================================
// BCCH MAIL ENGINE — Gestor de credenciales cifradas
// El motor recibe credenciales desde la app principal y las cifra (AES-256-GCM).
// La clave de cifrado vive en env, separada de la DB.
// ============================================================
import { encryptCredential, decryptCredential, rotateCredential } from "./crypto.js";
import { query } from "./db.js";
import { log } from "./logger.js";

export async function storeCredential(accountId: string, secretValue: string): Promise<void> {
  if (!secretValue) throw new Error("El valor del secreto no puede estar vacío");
  const enc = encryptCredential(secretValue);
  const blob = { iv: enc.iv, tag: enc.tag, ciphertext: enc.ciphertext };
  const existing = await query("SELECT id FROM engine_accounts WHERE builder_account_id=$1", [accountId]);
  if (existing.rows[0]) {
    await query(
      "UPDATE engine_accounts SET credential_blob=$1, updated_at=now() WHERE builder_account_id=$2",
      [JSON.stringify(blob), accountId],
    );
  } else {
    await query(
      "INSERT INTO engine_accounts (builder_account_id, email_address, domain_dns, imap_server, imap_port, imap_security, smtp_server, smtp_port, smtp_security, auth_method, credential_blob) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [accountId, "", "", "", 0, "", 0, "", "", JSON.stringify(blob)],
    );
  }
  log.info({ accountId }, "credencial cifrada almacenada");
}

export async function getCredential(accountId: string): Promise<string | null> {
  const { rows } = await query("SELECT credential_blob FROM engine_accounts WHERE builder_account_id=$1", [accountId]);
  const blob = rows[0]?.credential_blob;
  if (!blob) return null;
  try {
    return decryptCredential({ iv: blob.iv, tag: blob.tag, ciphertext: blob.ciphertext });
  } catch (err: any) {
    log.error({ accountId, err: err.message }, "fallo al descifrar credencial");
    return null;
  }
}

export async function rotateAllCredentials(oldKeyHex: string, newKeyHex: string): Promise<{ rotated: number }> {
  const { rows } = await query(
    "SELECT builder_account_id, credential_blob FROM engine_accounts WHERE credential_blob IS NOT NULL",
  );
  let rotated = 0;
  for (const r of rows) {
    try {
      const newBlob = rotateCredential(r.credential_blob, oldKeyHex, newKeyHex);
      await query("UPDATE engine_accounts SET credential_blob=$1 WHERE builder_account_id=$2", [
        JSON.stringify(newBlob),
        r.builder_account_id,
      ]);
      rotated++;
    } catch (e: any) {
      log.error({ accountId: r.builder_account_id, err: e.message }, "rotación fallida");
    }
  }
  return { rotated };
}