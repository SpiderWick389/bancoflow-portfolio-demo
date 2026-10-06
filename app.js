const API_BASE = "/api";
const MIN_BANK_BALANCE = -14;
const FULL_LEAVE_HOURS = 7 + 20 / 60;
const LOGIN_ID_KEY = "bancoflow_demo_login_id";
const THEME_KEY = "bancoflow_demo_theme";

let currentUser = null;
let appState = { teams: [], bankPeople: [], bankRequests: [], bankBalances: {}, bankCalendar: {}, system: {} };
let users = [];
let currentRoute = "dashboard";
let authMode = "login";
let requestFilters = { status: "all", team: "all", query: "" };
let balanceSearch = "";
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedRequestDate = localDateKey();
let notifications = [];
let notificationsInitialized = false;
let notificationPollTimer = null;
let profilePhotoDraft = "";

const $ = (id) => document.getElementById(id);
const safe = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.2A8 8 0 1 1 10.8 3.4a6.2 6.2 0 0 0 9.8 9.8Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V5M16 20v-7M22 20H2"/><circle cx="17.5" cy="6" r="3"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M14 7l5 5-5 5"/></svg>',
  empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 9h8M8 13h5"/></svg>'
};

function roleLabel(role) {
  return {
    admin: "Administrador",
    coordinator: "Coordenador",
    supervisor: "Supervisor",
    monitoring: "Monitoramento",
    assistant: "Assistente",
    analyst: "Analista",
    balance_adjuster: "Ajuste de horas",
    leader: "Líder de equipe",
    viewer: "Operador"
  }[role] || "Operador";
}

function canAdmin() { return currentUser?.role === "admin"; }
function isBalanceAdjuster() { return currentUser?.role === "balance_adjuster"; }
function canReview() { return ["coordinator", "supervisor", "leader"].includes(currentUser?.role); }
function canAddNote() { return ["admin", "coordinator", "leader"].includes(currentUser?.role); }
function canRequest() { return ["viewer", "monitoring", "leader", "supervisor", "assistant", "analyst", "admin"].includes(currentUser?.role); }
function canManageBalances() { return ["admin", "coordinator", "leader", "balance_adjuster"].includes(currentUser?.role); }
function canViewAllPeople() { return ["admin", "leader", "supervisor", "coordinator", "balance_adjuster"].includes(currentUser?.role); }
function canEditBalance(operator) {
  if (["admin", "coordinator", "balance_adjuster"].includes(currentUser?.role)) return true;
  return currentUser?.role === "leader" && Boolean(currentUser.teamId) && currentUser.teamId === operator.teamId;
}

function roleNeedsTeam(role) {
  return ["viewer", "monitoring", "leader", "assistant"].includes(role);
}

function updateTeamField(role, field, select) {
  const needsTeam = roleNeedsTeam(role);
  field?.classList.toggle("hidden", !needsTeam);
  if (!select) return;
  select.disabled = !needsTeam;
  if (!needsTeam) select.value = "";
  else if (!select.value) select.value = select.querySelector('option[value]:not([value=""])')?.value || "alfa";
}

async function apiRequest(path, options = {}) {
  const init = { method: options.method || "GET", credentials: "same-origin", headers: {} };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new Error("Servidor indisponível. Tente novamente em instantes.");
  }
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || `Erro ${response.status}`);
  return payload;
}

function teamName(teamId) {
  return appState.teams.find((team) => team.id === teamId)?.name || ({
    alfa: "Aurora", bravo: "Horizonte", charlie: "Órbita", delta: "Prisma", echo: "Vértice", gestao: "Gestão"
  }[teamId] || teamId || "Sem equipe");
}

function getTeam(teamId) {
  return appState.teams.find((team) => team.id === teamId) || null;
}

function allOperators() {
  return (Array.isArray(appState.bankPeople) ? appState.bankPeople : []).map((person) => ({ ...person, teamName: teamName(person.teamId) }));
}

function bankBalance(operatorId) {
  const value = Number(appState.bankBalances?.[operatorId]);
  return Number.isFinite(value) ? Math.max(MIN_BANK_BALANCE, value) : 0;
}

