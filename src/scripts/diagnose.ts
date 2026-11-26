// ============================================================
// BCCH MAIL ENGINE — Script de diagnóstico
// Uso: npm run diag
// ============================================================
import { config } from "../config.js";
import { query, pool } from "../db.js";
import { getWorkerStats } from "../workers.js";
import { queueStats } from "../queue.js";

async function main(): Promise<void> {
  console.log("=== BCCH MAIL ENGINE — DIAGNÓSTICO ===\n");
  console.log(`Entorno: ${config.env}`);
  console.log(`Puerto: ${config.port}`);
  console.log(`URL pública: ${config.publicUrl}`);
  console.log(`Modo de sincronización: ${config.syncMode}`);
  console.log(`Proveedor de colas: ${config.queueProvider}\n`);

  // 1. PostgreSQL
  try {
    const { rows } = await query("SELECT version() AS v");
    console.log(`[OK] PostgreSQL: ${rows[0].v.split(",")[0]}`);
    const { rows: tables } = await query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    console.log(`[OK] Tablas: ${tables.map((t: any) => t.tablename).join(", ")}`);
  } catch (err: any) {
    console.log(`[FAIL] PostgreSQL: ${err.message}`);
  }

  // 2. Colas
  try {
    const stats = await queueStats();
    if (stats.provider === "postgres") {
      for (const q of stats.queues) {
        console.log(`[OK] Cola ${q.queue}: ${q.pending} pendientes, ${q.processing} en proceso, ${q.delayed} retrasadas, ${q.failed} fallidas`);
      }
      if (stats.queues.length === 0) console.log("[OK] Colas PostgreSQL: vacías (sin trabajos)");
    } else {
      console.log("[OK] Colas: Redis (QUEUE_PROVIDER=redis)");
    }
  } catch (err: any) {
    console.log(`[FAIL] Colas: ${err.message}`);
  }

  // 3. Cuentas
  try {
    const { rows } = await query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE connection_state='connected')::int AS connected FROM engine_accounts",
    );
    console.log(`[OK] Cuentas: ${rows[0].total} total, ${rows[0].connected} conectadas`);
  } catch (err: any) {
    console.log(`[WARN] Cuentas: ${err.message}`);
  }

  // 4. Workers
  const stats = getWorkerStats();
  if (config.syncMode === "periodic") {
    console.log("[OK] Sincronización: modo periódico (cron / API / apertura de buzón)");
  } else {
    console.log(`[OK] Workers: ${stats.active ? "activos" : "inactivos"}`);
  }

  // 5. Configuración crítica
  if (config.serviceHmacSecret.startsWith("dev-only")) {
    console.log("[WARN] SERVICE_HMAC_SECRET no configurada (modo dev)");
  } else {
    console.log("[OK] SERVICE_HMAC_SECRET configurada");
  }
  if (!config.credentialEncKey || config.credentialEncKey.startsWith("replace")) {
    console.log("[FAIL] CREDENTIAL_ENC_KEY no configurada");
  } else {
    console.log("[OK] CREDENTIAL_ENC_KEY configurada");
  }
  if (config.allowedMailDomains.length === 0) {
    console.log("[WARN] ALLOWED_MAIL_DOMAINS vacío — se permiten todos los dominios");
  } else {
    console.log(`[OK] Dominios autorizados: ${config.allowedMailDomains.join(", ")}`);
  }

  console.log("\n=== FIN DEL DIAGNÓSTICO ===");
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Diagnóstico falló:", err);
  process.exit(1);
});
