// ============================================================
// BCCH MAIL ENGINE — Diagnóstico de conectividad real (sin simulación)
// DNS → TCP → TLS → (IMAP/SMTP los prueban imap.ts / smtp.ts)
// ============================================================
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { config } from "./config.js";

export interface PortCheck {
  port: number;
  tcp: boolean;
  tls: boolean;
  tlsVersion?: string;
  latencyMs?: number;
  error?: string;
}

export interface HostDiagnosis {
  host: string;
  resolved: boolean;
  resolvedIps: string[];
  privateBlocked: boolean;
  ports: PortCheck[];
}

function tcpProbe(host: string, port: number, timeoutMs = 6000): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port }, () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ ok: true, latencyMs });
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "Tiempo de espera agotado." });
    });
    socket.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

function tlsProbe(host: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; latencyMs?: number; protocol?: string; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
      const latencyMs = Date.now() - start;
      const protocol = socket.getProtocol() || undefined;
      socket.destroy();
      resolve({ ok: true, latencyMs, protocol });
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "Negociación TLS agotada." });
    });
    socket.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

export async function diagnoseHost(host: string): Promise<HostDiagnosis> {
  const result: HostDiagnosis = { host, resolved: false, resolvedIps: [], privateBlocked: false, ports: [] };
  try {
    const rec = await dns.lookup(host, { all: true, family: 0 });
    result.resolvedIps = rec.map((r) => r.address);
    result.resolved = result.resolvedIps.length > 0;
  } catch (err: any) {
    result.ports = config.allowedPorts.map((port) => ({ port, tcp: false, tls: false, error: `No se pudo resolver el host: ${err.message}` }));
    return result;
  }

  for (const port of config.allowedPorts) {
    const check: PortCheck = { port, tcp: false, tls: false };
    const tcp = await tcpProbe(host, port);
    check.tcp = tcp.ok;
    check.latencyMs = tcp.latencyMs;
    check.error = tcp.error;
    if (tcp.ok && (port === 993 || port === 465)) {
      const t = await tlsProbe(host, port);
      check.tls = t.ok;
      check.tlsVersion = t.protocol;
      if (!t.ok) check.error = t.error;
    }
    result.ports.push(check);
  }
  return result;
}
