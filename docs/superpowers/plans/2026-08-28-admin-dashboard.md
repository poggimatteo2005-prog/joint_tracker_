# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a private `/admin` real-time statistics dashboard for the JointTracker owner, backed by one server-side aggregation RPC.

**Architecture:** A single self-contained `admin.html` at the repo root (inline CSS + inline ES-module script, supabase-js from CDN), copied verbatim into `dist/` by the build like the marketing pages. All data comes from one `SECURITY DEFINER` Postgres function, `admin_dashboard_stats()`, that refuses to run unless the caller's JWT email is the owner's and returns the whole dashboard as one `jsonb` document. The page reads the existing supabase-js auth session from `localStorage`, redirects non-owners to `/`, and renders four sections with hand-rolled inline-SVG bar charts.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no bundler for this page), Supabase (Postgres + Auth), `@supabase/supabase-js@2` from jsDelivr, esbuild (existing build only), Vercel hosting.

**Spec:** `docs/superpowers/specs/2026-08-28-admin-dashboard-design.md`

## Global Constraints

- **No test framework exists in this repo.** Verification is done with (a) SQL assertion queries run through the Supabase MCP (`execute_sql`), and (b) browser checks against a local static server or production. Each task below states its exact checks and expected results — treat those as the test cycle.
- Indentation: **tabs, not spaces** (project convention, `CLAUDE.md`).
- JS: camelCase, verb+noun function names, `addEventListener` (never inline `onclick=`), `async`/`await` (not `.then()` chains).
- User-supplied strings (usernames) rendered via `innerHTML` **must** pass through an `escapeHtml()` helper first.
- No service-role key anywhere client-side. `admin.html` uses the same publishable key as `app.js`: `sb_publishable_1rc0ueZL6Y03qhk5jp_34w_ObCOCpCP`, URL `https://afkxmbxcavwhurmdelfr.supabase.co`.
- Owner email (the only authorized user): `poggi.matteo.2005@gmail.com`.
- Every `SECURITY DEFINER` function must be documented in `CLAUDE.md` with its rationale before merge.
- Supabase project id: `afkxmbxcavwhurmdelfr`.
- The admin page is Italian-only, internal, `noindex`, and linked from nowhere.
- Session counts exclude `smokes` rows with `not_mine = true` everywhere (`WHERE not_mine IS NOT TRUE`).
- Work happens on branch `feat/admin-dashboard` (already created).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `supabase/migrations/20260828120000_add_admin_dashboard_stats.sql` (new) | Defines `public.admin_dashboard_stats()` + grants. The only DB change. |
| `admin.html` (new, repo root) | The entire admin page: theme bootstrap, palette, auth gate, RPC call, loading/error states, four render sections, `renderBarChart()` helper. |
| `vercel.json` (modify) | Add the `/admin` → `/admin.html` rewrite. |
| `build.mjs` (modify) | Add `'admin.html'` to `STATIC_ENTRIES`. |
| `robots.txt` (modify) | Add `Disallow: /admin`. |
| `CLAUDE.md` (modify) | Document `admin_dashboard_stats()` under the `SECURITY DEFINER` list; note `/admin` exists. |
| `.claude/launch.json` (new) | Local static-server config so the page can be previewed during development. |

---

## Task 1: The `admin_dashboard_stats()` RPC + docs

**Files:**
- Create: `supabase/migrations/20260828120000_add_admin_dashboard_stats.sql`
- Modify: `CLAUDE.md` (SECURITY DEFINER list + a one-line note that `/admin` exists)

**Interfaces:**
- Consumes: nothing.
- Produces: Postgres function `public.admin_dashboard_stats() RETURNS jsonb`, callable by role `authenticated`. Return shape (all keys always present):
  ```
  {
    generated_at: text (ISO 8601),
    growth: {
      total_users: int,
      new_users: { today: int, d7: int, d30: int },
      new_users_prev: { d7: int, d30: int },
      signups_by_day: [ { day: 'YYYY-MM-DD', count: int } ]  // exactly 30, oldest→newest
    },
    usage: {
      total_sessions: int,
      sessions_7: int,
      sessions_by_day_30: [ { day: 'YYYY-MM-DD', count: int } ]  // exactly 30, oldest→newest
      avg_sessions_per_user: number (1 decimal),
      dau: int, mau: int, dau_mau_pct: number (1 decimal)
    },
    adoption: {
      pct_shared_session: number, pct_tolerance_break: number, pct_in_leaderboard: number,  // 1 decimal each
      streak_buckets: { zero: int, d1_7: int, d8_30: int, d31_plus: int }
    },
    recent_users: [ { created_at: text, username: text|null, session_count: int } ]  // ≤20, newest→oldest
  }
  ```

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260828120000_add_admin_dashboard_stats.sql` with exactly this content:

```sql
-- Owner-only admin dashboard aggregate.
-- SECURITY DEFINER: reads auth.users + every user's smokes/tolerance_breaks/profiles,
-- which normal RLS forbids. Gated by a hardcoded email check on the caller JWT.
-- Execute granted only to `authenticated` (revoked from anon/public).

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
	v_total_users int;
	result jsonb;