function formatHours(value) {
  const numericValue = Number(value) || 0;
  const totalMinutes = Math.abs(Math.round(numericValue * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const sign = numericValue < 0 && totalMinutes ? "-" : "";
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseHours(value) {
  const input = String(value ?? "").trim();
  const duration = input.match(/^(-?)(\d{1,5}):([0-5]\d)$/);
  if (duration) {
    const hours = Number(duration[2]) + Number(duration[3]) / 60;
    return duration[1] ? -hours : hours;
  }
  if (/^-?\d+(?:[.,]\d+)?$/.test(input)) return Number(input.replace(",", "."));
  return Number.NaN;
}

function balanceHint(balance) {
  const remaining = balance - MIN_BANK_BALANCE;
  if (remaining <= 0) return "Limite de saldo negativo atingido. Novas solicitações estão bloqueadas.";
  if (balance <= 0) return `Ainda é possível solicitar até ${formatHours(remaining)} antes do limite de -14:00.`;
  return "O desconto ocorrerá após a aprovação. Limite mínimo permitido: -14:00.";
}

function requestTypeLabel(type) {
  return {
    full_leave: "Dispensa integral",
    partial_exit: "Saída parcial",
    late_entry: "Entrada com atraso"
  }[type] || "Banco de horas";
}

function currentOperator() {
  const registration = String(currentUser?.registration || "").toLowerCase();
  const name = String(currentUser?.name || "").toLocaleLowerCase("pt-BR");
  return allOperators().find((operator) => operator.userId === currentUser?.id)
    || allOperators().find((operator) => registration && String(operator.registration || "").toLowerCase() === registration)
    || allOperators().find((operator) => name && String(operator.name || "").toLocaleLowerCase("pt-BR") === name)
    || null;
}

function formatDate(value) {
  if (!value) return "Data não informada";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return String(value);
  return new Date(year, month - 1, day).toLocaleDateString("pt-BR");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function statusKey(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("aprov")) return "approved";
  if (value.includes("rejeit") || value.includes("negad")) return "rejected";
  return "pending";
}

function statusLabel(status) {
  return statusKey(status) === "approved" ? "Aprovado" : statusKey(status) === "rejected" ? "Rejeitado" : "Pendente";
}

function workflowLabel(request) {
  if (statusKey(request.status) !== "pending") return statusLabel(request.status);
  if (request.workflowStage === "leader_check") return "Aguardando líder";
  if (request.workflowStage === "supervisor_review") return "Aguardando supervisor";
  if (request.workflowStage === "coordinator_review") return "Aguardando coordenador";
  return "Pendente";
}

function canAcknowledgeRequest(request) {
  const responsibleTeam = request.reviewTeamId || request.teamId;
  return currentUser?.role === "leader" && request.workflowStage === "leader_check" && Boolean(currentUser.teamId) && currentUser.teamId === responsibleTeam;
}

function canFinalizeRequest(request) {
  if (request.workflowStage === "supervisor_review") return currentUser?.role === "supervisor";
  if (request.workflowStage === "coordinator_review") return currentUser?.role === "coordinator";
  return false;
}

function canActOnRequest(request) {
  return statusKey(request.status) === "pending" && (canAcknowledgeRequest(request) || canFinalizeRequest(request));
}

function initials(name) {
  return String(name || "U").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function avatarMarkup(person, className = "userAvatar") {
  const label = initials(person?.name || person?.username);
  return `<span class="${className}${person?.profilePhoto ? " hasPhoto" : ""}">${person?.profilePhoto ? `<img src="${safe(person.profilePhoto)}" alt="Foto de ${safe(person.name || person.username || "perfil")}">` : safe(label)}</span>`;
}

function updateCurrentAvatar() {
  const avatar = $("userInitials");
  avatar.classList.toggle("hasPhoto", Boolean(currentUser?.profilePhoto));
  avatar.innerHTML = currentUser?.profilePhoto
    ? `<img src="${safe(currentUser.profilePhoto)}" alt="Foto de ${safe(currentUser.name || currentUser.username)}">`
    : safe(initials(currentUser?.name || currentUser?.username));
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $("toastRegion").appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

function setBusy(button, busy, label = "Aguarde...") {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.innerHTML;
    button.disabled = true;
    button.textContent = label;
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
  }
}

function setLoginMessage(message = "", type = "error") {
  $("loginMessage").textContent = message;
  $("loginMessage").className = `formMessage ${message ? type : ""}`;
}

function setAuthMode(mode) {
  const modes = ["login", "register", "forgot"];
  if (!modes.includes(mode) || mode === authMode) return;
  const previousIndex = modes.indexOf(authMode);
  const nextIndex = modes.indexOf(mode);
  const animationClass = nextIndex > previousIndex ? "authSlideFromRight" : "authSlideFromLeft";
  authMode = mode;
  const config = {
    login: ["Acesso ao sistema", "Entre para solicitar ou acompanhar banco de horas.", "Entrar"],
    register: ["Primeiro acesso", "Crie seu cadastro para solicitar banco de horas.", "Enviar cadastro"],
    forgot: ["Redefinir senha", "Registre o pedido para o administrador.", "Enviar pedido"]
  }[mode];
  $("authTitle").textContent = config[0];
  $("authSubtitle").textContent = config[1];
  $("loginBtn").textContent = config[2];
  $("loginFields").classList.toggle("hidden", mode !== "login");
  $("registerFields").classList.toggle("hidden", mode !== "register");
  $("forgotFields").classList.toggle("hidden", mode !== "forgot");
  document.querySelectorAll(".authMode").forEach((button) => button.classList.toggle("active", button.dataset.authMode === mode));
  $("authSwitch").dataset.activeIndex = String(nextIndex);
  $("loginForm").classList.toggle("wide", mode === "register");
  $("demoAccess")?.classList.toggle("hidden", mode !== "login");
  const activePanel = mode === "login" ? $("loginFields") : mode === "register" ? $("registerFields") : $("forgotFields");
  const loginCopy = document.querySelector(".loginCopy");
  document.querySelectorAll(".authPanel").forEach((panel) => panel.classList.remove("authSlideFromLeft", "authSlideFromRight"));
  loginCopy?.classList.remove("authSlideFromLeft", "authSlideFromRight");
  void activePanel.offsetWidth;
  activePanel.classList.add(animationClass);
  loginCopy?.classList.add(animationClass);
  setLoginMessage();
}

async function login() {
  const identifier = $("loginUser").value.trim();
  const password = $("loginPassword").value;
  const remember = $("rememberLogin").checked;
  if (!identifier || !password) return setLoginMessage("Informe usuário e senha.");
  setBusy($("loginBtn"), true, "Entrando...");
  try {
    const { user } = await apiRequest("/login", { method: "POST", body: { identifier, password, remember } });
    if (remember) localStorage.setItem(LOGIN_ID_KEY, identifier);
    else localStorage.removeItem(LOGIN_ID_KEY);
    await applyAuth(user);
    $("loginPassword").value = "";
  } catch (error) {
    setLoginMessage(error.message);
  } finally {
    setBusy($("loginBtn"), false);
  }
}

async function registerUser() {
  const body = {
    name: $("registerName").value.trim(),
    registration: $("registerRegistration").value.trim(),
    username: $("registerUser").value.trim(),
    email: $("registerEmail").value.trim(),
    password: $("registerPassword").value,
    role: $("registerRole").value,
    teamId: $("registerTeam").value
  };
  if (!body.name || !body.username || !body.email || !body.password || !body.teamId) return setLoginMessage("Preencha os campos obrigatórios.");
  if (["viewer", "monitoring"].includes(body.role) && !body.registration) return setLoginMessage("Informe sua matrícula.");
  if (body.password !== $("registerPasswordConfirm").value) return setLoginMessage("As senhas não conferem.");
  setBusy($("loginBtn"), true, "Enviando...");
  let registered = false;
  try {
    await apiRequest("/register", { method: "POST", body });
    localStorage.setItem(LOGIN_ID_KEY, body.username);
    registered = true;
  } catch (error) {
    setLoginMessage(error.message);
  } finally {
    setBusy($("loginBtn"), false);
  }
  if (registered) {
    setAuthMode("login");
    $("loginUser").value = body.username;
    setLoginMessage("Cadastro enviado. Aguarde a aprovação do administrador.", "success");
  }
}

async function requestPasswordReset() {
  const identifier = $("forgotIdentifier").value.trim();
  if (!identifier) return setLoginMessage("Informe seu usuário ou e-mail.");
  setBusy($("loginBtn"), true, "Enviando...");
  try {
    await apiRequest("/password-reset", { method: "POST", body: { identifier, note: $("forgotNote").value.trim() } });
    setLoginMessage("Pedido registrado. Fale com o administrador para receber a nova senha.", "success");
    $("forgotNote").value = "";
  } catch (error) {
    setLoginMessage(error.message);
  } finally {
    setBusy($("loginBtn"), false);
  }
}

async function submitAuth(event) {
  event.preventDefault();
  if (authMode === "register") return registerUser();
  if (authMode === "forgot") return requestPasswordReset();
  return login();
}

async function hydrateSession() {
  const storedLogin = localStorage.getItem(LOGIN_ID_KEY);
  if (storedLogin) $("loginUser").value = storedLogin;
  try {
    const { user } = await apiRequest("/session");
    await applyAuth(user);
  } catch {
    $("loginScreen").classList.remove("hidden");
  }
}

async function applyAuth(user) {
  currentUser = user;
  $("loginScreen").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("currentUserName").textContent = user.name || user.username;
  $("currentUserRole").textContent = roleLabel(user.role);
  updateCurrentAvatar();
  $("adminNav").classList.toggle("hidden", !canAdmin());
  $("mobileAdminNav").classList.toggle("hidden", !canAdmin());
  $("dashboardNav").classList.toggle("hidden", isBalanceAdjuster());
  $("mobileDashboardNav").classList.toggle("hidden", isBalanceAdjuster());
  $("requestsNav").classList.toggle("hidden", isBalanceAdjuster());
  $("mobileRequestsNav").classList.toggle("hidden", isBalanceAdjuster());
  $("newRequestNav").classList.toggle("hidden", !canRequest() || isBalanceAdjuster());
  $("mobileNewRequestNav").classList.toggle("hidden", !canRequest() || isBalanceAdjuster());
  $("reportsNav").classList.remove("hidden");
  $("mobileReportsNav").classList.remove("hidden");
  $("exportBtn").classList.toggle("hidden", isBalanceAdjuster());
  await loadState(false);
  await loadNotifications(false);
  startNotificationPolling();
  setRoute(isBalanceAdjuster() ? "reports" : "dashboard");
  if (user.mustChangePassword) openPasswordModal(true);
}

async function logout() {
  stopNotificationPolling();
  try { await apiRequest("/logout", { method: "POST" }); } catch {}
  location.reload();
}

async function loadState(notify = true) {
  const button = $("refreshBtn");
  setBusy(button, true, "Atualizando...");
  try {
    const { state } = await apiRequest("/state");
    appState = {
      ...state,
      teams: Array.isArray(state?.teams) ? state.teams : [],
      bankRequests: Array.isArray(state?.bankRequests) ? state.bankRequests : [],
      bankPeople: Array.isArray(state?.bankPeople) ? state.bankPeople : [],
      bankBalances: state?.bankBalances && typeof state.bankBalances === "object" ? state.bankBalances : {},
      bankCalendar: state?.bankCalendar && typeof state.bankCalendar === "object" ? state.bankCalendar : {}
    };
    renderCurrentPage();
    updateNavCount();
    if (notify) showToast("Dados atualizados.");
  } catch (error) {
    if (notify) showToast(error.message, "error");
    else throw error;
  } finally {
    setBusy(button, false);
  }
}

async function loadNotifications(announce = true) {
  if (!currentUser) return;
  try {
    const previousIds = new Set(notifications.map((item) => item.id));
    const payload = await apiRequest("/notifications");
    const next = Array.isArray(payload.notifications) ? payload.notifications : [];
    const fresh = notificationsInitialized ? next.filter((item) => !item.readAt && !previousIds.has(item.id)) : [];
    notifications = next;
    notificationsInitialized = true;
    renderNotificationPanel();
    if (announce && fresh.length) {
      showToast(fresh[0].title);
      fresh.slice(0, 2).forEach(showSystemNotification);
    }
  } catch {
    // Notification polling stays silent when the connection is temporarily unavailable.
  }
}

function startNotificationPolling() {
  stopNotificationPolling();
  notificationPollTimer = setInterval(() => loadNotifications(true), 30_000);
}

function stopNotificationPolling() {
  if (notificationPollTimer) clearInterval(notificationPollTimer);
  notificationPollTimer = null;
}

function renderNotificationPanel() {
  const unread = notifications.filter((item) => !item.readAt).length;
  $("notificationCount").textContent = unread > 99 ? "99+" : String(unread);
  $("notificationCount").classList.toggle("hidden", unread === 0);
  $("notificationSummary").textContent = unread ? `${unread} ${unread === 1 ? "aviso novo" : "avisos novos"}` : "Tudo em dia";
  $("notificationList").innerHTML = notifications.length
    ? notifications.map((item) => `<article class="notificationItem ${safe(item.type)} ${item.readAt ? "read" : "unread"}"><span class="notificationMark"></span><div><strong>${safe(item.title)}</strong><p>${safe(item.message)}</p><small>${safe(formatDateTime(item.createdAt))}</small></div></article>`).join("")
    : `<div class="notificationEmpty">Você ainda não recebeu notificações.</div>`;
  const canEnable = "Notification" in window && Notification.permission === "default";
  $("enableNotificationsBtn").classList.toggle("hidden", !canEnable);
}

async function markNotificationsRead() {
  if (!notifications.some((item) => !item.readAt)) return;
  try {
    const payload = await apiRequest("/notifications/read", { method: "PATCH", body: { all: true } });
    notifications = Array.isArray(payload.notifications) ? payload.notifications : notifications;
    renderNotificationPanel();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function enableSystemNotifications() {
  if (!("Notification" in window)) return showToast("Este aparelho não oferece avisos do navegador.", "error");
  const permission = await Notification.requestPermission();
  renderNotificationPanel();
  showToast(permission === "granted" ? "Avisos ativados neste aparelho." : "Os avisos do aparelho não foram autorizados.", permission === "granted" ? "success" : "error");
}

async function showSystemNotification(item) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.ready : null;
    if (registration) registration.showNotification(item.title, { body: item.message, icon: "/bancoflow-mark.png", badge: "/bancoflow-mark.png", tag: item.id });
    else new Notification(item.title, { body: item.message, icon: "/bancoflow-mark.png", tag: item.id });
  } catch {}
}

function updateNavCount() {
  const count = appState.bankRequests.filter((request) => statusKey(request.status) === "pending").length;
  $("pendingNavCount").textContent = count;
  $("pendingNavCount").classList.toggle("hidden", count === 0);
}

const ROUTES = {
  dashboard: { kicker: "Banco de horas", title: "Visão geral", page: "dashboardPage" },
  "new-request": { kicker: "Banco de horas", title: "Nova solicitação", page: "newRequestPage" },
  requests: { kicker: "Banco de horas", title: "Solicitações", page: "requestsPage" },
  reports: { kicker: "Controle de horas", title: "Saldos e relatórios", page: "reportsPage" },
  admin: { kicker: "Administração", title: "Usuários e acessos", page: "adminPage" }
};

function setRoute(route) {
  if (isBalanceAdjuster() && route !== "reports") route = "reports";
  if (route === "admin" && !canAdmin()) route = "dashboard";
  if (route === "new-request" && !canRequest()) route = "requests";
  currentRoute = ROUTES[route] ? route : "dashboard";
  const config = ROUTES[currentRoute];
  $("pageKicker").textContent = config.kicker;
  $("pageTitle").textContent = config.title;
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === config.page));
  document.querySelectorAll("[data-route]").forEach((button) => button.classList.toggle("active", button.dataset.route === currentRoute));
  $("userMenu").classList.add("hidden");
  renderCurrentPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderCurrentPage() {
  if (!currentUser) return;
  if (currentRoute === "dashboard") renderDashboard();
  if (currentRoute === "new-request") renderNewRequest();
  if (currentRoute === "requests") renderRequestsPage();
  if (currentRoute === "reports") renderReportsPage();
  if (currentRoute === "admin") renderAdminPage();
}

function metricCard(label, value, tone, detail) {
  const marks = { neutral: ICONS.chart, pending: ICONS.clock, approved: ICONS.check, rejected: ICONS.close };
  return `<article class="metricCard ${tone}"><div class="metricTop"><span>${safe(label)}</span><i aria-hidden="true">${marks[tone] || "•"}</i></div><strong>${value}</strong><small>${safe(detail)}</small></article>`;
}

function renderDashboard() {
  const requests = appState.bankRequests;
  const pending = requests.filter((request) => statusKey(request.status) === "pending");
  const approved = requests.filter((request) => statusKey(request.status) === "approved");
  const rejected = requests.filter((request) => statusKey(request.status) === "rejected");
  const actionable = pending.filter(canActOnRequest);
  const recent = [...requests].sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date))).slice(0, 5);
  const mainAction = canReview() && actionable.length
    ? `<button class="primaryBtn" type="button" data-route="requests">Revisar pendências ${ICONS.arrow}</button>`
    : canRequest()
      ? `<button class="primaryBtn" type="button" data-route="new-request">${ICONS.plus} Nova solicitação</button>`
      : `<button class="primaryBtn" type="button" data-route="requests">Ver solicitações ${ICONS.arrow}</button>`;

  const ownOperator = currentOperator();
  const firstMetric = ownOperator
    ? metricCard("Meu saldo", formatHours(bankBalance(ownOperator.id)), "neutral", "horas disponíveis")
    : metricCard("Total", requests.length, "neutral", "solicitações visíveis");
  $("dashboardPage").innerHTML = `
    <div class="welcomeBand">
      <div><span class="eyebrow">Olá, ${safe((currentUser.name || currentUser.username).split(" ")[0])}</span><h2>${dashboardMessage(actionable.length)}</h2><p>${dashboardSupport()}</p></div>
      ${mainAction}
    </div>
    <div class="metricGrid">
      ${firstMetric}
      ${metricCard("Pendentes", pending.length, "pending", canReview() ? "aguardando análise" : "aguardando retorno")}
      ${metricCard("Aprovadas", approved.length, "approved", "pedidos concluídos")}
      ${metricCard("Rejeitadas", rejected.length, "rejected", "pedidos não aprovados")}
    </div>
    <div class="dashboardAnalytics">
      <article class="panel trendPanel">
        <div class="panelHeader chartHeader"><div><span class="eyebrow">Volume de pedidos</span><h2>Solicitações por data</h2><p>Distribuição dos pedidos nas datas escolhidas.</p></div><span class="liveBadge"><i></i> Dados atuais</span></div>
        ${renderRequestTrend(requests)}
      </article>
      <article class="panel recentPanel">
        <div class="panelHeader"><div><span class="eyebrow">Movimentação recente</span><h2>Últimas solicitações</h2></div><button class="textBtn" type="button" data-route="requests">Ver todas ${ICONS.arrow}</button></div>
        ${recent.length ? `<div class="compactRequestList">${recent.map(renderCompactRequest).join("")}</div>` : emptyState("Nenhuma solicitação registrada", "Os novos pedidos aparecerão aqui.")}
      </article>
    </div>
    <div class="dashboardSecondary">
      <article class="panel statusPanel">
        <div class="panelHeader"><div><span class="eyebrow">Andamento</span><h2>Status dos pedidos</h2></div></div>
        ${renderStatusOverview(pending.length, approved.length, rejected.length)}
      </article>
      <article class="panel summaryPanel">
        <div class="panelHeader"><div><span class="eyebrow">Distribuição</span><h2>Por equipe</h2></div></div>
        ${renderTeamSummary(requests)}
      </article>
      <article class="panel quickPanel">
        <div class="panelHeader"><div><span class="eyebrow">Acesso rápido</span><h2>Atalhos</h2></div></div>
        <div class="quickActions">
          ${canRequest() ? `<button type="button" data-route="new-request"><span>${ICONS.plus}</span><strong>Nova solicitação</strong><small>Escolher uma data</small></button>` : ""}
          <button type="button" data-route="requests"><span>${ICONS.arrow}</span><strong>Solicitações</strong><small>Acompanhar pedidos</small></button>
          <button type="button" data-route="reports"><span>${ICONS.chart}</span><strong>Relatórios</strong><small>Consultar saldos</small></button>
        </div>
      </article>
    </div>`;
}

