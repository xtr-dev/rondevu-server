# D1 Database Setup

This project uses Cloudflare D1 for storage instead of KV to avoid eventual consistency issues.

## Local Development

For local development, Wrangler automatically creates a local D1 database:

```bash
npx wrangler dev
```

## Production Setup

### 1. Create the D1 Database

```bash
npx wrangler d1 create rondevu-sessions
```

This will output something like:

```
✅ Successfully created DB 'rondevu-sessions'

[[d1_databases]]
binding = "DB"
database_name = "rondevu-sessions"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 2. Update wrangler.toml

Copy the `database_id` from the output and update it in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "rondevu-sessions"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # Replace with your actual ID
```

### 3. Initialize the Database Schema

```bash
npx wrangler d1 execute rondevu-sessions --remote --file=./migrations/schema.sql
```

### 4. Deploy

```bash
npx wrangler deploy
```

## Database Migrations

To run migrations on the remote database:

```bash
npx wrangler d1 execute rondevu-sessions --remote --file=./migrations/schema.sql
```

To run migrations on the local database:

```bash
npx wrangler d1 execute rondevu-sessions --local --file=./migrations/schema.sql
```

## Querying the Database

### Remote Database

```bash
# List all sessions
npx wrangler d1 execute rondevu-sessions --remote --command="SELECT * FROM sessions"

# Count sessions
npx wrangler d1 execute rondevu-sessions --remote --command="SELECT COUNT(*) FROM sessions"

# Delete expired sessions
npx wrangler d1 execute rondevu-sessions --remote --command="DELETE FROM sessions WHERE expires_at <= $(date +%s)000"
```

### Local Database

Replace `--remote` with `--local` for local queries.

## Why D1 Instead of KV?

D1 provides:
- **Strong consistency** - No race conditions from eventual consistency
- **ACID transactions** - Atomic updates prevent data corruption
- **SQL queries** - More powerful query capabilities
- **Relational data** - Better for complex queries and joins
- **No propagation delay** - Immediate read-after-write consistency

KV's eventual consistency was causing race conditions where ICE candidate updates would overwrite answers with stale data.