begin
	if coalesce(auth.jwt() ->> 'email', '') <> 'poggi.matteo.2005@gmail.com' then
		raise exception 'not authorized' using errcode = '42501';
	end if;

	select count(*) into v_total_users from auth.users;

	with
	user_days as (
		select distinct user_id, date as d
		from public.smokes
		where not_mine is not true
	),
	islands as (
		select user_id, d,
		       d - (row_number() over (partition by user_id order by d))::int as grp
		from user_days
	),
	current_run as (
		select i.user_id, count(*) as run_len, max(i.d) as last_day
		from islands i
		where i.grp = (
			select i2.grp from islands i2
			where i2.user_id = i.user_id
			order by i2.d desc
			limit 1
		)
		group by i.user_id
	),
	user_streak as (
		select u.id as user_id,
		       case when cr.last_day is null or cr.last_day < current_date - 1
		            then 0 else cr.run_len end as streak
		from auth.users u
		left join current_run cr on cr.user_id = u.id
	),
	streak_buckets as (
		select
			count(*) filter (where streak = 0)             as zero,
			count(*) filter (where streak between 1 and 7)  as d1_7,
			count(*) filter (where streak between 8 and 30) as d8_30,
			count(*) filter (where streak >= 31)            as d31_plus
		from user_streak
	),
	day_series as (
		select generate_series(current_date - 29, current_date, interval '1 day')::date as day
	),
	signups_g as (
		select created_at::date as day, count(*) as c
		from auth.users
		where created_at >= current_date - 29
		group by 1
	),
	signups_by_day as (
		select jsonb_agg(
			jsonb_build_object('day', to_char(ds.day, 'YYYY-MM-DD'), 'count', coalesce(s.c, 0))
			order by ds.day
		) as arr
		from day_series ds left join signups_g s on s.day = ds.day
	),
	sessions_g as (
		select date as day, count(*) as c
		from public.smokes
		where not_mine is not true and date >= current_date - 29
		group by 1
	),
	sessions_by_day as (
		select jsonb_agg(
			jsonb_build_object('day', to_char(ds.day, 'YYYY-MM-DD'), 'count', coalesce(s.c, 0))
			order by ds.day
		) as arr
		from day_series ds left join sessions_g s on s.day = ds.day
	),
	shared_users as (
		select distinct user_id
		from public.smokes
		where not_mine is true
		   or (shared_with is not null
		       and jsonb_typeof(shared_with) = 'array'
		       and jsonb_array_length(shared_with) > 0)
	),
	break_users as (
		select distinct user_id from public.tolerance_breaks
	),
	leaderboard_users as (
		select distinct s.user_id
		from public.smokes s
		join public.profiles p on p.id = s.user_id
		where s.not_mine is not true and p.username is not null
	),
	recent as (
		select u.id, u.created_at, p.username,
		       (select count(*) from public.smokes s
		        where s.user_id = u.id and s.not_mine is not true) as session_count
		from auth.users u
		left join public.profiles p on p.id = u.id
		order by u.created_at desc
		limit 20
	),
	recent_json as (
		select jsonb_agg(
			jsonb_build_object(
				'created_at', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
				'username', username,
				'session_count', session_count
			) order by created_at desc
		) as arr
		from recent
	)
	select jsonb_build_object(
		'generated_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'growth', jsonb_build_object(
			'total_users', v_total_users,
			'new_users', jsonb_build_object(
				'today', (select count(*) from auth.users where created_at::date = current_date),
				'd7',    (select count(*) from auth.users where created_at >= now() - interval '7 days'),
				'd30',   (select count(*) from auth.users where created_at >= now() - interval '30 days')
			),
			'new_users_prev', jsonb_build_object(
				'd7',  (select count(*) from auth.users
				        where created_at >= now() - interval '14 days'
				          and created_at <  now() - interval '7 days'),
				'd30', (select count(*) from auth.users
				        where created_at >= now() - interval '60 days'
				          and created_at <  now() - interval '30 days')
			),
			'signups_by_day', coalesce((select arr from signups_by_day), '[]'::jsonb)
		),
		'usage', jsonb_build_object(
			'total_sessions', (select count(*) from public.smokes where not_mine is not true),
			'sessions_7', (select count(*) from public.smokes
			               where not_mine is not true and date >= current_date - 6),
			'sessions_by_day_30', coalesce((select arr from sessions_by_day), '[]'::jsonb),
			'avg_sessions_per_user', round(
				(select count(*) from public.smokes where not_mine is not true)::numeric
				/ nullif(v_total_users, 0), 1),
			'dau', (select count(distinct user_id) from public.smokes
			        where not_mine is not true and created_at >= now() - interval '24 hours'),
			'mau', (select count(distinct user_id) from public.smokes
			        where not_mine is not true and created_at >= now() - interval '30 days'),
			'dau_mau_pct', round(
				100.0 * (select count(distinct user_id) from public.smokes
				         where not_mine is not true and created_at >= now() - interval '24 hours')
				/ nullif((select count(distinct user_id) from public.smokes
				          where not_mine is not true and created_at >= now() - interval '30 days'), 0), 1)
		),
		'adoption', jsonb_build_object(
			'pct_shared_session', round(100.0 * (select count(*) from shared_users) / nullif(v_total_users, 0), 1),
			'pct_tolerance_break', round(100.0 * (select count(*) from break_users) / nullif(v_total_users, 0), 1),
			'pct_in_leaderboard', round(100.0 * (select count(*) from leaderboard_users) / nullif(v_total_users, 0), 1),
			'streak_buckets', (select jsonb_build_object(
				'zero', zero, 'd1_7', d1_7, 'd8_30', d8_30, 'd31_plus', d31_plus) from streak_buckets)
		),
		'recent_users', coalesce((select arr from recent_json), '[]'::jsonb)
	) into result;

	return result;
