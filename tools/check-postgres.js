const fs = require("fs");
const path = require("path");

loadEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL nao esta configurada.");
  process.exitCode = 1;
} else {
  checkPostgres().catch((error) => {
    console.error(`Falha ao validar PostgreSQL: ${error.message}`);
    process.exitCode = 1;
  });
}

async function checkPostgres() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString,
    ssl: postgresSslOptions(),
    application_name: "bancoflow-demo-db-check",
    max: 1,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000)
  });

  try {
    const connection = await pool.query(`
      SELECT current_database() AS database_name,
             current_user AS database_user,
             version() AS server_version
    `);
    const tables = await pool.query(`
      SELECT
        to_regclass('public.app_records') IS NOT NULL AS records_ready,
        to_regclass('public.schema_migrations') IS NOT NULL AS migrations_ready
    `);
    const recordsReady = Boolean(tables.rows[0]?.records_ready);
    const migrationsReady = Boolean(tables.rows[0]?.migrations_ready);
    const records = recordsReady
      ? await pool.query("SELECT COUNT(*)::integer AS count FROM app_records")
      : { rows: [{ count: 0 }] };
    const migration = migrationsReady
      ? await pool.query("SELECT COALESCE(MAX(version), 0)::integer AS version FROM schema_migrations")
      : { rows: [{ version: 0 }] };

    console.log(JSON.stringify({
      ok: true,
      database: connection.rows[0]?.database_name,
      user: connection.rows[0]?.database_user,
      server: String(connection.rows[0]?.server_version || "").split(",")[0],
      recordsTable: recordsReady,
      migrationsTable: migrationsReady,
      migrationVersion: migration.rows[0]?.version || 0,
      storedRecordGroups: records.rows[0]?.count || 0
    }, null, 2));
  } finally {
    await pool.end();
  }
}

function postgresSslOptions() {
  if (String(process.env.PGSSLMODE || "verify-full").toLowerCase() === "disable") return false;
  const configuredCa = String(process.env.PGSSLROOTCERT || "").trim();
  if (!configuredCa) return { rejectUnauthorized: true };
  const ca = configuredCa.includes("BEGIN CERTIFICATE")
    ? configuredCa.replace(/\\n/g, "\n")
    : fs.readFileSync(path.resolve(__dirname, "..", configuredCa), "utf8");
  return { rejectUnauthorized: true, ca };
}

function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
