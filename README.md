# Brusche Time Clock

GPS-geofenced clock in/out with payroll timesheets. Phone-first web app (PWA), Node/Express + Postgres.

## What it does
- **Geofenced punches** — an employee can only Clock In / Clock Out when they're within a set radius of the work location. Each punch stores GPS coordinates + distance.
- **In / Out only**, weekly **overtime over 40 hrs**, **gross pay** computed from each employee's stored hourly rate.
- **Admin (you):** set the geofence in-app ("set to my current location"), manage employees & rates, review/correct punches, and export a payroll CSV.
- **Employees:** a big Clock In/Out button, today's hours, and this week's hours + estimated pay.

## Roles / login
- Login is the person's **name** (same idea as Stockroom).
- **Admins** come from the `TIMECLOCK_ADMINS` env var (e.g. `Jose`). Admins see the Team + Setup tabs.
- **Employees** are added by an admin in Setup (name + hourly rate); they log in with that name.

## Environment variables
| Var | Purpose |
|---|---|
| `TIMECLOCK_ADMINS` | comma list of admin logins, e.g. `Jose` (or `Jose:secret`) |
| `DATABASE_URL` | Postgres — safe to reuse the shared Railway instance (`${{Postgres.DATABASE_URL}}`); tables are prefixed `tk_` |
| `PORT` | provided by Railway |

## Deploy (Railway)
1. Create repo `BruscheInc/timeclock`, upload `server.js`, `package.json`, `README.md`, and `public/`.
2. Create the service from the repo; set `TIMECLOCK_ADMINS` and `DATABASE_URL` (reference the existing Postgres).
3. Generate a domain. Open `/?key=Jose`, go to **Setup**, stand at the warehouse, tap **"Set to my current location,"** set the radius, add employees + rates.

Schema is created automatically on first boot.

## QuickBooks Online — phase 2
v1 exports a payroll CSV (hours + OT + gross per employee per period). Live QuickBooks Online sync (push Time Activities via the Intuit API) is a follow-up that needs: an Intuit developer app (client id/secret + redirect), you authorizing QuickBooks (OAuth2), and a mapping of each employee to their QuickBooks employee record. Ready to add when you want it.

## Notes
- Location is captured **only at punch time** (no background tracking).
- Overtime/rounding rules vary by state — treat computed pay as a timesheet to confirm with your payroll provider.