end;
$$;

revoke all on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;
```

- [ ] **Step 2: Apply the function to the database**

Preferred: Supabase MCP `apply_migration` with `name = "add_admin_dashboard_stats"` and the file's SQL as `query`.
Alternative (project convention): ask Matteo to paste the file into the Supabase SQL editor and run it.

- [ ] **Step 3: Verify the gate rejects a non-owner caller**

Run via MCP `execute_sql`:
```sql
select public.admin_dashboard_stats();
```
Expected: **ERROR** `not authorized` (the MCP connection has no JWT email claim). If it returns JSON instead, the guard is wrong — stop and fix.

- [ ] **Step 4: Verify the happy path returns a well-formed document**

Run via MCP `execute_sql` (single call, one transaction):
```sql
begin;
select set_config('request.jwt.claims',
	'{"email":"poggi.matteo.2005@gmail.com","role":"authenticated"}', true);
select jsonb_pretty(public.admin_dashboard_stats());
rollback;
```
Expected: a JSON document with every key from the Interfaces block. Check specifically:
- `growth.signups_by_day` and `usage.sessions_by_day_30` each have **exactly 30** entries, oldest first, no gaps.
- `adoption.streak_buckets` values sum to `growth.total_users`.
- `recent_users` has ≤20 entries, `created_at` descending, `username` is `null` (not `""`) for profile-less users.

- [ ] **Step 5: Cross-check each aggregate against an independent query**

Run via MCP `execute_sql` and compare each number to the document from Step 4:
```sql
select
	(select count(*) from auth.users) as total_users,
	(select count(*) from auth.users where created_at::date = current_date) as new_today,
	(select count(*) from auth.users where created_at >= now() - interval '7 days') as new_d7,
	(select count(*) from auth.users where created_at >= now() - interval '30 days') as new_d30,
	(select count(*) from public.smokes where not_mine is not true) as total_sessions,
	(select count(distinct user_id) from public.smokes
	 where not_mine is not true and created_at >= now() - interval '24 hours') as dau,
	(select count(distinct user_id) from public.smokes
	 where not_mine is not true and created_at >= now() - interval '30 days') as mau,
	(select count(distinct user_id) from public.tolerance_breaks) as break_users,
	(select count(distinct s.user_id) from public.smokes s
	 join public.profiles p on p.id = s.user_id
	 where s.not_mine is not true and p.username is not null) as leaderboard_users;
```
Expected: `total_users` matches `growth.total_users`; `new_*` match `growth.new_users.*`; `total_sessions`, `dau`, `mau` match `usage.*`; `break_users`/`total_users` and `leaderboard_users`/`total_users` match the rounded `adoption.pct_*` values (±0.1).

- [ ] **Step 6: Verify streak logic against `calculateStreak()`**

Run via MCP `execute_sql`:
```sql
with user_days as (
	select distinct user_id, date as d from public.smokes where not_mine is not true
),
islands as (
	select user_id, d, d - (row_number() over (partition by user_id order by d))::int as grp
	from user_days
),
current_run as (
	select i.user_id, count(*) as run_len, max(i.d) as last_day
	from islands i
	where i.grp = (select i2.grp from islands i2 where i2.user_id = i.user_id order by i2.d desc limit 1)
	group by i.user_id
)
select u.id,
	case when cr.last_day is null or cr.last_day < current_date - 1 then 0 else cr.run_len end as streak,
	cr.last_day
from auth.users u left join current_run cr on cr.user_id = u.id
order by streak desc;
```
Expected: for any user whose most recent session is older than yesterday, `streak = 0`. For a user with sessions today/yesterday and the day before, `streak >= 2`. Manually re-run `calculateStreak()`'s logic on one non-zero user's distinct dates and confirm it matches.

- [ ] **Step 7: Document the function in `CLAUDE.md`**

In `CLAUDE.md`, under "## Sicurezza — regole non negoziabili" in the bulleted `SECURITY DEFINER` list, add (as the last sub-bullet, matching the existing style and indentation):
```
  - `admin_dashboard_stats()` — dashboard di amministrazione owner-only (`/admin`): aggrega `auth.users`, e `smokes`/`tolerance_breaks`/`profiles` di TUTTI gli utenti per crescita/utilizzo/adozione feature; la RLS normalmente limita ognuno alle proprie righe e `auth.users` non è raggiungibile dal client. Protetta da un controllo email hardcoded su `auth.jwt() ->> 'email'` (solo `poggi.matteo.2005@gmail.com`), `execute` concesso solo a `authenticated` e revocato da `anon`/`public`. Nessuna tabella nuova, quindi nessuna nuova RLS policy.
