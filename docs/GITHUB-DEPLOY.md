# BCCH MAIL ENGINE — Despliegue desde un repositorio privado de GitHub

> Este documento describe cómo desplegar **BCCH MAIL ENGINE** en un VPS
> Ubuntu 24.04 LTS clonando un repositorio **privado** de GitHub. El motor es
> **independiente** de la aplicación principal (BCCH MAIL CENTER alojada en
> Builder Cloud) y se ejecuta en su propio contenedor Docker.

---

## 1. Requisitos previos

- VPS Ubuntu 24.04 LTS (2 vCPU, 4 GB RAM, 80 GB SSD).
- Acceso SSH con usuario `sudo` no-root.
- Registro DNS **A** `mail-api.bcch.solutions` → IP pública del VPS
  (no se realizan cambios DNS automáticamente).
- Puertos **80/443** abiertos (entrada) y **993/465/587** abiertos (salida).
- Repositorio privado de GitHub con el contenido de `mail-engine/` en su raíz.

---

## 2. Conectar el proyecto del Builder con GitHub

Desde el Builder, exporte el directorio `mail-engine/` a un repositorio
privado de GitHub:

1. Cree un repositorio **privado** vacío en GitHub, por ejemplo
   `bcch-mail-engine`.
2. En el Builder, abra la terminal del proyecto y empuje **solo** el motor:

```bash
# Desde la raíz del proyecto del Builder
cd mail-engine
git init
git checkout -b main
git add .
git commit -m "BCCH MAIL ENGINE 1.0.0 — entrega Fase 2"
git remote add origin git@github.com:<su-organizacion>/bcch-mail-engine.git
git branch -M main
git push -u origin main
```

> El `.gitignore` del motor excluye `node_modules/`, `dist/`, `.env`,
> `*.pem`, `*.key`, `*.secret`, `secrets/`, `logs/` y `tmp/`. Verifique que
> **no** se commiteen secretos: `git status --ignored` antes del push.

3. Cree una **Deploy Key** (clave SSH de solo lectura) en GitHub:
   - `ssh-keygen -t ed25519 -C "vps-bcch-engine" -f ~/.ssh/bcch_engine_deploy -N ""`
   - Copie `~/.ssh/bcch_engine_deploy.pub` en GitHub →
     *Repo → Settings → Deploy keys → Add deploy key* (sin acceso write).

---

## 3. Comandos exactos de instalación en el VPS (Ubuntu 24.04 LTS)

Ejecute como usuario `sudo` no-root:

```bash
# 3.1 Actualizar sistema
sudo apt update && sudo apt upgrade -y

# 3.2 Instalar Docker + Compose plugin
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

# 3.3 Instalar herramientas auxiliares
sudo apt install -y git netcat-openbsd curl ufw

# 3.4 Configurar firewall
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# 3.5 Preparar clave SSH de deploy (solo lectura del repo privado)
mkdir -p ~/.ssh
# Copie la clave privada bcch_engine_deploy generada en el paso 2 al VPS:
#   scp ~/.ssh/bcch_engine_deploy <vps-user>@<vps-ip>:~/.ssh/
chmod 600 ~/.ssh/bcch_engine_deploy
cat >> ~/.ssh/config <<'EOF'
Host github-bcch-engine
  HostName github.com
  User git
  IdentityFile ~/.ssh/bcch_engine_deploy
  IdentitiesOnly yes
EOF
# Confirmar el fingerprint de GitHub (evita prompt interactivo)
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null

# 3.6 Clonar el repositorio privado
sudo mkdir -p /opt/bcch-mail-engine
sudo chown $USER:$USER /opt/bcch-mail-engine
git clone git@github-bcch-engine:<su-organizacion>/bcch-mail-engine.git /opt/bcch-mail-engine
cd /opt/bcch-mail-engine
git log --oneline -1   # verificar que el código está presente

# 3.7 Configurar variables de entorno
cp .env.example .env
nano .env   # rellenar con valores reales (ver sección 6)

# 3.8 Compilar e iniciar
docker compose up -d --build

# 3.9 Verificar salud del motor
docker compose ps
curl -s http://127.0.0.1:8443/api/v1/health
curl -s https://mail-api.bcch.solutions/api/v1/health
curl -s https://mail-api.bcch.solutions/api/v1/version
```

