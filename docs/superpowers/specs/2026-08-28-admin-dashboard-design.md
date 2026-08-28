# JointTracker — Admin Dashboard — Design

**Date:** 2026-08-28
**Status:** Approved for planning
**Author:** Matteo + Claude

## 1. Goal

A private, real-time statistics dashboard for JointTracker, reachable at `/admin`,
visible only to the owner (`poggi.matteo.2005@gmail.com`). Every load runs fresh
queries against Supabase — no caching. Not linked from any public UI.

## 2. Context / constraints discovered

Inspected against the live Supabase project `afkxmbxcavwhurmdelfr` on 2026-08-28
(18 users, 1561 `smokes` rows, 4 `tolerance_breaks`, 10 `friendships`).

- **No dedicated tables** for sessions / shared sessions / leaderboards / streaks:
  - Sessions = `public.smokes`.
  - Shared sessions = `smokes` rows carrying `shared_with` (jsonb array) for the
    owner, and `not_mine = true` duplicate rows for the other participants;
    created via the `create_shared_session(...)` `SECURITY DEFINER` RPC.
  - Leaderboards are computed on the fly by `SECURITY DEFINER` functions
    (`get_global_leaderboard()`, `get_friends_leaderboard(uuid)`, …).
  - "Streak" is computed client-side in `app.js` `calculateStreak()` — consecutive
    days that have at least one logged session, ending today or yesterday, else 0.
    Only `user_stats.best_streak` and `user_stats.elevated_since` are persisted.
- **`public.profiles` has no `created_at`.** Registration timestamps exist only in
  `auth.users.created_at`, which is not reachable from the client under any RLS
  policy. This is why aggregation must happen server-side in a definer function.
- `public.tolerance_breaks` columns: `user_id`, `start_date`, `end_date`,
  `is_active`, `confirmed_at`, `attempted`, `origin` (`auto` | `planned`), …
  A row exists only once a break has been started (auto-detected or planned).
- `public.smokes` time columns: `date` (session day, `date`), `time` (text),
  `ts` (epoch **milliseconds**, `bigint`), `created_at` (`timestamp` stored in UTC).
- Client bootstrap: `app.js:2-4` — `SUPABASE_URL`, publishable key
  `sb_publishable_1rc0ueZL6Y03qhk5jp_34w_ObCOCpCP`, `window.supabase.createClient`.
  The auth session is persisted by supabase-js in `localStorage`, per origin, so a
  separate page on the same origin can read it.
- Build (`build.mjs`): marketing/SEO pages (`index.html`, `faq.html`,
  `come-funziona.html`, `blog/`) are listed in `STATIC_ENTRIES` and copied to
  `dist/` verbatim; only the SPA (`app/index.html`, `app.js`, `i18n.js`,
  `style.css`) goes through esbuild minification + content-hash renaming.
- `vercel.json` sets `Cache-Control: public, max-age=31536000, immutable` on every
  `*.js` / `*.css`; HTML gets `max-age=0, must-revalidate`.
- Security rules (`CLAUDE.md`): every new table needs RLS before merge; every
  `SECURITY DEFINER` function must be documented in `CLAUDE.md` with rationale;
  never expose the service-role key client-side.
- Deploy: pushing `main` auto-deploys the frontend on Vercel. **Supabase
  migrations are NOT auto-applied** — they are run by hand in the Supabase SQL
  editor. Claude Code has no DB/Edge-Function deploy access from this repo.

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Admin gate mechanism | Single `SECURITY DEFINER` RPC with a **hardcoded email check** (`auth.jwt() ->> 'email'`) that raises on mismatch. No `admin_allowlist` table. |
| D2 | Page structure | **Standalone self-contained `admin.html`** at repo root (inline CSS + JS), added to `STATIC_ENTRIES`. Not inside the SPA. |
| D3 | "Present in a leaderboard" | User has **≥1 non-`not_mine` session AND a non-null `username`** (i.e. would appear in `get_global_leaderboard()`). |
| D4 | Session counting | **Exclude `not_mine` rows** everywhere: `COUNT(*) FILTER (WHERE not_mine IS NOT TRUE)`. Applies to totals, per-user averages, DAU/MAU, and the recent-users table. |
| D5 | Streak buckets | Non-overlapping edges: `0` / `1–7` / `8–30` / `31+`, labelled exactly in the UI so the spec's "7gg / 30gg" overlap is resolved visibly. |
| D6 | "Real-time" | Direct queries on every page load. No client or server caching. Not websocket/subscription real-time. |