```
Then, in "## Aree sensibili" or near the site-structure notes, add one line:
```
- Esiste una pagina admin privata a `/admin` (`admin.html`, standalone, `noindex`, non linkata da nessuna parte) — vedi `docs/superpowers/specs/2026-08-28-admin-dashboard-design.md`.
```

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260828120000_add_admin_dashboard_stats.sql CLAUDE.md
git commit -m "feat: add admin_dashboard_stats RPC (owner-only aggregate)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `admin.html` — scaffold, theme, auth gate, loading/error states

**Files:**
- Create: `admin.html` (repo root)
- Create: `.claude/launch.json`

**Interfaces:**
- Consumes: `public.admin_dashboard_stats()` from Task 1 (via `supabaseClient.rpc('admin_dashboard_stats')`).
- Produces (inside the module scope of `admin.html`, used by Task 3):
  - `const ADMIN_EMAIL = 'poggi.matteo.2005@gmail.com'`
  - `function escapeHtml(str): string`
  - `function el(id): HTMLElement` — `document.getElementById` shorthand
  - `function showState(name)` where `name ∈ 'loading' | 'error' | 'ready'` — toggles `#state-loading`, `#state-error`, `#dashboard` visibility
  - `function renderError(message: string)` — fills `#state-error-msg`, calls `showState('error')`
  - `async function loadDashboard()` — calls the RPC, on success calls `render(data)` (defined in Task 3) then `showState('ready')`, on failure calls `renderError(err.message)`
  - `function render(data)` — **stub in this task** (`function render(data) { /* Task 3 */ }`), fully implemented in Task 3
  - DOM contract Task 3 relies on: a `<main id="dashboard" hidden>` containing four `<section>`s with ids `sec-growth`, `sec-usage`, `sec-adoption`, `sec-recent`, each already holding an `<h2>` and an empty `<div class="sec-body">`.

- [ ] **Step 1: Create `.claude/launch.json`**

```json
{
	"version": "0.0.1",
	"configurations": [
		{
			"name": "static",
			"runtimeExecutable": "npx",
			"runtimeArgs": ["-y", "serve", "-l", "3000", "."],
			"port": 3000
		}
	]
}
```

- [ ] **Step 2: Create `admin.html` with scaffold + gate + states**

Create `admin.html` (tabs for indentation):

```html
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>JointTracker — Admin</title>
<meta name="robots" content="noindex, nofollow">
<script>
(function () {
	try {
		var pref = localStorage.getItem('jt_theme') || 'dark';
		var resolved = pref === 'auto'
			? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
			: pref;
		document.documentElement.setAttribute('data-theme', resolved);
	} catch (e) {
		document.documentElement.setAttribute('data-theme', 'dark');
	}
})();
</script>
<style>
:root{--primary:#2e7d32;--primary-light:#4caf50;--primary-dark:#1b5e20;--heading:#1b5e20;--danger:#ff3b30;--bg:#f4f7f6;--surface-rgb:255,255,255;--overlay-rgb:0,0,0;--color-text:#1c1c1e;--color-text-secondary:#666;--color-text-muted:#6b6b6b}
:root[data-theme="dark"]{--primary-light:#57c15c;--heading:#6fcf72;--bg:#0c120c;--surface-rgb:24,32,24;--overlay-rgb:255,255,255;--color-text:#eef2ee;--color-text-secondary:#b7c3b7;--color-text-muted:#8a978a}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--color-text);background:var(--bg);overflow-x:hidden}
.wrap{max-width:640px;margin:0 auto}
h1{font-size:20px;margin:0 0 16px}
h2{font-size:15px;color:var(--heading);margin:0 0 10px}
.card{background:rgba(var(--surface-rgb),.97);border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 4px 16px rgba(0,0,0,.12)}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.stat{background:rgba(var(--overlay-rgb),.04);border-radius:12px;padding:12px}
.stat .label{font-size:11px;color:var(--color-text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.stat .big{font-size:30px;font-weight:700;line-height:1.1;margin-top:4px}
.stat .sub{font-size:12px;color:var(--color-text-secondary);margin-top:2px}
.trend-up{color:var(--primary-light)}
.trend-down{color:var(--danger)}
.trend-flat{color:var(--color-text-muted)}
.bar-track{background:rgba(var(--overlay-rgb),.08);border-radius:6px;height:8px;overflow:hidden;margin-top:8px}
.bar-fill{height:100%;background:var(--primary-light);border-radius:6px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid rgba(var(--overlay-rgb),.08)}
th{font-size:11px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.03em}
td.num{text-align:right;font-variant-numeric:tabular-nums}
svg.chart{width:100%;height:auto;display:block}
.spinner{display:inline-block;width:24px;height:24px;border:3px solid rgba(var(--overlay-rgb),.15);border-radius:50%;border-top-color:var(--primary-light);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.center{text-align:center;padding:48px 0;color:var(--color-text-muted)}
.errbox{border:1px solid var(--danger);border-radius:12px;padding:16px;color:var(--danger)}
button.retry{margin-top:12px;background:var(--primary-dark);color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:600;cursor:pointer}
[hidden]{display:none !important}
</style>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" defer></script>
</head>
<body>
<div class="wrap">
	<div id="state-loading" class="center"><div class="spinner"></div><div style="margin-top:12px">Caricamento…</div></div>
	<div id="state-error" hidden><div class="errbox"><strong>Errore nel caricamento</strong><div id="state-error-msg" style="margin-top:6px;font-size:13px"></div><button class="retry" id="retryBtn">Riprova</button></div></div>

	<main id="dashboard" hidden>
		<h1>📊 JointTracker Admin</h1>
		<section id="sec-growth" class="card"><h2>Crescita</h2><div class="sec-body"></div></section>
		<section id="sec-usage" class="card"><h2>Utilizzo</h2><div class="sec-body"></div></section>
		<section id="sec-adoption" class="card"><h2>Adozione feature</h2><div class="sec-body"></div></section>
		<section id="sec-recent" class="card"><h2>Ultimi 20 iscritti</h2><div class="sec-body"></div></section>
	</main>
</div>

<script type="module">
const SUPABASE_URL = 'https://afkxmbxcavwhurmdelfr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1rc0ueZL6Y03qhk5jp_34w_ObCOCpCP';
const ADMIN_EMAIL = 'poggi.matteo.2005@gmail.com';

function el(id) { return document.getElementById(id); }

function escapeHtml(str) {
	if (str === null || str === undefined) return '';
	return String(str)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showState(name) {
	el('state-loading').hidden = name !== 'loading';
	el('state-error').hidden = name !== 'error';
	el('dashboard').hidden = name !== 'ready';
}

function renderError(message) {
	el('state-error-msg').textContent = message || 'Errore sconosciuto';
	showState('error');
}

function render(data) { /* implemented in Task 3 */ }

let supabaseClient;

async function loadDashboard() {
	showState('loading');
	try {
		const { data, error } = await supabaseClient.rpc('admin_dashboard_stats');
		if (error) throw new Error(error.message || 'RPC fallita');
		render(data);
		showState('ready');
	} catch (err) {
		renderError(err.message);
	}
}

async function init() {
	// supabase-js is loaded with `defer`; wait for it if needed.
	if (!window.supabase) {
		await new Promise(res => {
			const t = setInterval(() => { if (window.supabase) { clearInterval(t); res(); } }, 20);
		});
	}
	supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

	const { data: { session } } = await supabaseClient.auth.getSession();
	if (!session || session.user.email !== ADMIN_EMAIL) {
		window.location.replace('/');
		return;
	}

	el('retryBtn').addEventListener('click', loadDashboard);
	await loadDashboard();
}

init();
</script>
</body>
</html>
```