function renderRequestTrend(requests) {
  const validDates = [...new Set(requests.map((request) => request.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))];
  const today = new Date(`${localDateKey()}T12:00:00`);
  for (let offset = 0; validDates.length < 7 && offset < 14; offset += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (!validDates.includes(key)) validDates.push(key);
  }

  const sortedDates = validDates.sort();
  const upcomingDates = sortedDates.filter((date) => date >= localDateKey());
  const dates = (upcomingDates.length ? upcomingDates.slice(0, 8) : sortedDates.slice(-8));
  const values = dates.map((date) => requests.filter((request) => request.date === date).length);
  const width = 720;
  const height = 250;
  const left = 38;
  const right = 16;
  const top = 18;
  const bottom = 42;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = left + (dates.length === 1 ? chartWidth / 2 : index * chartWidth / (dates.length - 1));
    const y = top + chartHeight - value / max * chartHeight;
    return { x, y, value, date: dates[index] };
  });
  const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = points.length ? `${line} L${points[points.length - 1].x.toFixed(1)},${top + chartHeight} L${points[0].x.toFixed(1)},${top + chartHeight} Z` : "";
  const grid = [0, 1, 2, 3].map((index) => {
    const y = top + chartHeight * index / 3;
    const value = Math.round(max * (1 - index / 3));
    return `<g><line class="chartGridLine" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line><text class="chartAxisLabel" x="${left - 10}" y="${y + 4}" text-anchor="end">${value}</text></g>`;
  }).join("");
  const labels = points.map((point) => `<text class="chartAxisLabel" x="${point.x}" y="${height - 13}" text-anchor="middle">${formatDate(point.date).slice(0, 5)}</text>`).join("");
  const dots = points.map((point) => `<g><circle class="chartPointHalo" cx="${point.x}" cy="${point.y}" r="8"></circle><circle class="chartPoint" cx="${point.x}" cy="${point.y}" r="4"></circle><title>${formatDate(point.date)}: ${point.value} ${point.value === 1 ? "pedido" : "pedidos"}</title></g>`).join("");

  return `<div class="trendChart" role="img" aria-label="Gráfico de solicitações por data">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs><linearGradient id="requestArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".24"></stop><stop offset=".58" stop-color="#b8b8bc" stop-opacity=".1"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></linearGradient></defs>
      ${grid}<path class="chartArea" d="${area}"></path><path class="chartLine" d="${line}"></path>${dots}${labels}
    </svg>
  </div>`;
}

