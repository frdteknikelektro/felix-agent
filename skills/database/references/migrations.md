# Migrations

Running migration tools through Felix.

## Prisma

Setup:
```bash
npx prisma migrate dev --name MIGRATION_NAME
npx prisma migrate deploy  # apply pending migrations
npx prisma migrate status   # check status
```

Felix workflow:
1. Read `prisma/schema.prisma` to understand the schema.
2. Generate migration: `npx prisma migrate dev --name <description>`.
3. Review the generated SQL in `prisma/migrations/`.
4. Apply: `npx prisma migrate deploy`.
5. Verify: `npx prisma migrate status` shows all applied.

Quirks:
- `prisma migrate dev` creates a migration file and applies it.
- `prisma migrate deploy` applies pending migrations without generating new ones.
- `prisma db push` is for prototyping — not for production migrations.

## Alembic (Python / SQLAlchemy)

Setup:
```bash
alembic init alembic  # if not already initialized
alembic revision --autogenerate -m "description"
alembic upgrade head
alembic downgrade -1
```

Felix workflow:
1. Read `alembic.ini` and `alembic/env.py` for configuration.
2. Generate migration: `alembic revision --autogenerate -m <description>`.
3. Review the generated migration in `alembic/versions/`.
4. Apply: `alembic upgrade head`.
5. Verify: `alembic current` shows current revision.

Quirks:
- `--autogenerate` compares the model to the database — review the generated migration.
- `alembic stamp head` marks the current state as migrated without running migrations.
- `alembic history` shows the migration chain.

## Flyway (Java / SQL)

Setup:
```bash
flyway migrate
flyway info
flyway validate
flyway repair  # fix failed migrations
```

Felix workflow:
1. Read `flyway.conf` or `application.yml` for configuration.
2. Place SQL migrations in `src/main/resources/db/migration/`.
3. Naming: `V1__create_users_table.sql`, `V2__add_email_index.sql`.
4. Apply: `flyway migrate`.
5. Verify: `flyway info` shows migration status.

Quirks:
- Versioned migrations (`V`) run once, repeatable migrations (`R`) run when checksum changes.
- `flyway repair` removes failed migrations and updates the schema history table.
- Baseline: `flyway baseline` for existing databases.

## Django

Setup:
```bash
python manage.py makemigrations
python manage.py migrate
python manage.py showmigrations
python manage.py sqlmigrate APP NAME
```

Felix workflow:
1. Read `settings.py` for database configuration.
2. Generate migrations: `python manage.py makemigrations`.
3. Review generated files in `app/migrations/`.
4. Apply: `python manage.py migrate`.
5. Verify: `python manage.py showmigrations` shows applied status.

Quirks:
- `makemigrations` generates migration files, `migrate` applies them.
- `sqlmigrate` shows the SQL that would be executed.
- `squashmigrations` combines multiple migrations into one.

## General rules

- Always back up before running migrations in production.
- Review generated SQL before applying.
- Test migrations on a copy of production data when possible.
- Keep migrations small and focused — one logical change per migration.
- Never modify a migration that's already been applied to production.
