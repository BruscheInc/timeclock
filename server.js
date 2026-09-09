/**
 * Brusche Time Clock — GPS-geofenced clock in/out with payroll timesheets.
 *
 *  - Employees clock IN/OUT from their phone; a punch is only accepted when they are within a set
 *    radius of the work location (GPS geofence). Each punch stores its coordinates + distance.
 *  - Weekly overtime over 40 hrs; gross pay computed from each employee's stored hourly rate.
 *  - Admin (you) sets the geofence in-app ("use my location"), manages employees & rates, reviews
 *    and corrects punches, and exports a payroll CSV. QuickBooks Online sync is a planned phase 2.
 *
 * ENV
 *   TIMECLOCK_ADMINS   comma list of admin logins ("Jose" or "Jose:secret")
 *   DATABASE_URL       Postgres (shared Railway instance is fine — tables are prefixed tk_)
 *   PORT
 */
const express = require("express");
const path = require("path");
const https = require("https");
const { Pool } = require("pg");

/* ---- Slack (notify the supervisor of correction requests) ---- */
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const TC_CHANNEL = process.env.TIMECLOCK_CHANNEL || process.env.CS_CHANNEL || "";
function slackPost(text) {
  if (!SLACK_TOKEN || !TC_CHANNEL) return Promise.resolve();
  const data = JSON.stringify({ channel: TC_CHANNEL, text });
  return new Promise((resolve) => {
    const r = https.request("https://slack.com/api/chat.postMessage", { method: "POST", headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve()); });
    r.on("error", () => resolve()); r.write(data); r.end();
  });
}

