"use strict";

const state = { fuels: [], branches: [], readings: [], dashboard: null, currentUser: null, editingReadingId: null, deletingReadingId: null, editingBranchCode: null };
const el = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const themeKey = (user = state.currentUser) => `fuelcontrol-theme:${user?.username || "anonymous"}`;
const liters = (value) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value || 0)} L`;
const percent = (value) => value == null ? "—" : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`;

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({ error: "Resposta inválida do servidor." }));
  if (response.status === 401 && !["/api/auth/login", "/api/auth/me"].includes(path)) showLogin(payload.error);
  if (!response.ok) throw Object.assign(new Error(payload.error || "Não foi possível concluir a operação."), { status: response.status, details: payload.details || [] });
  return payload;
}

function localDate() {
  const now = new Date(), offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function showToast(message, tone = "success") {
  const toast = el("toast");
  toast.textContent = message;
  toast.className = `toast ${tone} show`;
  setTimeout(() => toast.classList.remove("show"), 3500);
}

function applyTheme(theme, persist = false) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  document.documentElement.style.colorScheme = selected;
  document.querySelectorAll('[name="theme"]').forEach((input) => { input.checked = input.value === selected; });
  if (persist && state.currentUser) localStorage.setItem(themeKey(), selected);
}

function loadUserTheme(user) {
  applyTheme(localStorage.getItem(themeKey(user)) || "light");
}

function statusInfo(item) {
  if (item.status === "critical") return { label: "CRÍTICO", css: "critical" };
  if (item.status === "warning") return { label: "ATENÇÃO", css: "pending" };
  if (item.status === "regular") return { label: "ATUALIZADO", css: "ok" };
  return { label: "SEM LEITURA", css: "pending" };
}

function levelColor(status) {
  return status === "critical" ? "var(--critical)" : status === "warning" ? "var(--warning)" : status === "regular" ? "var(--accent)" : "#b8c4c9";
}

function renderDashboard(data) {
  state.dashboard = data;
  const s = data.summary;
  const occupancyNote = s.reported ? "Calculada sobre a capacidade total" : "Aguardando os primeiros lançamentos";
  const kpis = [
    ["Filiais informadas", `${s.reported} de ${s.branchCount}`, `${s.missing} aguardando leitura`, "#00a878", "#dcf7ee", "▤"],
    ["Volume consolidado", liters(s.totalVolume), s.reported ? "Soma das últimas leituras" : "Nenhuma leitura nesta data", "#3284c5", "#e5f2fc", "◫"],
    ["Ocupação geral", percent(s.occupancyPercent), `${occupancyNote} · ${liters(s.totalCapacity)}`, "#7766cc", "#eeebff", "◒"],
    ["Alertas", String(s.alertCount), s.capacityWarnings ? `${s.capacityWarnings} inconsistência de capacidade` : "Nenhuma inconsistência cadastral", "#d88416", "#fff3da", "!"],
  ];
  el("kpiGrid").innerHTML = kpis.map((k) => `<article class="kpi-card" style="--kpi-color:${k[3]};--kpi-soft:${k[4]}"><div class="kpi-label"><span>${k[0]}</span><span class="kpi-icon">${k[5]}</span></div><strong>${k[1]}</strong><small>${k[2]}</small></article>`).join("");

  el("branchGrid").innerHTML = data.items.map((item) => {
    const b = item.branch, latest = item.latest, info = statusInfo(item), level = latest?.occupancyPercent || 0;
    const mismatch = b.capacityMismatch ? `<span class="data-warning">Capacidade a revisar</span>` : "";
    return `<article class="branch-card"><div class="branch-top"><div class="branch-name"><strong>${b.code}</strong><span>${escapeHtml(b.name)}</span></div><span class="status-badge ${info.css}">${info.label}</span></div><div class="tank-line"><strong>${latest ? liters(latest.totalLiters) : "—"}</strong><span>${latest ? `${percent(level)} da capacidade` : "Aguardando lançamento"}</span></div><div class="progress"><span style="--value:${Math.min(level, 100)}%;--bar:${levelColor(item.status)}"></span></div><div class="branch-meta"><span>Cap. ${liters(b.totalCapacity)}</span><span>${latest ? `Leitura às ${latest.time}` : "Sem horário"}</span></div>${mismatch}</article>`;
  }).join("");

  const alerts = [];
  for (const item of data.items) {
    if (item.branch.capacityMismatch) alerts.push({ level: "warning", branch: item.branch.code, detail: `Tanques somam ${liters(item.branch.calculatedCapacity)}; total informado ${liters(item.branch.totalCapacity)}.`, time: "Cadastro" });
    else if (item.status === "missing") alerts.push({ level: "warning", branch: item.branch.code, detail: "Lançamento ainda não registrado", time: "Pendente" });
    else if (item.status === "critical") alerts.push({ level: "critical", branch: item.branch.code, detail: `Nível em ${percent(item.latest.occupancyPercent)}`, time: item.latest.time });
  }
  el("attentionList").innerHTML = alerts.length ? alerts.map((a) => `<div class="attention-item"><i class="dot ${a.level}"></i><span><strong>${a.branch}</strong><small>${a.detail}</small></span><time>${a.time}</time></div>`).join("") : `<div class="empty-inline">Nenhuma pendência para a data.</div>`;
}

