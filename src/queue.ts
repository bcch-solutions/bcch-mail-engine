// ============================================================
// BCCH MAIL ENGINE — Colas persistentes con proveedor configurable
//   QUEUE_PROVIDER=postgres  → implementación nativa SKIP LOCKED
//                              (SiteGround GoGeek, sin Redis)
//   QUEUE_PROVIDER=redis     → Redis (conservado para VPS/Docker)
// ============================================================
import { query } from "./db.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { RedisClientType } from "redis";

export const QUEUES = {
  sync: "bme:queue:sync",
  outgoing: "bme:queue:outgoing",
  scheduled: "bme:queue:scheduled",
};

export interface QueueItem {
  id: string;
  payload: any;
  attempts: number;
  enqueuedAt: number;
}

const useRedis = (): boolean => config.queueProvider === "redis";

// ---------------- Redis (VPS / Docker) ----------------
let redis: RedisClientType | null = null;

async function getRedis(): Promise<RedisClientType> {
  if (redis) return redis;
  const { createClient } = await import("redis");
  redis = createClient({ url: config.redisUrl }) as unknown as RedisClientType;
  redis.on("error", (err: Error) => log.error({ err: err.message }, "redis error"));
  await redis.connect();
  return redis;
}

async function enqueueRedis(queue: string, payload: Record<string, any>): Promise<string> {
  const r = await getRedis();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await r.lPush(queue, JSON.stringify({ id, payload, attempts: 0, enqueuedAt: Date.now() }));
  return id;
}

async function dequeueRedis(queue: string, timeoutMs = 5000): Promise<QueueItem | null> {
  const r = await getRedis();
  const res = await r.blPop(queue, Math.floor(timeoutMs / 1000));
  if (!res) return null;
  const raw = Array.isArray(res) ? res[1] : res.element;
  try {
    return JSON.parse(raw) as QueueItem;
  } catch {
    return null;
  }
}

async function requeueWithDelayRedis(queue: string, item: QueueItem, delayMs: number): Promise<void> {
  const r = await getRedis();
  await r.set(`bme:delayed:${queue}:${item.id}`, JSON.stringify({ ...item, attempts: item.attempts + 1 }), {
    PX: delayMs,
  });
}

async function claimDelayedRedis(queue: string): Promise<QueueItem | null> {
  const r = await getRedis();
  const keys = await r.keys(`bme:delayed:${queue}:*`);
  for (const key of keys) {
    const raw = await r.get(key);
    if (raw) {
      await r.del(key);
      return JSON.parse(raw) as QueueItem;
    }
  }
  return null;
}

async function pruneExpiredRedis(): Promise<void> {
  const r = await getRedis();
  for (const q of Object.values(QUEUES)) {
    const keys = await r.keys(`bme:delayed:${q}:*`);
    for (const key of keys) {
      const ttl = await r.pTTL(key);
      if (ttl !== null && ttl < 0) await r.del(key);
    }
  }
}

// ---------------- PostgreSQL (SiteGround, sin Redis) ----------------
export async function enqueuePg(queue: string, payload: Record<string, any>): Promise<string> {
  const { rows } = await query(
    "INSERT INTO engine_queue (queue, payload) VALUES ($1,$2) RETURNING id::text AS id",
    [queue, JSON.stringify(payload)],
  );
  return rows[0].id;
}

export async function claimPg(queue: string, limit = 1): Promise<QueueItem[]> {
  const { rows } = await query(
    `UPDATE engine_queue SET status='processing', updated_at=now()
     WHERE id IN (
       SELECT id FROM engine_queue
       WHERE queue=$1 AND status='pending' AND visible_at <= now()
       ORDER BY id LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id::text AS id, payload, attempts, created_at`,
    [queue, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    attempts: r.attempts,
    enqueuedAt: new Date(r.created_at).getTime(),
  }));
}

export async function completePg(id: string): Promise<void> {
  await query("UPDATE engine_queue SET status='done', updated_at=now() WHERE id=$1::bigint", [id]);
}

export async function failPg(id: string, err: string, maxRetries: number, backoffMs: number): Promise<void> {
  const { rows } = await query("SELECT attempts FROM engine_queue WHERE id=$1::bigint", [id]);
  const attempts = rows[0]?.attempts ?? 0;
  if (attempts + 1 >= maxRetries) {
    await query("UPDATE engine_queue SET status='failed', error=$2, attempts=attempts+1, updated_at=now() WHERE id=$1::bigint", [
      id,
      String(err).slice(0, 500),
    ]);
    return;
  }
  await query(
    "UPDATE engine_queue SET status='pending', visible_at=now() + ($2 || ' milliseconds')::interval, attempts=attempts+1, error=$3, updated_at=now() WHERE id=$1::bigint",
    [id, String(backoffMs * Math.pow(2, attempts)), String(err).slice(0, 500)],
  );
}

export async function requeueWithDelayPg(queue: string, item: QueueItem, delayMs: number): Promise<void> {
  await query(
    "UPDATE engine_queue SET status='pending', visible_at=now() + ($2 || ' milliseconds')::interval, attempts=attempts+1, updated_at=now() WHERE id=$1::bigint",
    [item.id, String(delayMs)],
  );
}

export async function pruneExpiredPg(): Promise<void> {
  await query("DELETE FROM engine_queue WHERE status IN ('done','failed') AND updated_at < now() - interval '7 days'");
}

export interface QueueStats {
  provider: string;
  queues: { queue: string; pending: number; processing: number; delayed: number; failed: number }[];
}

export async function queueStats(): Promise<QueueStats> {
  if (useRedis()) {
    return { provider: "redis", queues: [] };
  }
  const { rows } = await query(
    `SELECT queue,
            count(*) FILTER (WHERE status='pending' AND visible_at<=now())::int AS pending,
            count(*) FILTER (WHERE status='pending' AND visible_at>now())::int AS delayed,
            count(*) FILTER (WHERE status='processing')::int AS processing,
            count(*) FILTER (WHERE status='failed')::int AS failed
     FROM engine_queue GROUP BY queue`,
  );
  return {
    provider: "postgres",
    queues: rows.map((r) => ({
      queue: r.queue,
      pending: r.pending,
      delayed: r.delayed,
      processing: r.processing,
      failed: r.failed,
    })),
  };
}

// ---------------- API unificada (compatibilidad con imports existentes) ----------------
export async function enqueue(queue: string, payload: Record<string, any>): Promise<string> {
  return useRedis() ? enqueueRedis(queue, payload) : enqueuePg(queue, payload);
}

export async function dequeue(queue: string, timeoutMs = 5000): Promise<QueueItem | null> {
  return useRedis() ? dequeueRedis(queue, timeoutMs) : (await claimPg(queue, 1))[0] ?? null;
}

export async function claim(queue: string, limit = 1): Promise<QueueItem[]> {
  return useRedis() ? [((await dequeueRedis(queue)) ?? null) as QueueItem].filter(Boolean) : claimPg(queue, limit);
}

export async function requeueWithDelay(queue: string, item: QueueItem, delayMs: number): Promise<void> {
  return useRedis() ? requeueWithDelayRedis(queue, item, delayMs) : requeueWithDelayPg(queue, item, delayMs);
}

export async function claimDelayed(queue: string): Promise<QueueItem | null> {
  return useRedis() ? claimDelayedRedis(queue) : null; // en PG los items retrasados se reclaman solos vía visible_at
}

export async function pruneExpired(): Promise<void> {
  return useRedis() ? pruneExpiredRedis() : pruneExpiredPg();
}
