"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");

const PORT = Number(process.env.PORT || 4173);
// Escuta em todas as interfaces para permitir acesso pela rede local.
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, "data", "db.json");
const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const postgres = USE_POSTGRES ? require("./database") : null;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
]);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const localSessions = new Map();
const loginAttempts = new Map();
let writeQueue = Promise.resolve();

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(payload);
}

async function loadDb() {
  if (USE_POSTGRES) return postgres.loadDb();
  return JSON.parse(await fs.readFile(DB_PATH, "utf8"));
}
function saveDb(db) {
  writeQueue = writeQueue.then(async () => {
    const temporary = `${DB_PATH}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(db, null, 2)}\n`, "utf8");
    await fs.rename(temporary, DB_PATH);
  });
  return writeQueue;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Corpo da requisição muito grande."), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("JSON inválido."), { status: 400 }); }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, branchCode: user.branchCode };
}

async function authenticatedUser(req, db) {
  const token = parseCookies(req).fc_session;
  if (USE_POSTGRES) {
    if (!token) return null;
    return postgres.authenticatedUser(token);
  }
  const session = token ? localSessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) localSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + (session.rememberMe ? REMEMBERED_SESSION_TTL_MS : SESSION_TTL_MS);
  return db.users.find((user) => user.id === session.userId && user.active) || null;
}

function verifyPassword(password, user) {
  if (typeof password !== "string") return false;
  const supplied = scryptSync(password, user.salt, 64);
  const stored = Buffer.from(user.passwordHash, "hex");
  return supplied.length === stored.length && timingSafeEqual(supplied, stored);
}

function sessionCookie(token, req, rememberMe) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  const persistence = rememberMe ? `; Max-Age=${REMEMBERED_SESSION_TTL_MS / 1000}` : "";
  return `fc_session=${token}; HttpOnly; SameSite=Strict; Path=/${persistence}${secure}`;
}

