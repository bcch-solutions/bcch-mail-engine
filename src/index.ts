// ============================================================
// BCCH MAIL ENGINE — Punto de entrada
// ============================================================
import { config } from "./config.js";
import { log } from "./logger.js";
import { app } from "./api.js";
import { ensureSchema } from "./db.js";
import { startWorkers, stopWorkers } from "./workers.js";

async function main(): Promise<void> {
  log.info({ env: config.env, port: config.port }, "iniciando BCCH MAIL ENGINE");

  // Validar configuración crítica
  if (config.env === "production" && config.serviceHmacSecret.startsWith("dev-only")) {
    throw new Error("SERVICE_HMAC_SECRET no configurada en producción");
  }
  if (!config.credentialEncKey || config.credentialEncKey.startsWith("replace")) {
    log.warn("CREDENTIAL_ENC_KEY no configurada — el cifrado de credenciales fallará hasta configurarla");
  }

  // Inicializar esquema de DB
  try {
    await ensureSchema();
  } catch (err: any) {
    log.error({ err: err.message }, "no se pudo inicializar el esquema de base de datos");
  }

  // Iniciar workers persistentes
  startWorkers();

  const server = app.listen(config.port, () => {
    log.info({ port: config.port }, "BCCH MAIL ENGINE escuchando");
  });

  const shutdown = async (sig: string) => {
    log.info({ sig }, "cerrando");
    stopWorkers();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    log.error({ reason: String(reason) }, "unhandledRejection");
  });
}

main().catch((err) => {
  log.error({ err: err.message }, "fallo crítico al iniciar");
  process.exit(1);
});

export { app };