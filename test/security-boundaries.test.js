const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ADMIN_PASSWORD = "Admin-pass-123";

test("security boundaries remain enforced end to end", { timeout: 45_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bancoflow-security-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      STORAGE_MODE: "json",
      DEMO_MODE: "false",
      REQUIRE_FIREBASE: "false",
      REQUIRE_POSTGRES: "false",
      ADMIN_USERNAME: "admin",
      ADMIN_EMAIL: "admin@example.test",
      ADMIN_PASSWORD,
      TRUST_PROXY: "false",
      REGISTER_RATE_LIMIT: "1",
      REGISTER_GLOBAL_RATE_LIMIT: "10",
      PASSWORD_RESET_RATE_LIMIT: "2",
      LOGIN_MAX_FAILURES: "2",
      LOGIN_IP_MAX_FAILURES: "4",
      LOGIN_GLOBAL_MAX_FAILURES: "100"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);

    const health = await request(baseUrl, "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(health.body).sort(), ["name", "ok"]);
    assert.equal(health.body.ok, true);

    for (const internalPath of ["/server.js", "/package.json", "/render.yaml", "/CODEX_HANDOFF.md", "/tools/check-postgres.js", "/.env"]) {
      const response = await request(baseUrl, internalPath);
      assert.equal(response.status, 404, `${internalPath} must not be publicly served`);
    }
    assert.equal((await request(baseUrl, "/")).status, 200);

    const adminLogin = await login(baseUrl, "admin", ADMIN_PASSWORD);
    assert.equal(adminLogin.status, 200);
    const originalAdminCookie = adminLogin.cookie;
    assert.ok(originalAdminCookie);

    assert.equal((await request(baseUrl, "/api/health/details")).status, 401);
    const privateHealth = await request(baseUrl, "/api/health/details", { cookie: originalAdminCookie });
    assert.equal(privateHealth.status, 200);
    assert.ok(Object.hasOwn(privateHealth.body, "storage"));

    const leader = await request(baseUrl, "/api/users", {
      method: "POST",
      cookie: originalAdminCookie,
      body: {
        name: "Security Leader",
        username: "security.leader",
        email: "leader@example.test",
        role: "leader",
        teamId: "alfa",
        password: "Leader-pass-123"
      }
    });
    assert.equal(leader.status, 201);

    const operator = await request(baseUrl, "/api/users", {
      method: "POST",
      cookie: originalAdminCookie,
      body: {
        name: "Security Operator",
        username: "security.operator",
        email: "operator@example.test",
        registration: "SEC-001",
        role: "viewer",
        teamId: "alfa",
        password: "Operator-pass-123"
      }
    });
    assert.equal(operator.status, 201);

    const oversizedPassword = await request(baseUrl, "/api/users", {
      method: "POST",
      cookie: originalAdminCookie,
      body: {
        name: "Oversized Password",
        username: "oversized.password",
        email: "oversized@example.test",
        registration: "SEC-002",
        role: "viewer",
        teamId: "alfa",
        password: "x".repeat(300)
      }
    });
    assert.equal(oversizedPassword.status, 400);

    const leaderLogin = await login(baseUrl, "security.leader", "Leader-pass-123");
    assert.equal(leaderLogin.status, 200);
    const oldLeaderCookie = leaderLogin.cookie;

    const forbiddenWholeState = await request(baseUrl, "/api/state", {
      method: "PUT",
      cookie: oldLeaderCookie,
      body: { bankBalances: { arbitrary: 9999 }, users: [{ role: "admin" }] }
    });
    assert.equal(forbiddenWholeState.status, 405);
    assert.equal(forbiddenWholeState.headers.get("allow"), "GET");

    const adminWholeState = await request(baseUrl, "/api/state", {
      method: "POST",
      cookie: originalAdminCookie,
      body: { data: { secret: true } }
    });
    assert.equal(adminWholeState.status, 405);

    const operatorLogin = await login(baseUrl, "security.operator", "Operator-pass-123");
    assert.equal(operatorLogin.status, 200);
    const operatorState = await request(baseUrl, "/api/state", { cookie: operatorLogin.cookie });
    assert.equal(operatorState.status, 200);
    assert.deepEqual(Object.keys(operatorState.body.state).sort(), [
      "bankBalances",
      "bankCalendar",
      "bankPeople",
      "bankRequests",
      "teams"
    ]);
    assert.equal(operatorState.body.state.bankPeople.length, 1);
    assert.equal(operatorState.body.state.bankPeople[0].id, operator.body.user.id);
    assert.equal(Object.hasOwn(operatorState.body.state, "schedules"), false);
    assert.equal(Object.hasOwn(operatorState.body.state, "auditEvents"), false);
    assert.equal(operatorState.body.state.teams.every((team) => Object.keys(team).sort().join(",") === "accent,id,name"), true);

    const changedPassword = await request(baseUrl, "/api/change-password", {
      method: "POST",
      cookie: originalAdminCookie,
      body: { currentPassword: ADMIN_PASSWORD, newPassword: "Admin-new-pass-456" }
    });
    assert.equal(changedPassword.status, 200);
    const rotatedAdminCookie = cookieFrom(changedPassword.response);
    assert.ok(rotatedAdminCookie);
    assert.equal((await request(baseUrl, "/api/session", { cookie: originalAdminCookie })).status, 401);
    assert.equal((await request(baseUrl, "/api/session", { cookie: rotatedAdminCookie })).status, 200);

    const resetLeader = await request(baseUrl, `/api/users/${encodeURIComponent(leader.body.user.id)}`, {
      method: "PATCH",
      cookie: rotatedAdminCookie,
      body: { password: "Leader-new-pass-456" }
    });
    assert.equal(resetLeader.status, 200);
    assert.equal((await request(baseUrl, "/api/session", { cookie: oldLeaderCookie })).status, 401);
    assert.equal((await login(baseUrl, "security.leader", "Leader-new-pass-456")).status, 200);

    const shortAdminLogin = await request(baseUrl, "/api/login", {
      method: "POST",
      body: { identifier: "admin", password: "Admin-new-pass-456", remember: false }
    });
    assert.equal(shortAdminLogin.status, 200);
    const shortAdminCookie = cookieFrom(shortAdminLogin.response);
    const selfAdminReset = await request(baseUrl, `/api/users/${encodeURIComponent(shortAdminLogin.body.user.id)}`, {
      method: "PATCH",
      cookie: shortAdminCookie,
      body: { password: "Admin-final-pass-789" }
    });
    assert.equal(selfAdminReset.status, 200);
    assert.match(String(selfAdminReset.headers.get("set-cookie")), /Max-Age=28800(?:;|$)/);
    assert.equal((await request(baseUrl, "/api/session", { cookie: shortAdminCookie })).status, 401);
    assert.equal((await request(baseUrl, "/api/session", { cookie: cookieFrom(selfAdminReset.response) })).status, 200);

    assert.equal((await login(baseUrl, "security.operator", "wrong-password", { "x-forwarded-for": "203.0.113.10" })).status, 401);
    assert.equal((await login(baseUrl, "security.operator", "wrong-password", { "x-forwarded-for": "198.51.100.20" })).status, 401);
    const blockedOperator = await login(baseUrl, "security.operator", "Operator-pass-123", { "x-forwarded-for": "192.0.2.30" });
    assert.equal(blockedOperator.status, 200, "account failures must not let an attacker lock the user out");

    assert.equal((await login(baseUrl, "not-a-real-user", "wrong-password", { "x-forwarded-for": "203.0.113.40" })).status, 401);
    assert.equal((await login(baseUrl, "not-a-real-user", "wrong-password", { "x-forwarded-for": "198.51.100.50" })).status, 401);
    const blockedIp = await login(baseUrl, "security.operator", "Operator-pass-123", { "x-forwarded-for": "192.0.2.60" });
    assert.equal(blockedIp.status, 429);
    assert.ok(blockedIp.headers.get("retry-after"));

    const registration = await request(baseUrl, "/api/register", {
      method: "POST",
      body: {
        name: "Pending User",
        username: "pending.user",
        email: "pending@example.test",
        registration: "SEC-003",
        role: "viewer",
        teamId: "bravo",
        password: "Pending-pass-123"
      }
    });
    assert.equal(registration.status, 201);
    const rateLimitedRegistration = await request(baseUrl, "/api/register", {
      method: "POST",
      body: {
        name: "Second Pending User",
        username: "pending.user.two",
        email: "pending.two@example.test",
        registration: "SEC-004",
        role: "viewer",
        teamId: "bravo",
        password: "Pending-pass-456"
      }
    });
    assert.equal(rateLimitedRegistration.status, 429);
    assert.ok(rateLimitedRegistration.headers.get("retry-after"));

    assert.equal((await request(baseUrl, "/api/password-reset", {
      method: "POST",
      body: { identifier: "security.operator" }
    })).status, 200);
    assert.equal((await request(baseUrl, "/api/password-reset", {
      method: "POST",
      body: { identifier: "does.not.exist@example.test" }
    })).status, 200);
    assert.equal((await request(baseUrl, "/api/password-reset", {
      method: "POST",
      body: { identifier: "security.operator" }
    })).status, 429);

    const tooLarge = await request(baseUrl, "/api/login", {
      method: "POST",
      rawBody: JSON.stringify({ identifier: "admin", password: "x", padding: "x".repeat(70_000) })
    });
    assert.equal(tooLarge.status, 413);

    const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    const dbCheckSource = fs.readFileSync(path.join(ROOT, "tools", "check-postgres.js"), "utf8");
    assert.equal(serverSource.includes("rejectUnauthorized: false"), false);
    assert.equal(dbCheckSource.includes("rejectUnauthorized: false"), false);
    assert.match(serverSource, /rejectUnauthorized:\s*true/);
    assert.match(serverSource, /serializeStateMutation/);
  } finally {
    await stopChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function request(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  let body;
  if (options.rawBody !== undefined) {
    headers["content-type"] = "application/json";
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, headers: response.headers, body: parsed, response };
}

async function login(baseUrl, identifier, password, headers = {}) {
  const result = await request(baseUrl, "/api/login", {
    method: "POST",
    headers,
    body: { identifier, password, remember: true }
  });
  return { ...result, cookie: cookieFrom(result.response) };
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.status === 200) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`Server did not start:\n${output.join("")}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => child.kill("SIGKILL"))
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