## 4. Architecture

### 4.1 Files touched

| File | Change |
|------|--------|
| `admin.html` (new, repo root) | Self-contained page: inline `<style>`, inline `<script type="module">`, supabase-js from CDN. |
| `vercel.json` | Add rewrite `{ "source": "/admin", "destination": "/admin.html" }`. |
| `build.mjs` | Add `'admin.html'` to `STATIC_ENTRIES`. |
| `robots.txt` | Add `Disallow: /admin`. |
| `supabase/migrations/<ts>_add_admin_dashboard_stats.sql` (new) | The RPC + grants. |
| `CLAUDE.md` | Document `admin_dashboard_stats()` under the `SECURITY DEFINER` list and note `/admin` exists. |

No changes to `app.js`, `app/index.html`, `style.css`, `sw.js`, or the service worker
precache (the admin page is intentionally outside the PWA scope).

### 4.2 The RPC — `public.admin_dashboard_stats()`

- `RETURNS jsonb`, `LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = public, auth`.
- First statement — the gate:
  ```sql
  if coalesce(auth.jwt() ->> 'email', '') <> 'poggi.matteo.2005@gmail.com' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  ```
- Grants:
  ```sql
  revoke all on function public.admin_dashboard_stats() from public, anon;
  grant execute on function public.admin_dashboard_stats() to authenticated;
  ```
- All aggregation happens inside this one function. Returns a single `jsonb`
  document (shape in §5). No parameters (avoids any injection surface).
- Date math uses `current_date` / `now()` at `UTC` (matches how `smokes.created_at`
  and `auth.users.created_at` are stored).

### 4.3 Client flow (`admin.html` script)

1. Apply theme from `localStorage['jt_theme']` before paint (copy the SPA's 6-line
   inline snippet).
2. `createClient(URL, PUBLISHABLE_KEY)` with the same constants as `app.js`.
3. `const { data: { session } } = await supabaseClient.auth.getSession()`.
4. If `!session || session.user.email !== 'poggi.matteo.2005@gmail.com'` →
   `window.location.replace('/')` and return. Body stays empty until this check
   passes (render nothing for non-admins).
5. Show the loading state. `await supabaseClient.rpc('admin_dashboard_stats')`.
6. On error (including the definer guard firing) → render the error card with the
   message and a "Riprova" button. Never fall through to a blank page.
7. On success → render all four sections from the returned `jsonb`.

## 5. RPC return shape

```jsonc
{
  "generated_at": "2026-08-28T12:00:00Z",

  "growth": {
    "total_users": 18,
    "new_users":      { "today": 0, "d7": 1, "d30": 3 },
    "new_users_prev": { "d7": 0, "d30": 2 },          // days 8-14 ago, days 31-60 ago
    "signups_by_day": [ { "day": "2026-07-30", "count": 0 }, … 30 entries, zero-filled … ]
  },

  "usage": {
    "total_sessions": 1400,                            // COUNT(*) FILTER (WHERE not_mine IS NOT TRUE)
    "sessions_7": 42,
    "sessions_by_day_30": [ { "day": "2026-07-30", "count": 5 }, … 30 entries, zero-filled … ],
    "avg_sessions_per_user": 77.8,                     // total_sessions / total_users, 1 decimal
    "dau": 4,                                          // distinct user_id, not_mine false, created_at >= now()-24h
    "mau": 12,                                         // distinct user_id, not_mine false, created_at >= now()-30d
    "dau_mau_pct": 33.3
  },

  "adoption": {
    "pct_shared_session": 44.4,     // users who own a row with jsonb_array_length(shared_with) > 0  OR have a not_mine row
    "pct_tolerance_break": 22.2,    // users with >= 1 tolerance_breaks row
    "pct_in_leaderboard": 61.1,     // users with >= 1 non-not_mine session AND username is not null
    "streak_buckets": { "zero": 6, "d1_7": 8, "d8_30": 3, "d31_plus": 1 }   // sums to total_users
  },

  "recent_users": [
    { "created_at": "2026-08-20T22:13:22Z", "username": "mario", "session_count": 12 },
    { "created_at": "…", "username": null, "session_count": 0 },
    … 20 rows, newest first by auth.users.created_at …
  ]
}
```

### 5.1 Aggregate definitions (authoritative)

