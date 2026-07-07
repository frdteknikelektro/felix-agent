# Security

Credential handling and least-privilege setup.

## Credential storage

- Passwords encrypted with AES-256-GCM using `DB_ENCRYPTION_KEY`.
- Key is a 32-byte random value generated during setup.
- Stored in `.env` as `DB_ENCRYPTION_KEY=base64encodedkey`.
- Credentials decrypted only at connect time — never logged or exposed.

## Least-privilege users

Create Felix-specific database users with minimal privileges:

**PostgreSQL:**
```sql
-- Read-only user
CREATE USER felix_read WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE myapp TO felix_read;
GRANT USAGE ON SCHEMA public TO felix_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO felix_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO felix_read;

-- Read-write user
CREATE USER felix_write WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE myapp TO felix_write;
GRANT USAGE, CREATE ON SCHEMA public TO felix_write;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO felix_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO felix_write;

-- Admin user (use sparingly)
CREATE USER felix_admin WITH PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE myapp TO felix_admin;
```

**MySQL:**
```sql
-- Read-only user
CREATE USER 'felix_read'@'%' IDENTIFIED BY 'secure_password';
GRANT SELECT ON myapp.* TO 'felix_read'@'%';

-- Read-write user
CREATE USER 'felix_write'@'%' IDENTIFIED BY 'secure_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON myapp.* TO 'felix_write'@'%';

-- Admin user (use sparingly)
CREATE USER 'felix_admin'@'%' IDENTIFIED BY 'secure_password';
GRANT ALL PRIVILEGES ON myapp.* TO 'felix_admin'@'%';
```

## SSH tunnel security

- Use key-based authentication (not passwords).
- Tunnel binds to localhost only — don't expose the tunnel port.
- Use `ProxyJump` for bastion hosts instead of direct tunnel chains.

## SSL/TLS

- Require SSL for production connections.
- Verify server certificates (`sslmode=verify-full` for PostgreSQL).
- Use client certificates for mutual TLS when available.

## Connection file security

- Connection files are world-readable within the container.
- Passwords are encrypted — even if files are exposed, credentials are safe.
- Don't commit connection files to version control.
- Rotate `DB_ENCRYPTION_KEY` periodically (requires re-encrypting all connections).

## Audit

- Felix logs connection attempts and query execution.
- Check `audit` slice for database operation history.
- Monitor for unusual query patterns or access from unexpected connections.