function renderStatusOverview(pending, approved, rejected) {
  const total = pending + approved + rejected;
  const pendingEnd = total ? pending / total * 100 : 0;
  const approvedEnd = total ? pendingEnd + approved / total * 100 : 0;
  const background = total
    ? `conic-gradient(var(--yellow) 0 ${pendingEnd}%, var(--green-bright) ${pendingEnd}% ${approvedEnd}%, var(--red-bright) ${approvedEnd}% 100%)`
    : "var(--surface-3)";
  return `<div class="statusOverview">
    <div class="statusDonut" style="background:${background}"><span><strong>${total}</strong><small>Total</small></span></div>
    <div class="statusLegend">
      <div><i class="pending"></i><span>Pendentes</span><strong>${pending}</strong></div>
      <div><i class="approved"></i><span>Aprovadas</span><strong>${approved}</strong></div>
      <div><i class="rejected"></i><span>Rejeitadas</span><strong>${rejected}</strong></div>
    </div>
  </div>`;
}

function dashboardMessage(pendingCount) {
  if (canReview() && pendingCount) return `${pendingCount} ${pendingCount === 1 ? "solicitação aguarda" : "solicitações aguardam"} sua análise`;
  if (canRequest()) return "Acompanhe seus pedidos em um só lugar";
  return "Acompanhe as solicitações das equipes";
}

function dashboardSupport() {
  if (canReview()) return "Analise pedidos pendentes e consulte as decisões já registradas.";
  if (canRequest()) return "Registre uma nova solicitação e acompanhe cada etapa da aprovação.";
  return "Consulte o andamento e as observações de cada solicitação.";
}

function renderCompactRequest(request) {
  const status = statusKey(request.status);
  const person = allOperators().find((item) => item.id === request.operatorId) || request.requestedBy || { name: request.operatorName };
  return `<button class="compactRequest" type="button" data-route="requests" aria-label="Ver solicitação de ${safe(request.operatorName)}">
    ${avatarMarkup(person, `teamAvatar team-${safe(request.teamId)}`)}
    <span class="compactMain"><strong>${safe(request.operatorName)}</strong><small>${safe(teamName(request.teamId))} · ${formatDate(request.date)}</small></span>
    <span class="statusPill ${status}">${safe(workflowLabel(request))}</span>
  </button>`;
}

function renderTeamSummary(requests) {
  if (!requests.length) return emptyState("Sem dados para comparar", "A distribuição será exibida após o primeiro pedido.");
  const teams = [...appState.teams, { id: "gestao", name: "Gestão" }];
  const entries = teams.map((team) => ({ team, count: requests.filter((request) => request.teamId === team.id).length })).filter((item) => item.count);
  const max = Math.max(1, ...entries.map((item) => item.count));
  return `<div class="teamSummary">${entries.map(({ team, count }) => `<div class="teamSummaryRow"><div><span>${safe(team.name)}</span><strong>${count}</strong></div><div class="barTrack"><span class="team-${safe(team.id)}" style="width:${Math.max(7, count / max * 100)}%"></span></div></div>`).join("")}</div>`;
}

function emptyState(title, text) {
  return `<div class="emptyState"><span class="emptyIcon">${ICONS.empty}</span><strong>${safe(title)}</strong><p>${safe(text)}</p></div>`;
}

function renderNewRequest() {
  const person = allOperators().find((item) => item.id === currentUser.id);
  if (!person) {
    $("newRequestPage").innerHTML = emptyState("Cadastro não disponível", "Seu perfil não possui um fluxo de solicitação ativo.");
    return;
  }
  const selectedDate = selectedRequestDate || localDateKey();
  const balance = bankBalance(person.id);
  $("newRequestPage").innerHTML = `
    <div class="formPageGrid">
      <article class="panel requestFormPanel">
        <div class="panelHeader"><div><span class="eyebrow">Novo pedido</span><h2>Solicitar banco de horas</h2><p>Preencha os dados abaixo para encaminhar a solicitação.</p></div></div>
        <form id="bankRequestForm" class="requestForm">
          <div class="formGrid twoCols">
            <div class="requesterCard spanTwo">${avatarMarkup(person)}<div><small>Solicitante</small><strong>${safe(person.name)}</strong><span>${safe(roleLabel(person.role))}${person.teamId ? ` · Equipe ${safe(teamName(person.teamId))}` : ""}</span></div></div>
            <label class="spanTwo">Data escolhida<div id="requestDateDisplay" class="dateDisplay">${formatDate(selectedDate)}</div><input id="requestDate" type="hidden" value="${safe(selectedDate)}"></label>
            <fieldset class="requestTypeField spanTwo">
              <legend>Tipo da solicitação</legend>
              <div class="requestTypeOptions">
                <label class="requestTypeOption"><input type="radio" name="requestType" value="full_leave" required><span><strong>Dispensa integral</strong><small>Desconto fixo de 07:20</small></span></label>
                <label class="requestTypeOption"><input type="radio" name="requestType" value="partial_exit" required><span><strong>Saída parcial</strong><small>Informe o período utilizado</small></span></label>
                <label class="requestTypeOption"><input type="radio" name="requestType" value="late_entry" required><span><strong>Entrada com atraso</strong><small>Informe o período utilizado</small></span></label>
              </div>
            </fieldset>
            <div id="fixedRequestHours" class="fixedHoursNotice spanTwo hidden"><span>Horas que serão descontadas</span><strong>07:20</strong></div>
            <label id="requestHoursField" class="spanTwo hidden">Quantidade de horas<input id="requestHours" data-duration-input type="text" inputmode="numeric" maxlength="8" placeholder="00:00" aria-describedby="requestHoursHint"><small id="requestHoursHint" class="fieldHint">Use horas e minutos. Ex.: 02:30</small></label>
            <div class="balancePreview spanTwo"><span>Saldo disponível</span><strong id="requestBalance" class="${balance < 0 ? "negativeValue" : ""}">${formatHours(balance)}</strong><small id="balanceHint">${balanceHint(balance)}</small></div>
            <label class="spanTwo">Motivo<textarea id="requestReason" maxlength="500" placeholder="Descreva o motivo da solicitação"></textarea></label>
          </div>
          <div id="echoRouteNote" class="infoNote ${person.teamId === "echo" ? "" : "hidden"}">A solicitação da equipe Vértice será encaminhada automaticamente ao líder responsável pela data escolhida.</div>
          <div class="formActions"><button class="ghostBtn" type="button" data-route="dashboard">Cancelar</button><button id="submitRequestBtn" class="primaryBtn" type="submit">${ICONS.plus} Enviar solicitação</button></div>
        </form>
      </article>
      <aside id="smartCalendar" class="calendarPanel">${renderSmartCalendar()}</aside>
    </div>`;
  $("bankRequestForm").addEventListener("submit", submitBankRequest);
  document.querySelectorAll('input[name="requestType"]').forEach((input) => input.addEventListener("change", updateRequestTypeFields));
}

function updateRequestTypeFields() {
  const type = document.querySelector('input[name="requestType"]:checked')?.value || "";
  const customHours = type === "partial_exit" || type === "late_entry";
  $("fixedRequestHours")?.classList.toggle("hidden", type !== "full_leave");
  $("requestHoursField")?.classList.toggle("hidden", !customHours);
  if ($("requestHours")) {
    $("requestHours").required = customHours;
    if (!customHours) $("requestHours").value = "";
  }
}

function renderSmartCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let index = 0; index < firstWeekday; index += 1) cells.push('<span class="calendarBlank"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const count = Math.min(3, Number(appState.bankCalendar?.[date]) || 0);
    const state = count === 1 ? "available" : count === 2 ? "attention" : count >= 3 ? "full" : "empty";
    const label = count === 0 ? "Livre" : count === 1 ? "1 pedido" : `${count} pedidos`;
    cells.push(`<button class="calendarDay ${state} ${date === selectedRequestDate ? "selected" : ""}" type="button" data-calendar-date="${date}" ${count >= 3 ? "disabled" : ""} aria-label="${day} de ${calendarMonth.toLocaleDateString("pt-BR", { month: "long" })}: ${label}"><span>${day}</span><small>${count || ""}</small></button>`);
  }
  return `<div class="calendarHeader"><div><span class="eyebrow">Disponibilidade</span><h2>Escolha uma data</h2></div><div class="calendarControls"><button class="iconBtn" type="button" data-action="calendar-prev" aria-label="Mês anterior">‹</button><strong>${calendarMonth.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong><button class="iconBtn" type="button" data-action="calendar-next" aria-label="Próximo mês">›</button></div></div><div class="calendarWeekdays"><span>DOM</span><span>SEG</span><span>TER</span><span>QUA</span><span>QUI</span><span>SEX</span><span>SÁB</span></div><div class="calendarGrid">${cells.join("")}</div><div class="calendarLegend"><span><i class="available"></i>1 pedido</span><span><i class="attention"></i>2 pedidos</span><span><i class="full"></i>3 pedidos · lotado</span></div><p class="calendarHelp">Ao atingir três solicitações, o dia é bloqueado automaticamente.</p>`;
}

function refreshCalendar() {
  if ($("smartCalendar")) $("smartCalendar").innerHTML = renderSmartCalendar();
}

function selectCalendarDate(date) {
  if ((Number(appState.bankCalendar?.[date]) || 0) >= 3) return showToast("Esta data já atingiu o limite de solicitações.", "error");
  selectedRequestDate = date;
  const input = $("requestDate");
  if (input) input.value = date;
  const display = $("requestDateDisplay");
  if (display) display.textContent = formatDate(date);
  refreshCalendar();
}

