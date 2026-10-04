const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const REMEMBER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const sessions = new Map();
const loginAttempts = new Map();
const publicRequestLimits = new Map();

loadEnv();
const APP_NAME = process.env.APP_NAME || "BancoFlow Demo";
const DEMO_MODE = String(process.env.DEMO_MODE || "false").toLowerCase() === "true";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "Portfolio#2026";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, ".data"));
const USERS_FILE = path.join(DATA_DIR, "users.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const ACCESS_LOG_FILE = path.join(DATA_DIR, "access-log.json");
const CHANGE_LOG_FILE = path.join(DATA_DIR, "change-log.json");
const NOTIFICATIONS_FILE = path.join(DATA_DIR, "notifications.json");
const SQLITE_FILE = path.join(DATA_DIR, "bancoflow-demo.sqlite");
const BOOTSTRAP_FILE = path.join(DATA_DIR, "bootstrap-admin.txt");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PORT = Number(process.env.PORT || 4173);
const MAX_BODY_BYTES = 5_000_000;
const MAX_PUBLIC_BODY_BYTES = positiveInteger(process.env.MAX_PUBLIC_BODY_BYTES, 64_000);
const MAX_PASSWORD_BYTES = positiveInteger(process.env.MAX_PASSWORD_BYTES, 256);
const LOGIN_MAX_FAILURES = positiveInteger(process.env.LOGIN_MAX_FAILURES, 5);
const LOGIN_IP_MAX_FAILURES = positiveInteger(process.env.LOGIN_IP_MAX_FAILURES, 50);
const LOGIN_GLOBAL_MAX_FAILURES = positiveInteger(process.env.LOGIN_GLOBAL_MAX_FAILURES, 1000);
const LOGIN_BLOCK_MS = positiveInteger(process.env.LOGIN_BLOCK_MS, 10 * 60 * 1000);
const RATE_LIMIT_MAX_ENTRIES = positiveInteger(process.env.RATE_LIMIT_MAX_ENTRIES, 5000);
const REGISTER_RATE_LIMIT = positiveInteger(process.env.REGISTER_RATE_LIMIT, 5);
const REGISTER_GLOBAL_RATE_LIMIT = positiveInteger(process.env.REGISTER_GLOBAL_RATE_LIMIT, 100);
const PASSWORD_RESET_RATE_LIMIT = positiveInteger(process.env.PASSWORD_RESET_RATE_LIMIT, 5);
const PUBLIC_RATE_WINDOW_MS = positiveInteger(process.env.PUBLIC_RATE_WINDOW_MS, 60 * 60 * 1000);
const MAX_PENDING_REGISTRATIONS = positiveInteger(process.env.MAX_PENDING_REGISTRATIONS, 200);
const TRUST_PROXY = String(process.env.TRUST_PROXY || "false").toLowerCase() === "true";
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString("base64url"));
const MIN_BANK_BALANCE = -14;
const FULL_LEAVE_HOURS = 7 + 20 / 60;
const DEFAULT_CYCLE_START = "2026-05-24";
const DEFAULT_TEAM_IDS = ["alfa", "bravo", "charlie", "delta", "echo"];
const DEFAULT_TEAM_META = [
  ["alfa", "Aurora", "#00778b"],
  ["bravo", "Horizonte", "#00a3d7"],
  ["charlie", "Orbita", "#1d4f91"],
  ["delta", "Prisma", "#d49a1e"],
  ["echo", "Vertice", "#28b463"]
];
const PUBLIC_FILES = new Set([
  "index.html",
  "app.js",
  "style.css",
  "sw.js",
  "manifest.json",
  "bancoflow-mark.png"
]);
const DEFAULT_TEAM_SHIFTS = ["MANHA", "MANHA", "TARDE", "TARDE", "NOITE", "NOITE", "FOLGA", "FOLGA"];
const REQUIRE_FIREBASE = String(process.env.REQUIRE_FIREBASE || "false").toLowerCase() === "true";
const REQUIRE_POSTGRES = String(process.env.REQUIRE_POSTGRES || "false").toLowerCase() === "true";
const FIRESTORE_COLLECTION = cleanCollectionName(process.env.FIREBASE_COLLECTION || "app_records");
const FIRESTORE_CHUNK_SIZE = Number(process.env.FIREBASE_CHUNK_SIZE || 250_000);
let database = null;
let firestoreDb = null;
const firestoreCache = new Map();
const firestoreChunkCounts = new Map();
let firestoreWrites = Promise.resolve();
let firestorePendingWrites = 0;
let firestoreLastError = "";
let firestoreAccessToken = null;
let postgresPool = null;
const postgresCache = new Map();
let postgresWrites = Promise.resolve();
let postgresPendingWrites = 0;
let postgresLastError = "";
let stateMutationQueue = Promise.resolve();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      if (isStateMutationRequest(req, url)) await serializeStateMutation(() => handleApi(req, res, url));
      else await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Falha interna do servidor." });
  }
});

start().catch((error) => {
  console.error("[BANCOFLOW] Falha ao iniciar servidor:", error);
  process.exitCode = 1;
});

let cleanupTimer = null;

async function start() {
  ensureStore();
  await initDatabase();
  if (syncUsersToState(readUsers())) await flushDatabaseWrites();
  loadSessions();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[BANCOFLOW] Servidor iniciado em http://0.0.0.0:${PORT}`);
  });
  cleanupTimer = setInterval(cleanSecurityState, 1000 * 60 * 15);
  cleanupTimer.unref();
}

async function shutdown(signal) {
  console.log(`[BANCOFLOW] Encerrando com ${signal}...`);
  if (cleanupTimer) clearInterval(cleanupTimer);
  try {
    await firestoreWrites;
    await postgresWrites;
    if (postgresPool) await postgresPool.end();
  } catch (error) {
    console.error("[BANCOFLOW] Falha ao finalizar banco:", error.message);
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
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

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(USERS_FILE)) return;

  if (DEMO_MODE) {
    seedDemoStore();
    return;
  }

  const password = process.env.ADMIN_PASSWORD || createPassword();
  const admin = makeUser({
    name: process.env.ADMIN_NAME || "Administrador",
    username: process.env.ADMIN_USERNAME || "admin",
    email: process.env.ADMIN_EMAIL || "admin@bancoflow.local",
    role: "admin",
    password,
    mustChangePassword: true
  });

  fs.writeFileSync(USERS_FILE, JSON.stringify([admin], null, 2));
  if (!process.env.ADMIN_PASSWORD) {
    fs.writeFileSync(
      BOOTSTRAP_FILE,
      `Usuario: ${admin.username}\nE-mail: ${admin.email}\nSenha temporaria: ${password}\n`
    );
    console.log(`[BANCOFLOW] Admin temporario criado: ${admin.username} / ${password}`);
  }
}

function seedDemoStore() {
  const demoUsers = [
    demoUser("demo-admin", "Marina Costa", "demo", "demo@portfolio.local", "ADM-001", "admin", ""),
    demoUser("demo-ana", "Ana Ribeiro", "ana", "ana@portfolio.local", "1001", "viewer", "alfa"),
    demoUser("demo-bruno", "Bruno Lima", "bruno", "bruno@portfolio.local", "L-101", "leader", "alfa"),
    demoUser("demo-elisa", "Elisa Prado", "elisa", "elisa@portfolio.local", "2002", "assistant", "bravo"),
    demoUser("demo-lucas", "Lucas Mendes", "lucas", "lucas@portfolio.local", "L-202", "leader", "bravo"),
    demoUser("demo-carla", "Carla Nunes", "carla", "carla@portfolio.local", "SUP-01", "supervisor", ""),
    demoUser("demo-diego", "Diego Alves", "diego", "diego@portfolio.local", "COO-01", "coordinator", ""),
    demoUser("demo-fabio", "Fabio Rocha", "fabio", "fabio@portfolio.local", "ANA-01", "analyst", ""),
    demoUser("demo-gabriela", "Gabriela Souza", "gabriela", "gabriela@portfolio.local", "AJU-01", "balance_adjuster", ""),
    demoUser("demo-helena", "Helena Torres", "helena", "helena@portfolio.local", "5005", "monitoring", "echo")
  ];
  const userById = Object.fromEntries(demoUsers.map((user) => [user.id, publicUser(user)]));
  const today = new Date();
  const dateAt = (offset) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12);
    return date.toISOString().slice(0, 10);
  };
  const timestamp = (offset) => `${dateAt(offset)}T12:00:00.000Z`;
  const bankRequests = [
    {
      id: "demo-request-1", teamId: "alfa", operatorId: "demo-ana", operatorName: "Ana Ribeiro",
      requesterRole: "viewer", requestType: "partial_exit", date: dateAt(2), hours: 2.5,
      reason: "Compromisso pessoal agendado.", status: "Pendente", workflowStage: "leader_check",
      createdAt: timestamp(-1), requestedBy: userById["demo-ana"]
    },
    {
      id: "demo-request-2", teamId: "bravo", operatorId: "demo-elisa", operatorName: "Elisa Prado",
      requesterRole: "assistant", requestType: "late_entry", date: dateAt(4), hours: 1.5,
      reason: "Consulta medica.", status: "Pendente", workflowStage: "supervisor_review",
      createdAt: timestamp(-2), requestedBy: userById["demo-elisa"], leaderCheckedAt: timestamp(-1),
      leaderCheckedBy: userById["demo-lucas"]
    },
    {
      id: "demo-request-3", teamId: "gestao", operatorId: "demo-fabio", operatorName: "Fabio Rocha",
      requesterRole: "analyst", requestType: "full_leave", date: dateAt(6), hours: FULL_LEAVE_HOURS,
      reason: "Compensacao de jornada.", status: "Pendente", workflowStage: "coordinator_review",
      createdAt: timestamp(-1), requestedBy: userById["demo-fabio"]
    },
    {
      id: "demo-request-4", teamId: "alfa", operatorId: "demo-ana", operatorName: "Ana Ribeiro",
      requesterRole: "viewer", requestType: "partial_exit", date: dateAt(-7), hours: 2.5,
      reason: "Atendimento familiar.", status: "Aprovado", workflowStage: "approved",
      createdAt: timestamp(-12), requestedBy: userById["demo-ana"], leaderCheckedAt: timestamp(-11),
      leaderCheckedBy: userById["demo-bruno"], reviewedAt: timestamp(-10), reviewedBy: userById["demo-carla"],
      deductedHours: 2.5, balanceAdjustedAt: timestamp(-10)
    },
    {
      id: "demo-request-5", teamId: "alfa", operatorId: "demo-bruno", operatorName: "Bruno Lima",
      requesterRole: "leader", requestType: "late_entry", date: dateAt(-3), hours: 1,
      reason: "Ajuste de horario particular.", status: "Rejeitado", workflowStage: "rejected",
      createdAt: timestamp(-8), requestedBy: userById["demo-bruno"], reviewedAt: timestamp(-6),
      reviewedBy: userById["demo-carla"], coordinatorNote: "Data com limite operacional atingido."
    }
  ];
  const teams = DEFAULT_TEAM_META.map(([id, name, accent]) => ({
    id,
    name,
    accent,
    operators: demoUsers
      .filter((user) => user.teamId === id)
      .map((user) => ({ id: user.id, userId: user.id, registration: user.registration, name: user.name, role: roleLabel(user.role), active: true }))
  }));
  const state = {
    version: 4,
    teams,
    bankRequests,
    bankBalances: {
      "demo-admin": 12, "demo-ana": 5.75, "demo-bruno": 14, "demo-elisa": -1.5,
      "demo-lucas": 9.5, "demo-carla": 20, "demo-diego": 18, "demo-fabio": 6,
      "demo-gabriela": 8, "demo-helena": 4.25
    },
    updatedAt: new Date().toISOString(),
    updatedBy: { id: "system", name: "Dados demonstrativos", username: "system", role: "admin" }
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify(demoUsers, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log("[BANCOFLOW] Base demonstrativa criada com dados ficticios.");
}

function demoUser(id, name, username, email, registration, role, teamId) {
  const user = makeUser({ name, username, email, registration, role, teamId, password: DEMO_PASSWORD, mustChangePassword: false });
  user.id = id;
  return user;
}

async function initDatabase() {
  if (REQUIRE_FIREBASE && !firebaseConfigured()) {
    throw new Error("REQUIRE_FIREBASE esta ativo, mas as credenciais do Firebase nao foram configuradas.");
  }
  if (REQUIRE_POSTGRES && !process.env.DATABASE_URL) {
    throw new Error("REQUIRE_POSTGRES esta ativo, mas DATABASE_URL nao foi configurada.");
  }
  if (String(process.env.STORAGE_MODE || "sqlite").toLowerCase() !== "json") initSqlite();
  await initFirestore();
  await initPostgres();
  migrateLocalRecord("users", USERS_FILE);
  migrateLocalRecord("state", STATE_FILE);
  migrateLocalRecord("sessions", SESSIONS_FILE);
  migrateLocalRecord("access_logs", ACCESS_LOG_FILE);
  migrateLocalRecord("change_logs", CHANGE_LOG_FILE);
  migrateLocalRecord("notifications", NOTIFICATIONS_FILE);
  await flushDatabaseWrites();
}

function initSqlite() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    database = new DatabaseSync(SQLITE_FILE);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS app_records (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    console.log(`[BANCOFLOW] Banco SQLite ativo: ${SQLITE_FILE}`);
  } catch (error) {
    database = null;
    console.error(`[BANCOFLOW] SQLite indisponivel; usando JSON em disco: ${error.message}`);
  }
}

