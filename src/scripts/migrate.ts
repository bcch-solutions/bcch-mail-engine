// ============================================================
// BCCH MAIL ENGINE — Script de migración manual
// Uso: npm run migrate
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { pool, query } from "../db.js";

async function main(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, "../../migrations");
  await query(`CREATE TABLE IF NOT EXISTS engine_migrations (
    id serial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await query("SELECT id FROM engine_migrations WHERE name=$1", [file]);
    if (applied.rows.length > 0) {
      console.log(`[skip] ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    try {
      await query(sql);
      await query("INSERT INTO engine_migrations (name) VALUES ($1)", [file]);
      console.log(`[ok] ${file}`);
    } catch (err: any) {
      console.error(`[fail] ${file}: ${err.message}`);
      process.exit(1);
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error("Migración falló:", err);
  process.exit(1);
});