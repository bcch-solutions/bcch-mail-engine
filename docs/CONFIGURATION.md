# BCCH MAIL ENGINE — Manual de Configuración

## 1. Secretos críticos

Generar en el VPS:

```bash
openssl rand -hex 48   # SERVICE_HMAC_SECRET
openssl rand -hex 32   # CREDENTIAL_ENC_KEY
openssl rand -hex 32   # PG_PASSWORD (o usar generador de contraseñas)
```

Copiar los valores a `.env` (nunca al repositorio). El mismo `SERVICE_HMAC_SECRET` debe configurarse como `BCCH_ENGINE_SERVICE_SECRET` en el backend de BCCH MAIL CENTER (secrets del Builder).

## 2. Rotación de claves

Para rotar `CREDENTIAL_ENC_KEY` sin perder credenciales:

```bash
# 1. Configurar la nueva clave en .env como CREDENTIAL_ENC_KEY_NEW
# 2. Ejecutar rotación
docker compose exec engine node -e "
  const { rotateAllCredentials } = require('./dist/credentials');
  rotateAllCredentials(process.env.CREDENTIAL_ENC_KEY, process.env.CREDENTIAL_ENC_KEY_NEW)
    .then(r => console.log('rotadas:', r.rotated));
"
# 3. Promover la nueva clave a CREDENTIAL_ENC_KEY y reiniciar
```

## 3. Dominios autorizados

`ALLOWED_MAIL_DOMAINS` restringe a qué dominios puede conectarse el motor (protección SSRF + aislamiento). Añadir nuevos dominios desde el panel administrativo del portal y actualizar esta variable en el VPS.

## 4. Sincronización

- `SYNC_INITIAL_DAYS=30` — importación inicial (30/90/365 configurable por cuenta vía API).
- `SYNC_MAX_CONCURRENCY=4` — buzones sincronizados en paralelo.
- `SYNC_IDLE_ENABLED=true` — IMAP IDLE para detección en tiempo real.

## 5. SMTP

- `SMTP_MAX_CONCURRENCY=2`, `SMTP_MAX_RETRIES=5`, backoff exponencial desde 2 s.
- Estados de envío: `queued → processing → smtp_accepted | rejected | uncertain` (entregado solo con evidencia verificable).

## 6. Retención

- `ATTACHMENT_RETENTION_DAYS=30` — limpieza de archivos temporales.
- Los adjuntos se descargan solo bajo demanda; el servidor IMAP original es la fuente principal.

## 7. TLS

Caddy gestiona certificados automáticamente. Verificar:

```bash
curl -I https://mail-api.bcch.solutions/api/v1/health
openssl s_client -connect mail-api.bcch.solutions:443 -servername mail-api.bcch.solutions | head
```
