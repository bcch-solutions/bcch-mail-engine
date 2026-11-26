// ============================================================
// BCCH MAIL ENGINE — Validación de red (protección SSRF)
// Restringe destinos y puertos autorizados; bloquea redes privadas.
// ============================================================
import dns from "node:dns/promises";
import net from "node:net";
import { config } from "./config.js";

const PRIVATE_RANGES = [
  // IPv4 loopback, private, link-local
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\./, // CGNAT
  // IPv6 loopback + unique local + link-local
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

export interface ResolvedTarget {
  host: string;
  port: number;
  addresses: string[];
}

export async function resolveAndValidate(host: string, port: number): Promise<ResolvedTarget> {
  if (!host || (!net.isIP(host) && !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) {
    throw new Error(`Host inválido: ${host}`);
  }
  if (!config.allowedPorts.includes(port)) {
    throw new Error(`Puerto ${port} no autorizado. Permitidos: ${config.allowedPorts.join(", ")}`);
  }
  let addresses: string[];
  try {
    const rec = await dns.lookup(host, { all: true, family: 0 });
    addresses = rec.map((r) => r.address);
  } catch {
    throw new Error(`No se pudo resolver el host: ${host}`);
  }
  if (addresses.length === 0) {
    throw new Error(`Sin resultados DNS para: ${host}`);
  }
  if (config.blockPrivateNetworks) {
    for (const addr of addresses) {
      const stripped = addr.replace(/^::ffff:/, "");
      if (PRIVATE_RANGES.some((re) => re.test(stripped))) {
        throw new Error(`Destino en red privada bloqueado por SSRF: ${addr}`);
      }
    }
  }
  return { host, port, addresses };
}

export function isDomainAllowed(domain: string): boolean {
  if (config.allowedMailDomains.length === 0) return true;
  return config.allowedMailDomains.includes(domain.toLowerCase());
}