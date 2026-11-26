# BCCH MAIL ENGINE — Despliegue nativo en SiteGround GoGeek

> Guía completa para desplegar el motor **sin Docker, sin root, sin Redis, sin
> segunda base de datos y sin puertos entrantes personalizados**, usando:
> - **Cloud PostgreSQL** existente (base de datos única) con un **esquema
>   dedicado** (`mail_engine`) y un **rol restringido** (`bcch_engine`).
> - Infraestructura administrada por **SiteGround**: Node.js, SSL y GitHub.

---

## 1. Requisitos previos

- Plan **SiteGround GoGeek** con acceso a *Site Tools → Node.js*.
- Repositorio privado de GitHub `bcch-mail-engine` (contenido de `mail-engine/`
  en su raíz — publicado automáticamente por la GitHub Action del repo
  `bcch-mail-core`).
- Dominio `bcch.solutions` gestionado en SiteGround (para el subdominio
  `mail-api.bcch.solutions`).
- Cloud PostgreSQL habilitado y el rol `bcch_engine` + esquema `mail_engine`
  ya creados por la migración del Builder.

---

## 2. Base de datos: Cloud PostgreSQL con esquema dedicado

El motor usa la **misma base de datos Cloud** que BCCH MAIL CENTER, pero en un
**esquema aislado** (`mail_engine`) con un **rol restringido** (`bcch_engine`)
que **no tiene acceso** a `public`, `auth`, `storage` ni `realtime`.

### 2.1 Rotar la contraseña del rol (OBLIGATORIO)

La migración creó el rol `bcch_engine` con una contraseña temporal
(`CHANGE_ME_ENGINE_PASSWORD`). **Rótela antes de desplegar**:

1. Abra **More → Cloud** en el Builder.
2. En **SQL → psql**, ejecute:
   ```sql
   ALTER ROLE bcch_engine WITH PASSWORD '<contraseña-fuerte-generada>';
   ```
3. Anote la contraseña — no se vuelve a mostrar y no está en el repositorio.

### 2.2 Obtener la cadena de conexión

Cloud PostgreSQL expone conexiones externas vía su **pooler**. La cadena es:

```
postgres://bcch_engine:<contraseña>@db.<project-ref>.supabase.co:5432/postgres
```

> Reemplace `<contraseña>` por la que rotó en el paso 2.1 y `<project-ref>` por
> el identificador de su proyecto Cloud (visible en More → Cloud). El motor
> forzará TLS (`DB_SSL=true`) para toda conexión externa.

---

## 3. Crear la aplicación Node.js (Site Tools)

1. **Site Tools → Node.js → Create App**:

| Campo | Valor |
|---|---|
| Node.js version | **20.x LTS** (o 22.x LTS si está disponible) |
| Application root | `bcch-mail-engine` |
| Application URL | subdominio `mail-api.bcch.solutions` (paso 5) |
| Application startup file | `dist/index.js` |

2. **Comandos de la aplicación** (Site Tools → Node.js → Custom setup):

| Campo | Valor |
|---|---|
| Framework | Custom / Node.js |
| Installation command | `npm ci` |
| Build command | `npm run build` |
| Start command | `npm start` |
| Output directory | `dist` |

3. **Variables de entorno** (Site Tools → Node.js → Environment variables):

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `SERVICE_HMAC_SECRET` | `openssl rand -hex 48` (mismo valor que en el Builder) |
| `CREDENTIAL_ENC_KEY` | `openssl rand -hex 32` |
| `DATABASE_URL` | `postgres://bcch_engine:<contraseña>@db.<ref>.supabase.co:5432/postgres` |
| `DB_SCHEMA` | `mail_engine` |
| `DB_SSL` | `true` |
| `QUEUE_PROVIDER` | `postgres` |
| `SYNC_MODE` | `periodic` |
| `BUILDER_SUPABASE_URL` | URL de Cloud del Builder |
| `BUILDER_SUPABASE_PUBLISHABLE_KEY` | clave publicable de Cloud |
| `ALLOWED_MAIL_DOMAINS` | `bcch.solutions,net-capital.net` |
| `ALLOWED_PORTS` | `993,465,587` |
| `ENGINE_PUBLIC_URL` | `https://mail-api.bcch.solutions` |
| `CORS_ALLOWED_ORIGIN` | `https://webmail.bcch.solutions` |

> **No** defina `PORT`: SiteGround asigna el puerto dinámicamente. **No** defina
> `REDIS_URL` (`QUEUE_PROVIDER=postgres` no lo necesita).

---

## 4. Vincular GitHub (Site Tools → Git)

1. **Site Tools → Git → Create Repository → Clone from remote**:
   - URL: `https://github.com/bcch-solutions/bcch-mail-engine.git` (con token
     de acceso personal de solo lectura) o `git@github.com:...` (SSH).
   - Rama: `main`.
2. Primer despliegue: en Site Tools → Node.js, ejecute
   `npm ci` → `npm run build` → `npm start`.
3. Actualizaciones futuras: `git pull` desde Site Tools → Git → *Pull Changes*,
   luego re-ejecutar build y reiniciar la aplicación.

