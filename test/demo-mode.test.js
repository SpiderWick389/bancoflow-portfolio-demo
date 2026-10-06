const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DEMO_PASSWORD = "Portfolio#2026";

test("demo logins always restore a complete fictitious workspace", { timeout: 60_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bancoflow-demo-"));
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
      DEMO_MODE: "true",
      DEMO_PASSWORD,
      REQUIRE_FIREBASE: "false",
      REQUIRE_POSTGRES: "false",
      TRUST_PROXY: "false",
      DEMO_RESET_INTERVAL_MS: String(60 * 60 * 1000)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);

    const firstAdmin = await login(baseUrl, "demo", DEMO_PASSWORD);
    assert.equal(firstAdmin.status, 200);
    assert.equal(firstAdmin.body.user.name, "Marina Costa");

    const initialUsers = await request(baseUrl, "/api/users", { cookie: firstAdmin.cookie });
    const initialState = await request(baseUrl, "/api/state", { cookie: firstAdmin.cookie });
    assert.equal(initialUsers.body.users.length, 10);
    assert.equal(initialState.body.state.bankRequests.length, 5);
    assert.deepEqual(initialState.body.state.teams.map((team) => team.name), ["Aurora", "Horizonte", "Orbita", "Prisma", "Vertice"]);

    const changedPassword = await request(baseUrl, "/api/users/demo-admin", {
      method: "PATCH",
      cookie: firstAdmin.cookie,
      body: { password: "Temporary-demo-password-123" }
    });
    assert.equal(changedPassword.status, 200);
    const changedCookie = cookieFrom(changedPassword.response);

    assert.equal((await request(baseUrl, "/api/users/demo-ana", { method: "DELETE", cookie: changedCookie })).status, 200);
    assert.equal((await request(baseUrl, "/api/bank-requests/demo-request-1", { method: "DELETE", cookie: changedCookie })).status, 200);

    const restoredAdmin = await login(baseUrl, "demo", DEMO_PASSWORD);
    assert.equal(restoredAdmin.status, 200, "the published credential must recover even after a visitor changes it");

    const restoredUsers = await request(baseUrl, "/api/users", { cookie: restoredAdmin.cookie });
    const restoredState = await request(baseUrl, "/api/state", { cookie: restoredAdmin.cookie });
    assert.equal(restoredUsers.body.users.length, 10);
    assert.ok(restoredUsers.body.users.some((user) => user.id === "demo-ana" && user.role === "viewer"));
    assert.equal(restoredState.body.state.bankRequests.length, 5);
    assert.ok(restoredState.body.state.bankRequests.some((item) => item.id === "demo-request-1"));

    const operator = await login(baseUrl, "ana", DEMO_PASSWORD);
    assert.equal(operator.status, 200);
    const operatorState = await request(baseUrl, "/api/state", { cookie: operator.cookie });
    assert.equal(operatorState.body.state.bankPeople.length, 1);
    assert.equal(operatorState.body.state.bankPeople[0].id, "demo-ana");
    assert.ok(operatorState.body.state.bankRequests.every((item) => item.operatorId === "demo-ana"));

    const supervisor = await login(baseUrl, "carla", DEMO_PASSWORD);
    assert.equal(supervisor.status, 200);
    const supervisorState = await request(baseUrl, "/api/state", { cookie: supervisor.cookie });
    assert.ok(supervisorState.body.state.bankPeople.length > 1);
    assert.ok(supervisorState.body.state.bankRequests.some((item) => item.workflowStage === "supervisor_review"));

    const accessLogs = await request(baseUrl, "/api/access-logs", { cookie: restoredAdmin.cookie });
    assert.equal(accessLogs.status, 200);
    assert.ok(accessLogs.body.logs.every((item) => item.ip === "oculto-na-demo" && item.userAgent === "navegador-da-demo"));
    const changeLogs = await request(baseUrl, "/api/change-logs", { cookie: restoredAdmin.cookie });
    assert.equal(changeLogs.status, 200);
    assert.ok(changeLogs.body.logs.every((item) => item.ip === "oculto-na-demo" && item.userAgent === "navegador-da-demo"));
  } finally {
    await stopChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function request(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, { method: options.method || "GET", headers, body });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, headers: response.headers, body: parsed, response };
}

async function login(baseUrl, identifier, password) {
  const result = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { identifier, password, remember: true }
  });
  return { ...result, cookie: cookieFrom(result.response) };
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