async function submitBankRequest(event) {
  event.preventDefault();
  const date = $("requestDate").value;
  const requestType = document.querySelector('input[name="requestType"]:checked')?.value || "";
  const hours = requestType === "full_leave" ? FULL_LEAVE_HOURS : parseHours($("requestHours").value);
  if (!date) return showToast("Informe a data.", "error");
  if (!requestType) return showToast("Escolha o tipo da solicitação.", "error");
  if (!Number.isFinite(hours) || hours <= 0) return showToast("Informe as horas no formato 00:00.", "error");
  const balance = bankBalance(currentUser.id);
  if (balance - hours < MIN_BANK_BALANCE) return showToast(`Este pedido ultrapassa o limite de -14:00. Você ainda pode solicitar ${formatHours(Math.max(0, balance - MIN_BANK_BALANCE))}.`, "error");
  const button = $("submitRequestBtn");
  setBusy(button, true, "Enviando...");
  try {
    await apiRequest("/bank-requests", { method: "POST", body: {
      date,
      requestType,
      hours,
      reason: $("requestReason").value.trim()
    }});
    await loadState(false);
    requestFilters = { status: "all", team: "all", query: "" };
    setRoute("requests");
    showToast("Solicitação enviada com sucesso.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function filteredRequests() {
  const query = requestFilters.query.toLocaleLowerCase("pt-BR");
  return [...appState.bankRequests]
    .filter((request) => requestFilters.status === "all" || statusKey(request.status) === requestFilters.status)
    .filter((request) => requestFilters.team === "all" || request.teamId === requestFilters.team || request.reviewTeamId === requestFilters.team)
    .filter((request) => !query || [request.operatorName, request.reason, teamName(request.teamId), request.coordinatorNote, requestTypeLabel(request.requestType)].some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query)))
    .sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)));
}

function renderRequestsPage() {
  const rows = filteredRequests();
  $("requestsPage").innerHTML = `
    <article class="panel requestsPanel">
      <div class="panelHeader requestsHeader"><div><span class="eyebrow">Histórico completo</span><h2>Solicitações de banco</h2><p>${rows.length} ${rows.length === 1 ? "registro encontrado" : "registros encontrados"}</p></div>${canRequest() ? `<button class="primaryBtn" type="button" data-route="new-request">${ICONS.plus} Nova solicitação</button>` : ""}</div>
      <div class="filterBar">
        <label class="searchField"><span>Buscar</span><input id="requestSearch" type="search" placeholder="Nome, equipe ou motivo" value="${safe(requestFilters.query)}"></label>
        <label><span>Status</span><select id="requestStatusFilter"><option value="all">Todos</option><option value="pending" ${requestFilters.status === "pending" ? "selected" : ""}>Pendentes</option><option value="approved" ${requestFilters.status === "approved" ? "selected" : ""}>Aprovados</option><option value="rejected" ${requestFilters.status === "rejected" ? "selected" : ""}>Rejeitados</option></select></label>
        <label><span>Equipe</span><select id="requestTeamFilter"><option value="all">Todas</option>${appState.teams.map((team) => `<option value="${safe(team.id)}" ${requestFilters.team === team.id ? "selected" : ""}>${safe(team.name)}</option>`).join("")}</select></label>
      </div>
      ${rows.length ? `<div class="requestList">${rows.map(renderRequestCard).join("")}</div>` : emptyState("Nenhum pedido encontrado", "Ajuste os filtros ou registre uma nova solicitação.")}
    </article>`;
  $("requestSearch").addEventListener("input", debounce((event) => { requestFilters.query = event.target.value; renderRequestsPage(); }, 180));
  $("requestStatusFilter").addEventListener("change", (event) => { requestFilters.status = event.target.value; renderRequestsPage(); });
  $("requestTeamFilter").addEventListener("change", (event) => { requestFilters.team = event.target.value; renderRequestsPage(); });
}

function renderRequestCard(request) {
  const status = statusKey(request.status);
  const pending = status === "pending";
  const person = allOperators().find((item) => item.id === request.operatorId) || request.requestedBy || { name: request.operatorName };
  const destination = request.reviewTeamId && request.reviewTeamId !== request.teamId
    ? `<span><b>Destino</b>${safe(teamName(request.reviewTeamId))}${request.reviewLeaderName ? ` · ${safe(request.reviewLeaderName)}` : ""}</span>` : "";
  return `<article class="requestCard ${status}">
    <div class="requestStripe"></div>
    <div class="requestIdentity">${avatarMarkup(person, `teamAvatar team-${safe(request.teamId)}`)}<div><strong>${safe(request.operatorName)}</strong><small>${safe(roleLabel(request.requesterRole || person?.role))}${request.teamId !== "gestao" ? ` · Equipe ${safe(teamName(request.teamId))}` : ""}${person?.registration ? ` · ${safe(person.registration)}` : ""}</small></div></div>
    <div class="requestDetails"><span><b>Data</b>${formatDate(request.date)}</span><span><b>Tipo</b>${safe(requestTypeLabel(request.requestType))}</span><span><b>Horas</b>${request.hours ? formatHours(request.hours) : "Não informado"}</span><span><b>Motivo</b>${safe(request.reason || "Sem motivo informado")}</span>${destination}${request.coordinatorNote ? `<span class="requestNote"><b>Observação</b>${safe(request.coordinatorNote)}</span>` : ""}</div>
    <div class="requestDecision"><span class="statusPill ${status}">${safe(workflowLabel(request))}</span>${request.reviewedAt ? `<small>Atualizado em ${formatDateTime(request.reviewedAt)}</small>` : request.leaderCheckedAt ? `<small>Check do líder: ${formatDateTime(request.leaderCheckedAt)}</small>` : `<small>Enviado em ${formatDateTime(request.createdAt) || formatDate(request.date)}</small>`}</div>
    <div class="requestActions">
      ${canAcknowledgeRequest(request) && pending ? `<button class="warningBtn" type="button" data-action="bank-acknowledge" data-id="${safe(request.id)}">${ICONS.check}<span>Dar check</span></button>` : ""}
      ${canFinalizeRequest(request) && pending ? `<button class="approveBtn" type="button" data-action="bank-status" data-id="${safe(request.id)}" data-status="Aprovado">${ICONS.check}<span>Aprovar</span></button><button class="rejectBtn" type="button" data-action="bank-status" data-id="${safe(request.id)}" data-status="Rejeitado">${ICONS.close}<span>Rejeitar</span></button>` : ""}
      ${canAddNote() ? `<button class="noteBtn" type="button" data-action="bank-note" data-id="${safe(request.id)}">${ICONS.note}<span>${request.coordinatorNote ? "Editar observação" : "Observação"}</span></button>` : ""}
      ${canAdmin() ? `<button class="deleteBtn" type="button" data-action="bank-delete" data-id="${safe(request.id)}">${ICONS.trash}<span>Excluir</span></button>` : ""}
    </div>
  </article>`;
}

async function acknowledgeBankRequest(id) {
  if (!confirm("Confirmar que o líder visualizou esta solicitação?")) return;
  try {
    await apiRequest(`/bank-requests/${encodeURIComponent(id)}`, { method: "PATCH", body: { action: "acknowledge" } });
    await loadState(false);
    showToast("Check registrado. A solicitação foi enviada ao supervisor.");
  } catch (error) { showToast(error.message, "error"); }
}

