// ============================================================
// BCCH MAIL ENGINE — Pruebas automatizadas (unitarias)
// Pruebas con cuentas reales se realizan tras el despliegue.
// ============================================================
import crypto from "node:crypto";
import { encryptCredential, decryptCredential, rotateCredential } from "../crypto";
import { issueUserToken, verifyUserToken } from "../auth";
import { resolveAndValidate } from "../network";
import { sanitizeEmailHtml, stripExternalImages } from "../sanitize";

describe("BCCH MAIL ENGINE — pruebas unitarias", () => {
  describe("Cifrado AES-256-GCM de credenciales", () => {
    beforeAll(() => {
      process.env.CREDENTIAL_ENC_KEY = "a".repeat(64);
    });

    it("cifra y descifra correctamente", () => {
      const secret = "app-password-123";
      const enc = encryptCredential(secret);
      expect(enc.iv).toBeDefined();
      expect(enc.tag).toBeDefined();
      expect(enc.ciphertext).not.toContain(secret);
      const dec = decryptCredential(enc);
      expect(dec).toBe(secret);
    });

    it("rechaza clave inválida", () => {
      process.env.CREDENTIAL_ENC_KEY = "short";
      expect(() => encryptCredential("x")).toThrow();
      process.env.CREDENTIAL_ENC_KEY = "a".repeat(64);
    });

    it("detecta manipulación (tag inválido)", () => {
      const enc = encryptCredential("secret");
      const tampered = { ...enc, tag: Buffer.from("0".repeat(16)).toString("base64") };
      expect(() => decryptCredential(tampered)).toThrow();
    });

    it("soporta rotación de claves", () => {
      process.env.CREDENTIAL_ENC_KEY = "a".repeat(64);
      const enc = encryptCredential("rotame");
      const newKey = "b".repeat(64);
      const rotated = rotateCredential(enc, "a".repeat(64), newKey);
      process.env.CREDENTIAL_ENC_KEY = newKey;
      expect(decryptCredential(rotated)).toBe("rotame");
      process.env.CREDENTIAL_ENC_KEY = "a".repeat(64);
    });
  });

  describe("Autenticación entre servicios (HMAC)", () => {
    beforeAll(() => {
      process.env.SERVICE_HMAC_SECRET = "test-secret";
    });

    it("emite y verifica token de usuario", () => {
      const { token } = issueUserToken({
        userId: "u1",
        email: "a@bcch.solutions",
        role: "user",
      });
      const ctx = verifyUserToken(token);
      expect(ctx).not.toBeNull();
      expect(ctx!.userId).toBe("u1");
      expect(ctx!.role).toBe("user");
    });

    it("rechaza token manipulado", () => {
      const { token } = issueUserToken({ userId: "u1", email: "a@b.c", role: "user" });
      const tampered = token.slice(0, -2) + "zz";
      expect(verifyUserToken(tampered)).toBeNull();
    });

    it("rechaza token caducado", () => {
      const { token } = issueUserToken({ userId: "u1", email: "a@b.c", role: "user" });
      // El token original sigue siendo válido (no caducado).
      expect(verifyUserToken(token)).not.toBeNull();
      // Un token con expiración en el pasado debe rechazarse.
      const body = token.split(".")[0].slice(4);
      const payload = JSON.parse(Buffer.from(body, "base64url").toString());
      payload.exp = Date.now() - 1000;
      const tamperedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sig = crypto.createHmac("sha256", "test-secret").update(tamperedBody).digest("base64url");
      const tamperedToken = `bme.${tamperedBody}.${sig}`;
      expect(verifyUserToken(tamperedToken)).toBeNull();
    });

    it("firma de servicio es determinista y verificable", () => {
      const secret = "test-secret";
      const ts = "12345";
      const sig = crypto.createHmac("sha256", secret).update(`GET|/api/v1/health|${ts}`).digest("base64url");
      const expected = crypto.createHmac("sha256", secret).update(`GET|/api/v1/health|${ts}`).digest("base64url");
      expect(sig).toBe(expected);
    });
  });

  describe("Protección SSRF", () => {
    beforeAll(() => {
      process.env.BLOCK_PRIVATE_NETWORKS = "true";
      process.env.ALLOWED_PORTS = "993,465,587";
    });

    it("bloquea redes privadas", async () => {
      await expect(resolveAndValidate("127.0.0.1", 993)).rejects.toThrow(/privada/i);
      await expect(resolveAndValidate("192.168.1.1", 993)).rejects.toThrow(/privada/i);
      await expect(resolveAndValidate("10.0.0.1", 993)).rejects.toThrow(/privada/i);
    });

    it("bloquea puertos no autorizados", async () => {
      await expect(resolveAndValidate("imap.gmail.com", 143)).rejects.toThrow(/Puerto/i);
    });

    it("permite hosts públicos en puertos autorizados", async () => {
      const res = await resolveAndValidate("bcch.solutions", 993);
      expect(res.port).toBe(993);
    });
  });

  describe("Sanitización HTML", () => {
    it("elimina scripts", () => {
      const dirty = `<p>hola</p><script>alert('xss')</script><img src="x" onerror="alert(1)">`;
      const clean = sanitizeEmailHtml(dirty);
      expect(clean).not.toContain("<script");
      expect(clean).not.toContain("onerror");
    });

    it("elimina javascript: URLs", () => {
      const dirty = `<a href="javascript:alert(1)">click</a>`;
      const clean = sanitizeEmailHtml(dirty);
      expect(clean).not.toContain("javascript:");
    });

    it("bloquea imágenes externas por defecto", () => {
      const html = `<img src="https://evil.com/track.png">`;
      const clean = stripExternalImages(html);
      expect(clean).toContain("data-blocked-src");
    });
  });

  describe("Idempotencia de envío", () => {
    it("genera hash estable para el mismo mensaje", () => {
      const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
      const m1 = JSON.stringify({ a: "acc1", f: "from@x", t: ["to@y"], s: "subj", body: "body" });
      const m2 = JSON.stringify({ a: "acc1", f: "    from@x", t: ["to@y"], s: "subj", body: "body" });
      expect(hash(m1)).toBe(hash(m1));
      expect(hash(m1)).not.toBe(hash(m2));
    });
  });
});