async function initFirestore() {
  let serviceAccount = null;
  try {
    serviceAccount = readFirebaseServiceAccount();
  } catch (error) {
    firestoreLastError = error.message;
    console.error(`[BANCOFLOW] Credencial Firebase invalida: ${error.message}`);
    if (REQUIRE_FIREBASE) throw error;
    return;
  }
  if (!serviceAccount) return;
  try {
    firestoreDb = serviceAccount;
    await loadFirestoreCache();
    console.log(`[BANCOFLOW] Firebase Firestore ativo na colecao ${FIRESTORE_COLLECTION}.`);
  } catch (error) {
    firestoreDb = null;
    firestoreAccessToken = null;
    firestoreCache.clear();
    firestoreChunkCounts.clear();
    firestoreLastError = error.message;
    console.error(`[BANCOFLOW] Firebase Firestore indisponivel; mantendo SQLite/JSON: ${error.message}`);
    if (REQUIRE_FIREBASE) throw error;
  }
}

function firebaseConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT
    || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
  );
}

function readFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const value = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    const json = value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
    const account = JSON.parse(json);
    if (account.private_key) account.private_key = String(account.private_key).replace(/\\n/g, "\n");
    return account;
  }
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) return null;
  return {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n")
  };
}

function cleanCollectionName(value) {
  const name = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return name || "app_records";
}

async function loadFirestoreCache() {
  if (!firestoreDb) return;
  firestoreCache.clear();
  firestoreChunkCounts.clear();
  const snapshot = await firestoreRequest("GET", [], null, { pageSize: 100 });
  for (const doc of asArray(snapshot?.documents)) {
    const fields = objectValue(doc.fields);
    const docId = decodeURIComponent(String(doc.name || "").split("/").pop() || "");
    let raw = "";
    const chunkCount = Number(fields.chunks?.integerValue || 0);
    if (typeof fields.raw?.stringValue === "string") raw = fields.raw.stringValue;
    else if (chunkCount > 0) raw = await readFirestoreChunks(docId);
    else continue;
    if (docId) {
      firestoreCache.set(docId, raw);
      firestoreChunkCounts.set(docId, chunkCount);
    }
  }
}

async function readFirestoreChunks(key) {
  const snapshot = await firestoreRequest("GET", [key, "chunks"], null, { pageSize: 100 });
  return asArray(snapshot?.documents)
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")))
    .map((doc) => String(objectValue(doc.fields).value?.stringValue || ""))
    .join("");
}

async function firestoreRequest(method, pathParts = [], body = null, query = {}) {
  const token = await firestoreToken();
  const url = firestoreUrl(pathParts, query);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 404 && (method === "GET" || method === "DELETE")) return null;
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const message = payload?.error?.message || text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function firestoreUrl(pathParts = [], query = {}) {
  const projectId = encodeURIComponent(firestoreDb.project_id);
  const parts = [FIRESTORE_COLLECTION, ...pathParts].map((part) => encodeURIComponent(String(part)));
  const search = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const qs = search.toString();
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${parts.join("/")}${qs ? `?${qs}` : ""}`;
}

async function firestoreToken() {
  if (firestoreAccessToken && firestoreAccessToken.expiresAt > Date.now() + 60_000) {
    return firestoreAccessToken.value;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: firestoreDb.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    },
    firestoreDb.private_key
  );
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || text || "Falha ao autenticar no Firebase.");
  }
  firestoreAccessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000
  };
  return firestoreAccessToken.value;
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
  return `${input}.${signature}`;
}

function postgresSslOptions() {
  if (String(process.env.PGSSLMODE || "verify-full").toLowerCase() === "disable") return false;
  const configuredCa = String(process.env.PGSSLROOTCERT || "").trim();
  if (!configuredCa) return { rejectUnauthorized: true };
  const ca = configuredCa.includes("BEGIN CERTIFICATE")
    ? configuredCa.replace(/\\n/g, "\n")
    : fs.readFileSync(path.resolve(ROOT, configuredCa), "utf8");
  return { rejectUnauthorized: true, ca };
}

async function initPostgres() {
  if (!process.env.DATABASE_URL) return;
  try {
    const { Pool } = require("pg");
    postgresPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: postgresSslOptions(),
      application_name: "bancoflow-demo",
      max: Number(process.env.PG_POOL_MAX || 5),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000)
    });
    postgresPool.on("error", (error) => {
      postgresLastError = error.message;
      console.error(`[BANCOFLOW] Erro inesperado no pool PostgreSQL: ${error.message}`);
    });
    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS app_records (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO schema_migrations (version)
      VALUES (1)
      ON CONFLICT (version) DO NOTHING;
    `);
    await loadPostgresCache();
    console.log("[BANCOFLOW] Banco PostgreSQL ativo via DATABASE_URL.");
  } catch (error) {
    console.error(`[BANCOFLOW] PostgreSQL indisponivel; mantendo SQLite/JSON: ${error.message}`);
    if (postgresPool) {
      try { await postgresPool.end(); } catch {}
    }
    postgresPool = null;
    postgresCache.clear();
    postgresLastError = error.message;
    if (REQUIRE_POSTGRES) throw error;
  }
}

async function loadPostgresCache() {
  if (!postgresPool) return;
  postgresCache.clear();
  const result = await postgresPool.query("SELECT key, value::text AS value FROM app_records");
  result.rows.forEach((row) => postgresCache.set(row.key, row.value));
}

function storageMode() {
  const modes = [];
  if (firestoreDb) modes.push("firestore");
  if (postgresPool) modes.push("postgres");
  if (database) modes.push("sqlite");
  return modes.length ? modes.join("+") : "json";
}

async function databaseHealth() {
  let firestore = Boolean(firestoreDb);
  if (firestoreDb) {
    try {
      await firestoreRequest("GET", [], null, { pageSize: 1 });
    } catch (error) {
      firestore = false;
      firestoreLastError = error.message;
    }
  }
  let postgres = Boolean(postgresPool);
  if (postgresPool) {
    try {
      await postgresPool.query("SELECT 1");
    } catch (error) {
      postgres = false;
      postgresLastError = error.message;
    }
  }
  return {
    ok: (!REQUIRE_FIREBASE || firestore) && (!REQUIRE_POSTGRES || postgres),
    storage: storageMode(),
    database: {
      firebaseConfigured: firebaseConfigured(),
      firebaseRequired: REQUIRE_FIREBASE,
      firestoreConnected: firestore,
      firestoreCollection: FIRESTORE_COLLECTION,
      firestorePendingWrites,
      firestoreLastError: firestoreLastError || null,
      postgresConfigured: Boolean(process.env.DATABASE_URL),
      postgresRequired: REQUIRE_POSTGRES,
      postgresConnected: postgres,
      sqliteConnected: Boolean(database),
      pendingWrites: firestorePendingWrites + postgresPendingWrites,
      lastError: firestoreLastError || postgresLastError || null
    }
  };
}

function migrateLocalRecord(key, file) {
  if (dbGetRaw(key) !== null) return;
  const local = readLocalRecord(key, file);
  if (local === null) return;
  dbSetRecord(key, local);
}

function readLocalRecord(key, file) {
  const raw = sqliteGetRaw(key);
  if (raw !== null) {
    try { return JSON.parse(raw); } catch {}
  }
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`[BANCOFLOW] Nao foi possivel ler ${file}: ${error.message}`);
    return null;
  }
}

function dbGetRaw(key) {
  if (firestoreDb) return firestoreCache.has(key) ? firestoreCache.get(key) : null;
  if (postgresPool) return postgresCache.has(key) ? postgresCache.get(key) : null;
  return sqliteGetRaw(key);
}

function sqliteGetRaw(key) {
  if (!database) return null;
  const row = database.prepare("SELECT value FROM app_records WHERE key = ?").get(key);
  return row?.value ?? null;
}

function dbGetRecord(key, fallback) {
  const raw = dbGetRaw(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[BANCOFLOW] Registro de banco invalido (${key}): ${error.message}`);
    return fallback;
  }
}

function dbSetRecord(key, value) {
  const raw = JSON.stringify(value);
  if (firestoreDb) queueFirestoreWrite(key, raw);
  if (postgresPool) queuePostgresWrite(key, raw);
  if (database) {
    database.prepare(`
      INSERT INTO app_records (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, raw, new Date().toISOString());
  }
  return Boolean(firestoreDb || postgresPool || database);
}

function queueFirestoreWrite(key, raw) {
  const db = firestoreDb;
  if (!db) return firestoreWrites;
  firestorePendingWrites += 1;
  firestoreWrites = firestoreWrites
    .then(async () => {
      try {
        const chunks = chunkString(raw, FIRESTORE_CHUNK_SIZE);
        const previousCount = firestoreChunkCounts.get(key) || 0;
        await Promise.all(chunks.map((chunk, index) =>
          firestoreRequest("PATCH", [key, "chunks", String(index).padStart(4, "0")], {
            fields: {
              index: { integerValue: String(index) },
              value: { stringValue: chunk }
            }
          })
        ));
        await Promise.all(Array.from({ length: Math.max(0, previousCount - chunks.length) }, (_, offset) =>
          firestoreRequest("DELETE", [key, "chunks", String(chunks.length + offset).padStart(4, "0")])
        ));
        await firestoreRequest("PATCH", [key], {
          fields: {
            key: { stringValue: key },
            chunks: { integerValue: String(chunks.length) },
            size: { integerValue: String(raw.length) },
            encoding: { stringValue: "json-string-chunks" },
            updatedAt: { timestampValue: new Date().toISOString() }
          }
        });
        if (firestoreDb === db) {
          firestoreCache.set(key, raw);
          firestoreChunkCounts.set(key, chunks.length);
        }
      } catch (error) {
        firestoreLastError = error.message;
        console.error(`[BANCOFLOW] Falha ao salvar ${key} no Firebase Firestore: ${error.message}`);
        if (firestoreDb === db && !REQUIRE_FIREBASE) {
          firestoreDb = null;
          firestoreAccessToken = null;
          firestoreCache.clear();
          firestoreChunkCounts.clear();
          console.error("[BANCOFLOW] Firebase Firestore desativado; SQLite/JSON permanece como armazenamento ativo.");
        }
      } finally {
        firestorePendingWrites = Math.max(0, firestorePendingWrites - 1);
      }
    });
  return firestoreWrites;
}

function chunkString(value, size) {
  const chunkSize = Math.max(50_000, Math.min(Number(size) || FIRESTORE_CHUNK_SIZE, 900_000));
  const chunks = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks.length ? chunks : [""];
}