async function updateBankStatus(id, status) {
  const label = status === "Aprovado" ? "aprovar" : "rejeitar";
  if (!confirm(`Deseja ${label} esta solicitação?`)) return;
  try {
    await apiRequest(`/bank-requests/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
    await loadState(false);
    showToast(`Solicitação ${status.toLowerCase()}.`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteBankRequest(id) {
  const request = appState.bankRequests.find((item) => item.id === id);
  if (!request) return;
  const restoreNotice = statusKey(request.status) === "approved" && Number(request.hours) > 0
    ? ` As ${formatHours(request.deductedHours || request.hours)} serão devolvidas ao saldo.`
    : "";
  if (!confirm(`Excluir a solicitação de ${request.operatorName} para ${formatDate(request.date)}?${restoreNotice} Esta ação não pode ser desfeita.`)) return;
  try {
    const result = await apiRequest(`/bank-requests/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadState(false);
    showToast(result.restoredHours ? `Solicitação excluída e ${formatHours(result.restoredHours)} devolvidas ao saldo.` : "Solicitação excluída.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function openNoteModal(id) {
  const request = appState.bankRequests.find((item) => item.id === id);
  if (!request) return;
  openModal(`<div class="modalHeader"><div><span class="eyebrow">Solicitação</span><h2 id="modalTitle">Adicionar observação</h2></div><button class="iconBtn" type="button" data-action="close-modal" aria-label="Fechar">${ICONS.close}</button></div>
    <p class="modalIntro">${safe(request.operatorName)} · ${safe(teamName(request.teamId))} · ${formatDate(request.date)}</p>
    <label>Observação<textarea id="bankNoteText" maxlength="700" placeholder="Digite a orientação ou informação necessária">${safe(request.coordinatorNote || "")}</textarea></label>
    <div class="modalActions"><button class="ghostBtn" type="button" data-action="close-modal">Cancelar</button><button class="primaryBtn" type="button" data-action="save-bank-note" data-id="${safe(id)}">Salvar observação</button></div>`);
}

async function saveBankNote(id) {
  try {
    await apiRequest(`/bank-requests/${encodeURIComponent(id)}`, { method: "PATCH", body: { coordinatorNote: $("bankNoteText").value.trim() } });
    closeModal();
    await loadState(false);
    showToast("Observação salva.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderReportsPage() {
  const operators = allOperators().filter((operator) => operator.active !== false);
  const positiveHours = operators.reduce((sum, operator) => sum + Math.max(0, bankBalance(operator.id)), 0);
  const negativeHours = Math.abs(operators.reduce((sum, operator) => sum + Math.min(0, bankBalance(operator.id)), 0));
  const ownOperator = operators.length === 1 && operators[0].id === currentUser.id ? operators[0] : null;
  const approvedHours = appState.bankRequests
    .filter((request) => statusKey(request.status) === "approved" && (!ownOperator || request.operatorId === ownOperator.id))
    .reduce((sum, request) => sum + (Number(request.hours) || 0), 0);
  const reportMetrics = ownOperator
    ? `${metricCard("Saldo atual", formatHours(bankBalance(ownOperator.id)), bankBalance(ownOperator.id) < 0 ? "rejected" : "neutral", bankBalance(ownOperator.id) < 0 ? "horas que precisam ser compensadas" : "crédito disponível para solicitações")}
      ${metricCard("Horas utilizadas", formatHours(approvedHours), "approved", "total de solicitações aprovadas")}
      ${metricCard("Margem disponível", formatHours(Math.max(0, bankBalance(ownOperator.id) - MIN_BANK_BALANCE)), "pending", "antes de atingir o limite de -14:00")}`
    : `${metricCard("Créditos disponíveis", formatHours(positiveHours), "neutral", "soma apenas dos saldos positivos")}
      ${metricCard("Horas a compensar", formatHours(negativeHours), "rejected", "soma apenas dos saldos negativos")}
      ${metricCard("Pessoas acompanhadas", operators.length, "pending", "cadastros reais disponíveis nesta visão")}`;
  $("reportsPage").innerHTML = `
    <div class="reportMetrics">
      ${reportMetrics}
    </div>
    <article class="panel balancePanel">
      <div class="panelHeader"><div><span class="eyebrow">Controle individual</span><h2>Saldo de horas por pessoa</h2><p>${isBalanceAdjuster() || ["admin", "coordinator"].includes(currentUser.role) ? "Consulte e ajuste os saldos de todas as pessoas." : currentUser.role === "leader" ? "Consulte todos e ajuste apenas os saldos da sua equipe." : canViewAllPeople() ? "Consulte os saldos de todas as pessoas." : "Consulte apenas o seu saldo e as horas disponíveis para novas solicitações."}</p></div>${canManageBalances() ? '<span class="permissionTag">Edição autorizada</span>' : '<span class="permissionTag viewOnly">Somente leitura</span>'}</div>
      ${operators.length > 1 ? `<label class="balanceSearch"><span>Buscar pessoa</span><input id="balanceSearch" type="search" value="${safe(balanceSearch)}" placeholder="Nome, matrícula ou equipe" autocomplete="off"></label>` : ""}
      <div id="balanceRows">${renderBalanceRows(operators)}</div>
    </article>`;
  $("balanceSearch")?.addEventListener("input", (event) => {
    balanceSearch = event.target.value;
    $("balanceRows").innerHTML = renderBalanceRows(operators);
  });
}

function renderBalanceRows(operators = allOperators().filter((operator) => operator.active !== false)) {
  const query = balanceSearch.trim().toLocaleLowerCase("pt-BR");
  const filtered = query ? operators.filter((operator) => [operator.name, operator.registration, operator.teamName, roleLabel(operator.role)].some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query))) : operators;
  return filtered.length
    ? `<div class="balanceList">${filtered.map(renderBalanceRow).join("")}</div>`
    : emptyState("Nenhuma pessoa encontrada", "Tente buscar por outro nome, matrícula ou equipe.");
}

function renderBalanceRow(operator) {
  const balance = bankBalance(operator.id);
  const approved = appState.bankRequests.filter((request) => request.operatorId === operator.id && statusKey(request.status) === "approved").reduce((sum, request) => sum + (Number(request.hours) || 0), 0);
  return `<article class="balanceRow">
    <div class="balanceIdentity">${avatarMarkup(operator, `teamAvatar team-${safe(operator.teamId)}`)}<div><strong>${safe(operator.name)}</strong><small>${safe(roleLabel(operator.role))}${operator.registration ? ` · ${safe(operator.registration)}` : ""}${operator.teamId ? ` · Equipe ${safe(operator.teamName)}` : ""}</small></div></div>
    <div class="balanceHistory"><span class="${balance < 0 ? "negativeValue" : ""}"><b>Saldo atual</b>${formatHours(balance)}</span><span><b>Já aprovado</b>${formatHours(approved)}</span></div>
    ${canEditBalance(operator) ? `<div class="balanceEditor"><label>Novo saldo<input data-balance-input="${safe(operator.id)}" data-duration-input type="text" inputmode="numeric" maxlength="8" value="${formatHours(balance)}" placeholder="00:00"></label><button class="primaryBtn" type="button" data-action="save-balance" data-operator="${safe(operator.id)}">Salvar</button></div>` : `<strong class="balanceValue ${balance < 0 ? "negativeValue" : ""}">${formatHours(balance)}</strong>`}
  </article>`;
}

async function saveBalance(operatorId) {
  const input = document.querySelector(`[data-balance-input="${CSS.escape(operatorId)}"]`);
  const hours = parseHours(input?.value);
  if (!Number.isFinite(hours) || hours < MIN_BANK_BALANCE) return showToast("Informe um saldo de no mínimo -14:00, no formato 00:00.", "error");
  try {
    await apiRequest(`/bank-balances/${encodeURIComponent(operatorId)}`, { method: "PATCH", body: { hours } });
    await loadState(false);
    showToast("Saldo atualizado.");
  } catch (error) { showToast(error.message, "error"); }
}

async function renderAdminPage() {
  if (!canAdmin()) return;
  $("adminPage").innerHTML = `<div class="adminGrid"><article class="panel createUserPanel"><div class="panelHeader"><div><span class="eyebrow">Novo acesso</span><h2>Criar usuário</h2><p>Cadastre operadores e responsáveis pelo fluxo de aprovação.</p></div></div>${renderCreateUserForm()}</article><article class="panel usersPanel"><div class="panelHeader"><div><span class="eyebrow">Controle de acesso</span><h2>Usuários cadastrados</h2></div></div><div id="usersList" class="loadingState">Carregando usuários...</div></article></div>`;
  $("createUserForm").addEventListener("submit", createUser);
  $("userRole").addEventListener("change", () => updateTeamField($("userRole").value, $("userTeamField"), $("userTeam")));
  updateTeamField($("userRole").value, $("userTeamField"), $("userTeam"));
  try {
    users = (await apiRequest("/users")).users || [];
    renderUsersList();
  } catch (error) {
    $("usersList").innerHTML = emptyState("Não foi possível carregar", error.message);
  }
}

function renderCreateUserForm() {
  return `<form id="createUserForm" class="requestForm"><div class="formGrid twoCols">
    <label>Nome completo<input id="userName" type="text" required placeholder="Nome do usuário"></label>
    <label>Matrícula<input id="userRegistration" type="text" placeholder="13.000"></label>
    <label>Usuário<input id="userLogin" type="text" required placeholder="usuario"></label>
    <label>E-mail<input id="userEmail" type="email" required placeholder="usuario@empresa.com"></label>
    <label>Perfil<select id="userRole"><option value="viewer">Operador</option><option value="monitoring">Monitoramento</option><option value="leader">Líder de equipe</option><option value="assistant">Assistente</option><option value="analyst">Analista</option><option value="supervisor">Supervisor</option><option value="coordinator">Coordenador</option><option value="balance_adjuster">Ajuste de horas</option><option value="admin">Administrador</option></select></label>
    <label id="userTeamField">Equipe<select id="userTeam"><option value="">Todas</option>${appState.teams.map((team) => `<option value="${safe(team.id)}">${safe(team.name)}</option>`).join("")}</select></label>
    <label class="spanTwo">Senha temporária<input id="userPassword" type="password" required minlength="6" placeholder="Mínimo 6 caracteres"></label>
  </div><button id="createUserBtn" class="primaryBtn fullBtn" type="submit">${ICONS.plus} Criar usuário</button></form>`;
}

function renderUsersList() {
  if (!$("usersList")) return;
  if (!users.length) {
    $("usersList").innerHTML = emptyState("Nenhum usuário cadastrado", "Crie o primeiro acesso pelo formulário.");
    return;
  }
  $("usersList").innerHTML = `<div class="userList">${users.map((user) => `<article class="userRow">
    <div class="userMain">${avatarMarkup(user)}<div><strong>${safe(user.name)}</strong><small>${safe(user.email)}</small><span class="userStatus ${user.active ? "active" : user.pendingApproval ? "pending" : "blocked"}">${user.active ? "Ativo" : user.pendingApproval ? "Aguardando aprovação" : "Bloqueado"}</span></div></div>
    <div class="userFields"><label>Matrícula<input data-user-registration="${safe(user.id)}" value="${safe(user.registration || "")}" placeholder="13.000"></label><label>Perfil<select data-user-role="${safe(user.id)}" ${user.role === "admin" ? 'disabled title="Perfil de administrador protegido"' : ""}>${["viewer", "monitoring", "leader", "assistant", "analyst", "supervisor", "coordinator", "balance_adjuster", "admin"].map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}</select></label><label data-user-team-field="${safe(user.id)}" class="${roleNeedsTeam(user.role) ? "" : "hidden"}">Equipe<select data-user-team="${safe(user.id)}" ${roleNeedsTeam(user.role) ? "" : "disabled"}><option value="">Todas</option>${appState.teams.map((team) => `<option value="${safe(team.id)}" ${user.teamId === team.id ? "selected" : ""}>${safe(team.name)}</option>`).join("")}</select></label></div>
    <div class="userActions"><button class="smallBtn" type="button" data-action="save-user" data-user="${safe(user.id)}">Salvar</button><button class="smallBtn" type="button" data-action="reset-user-password" data-user="${safe(user.id)}">Senha</button><button class="${user.active ? "warningBtn" : "approveBtn"}" type="button" data-action="toggle-user" data-user="${safe(user.id)}" data-active="${!user.active}">${user.active ? "Bloquear" : user.pendingApproval ? "Aprovar" : "Ativar"}</button>${user.id !== currentUser.id ? `<button class="rejectBtn" type="button" data-action="delete-user" data-user="${safe(user.id)}" aria-label="Excluir ${safe(user.name)}">Excluir</button>` : ""}</div>
  </article>`).join("")}</div>`;
  document.querySelectorAll("[data-user-role]").forEach((select) => select.addEventListener("change", () => {
    const id = select.dataset.userRole;
    updateTeamField(select.value, document.querySelector(`[data-user-team-field="${CSS.escape(id)}"]`), document.querySelector(`[data-user-team="${CSS.escape(id)}"]`));
  }));
}

async function createUser(event) {
  event.preventDefault();
  const button = $("createUserBtn");
  setBusy(button, true, "Criando...");
  try {
    await apiRequest("/users", { method: "POST", body: {
      name: $("userName").value.trim(), registration: $("userRegistration").value.trim(), username: $("userLogin").value.trim(), email: $("userEmail").value.trim(), role: $("userRole").value, teamId: $("userTeam").value, password: $("userPassword").value
    }});
    showToast("Usuário criado.");
    await renderAdminPage();
  } catch (error) {
    showToast(error.message, "error");
  } finally { setBusy(button, false); }
}

async function saveUser(id) {
  try {
    await apiRequest(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: {
      registration: document.querySelector(`[data-user-registration="${CSS.escape(id)}"]`).value.trim(),
      role: document.querySelector(`[data-user-role="${CSS.escape(id)}"]`).value,
      teamId: document.querySelector(`[data-user-team="${CSS.escape(id)}"]`).value
    }});
    showToast("Usuário atualizado.");
    await renderAdminPage();
  } catch (error) { showToast(error.message, "error"); }
}

async function toggleUser(id, active) {
  try {
    await apiRequest(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: { active } });
    showToast(active ? "Acesso ativado." : "Acesso bloqueado.");
    await renderAdminPage();
  } catch (error) { showToast(error.message, "error"); }
}

function openResetPasswordModal(id) {
  const user = users.find((item) => item.id === id);
  if (!user) return;
  openModal(`<div class="modalHeader"><div><span class="eyebrow">Usuário</span><h2 id="modalTitle">Redefinir senha</h2></div><button class="iconBtn" type="button" data-action="close-modal">${ICONS.close}</button></div><p class="modalIntro">${safe(user.name)}</p><label>Nova senha temporária<input id="resetUserPassword" type="password" minlength="6" placeholder="Mínimo 6 caracteres"></label><div class="modalActions"><button class="ghostBtn" type="button" data-action="close-modal">Cancelar</button><button class="primaryBtn" type="button" data-action="save-user-password" data-user="${safe(id)}">Redefinir</button></div>`);
}

async function saveUserPassword(id) {
  const password = $("resetUserPassword").value;
  if (password.length < 6) return showToast("A senha precisa ter pelo menos 6 caracteres.", "error");
  try {
    await apiRequest(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: { password } });
    closeModal();
    showToast("Senha temporária definida.");
  } catch (error) { showToast(error.message, "error"); }
}