function clearSessionCookie(req) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `fc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function loginKey(req, username) {
  return `${req.socket.remoteAddress || "local"}:${String(username || "").toLowerCase()}`;
}

function branchWithChecks(branch) {
  const calculatedCapacity = Object.values(branch.capacities).reduce((sum, value) => sum + value, 0);
  return { ...branch, calculatedCapacity, capacityMismatch: calculatedCapacity !== branch.totalCapacity };
}

function readingTotals(reading, branch, fuels) {
  const volumes = Object.fromEntries(fuels.map((fuel) => [fuel.id, Number(reading.measurements?.[fuel.id]?.liters || 0)]));
  const totalLiters = Object.values(volumes).reduce((sum, value) => sum + value, 0);
  const occupancyPercent = branch.totalCapacity > 0 ? Number(((totalLiters / branch.totalCapacity) * 100).toFixed(1)) : null;
  return { ...reading, volumes, totalLiters, occupancyPercent };
}

function validateReading(payload, db) {
  const errors = [];
  const branch = db.branches.find((item) => item.code === payload.branchCode && item.active);
  if (!branch) errors.push({ field: "branch", message: "Selecione uma filial ativa." });
  if (!isIsoDate(payload.date)) errors.push({ field: "date", message: "Informe uma data válida." });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.time || "")) errors.push({ field: "time", message: "Informe um horário válido." });
  if (typeof payload.responsible !== "string" || payload.responsible.trim().length < 2) errors.push({ field: "responsible", message: "Informe o responsável pela leitura." });
  if (branch) for (const fuel of db.fuels) {
    const values = payload.measurements?.[fuel.id] || {};
    const cm3 = Number(values.cm3 ?? 0), liters = Number(values.liters ?? 0), capacity = branch.capacities[fuel.id] || 0;
    if (!Number.isFinite(cm3) || cm3 < 0) errors.push({ field: `${fuel.id}-cm3`, message: `${fuel.label}: a medição deve ser zero ou positiva.` });
    if (!Number.isFinite(liters) || liters < 0) errors.push({ field: `${fuel.id}-liters`, message: `${fuel.label}: a conversão deve ser zero ou positiva.` });
    if (capacity === 0 && liters !== 0) errors.push({ field: `${fuel.id}-liters`, message: `${fuel.label} não está disponível nesta filial.` });
    if (liters > capacity) errors.push({ field: `${fuel.id}-liters`, message: `${fuel.label}: o volume supera a capacidade de ${capacity} L.` });
  }
  return { branch, errors };
}

function branchPayload(payload, db, existing = null) {
  const errors = [];
  const code = existing?.code || String(payload.code || "").trim().toUpperCase();
  const name = String(payload.name || "").trim();
  if (!/^FILIAL \d{2,3}$/.test(code)) errors.push({ field: "code", message: "Use o formato FILIAL 13." });
  if (name.length < 2) errors.push({ field: "name", message: "Informe o nome ou cidade da filial." });
  if (!existing && db.branches.some((branch) => branch.code === code)) errors.push({ field: "code", message: "Esta filial já está cadastrada." });
  const capacities = {};
  for (const fuel of db.fuels) {
    const capacity = Number(payload.capacities?.[fuel.id] ?? 0);
    if (!Number.isFinite(capacity) || capacity < 0 || !Number.isInteger(capacity)) errors.push({ field: fuel.id, message: `${fuel.label}: informe uma capacidade inteira igual ou maior que zero.` });
    capacities[fuel.id] = Number.isFinite(capacity) && capacity >= 0 ? Math.round(capacity) : 0;
  }
  return { errors, branch: { id: existing?.id || code.toLowerCase().replace(" ", "-"), code, name, capacities, totalCapacity: Object.values(capacities).reduce((sum, value) => sum + value, 0), active: payload.active !== false } };
}

async function serveStatic(pathname, res) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  try {
    const content = await fs.readFile(path.join(ROOT, entry[0]));
    res.writeHead(200, { "content-type": entry[1], "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    res.end(content);
  } catch { send(res, 404, { error: "Arquivo não encontrado." }); }
  return true;
}

async function api(req, res, url) {
  const db = await loadDb();
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, USE_POSTGRES ? await postgres.health() : { status: "ok", database: "json-local", schemaVersion: db.schemaVersion });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const payload = await readJson(req);
    const username = String(payload.username || "").trim().toLowerCase();
    const key = loginKey(req, username), attempt = loginAttempts.get(key);
    if (attempt?.blockedUntil > Date.now()) return send(res, 429, { error: "Muitas tentativas. Aguarde cinco minutos e tente novamente." });
    const user = db.users.find((item) => item.username.toLowerCase() === username && item.active);
    if (!user || !verifyPassword(payload.password, user)) {
      const failures = (attempt?.failures || 0) + 1;
      loginAttempts.set(key, { failures, blockedUntil: failures >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
      return send(res, 401, { error: "Usuário ou senha inválidos." });
    }
    loginAttempts.delete(key);
    const rememberMe = payload.rememberMe === true;
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + (rememberMe ? REMEMBERED_SESSION_TTL_MS : SESSION_TTL_MS);
    if (USE_POSTGRES) await postgres.createSession(token, user.id, expiresAt, rememberMe);
    else localSessions.set(token, { userId: user.id, expiresAt, rememberMe });
    return send(res, 200, { user: publicUser(user) }, { "set-cookie": sessionCookie(token, req, rememberMe) });
  }

  const user = await authenticatedUser(req, db);
  if (!user) return send(res, 401, { error: "Sua sessão expirou. Entre novamente." }, { "set-cookie": clearSessionCookie(req) });
  if (req.method === "GET" && url.pathname === "/api/auth/me") return send(res, 200, { user: publicUser(user) });
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = parseCookies(req).fc_session;
    if (token && USE_POSTGRES) await postgres.deleteSession(token);
    else if (token) localSessions.delete(token);
    return send(res, 200, { success: true }, { "set-cookie": clearSessionCookie(req) });
  }

  const scopedBranches = user.role === "admin" ? db.branches : db.branches.filter((branch) => branch.code === user.branchCode);
  if (req.method === "GET" && url.pathname === "/api/meta") return send(res, 200, { fuels: db.fuels, currentUser: publicUser(user), alertThresholds: { criticalBelow: 25, warningBelow: 40 } });
  if (req.method === "GET" && url.pathname === "/api/branches") return send(res, 200, { data: scopedBranches.map(branchWithChecks) });

  if (req.method === "POST" && url.pathname === "/api/branches") {
    if (user.role !== "admin") return send(res, 403, { error: "Somente o administrador pode criar filiais." });
    const payload = await readJson(req);
    const { errors, branch } = branchPayload(payload, db);
    const username = String(payload.username || "").trim().toLowerCase();
    const password = String(payload.password || "");
    if (!/^[a-z0-9._-]{4,30}$/.test(username)) errors.push({ field: "username", message: "O login deve ter de 4 a 30 caracteres, sem espaços." });
    if (db.users.some((item) => item.username.toLowerCase() === username)) errors.push({ field: "username", message: "Este login já está em uso." });
    if (password.length < 8) errors.push({ field: "password", message: "A senha fixa deve ter pelo menos 8 caracteres." });
    if (errors.length) return send(res, 422, { error: "Corrija os campos indicados.", details: errors });
    const salt = randomBytes(16).toString("hex");
    const branchUser = { id: randomUUID(), username, displayName: branch.name, role: "branch", branchCode: branch.code, salt, passwordHash: scryptSync(password, salt, 64).toString("hex"), active: branch.active };
    const auditEntry = { id: randomUUID(), action: "branch.created", entityId: branch.id, userId: user.id, role: user.role, branchCode: branch.code, occurredAt: new Date().toISOString() };
    if (USE_POSTGRES) await postgres.createBranch(branch, branchUser, auditEntry);
    else { db.branches.push(branch); db.users.push(branchUser); db.auditLog.push(auditEntry); await saveDb(db); }
    return send(res, 201, { data: branchWithChecks(branch), login: { username } });
  }

  const branchRoute = url.pathname.match(/^\/api\/branches\/([^/]+)$/);
  if (req.method === "PUT" && branchRoute) {
    if (user.role !== "admin") return send(res, 403, { error: "Somente o administrador pode editar filiais." });
    const code = decodeURIComponent(branchRoute[1]);
    const existing = db.branches.find((branch) => branch.code === code);
    if (!existing) return send(res, 404, { error: "Filial não encontrada." });
    const payload = await readJson(req);
    const { errors, branch } = branchPayload(payload, db, existing);
    if (errors.length) return send(res, 422, { error: "Corrija os campos indicados.", details: errors });
    const auditEntry = { id: randomUUID(), action: "branch.updated", entityId: branch.id, userId: user.id, role: user.role, branchCode: branch.code, occurredAt: new Date().toISOString() };
    if (USE_POSTGRES) await postgres.updateBranch(branch, auditEntry);
    else {
      Object.assign(existing, branch);
      db.users.filter((item) => item.role === "branch" && item.branchCode === branch.code).forEach((item) => { item.displayName = branch.name; item.active = branch.active; });
      db.auditLog.push(auditEntry); await saveDb(db);
    }
    return send(res, 200, { data: branchWithChecks(branch) });
  }

  if (req.method === "GET" && url.pathname === "/api/readings") {
    const branchCode = url.searchParams.get("branch"), date = url.searchParams.get("date"), from = url.searchParams.get("from"), to = url.searchParams.get("to"), query = url.searchParams.get("q")?.trim().toLocaleLowerCase("pt-BR");
    let readings = db.readings;
    if (user.role !== "admin") {
      if (branchCode && branchCode !== user.branchCode) return send(res, 403, { error: "Você só pode consultar dados da sua filial." });
      readings = readings.filter((item) => item.branchCode === user.branchCode);
    }
    if (branchCode) readings = readings.filter((item) => item.branchCode === branchCode);
    if (date) readings = readings.filter((item) => item.date === date);
    if (from) readings = readings.filter((item) => item.date >= from);
    if (to) readings = readings.filter((item) => item.date <= to);
    if (query) readings = readings.filter((item) => item.responsible.toLocaleLowerCase("pt-BR").includes(query));
    readings = readings.map((item) => readingTotals(item, db.branches.find((branch) => branch.code === item.branchCode), db.fuels)).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
    return send(res, 200, { data: readings });
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const date = url.searchParams.get("date");
    if (!isIsoDate(date)) return send(res, 400, { error: "Informe a data no formato AAAA-MM-DD." });
    const items = scopedBranches.map((branch) => {
      const matches = db.readings.filter((reading) => reading.branchCode === branch.code && reading.date === date).sort((a, b) => b.time.localeCompare(a.time));
      const latest = matches[0] ? readingTotals(matches[0], branch, db.fuels) : null;
      const checked = branchWithChecks(branch);
      let status = "missing";
      if (latest) status = latest.occupancyPercent < 25 ? "critical" : latest.occupancyPercent < 40 ? "warning" : "regular";
      return { branch: checked, latest, status };
    });
    const reported = items.filter((item) => item.latest).length;
    const totalCapacity = scopedBranches.reduce((sum, branch) => sum + branch.totalCapacity, 0);
    const totalVolume = items.reduce((sum, item) => sum + (item.latest?.totalLiters || 0), 0);
    const capacityWarnings = items.filter((item) => item.branch.capacityMismatch).length;
    return send(res, 200, { date, items, summary: { branchCount: scopedBranches.length, reported, missing: scopedBranches.length - reported, totalCapacity, totalVolume, occupancyPercent: reported && totalCapacity ? Number(((totalVolume / totalCapacity) * 100).toFixed(1)) : null, alertCount: items.filter((item) => ["missing", "critical", "warning"].includes(item.status)).length + capacityWarnings, capacityWarnings } });
  }

  if (req.method === "POST" && url.pathname === "/api/readings") {
    const payload = await readJson(req);
    if (user.role !== "admin" && payload.branchCode !== user.branchCode) return send(res, 403, { error: "Você só pode adicionar informações da sua filial." });
    const { branch, errors } = validateReading(payload, db);
    if (db.readings.some((item) => item.branchCode === payload.branchCode && item.date === payload.date && item.time === payload.time)) errors.push({ field: "time", message: "Já existe uma leitura desta filial na mesma data e horário." });
    if (errors.length) return send(res, 422, { error: "Corrija os campos indicados.", details: errors });
    const measurements = Object.fromEntries(db.fuels.map((fuel) => [fuel.id, { cm3: Number(payload.measurements?.[fuel.id]?.cm3 || 0), liters: Number(payload.measurements?.[fuel.id]?.liters || 0) }]));
    const reading = { id: randomUUID(), branchCode: branch.code, date: payload.date, time: payload.time, responsible: payload.responsible.trim(), measurements, createdAt: new Date().toISOString(), createdByUserId: user.id, createdByRole: user.role };
    const auditEntry = { id: randomUUID(), action: "reading.created", entityId: reading.id, userId: user.id, role: user.role, branchCode: branch.code, occurredAt: reading.createdAt };
    if (USE_POSTGRES) await postgres.createReading(reading, auditEntry);
    else {
      db.readings.push(reading);
      db.auditLog.push(auditEntry);
      await saveDb(db);
    }
    return send(res, 201, { data: readingTotals(reading, branch, db.fuels) });
  }

  const readingRoute = url.pathname.match(/^\/api\/readings\/([0-9a-f-]+)$/i);
  if (req.method === "PUT" && readingRoute) {
    if (user.role !== "admin") return send(res, 403, { error: "Somente o administrador pode modificar lançamentos." });
    const existing = db.readings.find((item) => item.id === readingRoute[1]);
    if (!existing) return send(res, 404, { error: "Lançamento não encontrado." });
    const payload = await readJson(req);
    const { branch, errors } = validateReading(payload, db);
    if (db.readings.some((item) => item.id !== existing.id && item.branchCode === payload.branchCode && item.date === payload.date && item.time === payload.time)) errors.push({ field: "time", message: "Já existe uma leitura desta filial na mesma data e horário." });
    if (errors.length) return send(res, 422, { error: "Corrija os campos indicados.", details: errors });
    const measurements = Object.fromEntries(db.fuels.map((fuel) => [fuel.id, { cm3: Number(payload.measurements?.[fuel.id]?.cm3 || 0), liters: Number(payload.measurements?.[fuel.id]?.liters || 0) }]));
    const reading = { ...existing, branchCode: branch.code, date: payload.date, time: payload.time, responsible: payload.responsible.trim(), measurements };
    const auditEntry = { id: randomUUID(), action: "reading.updated", entityId: reading.id, userId: user.id, role: user.role, branchCode: branch.code, occurredAt: new Date().toISOString() };
    if (USE_POSTGRES) await postgres.updateReading(reading, auditEntry);
    else { Object.assign(existing, reading); db.auditLog.push(auditEntry); await saveDb(db); }
    return send(res, 200, { data: readingTotals(reading, branch, db.fuels) });
  }

  if (req.method === "DELETE" && readingRoute) {
    if (user.role !== "admin") return send(res, 403, { error: "Somente o administrador pode excluir lançamentos." });
    const index = db.readings.findIndex((item) => item.id === readingRoute[1]);
    if (index < 0) return send(res, 404, { error: "Lançamento não encontrado." });
    const reading = db.readings[index];
    const auditEntry = { id: randomUUID(), action: "reading.deleted", entityId: reading.id, userId: user.id, role: user.role, branchCode: reading.branchCode, occurredAt: new Date().toISOString() };
    if (USE_POSTGRES) await postgres.deleteReading(reading.id, auditEntry);
    else { db.readings.splice(index, 1); db.auditLog.push(auditEntry); await saveDb(db); }
    return send(res, 200, { success: true });
  }
  return send(res, 404, { error: "Rota não encontrada." });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (await serveStatic(url.pathname, res)) return;
    return send(res, 404, { error: "Página não encontrada." });
  } catch (error) {
    console.error(error);
    return send(res, error.status || 500, { error: error.status ? error.message : "Erro interno do servidor." });
  }
});

async function start() {
  if (process.env.NODE_ENV === "production" && !USE_POSTGRES) {
    throw new Error("DATABASE_URL é obrigatória em produção.");
  }
  if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET é obrigatória em produção.");
  }
  if (USE_POSTGRES) {
    await postgres.initializeDatabase();
    console.log("PostgreSQL conectado e estrutura verificada.");
  } else {
    console.warn("Modo local: usando data/db.json. Configure DATABASE_URL para usar PostgreSQL.");
  }
  server.listen(PORT, HOST, () => console.log(`FuelControl disponível em http://${HOST}:${PORT}`));
}

start().catch((error) => {
  console.error("Não foi possível iniciar o FuelControl:", error);
  process.exitCode = 1;
});