function renderBranchOptions() {
  const options = state.branches.map((b) => `<option value="${b.code}">${b.code} — ${escapeHtml(b.name)}</option>`).join("");
  const restricted = state.currentUser?.role === "branch";
  el("entryBranch").innerHTML = `${restricted ? "" : `<option value="">Selecione...</option>`}${options}`;
  el("historyBranch").innerHTML = `${restricted ? "" : `<option value="">Todas as filiais</option>`}${options}`;
  el("entryBranch").disabled = restricted;
  el("historyBranch").disabled = restricted;
}

function renderBranchesTable() {
  const admin = state.currentUser?.role === "admin";
  el("branchesTable").innerHTML = state.branches.map((b) => `<tr><td class="cell-primary">${b.code}</td><td>${escapeHtml(b.name)}${b.active ? "" : `<small class="table-warning">Inativa</small>`}</td>${state.fuels.map((fuel) => `<td>${liters(b.capacities[fuel.id])}</td>`).join("")}<td class="cell-primary">${liters(b.totalCapacity)}${b.capacityMismatch ? `<small class="table-warning">Revisar soma</small>` : ""}</td>${admin ? `<td><button class="table-button" type="button" data-edit-branch="${b.code}">Editar</button></td>` : ""}</tr>`).join("");
  document.querySelectorAll("[data-edit-branch]").forEach((button) => button.addEventListener("click", () => openBranchModal(button.dataset.editBranch)));
}

function selectedBranch() { return state.branches.find((b) => b.code === el("entryBranch").value); }

function renderFuelFields() {
  const branch = selectedBranch();
  el("fuelEntryGrid").innerHTML = state.fuels.map((fuel) => {
    const capacity = branch?.capacities[fuel.id] || 0, unavailable = branch && capacity === 0;
    return `<fieldset class="fuel-fieldset ${unavailable ? "unavailable" : ""}"><legend>${fuel.label}</legend><span class="tank-capacity">${branch ? `Capacidade: ${liters(capacity)}` : "Selecione a filial"}</span><label>Medição (cm³)<input type="number" min="0" step="0.01" name="${fuel.id}-cm3" placeholder="0,00" ${unavailable ? "disabled" : ""}></label><label>Conversão (L)<input class="liters-input" type="number" min="0" max="${capacity}" step="0.01" name="${fuel.id}-liters" placeholder="0,00" ${unavailable ? "disabled" : ""}></label></fieldset>`;
  }).join("");
  document.querySelectorAll(".liters-input").forEach((input) => input.addEventListener("input", updateSummary));
  const noTanks = branch && Object.values(branch.capacities).every((value) => value === 0);
  el("saveReading").disabled = Boolean(noTanks);
  el("formCapacity").textContent = branch ? liters(branch.totalCapacity) : "—";
  if (noTanks) showFormMessage("Esta filial não possui capacidade por combustível cadastrada. Revise o cadastro antes de lançar.");
  else showFormMessage("");
  updateSummary();
}

function updateSummary() {
  const total = [...document.querySelectorAll(".liters-input")].reduce((sum, input) => sum + Number(input.value || 0), 0);
  const capacity = selectedBranch()?.totalCapacity || 0;
  el("formTotal").textContent = liters(total);
  el("formPercent").textContent = capacity ? percent(total / capacity * 100) : "—";
}

function showFormMessage(message, details = []) {
  const box = el("formMessage");
  if (!message) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `<strong>${message}</strong>${details.length ? `<ul>${details.map((item) => `<li>${item.message}</li>`).join("")}</ul>` : ""}`;
}

function formPayload(form) {
  const values = new FormData(form);
  const measurements = Object.fromEntries(state.fuels.map((fuel) => [fuel.id, { cm3: Number(values.get(`${fuel.id}-cm3`) || 0), liters: Number(values.get(`${fuel.id}-liters`) || 0) }]));
  return { date: values.get("date"), time: values.get("time"), branchCode: el("entryBranch").value, responsible: values.get("responsible"), measurements };
}

