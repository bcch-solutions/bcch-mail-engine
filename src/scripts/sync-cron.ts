// ============================================================
// BCCH MAIL ENGINE — Sincronización periódica (modalidad B, SiteGround)
// Conexiones IMAP de corta duración: sincroniza, procesa colas y sale.
// Ejecutar desde cron de SiteGround o manualmente:
//   node dist/scripts/sync-cron.js
// ============================================================
import { config } from "../config.js";
import { log } from "../logger.js";
import { pool, query } from "../db.js";
import { syncAccount } from "../imap.js";
import { processOutgoing, processScheduled } from "../smtp.js";

async function main(): Promise<void> {
  log.info({ mode: config.syncMode }, "sync-cron: iniciando ciclo");
  const { rows } = await query("SELECT builder_account_id FROM engine_accounts WHERE connection_state='connected'");
  let synced = 0;
  let errors = 0;
  for (const r of rows) {
    try {
      const res = await syncAccount(r.builder_account_id, { incremental: true });
      synced++;
      log.info({ accountId: r.builder_account_id, ...res }, "sync-cron: cuenta sincronizada");
    } catch (err: any) {
      errors++;
      log.error({ accountId: r.builder_account_id, err: err.message }, "sync-cron: error");
    }
  }
  await processOutgoing().catch((e) => log.error({ err: e.message }, "sync-cron: outgoing"));
  await processScheduled().catch((e) => log.error({ err: e.message }, "sync-cron: scheduled"));
  log.info({ synced, errors }, "sync-cron: ciclo completado");
  await pool.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  log.error({ err: err.message }, "sync-cron: fallo crítico");
  process.exit(1);
});