function queuePostgresWrite(key, raw) {
  const pool = postgresPool;
  if (!pool) return postgresWrites;
  postgresPendingWrites += 1;
  postgresWrites = postgresWrites
    .then(async () => {
      try {
        await pool.query(
          `INSERT INTO app_records (key, value, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [key, raw]
        );
        if (postgresPool === pool) postgresCache.set(key, raw);
      } catch (error) {
        postgresLastError = error.message;
        console.error(`[BANCOFLOW] Falha ao salvar ${key} no PostgreSQL: ${error.message}`);
        if (postgresPool === pool && !REQUIRE_POSTGRES) {
          postgresPool = null;
          postgresCache.clear();
          pool.end().catch(() => {});
          console.error("[BANCOFLOW] PostgreSQL desativado; SQLite/JSON permanece como armazenamento ativo.");
        }
      } finally {
        postgresPendingWrites = Math.max(0, postgresPendingWrites - 1);
      }
    });
  return postgresWrites;
}

async function flushDatabaseWrites() {
  await firestoreWrites;
  await postgresWrites;
  if (REQUIRE_FIREBASE && firestoreLastError) {
    const detail = firestoreLastError;
    firestoreLastError = "";
    const error = new Error(`Falha ao confirmar gravacao no Firebase Firestore: ${detail}`);
    error.statusCode = 503;
    throw error;
  }
  if (REQUIRE_POSTGRES && postgresLastError) {
    const detail = postgresLastError;
    postgresLastError = "";
    const error = new Error(`Falha ao confirmar gravacao no PostgreSQL: ${detail}`);
    error.statusCode = 503;
    throw error;
  }
}

async function handleApi(req, res, url) {
  setSecurityHeaders(res);

  if (req.method === "GET" && url.pathname === "/api/health") {
    const health = await databaseHealth();
    sendJson(res, health.ok ? 200 : 503, { ok: health.ok, name: APP_NAME });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req, MAX_PUBLIC_BODY_BYTES);
    const identifier = String(body.identifier || body.user || "").trim().toLowerCase();
    const password = String(body.password || "");
    const users = readUsers();
    const user = users.find((item) =>
      [item.username, item.email].filter(Boolean).map((v) => String(v).toLowerCase()).includes(identifier)
    );
    const attemptKeys = loginAttemptKeys(req, user, identifier);
    const blockedUntil = blockedLoginUntil(attemptKeys);
    if (blockedUntil > Date.now()) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))));
      sendJson(res, 429, { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
      return;
    }
    const penaltyMs = loginPenaltyMs(attemptKeys);
    if (penaltyMs) await delay(penaltyMs);

    const passwordWithinLimit = Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
    const passwordMatches = passwordWithinLimit
      ? await verifyPasswordAsync(password, user?.password || DUMMY_PASSWORD_HASH)
      : false;
    if (!user || !passwordMatches) {
      recordFailedLogin(attemptKeys);
      sendJson(res, 401, { error: "Usuario ou senha invalidos." });
      return;
    }

    if (user.active === false) {
      sendJson(res, 403, { error: user.pendingApproval ? "Cadastro aguardando aprovacao do administrador." : "Usuario bloqueado. Fale com o administrador." });
      return;
    }

    loginAttempts.delete(`account:${user.id}`);
    user.lastLoginAt = new Date().toISOString();
    writeUsers(users);
    appendAccessLog(req, user, "login");
    const session = createSession(user.id, body.remember !== false, user.authVersion);
    await flushDatabaseWrites();
    res.setHeader("Set-Cookie", sessionCookie(req, session.token, session.maxAgeSeconds));
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    if (!consumePublicRateLimit(req, res, "register", REGISTER_RATE_LIMIT, REGISTER_GLOBAL_RATE_LIMIT)) return;
    const body = await readJson(req, MAX_PUBLIC_BODY_BYTES);
    let users = readUsers();
    if (pendingRegistrationCount(users) >= MAX_PENDING_REGISTRATIONS) {
      sendJson(res, 503, { error: "Limite de cadastros pendentes atingido. Aguarde a analise do administrador." });
      return;
    }
    normalizeSelfRegistration(body, users);
    const passwordHash = await hashPasswordAsync(String(body.password || ""));
    users = readUsers();
    if (pendingRegistrationCount(users) >= MAX_PENDING_REGISTRATIONS) {
      sendJson(res, 503, { error: "Limite de cadastros pendentes atingido. Aguarde a analise do administrador." });
      return;
    }
    const incoming = normalizeSelfRegistration(body, users);
    const user = makeUserWithPasswordHash({
      ...incoming,
      active: false,
      mustChangePassword: false,
      pendingApproval: true
    }, passwordHash);
    users.push(user);
    writeUsers(users);
    syncUsersToState(users);
    appendAccessLog(req, user, "register");
    appendChangeLog(req, user, {
      action: "Novo cadastro",
      detail: `${user.name} criou acesso como ${roleLabel(user.role)} na equipe ${teamLabel(user.teamId)}`,
      targetUser: publicUser(user)
    });
    await flushDatabaseWrites();
    sendJson(res, 201, { user: publicUser(user), pendingApproval: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/password-reset") {
    if (!consumePublicRateLimit(req, res, "password-reset", PASSWORD_RESET_RATE_LIMIT, REGISTER_GLOBAL_RATE_LIMIT)) return;
    const body = await readJson(req, MAX_PUBLIC_BODY_BYTES);
    const identifier = String(body.identifier || body.user || body.email || "").trim().toLowerCase();
    const note = cleanText(body.note, 500);
    if (!identifier) throwApi("Informe usuario ou e-mail.");
    const user = readUsers().find((item) =>
      [item.username, item.email].filter(Boolean).map((value) => String(value).toLowerCase()).includes(identifier)
    );
    appendChangeLog(req, user || { id: "public", name: "Visitante", username: identifier, role: "public" }, {
      action: "Solicitacao de senha",
      detail: user
        ? `${user.name} pediu redefinicao de senha${note ? `: ${note}` : ""}`
        : `Pedido de redefinicao para usuario/e-mail nao localizado: ${identifier}${note ? `: ${note}` : ""}`,
      targetUser: user ? publicUser(user) : { username: identifier, name: "Nao localizado", role: "public" }
    });
    await flushDatabaseWrites();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = getCookie(req, "bancoflow_session");
    const user = token ? getCurrentUser(req) : null;
    if (user) appendAccessLog(req, user, "logout");
    if (token) {
      sessions.delete(token);
      writeSessions();
    }
    await flushDatabaseWrites();
    res.setHeader("Set-Cookie", clearSessionCookie(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  const currentUser = getCurrentUser(req);

  if (req.method === "GET" && url.pathname === "/api/session") {
    if (!currentUser) {
      sendJson(res, 401, { error: "Sessao expirada ou inexistente." });
      return;
    }
    sendJson(res, 200, { user: publicUser(currentUser) });
    return;
  }

  if (!currentUser) {
    sendJson(res, 401, { error: "Faca login para continuar." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health/details") {
    if (!isAdmin(currentUser)) return forbidden(res);
    const health = await databaseHealth();
    sendJson(res, health.ok ? 200 : 503, { ...health, name: APP_NAME });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/profile") {
    const body = await readJson(req);
    const users = readUsers();
    const user = users.find((item) => item.id === currentUser.id);
    if (!user) return sendJson(res, 404, { error: "Usuario nao encontrado." });
    user.profilePhoto = normalizeProfilePhoto(body.profilePhoto);
    user.updatedAt = new Date().toISOString();
    writeUsers(users);
    syncUsersToState(users);
    await flushDatabaseWrites();
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const notifications = readNotifications()
      .filter((item) => item.userId === currentUser.id)
      .slice(0, 80);
    sendJson(res, 200, { notifications });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/notifications/read") {
    const body = await readJson(req);
    const requestedIds = new Set(asArray(body.ids).map((id) => cleanText(id, 80)));
    const now = new Date().toISOString();
    const notifications = readNotifications().map((item) => {
      if (item.userId !== currentUser.id || item.readAt || (!body.all && !requestedIds.has(item.id))) return item;
      return { ...item, readAt: now };
    });
    writeNotifications(notifications);
    await flushDatabaseWrites();
    sendJson(res, 200, { notifications: notifications.filter((item) => item.userId === currentUser.id).slice(0, 80) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, { state: filterStateForUser(readState(), currentUser, readUsers()) });
    return;
  }

  if ((req.method === "POST" || req.method === "PUT") && url.pathname === "/api/state") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: "O estado completo e somente leitura. Use as rotas especificas do banco de horas." });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bank-requests") {
    const body = await readJson(req);
    const state = ensureStateObject(readState());
    const requesterRole = normalizeRole(currentUser.role);
    if (!isBankRequesterRole(requesterRole)) {
      sendJson(res, 403, { error: "Seu perfil nao possui fluxo de solicitacao." });
      return;
    }
    const requestType = normalizeBankRequestType(body.requestType);
    const hours = requestType === "full_leave" ? normalizeHours(FULL_LEAVE_HOURS) : normalizeHours(body.hours);
    const date = normalizeDate(body.date);
    const teamId = ["viewer", "monitoring", "leader", "assistant"].includes(requesterRole) ? userTeamId(currentUser) : "gestao";
    const activeRequestsForDate = asArray(state.bankRequests).filter((item) =>
      normalizeDate(item?.date) === date && normalizeBankStatus(item?.status) !== "Rejeitado"
    );
    if (!requestType) throwApi("Informe o tipo da solicitacao.");
    if (!hours) throwApi("Informe uma quantidade de horas maior que zero.");
    if (!date) throwApi("Informe uma data valida para o banco.");
    if (activeRequestsForDate.length >= 3) {
      sendJson(res, 409, { error: "Esta data ja atingiu o limite de 3 solicitacoes." });
      return;
    }
    if (activeRequestsForDate.some((item) => cleanText(item?.operatorId, 80) === currentUser.id)) {
      sendJson(res, 409, { error: "Voce ja possui uma solicitacao ativa para esta data." });
      return;
    }
    const availableHours = bankBalanceFor(state, currentUser.id);
    if (availableHours - hours < MIN_BANK_BALANCE) {
      sendJson(res, 409, { error: `A solicitacao ultrapassa o limite de -14:00. Saldo atual: ${formatHours(availableHours)}.` });
      return;
    }
    const routeTarget = isSemiTurnTeam(teamId) ? resolveSemiTurnBankTarget(state, date) : null;
    const request = normalizeBankRequest({
      id: crypto.randomUUID(),
      teamId,
      reviewTeamId: routeTarget?.team?.id || body.reviewTeamId,
      reviewTeamName: routeTarget?.team?.name || body.reviewTeamName,
      reviewLeaderName: routeTarget?.leader?.name || body.reviewLeaderName,
      operatorId: currentUser.id,
      operatorName: currentUser.name || currentUser.username,
      requesterRole,
      requestType,
      workflowStage: initialBankWorkflowStage(requesterRole),
      date,
      hours,
      reason: body.reason,
      status: "Pendente",
      createdAt: new Date().toISOString(),
      requestedBy: publicUser(currentUser)
    });
    if (!request.teamId || !request.operatorName || !request.date) throwApi("Nao foi possivel identificar o solicitante e a data.");
    if (isSemiTurnTeam(request.teamId) && !request.reviewTeamId) throwApi("A equipe Vertice esta de folga nesta data. Escolha um dia de segunda a sabado.");
    state.bankRequests = [request, ...asArray(state.bankRequests)];
    state.updatedAt = new Date().toISOString();
    state.updatedBy = publicUser(currentUser);
    writeState(normalizeAppState(state, currentUser));
    appendChangeLog(req, currentUser, {
      action: "Solicitacao de banco",
      detail: `${request.operatorName} solicitou banco em ${request.date}${request.reviewTeamId ? ` para ${teamLabel(request.reviewTeamId)}` : ""}`,
      teamId: request.reviewTeamId || request.teamId,
      operatorId: request.operatorId,
      operatorName: request.operatorName
    });
    await flushDatabaseWrites();
    sendJson(res, 201, { request });
    return;
  }

  const bankMatch = url.pathname.match(/^\/api\/bank-requests\/([^/]+)$/);
  if (bankMatch && req.method === "DELETE") {
    if (currentUser.role !== "admin") {
      sendJson(res, 403, { error: "Apenas o administrador pode excluir solicitacoes." });
      return;
    }
    const state = ensureStateObject(readState());
    const id = decodeURIComponent(bankMatch[1]);
    const requests = asArray(state.bankRequests);
    const requestIndex = requests.findIndex((item) => item && item.id === id);
    const request = requestIndex >= 0 ? normalizeBankRequest(requests[requestIndex]) : null;
    if (!request) return sendJson(res, 404, { error: "Solicitacao nao encontrada." });

    let restoredHours = 0;
    state.bankBalances = normalizeBankBalances(state.bankBalances);
    if (normalizeBankStatus(request.status) === "Aprovado") {
      restoredHours = normalizeHours(request.deductedHours || request.hours);
      if (restoredHours) {
        state.bankBalances[request.operatorId] = normalizeBalanceHours(bankBalanceFor(state, request.operatorId) + restoredHours);
      }
    }

    requests.splice(requestIndex, 1);
    state.bankRequests = requests.map(normalizeBankRequest);
    state.updatedAt = new Date().toISOString();
    state.updatedBy = publicUser(currentUser);
    writeState(normalizeAppState(state, currentUser));
    addNotification({
      userId: request.operatorId,
      requestId: request.id,
      title: "Solicitacao removida",
      message: `A solicitacao de ${formatDateForNotification(request.date)} foi excluida pelo administrador.`,
      type: "rejected"
    });
    appendChangeLog(req, currentUser, {
      action: "Exclusao de solicitacao",
      detail: `${request.operatorName}: solicitacao de ${request.date} excluida${restoredHours ? ` e ${formatHours(restoredHours)} devolvidas ao saldo` : ""}`,
      teamId: request.reviewTeamId || request.teamId,
      operatorId: request.operatorId,
      operatorName: request.operatorName
    });
    await flushDatabaseWrites();
    sendJson(res, 200, { ok: true, restoredHours });
    return;
  }

  if (bankMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const state = ensureStateObject(readState());
    const id = decodeURIComponent(bankMatch[1]);
    const requests = asArray(state.bankRequests);
    const requestIndex = requests.findIndex((item) => item && item.id === id);
    const request = requestIndex >= 0 ? normalizeBankRequest(requests[requestIndex]) : null;
    if (!request) return sendJson(res, 404, { error: "Solicitacao nao encontrada." });
    requests[requestIndex] = request;
    if (!canAccessBankRequest(currentUser, request)) {
      sendJson(res, 403, { error: "Voce nao pode acessar banco desta equipe." });
      return;
    }
    const wantsStatus = body.status !== undefined;
    const wantsNote = body.coordinatorNote !== undefined || body.note !== undefined;
    const wantsAcknowledgement = body.action === "acknowledge" || body.leaderChecked === true;
    if (wantsAcknowledgement) {
      if (!canAcknowledgeBank(currentUser, request)) {
        sendJson(res, 403, { error: "Apenas o lider responsavel pode dar o check nesta solicitacao." });
        return;
      }
      if (normalizeBankStatus(request.status) !== "Pendente") {
        sendJson(res, 409, { error: "Esta solicitacao ja foi finalizada." });
        return;
      }
      request.leaderCheckedAt = new Date().toISOString();
      request.leaderCheckedBy = publicUser(currentUser);
      request.workflowStage = "supervisor_review";
      addNotification({
        userId: request.operatorId,
        requestId: request.id,
        title: "Solicitacao visualizada",
        message: "O lider confirmou o recebimento. Agora a solicitacao aguarda o supervisor.",
        type: "info"
      });
    }
    if (wantsStatus) {
      if (!canFinalizeBankRequest(currentUser, request)) {
        sendJson(res, 403, { error: bankWorkflowPermissionMessage(request) });
        return;
      }
      const previousStatus = normalizeBankStatus(request.status);
      const nextStatus = normalizeBankStatus(body.status);
      state.bankBalances = normalizeBankBalances(state.bankBalances);
      if (previousStatus !== "Aprovado" && nextStatus === "Aprovado") {
        const hours = normalizeHours(request.hours);
        const availableHours = bankBalanceFor(state, request.operatorId);
        if (availableHours - hours < MIN_BANK_BALANCE) {
          sendJson(res, 409, { error: `A aprovacao ultrapassa o limite de -14:00. Saldo atual: ${formatHours(availableHours)}.` });
          return;
        }
        if (hours) {
          state.bankBalances[request.operatorId] = normalizeBalanceHours(availableHours - hours);
          request.deductedHours = hours;
          request.balanceAdjustedAt = new Date().toISOString();
        }
      }
      if (previousStatus === "Aprovado" && nextStatus !== "Aprovado") {
        const restoredHours = normalizeHours(request.deductedHours || request.hours);
        if (restoredHours) state.bankBalances[request.operatorId] = normalizeBalanceHours(bankBalanceFor(state, request.operatorId) + restoredHours);
        request.deductedHours = 0;
        request.balanceAdjustedAt = new Date().toISOString();
      }
      request.status = nextStatus;
      request.workflowStage = nextStatus === "Aprovado" ? "approved" : nextStatus === "Rejeitado" ? "rejected" : request.workflowStage;
      request.reviewedAt = new Date().toISOString();
      request.reviewedBy = publicUser(currentUser);
      if (previousStatus !== nextStatus) {
        addNotification({
          userId: request.operatorId,
          requestId: request.id,
          title: nextStatus === "Aprovado" ? "Solicitacao aprovada" : "Solicitacao rejeitada",
          message: `${requestTypeLabelServer(request.requestType)} de ${formatHours(request.hours)} para ${formatDateForNotification(request.date)}: ${nextStatus.toLowerCase()}.`,
          type: nextStatus === "Aprovado" ? "approved" : "rejected"
        });
      }
    }
    if (wantsNote) {
      if (!(currentUser.role === "admin" || currentUser.role === "coordinator" || currentUser.role === "leader")) {
        sendJson(res, 403, { error: "Voce nao pode adicionar observacao." });
        return;
      }
      request.coordinatorNote = cleanText(body.coordinatorNote ?? body.note, 700);
      request.notedAt = new Date().toISOString();
      request.notedBy = publicUser(currentUser);
      addNotification({
        userId: request.operatorId,
        requestId: request.id,
        title: "Nova observacao",
        message: request.coordinatorNote || "Uma observacao foi registrada na sua solicitacao.",
        type: "info"
      });
    }
    state.bankRequests = requests.map(normalizeBankRequest);
    state.updatedAt = new Date().toISOString();
    state.updatedBy = publicUser(currentUser);
    writeState(normalizeAppState(state, currentUser));
    appendChangeLog(req, currentUser, {
      action: wantsAcknowledgement ? "Check do lider" : wantsStatus ? "Revisao de banco" : "Observacao de banco",
      detail: wantsAcknowledgement ? `${request.operatorName}: solicitacao visualizada pelo lider` : wantsStatus ? `${request.operatorName}: solicitacao ${request.status.toLowerCase()}` : `${request.operatorName}: observacao registrada`,
      teamId: request.reviewTeamId || request.teamId,
      operatorId: request.operatorId,
      operatorName: request.operatorName
    });
    await flushDatabaseWrites();
    sendJson(res, 200, { request: normalizeBankRequest(request) });
    return;
  }

  const balanceMatch = url.pathname.match(/^\/api\/bank-balances\/([^/]+)$/);
  if (balanceMatch && req.method === "PATCH") {
    if (!canManageBankBalances(currentUser)) {
      sendJson(res, 403, { error: "Seu perfil nao pode alterar saldos de horas." });
      return;
    }
    const body = await readJson(req);
    const state = ensureStateObject(readState());
    const operatorId = decodeURIComponent(balanceMatch[1]);
    const person = readUsers().find((user) => user.id === operatorId && user.active !== false && !user.pendingApproval && isBankRequesterRole(user.role));
    if (!person) return sendJson(res, 404, { error: "Usuario nao encontrado." });
    if (currentUser.role === "leader" && (!userTeamId(currentUser) || userTeamId(currentUser) !== userTeamId(person))) {
      sendJson(res, 403, { error: "O lider so pode alterar o saldo de pessoas da propria equipe." });
      return;
    }
    const parsedHours = parseHourValue(body.hours);
    if (!Number.isFinite(parsedHours) || parsedHours < MIN_BANK_BALANCE || parsedHours > 100_000) {
      sendJson(res, 400, { error: "Informe um saldo valido, respeitando o limite minimo de -14:00." });
      return;
    }
    const hours = roundHours(parsedHours);
    state.bankBalances = normalizeBankBalances(state.bankBalances);
    const previous = bankBalanceFor(state, operatorId);
    state.bankBalances[operatorId] = hours;
    state.updatedAt = new Date().toISOString();
    state.updatedBy = publicUser(currentUser);
    writeState(normalizeAppState(state, currentUser));
    appendChangeLog(req, currentUser, {
      action: "Saldo de banco atualizado",
      detail: `${person.name}: ${formatHours(previous)} para ${formatHours(hours)}`,
      teamId: person.teamId || "gestao",
      operatorId,
      operatorName: person.name
    });
    await flushDatabaseWrites();
    sendJson(res, 200, { operatorId, hours });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/access-logs") {
    if (!isAdmin(currentUser)) return forbidden(res);
    sendJson(res, 200, { logs: readAccessLogs().slice(0, 250) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/change-logs") {
    if (!canViewChangeLogs(currentUser)) return forbidden(res);
    const logs = readChangeLogs();
    const scopedLogs = canViewAllChangeLogs(currentUser)
      ? logs
      : logs.filter((log) => cleanText(log.teamId, 40).toLowerCase() === userTeamId(currentUser));
    sendJson(res, 200, { logs: scopedLogs.slice(0, 500) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/change-password") {
    const body = await readJson(req);
    const currentPassword = String(body.currentPassword || "");
    const nextPassword = String(body.newPassword || "");
    if (!verifyPassword(currentPassword, currentUser.password)) {
      sendJson(res, 400, { error: "Senha atual incorreta." });
      return;
    }
    try { validatePassword(nextPassword); } catch (error) { return sendJson(res, 400, { error: error.message }); }
    const users = readUsers();
    const user = users.find((item) => item.id === currentUser.id);
    user.password = hashPassword(nextPassword);
    user.authVersion = normalizedAuthVersion(user.authVersion) + 1;
    user.mustChangePassword = false;
    user.updatedAt = new Date().toISOString();
    writeUsers(users);
    const previousToken = getCookie(req, "bancoflow_session");
    const remember = sessions.get(previousToken)?.remember !== false;
    revokeUserSessions(user.id);
    const replacementSession = createSession(user.id, remember, user.authVersion);
    await flushDatabaseWrites();
    res.setHeader("Set-Cookie", sessionCookie(req, replacementSession.token, replacementSession.maxAgeSeconds));
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (url.pathname === "/api/users" && req.method === "GET") {
    if (!isAdmin(currentUser)) return forbidden(res);
    sendJson(res, 200, { users: readUsers().map(publicUser) });
    return;
  }

  if (url.pathname === "/api/users" && req.method === "POST") {
    if (!isAdmin(currentUser)) return forbidden(res);
    const body = await readJson(req);
    const users = readUsers();
    const user = normalizeIncomingUser(body, users);
    const createdUser = makeUser(user);
    users.push(createdUser);
    writeUsers(users);
    syncUsersToState(users);
    appendChangeLog(req, currentUser, {
      action: "Usuario criado",
      detail: `${user.name} criado como ${normalizeRole(user.role)}`,
      targetUser: publicUser(createdUser)
    });
    await flushDatabaseWrites();
    sendJson(res, 201, { user: publicUser(createdUser) });
    return;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === "PATCH") {
    if (!isAdmin(currentUser)) return forbidden(res);
    const id = decodeURIComponent(userMatch[1]);
    const body = await readJson(req);
    const users = readUsers();
    const user = users.find((item) => item.id === id);
    if (!user) return sendJson(res, 404, { error: "Usuario nao encontrado." });
    const currentToken = getCookie(req, "bancoflow_session");
    const currentSessionRemember = sessions.get(currentToken)?.remember !== false;
    const before = publicUser(user);
    updateUserRecord(user, body, users);
    const passwordChanged = body.password !== undefined && Boolean(String(body.password).trim());
    const userDisabled = body.active !== undefined && !Boolean(body.active);
    writeUsers(users);
    syncUsersToState(users);
    if (passwordChanged || userDisabled) {
      revokeUserSessions(user.id);
      if (user.id === currentUser.id && !userDisabled) {
        const replacementSession = createSession(user.id, currentSessionRemember, user.authVersion);
        res.setHeader("Set-Cookie", sessionCookie(req, replacementSession.token, replacementSession.maxAgeSeconds));
      }
    }
    appendChangeLog(req, currentUser, {
      action: "Usuario alterado",
      detail: describeUserPatch(before, publicUser(user), body),
      targetUser: publicUser(user)
    });
    await flushDatabaseWrites();
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (userMatch && req.method === "DELETE") {
    if (!isAdmin(currentUser)) return forbidden(res);
    const id = decodeURIComponent(userMatch[1]);
    if (id === currentUser.id) return sendJson(res, 400, { error: "Voce nao pode excluir seu proprio usuario." });
    const users = readUsers();
    const removed = users.find((item) => item.id === id);
    const next = users.filter((item) => item.id !== id);
    if (next.length === users.length) return sendJson(res, 404, { error: "Usuario nao encontrado." });
    writeUsers(next);
    revokeUserSessions(id);
    syncUsersToState(next, [removed]);
    appendChangeLog(req, currentUser, {
      action: "Usuario excluido",
      detail: `${removed?.name || removed?.username || id} excluido`,
      targetUser: removed ? publicUser(removed) : { id }
    });
    await flushDatabaseWrites();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Rota nao encontrada." });
}

function validatePassword(password) {
  if (password.length < 6) throwApi("A senha precisa ter no minimo 6 caracteres.");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throwApi(`A senha deve ter no maximo ${MAX_PASSWORD_BYTES} bytes.`);
  }
}

function normalizeIncomingUser(body, users) {
  const name = String(body.name || "").trim();
  const username = String(body.username || "").trim().toLowerCase();
  const email = String(body.email || "").trim().toLowerCase();
  const role = normalizeRole(body.role);
  const teamId = normalizeUserTeamId(body.teamId || body.team, role);
  const registration = readUserRegistration(body);
  const password = String(body.password || "");

  if (!name || !username || !email) throwApi("Informe nome, usuario e e-mail.");
  if (requiresFixedTeam(role) && !teamId) throwApi("Informe a equipe fixa para este perfil.");
  validateRegistrationForRole(registration, role);
  if (registrationInUse(users, registration)) throwApi("Ja existe usuario com esta matricula.");
  validatePassword(password);
  if (users.some((item) => item.username === username || item.email === email)) {
    throwApi("Ja existe usuario com esse login ou e-mail.");
  }
  return { name, username, email, registration, role, teamId, password, active: true };
}

function normalizeSelfRegistration(body, users) {
  const name = cleanText(body.name, 120).trim();
  const username = cleanText(body.username, 80).trim().toLowerCase();
  const email = cleanText(body.email, 160).trim().toLowerCase();
  const role = normalizeSelfRole(body.role || body.requestedRole);
  const teamId = normalizeUserTeamId(body.teamId || body.team, role);
  const registration = readUserRegistration(body);
  const password = String(body.password || "");
  if (!name || !username || !email) throwApi("Informe nome, usuario e e-mail.");
  if (requiresFixedTeam(role) && !teamId) throwApi("Escolha a equipe fixa.");
  validateRegistrationForRole(registration, role);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throwApi("Usuario deve ter 3 a 40 caracteres, usando letras, numeros, ponto, traco ou underline.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throwApi("Informe um e-mail valido.");
  validatePassword(password);
  if (registrationInUse(users, registration)) throwApi("Ja existe usuario com esta matricula.");
  if (users.some((item) => String(item.username).toLowerCase() === username || String(item.email).toLowerCase() === email)) {
    throwApi("Ja existe usuario com esse login ou e-mail.");
  }
  return { name, username, email, registration, role, teamId, password };
}

function updateUserRecord(user, body, users) {
  if (body.name !== undefined) user.name = String(body.name || "").trim() || user.name;
  if (body.username !== undefined) {
    const username = String(body.username || "").trim().toLowerCase();
    if (!username) throwApi("Usuario nao pode ficar vazio.");
    if (users.some((item) => item.id !== user.id && item.username === username)) throwApi("Usuario ja esta em uso.");
    user.username = username;
  }
  if (body.email !== undefined) {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) throwApi("E-mail nao pode ficar vazio.");
    if (users.some((item) => item.id !== user.id && item.email === email)) throwApi("E-mail ja esta em uso.");
    user.email = email;
  }
  if (body.role !== undefined) {
    const nextRole = normalizeRole(body.role);
    if (normalizeRole(user.role) === "admin" && nextRole !== "admin") {
      throwApi("O perfil de administrador e protegido e nao pode ser alterado.");
    }
    user.role = nextRole;
  }
  if (body.registration !== undefined || body.matricula !== undefined || body.employeeId !== undefined) {
    const registration = readUserRegistration(body);
    if (registrationInUse(users, registration, user.id)) throwApi("Ja existe usuario com esta matricula.");
    user.registration = registration;
  }
  if (body.teamId !== undefined || body.team !== undefined) {
    user.teamId = normalizeUserTeamId(body.teamId || body.team, user.role);
  }
  if (body.role !== undefined && requiresFixedTeam(user.role) && !user.teamId) {
    user.teamId = normalizeUserTeamId(body.teamId || body.team || user.teamId, user.role);
    if (!user.teamId) throwApi("Informe a equipe fixa para este perfil.");
  }
  if (body.role !== undefined && !requiresFixedTeam(user.role)) user.teamId = "";
  if (body.active !== undefined) {
    user.active = Boolean(body.active);
    user.pendingApproval = false;
  }
  if (body.pendingApproval !== undefined) user.pendingApproval = Boolean(body.pendingApproval);
  if (body.password !== undefined && String(body.password).trim()) {
    const password = String(body.password);
    validatePassword(password);
    user.password = hashPassword(password);
    user.authVersion = normalizedAuthVersion(user.authVersion) + 1;
    user.mustChangePassword = true;
  }
  validateRegistrationForRole(user.registration, user.role);
  user.updatedAt = new Date().toISOString();
}

function readUserRegistration(body) {
  return cleanText(body.registration ?? body.matricula ?? body.employeeId, 40).trim();
}

function validateRegistrationForRole(registration, role) {
  if (["viewer", "monitoring"].includes(normalizeRole(role)) && !registration) {
    throwApi("Informe a matricula para este perfil.");
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isStateMutationRequest(req, url) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return false;
  return url.pathname === "/api/register"
    || url.pathname === "/api/profile"
    || url.pathname === "/api/state"
    || url.pathname === "/api/change-password"
    || url.pathname === "/api/users"
    || /^\/api\/users\/[^/]+$/.test(url.pathname)
    || url.pathname === "/api/bank-requests"
    || /^\/api\/bank-requests\/[^/]+$/.test(url.pathname)
    || /^\/api\/bank-balances\/[^/]+$/.test(url.pathname);
}

async function serializeStateMutation(callback) {
  const previous = stateMutationQueue;
  let release;
  stateMutationQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function registrationInUse(users, registration, exceptUserId = "") {
  const value = cleanText(registration, 40).toLowerCase();
  if (!value) return false;
  return asArray(users).some((item) => item.id !== exceptUserId && cleanText(item.registration || item.matricula, 40).toLowerCase() === value);
}

function throwApi(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let receivedBytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > maxBytes) {
        tooLarge = true;
        raw = "";
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Payload muito grande."), { statusCode: 413 }));
        return;
      }
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("JSON invalido."), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  }).catch((error) => {
    if (error.statusCode) throw error;
    throwApi(error.message);
  });
}

function makeUser(input) {
  return makeUserWithPasswordHash(input, hashPassword(input.password));
}

function makeUserWithPasswordHash({ name, username, email, registration = "", role, teamId = "", active = true, mustChangePassword = false, pendingApproval = false, profilePhoto = "" }, passwordHash) {
  const now = new Date().toISOString();
  const normalizedRole = normalizeRole(role);
  return {
    id: crypto.randomUUID(),
    name,
    username,
    email,
    registration: cleanText(registration, 40),
    role: normalizedRole,
    teamId: normalizeUserTeamId(teamId, normalizedRole),
    active,
    pendingApproval,
    profilePhoto: normalizeProfilePhoto(profilePhoto),
    mustChangePassword,
    authVersion: 1,
    password: passwordHash,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null
  };
}

function readUsers() {
  ensureStore();
  const stored = dbGetRecord("users", null);
  if (Array.isArray(stored)) return stored;
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function writeUsers(users) {
  dbSetRecord("users", users);
  writeJsonAtomic(USERS_FILE, users);
  writeDailyBackup("users", users);
}

function readState() {
  ensureStore();
  const stored = dbGetRecord("state", null);
  if (stored) return stored;
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (error) {
    console.error("[BANCOFLOW] Estado salvo invalido:", error.message);
    return null;
  }
}

function writeState(state) {
  dbSetRecord("state", state);
  writeJsonAtomic(STATE_FILE, state);
  writeDailyBackup("state", state);
}

function readNotifications() {
  ensureStore();
  const stored = dbGetRecord("notifications", null);
  if (Array.isArray(stored)) return normalizeNotifications(stored);
  if (!fs.existsSync(NOTIFICATIONS_FILE)) return [];
  try {
    return normalizeNotifications(JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, "utf8")));
  } catch {
    return [];
  }
}

function writeNotifications(notifications) {
  const next = normalizeNotifications(notifications).slice(0, 5000);
  dbSetRecord("notifications", next);
  writeJsonAtomic(NOTIFICATIONS_FILE, next);
  writeDailyBackup("notifications", next);
}

function addNotification(notification) {
  if (!notification?.userId) return;
  const next = [{
    id: crypto.randomUUID(),
    userId: cleanText(notification.userId, 80),
    requestId: cleanText(notification.requestId, 80),
    title: cleanText(notification.title, 100),
    message: cleanText(notification.message, 400),
    type: ["approved", "rejected", "info"].includes(notification.type) ? notification.type : "info",
    createdAt: new Date().toISOString(),
    readAt: ""
  }, ...readNotifications()];
  writeNotifications(next);
}

function syncUsersToState(users, removedUsers = []) {
  const source = readState();
  if (!source) return false;
  const state = ensureStateObject(source);
  const previousTeams = normalizeTeams(state.teams);
  const activeUsers = asArray(users).filter((user) => user.active !== false && !user.pendingApproval);
  const nextTeams = DEFAULT_TEAM_META.map(([id, name, accent]) => {
    const previous = previousTeams.find((team) => team.id === id);
    const operators = activeUsers
      .filter((user) => requiresFixedTeam(user.role) && normalizeUserTeamId(user.teamId, user.role) === id)
      .map((user) => ({
        id: user.id,
        userId: user.id,
        registration: cleanText(user.registration || user.matricula, 40),
        name: cleanText(user.name, 120),
        role: roleLabel(user.role),
        active: true
      }));
    return { id, name: previous?.name || name, accent: previous?.accent || accent, operators };
  });
  let changed = JSON.stringify(previousTeams) !== JSON.stringify(nextTeams);
  state.bankBalances = normalizeBankBalances(state.bankBalances);

  for (const user of activeUsers) {
    const previousOperator = previousTeams.flatMap((team) => asArray(team.operators)).find((operator) =>
      operator.userId === user.id
      || (user.registration && cleanText(operator.registration, 40).toLowerCase() === cleanText(user.registration, 40).toLowerCase())
      || cleanText(operator.name, 120).toLowerCase() === cleanText(user.name, 120).toLowerCase()
    );
    if (previousOperator && state.bankBalances[user.id] === undefined && state.bankBalances[previousOperator.id] !== undefined) {
      state.bankBalances[user.id] = state.bankBalances[previousOperator.id];
      changed = true;
    }
    for (const request of asArray(state.bankRequests)) {
      if (previousOperator && request.operatorId === previousOperator.id && cleanText(request.operatorName, 120).toLowerCase() === cleanText(user.name, 120).toLowerCase()) {
        request.operatorId = user.id;
        changed = true;
      }
    }
  }

  state.teams = nextTeams;
  if (!changed) return false;
  state.updatedAt = new Date().toISOString();
  state.updatedBy = {
    id: "system",
    name: "Sistema",
    username: "system",
    role: "admin"
  };
  writeState(state);
  return true;
}

function ensureTeamsForUserSync(value) {
  const existing = normalizeTeams(value);
  const result = DEFAULT_TEAM_IDS
    .map((teamId) => existing.find((team) => team.id === teamId) || defaultTeamForId(teamId))
    .filter(Boolean);
  for (const team of existing) {
    if (!result.some((item) => item.id === team.id)) result.push(team);
  }
  return result;
}

function shouldUserBeScaleOperator(user) {
  return Boolean(user && user.active !== false && !user.pendingApproval && normalizeRole(user.role) === "viewer" && normalizeUserTeamId(user.teamId, user.role) && cleanText(user.registration || user.matricula, 40));
}

function syncUserOperator(state, user, stillExists) {
  if (!user?.id) return false;
  const targetTeamId = normalizeUserTeamId(user.teamId, user.role);
  const shouldBeOperator = stillExists && shouldUserBeScaleOperator(user);
  let changed = false;
  let linkedOperator = null;

  for (const team of asArray(state.teams)) {
    const operators = asArray(team.operators);
    let operator = operators.find((item) => item.userId === user.id);
    if (!operator && shouldBeOperator && team.id === targetTeamId) {
      const registration = cleanText(user.registration || user.matricula, 40).toLowerCase();
      operator = operators.find((item) => cleanText(item.registration, 40).toLowerCase() === registration);
    }
    if (operator) linkedOperator = operator;
  }

  for (const team of asArray(state.teams)) {
    const operators = asArray(team.operators);
    team.operators = operators;
    let operator = operators.find((item) => item.userId === user.id);
    if (!operator && linkedOperator && operators.includes(linkedOperator)) operator = linkedOperator;

    if (shouldBeOperator && team.id === targetTeamId) {
      if (!operator) {
        operator = {
          id: `user-${user.id}`,
          registration: "",
          name: "",
          role: "Operador",
          active: true,
          userId: user.id
        };
        operators.push(operator);
        changed = true;
      }
      const next = {
        id: operator.id || `user-${user.id}`,
        registration: cleanText(user.registration || user.matricula, 40),
        name: cleanText(user.name, 120),
        role: "Operador",
        active: true,
        userId: user.id
      };
      if (operator.registration !== next.registration || operator.name !== next.name || operator.role !== next.role || operator.active !== true || operator.userId !== user.id) {
        Object.assign(operator, next);
        changed = true;
      }
      changed = updateScheduleOperatorNames(state, operator.id, next.name) || changed;
    } else if (operator && operator.active !== false) {
      operator.active = false;
      changed = true;
    }
  }

  return changed;
}

function updateScheduleOperatorNames(state, operatorId, name) {
  let changed = false;
  Object.values(objectValue(state.schedules)).forEach((rows) => {
    asArray(rows).forEach((row) => {
      if (row?.operatorId === operatorId && row.operatorName !== name) {
        row.operatorName = name;
        changed = true;
      }
    });
  });
  return changed;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function writeDailyBackup(kind, value) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(BACKUP_DIR, `${kind}-${day}.json`);
  writeJsonAtomic(file, value);
}

function loadSessions() {
  try {
    const stored = dbGetRecord("sessions", null) ?? (fs.existsSync(SESSIONS_FILE) ? JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) : []);
    const now = Date.now();
    asArray(stored).forEach((item) => {
      const session = objectValue(item);
      const token = cleanText(session.token, 160);
      const userId = cleanText(session.userId, 80);
      const expiresAt = Number(session.expiresAt) || 0;
      if (token && userId && expiresAt > now) {
        sessions.set(token, {
          userId,
          expiresAt,
          remember: Boolean(session.remember),
          authVersion: normalizedAuthVersion(session.authVersion)
        });
      }
    });
  } catch (error) {
    console.error("[BANCOFLOW] Sessoes salvas invalidas:", error.message);
  }
}

function writeSessions() {
  const data = [...sessions.entries()].map(([token, session]) => ({
    token,
    userId: session.userId,
    expiresAt: session.expiresAt,
    remember: Boolean(session.remember),
    authVersion: normalizedAuthVersion(session.authVersion)
  }));
  dbSetRecord("sessions", data);
  writeJsonAtomic(SESSIONS_FILE, data);
}

function normalizeAppState(input, user) {
  const source = input && typeof input === "object" ? input : {};
  const size = Buffer.byteLength(JSON.stringify(source), "utf8");
  if (size > MAX_BODY_BYTES) throwApi("O arquivo da escala esta muito grande para salvar.");
  return {
    version: Number(source.version) || 4,
    teams: normalizeTeams(source.teams),
    schedules: normalizeSchedules(source.schedules),
    bankRequests: normalizeBankRequests(source.bankRequests),
    bankBalances: normalizeBankBalances(source.bankBalances),
    auditEvents: normalizeAuditEvents(source.auditEvents),
    system: normalizeSystem(source.system),
    equipe: normalizeTeam(source.equipe),
    data: normalizeScheduleData(source.data),
    currentDate: normalizeIsoDate(source.currentDate) || new Date().toISOString(),
    cycleStartValue: normalizeDate(source.cycleStartValue) || DEFAULT_CYCLE_START,
    vacations: normalizeVacations(source.vacations),
    swaps: normalizeSwaps(source.swaps),
    status: normalizeStatus(source.status),
    theme: source.theme === "light" ? "light" : "dark",
    updatedAt: new Date().toISOString(),
    updatedBy: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
    }
  };
}

function ensureStateObject(state) {
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function normalizeTeams(value) {
  return asArray(value).slice(0, 20).map((raw) => {
    const item = objectValue(raw);
    return {
      id: cleanText(item.id, 40),
      name: cleanText(item.name, 80),
      accent: cleanText(item.accent, 20),
      operators: asArray(item.operators).slice(0, 200).map((opRaw, index) => {
        const op = objectValue(opRaw);
        return {
          id: cleanText(op.id || `op-${index + 1}`, 60),
          userId: cleanText(op.userId, 80),
          registration: cleanText(op.registration, 40),
          name: cleanText(op.name, 120),
          role: cleanText(op.role || "Operador", 80),
          active: op.active !== false
        };
      }).filter((op) => op.name)
    };
  }).filter((team) => team.id && team.name);
}

function defaultTeamForId(teamId) {
  const index = DEFAULT_TEAM_META.findIndex(([id]) => id === cleanText(teamId, 40).toLowerCase());
  if (index < 0) return null;
  const [id, name, accent] = DEFAULT_TEAM_META[index];
  return {
    id,
    name,
    accent,
    operators: Array.from({ length: 8 }, (_, operatorIndex) => ({
      id: `${id}-${operatorIndex + 1}`,
      registration: `${index + 1}${String(operatorIndex + 1).padStart(2, "0")}.${240 + operatorIndex}`,
      name: `${name} Operador ${operatorIndex + 1}`,
      role: operatorIndex === 0 ? "Lider da equipe" : "Operador",
      active: true
    }))
  };
}

function normalizeSchedules(value) {
  const schedules = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return schedules;
  for (const [teamId, rows] of Object.entries(value).slice(0, 20)) {
    const id = cleanText(teamId, 40);
    if (!id) continue;
    schedules[id] = asArray(rows).slice(0, 150_000).map((raw) => {
      const item = objectValue(raw);
      const date = normalizeDate(item.date) || "";
      return {
        id: cleanText(item.id, 80),
        teamId: cleanText(item.teamId || id, 40),
        operatorId: cleanText(item.operatorId, 60),
        operatorName: cleanText(item.operatorName, 120),
        date,
        month: cleanText(item.month, 20) || date.slice(0, 7),
        shift: cleanText(item.shift, 30),
        post: cleanText(item.post, 30),
        note: cleanText(item.note, 500),
        updatedAt: normalizeIsoDate(item.updatedAt) || "",
        updatedBy: item.updatedBy ? publicLogUser(item.updatedBy) : null
      };
    }).filter((item) => item.operatorName && item.date);
  }
  return schedules;
}

function normalizeBankRequests(value) {
  return asArray(value).slice(0, 20_000).map(normalizeBankRequest).filter((item) => item.id && item.teamId && item.operatorName && item.date);
}

function normalizeNotifications(value) {
  return asArray(value).slice(0, 5000).map((raw) => {
    const item = objectValue(raw);
    return {
      id: cleanText(item.id, 80),
      userId: cleanText(item.userId, 80),
      requestId: cleanText(item.requestId, 80),
      title: cleanText(item.title, 100),
      message: cleanText(item.message, 400),
      type: ["approved", "rejected", "info"].includes(item.type) ? item.type : "info",
      createdAt: normalizeIsoDate(item.createdAt) || new Date().toISOString(),
      readAt: normalizeIsoDate(item.readAt) || ""
    };
  }).filter((item) => item.id && item.userId && item.title);
}

function normalizeProfilePhoto(value) {
  const photo = String(value || "").trim();
  if (!photo) return "";
  if (photo.length > 450_000 || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(photo)) {
    throwApi("Use uma foto JPG, PNG ou WebP de ate 300 KB.");
  }
  return photo.replace(/[\r\n]/g, "");
}

function normalizeBankRequest(raw) {
  const item = objectValue(raw);
  const requesterRole = normalizeRole(item.requesterRole || item.requestedBy?.role || "viewer");
  const status = normalizeBankStatus(item.status);
  return {
    id: cleanText(item.id || crypto.randomUUID(), 80),
    teamId: cleanText(item.teamId, 40),
    reviewTeamId: cleanText(item.reviewTeamId, 40),
    reviewTeamName: cleanText(item.reviewTeamName, 80),
    reviewLeaderName: cleanText(item.reviewLeaderName, 120),
    operatorId: cleanText(item.operatorId, 60),
    operatorName: cleanText(item.operatorName, 120),
    requesterRole,
    requestType: normalizeBankRequestType(item.requestType, true),
    date: normalizeDate(item.date) || "",
    hours: normalizeHours(item.hours),
    reason: cleanText(item.reason, 500),
    status,
    workflowStage: normalizeBankWorkflowStage(item.workflowStage, requesterRole, status, item.leaderCheckedAt),
    createdAt: normalizeIsoDate(item.createdAt) || new Date().toISOString(),
    requestedBy: item.requestedBy ? publicLogUser(item.requestedBy) : null,
    reviewedAt: normalizeIsoDate(item.reviewedAt) || "",
    reviewedBy: item.reviewedBy ? publicLogUser(item.reviewedBy) : null,
    leaderCheckedAt: normalizeIsoDate(item.leaderCheckedAt) || "",
    leaderCheckedBy: item.leaderCheckedBy ? publicLogUser(item.leaderCheckedBy) : null,
    deductedHours: normalizeHours(item.deductedHours),
    balanceAdjustedAt: normalizeIsoDate(item.balanceAdjustedAt) || "",
    coordinatorNote: cleanText(item.coordinatorNote, 700),
    notedAt: normalizeIsoDate(item.notedAt) || "",
    notedBy: item.notedBy ? publicLogUser(item.notedBy) : null
  };
}

function normalizeBankRequestType(value, allowLegacy = false) {
  const type = cleanText(value, 40).toLowerCase();
  if (["full_leave", "partial_exit", "late_entry"].includes(type)) return type;
  return allowLegacy ? "legacy" : "";
}

function normalizeBankBalances(value) {
  const source = objectValue(value);
  const balances = {};
  for (const [operatorId, rawHours] of Object.entries(source).slice(0, 10_000)) {
    const id = cleanText(operatorId, 60);
    if (id) balances[id] = normalizeBalanceHours(rawHours);
  }
  return balances;
}

function normalizeHours(value, allowZero = false) {
  const hours = parseHourValue(value);
  if (!Number.isFinite(hours) || hours < 0 || (!allowZero && hours === 0)) return 0;
  return roundHours(Math.min(hours, 100_000));
}

function parseHourValue(value) {
  const input = String(value ?? "").trim();
  const duration = input.match(/^(-?)(\d{1,5}):([0-5]\d)$/);
  if (duration) {
    const hours = Number(duration[2]) + Number(duration[3]) / 60;
    return duration[1] ? -hours : hours;
  }
  return Number(input.replace(",", "."));
}

function roundHours(value) {
  const minutes = Math.round(Number(value) * 60);
  return Math.round(minutes / 60 * 1_000_000) / 1_000_000;
}

function normalizeBalanceHours(value) {
  const hours = parseHourValue(value);
  if (!Number.isFinite(hours)) return 0;
  return roundHours(Math.max(MIN_BANK_BALANCE, Math.min(hours, 100_000)));
}

function formatHours(value) {
  const hours = Number(value) || 0;
  const totalMinutes = Math.abs(Math.round(hours * 60));
  const sign = hours < 0 && totalMinutes ? "-" : "";
  return `${sign}${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function formatDateForNotification(value) {
  const [year, month, day] = String(value || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value || "");
}

function requestTypeLabelServer(type) {
  return { full_leave: "Dispensa integral", partial_exit: "Saida parcial", late_entry: "Entrada com atraso" }[type] || "Banco de horas";
}

function bankBalanceFor(state, operatorId) {
  return normalizeBalanceHours(objectValue(state?.bankBalances)[cleanText(operatorId, 60)]);
}

function findStateOperatorRecord(state, operatorId) {
  const id = cleanText(operatorId, 60);
  for (const team of normalizeTeams(state?.teams)) {
    const operator = asArray(team.operators).find((item) => item.id === id);
    if (operator) return { team, operator };
  }
  return null;
}

function findStateOperator(state, teamId, operatorId) {
  const team = normalizeTeams(state?.teams).find((item) => item.id === cleanText(teamId, 40).toLowerCase());
  return asArray(team?.operators).find((item) => item.id === cleanText(operatorId, 60)) || null;
}

function bankCalendarCounts(requests) {
  const counts = {};
  for (const request of asArray(requests)) {
    const date = normalizeDate(request?.date);
    if (!date || normalizeBankStatus(request?.status) === "Rejeitado") continue;
    counts[date] = Math.min(3, (counts[date] || 0) + 1);
  }
  return counts;
}

function normalizeBankStatus(status) {
  const value = cleanText(status || "Pendente", 40).toLowerCase();
  if (value.includes("aprov")) return "Aprovado";
  if (value.includes("rejeit")) return "Rejeitado";
  return "Pendente";
}

function normalizeAuditEvents(value) {
  return asArray(value).slice(0, 5000).map((raw) => {
    const item = objectValue(raw);
    return {
      id: cleanText(item.id || crypto.randomUUID(), 80),
      at: normalizeIsoDate(item.at) || new Date().toISOString(),
      user: cleanText(item.user, 120),
      action: cleanText(item.action, 120),
      detail: cleanText(item.detail, 500)
    };
  }).filter((item) => item.action);
}

function normalizeSystem(value) {
  const item = objectValue(value);
  return {
    theme: item.theme === "light" ? "light" : "dark",
    cycleStart: normalizeDate(item.cycleStart) || DEFAULT_CYCLE_START,
    teamOffStarts: normalizeTeamOffStarts(item.teamOffStarts),
    posts: asArray(item.posts).slice(0, 50).map((post) => cleanText(post, 30)).filter(Boolean),
    shifts: asArray(item.shifts).slice(0, 20).map((shift) => cleanText(shift, 30)).filter(Boolean)
  };
}

function normalizeTeamOffStarts(value) {
  const source = objectValue(value);
  const result = {};
  for (const [teamId, date] of Object.entries(source)) {
    const id = cleanText(teamId, 40).toLowerCase();
    if (DEFAULT_TEAM_IDS.includes(id) && !isSemiTurnTeam(id)) {
      const normalizedDate = normalizeDate(date);
      if (normalizedDate) result[id] = normalizedDate;
    }
  }
  return result;
}

function normalizeTeam(value) {
  return asArray(value).slice(0, 500).map((raw, index) => {
    const item = objectValue(raw);
    return {
      matricula: cleanText(item.matricula || `REG-${index + 1}`, 40),
      nome: cleanText(item.nome, 120)
    };
  }).filter((item) => item.nome);
}

function normalizeScheduleData(value) {
  return asArray(value).slice(0, 100_000).map((raw) => {
    const item = objectValue(raw);
    return {
      matricula: cleanText(item.matricula, 40),
      operador: cleanText(item.operador, 120),
      data: normalizeDate(item.data) || cleanText(item.data, 20),
      dia: Number(item.dia) || 0,
      mes: cleanText(item.mes, 20),
      turno: cleanText(item.turno, 30),
      posto: cleanText(item.posto, 30)
    };
  }).filter((item) => item.operador && item.data);
}

function normalizeVacations(value) {
  return asArray(value).slice(0, 5000).map((raw) => {
    const item = objectValue(raw);
    return {
      operador: cleanText(item.operador, 120),
      inicio: normalizeDate(item.inicio) || "",
      fim: normalizeDate(item.fim) || ""
    };
  }).filter((item) => item.operador && item.inicio && item.fim);
}

function normalizeSwaps(value) {
  return asArray(value).slice(0, 5000).map((raw) => {
    const item = objectValue(raw);
    return {
      from: cleanText(item.from, 120),
      date: normalizeDate(item.date) || "",
      reason: cleanText(item.reason, 500),
      status: cleanText(item.status || "Pendente", 40)
    };
  }).filter((item) => item.from && item.date);
}

function normalizeStatus(value) {
  const status = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return status;
  for (const [key, text] of Object.entries(value).slice(0, 1000)) {
    const name = cleanText(key, 120);
    if (name) status[name] = cleanText(text, 2000);
  }
  return status;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeIsoDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function readAccessLogs() {
  const stored = dbGetRecord("access_logs", null);
  if (Array.isArray(stored)) return stored;
  if (!fs.existsSync(ACCESS_LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(ACCESS_LOG_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeAccessLogs(logs) {
  const next = asArray(logs).slice(0, 1000);
  dbSetRecord("access_logs", next);
  writeJsonAtomic(ACCESS_LOG_FILE, next);
}

function appendAccessLog(req, user, action) {
  const logs = readAccessLogs();
  logs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    action,
    user: publicLogUser(user),
    ip: clientIp(req),
    userAgent: cleanText(req.headers["user-agent"], 300)
  });
  writeAccessLogs(logs);
}

function readChangeLogs() {
  const stored = dbGetRecord("change_logs", null);
  if (Array.isArray(stored)) return stored;
  if (!fs.existsSync(CHANGE_LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CHANGE_LOG_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeChangeLogs(logs) {
  const next = asArray(logs).slice(0, 20000);
  dbSetRecord("change_logs", next);
  writeJsonAtomic(CHANGE_LOG_FILE, next);
}

function appendChangeLog(req, user, change) {
  const logs = readChangeLogs();
  const item = objectValue(change);
  logs.unshift({
    id: cleanText(item.id || crypto.randomUUID(), 80),
    at: normalizeIsoDate(item.at) || new Date().toISOString(),
    action: cleanText(item.action || "Alteracao", 120),
    detail: cleanText(item.detail || "Alteracao registrada", 700),
    teamId: cleanText(item.teamId, 40),
    teamName: cleanText(item.teamName, 80),
    operatorId: cleanText(item.operatorId, 60),
    operatorName: cleanText(item.operatorName, 120),
    field: cleanText(item.field, 40),
    previous: cleanText(item.previous, 120),
    next: cleanText(item.next, 120),
    targetUser: item.targetUser ? publicLogUser(item.targetUser) : null,
    user: publicLogUser(user),
    ip: clientIp(req),
    userAgent: cleanText(req.headers["user-agent"], 300)
  });
  writeChangeLogs(logs);
}

function appendChangeLogs(req, user, changes, previousState, nextState) {
  const normalized = normalizeClientChanges(changes);
  if (normalized.length) {
    normalized.forEach((change) => appendChangeLog(req, user, change));
    return;
  }
  const summary = summarizeStateChange(previousState, nextState);
  appendChangeLog(req, user, {
    action: "Salvamento de escala",
    detail: summary
  });
}

function normalizeClientChanges(value) {
  return asArray(value).slice(0, 250).map((raw) => {
    const item = objectValue(raw);
    return {
      id: cleanText(item.id || crypto.randomUUID(), 80),
      at: normalizeIsoDate(item.at) || new Date().toISOString(),
      action: cleanText(item.action || "Alteracao", 120),
      detail: cleanText(item.detail || "Alteracao registrada", 700),
      teamId: cleanText(item.teamId, 40),
      teamName: cleanText(item.teamName, 80),
      operatorId: cleanText(item.operatorId, 60),
      operatorName: cleanText(item.operatorName, 120),
      field: cleanText(item.field, 40),
      previous: cleanText(item.previous, 120),
      next: cleanText(item.next, 120)
    };
  }).filter((item) => item.action);
}

function summarizeStateChange(previousState, nextState) {
  const previous = ensureStateObject(previousState);
  const next = ensureStateObject(nextState);
  const teamCount = asArray(next.teams).length;
  const scheduleCount = Object.values(objectValue(next.schedules)).reduce((sum, rows) => sum + asArray(rows).length, 0);
  const previousScheduleCount = Object.values(objectValue(previous.schedules)).reduce((sum, rows) => sum + asArray(rows).length, 0);
  return `Estado salvo com ${teamCount} equipes e ${scheduleCount} linhas de escala (${scheduleCount - previousScheduleCount >= 0 ? "+" : ""}${scheduleCount - previousScheduleCount}).`;
}

function describeUserPatch(before, after, body) {
  const changes = [];
  if (before.name !== after.name) changes.push(`nome: ${before.name} -> ${after.name}`);
  if ((before.registration || "") !== (after.registration || "")) changes.push(`matricula: ${before.registration || "-"} -> ${after.registration || "-"}`);
  if (before.username !== after.username) changes.push(`usuario: ${before.username} -> ${after.username}`);
  if (before.email !== after.email) changes.push(`e-mail: ${before.email} -> ${after.email}`);
  if (before.role !== after.role) changes.push(`perfil: ${before.role} -> ${after.role}`);
  if ((before.teamId || "") !== (after.teamId || "")) changes.push(`equipe: ${teamLabel(before.teamId)} -> ${teamLabel(after.teamId)}`);
  if (before.active !== after.active) changes.push(after.active ? "usuario ativado" : "usuario bloqueado");
  if (body.password !== undefined && String(body.password).trim()) changes.push("senha redefinida");
  return changes.length ? changes.join("; ") : "Usuario atualizado";
}

function publicLogUser(user) {
  return {
    id: cleanText(user.id, 80),
    name: cleanText(user.name, 120),
    username: cleanText(user.username, 80),
    registration: cleanText(user.registration || user.matricula, 40),
    role: cleanText(user.role, 40),
    teamId: cleanText(user.teamId, 40)
  };
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase();
  if (value === "viewer" || value === "operador") return "viewer";
  if (value === "monitoring" || value === "monitoramento" || value === "operador de cameras" || value === "operador de câmeras") return "monitoring";
  if (value === "assistant" || value === "assistente") return "assistant";
  if (value === "analyst" || value === "analista") return "analyst";
  if (value === "coordinator" || value === "coordenador") return "coordinator";
  if (value === "supervisor") return "supervisor";
  if (value === "leader" || value === "lider" || value === "líder") return "leader";
  if (value === "balance_adjuster" || value === "ajuste de horas" || value === "ajuste-horas") return "balance_adjuster";
  if (value === "admin" || value === "administrador") return "admin";
  return "viewer";
}

function normalizeSelfRole(role) {
  const value = normalizeRole(role);
  return ["viewer", "monitoring", "leader", "assistant", "analyst", "supervisor", "coordinator"].includes(value) ? value : "viewer";
}

function initialBankWorkflowStage(role) {
  const value = normalizeRole(role);
  if (["viewer", "monitoring", "assistant"].includes(value)) return "leader_check";
  if (value === "leader") return "supervisor_review";
  if (value === "supervisor" || value === "analyst") return "coordinator_review";
  return "coordinator_review";
}

function normalizeBankWorkflowStage(stage, role, status, leaderCheckedAt = "") {
  if (status === "Aprovado") return "approved";
  if (status === "Rejeitado") return "rejected";
  const value = cleanText(stage, 40).toLowerCase();
  if (["leader_check", "supervisor_review", "coordinator_review"].includes(value)) return value;
  if (["viewer", "monitoring", "assistant"].includes(normalizeRole(role)) && leaderCheckedAt) return "supervisor_review";
  return initialBankWorkflowStage(role);
}

function roleLabel(role) {
  return {
    admin: "Administrador",
    coordinator: "Coordenador",
    supervisor: "Supervisor",
    monitoring: "Monitoramento",
    assistant: "Assistente",
    analyst: "Analista",
    balance_adjuster: "Ajuste de horas",
    leader: "Lider de equipe",
    viewer: "Operador"
  }[normalizeRole(role)] || "Operador";
}

function requiresFixedTeam(role) {
  const value = normalizeRole(role);
  return value === "viewer" || value === "monitoring" || value === "leader" || value === "assistant";
}

function normalizeUserTeamId(teamId, role = "viewer") {
  const value = cleanText(teamId, 40).toLowerCase();
  if (!requiresFixedTeam(role)) return "";
  if (DEFAULT_TEAM_IDS.includes(value)) return value;
  return "";
}

function teamLabel(teamId) {
  const id = cleanText(teamId, 40).toLowerCase();
  const names = { alfa: "Aurora", bravo: "Horizonte", charlie: "Orbita", delta: "Prisma", echo: "Vertice", gestao: "Gestao" };
  return names[id] || (id ? id : "Todas");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex"), "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createPassword() {
  return crypto.randomBytes(14).toString("base64url");
}

function normalizedAuthVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function verifyPasswordAsync(password, stored) {
  const [, salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return Promise.resolve(false);
  const expected = Buffer.from(hash, "hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.length === expected.length && crypto.timingSafeEqual(derivedKey, expected));
    });
  });
}

function createSession(userId, remember = true, authVersion = 1) {
  const token = crypto.randomBytes(32).toString("base64url");
  const ttl = remember ? REMEMBER_SESSION_TTL_MS : SESSION_TTL_MS;
  sessions.set(token, {
    userId,
    expiresAt: Date.now() + ttl,
    remember: Boolean(remember),
    authVersion: normalizedAuthVersion(authVersion)
  });
  writeSessions();
  return { token, maxAgeSeconds: Math.floor(ttl / 1000) };
}

function cleanSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) writeSessions();
}

function cleanSecurityState() {
  cleanSessions();
  const now = Date.now();
  for (const [key, attempt] of loginAttempts) {
    if (!attempt?.expiresAt || attempt.expiresAt <= now) loginAttempts.delete(key);
  }
  for (const [key, limit] of publicRequestLimits) {
    if (!limit?.resetAt || limit.resetAt <= now) publicRequestLimits.delete(key);
  }
}

function revokeUserSessions(userId) {
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.userId !== userId) continue;
    sessions.delete(token);
    changed = true;
  }
  if (changed) writeSessions();
}

function getCurrentUser(req) {
  const token = getCookie(req, "bancoflow_session");
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    writeSessions();
    return null;
  }
  const user = readUsers().find((item) => item.id === session.userId && item.active !== false);
  if (!user || normalizedAuthVersion(session.authVersion) !== normalizedAuthVersion(user.authVersion)) {
    sessions.delete(token);
    writeSessions();
    return null;
  }
  if (!session.remember) session.expiresAt = Date.now() + SESSION_TTL_MS;
  return user;
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = header.split(";").map((item) => item.trim());
  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index === -1) continue;
    if (cookie.slice(0, index) === name) return decodeURIComponent(cookie.slice(index + 1));
  }
  return "";
}

function loginAttemptKeys(req, user, identifier = "") {
  const identifierDigest = crypto.createHash("sha256").update(String(identifier)).digest("hex").slice(0, 32);
  const keys = [
    { key: "global", limit: LOGIN_GLOBAL_MAX_FAILURES, blocking: true },
    { key: `ip:${clientIp(req)}`, limit: LOGIN_IP_MAX_FAILURES, blocking: true },
    {
      key: user?.id ? `account:${user.id}` : `identifier:${identifierDigest}`,
      limit: LOGIN_MAX_FAILURES,
      blocking: false
    }
  ];
  return keys;
}

function blockedLoginUntil(keys) {
  const now = Date.now();
  let blockedUntil = 0;
  for (const { key, blocking } of keys) {
    if (!blocking) continue;
    const current = loginAttempts.get(key);
    if (!current) continue;
    if (current.expiresAt <= now) {
      loginAttempts.delete(key);
      continue;
    }
    blockedUntil = Math.max(blockedUntil, current.blockedUntil || 0);
  }
  if (loginAttempts.size >= RATE_LIMIT_MAX_ENTRIES && keys.some(({ key }) => !loginAttempts.has(key))) {
    blockedUntil = Math.max(blockedUntil, now + 60_000);
  }
  return blockedUntil;
}

function loginPenaltyMs(keys) {
  const accountKey = keys.find(({ blocking }) => !blocking)?.key;
  const failures = accountKey ? Number(loginAttempts.get(accountKey)?.count) || 0 : 0;
  if (failures < LOGIN_MAX_FAILURES) return 0;
  return Math.min(1000, (failures - LOGIN_MAX_FAILURES + 1) * 200);
}

function recordFailedLogin(keys) {
  const now = Date.now();
  for (const { key, limit, blocking } of keys) {
    if (!loginAttempts.has(key) && loginAttempts.size >= RATE_LIMIT_MAX_ENTRIES) continue;
    const current = loginAttempts.get(key) || { count: 0, blockedUntil: 0, expiresAt: 0 };
    current.count += 1;
    current.blockedUntil = blocking && current.count >= limit ? now + LOGIN_BLOCK_MS : 0;
    current.expiresAt = Math.max(now + LOGIN_BLOCK_MS, current.blockedUntil);
    loginAttempts.set(key, current);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consumePublicRateLimit(req, res, scope, perIpLimit, globalLimit) {
  const now = Date.now();
  const entries = [
    { key: `${scope}:global`, limit: globalLimit },
    { key: `${scope}:ip:${clientIp(req)}`, limit: perIpLimit }
  ].map(({ key, limit }) => {
    const existing = publicRequestLimits.get(key);
    const value = existing?.resetAt > now ? existing : { count: 0, resetAt: now + PUBLIC_RATE_WINDOW_MS };
    return { key, limit, value };
  });
  const blocked = entries.find(({ limit, value }) => value.count >= limit);
  if (blocked || (publicRequestLimits.size >= RATE_LIMIT_MAX_ENTRIES && entries.some(({ key }) => !publicRequestLimits.has(key)))) {
    const resetAt = blocked?.value.resetAt || now + 60_000;
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
    sendJson(res, 429, { error: "Muitas solicitacoes. Aguarde antes de tentar novamente." });
    return false;
  }
  entries.forEach(({ key, value }) => publicRequestLimits.set(key, { count: value.count + 1, resetAt: value.resetAt }));
  return true;
}

function pendingRegistrationCount(users) {
  return asArray(users).filter((user) => user.pendingApproval && user.active === false).length;
}

function clientIp(req) {
  const socketIp = normalizeIp(req.socket.remoteAddress) || "local";
  if (!TRUST_PROXY) return socketIp;
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map(normalizeIp)
    .filter(Boolean);
  return forwarded.at(-1) || socketIp;
}

function normalizeIp(value) {
  const candidate = String(value || "").trim().replace(/^::ffff:/, "");
  return net.isIP(candidate) ? candidate : "";
}

function isHttps(req) {
  return Boolean(req.socket.encrypted) || (TRUST_PROXY && String(req.headers["x-forwarded-proto"] || "").split(",").at(-1).trim() === "https");
}

function sessionCookie(req, token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  const secure = isHttps(req) ? "; Secure" : "";
  return `bancoflow_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie(req) {
  const secure = isHttps(req) ? "; Secure" : "";
  return `bancoflow_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function userTeamId(user) {
  return normalizeUserTeamId(user?.teamId, user?.role);
}

function canAccessTeam(user, teamId) {
  if (!user) return false;
  if (["admin", "coordinator", "supervisor", "assistant", "analyst"].includes(user.role)) return true;
  return userTeamId(user) === cleanText(teamId, 40).toLowerCase();
}

function isSemiTurnTeam(teamId) {
  return cleanText(teamId, 40).toLowerCase() === "echo";
}

function parseDateValue(key) {
  const [year, month, day] = String(key || "").split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffDaysForDate(key, cycleStart) {
  const date = parseDateValue(key);
  const start = parseDateValue(cycleStart);
  if (!date || !start) return 0;
  return Math.floor((date - start) / 86400000);
}

function cycleShiftForDate(key, cycleStart, offset = 0) {
  const index = ((diffDaysForDate(key, cycleStart) + offset) % DEFAULT_TEAM_SHIFTS.length + DEFAULT_TEAM_SHIFTS.length) % DEFAULT_TEAM_SHIFTS.length;
  return DEFAULT_TEAM_SHIFTS[index];
}

function cycleShiftFromFirstOffForDate(key, firstOffDate) {
  const index = ((diffDaysForDate(key, firstOffDate) + 6) % DEFAULT_TEAM_SHIFTS.length + DEFAULT_TEAM_SHIFTS.length) % DEFAULT_TEAM_SHIFTS.length;
  return DEFAULT_TEAM_SHIFTS[index];
}

function defaultFirstOffForTeamId(teamId, cycleStart) {
  const index = Math.max(0, DEFAULT_TEAM_META.findIndex(([id]) => id === teamId));
  for (let day = 0; day < DEFAULT_TEAM_SHIFTS.length; day += 1) {
    const date = parseDateValue(cycleStart);
    if (!date) return cycleStart;
    date.setDate(date.getDate() + day);
    const key = date.toISOString().slice(0, 10);
    if (cycleShiftForDate(key, cycleStart, index * 2) === "FOLGA") return key;
  }
  return cycleStart;
}

function operationalTeamShiftForDate(teamId, key, system) {
  const cycleStart = normalizeDate(system?.cycleStart) || DEFAULT_CYCLE_START;
  const firstOff = normalizeDate(system?.teamOffStarts?.[teamId]) || defaultFirstOffForTeamId(teamId, cycleStart);
  return cycleShiftFromFirstOffForDate(key, firstOff);
}

function semiTurnShiftForDate(key, cycleStart = DEFAULT_CYCLE_START) {
  const date = parseDateValue(key);
  if (!date || date.getDay() === 0) return "FOLGA";
  const weekIndex = Math.floor(diffDaysForDate(key, cycleStart) / 7);
  return ((weekIndex % 2) + 2) % 2 === 0 ? "MANHA" : "TARDE";
}

function leaderForTeamRecord(team) {
  return asArray(team?.operators).find((operator) => cleanText(operator.role, 80).toLowerCase().includes("lider") && operator.active !== false)
    || asArray(team?.operators).find((operator) => operator.active !== false)
    || null;
}

function resolveSemiTurnBankTarget(state, dateValue) {
  const source = ensureStateObject(state);
  const cycleStart = normalizeDate(source.system?.cycleStart) || DEFAULT_CYCLE_START;
  const shift = semiTurnShiftForDate(dateValue, cycleStart);
  if (shift === "FOLGA") return null;
  const storedTeams = normalizeTeams(source.teams);
  const teams = DEFAULT_TEAM_META
    .filter(([id]) => id !== "echo")
    .map(([id]) => storedTeams.find((team) => team.id === id) || defaultTeamForId(id))
    .filter(Boolean);
  const system = normalizeSystem(source.system);
  const target = teams.find((team) => operationalTeamShiftForDate(team.id, dateValue, system) === shift)
    || teams.find((team) => operationalTeamShiftForDate(team.id, dateValue, system) !== "FOLGA")
    || null;
  return target ? { team: target, leader: leaderForTeamRecord(target), shift } : null;
}

function canAccessBankRequest(user, request) {
  if (!user) return false;
  if (["admin", "coordinator", "supervisor"].includes(user.role)) return true;
  if (["viewer", "monitoring", "assistant", "analyst"].includes(user.role)) return request?.requestedBy?.id === user.id;
  if (user.role === "balance_adjuster") return false;
  if (user.role === "leader") {
    if (request?.requestedBy?.id === user.id) return true;
    return ["viewer", "monitoring", "assistant"].includes(normalizeRole(request?.requesterRole || request?.requestedBy?.role));
  }
  const teamId = userTeamId(user);
  return request?.requestedBy?.id === user.id || Boolean(teamId && (
    cleanText(request?.teamId, 40).toLowerCase() === teamId
    || cleanText(request?.reviewTeamId, 40).toLowerCase() === teamId
  ));
}

function canReviewBank(user) {
  return user?.role === "admin" || user?.role === "supervisor" || user?.role === "coordinator" || user?.role === "leader";
}

function canManageBankBalances(user) {
  return user?.role === "admin" || user?.role === "coordinator" || user?.role === "leader" || user?.role === "balance_adjuster";
}

function canAcknowledgeBank(user, request) {
  if (user?.role !== "leader" || request?.workflowStage !== "leader_check") return false;
  const responsibleTeam = cleanText(request?.reviewTeamId || request?.teamId, 40).toLowerCase();
  return Boolean(userTeamId(user) && userTeamId(user) === responsibleTeam);
}

function canFinalizeBankRequest(user, request) {
  if (request?.workflowStage === "supervisor_review") return user?.role === "supervisor";
  if (request?.workflowStage === "coordinator_review") return user?.role === "coordinator";
  return false;
}

function bankWorkflowPermissionMessage(request) {
  if (request?.workflowStage === "leader_check") return "A solicitacao precisa primeiro do check do lider.";
  if (request?.workflowStage === "supervisor_review") return "Apenas o supervisor pode finalizar esta solicitacao.";
  if (request?.workflowStage === "coordinator_review") return "Apenas o coordenador pode finalizar esta solicitacao.";
  return "Esta solicitacao ja foi finalizada.";
}

function canViewChangeLogs(user) {
  return user?.role === "admin" || user?.role === "coordinator" || user?.role === "analyst" || user?.role === "leader";
}

function canViewAllChangeLogs(user) {
  return user?.role === "admin" || user?.role === "coordinator" || user?.role === "analyst";
}

function filterStateForUser(state, user, users = []) {
  const source = ensureStateObject(state);
  const requests = normalizeBankRequests(source.bankRequests);
  const calendar = bankCalendarCounts(requests);
  const people = visibleBankPeople(users, user);
  const storedTeams = normalizeTeams(source.teams);
  const allTeams = [
    ...DEFAULT_TEAM_META.map(([id]) => storedTeams.find((team) => team.id === id) || defaultTeamForId(id)).filter(Boolean),
    ...storedTeams.filter((team) => !DEFAULT_TEAM_IDS.includes(team.id))
  ].map(({ id, name, accent }) => ({ id, name, accent }));
  const role = normalizeRole(user?.role);
  const teamId = userTeamId(user);
  const canSeeAllTeams = ["admin", "coordinator", "supervisor", "leader", "balance_adjuster"].includes(role);
  const visibleTeams = canSeeAllTeams ? allTeams : allTeams.filter((team) => team.id === teamId);
  const visibleRequests = ["admin", "coordinator", "supervisor"].includes(role)
    ? requests
    : requests.filter((request) => canAccessBankRequest(user, request));
  return {
    teams: visibleTeams,
    bankRequests: visibleRequests,
    bankBalances: visibleBankBalances(source.bankBalances, people),
    bankCalendar: calendar,
    bankPeople: people
  };
}

function isBankRequesterRole(role) {
  return ["viewer", "monitoring", "leader", "supervisor", "assistant", "analyst", "admin"].includes(normalizeRole(role));
}

function visibleBankPeople(users, viewer) {
  const active = asArray(users)
    .filter((user) => user.active !== false && !user.pendingApproval && isBankRequesterRole(user.role))
    .map((user) => ({
      id: user.id,
      name: user.name,
      registration: user.registration || user.matricula || "",
      role: normalizeRole(user.role),
      teamId: user.teamId || "",
      profilePhoto: user.profilePhoto || ""
    }));
  const viewerRole = normalizeRole(viewer?.role);
  if (["admin", "coordinator", "supervisor", "leader", "balance_adjuster"].includes(viewerRole)) return active;
  return active.filter((person) => person.id === viewer?.id);
}

function visibleBankBalances(balances, people) {
  const source = normalizeBankBalances(balances);
  const ids = new Set(asArray(people).map((person) => person.id));
  return Object.fromEntries(Object.entries(source).filter(([personId]) => ids.has(personId)));
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    registration: user.registration || user.matricula || "",
    role: user.role,
    teamId: user.teamId || "",
    active: user.active !== false,
    pendingApproval: Boolean(user.pendingApproval),
    profilePhoto: user.profilePhoto || "",
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt
  };
}

function isAdmin(user) {
  return user?.role === "admin";
}

function forbidden(res) {
  sendJson(res, 403, { error: "Apenas administradores podem executar esta acao." });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, url) {
  setSecurityHeaders(res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("Metodo nao permitido");
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const target = path.resolve(ROOT, `.${pathname}`);
  const relative = path.relative(ROOT, target);
  const topLevel = relative.split(path.sep)[0];
  const publicPath = relative.split(path.sep).join("/");
  const allowed = PUBLIC_FILES.has(publicPath) || (topLevel === "downloads" && [".pptx", ".pdf"].includes(path.extname(relative).toLowerCase()));
  if (relative.startsWith("..") || path.isAbsolute(relative) || topLevel.startsWith(".") || !allowed) {
    res.writeHead(404);
    res.end("Arquivo nao encontrado");
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404);
    res.end("Arquivo nao encontrado");
    return;
  }
  const noStoreAsset = [".html", ".css", ".js", ".json"].includes(path.extname(pathname).toLowerCase());
  const headers = {
    "Content-Type": mime(target),
    "Cache-Control": noStoreAsset ? "no-store" : "public, max-age=3600"
  };
  if (path.extname(pathname).toLowerCase() === ".pptx") {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(target)}"`;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(target).pipe(res);
}

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  }[ext] || "application/octet-stream";
}