async function submitReading(event) {
  event.preventDefault();
  showFormMessage("");
  const button = el("saveReading");
  button.disabled = true;
  button.textContent = "Salvando...";
  try {
    const editing = state.editingReadingId;
    const result = await api(editing ? `/api/readings/${editing}` : "/api/readings", { method: editing ? "PUT" : "POST", body: JSON.stringify(formPayload(event.currentTarget)) });
    showToast(`Leitura de ${result.data.branchCode} ${editing ? "atualizada" : "salva"} com sucesso.`);
    cancelReadingEdit();
    await Promise.all([refreshDashboard(), refreshHistory()]);
    location.hash = "dashboard";
  } catch (error) {
    showFormMessage(error.message, error.details);
    showToast("O lançamento não foi salvo.", "error");
  } finally {
    button.disabled = false;
    button.textContent = state.editingReadingId ? "Salvar alterações" : "Salvar lançamento";
  }
}

function formatDateTime(date, time) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year} ${time}`;
}

function renderHistory(readings) {
  const admin = state.currentUser?.role === "admin";
  if (!readings.length) {
    el("historyTable").innerHTML = `<tr><td colspan="${admin ? 11 : 10}"><div class="empty-inline">Nenhum lançamento encontrado.</div></td></tr>`;
    return;
  }
  el("historyTable").innerHTML = readings.map((r) => `<tr><td>${formatDateTime(r.date, r.time)}</td><td class="cell-primary">${r.branchCode}</td><td>${escapeHtml(r.responsible)}</td>${state.fuels.map((fuel) => `<td>${liters(r.volumes[fuel.id])}</td>`).join("")}<td class="cell-primary">${liters(r.totalLiters)}</td><td><span class="status-badge ${r.occupancyPercent < 40 ? "pending" : "ok"}">${percent(r.occupancyPercent)}</span></td>${admin ? `<td><div class="table-actions"><button class="table-button" type="button" data-edit-reading="${r.id}">Editar</button><button class="table-button danger-text" type="button" data-delete-reading="${r.id}">Excluir</button></div></td>` : ""}</tr>`).join("");
  document.querySelectorAll("[data-edit-reading]").forEach((button) => button.addEventListener("click", () => beginReadingEdit(button.dataset.editReading)));
  document.querySelectorAll("[data-delete-reading]").forEach((button) => button.addEventListener("click", () => openDeleteReading(button.dataset.deleteReading)));
}

function beginReadingEdit(id) {
  const reading = state.readings.find((item) => item.id === id);
  if (!reading) return;
  state.editingReadingId = id;
  el("entryBranch").value = reading.branchCode;
  renderFuelFields();
  document.querySelector('[name="date"]').value = reading.date;
  document.querySelector('[name="time"]').value = reading.time;
  document.querySelector('[name="responsible"]').value = reading.responsible;
  for (const fuel of state.fuels) {
    document.querySelector(`[name="${fuel.id}-cm3"]`).value = reading.measurements[fuel.id]?.cm3 || 0;
    document.querySelector(`[name="${fuel.id}-liters"]`).value = reading.measurements[fuel.id]?.liters || 0;
  }
  updateSummary();
  el("saveReading").textContent = "Salvar alterações";
  el("cancelEditReading").hidden = false;
  location.hash = "lancamento";
}

function cancelReadingEdit() {
  state.editingReadingId = null;
  el("entryForm").reset();
  document.querySelector('[name="date"]').value = localDate();
  el("saveReading").textContent = "Salvar lançamento";
  el("cancelEditReading").hidden = true;
  renderFuelFields();
}

function openDeleteReading(id) { state.deletingReadingId = id; el("deleteReadingModal").hidden = false; setTimeout(() => el("cancelDeleteReading").focus()); }
function closeDeleteReading() { state.deletingReadingId = null; el("deleteReadingModal").hidden = true; }
async function confirmDeleteReading() {
  const id = state.deletingReadingId, button = el("confirmDeleteReading");
  if (!id) return;
  button.disabled = true; button.textContent = "Excluindo...";
  try { await api(`/api/readings/${id}`, { method: "DELETE" }); closeDeleteReading(); showToast("Lançamento excluído com sucesso."); await Promise.all([refreshDashboard(), refreshHistory()]); }
  catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Excluir lançamento"; }
}

function openBranchModal(code = null) {
  state.editingBranchCode = code;
  const branch = state.branches.find((item) => item.code === code);
  el("branchModalTitle").textContent = branch ? `Editar ${branch.code}` : "Adicionar filial";
  el("branchCode").value = branch?.code || ""; el("branchCode").disabled = Boolean(branch);
  el("branchName").value = branch?.name || ""; el("branchActive").checked = branch?.active ?? true;
  el("branchCredentials").hidden = Boolean(branch);
  el("branchUsername").required = !branch; el("branchPassword").required = !branch;
  el("branchUsername").value = ""; el("branchPassword").value = "";
  el("branchCapacityFields").innerHTML = state.fuels.map((fuel) => `<label>${fuel.label} (L)<input type="number" min="0" step="1" name="capacity-${fuel.id}" value="${branch?.capacities[fuel.id] || 0}" required></label>`).join("");
  showBranchMessage(""); el("branchModal").hidden = false; setTimeout(() => el("branchName").focus());
}
function closeBranchModal() { state.editingBranchCode = null; el("branchModal").hidden = true; el("branchForm").reset(); }
function showBranchMessage(message, details = []) { const box = el("branchFormMessage"); box.hidden = !message; box.innerHTML = message ? `<strong>${message}</strong>${details.length ? `<ul>${details.map((item) => `<li>${item.message}</li>`).join("")}</ul>` : ""}` : ""; }
async function submitBranch(event) {
  event.preventDefault(); const values = new FormData(event.currentTarget), editing = state.editingBranchCode, button = el("saveBranch");
  const capacities = Object.fromEntries(state.fuels.map((fuel) => [fuel.id, Number(values.get(`capacity-${fuel.id}`) || 0)]));
  const payload = { code: values.get("code"), name: values.get("name"), capacities, active: el("branchActive").checked, username: values.get("username"), password: values.get("password") };
  button.disabled = true; button.textContent = "Salvando..."; showBranchMessage("");
  try {
    const result = await api(editing ? `/api/branches/${encodeURIComponent(editing)}` : "/api/branches", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
    closeBranchModal(); showToast(`${result.data.code} ${editing ? "atualizada" : "criada"} com sucesso.`); await loadSystem(); location.hash = "filiais";
  } catch (error) { showBranchMessage(error.message, error.details); }
  finally { button.disabled = false; button.textContent = "Salvar filial"; }
}

async function refreshDashboard() {
  const date = el("referenceDate").value || localDate();
  renderDashboard(await api(`/api/dashboard?date=${encodeURIComponent(date)}`));
}

async function refreshHistory() {
  const branch = el("historyBranch").value;
  const period = el("historyPeriod").value, query = el("historySearch").value.trim(), params = new URLSearchParams();
  if (branch) params.set("branch", branch);
  if (query) params.set("q", query);
  if (period !== "all") {
    const days = period === "today" ? 0 : Number(period) - 1;
    const end = new Date(`${localDate()}T12:00:00`), start = new Date(end);
    start.setDate(start.getDate() - days);
    params.set("from", start.toISOString().slice(0, 10));
    params.set("to", end.toISOString().slice(0, 10));
  }
  const result = await api(`/api/readings?${params.toString()}`);
  state.readings = result.data;
  renderHistory(state.readings);
}

function showView(name) {
  const requested = el(name);
  const target = !requested || (requested.hasAttribute("data-admin-only") && state.currentUser?.role !== "admin") ? el("dashboard") : requested;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view === target));
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === target.id));
  el("breadcrumb").textContent = target.dataset.title;
  document.title = `${target.dataset.title} — FuelControl`;
  closeMenu();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openMenu() { el("sidebar").classList.add("open"); el("scrim").classList.add("show"); el("menuButton").setAttribute("aria-expanded", "true"); }
function closeMenu() { el("sidebar").classList.remove("open"); el("scrim").classList.remove("show"); el("menuButton").setAttribute("aria-expanded", "false"); }

function showLogin(message = "") {
  state.currentUser = null;
  applyTheme("light");
  el("appShell").hidden = true;
  el("loginScreen").hidden = false;
  el("loginMessage").hidden = !message;
  el("loginMessage").textContent = message;
  document.title = "Entrar — FuelControl";
  setTimeout(() => document.querySelector('[name="username"]').focus());
}

function showApp(user) {
  state.currentUser = user;
  loadUserTheme(user);
  el("loginScreen").hidden = true;
  el("appShell").hidden = false;
  document.querySelectorAll("[data-admin-only]").forEach((node) => { node.hidden = user.role !== "admin"; });
  el("userName").textContent = user.displayName;
  el("userScope").textContent = user.role === "admin" ? "Administrador geral" : user.branchCode;
  el("userAvatar").textContent = user.role === "admin" ? "AD" : user.branchCode.slice(-2);
  el("dashboardSubtitle").textContent = user.role === "admin" ? "Acompanhe o estoque informado por todas as filiais na data selecionada." : "Acompanhe os lançamentos e o estoque da sua filial.";
}

async function loadSystem() {
  const today = localDate();
  el("referenceDate").value = today;
  document.querySelector('[name="date"]').value = today;
  const [meta, branches] = await Promise.all([api("/api/meta"), api("/api/branches")]);
  state.fuels = meta.fuels;
  state.branches = branches.data;
  renderBranchOptions();
  renderBranchesTable();
  renderFuelFields();
  await Promise.all([refreshDashboard(), refreshHistory()]);
  el("connectionStatus").textContent = "Sessão protegida";
  el("connectionStatus").classList.add("connected");
  showView(location.hash.slice(1) || "dashboard");
}

async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget, button = el("loginButton"), values = new FormData(form);
  button.disabled = true;
  button.textContent = "Entrando...";
  el("loginMessage").hidden = true;
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: values.get("username"), password: values.get("password"), rememberMe: values.get("rememberMe") === "on" }) });
    showApp(result.user);
    form.reset();
    await loadSystem();
  } catch (error) {
    showLogin(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Entrar";
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch { /* a sessão local será encerrada mesmo se o servidor já tiver expirado */ }
  history.replaceState(null, "", location.pathname);
  showLogin();
}

function openLogoutConfirmation() {
  el("logoutModal").hidden = false;
  setTimeout(() => el("cancelLogout").focus());
}

function closeLogoutConfirmation() { el("logoutModal").hidden = true; }

async function confirmLogout() {
  const button = el("confirmLogout");
  button.disabled = true;
  button.textContent = "Saindo...";
  try { await logout(); }
  finally {
    closeLogoutConfirmation();
    button.disabled = false;
    button.textContent = "Sair da conta";
  }
}

function bindEvents() {
  el("loginForm").addEventListener("submit", submitLogin);
  el("logoutButton").addEventListener("click", openLogoutConfirmation);
  el("cancelLogout").addEventListener("click", closeLogoutConfirmation);
  el("confirmLogout").addEventListener("click", confirmLogout);
  el("logoutModal").addEventListener("click", (event) => { if (event.target === el("logoutModal")) closeLogoutConfirmation(); });
  el("addBranchButton").addEventListener("click", () => openBranchModal());
  el("closeBranchModal").addEventListener("click", closeBranchModal);
  el("cancelBranch").addEventListener("click", closeBranchModal);
  el("branchForm").addEventListener("submit", submitBranch);
  el("branchModal").addEventListener("click", (event) => { if (event.target === el("branchModal")) closeBranchModal(); });
  el("cancelEditReading").addEventListener("click", cancelReadingEdit);
  el("cancelDeleteReading").addEventListener("click", closeDeleteReading);
  el("confirmDeleteReading").addEventListener("click", confirmDeleteReading);
  el("deleteReadingModal").addEventListener("click", (event) => { if (event.target === el("deleteReadingModal")) closeDeleteReading(); });
  document.querySelectorAll('[name="theme"]').forEach((input) => input.addEventListener("change", () => { applyTheme(input.value, true); showToast(`Tema ${input.value === "dark" ? "escuro" : "claro"} ativado.`); }));
  window.addEventListener("hashchange", () => { if (state.currentUser) showView(location.hash.slice(1) || "dashboard"); });
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => { location.hash = button.dataset.go; }));
  el("menuButton").addEventListener("click", () => el("sidebar").classList.contains("open") ? closeMenu() : openMenu());
  el("scrim").addEventListener("click", closeMenu);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeMenu(); closeLogoutConfirmation(); closeBranchModal(); closeDeleteReading(); } });
  el("referenceDate").addEventListener("change", () => refreshDashboard().catch((error) => showToast(error.message, "error")));
  el("entryBranch").addEventListener("change", renderFuelFields);
  el("historyBranch").addEventListener("change", () => refreshHistory().catch((error) => showToast(error.message, "error")));
  el("historyPeriod").addEventListener("change", () => refreshHistory().catch((error) => showToast(error.message, "error")));
  el("historySearch").addEventListener("input", () => refreshHistory().catch((error) => showToast(error.message, "error")));
  el("entryForm").addEventListener("reset", () => setTimeout(renderFuelFields));
  el("entryForm").addEventListener("submit", submitReading);
}

async function init() {
  bindEvents();
  try {
    const session = await api("/api/auth/me");
    showApp(session.user);
    await loadSystem();
  } catch (error) {
    if (error.status === 401) showLogin();
    else showLogin("Não foi possível conectar ao servidor.");
  }
}

document.addEventListener("DOMContentLoaded", init);
