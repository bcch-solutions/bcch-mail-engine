# BCCH MAIL ENGINE

Backend especializado de correo para **BCCH MAIL CENTER**. Conexiones IMAP/SMTP reales, sincronización de buzones, colas persistentes, workers en segundo plano y API REST privada autenticada.

**Versión:** 1.0.0 · **runtime:** Node.js 20 LTS · **Licencia:** Uso interno BCCH

> **Despliegue desde GitHub (recomendado):** clone un repositorio privado y
> ejecute `docker compose up -d --build`. Procedimiento completo en
> `docs/GITHUB-DEPLOY.md`.
>
> **Empaquetado ZIP autónomo:** `bash scripts/pack-release.sh [ruta.zip]`
> genera `bcch-mail-engine-release.zip` con TODO el código fuente, Docker,
> migraciones y documentación — sin `node_modules/`, sin `dist/`, sin `.env`
> y sin secretos. Copie el ZIP al VPS y descomprímalo en `/opt/bcch-mail-engine`.

---

## Arquitectura

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  BCCH MAIL CENTER (Builder) │  HTTPS  │   BCCH MAIL ENGINE (VPS)     │
│  webmail.bcch.solutions     │ ──────► │   mail-api.bcch.solutions    │
│  - UI, Auth, Admin          │  HMAC   │   - IMAP (ImapFlow)          │
│  - Cloud (usuarios/roles)   │  +Token │   - SMTP (Nodemailer)        │
│  - engine_configuration     │         │   - PostgreSQL + Redis       │
└─────────────────────────────┘         │   - Workers persistentes     │
                                        └──────────────────────────────┘
```

- **Fuente única de verdad** para usuarios, dominios, roles, permisos y cuentas: **Cloud** (app principal). El motor solo mantiene índices, caché y colas.
- El motor **no** duplica usuarios ni configuraciones; consulta metadatos vía Data API con clave publicable.
- Las credenciales de correo se almacenan **cifradas con AES-256-GCM**; la clave vive en env, separada de la base de datos.

---

## Requisitos del VPS

- Ubuntu 24.04 LTS · 2 vCPU · 4 GB RAM · 80 GB SSD
- Docker + Docker Compose instalados
- Dominio `mail-api.bcch.solutions` con registro A apuntando al VPS

---

## Instalación en Ubuntu 24.04

```bash
# 1. Dependencias base
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg git

# 2. Docker
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

# 3. Clonar / copiar el código del motor
sudo mkdir -p /opt/bcch-mail-engine
sudo chown $USER /opt/bcch-mail-engine
# (copiar aquí el contenido de mail-engine/)

cd /opt/bcch-mail-engine

# 4. Configurar variables de entorno
cp .env.example .env
nano .env   # rellenar secretos reales (ver sección Variables)

# 5. Levantar la pila
docker compose up -d --build

# 6. Verificar
docker compose ps
curl http://127.0.0.1:8443/api/v1/health
```

### Comandos útiles

```bash
docker compose logs -f engine        # logs en vivo
docker compose restart engine        # reiniciar motor
docker compose down                  # detener pila
docker compose up -d --build         # reconstruir tras actualizar código
npm run diag                         # diagnóstico (dentro del contenedor: docker compose exec engine node dist/scripts/diagnose.js)
```

---

## Variables de entorno requeridas

| Variable | Descripción | Ejemplo |
|---|---|---|
| `PORT` | Puerto interno del motor | `8443` |
| `SERVICE_HMAC_SECRET` | Secreto compartido con la app principal | `openssl rand -hex 48` |
| `CREDENTIAL_ENC_KEY` | Clave AES-256-GCM (32 bytes hex) | `openssl rand -hex 32` |
| `DATABASE_URL` o `PG*` | PostgreSQL del motor | `postgres://...` |
| `REDIS_URL` | Redis para colas | `redis://redis:6379/0` |
| `BUILDER_SUPABASE_URL` | URL de Cloud | `https://...supabase.co` |
| `BUILDER_SUPABASE_PUBLISHABLE_KEY` | Clave publicable de Cloud | `eyJ...` |
| `ALLOWED_MAIL_DOMAINS` | Dominios autorizados | `bcch.solutions,net-capital.net` |
| `ALLOWED_PORTS` | Puertos IMAP/SMTP permitidos | `993,465,587` |
| `BLOCK_PRIVATE_NETWORKS` | Protección SSRF | `true` |
| `SYNC_INITIAL_DAYS` | Días de importación inicial | `30` |
| `CORS_ALLOWED_ORIGIN` | Origen del portal | `https://webmail.bcch.solutions` |

