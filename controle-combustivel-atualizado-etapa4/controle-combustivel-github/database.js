"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { createHmac } = require("node:crypto");
const { Pool } = require("pg");

const SEED_PATH = path.join(__dirname, "data", "db.json");
const SESSION_SECRET = process.env.SESSION_SECRET || "local-development-only";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error) => console.error("Erro inesperado no pool PostgreSQL:", error));

const tokenHash = (token) => createHmac("sha256", SESSION_SECRET).update(token).digest("hex");

async function initializeDatabase() {
  const seed = JSON.parse(await fs.readFile(SEED_PATH, "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key text PRIMARY KEY,
        value text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fuels (
        id text PRIMARY KEY,
        label text NOT NULL,
        sort_order smallint NOT NULL
      );

      CREATE TABLE IF NOT EXISTS branches (
        id text PRIMARY KEY,
        code text UNIQUE NOT NULL,
        name text NOT NULL,
        total_capacity integer NOT NULL CHECK (total_capacity >= 0),
        active boolean NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS branch_capacities (
        branch_id text NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        fuel_id text NOT NULL REFERENCES fuels(id),
        capacity integer NOT NULL CHECK (capacity >= 0),
        PRIMARY KEY (branch_id, fuel_id)
      );

      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY,
        username text UNIQUE NOT NULL,
        display_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'branch')),
        branch_code text REFERENCES branches(code),
        salt text NOT NULL,
        password_hash text NOT NULL,
        active boolean NOT NULL DEFAULT true,
        CHECK ((role = 'admin' AND branch_code IS NULL) OR (role = 'branch' AND branch_code IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

      CREATE TABLE IF NOT EXISTS readings (
        id uuid PRIMARY KEY,
        branch_code text NOT NULL REFERENCES branches(code),
        reading_date date NOT NULL,
        reading_time time NOT NULL,
        responsible text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by_user_id uuid NOT NULL REFERENCES users(id),
        created_by_role text NOT NULL CHECK (created_by_role IN ('admin', 'branch')),
        UNIQUE (branch_code, reading_date, reading_time)
      );

      CREATE TABLE IF NOT EXISTS reading_measurements (
        reading_id uuid NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
        fuel_id text NOT NULL REFERENCES fuels(id),
        cm3 numeric(14,3) NOT NULL DEFAULT 0 CHECK (cm3 >= 0),
        liters numeric(14,3) NOT NULL DEFAULT 0 CHECK (liters >= 0),
        PRIMARY KEY (reading_id, fuel_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash char(64) PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        remember_me boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS remember_me boolean NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id uuid PRIMARY KEY,
        action text NOT NULL,
        entity_id text,
        user_id uuid NOT NULL REFERENCES users(id),
        role text NOT NULL,
        branch_code text REFERENCES branches(code),
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS readings_branch_date_idx ON readings (branch_code, reading_date DESC, reading_time DESC);
      CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx ON audit_log (occurred_at DESC);
      ALTER TABLE audit_log ALTER COLUMN entity_id TYPE text USING entity_id::text;
    `);

    for (const [index, fuel] of seed.fuels.entries()) {
      await client.query(
        `INSERT INTO fuels (id, label, sort_order) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
        [fuel.id, fuel.label, index]
      );
    }
    for (const branch of seed.branches) {
      await client.query(
        `INSERT INTO branches (id, code, name, total_capacity, active) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [branch.id, branch.code, branch.name, branch.totalCapacity, branch.active]
      );
      for (const fuel of seed.fuels) {
        await client.query(
          `INSERT INTO branch_capacities (branch_id, fuel_id, capacity) VALUES ($1, $2, $3)
           ON CONFLICT (branch_id, fuel_id) DO NOTHING`,
          [branch.id, fuel.id, Number(branch.capacities[fuel.id] || 0)]
        );
      }
    }
    for (const user of seed.users) {
      await client.query(
        `INSERT INTO users (id, username, display_name, role, branch_code, salt, password_hash, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [user.id, user.username, user.displayName, user.role, user.branchCode, user.salt, user.passwordHash, user.active]
      );
    }
    for (const reading of seed.readings || []) {
      const inserted = await client.query(
        `INSERT INTO readings (id, branch_code, reading_date, reading_time, responsible, created_at, created_by_user_id, created_by_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
        [reading.id, reading.branchCode, reading.date, reading.time, reading.responsible, reading.createdAt, reading.createdByUserId, reading.createdByRole]
      );
      if (inserted.rowCount) {
        for (const fuel of seed.fuels) {
          const measurement = reading.measurements?.[fuel.id] || {};
          await client.query(
            `INSERT INTO reading_measurements (reading_id, fuel_id, cm3, liters) VALUES ($1, $2, $3, $4)`,
            [reading.id, fuel.id, Number(measurement.cm3 || 0), Number(measurement.liters || 0)]
          );
        }
      }
    }
    for (const entry of seed.auditLog || []) {
      await client.query(
        `INSERT INTO audit_log (id, action, entity_id, user_id, role, branch_code, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [entry.id, entry.action, entry.entityId, entry.userId, entry.role, entry.branchCode, entry.occurredAt]
      );
    }
    await client.query(
      `INSERT INTO app_meta (key, value) VALUES ('schema_version', '4')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
    await client.query("DELETE FROM sessions WHERE expires_at <= now()");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadDb() {
  const [fuelResult, branchResult, userResult, readingResult] = await Promise.all([
    pool.query(`SELECT id, label FROM fuels ORDER BY sort_order, id`),
    pool.query(`
      SELECT b.id, b.code, b.name, b.total_capacity, b.active,
        COALESCE(jsonb_object_agg(bc.fuel_id, bc.capacity) FILTER (WHERE bc.fuel_id IS NOT NULL), '{}'::jsonb) AS capacities
      FROM branches b LEFT JOIN branch_capacities bc ON bc.branch_id = b.id
      GROUP BY b.id ORDER BY b.code
    `),
    pool.query(`SELECT id, username, display_name, role, branch_code, salt, password_hash, active FROM users ORDER BY username`),
    pool.query(`
      SELECT r.id, r.branch_code, to_char(r.reading_date, 'YYYY-MM-DD') AS date,
        to_char(r.reading_time, 'HH24:MI') AS time, r.responsible, r.created_at,
        r.created_by_user_id, r.created_by_role,
        COALESCE(jsonb_object_agg(rm.fuel_id, jsonb_build_object('cm3', rm.cm3, 'liters', rm.liters))
          FILTER (WHERE rm.fuel_id IS NOT NULL), '{}'::jsonb) AS measurements
      FROM readings r LEFT JOIN reading_measurements rm ON rm.reading_id = r.id
      GROUP BY r.id ORDER BY r.reading_date DESC, r.reading_time DESC
    `),
  ]);
  return {
    schemaVersion: 4,
    fuels: fuelResult.rows,
    branches: branchResult.rows.map((row) => ({
      id: row.id, code: row.code, name: row.name,
      capacities: Object.fromEntries(Object.entries(row.capacities).map(([key, value]) => [key, Number(value)])),
      totalCapacity: Number(row.total_capacity), active: row.active,
    })),
    users: userResult.rows.map((row) => ({
      id: row.id, username: row.username, displayName: row.display_name, role: row.role,
      branchCode: row.branch_code, salt: row.salt, passwordHash: row.password_hash, active: row.active,
    })),
    readings: readingResult.rows.map((row) => ({
      id: row.id, branchCode: row.branch_code, date: row.date, time: row.time,
      responsible: row.responsible,
      measurements: Object.fromEntries(Object.entries(row.measurements).map(([key, value]) => [key, { cm3: Number(value.cm3), liters: Number(value.liters) }])),
      createdAt: new Date(row.created_at).toISOString(), createdByUserId: row.created_by_user_id,
      createdByRole: row.created_by_role,
    })),
  };
}

async function createSession(token, userId, expiresAt, rememberMe) {
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, remember_me) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at, remember_me = EXCLUDED.remember_me`,
    [tokenHash(token), userId, new Date(expiresAt).toISOString(), Boolean(rememberMe)]
  );
}

async function authenticatedUser(token) {
  const result = await pool.query(
    `UPDATE sessions s SET expires_at = now() + CASE WHEN s.remember_me THEN interval '30 days' ELSE interval '8 hours' END
     FROM users u
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.active = true
     RETURNING u.id, u.username, u.display_name, u.role, u.branch_code, u.salt, u.password_hash, u.active`,
    [tokenHash(token)]
  );
  const row = result.rows[0];
  return row ? {
    id: row.id, username: row.username, displayName: row.display_name, role: row.role,
    branchCode: row.branch_code, salt: row.salt, passwordHash: row.password_hash, active: row.active,
  } : null;
}

async function deleteSession(token) {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(token)]);
}

async function createReading(reading, auditEntry) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO readings (id, branch_code, reading_date, reading_time, responsible, created_at, created_by_user_id, created_by_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [reading.id, reading.branchCode, reading.date, reading.time, reading.responsible, reading.createdAt, reading.createdByUserId, reading.createdByRole]
    );
    for (const [fuelId, measurement] of Object.entries(reading.measurements)) {
      await client.query(
        `INSERT INTO reading_measurements (reading_id, fuel_id, cm3, liters) VALUES ($1, $2, $3, $4)`,
        [reading.id, fuelId, measurement.cm3, measurement.liters]
      );
    }
    await client.query(
      `INSERT INTO audit_log (id, action, entity_id, user_id, role, branch_code, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [auditEntry.id, auditEntry.action, auditEntry.entityId, auditEntry.userId, auditEntry.role, auditEntry.branchCode, auditEntry.occurredAt]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw Object.assign(new Error("Já existe uma leitura desta filial na mesma data e horário."), { status: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createBranch(branch, user, auditEntry) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO branches (id, code, name, total_capacity, active) VALUES ($1,$2,$3,$4,$5)`, [branch.id, branch.code, branch.name, branch.totalCapacity, branch.active]);
    for (const [fuelId, capacity] of Object.entries(branch.capacities)) {
      await client.query(`INSERT INTO branch_capacities (branch_id, fuel_id, capacity) VALUES ($1,$2,$3)`, [branch.id, fuelId, capacity]);
    }
    await client.query(`INSERT INTO users (id, username, display_name, role, branch_code, salt, password_hash, active) VALUES ($1,$2,$3,'branch',$4,$5,$6,$7)`, [user.id, user.username, user.displayName, user.branchCode, user.salt, user.passwordHash, user.active]);
    await client.query(`INSERT INTO audit_log (id, action, entity_id, user_id, role, branch_code, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [auditEntry.id, auditEntry.action, auditEntry.entityId, auditEntry.userId, auditEntry.role, auditEntry.branchCode, auditEntry.occurredAt]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw Object.assign(new Error("Código da filial ou nome de usuário já cadastrado."), { status: 409 });
    throw error;
  } finally { client.release(); }
}

async function updateBranch(branch, auditEntry) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE branches SET name=$2, total_capacity=$3, active=$4 WHERE code=$1`, [branch.code, branch.name, branch.totalCapacity, branch.active]);
    for (const [fuelId, capacity] of Object.entries(branch.capacities)) {
      await client.query(`INSERT INTO branch_capacities (branch_id, fuel_id, capacity) VALUES ($1,$2,$3) ON CONFLICT (branch_id,fuel_id) DO UPDATE SET capacity=EXCLUDED.capacity`, [branch.id, fuelId, capacity]);
    }
    await client.query(`UPDATE users SET display_name=$2, active=$3 WHERE branch_code=$1 AND role='branch'`, [branch.code, branch.name, branch.active]);
    await client.query(`INSERT INTO audit_log (id, action, entity_id, user_id, role, branch_code, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [auditEntry.id, auditEntry.action, auditEntry.entityId, auditEntry.userId, auditEntry.role, auditEntry.branchCode, auditEntry.occurredAt]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function updateReading(reading, auditEntry) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE readings SET branch_code=$2, reading_date=$3, reading_time=$4, responsible=$5 WHERE id=$1`, [reading.id, reading.branchCode, reading.date, reading.time, reading.responsible]);
    await client.query(`DELETE FROM reading_measurements WHERE reading_id=$1`, [reading.id]);
    for (const [fuelId, measurement] of Object.entries(reading.measurements)) await client.query(`INSERT INTO reading_measurements (reading_id,fuel_id,cm3,liters) VALUES ($1,$2,$3,$4)`, [reading.id, fuelId, measurement.cm3, measurement.liters]);
    await client.query(`INSERT INTO audit_log (id,action,entity_id,user_id,role,branch_code,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [auditEntry.id, auditEntry.action, auditEntry.entityId, auditEntry.userId, auditEntry.role, auditEntry.branchCode, auditEntry.occurredAt]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); if (error.code === "23505") throw Object.assign(new Error("Já existe uma leitura desta filial na mesma data e horário."), { status: 409 }); throw error; }
  finally { client.release(); }
}

async function deleteReading(id, auditEntry) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO audit_log (id,action,entity_id,user_id,role,branch_code,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [auditEntry.id, auditEntry.action, auditEntry.entityId, auditEntry.userId, auditEntry.role, auditEntry.branchCode, auditEntry.occurredAt]);
    await client.query(`DELETE FROM readings WHERE id=$1`, [id]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function health() {
  const result = await pool.query(`SELECT value FROM app_meta WHERE key = 'schema_version'`);
  return { status: "ok", database: "postgresql", schemaVersion: Number(result.rows[0]?.value || 4) };
}

async function close() { await pool.end(); }

module.exports = { initializeDatabase, loadDb, createSession, authenticatedUser, deleteSession, createReading, createBranch, updateBranch, updateReading, deleteReading, health, close };