Salud esperada (`/api/v1/health`):

```json
{ "status": "ok", "uptime": 12, "ts": "2026-11-25T..." }
```

---

## 4. HTTPS automático para mail-api.bcch.solutions

El `docker-compose.yml` incluye **Caddy**, que obtiene certificados TLS
válidos de Let's Encrypt automáticamente al iniciar, siempre que:

1. El registro A `mail-api.bcch.solutions` apunte a la IP pública del VPS.
2. Los puertos 80 y 443 estén abiertos (Caddy usa 80 para el challenge ACME).
3. El `Caddyfile` contenga el dominio exacto (ya configurado).

Verificar TLS:

```bash
curl -vI https://mail-api.bcch.solutions/api/v1/health 2>&1 | grep -E "subject|issuer|SSL|TLS"
echo | openssl s_client -connect mail-api.bcch.solutions:443 -servername mail-api.bcch.solutions 2>/dev/null | openssl x509 -noout -dates
```

Renovación: Caddy renueva automáticamente antes del vencimiento (cada ~60 días).
No requiere cron ni `certbot`.

---

## 5. Actualización del motor desde GitHub (sin perder datos)

Las **bases de datos (Postgres) y colas (Redis) viven en volúmenes Docker
persistentes** (`pgdata`, `redisdata`), por lo que un `git pull` + rebuild
**no** elimina datos ni configuraciones. El `.env` se mantiene en el VPS
(fuera del repo) y no se sobrescribe.

```bash
cd /opt/bcch-mail-engine

# 5.1 Backup previo (obligatorio)
mkdir -p /opt/backups
docker compose exec -T postgres pg_dump -U bcch_engine bcch_mail_engine \
  > /opt/backups/pre-update-$(date +%F).sql

# 5.2 Detener servicios
docker compose down

# 5.3 Actualizar código
git pull origin main

# 5.4 Reconstruir y arrancar
docker compose up -d --build

# 5.5 Aplicar migraciones incrementales (idempotentes)
docker compose exec engine node dist/scripts/migrate.js

# 5.6 Verificar
curl -s https://mail-api.bcch.solutions/api/v1/health
docker compose logs --tail 50 engine
```

**Reglas:**
- Las migraciones son **incrementales e idempotentes**; nunca reinicializan
  la base de datos.
- No se eliminan datos existentes durante actualizaciones.
- Si una migración falla, el script se detiene antes de continuar.
- Rollback: `git checkout <tag-anterior> && docker compose up -d --build`.

---

## 6. Listado exacto de secretos requeridos y su ubicación

### 6.1 En el VPS — archivo `/opt/bcch-mail-engine/.env` (fuera del repo)

| Variable | Descripción | Generación |
|---|---|---|
| `SERVICE_HMAC_SECRET` | Secreto HMAC entre Builder y Engine | `openssl rand -hex 48` |
| `CREDENTIAL_ENC_KEY` | Clave AES-256-GCM para credenciales de correo | `openssl rand -hex 32` |
| `PG_PASSWORD` | Contraseña de PostgreSQL del motor | `openssl rand -hex 24` |
| `DATABASE_URL` | Cadena de conexión Postgres del motor | (compuesta) |
| `REDIS_URL` | URL de Redis | `redis://redis:6379/0` |
| `BUILDER_SUPABASE_URL` | URL de Cloud del Builder | (de Cloud) |
| `BUILDER_SUPABASE_PUBLISHABLE_KEY` | Clave publicable de Cloud | (de Cloud) |
| `ALLOWED_MAIL_DOMAINS` | Dominios autorizados | `bcch.solutions,net-capital.net` |
| `ALLOWED_PORTS` | Puertos IMAP/SMTP permitidos | `993,465,587` |
| `ENGINE_PUBLIC_URL` | URL pública del motor | `https://mail-api.bcch.solutions` |
| `CORS_ALLOWED_ORIGIN` | Origen permitido (portal) | `https://webmail.bcch.solutions` |

