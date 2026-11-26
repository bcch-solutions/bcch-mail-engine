# BCCH MAIL ENGINE — Manual de Actualización

## Actualización estándar

```bash
cd /opt/bcch-mail-engine
# 1. Backup previo (obligatorio)
docker compose exec -T postgres pg_dump -U bcch_engine bcch_mail_engine > /opt/backups/pre-update-$(date +%F).sql

# 2. Detener
docker compose down

# 3. Reemplazar código
git pull origin main   # repositorio privado de GitHub (ver docs/GITHUB-DEPLOY.md)
# 4. Reconstruir y arrancar
docker compose up -d --build

# 5. Aplicar migraciones incrementales
docker compose exec engine node dist/scripts/migrate.js

# 6. Verificar
curl https://mail-api.bcch.solutions/api/v1/health
docker compose logs --tail 50 engine
```

## Reglas

- Las migraciones son **incrementales e idempotentes**; nunca reinicializan la base de datos.
- No se eliminan datos existentes durante actualizaciones.
- Si una migración falla, el script se detiene antes de continuar (`process.exit(1)`).
- Restaurar backup si es necesario: `cat backup.sql | docker compose exec -T postgres psql -U bcch_engine bcch_mail_engine`.

## Rollback

```bash
docker compose down
git checkout <tag-anterior>   # o restaurar copia del código
docker compose up -d --build
```