- [ ] **Step 3: Start the local preview server**

Use the preview tool: `preview_start` with `{ name: "static" }`. It serves the repo root at `http://localhost:3000`.

- [ ] **Step 4: Verify the logged-out gate**

Navigate the preview browser to `http://localhost:3000/admin.html` (no session in this browser's localStorage).
Expected: the URL immediately changes to `http://localhost:3000/` (redirect to home). `read_console_messages` shows no uncaught errors. The admin markup never becomes visible.

- [ ] **Step 5: Verify the loading and error states render**

In the preview browser, temporarily bypass the gate to see the states: via `javascript_tool` run
```js
history.pushState({}, '', '/admin.html');
```
then reload is not enough (still no session). Instead, in `javascript_tool`, directly exercise the state machine:
```js
document.getElementById('dashboard').hidden = true;
document.getElementById('state-loading').hidden = true;
document.getElementById('state-error').hidden = false;
document.getElementById('state-error-msg').textContent = 'Test error';
```
Expected screenshot: red-bordered "Errore nel caricamento / Test error" box with a "Riprova" button. Then set `state-error` hidden and `state-loading` visible — expect the spinner + "Caricamento…". This confirms the CSS/markup; it is a throwaway check, change nothing in the file.

- [ ] **Step 6: Commit**

```bash
git add admin.html .claude/launch.json
git commit -m "feat: admin.html scaffold with auth gate and loading/error states

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `admin.html` — chart helper and the four render sections

**Files:**
- Modify: `admin.html` (replace the `render` stub; add `renderBarChart` + four section renderers inside the existing `<script type="module">`)

**Interfaces:**
- Consumes from Task 2: `el`, `escapeHtml`, the `#sec-*` / `.sec-body` DOM contract, and the `data` object shaped per Task 1's Interfaces block.
- Produces: a working `render(data)` that fills all four `.sec-body` divs. No exports (same module scope).

- [ ] **Step 1: Add the `renderBarChart` helper**

Inside the `<script type="module">` in `admin.html`, above `function render`, add:

```js
// Minimal inline-SVG bar chart. data: [{ day:'YYYY-MM-DD', count:int }]. No library.
function renderBarChart(data, opts = {}) {
	const w = 600, h = opts.height || 120, pad = 18;
	const max = Math.max(1, ...data.map(d => d.count));
	const bw = (w - pad * 2) / data.length;
	const bars = data.map((d, i) => {
		const bh = Math.round((h - pad * 2) * (d.count / max));
		const x = pad + i * bw;
		const y = h - pad - bh;
		return `<rect x="${(x + 1).toFixed(1)}" y="${y}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh}" rx="1" fill="var(--primary-light)"><title>${escapeHtml(d.day)}: ${d.count}</title></rect>`;
	}).join('');
	// x labels: every ~5th day
	const labels = data.map((d, i) => {
		if (i % 5 !== 0) return '';
		const x = pad + i * bw + bw / 2;
		return `<text x="${x.toFixed(1)}" y="${h - 4}" font-size="9" text-anchor="middle" fill="var(--color-text-muted)">${d.day.slice(5)}</text>`;
	}).join('');
	const baseline = `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="rgba(128,128,128,.35)" stroke-width="1"/>`;
	const maxLabel = `<text x="${pad}" y="12" font-size="10" fill="var(--color-text-muted)">max ${max}</text>`;
	return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${maxLabel}${bars}${baseline}${labels}</svg>`;
}

