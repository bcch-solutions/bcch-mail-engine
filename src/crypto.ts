// ============================================================
// BCCH MAIL ENGINE — Cifrado de credenciales (AES-256-GCM)
// La clave vive en env (CREDENTIAL_ENC_KEY), separada de la DB.
// ============================================================
import crypto from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const raw = config.credentialEncKey;
  if (!raw || raw.length === 0 || raw.startsWith("replace")) {
    throw new Error("CREDENTIAL_ENC_KEY no configurada. Configure el cifrado de credenciales.");
  }
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 64) {
    throw new Error("CREDENTIAL_ENC_KEY inválida (se esperan 32 bytes hex).");
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedCredential {
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
}

export function encryptCredential(plaintext: string): EncryptedCredential {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
}

export function decryptCredential(enc: EncryptedCredential): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

// Rotación de claves: descifra con oldKey, recifra con nueva clave.
export function rotateCredential(
  enc: EncryptedCredential,
  oldKeyHex: string,
  newKeyHex: string,
): EncryptedCredential {
  const oldKey = Buffer.from(oldKeyHex.replace(/[^0-9a-fA-F]/g, ""), "hex");
  const decipher = crypto.createDecipheriv(ALGO, oldKey, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "base64")), decipher.final()]).toString("utf8");
  const newKey = Buffer.from(newKeyHex.replace(/[^0-9a-fA-F]/g, ""), "hex");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, newKey, iv);
  const enc2 = Buffer.concat([cipher.update(dec, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: enc2.toString("base64") };
}

export { IV_LEN, TAG_LEN };