- **signups_by_day / sessions_by_day**: left-join a `generate_series(current_date - 29, current_date, '1 day')` against the grouped counts so every day appears, including zeros. `signups_by_day` groups `auth.users.created_at::date`; `sessions_by_day_30` groups `smokes.date` (the session day, not insert time) with `not_mine IS NOT TRUE`.
- **new_users trend**: UI shows ▲ if `d7 > new_users_prev.d7`, ▼ if lower, `–` if equal; same for d30.
- **DAU / MAU**: activity = `smokes.created_at` (when the row was inserted), `not_mine IS NOT TRUE`, `COUNT(DISTINCT user_id)`. `dau_mau_pct = round(100 * dau / nullif(mau,0), 1)`.
- **Streak per user**: distinct `smokes.date` per `user_id`; walk backwards from the latest date; if the latest date is older than yesterday → 0; else 1 + count of contiguous preceding days. Implemented as a set-based query (recursive CTE or `generate_series` gap check), not a per-user loop. Bucket by D5 edges.
  Note: the dashboard's streak buckets exclude `not_mine` rows (per D4), whereas the in-app `calculateStreak()` (`app.js`) counts every `smokes` row. A user whose only activity on a given day was a shared session logged by someone else has that day count toward their in-app streak but not toward the dashboard bucket. This is intentional (D4: "everywhere").
- **pct_shared_session**: `user_id` is counted if it owns ≥1 `smokes` row with `shared_with` a non-empty jsonb array, OR owns ≥1 row with `not_mine = true`. `round(100 * matching / total_users, 1)`.
- **pct_tolerance_break**: distinct `user_id` in `tolerance_breaks` / `total_users`.
- **recent_users.session_count**: `COUNT(*)` in `smokes` for that `user_id` with `not_mine IS NOT TRUE`.
- All percentages: one decimal, `0` when `total_users = 0`.

## 6. Page layout & visual design

- Single column, `max-width: 640px`, centered, `padding: 16px`.
- Dark by default; honours `data-theme` from `localStorage['jt_theme']`.
- Palette + fonts: copy the green CSS custom properties and the system font stack
  from `app/index.html`'s critical inline CSS (`--primary #2e7d32`, `--heading`,
  `--bg`, `--surface-rgb`, `--color-text*`, dark overrides under
  `:root[data-theme="dark"]`).
- `.card`: `background: rgba(var(--surface-rgb), .97)`, `border-radius: 16px`,
  `padding: 16px`, `margin-bottom: 12px`, subtle shadow. A `.big` number is
  `font-size: 32px; font-weight: 700`. Section headers `h2` in `--heading`.
- Numbers must be readable in ~5 seconds: label small and muted above/below, value
  large. No decorative elements.

### Sections

1. **Crescita**
   - Row of 3 stat cards: *Utenti totali*, *Nuovi (7gg)*, *Nuovi (30gg)*. The 7/30
     cards show a trend chip (▲ green / ▼ red / – muted) comparing to the previous
     equal window. A small *oggi: N* line under the totals card.
   - Full-width bar chart: 30 bars, `signups_by_day`. Max-value label top-left,
     date ticks every ~5 bars.
2. **Utilizzo**
   - Stat cards: *Sessioni totali*, *Media sessioni / utente*, *DAU*, *MAU*,
     *DAU/MAU %*.
   - Bar chart: 30 bars, `sessions_by_day_30`, with a *ultimi 7gg: N* callout.
3. **Adozione feature**
   - 3 "percent" cards (*Shared session*, *Tolerance break*, *In classifica*):
     big `%` value + a thin horizontal progress bar (`width: <pct>%`,
     `background: var(--primary-light)`).
   - *Distribuzione streak*: 4 labelled horizontal bars — `0 giorni`, `1–7`,
     `8–30`, `31+` — each showing count and a bar scaled to the largest bucket.
