# BCCH MAIL ENGINE — Manual de Instalación (Ubuntu 24.04 LTS)

## Requisitos previos

- VPS Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, 80 GB SSD
- Acceso SSH con usuario sudo
- Dominio `mail-api.bcch.solutions` con registro A → IP del VPS
- Puertos 80 y 443 abiertos (y 993/465/587 **salientes** hacia los servidores de correo)

## Paso a paso

```bash
# 1. Actualizar sistema
sudo apt update && sudo apt upgrade -y

# 2. Instalar Docker + Compose
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

# 3. Crear directorio y copiar el código
sudo mkdir -p /opt/bcch-mail-engine && sudo chown $USER /opt/bcch-mail-engine
cd /opt/bcch-mail-engine
# copiar aquí el contenido del directorio mail-engine/

# 4. Configurar entorno
cp .env.example .env
nano .env

# 5. Firewall (ufw)
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# 6. Arrancar
docker compose up -d --build

# 7. Verificar salud
docker compose ps
curl http://127.0.0.1:8443/api/v1/health
curl https://mail-api.bcch.solutions/api/v1/health
```

## Procedimiento para conectar cuentas de SiteGround (IMAP 993 / SMTP 465)

1. En **Site Tools → Email → Accounts**, cree la cuenta de correo y genere una
   **contraseña de aplicación** (no la contraseña maestra de SiteTools).
2. En **Email → Accounts → *Manual Settings***, anote el host real de IMAP/SMTP
   (p. ej. `mailp1.mysecurecloudhost.com`) — **no** asuma `imap.bcch.solutions`.
3. Verifique conectividad saliente desde el VPS:
   ```bash
   HOST=mailp1.mysecurecloudhost.com
   nc -zv $HOST 993   # IMAP/TLS
   nc -zv $HOST 465   # SMTP/TLS
   ```
   Si SiteGround bloquea por IP, añada la IP pública del VPS en
   Site Tools → Security → Firewall/IP Restrictions.
4. Registre la cuenta en el portal (**CUENTAS DE CORREO → Agregar cuenta**)
   con: host IMAP real, puerto **993**, seguridad **SSL/TLS**; host SMTP real,
   puerto **465** (o 587 STARTTLS), seguridad SSL/TLS; credencial = contraseña
   de aplicación; usuarios autorizados asignados explícitamente.
5. Desde **MAIL ENGINE**, use **Probar IMAP / Probar SMTP** — el motor reporta
   `imap.ok` y `smtp.ok` reales (sin simulación). Vea `docs/SITEGROUND.md` para
   el procedimiento completo y el mapeo de errores.

## Verificación de conectividad saliente IMAP/SMTP

```bash
# IMAP 993
nc -zv <imap-server-del-proveedor> 993
# SMTP 465
nc -zv <smtp-server-del-proveedor> 465
# SMTP 587
nc -zv <smtp-server-del-proveedor> 587
```

Si el proveedor bloquea por IP, solicitar inclusión en allowlist con la IP del VPS.

## Diagnóstico

```bash
docker compose exec engine node dist/scripts/diagnose.js
```

## Logs

```bash
docker compose logs -f engine
tail -f logs/*.log   # si se monta volumen de logs
```