> El repositorio `bcch-mail-engine` se actualiza automáticamente cuando se
> actualiza `mail-engine/` en el repositorio principal `bcch-mail-core` (la
> GitHub Action `.github/workflows/publish-engine.yml` sincroniza el
> subdirectorio).

---

## 5. Asignar mail-api.bcch.solutions

1. **Site Tools → Domains → Subdomains**: `mail-api` sobre `bcch.solutions`.
2. **SSL**: Site Tools → Security → SSL Manager → *Install SSL* para
   `mail-api.bcch.solutions` (Let's Encrypt, administrado por SiteGround).
   Active *Force HTTPS*.
3. No se modifican registros MX, SPF, DKIM ni DMARC.

---

## 6. Migraciones

El motor crea sus tablas automáticamente en `mail_engine` al iniciar
(`ensureSchema()` usa `CREATE TABLE IF NOT EXISTS`). No se necesita un comando
de migración manual para el esquema del motor.

> Las tablas de Cloud (`domains`, `email_accounts`, etc.) se gestionan desde el
> Builder; el motor **no** las toca — solo lee metadatos vía la REST Data API.

---

## 7. Sincronización en SiteGround

### Modalidad B — periódica (`SYNC_MODE=periodic`, recomendada)

Conexiones IMAP de corta duración. Tres disparadores:

1. **Manual**: botón *Sincronizar* en el portal (API
   `POST /api/v1/accounts/:id/sync`).
2. **Al abrir el buzón**: el portal llama a la API al abrir la vista.
3. **Cron de SiteGround**: Site Tools → Cron → Add Job:

| Minuto | Hora | Día | Mes | Día semana | Comando |
|---|---|---|---|---|---|
| `*/15` | `*` | `*` | `*` | `*` | `cd ~/bcch-mail-engine/app && node dist/scripts/sync-cron.js >> ~/bcch-mail-engine/sync.log 2>&1` |

El script `sync-cron.js` sincroniza las cuentas conectadas, procesa la cola de
envío y los programados, y **cierra las conexiones** al terminar.

### Modalidad A — persistente (`SYNC_MODE=persistent`)

Workers + IMAP IDLE. Active solo si las pruebas de persistencia (sección 9)
pasan. No la declare operativa sin verificar primero.

---

## 8. Verificar que el motor está operativo

```bash
# Salud (endpoint público, sin firma)
curl -s https://mail-api.bcch.solutions/api/v1/health
# → {"status":"ok","timestamp":"..."}

# Diagnóstico completo (en la app Node de SiteGround)
cd ~/bcch-mail-engine/app
npm run diag
```

---

## 9. Pruebas de persistencia y conectividad

```bash
# 1. Persistencia de procesos: debe seguir vivo > 10 min
node -e "setInterval(()=>console.log(Date.now()),60000)" &
# 2. Cron: crear el job del paso 7 y verificar sync.log
tail -f ~/bcch-mail-engine/sync.log
# 3. Conectividad saliente IMAP/SMTP (consola SSH de SiteGround)
nc -zv <imap-server> 993
nc -zv <smtp-server> 465
nc -zv <smtp-server> 587
```

Si el proceso de larga vida muere o el cron no se ejecuta, mantenga
`SYNC_MODE=periodic` y use el cron de SiteGround.

---

## 10. Actualización del motor

```bash
cd ~/bcch-mail-engine/app
git pull origin main
npm ci
npm run build
# Reiniciar: Site Tools → Node.js → Restart
```

Los datos (esquema `mail_engine` en Cloud PG) viven fuera del código: la
actualización no pierde configuraciones ni datos.

---

## 11. Backup y restauración (Cloud PostgreSQL)

```bash
# Backup del esquema del motor
pg_dump "postgres://bcch_engine:<pwd>@db.<ref>.supabase.co:5432/postgres" \
  -n mail_engine > backup-engine-$(date +%F).sql

# Restaurar
psql "postgres://bcch_engine:<pwd>@db.<ref>.supabase.co:5432/postgres" \
  < backup-engine-2026-01-01.sql
```

---

## 12. Perfil Docker (VPS) — conservado

El perfil Docker (`Dockerfile`, `docker-compose.yml`, `Caddyfile`, Redis)
**se conserva intacto** para futuras migraciones a VPS. La selección entre
despliegues es exclusivamente por variables de entorno:

| Despliegue | DATABASE_URL | DB_SCHEMA | QUEUE_PROVIDER | SYNC_MODE |
|---|---|---|---|---|
| SiteGround GoGeek | Cloud PG (pooler) | `mail_engine` | `postgres` | `periodic` |
| VPS / Docker | PG local/contenedor | `mail_engine` | `redis` | `persistent` |

---

## 13. Seguridad

- **Separación de datos**: el rol `bcch_engine` solo accede a `mail_engine`;
  `REVOKE` explícito sobre `public`, `auth`, `storage`, `realtime`.
- HTTPS administrado por SiteGround (Let's Encrypt + Force HTTPS).
- HMAC de servicio con timestamp (anti-replay, ventana de 2 min).
- Credenciales de correo cifradas AES-256-GCM (`CREDENTIAL_ENC_KEY`).
- Protección SSRF y restricción de dominios/puertos.
- Conexiones Cloud PG forzadas a TLS (`DB_SSL=true`).
- Secretos solo en variables de entorno; nunca en el repositorio.