4. **Vista rapida**
   - `<table>`: columns *Registrato* (date, `YYYY-MM-DD`), *Username*
     (`—` when null, `escapeHtml()`'d), *Sessioni*. 20 rows.

### Chart helper

```
renderBarChart(container, data /* [{label, value}] */, { height = 120 })
```
~40 lines. Builds an inline `<svg viewBox>` with one `<rect>` per datum
(height ∝ value / max), a baseline `<line>`, a max-value `<text>`, and sparse
x-axis `<text>` labels. Colours from CSS vars. No external library. Responsive
(`width: 100%`, `viewBox` scales).

### States

- **Loading**: full-width card with a centered CSS spinner (copy the `.spinner`
  rule from the SPA critical CSS) + "Caricamento…".
- **Error**: red-bordered card, the caught error `message`, a "Riprova" button
  that re-runs the fetch. Shown instead of the dashboard, never alongside a blank
  page.
- **Empty data** (e.g. `total_users = 0`): sections still render with `0` / `–`,
  charts render an empty baseline. No crash.

## 7. Security review

- New function is `SECURITY DEFINER` → must be listed in `CLAUDE.md` with
  rationale: *aggregates `auth.users` and all users' `smokes` / `tolerance_breaks`
  / `profiles` for the owner-only admin dashboard; gated by a hardcoded email
  check on `auth.jwt()`; `execute` granted only to `authenticated`, revoked from
  `anon` / `public`.*
- No new table → no new RLS policy needed. The server-side email guard is the
  "protection that does not depend on the client" the requirement asks for.
- No service-role key anywhere in `admin.html`; it uses the same publishable key
  as the SPA.
- `admin.html` renders nothing before the email check; non-admins get
  `location.replace('/')`.
- Usernames in the recent-users table pass through `escapeHtml()` before
  `innerHTML` (copy the helper from `app.js`).
- `robots.txt` `Disallow: /admin` + `<meta robots noindex,nofollow>`; page is not
  linked anywhere.
- `/admin` is **within** the service-worker scope — `sw.js` registers at `/sw.js`, so its scope is `/`, not `/app`. It is **not** precached (`PRECACHE_URLS` unchanged), but `sw.js`'s cache-first-with-background-update handler serves it from cache after the first visit. `CACHE_NAME` is derived from the `app.js` content hash (`build.mjs`), so a deploy that changes **only** `admin.html` does not invalidate the cache: the owner sees the previous version for one load, then the background fetch refreshes it. After an admin-only hotfix, hard-reload. The displayed numbers are always fresh regardless — the RPC call bypasses the SW.

## 8. Work split & deployment

**Claude writes:** `admin.html`, `vercel.json` + `build.mjs` + `robots.txt` edits,
the migration SQL file, the `CLAUDE.md` entry.

**Matteo runs:**
1. Paste `supabase/migrations/<ts>_add_admin_dashboard_stats.sql` into the
   Supabase SQL editor and execute it.
2. `git push origin main` → Vercel auto-deploys the page.

**Verification (Claude):**
- RPC: via Supabase MCP `execute_sql`, call the function with the admin JWT claim
  set and with a non-admin claim, confirming (a) non-admin → exception,
  (b) admin → well-formed JSON. Spot-check each aggregate against an independent
  direct query.
- Page gate: load `https://joint-tracker.vercel.app/admin` while logged out →
  expect redirect to `/`. Check console + network are clean.
- Authed dashboard: Claude cannot log in (no password). Cross-check the rendered
  numbers by comparing them to the RPC JSON pulled via MCP; Matteo confirms the
  visual result.
- Responsive: 375px width, no horizontal scroll.

## 9. Out of scope

- Multiple admins / role system (hardcoded single email by decision D1).
- Editing or moderating data from the dashboard — read-only.
- Historical trend charts beyond 30 days.
- Auth via `last_sign_in_at`-based activity (DAU/MAU is session-based per the
  requirement).
- Any i18n — the page is Italian-only, internal.
- PWA / offline support for `/admin`.

## 10. Testing checklist

- [ ] `admin_dashboard_stats()` raises `not authorized` when called without the
      owner email claim.
- [ ] `admin_dashboard_stats()` returns valid JSON with all §5 keys for the owner.
- [ ] Each aggregate matches an independent hand-written query (±0 for counts,
      ±0.1 for rounded percentages).
- [ ] `signups_by_day` / `sessions_by_day_30` always have exactly 30 entries,
      including zero days.
- [ ] `streak_buckets` values sum to `total_users`.
- [ ] Logged-out visit to `/admin` redirects to `/`, renders nothing first.
- [ ] Non-owner logged-in visit redirects to `/` (simulated / reasoned — no
      second prod account available).
- [ ] RPC failure path shows the error card + working "Riprova", not a blank page.
- [ ] Layout has no horizontal scroll at 375px; dark and light themes both legible.
- [ ] `npm run build` succeeds and `dist/admin.html` exists.
- [ ] `CLAUDE.md` updated; grep for `admin_dashboard_stats` finds the doc entry.
