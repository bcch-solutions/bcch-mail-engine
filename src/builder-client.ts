// ============================================================
// BCCH MAIL ENGINE — Cliente Supabase del Builder (Data API)
// Lee metadatos de cuentas/dominios con clave publicable (TO anon).
// Las credenciales de correo se sirven cifradas desde la app principal
// mediante un endpoint seguro; nunca se expone la service_role al motor.
// ============================================================
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { log } from "./logger.js";

let _client: SupabaseClient | null = null;

export function builderClient(): SupabaseClient {
  if (_client) return _client;
  if (!config.builderSupabaseUrl || !config.builderSupabaseKey) {
    throw new Error("BUILDER_SUPABASE_URL/PUBLISHABLE_KEY no configuradas");
  }
  _client = createClient(config.builderSupabaseUrl, config.builderSupabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export interface BuilderAccountMeta {
  id: string;
  email_address: string;
  imap_server: string;
  imap_port: number;
  imap_security: string;
  smtp_server: string;
  smtp_port: number;
  smtp_security: string;
  auth_method: string;
  imap_username: string;
  smtp_username: string;
  encryption_type: string;
  domain_name: string;
  domain_dns: string;
}

export async function fetchAccountMeta(accountId: string): Promise<BuilderAccountMeta> {
  const sb = builderClient();
  const { data, error } = await sb
    .from("email_accounts")
    .select(
      "id, email_address, imap_server, imap_port, imap_security, smtp_server, smtp_port, smtp_security, auth_method, imap_username, smtp_username, encryption_type, domain_id",
    )
    .eq("id", accountId)
    .maybeSingle();
  if (error || !data) {
    log.error({ accountId, err: error?.message }, "cuenta no encontrada");
    throw new Error(`Account not found: ${accountId}`);
  }
  const { data: dom } = await sb.from("domains").select("name, domain").eq("id", data.domain_id).maybeSingle();
  return {
    id: data.id,
    email_address: data.email_address,
    imap_server: data.imap_server,
    imap_port: data.imap_port,
    imap_security: data.imap_security,
    smtp_server: data.smtp_server,
    smtp_port: data.smtp_port,
    smtp_security: data.smtp_security,
    auth_method: data.auth_method,
    imap_username: data.imap_username,
    smtp_username: data.smtp_username,
    encryption_type: data.encryption_type,
    domain_name: dom?.name || "",
    domain_dns: dom?.domain || "",
  };
}

export async function fetchAccountIdsForDomain(domainId: string): Promise<string[]> {
  const sb = builderClient();
  const { data, error } = await sb.from("email_accounts").select("id").eq("domain_id", domainId);
  if (error) throw error;
  return (data || []).map((r: any) => r.id);
}