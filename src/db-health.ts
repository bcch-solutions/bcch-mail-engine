// ============================================================
// BCCH MAIL ENGINE — Diagnóstico segmentado de PostgreSQL
// Cada prueba se ejecuta de forma AISLADA con su propio timeout,
// para que una prueba fallida (DNS, TCP, auth, tabla inexistente)
// no bloquee el resto del diagnóstico ni la respuesta HTTP.
// ============================================================
import { pool } from "./db.js";
import { config } from "./config.js";
import net from "node:net";
import dns from "node:dns/promises";
import { URL } from "node:url";

export interface DbStepResult {
  name: string;
  status: "ok" | "fail" | "timeout";
  ms: number;
  code?: string;
  detail: string;
}

export interface DbHealth {
  ok: boolean;
  steps: DbStepResult[];
  error?: string;
}

const STEP_TIMEOUT_MS = 7000;

// Oculta la contraseña de una connection string para mostrarla de forma segura.
export function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.password) url.password = "••••••••";
    return url.toString();
  } catch {
    return "(cadena inválida)";
  }
}

// Ejecuta una promesa con deadline; resuelve ok o {error, timedOut}.
function timed<T>(
  p: Promise<T>,
  ms = STEP_TIMEOUT_MS,
): Promise<{ ok: true; value: T } | { ok: false; error: string; timedOut: boolean }> {
  let t: any;
  return Promise.race([
    p.then((v) => ({ ok: true as const, value: v })),
    new Promise<{ ok: false; error: string; timedOut: boolean }>((resolve) => {
      t = setTimeout(() => resolve({ ok: false, error: "Tiempo de espera agotado", timedOut: true }), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// Envuelve una prueba: captura errores, aplica timeout y normaliza el resultado.
async function dbStep(name: string, fn: () => Promise<string>): Promise<DbStepResult> {
  const start = Date.now();
  try {
    const r = await timed(fn());
    if (r.ok) {
      return { name, status: "ok", ms: Date.now() - start, detail: r.value };
    }
    return { name, status: r.timedOut ? "timeout" : "fail", ms: Date.now() - start, detail: r.error };
  } catch (err: any) {
    return {
      name,
      status: "fail",
      ms: Date.now() - start,
      code: err?.code,
      detail: err?.message || String(err),
    };
  }
}

// --- Pruebas individuales ---

async function testDns(): Promise<string> {
  if (!config.databaseUrl) throw new Error("DATABASE_URL no configurada");
  const u = new URL(config.databaseUrl);
  const rec = await dns.lookup(u.hostname, { all: true, family: 0 });
  if (!rec.length) throw new Error(`No se resolvió el host ${u.hostname}`);
  const ips = rec.map((r) => r.address);
  const families = rec.map((r) => (r.family === 6 ? "IPv6" : "IPv4"));
  return `${u.hostname} → ${ips.map((a, i) => `${a} (${families[i]})`).join(", ")}`;
}

async function testTcp(): Promise<string> {
  if (!config.databaseUrl) throw new Error("DATABASE_URL no configurada");
  const u = new URL(config.databaseUrl);
  const port = Number(u.port) || 5432;
  return await new Promise<string>((resolve, reject) => {
    const sock = net.createConnection({ host: u.hostname, port }, () => {
      sock.destroy();
      resolve(`TCP ${u.hostname}:${port} alcanzable`);
    });
    sock.setTimeout(STEP_TIMEOUT_MS);
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error(`TCP ${u.hostname}:${port} — tiempo de espera agotado`));
    });
    sock.on("error", (e) => reject(e));
  });
}

async function testSelectOne(): Promise<string> {
  const client = await pool.connect();
  try {
    const r = await client.query("SELECT 1 AS v");
    if (r.rows[0]?.v !== 1) throw new Error("SELECT 1 no devolvió el valor esperado");
    // Reportar si la validación TLS usó CA inyectado o trust store del sistema.
    const sslCa = config.dbSslCa || config.dbSslCaFile ? "CA inyectado (DB_SSL_CA)" : "trust store del sistema";
    return `Autenticación PostgreSQL + negociación TLS correctas (SELECT 1 OK · ${sslCa})`;
  } finally {
    client.release();
  }
}

async function testSchemaAccess(): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${config.dbSchema}, public`);
    const r = await client.query("SELECT current_schema() AS s");
    const schema = r.rows[0]?.s;
    if (schema !== config.dbSchema) {
      throw new Error(`search_path resuelto a '${schema}' — el rol no tiene acceso a '${config.dbSchema}'`);
    }
    return `Acceso al esquema '${schema}' confirmado`;
  } finally {
    client.release();
  }
}

async function testEnsureSchema(): Promise<string> {
  const r = await pool.query(`SELECT to_regclass($1) AS reg`, [`${config.dbSchema}.engine_accounts`]);
  if (!r.rows[0]?.reg) {
    throw new Error(
      `La tabla '${config.dbSchema}.engine_accounts' no existe. ensureSchema() no se ejecutó correctamente ` +
      `(revisa el log de arranque del motor) o el rol carece de CREATE sobre el esquema.`,
    );
  }
  return `Tabla engine_accounts existe (ensureSchema ejecutado correctamente)`;
}

async function testAccountsTable(): Promise<string> {
  const r = await pool.query(`SELECT count(*)::int AS c FROM ${config.dbSchema}.engine_accounts`);
  const connected = await pool.query(
    `SELECT count(*)::int AS c FROM ${config.dbSchema}.engine_accounts WHERE connection_state='connected'`,
  );
  return `${r.rows[0].c} cuentas registradas · ${connected.rows[0].c} conectadas`;
}

async function testQueueTable(): Promise<string> {
  const r = await pool.query(`SELECT count(*)::int AS c FROM ${config.dbSchema}.engine_queue`);
  const pending = await pool.query(
    `SELECT count(*)::int AS c FROM ${config.dbSchema}.engine_queue WHERE status='pending'`,
  );
  return `${r.rows[0].c} ítems totales · ${pending.rows[0].c} pendientes`;
}

async function testPoolState(): Promise<string> {
  const p = pool as any;
  return `total=${p.totalCount} idle=${p.idleCount} waiting=${p.waitingCount}`;
}

// --- Orquestador ---
export async function runDbHealth(): Promise<DbHealth> {
  const steps: DbStepResult[] = [];
  steps.push(await dbStep("Resolución DNS del Session Pooler", testDns));
  steps.push(await dbStep("Conectividad TCP al puerto 5432", testTcp));
  steps.push(await dbStep("Autenticación + TLS (SELECT 1)", testSelectOne));
  steps.push(await dbStep("Acceso al esquema mail_engine", testSchemaAccess));
  steps.push(await dbStep("ensureSchema ejecutado", testEnsureSchema));
  steps.push(await dbStep("Tabla engine_accounts", testAccountsTable));
  steps.push(await dbStep("Tabla engine_queue (colas)", testQueueTable));
  steps.push(await dbStep("Estado del pool de conexiones", testPoolState));
  const ok = steps.every((s) => s.status === "ok");
  return { ok, steps };
}