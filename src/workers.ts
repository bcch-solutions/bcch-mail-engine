// ============================================================
// BCCH MAIL ENGINE — Workers
//   SYNC_MODE=persistent → workers en intervalos + IMAP IDLE
//   SYNC_MODE=periodic   → no arranca workers; la sincronización se
//                          ejecuta vía cron (sync-cron.js), al abrir el
//                          buzón o por API (POST /accounts/:id/sync)
// ============================================================
import { config } from "./config.js";
import { log } from "./logger.js";
import { syncAccount, getActiveImapConnections } from "./imap.js";
import { processOutgoing, processScheduled } from "./smtp.js";
import { claimDelayed, pruneExpired, claim, completePg, failPg } from "./queue.js";
import { query } from "./db.js";

export interface WorkerStats {
  active: boolean;
  mode: "persistent" | "periodic";
  syncWorkers: number;
  smtpWorkers: number;
  idleCount: number;
  lastTick: number;
  pendingSync: number;
  pendingOutgoing: number;
  pendingScheduled: number;
}

const state: WorkerStats = {
  active: false,
  mode: config.syncMode,
  syncWorkers: 0,
  smtpWorkers: 0,
  idleCount: 0,
  lastTick: 0,
  pendingSync: 0,
  pendingOutgoing: 0,
  pendingScheduled: 0,
};

let syncInterval: any = null;
let smtpInterval: any = null;
let scheduledInterval: any = null;
let maintenanceInterval: any = null;
let reconnectInterval: any = null;

export function startWorkers(): void {
  if (state.active) return;
  if (config.syncMode === "periodic") {
    log.info("SYNC_MODE=periodic — workers persistentes deshabilitados; use cron (sync-cron.js) o la API");
    return;
  }
  state.active = true;
  log.info("workers iniciados (modo persistente)");

  syncInterval = setInterval(async () => {
    state.lastTick = Date.now();
    try {
      const { rows } = await query(
        "SELECT builder_account_id FROM engine_accounts WHERE connection_state='connected'",
      );
      state.pendingSync = rows.length;
      state.syncWorkers = Math.min(rows.length, config.syncMaxConcurrency);
      for (const r of rows) {
        syncAccount(r.builder_account_id, { incremental: true }).catch((e) =>
          log.error({ accountId: r.builder_account_id, err: e.message }, "sync worker"),
        );
      }
    } catch (e: any) {
      log.error({ err: e.message }, "sync tick");
    }
  }, 60_000);

  smtpInterval = setInterval(async () => {
    try {
      const { rows } = await query("SELECT count(*)::int AS c FROM engine_outgoing WHERE status='queued'");
      state.pendingOutgoing = rows[0]?.c || 0;
      state.smtpWorkers = Math.min(state.pendingOutgoing, config.smtpMaxConcurrency);
      for (let i = 0; i < config.smtpMaxConcurrency; i++) {
        processOutgoing().catch((e) => log.error({ err: e.message }, "smtp tick"));
      }
      const delayed = await claimDelayed("bme:queue:outgoing").catch(() => null);
      if (delayed) {
        // re-enqueue delayed items
      }
    } catch (e: any) {
      log.error({ err: e.message }, "smtp tick");
    }
  }, 5_000);

  scheduledInterval = setInterval(async () => {
    try {
      const { rows } = await query("SELECT count(*)::int AS c FROM engine_scheduled WHERE status='scheduled'");
      state.pendingScheduled = rows[0]?.c || 0;
      for (let i = 0; i < 3; i++) {
        processScheduled().catch((e) => log.error({ err: e.message }, "scheduled tick"));
      }
    } catch (e: any) {
      log.error({ err: e.message }, "scheduled tick");
    }
  }, 10_000);

  maintenanceInterval = setInterval(async () => {
    try {
      await pruneExpired();
    } catch {}
  }, 5 * 60_000);

  reconnectInterval = setInterval(async () => {
    try {
      state.idleCount = getActiveImapConnections();
      const { rows } = await query("SELECT builder_account_id FROM engine_accounts WHERE connection_state='connected'");
      for (const r of rows) {
        // ImapFlow gestiona reconexión; aquí se verifica estado
      }
    } catch {}
  }, config.idleReconnectMs);
}

export function stopWorkers(): void {
  state.active = false;
  if (syncInterval) clearInterval(syncInterval);
  if (smtpInterval) clearInterval(smtpInterval);
  if (scheduledInterval) clearInterval(scheduledInterval);
  if (maintenanceInterval) clearInterval(maintenanceInterval);
  if (reconnectInterval) clearInterval(reconnectInterval);
  log.info("workers detenidos");
}

export function getWorkerStats(): WorkerStats {
  return { ...state };
}

// Procesa un lote de la cola genérica (engine_queue) — usado por sync-cron
export async function drainQueueOnce(queue: string): Promise<number> {
  const items = await claim(queue, 5);
  let processed = 0;
  for (const item of items) {
    try {
      // payload { accountId, days } → sincronización incremental
      const payload = item.payload || {};
      if (payload.accountId) {
        await syncAccount(payload.accountId, { incremental: true, days: payload.days });
      }
      await completePg(item.id);
      processed++;
    } catch (err: any) {
      await failPg(item.id, err.message, config.smtpMaxRetries, config.smtpRetryBackoffMs);
    }
  }
  return processed;
}