function trendChip(cur, prev) {
	if (cur > prev) return `<span class="trend-up">▲ ${cur - prev}</span>`;
	if (cur < prev) return `<span class="trend-down">▼ ${prev - cur}</span>`;
	return `<span class="trend-flat">–</span>`;
}

function pctRow(label, value) {
	return `<div class="stat"><div class="label">${escapeHtml(label)}</div><div class="big">${value}%</div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, value)}%"></div></div></div>`;
}
```

- [ ] **Step 2: Replace the `render` stub with the full implementation**

Replace `function render(data) { /* implemented in Task 3 */ }` with:

```js
function render(data) {
	const g = data.growth, u = data.usage, a = data.adoption;

	// --- Crescita ---
	el('sec-growth').querySelector('.sec-body').innerHTML = `
		<div class="grid">
			<div class="stat"><div class="label">Utenti totali</div><div class="big">${g.total_users}</div><div class="sub">oggi +${g.new_users.today}</div></div>
			<div class="stat"><div class="label">Nuovi 7gg</div><div class="big">${g.new_users.d7}</div><div class="sub">${trendChip(g.new_users.d7, g.new_users_prev.d7)} vs 7gg prec.</div></div>
			<div class="stat"><div class="label">Nuovi 30gg</div><div class="big">${g.new_users.d30}</div><div class="sub">${trendChip(g.new_users.d30, g.new_users_prev.d30)} vs 30gg prec.</div></div>
		</div>
		<div style="margin-top:12px"><div class="label" style="font-size:11px;color:var(--color-text-muted)">Iscrizioni / giorno (30gg)</div>${renderBarChart(g.signups_by_day)}</div>`;

	// --- Utilizzo ---
	el('sec-usage').querySelector('.sec-body').innerHTML = `
		<div class="grid">
			<div class="stat"><div class="label">Sessioni totali</div><div class="big">${u.total_sessions}</div></div>
			<div class="stat"><div class="label">Media / utente</div><div class="big">${u.avg_sessions_per_user}</div></div>
			<div class="stat"><div class="label">DAU (24h)</div><div class="big">${u.dau}</div></div>
			<div class="stat"><div class="label">MAU (30gg)</div><div class="big">${u.mau}</div><div class="sub">DAU/MAU ${u.dau_mau_pct}%</div></div>
		</div>
		<div style="margin-top:12px"><div class="label" style="font-size:11px;color:var(--color-text-muted)">Sessioni / giorno (30gg) — ultimi 7gg: ${u.sessions_7}</div>${renderBarChart(u.sessions_by_day_30)}</div>`;

	// --- Adozione feature ---
	const sb = a.streak_buckets;
	const maxBucket = Math.max(1, sb.zero, sb.d1_7, sb.d8_30, sb.d31_plus);
	const bucketRow = (label, n) => `<div style="display:flex;align-items:center;gap:8px;margin-top:6px">
		<span style="width:56px;font-size:12px;color:var(--color-text-secondary)">${label}</span>
		<div class="bar-track" style="flex:1;margin-top:0"><div class="bar-fill" style="width:${(n / maxBucket) * 100}%"></div></div>
		<span style="width:24px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums">${n}</span></div>`;
	el('sec-adoption').querySelector('.sec-body').innerHTML = `
		<div class="grid">
			${pctRow('Shared session', a.pct_shared_session)}
			${pctRow('Tolerance break', a.pct_tolerance_break)}
			${pctRow('In classifica', a.pct_in_leaderboard)}
		</div>
		<div style="margin-top:14px"><div class="label" style="font-size:11px;color:var(--color-text-muted)">Distribuzione streak</div>
			${bucketRow('0 gg', sb.zero)}
			${bucketRow('1–7 gg', sb.d1_7)}
			${bucketRow('8–30 gg', sb.d8_30)}
			${bucketRow('31+ gg', sb.d31_plus)}
		</div>`;

	// --- Ultimi 20 iscritti ---
	const rows = data.recent_users.map(r => `<tr>
		<td>${escapeHtml((r.created_at || '').slice(0, 10))}</td>
		<td>${r.username ? escapeHtml(r.username) : '—'}</td>
		<td class="num">${r.session_count}</td></tr>`).join('');
	el('sec-recent').querySelector('.sec-body').innerHTML = `
		<table><thead><tr><th>Registrato</th><th>Username</th><th class="num">Sessioni</th></tr></thead>
		<tbody>${rows || '<tr><td colspan="3" style="color:var(--color-text-muted)">Nessun utente</td></tr>'}</tbody></table>`;
}
```

- [ ] **Step 3: Pull a real RPC payload for visual verification**

Run via MCP `execute_sql` (one call):
```sql
begin;
select set_config('request.jwt.claims', '{"email":"poggi.matteo.2005@gmail.com","role":"authenticated"}', true);
select public.admin_dashboard_stats();
rollback;
```
Copy the returned JSON.

- [ ] **Step 4: Render the real payload in the preview browser and screenshot**

The auth gate and the module scope make a clean in-browser injection impossible, so use a **temporary throwaway edit** purely for visual verification:

1. In `admin.html`, comment out the four gate lines so the page always proceeds:
   ```js
   // if (!session || session.user.email !== ADMIN_EMAIL) {
   //     window.location.replace('/');
   //     return;
   // }
   ```
2. In `loadDashboard()`, replace the `supabaseClient.rpc(...)` line with the payload from Step 3:
   ```js
   const data = /* <paste JSON from Step 3> */, error = null;
   ```
3. With the preview server running, navigate to `http://localhost:3000/admin.html`. Screenshot all four sections.
4. `resize_window` to 375px width, reload, screenshot again.