---

## Configuración DNS (manual, sin cambios automáticos)

En el gestor DNS de `bcch.solutions`:

| Tipo | Nombre | Valor |
|---|---|---|
| A | `mail-api` | IP pública del VPS |

Caddy obtiene el certificado TLS automáticamente al arrancar. No se modifican registros MX, SPF, DKIM ni DMARC.

---

## Conexión con BCCH MAIL CENTER

1. En el portal, ir a **BCCH Mail Engine** (panel superadmin).
2. Introducir la URL `https://mail-api.bcch.solutions`.
3. Usar **Probar API** — el backend del portal firma la petición con `BCCH_ENGINE_SERVICE_SECRET` y muestra la latencia real.
4. Las acciones de cuenta (Probar IMAP, Probar SMTP, Conectar, Sincronizar) se habilitan cuando el motor responde.

---

## API REST

Documentación OpenAPI completa: [`docs/openapi.yaml`](docs/openapi.yaml).

Resumen de endpoints bajo `/api/v1`:

| Grupo | Endpoints |
|---|---|
| Sistema | `GET /health` · `GET /version` · `GET /status` · `GET /diagnostics` |
| Auth | `POST /auth/issue-token` |
| Cuentas | `POST /accounts` · `POST /accounts/test` · `POST /accounts/connect` · `POST /accounts/disconnect` · `GET /accounts/:id/status` |
| Sincronización | `POST /accounts/:id/sync` · `GET /accounts/:id/sync-status` |
| Mensajes | `GET /accounts/:id/messages` · `GET /messages/:id` · `POST /messages/send` · `POST /messages/:id/reply` · `POST /messages/:id/forward` · `PATCH /messages/:id/flags` · `POST /messages/:id/move` · `DELETE /messages/:id` |
| Carpetas | `GET /accounts/:id/folders` · `POST /accounts/:id/folders` · `PATCH /folders/:id` · `DELETE /folders/:id` |
| Adjuntos | `GET /attachments/:id` |

---

## Actualización

```bash
cd /opt/bcch-mail-engine
git pull   # o copiar el nuevo código
docker compose up -d --build
docker compose exec engine node dist/scripts/migrate.js   # migraciones incrementales
```

Las actualizaciones **no eliminan datos**; las migraciones son incrementales e idempotentes.

---

## Backup y restauración

```bash
# Backup PostgreSQL del motor
docker compose exec postgres pg_dump -U bcch_engine bcch_mail_engine > backup-$(date +%F).sql

# Backup volumen Redis (colas)
docker run --rm -v bcch-mail-engine_redisdata:/data -v $(pwd):/backup alpine tar czf /backup/redis-$(date +%F).tar.gz /data

# Restaurar
cat backup-2026-01-01.sql | docker compose exec -T postgres psql -U bcch_engine bcch_mail_engine
```

Programar backups diarios con cron:

```cron
0 3 * * * cd /opt/bcch-mail-engine && docker compose exec -T postgres pg_dump -U bcch_engine bcch_mail_engine > /opt/backups/engine-$(date +\%F).sql
```

---

## Seguridad

- Credenciales cifradas AES-256-GCM; clave en env, nunca en la base de datos.
- HTTPS obligatorio vía Caddy (TLS 1.2/1.3, HSTS).
- Firma HMAC de servicio con timestamp (anti-replay, ventana de 2 min).
- Token de contexto de usuario de corta duración (5 min).
- Rate limiting global (300 req/min).
- Protección SSRF: bloqueo de redes privadas y puertos no autorizados.
- Sanitización HTML estricta; bloqueo de imágenes externas por defecto.
- Logs con redacción automática de secretos (pino `redact`).
- Nunca registra contraseñas ni tokens.

---

## Estado de implementación

| Componente | Estado |
|---|---|
| Código fuente del motor | ✅ Desarrollado |
| API REST /api/v1 | ✅ Desarrollada |
| Docker / Compose / Caddy | ✅ Desarrollados |
| Pruebas unitarias (crypto, auth, SSRF, sanitización, idempotencia) | ✅ Desarrolladas |
| Despliegue en VPS | ⏳ Pendiente (requiere VPS del cliente) |
| Pruebas con cuentas reales | ⏳ Pendientes (tras despliegue) |

**El motor NO se considera operativo** hasta que exista un VPS configurado y las pruebas reales de IMAP/SMTP satisfactorias (Fase 2.14).