async function deleteUser(id) {
  const user = users.find((item) => item.id === id);
  if (!user || !confirm(`Excluir o usuário ${user.name}?`)) return;
  try {
    await apiRequest(`/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("Usuário excluído.");
    await renderAdminPage();
  } catch (error) { showToast(error.message, "error"); }
}

function openProfilePhotoModal() {
  profilePhotoDraft = currentUser?.profilePhoto || "";
  openModal(`<div class="modalHeader"><div><span class="eyebrow">Minha conta</span><h2 id="modalTitle">Foto de perfil</h2></div><button class="iconBtn" type="button" data-action="close-modal">${ICONS.close}</button></div>
    <p class="modalIntro">Escolha uma foto nítida. Ela aparecerá na sua conta, nas solicitações e na consulta de saldos.</p>
    <div class="profilePhotoEditor">
      <div id="profilePhotoPreview" class="profilePhotoPreview">${avatarMarkup(currentUser, "profileAvatar")}</div>
      <label class="photoPicker">Escolher foto<input id="profilePhotoInput" type="file" accept="image/*"></label>
      <small>Formatos aceitos: JPG, PNG ou WebP.</small>
    </div>
    <div class="modalActions"><button class="ghostBtn" type="button" data-action="remove-profile-photo">Remover foto</button><button class="primaryBtn" type="button" data-action="save-profile-photo">Salvar foto</button></div>`);
}

async function prepareProfilePhoto(file) {
  if (!file || !String(file.type || "").startsWith("image/")) throw new Error("Escolha um arquivo de imagem válido.");
  if (file.size > 8_000_000) throw new Error("A foto original deve ter no máximo 8 MB.");
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Não foi possível ler esta foto."));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Este formato de foto não é compatível. Tente JPG ou PNG."));
    image.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Não foi possível preparar esta foto.");
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const x = (image.naturalWidth - side) / 2;
  const y = (image.naturalHeight - side) / 2;
  context.drawImage(image, x, y, side, side, 0, 0, 320, 320);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function updateProfilePhotoPreview() {
  const preview = $("profilePhotoPreview");
  if (!preview) return;
  preview.innerHTML = avatarMarkup({ ...currentUser, profilePhoto: profilePhotoDraft }, "profileAvatar");
}

async function saveProfilePhoto() {
  const button = document.querySelector('[data-action="save-profile-photo"]');
  setBusy(button, true, "Salvando...");
  try {
    const { user } = await apiRequest("/profile", { method: "PATCH", body: { profilePhoto: profilePhotoDraft } });
    currentUser = user;
    updateCurrentAvatar();
    closeModal();
    await loadState(false);
    showToast(profilePhotoDraft ? "Foto de perfil atualizada." : "Foto de perfil removida.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function openPasswordModal(required = false) {
  openModal(`<div class="modalHeader"><div><span class="eyebrow">Segurança</span><h2 id="modalTitle">Alterar senha</h2></div>${required ? "" : `<button class="iconBtn" type="button" data-action="close-modal">${ICONS.close}</button>`}</div><p class="modalIntro">${required ? "Defina uma nova senha para continuar." : "Confirme sua senha atual e escolha uma nova."}</p><div class="formGrid"><label>Senha atual<input id="currentPassword" type="password" autocomplete="current-password"></label><label>Nova senha<input id="newPassword" type="password" minlength="6" autocomplete="new-password"></label><label>Confirmar nova senha<input id="confirmNewPassword" type="password" minlength="6" autocomplete="new-password"></label></div><div class="modalActions">${required ? "" : `<button class="ghostBtn" type="button" data-action="close-modal">Cancelar</button>`}<button class="primaryBtn" type="button" data-action="save-own-password">Alterar senha</button></div>`);
}

async function saveOwnPassword() {
  const next = $("newPassword").value;
  if (next.length < 6) return showToast("A nova senha precisa ter pelo menos 6 caracteres.", "error");
  if (next !== $("confirmNewPassword").value) return showToast("As novas senhas não conferem.", "error");
  try {
    const { user } = await apiRequest("/change-password", { method: "POST", body: { currentPassword: $("currentPassword").value, newPassword: next } });
    currentUser = user;
    closeModal();
    showToast("Senha alterada.");
  } catch (error) { showToast(error.message, "error"); }
}

function openModal(content) {
  $("modal").innerHTML = content;
  $("modalBackdrop").classList.remove("hidden");
  document.body.classList.add("modalOpen");
  setTimeout(() => $("modal").querySelector("input, textarea, select, button")?.focus(), 20);
}

function closeModal() {
  $("modalBackdrop").classList.add("hidden");
  $("modal").innerHTML = "";
  document.body.classList.remove("modalOpen");
}

function exportExcel() {
  const rows = [...appState.bankRequests].sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)));
  const header = ["Data", "Equipe", "Operador", "Tipo", "Horas", "Motivo", "Status", "Destino", "Observação", "Solicitado em", "Revisado em", "Revisado por"];
  const dataRows = rows.map((request) => [formatDate(request.date), teamName(request.teamId), request.operatorName, requestTypeLabel(request.requestType), request.hours ? formatHours(request.hours) : "", request.reason || "", statusLabel(request.status), request.reviewTeamId ? teamName(request.reviewTeamId) : "", request.coordinatorNote || "", formatDateTime(request.createdAt), formatDateTime(request.reviewedAt), request.reviewedBy?.name || request.reviewedBy?.username || ""]);
  const cell = (value, style = "Text") => `<Cell ss:StyleID="${style}"><Data ss:Type="String">${xmlSafe(value)}</Data></Cell>`;
  const balanceRows = allOperators().map((operator) => [operator.teamName, operator.registration || "", operator.name, bankBalance(operator.id)]);
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Default" ss:Name="Normal"><Font ss:FontName="Aptos" ss:Size="10"/></Style><Style ss:ID="Title"><Font ss:Bold="1" ss:Color="#FFFFFF" ss:Size="14"/><Interior ss:Color="#0C6E7D" ss:Pattern="Solid"/></Style><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#17303A" ss:Pattern="Solid"/></Style><Style ss:ID="Text"/></Styles><Worksheet ss:Name="Solicitações"><Table><Row ss:Height="26"><Cell ss:StyleID="Title" ss:MergeAcross="11"><Data ss:Type="String">BANCOFLOW | DADOS DEMONSTRATIVOS</Data></Cell></Row><Row>${header.map((value) => cell(value, "Header")).join("")}</Row>${dataRows.map((row) => `<Row>${row.map((value) => cell(value)).join("")}</Row>`).join("")}</Table></Worksheet><Worksheet ss:Name="Saldos"><Table><Row>${["Equipe", "Matrícula", "Operador", "Saldo disponível"].map((value) => cell(value, "Header")).join("")}</Row>${balanceRows.map((row) => `<Row>${row.map((value) => cell(value)).join("")}</Row>`).join("")}</Table></Worksheet></Workbook>`;
  download(workbook, `banco_de_horas_${new Date().toISOString().slice(0, 10)}.xls`, "application/vnd.ms-excel");
  showToast("Arquivo Excel gerado.");
}

function xmlSafe(value) {
  return String(value ?? "").replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function updateThemeControls(theme, animate = false) {
  const isLight = theme === "light";
  const icon = isLight ? ICONS.sun : ICONS.moon;
  const activeLabel = isLight ? "Modo claro" : "Modo noturno";
  const targetLabel = isLight ? "modo noturno" : "modo claro";
  const desktopButton = $("themeBtn");
  const mobileButton = $("mobileThemeBtn");
  const desktopIcon = desktopButton?.querySelector(".navIcon");
  const desktopLabel = desktopButton?.querySelector(":scope > span:last-child");
  if (desktopIcon) desktopIcon.innerHTML = `<span class="themeGlyph">${icon}</span>`;
  if (desktopLabel) desktopLabel.textContent = activeLabel;
  if (mobileButton) mobileButton.innerHTML = `<span class="themeGlyph">${icon}</span>`;
  [desktopButton, mobileButton].filter(Boolean).forEach((button) => {
    button.title = `${activeLabel} ativo. Alternar para ${targetLabel}`;
    button.setAttribute("aria-label", `${activeLabel} ativo. Alternar para ${targetLabel}`);
    button.classList.remove("themeToLight", "themeToDark");
    if (!animate) return;
    void button.offsetWidth;
    button.classList.add(isLight ? "themeToLight" : "themeToDark");
  });
}

function applyTheme(theme, animate = false) {
  const next = theme === "light" ? "light" : "dark";
  if (animate) {
    document.body.classList.remove("themeChanging");
    void document.body.offsetWidth;
    document.body.classList.add("themeChanging");
  }
  document.body.classList.toggle("theme-light", next === "light");
  document.body.classList.toggle("theme-dark", next === "dark");
  localStorage.setItem(THEME_KEY, next);
  document.querySelector('meta[name="theme-color"]').content = next === "dark" ? "#06101a" : "#edf7fb";
  updateThemeControls(next, animate);
  if (animate) setTimeout(() => document.body.classList.remove("themeChanging"), 420);
}

function toggleTheme() {
  applyTheme(document.body.classList.contains("theme-dark") ? "light" : "dark", true);
}

document.addEventListener("click", (event) => {
  const calendarDay = event.target.closest("[data-calendar-date]");
  if (calendarDay) return selectCalendarDate(calendarDay.dataset.calendarDate);
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) return setRoute(routeButton.dataset.route);
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    if (!event.target.closest(".userBadge")) $("userMenu").classList.add("hidden");
    if (!event.target.closest(".notificationPanel") && !event.target.closest(".notificationBtn")) $("notificationPanel").classList.add("hidden");
    return;
  }
  const { action, id, status, user, active, operator } = actionButton.dataset;
  if (action === "logout") logout();
  if (action === "profile-photo") openProfilePhotoModal();
  if (action === "change-password") openPasswordModal();
  if (action === "close-modal") closeModal();
  if (action === "bank-status") updateBankStatus(id, status);
  if (action === "bank-acknowledge") acknowledgeBankRequest(id);
  if (action === "bank-note") openNoteModal(id);
  if (action === "bank-delete") deleteBankRequest(id);
  if (action === "save-bank-note") saveBankNote(id);
  if (action === "save-user") saveUser(user);
  if (action === "toggle-user") toggleUser(user, active === "true");
  if (action === "reset-user-password") openResetPasswordModal(user);
  if (action === "save-user-password") saveUserPassword(user);
  if (action === "delete-user") deleteUser(user);
  if (action === "save-own-password") saveOwnPassword();
  if (action === "save-balance") saveBalance(operator);
  if (action === "remove-profile-photo") {
    profilePhotoDraft = "";
    updateProfilePhotoPreview();
  }
  if (action === "save-profile-photo") saveProfilePhoto();
  if (action === "read-notifications") markNotificationsRead();
  if (action === "enable-notifications") enableSystemNotifications();
  if (action === "calendar-prev") {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    refreshCalendar();
  }
  if (action === "calendar-next") {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    refreshCalendar();
  }
});

$("loginForm").addEventListener("submit", submitAuth);
document.querySelectorAll(".authMode").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
document.querySelectorAll("[data-demo-user]").forEach((button) => button.addEventListener("click", () => {
  if (authMode !== "login") setAuthMode("login");
  $("loginUser").value = button.dataset.demoUser;
  $("loginPassword").value = "Portfolio#2026";
  $("loginUser").focus();
}));
$("registerRole").addEventListener("change", () => updateTeamField($("registerRole").value, $("registerTeamField"), $("registerTeam")));
updateTeamField($("registerRole").value, $("registerTeamField"), $("registerTeam"));
$("togglePassword").addEventListener("click", () => {
  const input = $("loginPassword");
  input.type = input.type === "password" ? "text" : "password";
  $("togglePassword").textContent = input.type === "password" ? "Ver" : "Ocultar";
});
$("themeBtn").addEventListener("click", toggleTheme);
$("mobileThemeBtn").addEventListener("click", toggleTheme);
$("logoutBtn").addEventListener("click", logout);
$("refreshBtn").addEventListener("click", () => loadState(true));
$("exportBtn").addEventListener("click", exportExcel);
$("userMenuBtn").addEventListener("click", () => {
  $("userMenu").classList.toggle("hidden");
  $("notificationPanel").classList.add("hidden");
  $("userMenuBtn").setAttribute("aria-expanded", String(!$("userMenu").classList.contains("hidden")));
});
$("notificationBtn").addEventListener("click", () => {
  const opening = $("notificationPanel").classList.contains("hidden");
  $("notificationPanel").classList.toggle("hidden");
  $("userMenu").classList.add("hidden");
  $("notificationBtn").setAttribute("aria-expanded", String(opening));
  if (opening) loadNotifications(false);
});
$("modalBackdrop").addEventListener("click", (event) => { if (event.target === $("modalBackdrop")) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !currentUser?.mustChangePassword) closeModal(); });
document.addEventListener("focusout", (event) => {
  const input = event.target.closest?.("[data-duration-input]");
  if (!input || !input.value.trim()) return;
  const hours = parseHours(input.value);
  if (Number.isFinite(hours) && hours >= MIN_BANK_BALANCE) input.value = formatHours(hours);
});
document.addEventListener("change", async (event) => {
  if (event.target.id !== "profilePhotoInput") return;
  try {
    profilePhotoDraft = await prepareProfilePhoto(event.target.files?.[0]);
    updateProfilePhotoPreview();
  } catch (error) {
    event.target.value = "";
    showToast(error.message, "error");
  }
});

applyTheme(localStorage.getItem(THEME_KEY) || "dark");
hydrateSession();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js?v=portfolio-v3").catch(() => {}));
}