Confirm from the screenshots: charts render exactly 30 bars scaled under the "max N" label; the streak bars' counts sum to `total_users`; the table shows `YYYY-MM-DD` dates and `—` for null usernames; **no horizontal scroll at 375px**; legible in the current theme.

5. **Revert both edits.** Run `git diff admin.html` and confirm the only remaining changes are the intended Task 3 additions (`renderBarChart`, `trendChip`, `pctRow`, the full `render`). The gate and the real `rpc(...)` call must be back exactly as Task 2 left them.

- [ ] **Step 5: Verify no console errors with the reverted file**

Reload `http://localhost:3000/admin.html` (gate restored). Expected: redirect to `/`, `read_console_messages` clean.

- [ ] **Step 6: Commit**

```bash
git add admin.html
git commit -m "feat: admin dashboard rendering + inline-SVG bar charts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Routing, build, and robots wiring

**Files:**
- Modify: `vercel.json` (rewrites array)
- Modify: `build.mjs` (`STATIC_ENTRIES`)
- Modify: `robots.txt`

**Interfaces:**
- Consumes: `admin.html` from Tasks 2–3.
- Produces: `/admin` serves `admin.html` in production; `dist/admin.html` and updated `dist/robots.txt` exist after `npm run build`.

- [ ] **Step 1: Add the rewrite to `vercel.json`**

In the `"rewrites"` array, add as the first entry (after `/app`):
```json
		{ "source": "/admin", "destination": "/admin.html" },
```
Place it right after the `{ "source": "/app", "destination": "/app/index.html" }` line.

- [ ] **Step 2: Add `admin.html` to the build's static entries**

In `build.mjs`, in the `STATIC_ENTRIES` array, add `'admin.html'` to the line that currently reads:
```js
	'index.html', 'come-funziona.html', 'faq.html', 'blog', 'marketing.css', 'og-image.png'
```
making it:
```js
	'index.html', 'come-funziona.html', 'faq.html', 'blog', 'marketing.css', 'og-image.png',
	'admin.html'
```

- [ ] **Step 3: Disallow `/admin` in `robots.txt`**

Change `robots.txt` from:
```
User-agent: *
Allow: /

Sitemap: https://joint-tracker.vercel.app/sitemap.xml
```
to:
```
User-agent: *
Allow: /
Disallow: /admin

Sitemap: https://joint-tracker.vercel.app/sitemap.xml
```

- [ ] **Step 4: Run the build and verify output**

```bash
npm run build
```
Then:
```bash
test -f dist/admin.html && echo "admin.html OK"
grep -c "Disallow: /admin" dist/robots.txt
grep -c '"/admin"' vercel.json
```
Expected: `admin.html OK`; the two `grep -c` print `1` and `1`. Build exits 0 with the usual "Build completata" line.

- [ ] **Step 5: Verify `dist/admin.html` is byte-identical to the source**

```bash
diff admin.html dist/admin.html && echo "identical (not hashed, as intended)"
```
Expected: no diff — the page is copied verbatim, not run through esbuild.

- [ ] **Step 6: Commit**

```bash
git add vercel.json build.mjs robots.txt
git commit -m "feat: route /admin, include admin.html in build, disallow in robots

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Production integration verification & branch finish

**Files:** none (verification + merge only).

**Interfaces:**
- Consumes: everything from Tasks 1–4, after Matteo has (a) applied the migration if not already applied via MCP in Task 1, and (b) merged/pushed the branch so Vercel deploys.

- [ ] **Step 1: Confirm the migration is live in production**

Via MCP `execute_sql`:
```sql
select proname, prosecdef from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname = 'admin_dashboard_stats';
```
Expected: one row, `prosecdef = true`. If missing, Matteo must run the migration file in the Supabase SQL editor before continuing.

- [ ] **Step 2: Ask Matteo to push/merge and confirm deploy**

Tell Matteo: merge `feat/admin-dashboard` (or push it) so Vercel deploys. Wait for the deploy to finish (`joint-tracker.vercel.app`).

- [ ] **Step 3: Verify the production gate for a logged-out visitor**

