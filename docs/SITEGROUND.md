# BCCH MAIL ENGINE — Procedimiento de conexión con cuentas SiteGround

> Este documento describe cómo conectar cuentas de correo reales alojadas en
> SiteGround mediante IMAP (puerto 993, TLS) y SMTP (puerto 465, TLS / 587,
> STARTTLS) a través de **BCCH MAIL ENGINE**.
>
> **Importante:** el motor NO crea buzones. Solo conecta cuentas de correo
> existentes en el proveedor. No se modifican registros MX, SPF, DKIM ni
> DMARC.

---

## 1. Requisitos previos en SiteGround

1. **Cuenta de correo creada en SiteGround** (Site Tools → Email → Accounts).
2. **Contraseña de aplicación** (no la contraseña maestra de la cuenta de
   usuario de SiteTools). SiteTools → Email → Accounts →
   *Manage* → *Generate App Password* (o *Set Password* si el proveedor exige
   la contraseña de buzón). Si SiteGround exige autenticación con la
   contraseña del buzón, usar esa contraseña como credencial.
3. **Buzón IMAP habilitado** (Site Tools → Email → *IMAP/POP* → habilitar
   IMAP). SiteGround lo habilita por defecto.
4. **Conectividad saliente desde el VPS** hacia los servidores de SiteGround
   (verificación abajo).

---

## 2. Servidores reales de SiteGround

SiteGround publica los servidores IMAP/SMTP del **servidor de correo** que
aloja el dominio. NO son `imap.bcch.solutions`; se obtienen en
**Site Tools → Email → Accounts → *Manual Settings*** de cada cuenta.

Formato típico de SiteGround:

| Protocolo | Host (ejemplo) | Puerto | Cifrado |
|---|---|---|---|
| IMAP | `mailp*.mysecurecloudhost.com` o `mx*.sitegroundhost.com` | **993** | SSL/TLS |
| IMAP (alt.) | mismo host | 143 | STARTTLS |
| SMTP  | mismo host | **465** | SSL/TLS |
| SMTP (alt.) | mismo host | **587** | STARTTLS |

> El host real (`mailpNN.mysecurecloudhost.com`) aparece en el panel de
> SiteGround bajo *Manual Settings* de la cuenta. Anote ese host exacto —
> no asuma que es `imap.bcch.solutions`.

---

## 3. Verificación de conectividad saliente desde el VPS

Antes de registrar la cuenta en el motor, verifique que el VPS puede alcanzar
el servidor de SiteGround en los puertos 993 y 465:

```bash
# Reemplace <host> por el host real de SiteGround de Manual Settings
HOST=mailp1.mysecurecloudhost.com

# IMAP/TLS 993
nc -zv $HOST 993
openssl s_client -connect $HOST:993 -servername $HOST -showcerts </dev/null 2>&1 | head -20

# SMTP/TLS 465
nc -zv $HOST 465
openssl s_client -connect $HOST:465 -servername $HOST </dev/null 2>&1 | head -20

# SMTP/STARTTLS 587
nc -zv $HOST 587
openssl s_client -connect $HOST:587 -starttls smtp -servername $HOST </dev/null 2>&1 | head -20
```

Si SiteGround bloquea por IP, solicite incluir la **IP pública del VPS** en
la allowlist de Site Tools → Security → *IP Restrictions* / Firewall.

---

## 4. Registro de la cuenta en BCCH MAIL CENTER (portal)

La cuenta se crea desde el panel administrativo del portal
(**CUENTAS DE CORREO → Agregar cuenta**) — no directamente en el motor.

Campos a introducir (valores reales de SiteGround):