/* ------------------------------------------------ Postgres ------------------------------------------------ */
const DB_URL = process.env.DATABASE_URL || "";
const DB_SSL = (/sslmode=require/i.test(DB_URL) || /proxy\.rlwy\.net|rlwy\.net|amazonaws/i.test(DB_URL)) && !/\.railway\.internal/i.test(DB_URL);
const pool = new Pool({ connectionString: DB_URL, ssl: DB_SSL ? { rejectUnauthorized: false } : false });
async function db(q, params) { const c = await pool.connect(); try { return await c.query(q, params); } finally { c.release(); } }
async function migrate() {
  await db(`CREATE TABLE IF NOT EXISTS tk_employees (
    name TEXT PRIMARY KEY,
    login_key TEXT,
    hourly_rate NUMERIC(10,2) DEFAULT 0,
    active BOOLEAN DEFAULT true,
    email TEXT, phone TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`ALTER TABLE tk_employees ADD COLUMN IF NOT EXISTS email TEXT`);
  await db(`ALTER TABLE tk_employees ADD COLUMN IF NOT EXISTS phone TEXT`);
  await db(`CREATE TABLE IF NOT EXISTS tk_punches (
    id BIGSERIAL PRIMARY KEY,
    employee TEXT NOT NULL,
    type TEXT NOT NULL,               -- 'in' | 'out'
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    lat DOUBLE PRECISION, lng DOUBLE PRECISION,
    accuracy_m DOUBLE PRECISION, distance_m DOUBLE PRECISION, within_zone BOOLEAN,
    source TEXT, note TEXT, edited_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_punch_emp_ts ON tk_punches(employee, ts)`);
  await db(`CREATE TABLE IF NOT EXISTS tk_config (
    id INT PRIMARY KEY DEFAULT 1,
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, radius_m INTEGER DEFAULT 150,
    week_start INTEGER DEFAULT 3,      -- 0=Sun .. 6=Sat (Brusche work week starts Wednesday)
    tz TEXT DEFAULT 'America/Chicago',
    company TEXT DEFAULT 'Brusche',
    ot_multiplier NUMERIC(4,2) DEFAULT 1.5,
    pay_anchor DATE DEFAULT '2026-09-02',   -- start of a known biweekly pay period
    pay_period_days INTEGER DEFAULT 14,     -- biweekly
    pay_offset_days INTEGER DEFAULT 2,      -- payday = period end + 2 days (e.g. 09/15 → 09/17)
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`INSERT INTO tk_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // New columns for existing installs.
  await db(`ALTER TABLE tk_config ADD COLUMN IF NOT EXISTS ot_multiplier NUMERIC(4,2) DEFAULT 1.5`);
  await db(`ALTER TABLE tk_config ADD COLUMN IF NOT EXISTS pay_anchor DATE`);
  await db(`ALTER TABLE tk_config ADD COLUMN IF NOT EXISTS pay_period_days INTEGER DEFAULT 14`);
  await db(`ALTER TABLE tk_config ADD COLUMN IF NOT EXISTS pay_offset_days INTEGER DEFAULT 2`);
  // Enforce the Brusche schedule: Wednesday work week + the known pay anchor.
  await db(`UPDATE tk_config SET week_start=3 WHERE id=1`);
  await db(`UPDATE tk_config SET pay_anchor='2026-09-02' WHERE id=1 AND pay_anchor IS NULL`);
  await db(`UPDATE tk_config SET pay_period_days=COALESCE(pay_period_days,14), pay_offset_days=COALESCE(pay_offset_days,2), ot_multiplier=COALESCE(ot_multiplier,1.5) WHERE id=1`);
  // Manual-entry / correction requests (employee submits → supervisor approves).
  await db(`CREATE TABLE IF NOT EXISTS tk_requests (
    id BIGSERIAL PRIMARY KEY,
    employee TEXT NOT NULL,
    type TEXT NOT NULL,               -- 'in' | 'out'
    req_ts TIMESTAMPTZ NOT NULL,      -- the time the employee says they clocked
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied
    decided_by TEXT, decided_at TIMESTAMPTZ, punch_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await db(`CREATE INDEX IF NOT EXISTS idx_req_status ON tk_requests(status, created_at DESC)`);
}
async function getConfig() {
  const r = await db(`SELECT lat,lng,radius_m,week_start,tz,company,ot_multiplier,pay_anchor,pay_period_days,pay_offset_days FROM tk_config WHERE id=1`);
  const c = r.rows[0] || {};
  return {
    lat: c.lat ?? null, lng: c.lng ?? null, radius_m: c.radius_m ?? 150, week_start: c.week_start ?? 3,
    tz: c.tz || "America/Chicago", company: c.company || "Brusche", ot_multiplier: Number(c.ot_multiplier) || 1.5,
    pay_anchor: c.pay_anchor ? new Date(c.pay_anchor).toISOString().slice(0, 10) : "2026-09-02",
    pay_period_days: c.pay_period_days || 14, pay_offset_days: c.pay_offset_days ?? 2,
  };
}
// Which biweekly pay period does a date fall in? Returns start/end/payday (all YYYY-MM-DD) + the two work weeks.
function payPeriodFor(dateStr, cfg) {
  const anchor = cfg.pay_anchor || "2026-09-02", days = cfg.pay_period_days || 14, off = cfg.pay_offset_days ?? 2;
  const a = new Date(anchor + "T00:00:00Z"), d = new Date(dateStr + "T00:00:00Z");
  const idx = Math.floor(Math.floor((d - a) / 86400000) / days);
  const start = new Date(a); start.setUTCDate(a.getUTCDate() + idx * days);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + days - 1);
  const pay = new Date(end); pay.setUTCDate(end.getUTCDate() + off);
  const iso = (x) => x.toISOString().slice(0, 10);
  const shift = (base, n) => { const x = new Date(base + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
  return { start: iso(start), end: iso(end), payday: iso(pay), index: idx,
    weeks: [{ start: iso(start), end: shift(iso(start), 6) }, { start: shift(iso(start), 7), end: iso(end) }] };
}

/* ------------------------------------------------ Helpers ------------------------------------------------ */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function ctDate(d, tz) { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d)); } catch { return new Date(d).toISOString().slice(0, 10); } }
function weekStartOf(dateStr, weekStart) {
  const d = new Date(dateStr + "T00:00:00Z");
  const off = (d.getUTCDay() - weekStart + 7) % 7;
  d.setUTCDate(d.getUTCDate() - off);
  return d.toISOString().slice(0, 10);
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------------------------------ Auth ------------------------------------------------ */
function loadAdmins() {
  const out = [];
  for (const e of (process.env.TIMECLOCK_ADMINS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, key] = e.split(":").map((x) => (x || "").trim());
    if (name) out.push({ name, key: key || name });
  }
  return out;
}
const ADMINS = loadAdmins();
async function userInfo(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  const a = ADMINS.find((a) => a.key.toLowerCase() === k.toLowerCase());
  if (a) return { name: a.name, role: "admin" };
  const r = await db(`SELECT name, active FROM tk_employees WHERE lower(name)=lower($1) OR lower(coalesce(login_key,''))=lower($1)`, [k]);
  if (r.rows[0] && r.rows[0].active !== false) return { name: r.rows[0].name, role: "employee" };
  return null;
}
function keyFrom(req) { return req.query.key || req.get("x-tc-key") || (req.body && req.body.key) || ""; }

/* ------------------------------------------------ Punch logic ------------------------------------------------ */
async function lastPunch(emp) {
  const r = await db(`SELECT type, ts FROM tk_punches WHERE lower(employee)=lower($1) ORDER BY ts DESC LIMIT 1`, [emp]);
  return r.rows[0] || null;
}
async function currentState(emp) {
  const lp = await lastPunch(emp);
  return { state: lp && lp.type === "in" ? "in" : "out", since: lp ? lp.ts : null };
}
async function doPunch(emp, wantType, lat, lng, acc) {
  const cfg = await getConfig();
  let dist = null, within = true;
  if (cfg.lat != null && cfg.lng != null) {
    if (lat == null || lng == null) { const e = new Error("Location is required to punch. Enable location and try again."); e.code = "NO_LOC"; throw e; }
    dist = haversine(Number(lat), Number(lng), Number(cfg.lat), Number(cfg.lng));
    within = dist <= (cfg.radius_m || 150);
    if (!within) { const e = new Error(`You're ${Math.round(dist)} m from ${cfg.company || "the site"} — you must be within ${cfg.radius_m} m to clock in/out.`); e.code = "OUT_OF_ZONE"; e.distance = Math.round(dist); throw e; }
  }
  const cur = (await currentState(emp)).state;
  const type = wantType || (cur === "in" ? "out" : "in");
  if (type === cur) { const e = new Error(`You're already clocked ${cur}.`); e.code = "DUP"; throw e; }
  const r = await db(
    `INSERT INTO tk_punches (employee,type,ts,lat,lng,accuracy_m,distance_m,within_zone,source) VALUES ($1,$2,now(),$3,$4,$5,$6,$7,'app') RETURNING id, ts`,
    [emp, type, lat ?? null, lng ?? null, acc ?? null, dist, within]
  );
  return { ok: true, type, ts: r.rows[0].ts, id: r.rows[0].id, distance_m: dist != null ? Math.round(dist) : null };
}

/* ------------------------------------------------ Timesheet / payroll ------------------------------------------------ */
// Pair punches per employee into worked intervals, roll up to CT days and weeks, apply weekly OT>40 and rates.
async function computeTimesheet(fromDate, toDate, onlyEmp) {
  const cfg = await getConfig();
  const tz = cfg.tz || "America/Chicago", weekStart = cfg.week_start ?? 3, otMult = cfg.ot_multiplier || 1.5;
  // pull punches across a padded range (so an interval spanning the boundary still pairs), then filter by IN day.
  const params = [fromDate + "T00:00:00Z", toDate + "T23:59:59Z"];
  let where = `ts >= $1 AND ts <= $2`;
  if (onlyEmp) { params.push(onlyEmp); where += ` AND lower(employee)=lower($3)`; }
  const pr = await db(`SELECT id,employee,type,ts,distance_m,within_zone FROM tk_punches WHERE ${where} ORDER BY employee, ts`, params);
  const rates = {}; (await db(`SELECT name, hourly_rate FROM tk_employees`)).rows.forEach((r) => (rates[r.name.toLowerCase()] = Number(r.hourly_rate) || 0));
  // group punches by employee
  const byEmp = {};
  for (const p of pr.rows) (byEmp[p.employee] ||= []).push(p);
  const out = [];
  for (const [emp, punches] of Object.entries(byEmp)) {
    const days = {}; // dayKey -> minutes
    const pairs = [];
    let openIn = null;
    for (const p of punches) {
      if (p.type === "in") openIn = p;
      else if (p.type === "out" && openIn) {
        const mins = (new Date(p.ts) - new Date(openIn.ts)) / 60000;
        if (mins > 0 && mins < 24 * 60) { const dk = ctDate(openIn.ts, tz); days[dk] = (days[dk] || 0) + mins; pairs.push({ in: openIn.ts, out: p.ts, day: dk, hours: round2(mins / 60) }); }
        openIn = null;
      }
    }
    const dailyRows = Object.entries(days).filter(([dk]) => dk >= fromDate && dk <= toDate).map(([day, mins]) => ({ day, hours: round2(mins / 60) })).sort((a, b) => a.day.localeCompare(b.day));
    // weekly OT (>40 hrs per work week), broken out per week so the timesheet can show it
    const weekMap = {};
    for (const d of dailyRows) { const wk = weekStartOf(d.day, weekStart); weekMap[wk] = (weekMap[wk] || 0) + d.hours; }
    const weekRows = Object.entries(weekMap).map(([wk, mh]) => ({ week_start: wk, hours: round2(mh), reg: round2(Math.min(mh, 40)), ot: round2(Math.max(0, mh - 40)) })).sort((a, b) => a.week_start.localeCompare(b.week_start));
    const reg = round2(weekRows.reduce((s, w) => s + w.reg, 0)), ot = round2(weekRows.reduce((s, w) => s + w.ot, 0));
    const rate = rates[emp.toLowerCase()] || 0;
    const openState = (await currentState(emp)).state;
    out.push({ employee: emp, rate, total_hours: round2(reg + ot), reg_hours: reg, ot_hours: ot,
      gross_pay: round2(reg * rate + ot * rate * otMult), currently: openState, days: dailyRows, weeks: weekRows });
  }
  out.sort((a, b) => a.employee.localeCompare(b.employee));
  return { from: fromDate, to: toDate, week_start: weekStart, tz, ot_multiplier: otMult, employees: out };
}

/* ------------------------------------------------ HTTP ------------------------------------------------ */
const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (res, p) => { if (p.endsWith(".webmanifest")) res.set("Content-Type", "application/manifest+json"); if (p.endsWith("sw.js")) res.set("Cache-Control", "no-cache"); } }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function guard(req, res, needAdmin) {
  const u = await userInfo(keyFrom(req));
  if (!u) { res.status(401).json({ error: "unauthorized" }); return null; }
  if (needAdmin && u.role !== "admin") { res.status(403).json({ error: "admin only" }); return null; }
  return u;
}

app.get("/api/role", async (req, res) => { const u = await userInfo(keyFrom(req)); res.json({ ok: !!u, user: u ? u.name : null, role: u ? u.role : null }); });

// ---- Employee: state + punch ----
app.get("/api/state", async (req, res) => {
  const u = await guard(req, res); if (!u) return;
  try {
    const st = await currentState(u.name);
    const cfg = await getConfig();
    // today's hours
    const ts = await computeTimesheet(ctDate(Date.now(), cfg.tz), ctDate(Date.now(), cfg.tz), u.name);
    const me = ts.employees[0];
    res.json({ user: u.name, role: u.role, state: st.state, since: st.since, today_hours: me ? me.total_hours : 0, geofence_set: cfg.lat != null, radius_m: cfg.radius_m, company: cfg.company });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/punch", async (req, res) => {
  const u = await guard(req, res); if (!u) return;
  try {
    const { type, lat, lng, accuracy } = req.body || {};
    const r = await doPunch(u.name, type, lat, lng, accuracy);
    res.json(r);
  } catch (e) { res.status(e.code === "OUT_OF_ZONE" ? 409 : 400).json({ error: e.message, code: e.code, distance_m: e.distance }); }
});
app.get("/api/my-timesheet", async (req, res) => {
  const u = await guard(req, res); if (!u) return;
  try { res.json(await computeTimesheet(req.query.from, req.query.to, u.name)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Pay period (any signed-in user) ----
app.get("/api/pay-period", async (req, res) => {
  const u = await guard(req, res); if (!u) return;
  try {
    const cfg = await getConfig();
    const base = req.query.date || ctDate(Date.now(), cfg.tz);
    const cur = payPeriodFor(base, cfg);
    const prev = payPeriodFor(new Date(new Date(cur.start + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10), cfg);
    const next = payPeriodFor(new Date(new Date(cur.end + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10), cfg);
    res.json({ current: cur, prev, next, today: ctDate(Date.now(), cfg.tz) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Employee: submit a correction / manual-entry request (forgot to clock) → supervisor approves ----
app.post("/api/request", async (req, res) => {
  const u = await guard(req, res); if (!u) return;
  try {
    const { type, ts, reason } = req.body || {};
    if (!["in", "out"].includes(type) || !ts) return res.status(400).json({ error: "type (in/out) and ts required" });
    const when = new Date(ts); if (isNaN(when)) return res.status(400).json({ error: "invalid time" });
    if (when.getTime() > Date.now() + 60000) return res.status(400).json({ error: "that time is in the future" });
    const r = await db(`INSERT INTO tk_requests (employee,type,req_ts,reason,status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`, [u.name, type, when.toISOString(), (reason || "").slice(0, 500)]);
    const cfg = await getConfig();
    const nice = new Intl.DateTimeFormat("en-US", { timeZone: cfg.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(when);
    slackPost(`⏱️ *Time correction request* — needs your approval · #${r.rows[0].id}\n*${u.name}* asks to clock *${type.toUpperCase()}* at *${nice}*${reason ? `\nReason: ${reason}` : ""}\nApprove in the Time Clock app → Requests.`);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/my-requests", async (req, res) => {
  const u = await guard(req, res); if (!u) return;
  try { const r = await db(`SELECT id,type,req_ts,reason,status,decided_by,decided_at,created_at FROM tk_requests WHERE lower(employee)=lower($1) ORDER BY created_at DESC LIMIT 50`, [u.name]); res.json({ requests: r.rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Admin: config, employees, timesheets, corrections, export ----
app.get("/api/config", async (req, res) => { if (!(await guard(req, res, true))) return; res.json(await getConfig()); });
app.post("/api/config", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  try {
    const { lat, lng, radius_m, week_start, tz, company, ot_multiplier, pay_anchor, pay_period_days, pay_offset_days } = req.body || {};
    await db(`UPDATE tk_config SET lat=COALESCE($1,lat), lng=COALESCE($2,lng), radius_m=COALESCE($3,radius_m), week_start=COALESCE($4,week_start), tz=COALESCE($5,tz), company=COALESCE($6,company),
      ot_multiplier=COALESCE($7,ot_multiplier), pay_anchor=COALESCE($8,pay_anchor), pay_period_days=COALESCE($9,pay_period_days), pay_offset_days=COALESCE($10,pay_offset_days), updated_at=now() WHERE id=1`,
      [lat ?? null, lng ?? null, radius_m ?? null, week_start ?? null, tz ?? null, company ?? null, ot_multiplier ?? null, pay_anchor ?? null, pay_period_days ?? null, pay_offset_days ?? null]);
    res.json(await getConfig());
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/employees", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  const r = await db(`SELECT name, hourly_rate, active, email, phone FROM tk_employees ORDER BY name`);
  res.json({ employees: r.rows, admins: ADMINS.map((a) => a.name) });
});
app.post("/api/employees", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  try {
    const { name, hourly_rate, active, email, phone } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    await db(`INSERT INTO tk_employees (name,hourly_rate,active,email,phone) VALUES ($1,$2,COALESCE($3,true),$4,$5)
      ON CONFLICT (name) DO UPDATE SET hourly_rate=COALESCE($2,tk_employees.hourly_rate), active=COALESCE($3,tk_employees.active),
        email=COALESCE($4,tk_employees.email), phone=COALESCE($5,tk_employees.phone)`,
      [String(name).trim(), hourly_rate ?? 0, active, email ?? null, phone ?? null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/employee-delete", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  try {
    const { name, purge } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    await db(`DELETE FROM tk_employees WHERE lower(name)=lower($1)`, [name]);
    await db(`DELETE FROM tk_requests WHERE lower(employee)=lower($1)`, [name]);
    if (purge) await db(`DELETE FROM tk_punches WHERE lower(employee)=lower($1)`, [name]); // optional: also erase punch history
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/timesheet", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  try { res.json(await computeTimesheet(req.query.from, req.query.to, req.query.employee || null)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/punches", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  const params = [req.query.from + "T00:00:00Z", req.query.to + "T23:59:59Z"]; let w = `ts>=$1 AND ts<=$2`;
  if (req.query.employee) { params.push(req.query.employee); w += ` AND lower(employee)=lower($3)`; }
  const r = await db(`SELECT id,employee,type,ts,distance_m,within_zone,edited_by FROM tk_punches WHERE ${w} ORDER BY ts DESC LIMIT 500`, params);
  res.json({ punches: r.rows });
});
// Manual correction: add a punch (admin) or delete one.
app.post("/api/admin-punch", async (req, res) => {
  const u = await guard(req, res, true); if (!u) return;
  try {
    const { employee, type, ts } = req.body || {};
    if (!employee || !["in", "out"].includes(type) || !ts) return res.status(400).json({ error: "employee, type(in/out), ts required" });
    await db(`INSERT INTO tk_punches (employee,type,ts,source,edited_by) VALUES ($1,$2,$3,'manual',$4)`, [employee, type, new Date(ts).toISOString(), u.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/punch-delete", async (req, res) => {
  const u = await guard(req, res, true); if (!u) return;
  try { await db(`DELETE FROM tk_punches WHERE id=$1`, [req.body.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin override: change an existing punch's time.
app.post("/api/punch-edit", async (req, res) => {
  const u = await guard(req, res, true); if (!u) return;
  try {
    const { id, ts } = req.body || {};
    if (!id || !ts) return res.status(400).json({ error: "id and ts required" });
    const when = new Date(ts); if (isNaN(when)) return res.status(400).json({ error: "invalid time" });
    await db(`UPDATE tk_punches SET ts=$1, source='manual', edited_by=$2 WHERE id=$3`, [when.toISOString(), u.name, id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: review correction requests.
app.get("/api/requests", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  try {
    const status = req.query.status || "pending";
    const r = status === "all"
      ? await db(`SELECT id,employee,type,req_ts,reason,status,decided_by,decided_at,created_at FROM tk_requests ORDER BY (status='pending') DESC, created_at DESC LIMIT 200`)
      : await db(`SELECT id,employee,type,req_ts,reason,status,decided_by,decided_at,created_at FROM tk_requests WHERE status=$1 ORDER BY created_at DESC LIMIT 200`, [status]);
    const pending = (await db(`SELECT COUNT(*)::int n FROM tk_requests WHERE status='pending'`)).rows[0].n;
    res.json({ requests: r.rows, pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/request-decision", async (req, res) => {
  const u = await guard(req, res, true); if (!u) return;
  try {
    const { id, approve } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const r = await db(`SELECT * FROM tk_requests WHERE id=$1`, [id]);
    const rq = r.rows[0];
    if (!rq) return res.status(404).json({ error: "request not found" });
    if (rq.status !== "pending") return res.status(400).json({ error: `already ${rq.status}` });
    if (approve) {
      const ins = await db(`INSERT INTO tk_punches (employee,type,ts,source,note,edited_by) VALUES ($1,$2,$3,'manual',$4,$5) RETURNING id`,
        [rq.employee, rq.type, new Date(rq.req_ts).toISOString(), `approved request #${id}`, u.name]);
      await db(`UPDATE tk_requests SET status='approved', decided_by=$1, decided_at=now(), punch_id=$2 WHERE id=$3`, [u.name, ins.rows[0].id, id]);
    } else {
      await db(`UPDATE tk_requests SET status='denied', decided_by=$1, decided_at=now() WHERE id=$2`, [u.name, id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Payroll CSV export.
app.get("/api/export", async (req, res) => {
  if (!(await guard(req, res, true))) return;
  try {
    const t = await computeTimesheet(req.query.from, req.query.to);
    let csv = "Employee,Rate,Regular Hours,OT Hours,Total Hours,Gross Pay,Period Start,Period End\n";
    for (const e of t.employees) csv += `"${e.employee}",${e.rate},${e.reg_hours},${e.ot_hours},${e.total_hours},${e.gross_pay},${t.from},${t.to}\n`;
    res.set("Content-Type", "text/csv"); res.set("Content-Disposition", `attachment; filename="payroll_${t.from}_${t.to}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8080;
(async () => {
  try { await migrate(); console.log("🗄️  Timeclock schema ready"); } catch (e) { console.error("❌ migrate:", e.message); }
  app.listen(PORT, () => {
    console.log(`⏱️  Timeclock on :${PORT}`);
    console.log(`🔎 boot → admins:${ADMINS.map((a) => a.name).join("/") || "(none)"} · db:${DB_URL ? "set" : "MISSING"}`);
  });
})();