Use the preview browser (or `navigate`) to `https://joint-tracker.vercel.app/admin`.
Expected: redirected to `https://joint-tracker.vercel.app/` (the marketing landing page). View source of `/admin` before JS runs (via `read_network_requests` on the document response) shows the admin markup is present but `#dashboard` stays `hidden` and the redirect fires. `read_console_messages`: no uncaught errors.

- [ ] **Step 4: Verify `/admin` is not crawlable**

```bash
curl -s https://joint-tracker.vercel.app/robots.txt
```
Expected: contains `Disallow: /admin`.

- [ ] **Step 5: Cross-check the deployed dashboard numbers**

Pull the live payload via MCP (`execute_sql` with the simulated admin claim, as in Task 1 Step 4). Have Matteo open `https://joint-tracker.vercel.app/admin` while logged in as the owner and screenshot / read out the four sections. Compare every number to the MCP payload. They must match exactly (percentages ±0.1 from rounding).

- [ ] **Step 6: Responsive check**

Matteo (logged in) views `/admin` at ~375px width (devtools or phone). Confirm: no horizontal scroll, charts fit, table readable, both dark and light themes legible (toggle `localStorage.jt_theme`).

- [ ] **Step 7: Finish the branch**

Invoke `superpowers:finishing-a-development-branch` to decide merge/PR handling. Default here (matches project convention): fast-forward merge `feat/admin-dashboard` into `main` and push.

```bash
git checkout main
git merge --ff-only feat/admin-dashboard
git push origin main
```

- [ ] **Step 8: Update memory**

Add/update the project memory: note that `/admin` exists (`admin.html`, standalone, owner-only via `admin_dashboard_stats()` RPC email guard), and that the RPC migration `20260828120000_add_admin_dashboard_stats.sql` was applied manually / via MCP on 2026-08-28.

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| Route `/admin` | Task 4 Step 1 |
| Auth gate: logged-in user email must equal owner, else redirect home, render nothing | Task 2 Step 2 (gate), Steps 4 & Task 5 Step 3 (verify) |
| Server-side protection not dependent on client (spec asked "RLS policy"; design D1 → definer-function email guard) | Task 1 Step 1, verified Steps 3–4 |
| Not linked anywhere in public UI | No link added anywhere; Task 1 Step 7 documents it; Task 4 Step 3 robots |
| §1 Growth: total users, new users today/7/30 + trend, signups/day chart 30d | Task 1 (`growth.*`), Task 3 Step 2 (Crescita section) |
| §2 Usage: total sessions, sessions/day 7 & 30, avg per user, DAU/MAU | Task 1 (`usage.*`), Task 3 Step 2 (Utilizzo) |
| §3 Adoption: % shared, % tolerance break, % leaderboard, streak distribution | Task 1 (`adoption.*`), Task 3 Step 2 (Adozione) |
| §4 Quick view: last 20 users (date, name/username, session count) | Task 1 (`recent_users`), Task 3 Step 2 (table) |
| Real-time, direct queries every load, no cache | Single RPC call in `loadDashboard()` on every page load; no storage/caching added |
| Design: green palette, dark mode, mobile-first, vanilla, no build step | Task 2 Step 2 CSS (copied palette + `data-theme`), self-contained file |
| Card layout, big readable numbers | Task 2 CSS `.card`/`.stat .big`, Task 3 markup |
| No heavy charting lib — simple SVG/canvas | Task 3 Step 1 `renderBarChart` (inline SVG, no dep) |
| Loading state + failed-query state (error, not blank) | Task 2 Step 2 (`showState`/`renderError`), Task 3 keeps `render` pure; verified Task 2 Step 5 |
| Queries respect existing RLS; no service-role key client-side | RPC is `SECURITY DEFINER` owned by definer, page uses publishable key only (Global Constraints, Task 1) |
| Document SECURITY DEFINER fn in CLAUDE.md | Task 1 Step 7 |

No gaps found.

**2. Placeholder scan:** The only stub (`render` in Task 2) is explicitly labelled as such, replaced with full code in Task 3 Step 2. Task 3 Step 4 describes a fiddly local-verification path; it gives a concrete fallback (temporarily comment gate + stub RPC with pasted JSON, screenshot, revert) rather than leaving it vague. No "TBD"/"handle edge cases"/"add validation" language. All code steps contain real code.

**3. Type consistency:**
- RPC return keys in Task 1 Interfaces (`growth.new_users.d7`, `growth.new_users_prev.d7`, `usage.sessions_by_day_30`, `usage.sessions_7`, `adoption.streak_buckets.d1_7/d8_30/d31_plus`, `recent_users[].session_count`) are exactly the keys read in Task 3 Step 2 `render()`. Checked field by field — consistent.
- `showState('loading'|'error'|'ready')` values match between definition (Task 2) and calls (`loadDashboard`, `renderError`).
- `renderBarChart(data)` expects `[{day,count}]`; both `g.signups_by_day` and `u.sessions_by_day_30` have that shape per Task 1. Consistent.
- `escapeHtml` signature identical to the `app.js` original (Global Constraints).
- Migration filename identical in Task 1 Step 1, Task 1 Step 8, Task 5 Step 1/8.

No inconsistencies found.