| Campo del portal | Valor |
|---|---|
| Empresa | (según corresponda) |
| Dominio | `bcch.solutions` o `net-capital.net` |
| Nombre de la cuenta | (etiqueta interna, ej. `Soporte BCCH`) |
| Dirección de correo | `usuario@bcch.solutions` |
| Nombre de usuario IMAP | `usuario@bcch.solutions` (o el user IMAP de SiteGround) |
| Nombre de usuario SMTP | `usuario@bcch.solutions` |
| Contraseña / credencial | **contraseña de aplicación** de SiteGround |
| Servidor IMAP | `mailp1.mysecurecloudhost.com` (host real) |
| Puerto IMAP | **993** |
| Seguridad IMAP | **SSL/TLS** |
| Servidor SMTP | `mailp1.mysecurecloudhost.com` (host real) |
| Puerto SMTP | **465** (o **587** con STARTTLS) |
| Tipo de cifrado | SSL/TLS (o STARTTLS si usa 587) |
| Método de autenticación | Contraseña de aplicación (o OAuth 2.0 si SiteGround lo exige) |
| Usuarios autorizados | Asignar explícitamente los usuarios del portal |

> El motor valida con `rejectUnauthorized: true`; SiteGround sirve certificados
> TLS válidos, por lo que no se requiere desactivar la validación.

---

## 5. Probar conexión IMAP y SMTP desde el motor

Una vez registrado y con el motor desplegado, pruebe la cuenta desde el panel
**MAIL ENGINE → Probar IMAP / Probar SMTP** (o vía API):

```bash
# Prueba IMAP + SMTP vía API (firmada por el backend del portal)
curl -X POST https://mail-api.bcch.solutions/api/v1/accounts/test \
  -H "Content-Type: application/json" \
  -H "X-Service-Signature: $SIG" \
  -H "X-Service-Timestamp: $TS" \
  -H "X-User-Token: $USER_TOKEN" \
  -d '{"account_id":"<uuid-de-la-cuenta>"}'
```

Respuesta esperada (`imap.ok: true`, `smtp.ok: true`):

```json
{
  "imap": { "ok": true, "latencyMs": 187 },
  "smtp": { "ok": true, "latencyMs": 142 }
}
```

Errores típicos reales que el motor distingue (sin simulación):

| Error | Causa |
|---|---|
| `Credenciales incorrectas.` | Contraseña de aplicación inválida o expirada |
| `Servidor inaccesible o puerto bloqueado.` | Firewall del VPS o de SiteGround bloquea 993/465 |
| `Certificado inválido o TLS no compatible.` | Host equivocado o MITM |
| `Tiempo de espera agotado.` | Conectividad interrumpida |
| `Método de autenticación no compatible.` | Proveedor exige OAuth 2.0 |

---

## 6. Conectar y sincronizar

```bash
# Conectar (mantiene IMAP IDLE)
curl -X POST https://mail-api.bcch.solutions/api/v1/accounts/connect \
  -H "Content-Type: application/json" -H "X-Service-Signature: $SIG" \
  -H "X-Service-Timestamp: $TS" -H "X-User-Token: $USER_TOKEN" \
  -d '{"account_id":"<uuid>"}'

# Sincronizar últimos 30 días (por defecto)
curl -X POST https://mail-api.bcch.solutions/api/v1/accounts/<uuid>/sync \
  -H "Content-Type: application/json" -H "X-Service-Signature: $SIG" \
  -H "X-Service-Timestamp: $TS" -H "X-User-Token: $USER_TOKEN" \
  -d '{"days":30}'
```

Alternativas de período: `90`, `365`, o `3650` (historial completo).

---

## 7. Notas de seguridad

- La **contraseña de aplicación** se cifra con AES-256-GCM en el motor
  (`CREDENTIAL_ENC_KEY`, nunca en la base de datos en texto plano).
- El motor **no** elimina correos del servidor IMAP original al
  desconectar una cuenta del portal; las eliminaciones permanentes requieren
  confirmación explícita.
- `ALLOWED_MAIL_DOMAINS` debe incluir los dominios de SiteGround que se
  conecten; el motor rechaza conexiones a dominios no autorizados
  (protección SSRF).
- Nunca registre la contraseña maestra de SiteTools; use siempre una
  **contraseña de aplicación** por cuenta de correo.