> **NUNCA** commitear `.env`. El `.gitignore` del motor lo excluye.

### 6.2 En el Builder — Secrets del proyecto (More → Secrets)

| Secret | Descripción |
|---|---|
| `BCCH_ENGINE_API_URL` | `https://mail-api.bcch.solutions` |
| `BCCH_ENGINE_SERVICE_SECRET` | Mismo valor que `SERVICE_HMAC_SECRET` del VPS |
| `BCCH_BOOTSTRAP_SECRET` | Secreto de un solo uso para inicializar el superadmin |
| `SUPABASE_SERVICE_ROLE_KEY` | (gestionado por Cloud) |

> Estos secretos se leen **dentro** de los handlers de las server functions
> (`process.env.*`), nunca en el navegador.

---

## 7. Conectar el Builder con el motor desplegado

1. Despliegue el motor en el VPS (secciones 3–4).
2. En el Builder: **More → Secrets**, registre `BCCH_ENGINE_API_URL` y
   `BCCH_ENGINE_SERVICE_SECRET` (idénticos a los del VPS).
3. En el portal, vaya a **MAIL ENGINE**, introduzca la URL de la API y use
   **Probar API** — el backend del Builder firmará la petición con HMAC y
   el motor responderá con estado real.
4. Mientras el motor no responda, el portal muestra
   **MOTOR PENDIENTE DE DESPLIEGUE** (sin resultados simulados).

---

## 8. Procedimiento para conectar cuentas de SiteGround (IMAP 993 / SMTP 465)

Ver `docs/SITEGROUND.md` para el procedimiento completo. Resumen:

1. En SiteGround, obtenga el **host real** IMAP/SMTP
   (`mailp*.mysecurecloudhost.com`) desde *Manual Settings* — no asuma
   `imap.bcch.solutions`.
2. Verifique conectividad saliente desde el VPS:
   `nc -zv <host> 993` y `nc -zv <host> 465`.
3. Registre la cuenta en el portal (**CUENTAS DE CORREO → Agregar cuenta**)
   con host real, puerto 993 (SSL/TLS) y 465 (SSL/TLS) o 587 (STARTTLS),
   usando la **contraseña de aplicación**.
4. Desde **MAIL ENGINE → Probar IMAP / Probar SMTP**, el motor reporta
   `imap.ok` y `smtp.ok` reales.

---

## 9. Verificación final de que el motor está operativo

```bash
# Salud
curl -s https://mail-api.bcch.solutions/api/v1/health
# Versión
curl -s https://mail-api.bcch.solutions/api/v1/version
# Estado (requiere firma HMAC desde el Builder; vía API directa):
docker compose exec engine node dist/scripts/diagnose.js
# Contenedores
docker compose ps
# Logs
docker compose logs --tail 100 engine
```

El motor se considera **operativo** únicamente cuando:
- `/api/v1/health` responde `200` con `"status":"ok"`.
- El diagnóstico reporta Postgres, Redis y workers activos.
- Una cuenta real de SiteGround pasa `Probar IMAP` y `Probar SMTP`.

---

## 10. Backup y restauración

```bash
# Backup
docker compose exec -T postgres pg_dump -U bcch_engine bcch_mail_engine \
  > /opt/backups/bcch-engine-$(date +%F).sql

# Restaurar
docker compose down
cat /opt/backups/bcch-engine-AAAA-MM-DD.sql | \
  docker compose exec -T postgres psql -U bcch_engine bcch_mail_engine
docker compose up -d
```
