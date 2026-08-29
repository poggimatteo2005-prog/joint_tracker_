# Feed Istantanee (Parte 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare la griglia istantanee della pagina Social in un feed verticale con reazioni emoji, commenti a thread piatto, notifiche in-app aggregate, empty state e conferma di cancellazione con cascade.

**Architecture:** Le istantanee restano righe `public.smokes` con `photo_path` non null. Due tabelle nuove (`snapshot_reactions`, `snapshot_comments`) legate a `smokes.id`. Tutto l'accesso cross-utente passa da RPC `SECURITY DEFINER` che filtrano con `can_see_snapshot` (stesso pattern di ogni feature social esistente). Le notifiche riusano la tabella `notifications` con 4 colonne nuove e aggregazione per giorno solare via `INSERT … ON CONFLICT`. Frontend vanilla, event delegation, nessuna libreria nuova.

**Tech Stack:** PostgreSQL 15 (Supabase, progetto `afkxmbxcavwhurmdelfr`, piano Free — niente branching), HTML/CSS/JS vanilla, `supabase-js` già presente, i18n custom (`i18n.js` `t()`), deploy Vercel su push a `main`.

**Spec:** [`docs/superpowers/specs/2026-08-29-feed-istantanee-design.md`](../specs/2026-08-29-feed-istantanee-design.md) — leggere prima di iniziare, il piano argomenta dallo spec.

## Global Constraints

- **RLS obbligatorio** su ogni tabella nuova prima del merge (`CLAUDE.md`).
- **Ogni funzione `SECURITY DEFINER` va documentata in `CLAUDE.md`** con motivazione.
- **`escapeHtml()`** su ogni testo libero di altri utenti iniettato via `innerHTML` (`username`, comment `body`, `location_name`).
- **Mai `onclick=` inline** in HTML/JS nuovo — solo `addEventListener` + event delegation.
- **Indentazione: tab.** `camelCase` per JS. Classi CSS kebab-case flat. Banner di sezione `// ========== NOME ==========` (JS) e `/* ========== NOME ========== */` (CSS).
- **Nessuna libreria/dipendenza nuova.** Progetto vanilla, attenzione al bundle.
- **Testo utente-visibile solo via `t()`** con chiave in **entrambi** `locales/it.json` e `locales/en.json`.
- **Emoji reazioni: esattamente 5**, valori interni `heart`, `fire`, `joy`, `wow`, `clap` → ❤️ 🔥 😂 😮 👏.
- **Commento: `body` 1–500 caratteri** (`char_length`).
- **Feed: ultime 20 istantanee**, ordine `ts desc`, nessuna paginazione, nessun realtime.
- **Aggregazione notifiche: finestra = giorno solare UTC** (`(now() at time zone 'utc')::date`).
- **Migration NON auto-applicate da git push** — applicate a mano via Supabase MCP `apply_migration` sul progetto `afkxmbxcavwhurmdelfr` (che è **produzione**). Le modifiche di questo piano sono additive; ogni task migration include lo SQL di rollback.
- **`ts` in `smokes` è epoch in millisecondi** (bigint).
- Tutte le funzioni: `set search_path = public`, `revoke all … from public, anon`, `grant execute … to authenticated`.

---

## File structure

**Creare (migration, in `supabase/migrations/`):**
- `20260829130000_snapshot_reactions_comments.sql` — tabelle `snapshot_reactions` + `snapshot_comments`, RLS, policy, indici.
- `20260829130100_notifications_aggregation.sql` — 4 colonne su `notifications`, backfill `updated_at`, indice unico parziale.
- `20260829130200_snapshot_engagement_cascade.sql` — funzione + trigger di cascade su `smokes`, vista `snapshot_engagement`.
- `20260829130300_snapshot_read_rpcs.sql` — `can_see_snapshot`, `snapshot_reaction_summary`, `get_snapshot_feed`, `get_snapshot_comments`.
- `20260829130400_snapshot_write_rpcs.sql` — `notify_snapshot_engagement`, `set_snapshot_reaction`, `remove_snapshot_reaction`, `add_snapshot_comment`, `delete_snapshot_comment`.

**Modificare:**
- `app/index.html` — `#snapshotsGrid` → `#snapshotFeed`, nota della card.
- `app.js` — sezione `ISTANTANEE` riscritta come `FEED ISTANTANEE` (`loadFeed`, `renderFeed`, reazioni, commenti, `openSnapshotViewer` ripuntato); sezione `NOTIFICHE IN-APP` (`loadNotifications` ordine, `renderNotifications` switch, `subscribeToNotifications` UPDATE, click→scroll); `deletePhotoFromViewer` (conferma + `loadFeed`).
- `style.css` — nuova sezione `/* ========== FEED ISTANTANEE ========== */`.
- `locales/it.json`, `locales/en.json` — chiavi `feed.*`, `notif.snapshotReactions`, `notif.snapshotComments`, `gallery.deleteSnapshotConfirmWithEngagement`.
- `CLAUDE.md` — voci `SECURITY DEFINER`, sezione istantanee/feed, backlog.

**Branch:** `feat/feed-istantanee` (già creato, contiene il commit dello spec). Nessun push finché Matteo non lo chiede.

---

## Verifica — come si testano le cose in questo repo

Non c'è framework di test. Due modi:

1. **SQL via Supabase MCP** (`execute_sql` sul progetto `afkxmbxcavwhurmdelfr`). Per simulare un utente, mettere la claim JWT nella **stessa** chiamata (transaction-local):
   ```sql
   select set_config('request.jwt.claims', '{"sub":"<UUID>"}', true);
   -- …statement che usa auth.uid()…
   ```
   `auth.uid()` = `(current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid`.

2. **Browser pane** su `npx serve .` (dalla root del repo) per il rendering non autenticato (nessun login: la regola password del progetto vieta di inserire credenziali). I flussi autenticati li verifica Matteo con l'account `claude_test` (`e0346ed5-45b6-4c42-bd46-c129a21798b3`) via screenshot.

**Dati per i test SQL** (l'esecutore li recupera all'inizio di ogni task migration):
```sql
-- due utenti amici accettati + una loro istantanea
select f.user_id as viewer, f.friend_id as owner
from friendships f where f.status = 'accepted' limit 1;
select id, user_id, ts from smokes where photo_path is not null order by ts desc limit 5;
-- un utente NON amico di 'owner'
```
Nel piano sono `<VIEWER>` (amico), `<OWNER>` (proprietario istantanea, amico di VIEWER), `<STRANGER>` (non amico di OWNER), `<SNAP_ID>` (una `smokes.id` di OWNER con foto).

---

## Task 1: Migration — tabelle `snapshot_reactions` + `snapshot_comments`

**Files:**
- Create: `supabase/migrations/20260829130000_snapshot_reactions_comments.sql`

**Interfaces:**
- Produces: tabelle `public.snapshot_reactions(id, snapshot_id, user_id, reaction_type, created_at)` con `unique(snapshot_id, user_id)`; `public.snapshot_comments(id, snapshot_id, user_id, body, created_at)`. Entrambe RLS-on, policy "solo le mie righe". FK `snapshot_id → smokes.id ON DELETE CASCADE`, `user_id → auth.users.id ON DELETE CASCADE`.

- [ ] **Step 1: Scrivere il file migration**

```sql
-- Reazioni e commenti sulle istantanee (righe smokes con photo_path).
-- RLS restrittivo: ogni utente vede/scrive solo le proprie righe. La lettura
-- delle reazioni/commenti altrui passa dalle RPC SECURITY DEFINER (get_snapshot_feed,
-- get_snapshot_comments) che filtrano con can_see_snapshot. Vedi
-- docs/superpowers/specs/2026-08-29-feed-istantanee-design.md §4.1/§4.2.

create table public.snapshot_reactions (
  id            bigint generated always as identity primary key,
  snapshot_id   bigint not null references public.smokes(id) on delete cascade,
  user_id       uuid   not null references auth.users(id)    on delete cascade,
  reaction_type text   not null check (reaction_type in ('heart','fire','joy','wow','clap')),
  created_at    timestamptz not null default now(),
  unique (snapshot_id, user_id)
);
create index snapshot_reactions_snapshot_idx on public.snapshot_reactions (snapshot_id);

alter table public.snapshot_reactions enable row level security;
create policy "own reactions" on public.snapshot_reactions
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.snapshot_comments (
  id          bigint generated always as identity primary key,
  snapshot_id bigint not null references public.smokes(id) on delete cascade,
  user_id     uuid   not null references auth.users(id)    on delete cascade,
  body        text   not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index snapshot_comments_snapshot_idx on public.snapshot_comments (snapshot_id, created_at);

alter table public.snapshot_comments enable row level security;
create policy "read own comments"   on public.snapshot_comments for select using (user_id = (select auth.uid()));
create policy "insert own comments"  on public.snapshot_comments for insert with check (user_id = (select auth.uid()));
create policy "delete own comments"  on public.snapshot_comments for delete using (user_id = (select auth.uid()));
```

Rollback (per riferimento, non nel file): `drop table public.snapshot_comments; drop table public.snapshot_reactions;`

- [ ] **Step 2: Verifica pre-applicazione — le tabelle non esistono**

Via MCP `execute_sql`:
```sql
select to_regclass('public.snapshot_reactions'), to_regclass('public.snapshot_comments');
```
Atteso: entrambe `null`.

- [ ] **Step 3: Applicare la migration**

Via MCP `apply_migration`, name `snapshot_reactions_comments`, query = contenuto del file. **Scrive su produzione** (`afkxmbxcavwhurmdelfr`) — additivo.

- [ ] **Step 4: Verifica post-applicazione**

```sql
select relname, relrowsecurity from pg_class where relname in ('snapshot_reactions','snapshot_comments');
select tablename, policyname, cmd from pg_policies where tablename in ('snapshot_reactions','snapshot_comments') order by 1,3;
select conname, confdeltype from pg_constraint
  where conrelid in ('public.snapshot_reactions'::regclass,'public.snapshot_comments'::regclass) and contype='f';
```
Atteso: `relrowsecurity = t` per entrambe; policy `own reactions` (ALL) + 3 policy commenti; `confdeltype = c` (cascade) su tutte le FK.

- [ ] **Step 5: Verifica RLS — insert per un altro utente è rifiutato**

```sql
select set_config('request.jwt.claims', '{"sub":"<VIEWER>"}', true);
insert into public.snapshot_comments (snapshot_id, user_id, body) values (<SNAP_ID>, '<OWNER>', 'x');
```
Atteso: errore RLS (`new row violates row-level security policy`). Poi con `user_id = '<VIEWER>'` (stesso `sub`): inserimento OK. Pulire: `delete from public.snapshot_comments where body = 'x';` (come postgres, senza claim).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260829130000_snapshot_reactions_comments.sql
git commit -m "feat(db): snapshot_reactions + snapshot_comments tables with RLS"
```

---

## Task 2: Migration — colonne di aggregazione su `notifications`

**Files:**
- Create: `supabase/migrations/20260829130100_notifications_aggregation.sql`

**Interfaces:**
- Consumes: tabella `public.notifications` esistente (`id, user_id, type, message, read, created_at`).
- Produces: colonne `snapshot_id bigint` (FK `smokes.id ON DELETE CASCADE`), `event_count int not null default 1`, `bucket_date date`, `updated_at timestamptz not null default now()`. Indice unico parziale `notifications_daily_agg` su `(user_id, type, snapshot_id, bucket_date)` where `type in ('snapshot_reaction','snapshot_comment')`.

- [ ] **Step 1: Scrivere il file migration**

```sql
-- Aggregazione notifiche per le istantanee: una riga per (destinatario, tipo,
-- istantanea, giorno solare UTC) che si incrementa via INSERT … ON CONFLICT.
-- Le righe legacy (snapshot_id/bucket_date NULL) restano invariate e non
-- collidono nell'indice parziale. Vedi spec §4.3.

alter table public.notifications
  add column snapshot_id bigint references public.smokes(id) on delete cascade,
  add column event_count int not null default 1,
  add column bucket_date date,
  add column updated_at  timestamptz not null default now();

update public.notifications set updated_at = created_at;

create unique index notifications_daily_agg
  on public.notifications (user_id, type, snapshot_id, bucket_date)
  where type in ('snapshot_reaction','snapshot_comment');
```

Rollback: `drop index public.notifications_daily_agg; alter table public.notifications drop column snapshot_id, drop column event_count, drop column bucket_date, drop column updated_at;`

- [ ] **Step 2: Verifica pre — colonne assenti**

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='notifications' and column_name in ('snapshot_id','event_count','bucket_date','updated_at');
```
Atteso: 0 righe.

- [ ] **Step 3: Applicare la migration** (MCP `apply_migration`, name `notifications_aggregation`).

- [ ] **Step 4: Verifica post**

```sql
select column_name, data_type, is_nullable, column_default from information_schema.columns
where table_schema='public' and table_name='notifications'
  and column_name in ('snapshot_id','event_count','bucket_date','updated_at') order by 1;
select count(*) filter (where updated_at is distinct from created_at) as mismatch,
       count(*) filter (where updated_at is null) as null_updated
from public.notifications;
select indexdef from pg_indexes where indexname = 'notifications_daily_agg';
```
Atteso: 4 colonne; `event_count` default `1` not null; `updated_at` not null default `now()`; `mismatch = 0`, `null_updated = 0`; indexdef contiene `WHERE (type = ANY (...))`.

- [ ] **Step 5: Verifica ON CONFLICT — l'upsert aggrega**

```sql
-- inserimento diretto (come postgres) per testare l'indice, poi cleanup
insert into public.notifications (user_id, type, snapshot_id, bucket_date, event_count, message)
values ('<OWNER>','snapshot_reaction',<SNAP_ID>, current_date, 1, null)
on conflict (user_id, type, snapshot_id, bucket_date) where type in ('snapshot_reaction','snapshot_comment')
do update set event_count = public.notifications.event_count + 1, read = false, updated_at = now();
-- eseguire due volte, poi:
select event_count from public.notifications where user_id='<OWNER>' and type='snapshot_reaction' and snapshot_id=<SNAP_ID> and bucket_date=current_date;
delete from public.notifications where user_id='<OWNER>' and type='snapshot_reaction' and snapshot_id=<SNAP_ID> and bucket_date=current_date;
```
Atteso: dopo due esecuzioni `event_count = 2` (una riga sola).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260829130100_notifications_aggregation.sql
git commit -m "feat(db): notifications aggregation columns + daily partial index"
```

---

## Task 3: Migration — trigger di cascade + vista engagement

**Files:**
- Create: `supabase/migrations/20260829130200_snapshot_engagement_cascade.sql`

**Interfaces:**
- Consumes: `snapshot_reactions`, `snapshot_comments` (Task 1), `notifications.snapshot_id` (Task 2), `public.smokes`.
- Produces: funzione `public.cascade_snapshot_engagement_delete()` + trigger `trg_smokes_snapshot_cleanup_upd` (AFTER UPDATE OF photo_path) e `trg_smokes_snapshot_cleanup_del` (AFTER DELETE) su `public.smokes`. Vista `public.snapshot_engagement(snapshot_id, owner_id, reaction_count, comment_count)`.

- [ ] **Step 1: Scrivere il file migration**

```sql
-- "Cancellare un'istantanea" = smokes.photo_path passa a NULL (la sessione resta
-- loggata), quindi l'ON DELETE CASCADE delle FK non scatta. Questo trigger fa il
-- cascade di reazioni/commenti/notifiche in quel caso; sul DELETE vero della riga
-- le FK cascade fanno già il lavoro e qui i DELETE sono no-op innocui. Vedi spec §4.4.

create or replace function public.cascade_snapshot_engagement_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and not (old.photo_path is not null and new.photo_path is null) then
    return null;
  end if;
  delete from public.snapshot_reactions where snapshot_id = old.id;
  delete from public.snapshot_comments  where snapshot_id = old.id;
  delete from public.notifications      where snapshot_id = old.id;
  return null;
end $$;

drop trigger if exists trg_smokes_snapshot_cleanup_upd on public.smokes;
create trigger trg_smokes_snapshot_cleanup_upd
  after update of photo_path on public.smokes
  for each row execute function public.cascade_snapshot_engagement_delete();

drop trigger if exists trg_smokes_snapshot_cleanup_del on public.smokes;
create trigger trg_smokes_snapshot_cleanup_del
  after delete on public.smokes
  for each row execute function public.cascade_snapshot_engagement_delete();

-- Contatore engagement, interrogabile via SQL/MCP (punto 7 del prompt). Nessuna UI.
create or replace view public.snapshot_engagement as
select s.id as snapshot_id, s.user_id as owner_id,
       (select count(*) from public.snapshot_reactions r where r.snapshot_id = s.id) as reaction_count,
       (select count(*) from public.snapshot_comments  c where c.snapshot_id = s.id) as comment_count
from public.smokes s
where s.photo_path is not null;
```

Rollback: `drop view public.snapshot_engagement; drop trigger trg_smokes_snapshot_cleanup_upd on public.smokes; drop trigger trg_smokes_snapshot_cleanup_del on public.smokes; drop function public.cascade_snapshot_engagement_delete();`

- [ ] **Step 2: Applicare la migration** (MCP `apply_migration`, name `snapshot_engagement_cascade`).

- [ ] **Step 3: Verifica trigger — photo_path→NULL pulisce i figli**

```sql
-- setup: una reazione + un commento su <SNAP_ID> (come postgres)
insert into public.snapshot_reactions (snapshot_id, user_id, reaction_type) values (<SNAP_ID>,'<VIEWER>','heart');
insert into public.snapshot_comments (snapshot_id, user_id, body) values (<SNAP_ID>,'<VIEWER>','trigger-test');
insert into public.notifications (user_id, type, snapshot_id, bucket_date) values ('<OWNER>','snapshot_reaction',<SNAP_ID>,current_date);
-- salva il path per ripristinarlo
select photo_path from public.smokes where id = <SNAP_ID>;  -- => <SAVED_PATH>
update public.smokes set photo_path = null where id = <SNAP_ID>;
select
  (select count(*) from public.snapshot_reactions where snapshot_id=<SNAP_ID>) as r,
  (select count(*) from public.snapshot_comments  where snapshot_id=<SNAP_ID>) as c,
  (select count(*) from public.notifications where snapshot_id=<SNAP_ID>)      as n;
-- RIPRISTINO obbligatorio:
update public.smokes set photo_path = '<SAVED_PATH>' where id = <SNAP_ID>;
```
Atteso: `r=0, c=0, n=0`. **Ripristinare `photo_path`** dopo il test.

- [ ] **Step 4: Verifica vista**

```sql
insert into public.snapshot_reactions (snapshot_id, user_id, reaction_type) values (<SNAP_ID>,'<VIEWER>','fire');
select * from public.snapshot_engagement where snapshot_id = <SNAP_ID>;
delete from public.snapshot_reactions where snapshot_id=<SNAP_ID> and user_id='<VIEWER>';
```
Atteso: una riga `owner_id = <OWNER>`, `reaction_count = 1`, `comment_count = 0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260829130200_snapshot_engagement_cascade.sql
git commit -m "feat(db): snapshot engagement cascade trigger + snapshot_engagement view"
```

---

## Task 4: Migration — RPC di lettura

**Files:**
- Create: `supabase/migrations/20260829130300_snapshot_read_rpcs.sql`

**Interfaces:**
- Consumes: `snapshot_reactions`, `snapshot_comments`, `public.smokes`, `public.profiles`, `public.friendships`.
- Produces:
  - `public.can_see_snapshot(p_snapshot_id bigint) → boolean`
  - `public.snapshot_reaction_summary(p_snapshot_id bigint) → jsonb` (es. `{"heart":3,"fire":1}` o `{}`)
  - `public.get_snapshot_feed(limit_count int default 20) → table(id bigint, user_id uuid, username text, avatar_url text, ts bigint, date date, "time" text, type text, my_fumo_grams numeric, my_erba_grams numeric, location_name text, photo_path text, reaction_summary jsonb, my_reaction text, comment_count int)`
  - `public.get_snapshot_comments(p_snapshot_id bigint) → table(id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)` — solleva `42501` se `can_see_snapshot` è falso.

- [ ] **Step 1: Scrivere il file migration**

```sql
-- RPC di lettura per il feed istantanee. SECURITY DEFINER perché fanno join
-- cross-utente su smokes/profiles/friendships, che la RLS vieta; ogni funzione
-- filtra con can_see_snapshot (stessa visibilità di get_friends_snapshots).
-- Vedi spec §5.1/§5.2 e CLAUDE.md.

create or replace function public.can_see_snapshot(p_snapshot_id bigint)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.smokes s
    where s.id = p_snapshot_id
      and s.photo_path is not null
      and (
        s.user_id = (select auth.uid())
        or exists (
          select 1 from public.friendships f
          where f.user_id = (select auth.uid()) and f.friend_id = s.user_id and f.status = 'accepted'
        )
      )
  );
$$;

create or replace function public.snapshot_reaction_summary(p_snapshot_id bigint)
returns jsonb language sql security definer set search_path = public stable as $$
  select coalesce(jsonb_object_agg(t.reaction_type, t.cnt), '{}'::jsonb)
  from (
    select reaction_type, count(*)::int as cnt
    from public.snapshot_reactions
    where snapshot_id = p_snapshot_id
    group by reaction_type
  ) t;
$$;

create or replace function public.get_snapshot_feed(limit_count int default 20)
returns table (
  id bigint, user_id uuid, username text, avatar_url text,
  ts bigint, date date, "time" text, type text,
  my_fumo_grams numeric, my_erba_grams numeric, location_name text, photo_path text,
  reaction_summary jsonb, my_reaction text, comment_count int
)
language sql security definer set search_path = public as $$
  select
    s.id, s.user_id, p.username, p.avatar_url,
    s.ts, s.date, s.time, s.type,
    s.my_fumo_grams, s.my_erba_grams, s.location_name, s.photo_path,
    public.snapshot_reaction_summary(s.id) as reaction_summary,
    (select r.reaction_type from public.snapshot_reactions r
       where r.snapshot_id = s.id and r.user_id = (select auth.uid())) as my_reaction,
    (select count(*)::int from public.snapshot_comments c where c.snapshot_id = s.id) as comment_count
  from public.smokes s
  join public.profiles p on p.id = s.user_id
  where s.photo_path is not null
    and (
      s.user_id = (select auth.uid())
      or s.user_id in (
        select f.friend_id from public.friendships f
        where f.user_id = (select auth.uid()) and f.status = 'accepted'
      )
    )
  order by s.ts desc
  limit limit_count;
$$;

create or replace function public.get_snapshot_comments(p_snapshot_id bigint)
returns table (id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_see_snapshot(p_snapshot_id) then
    raise exception 'Not allowed to view this snapshot' using errcode = '42501';
  end if;
  return query
    select c.id, c.user_id, p.username, p.avatar_url, c.body, c.created_at,
           (c.user_id = (select auth.uid())) as is_mine
    from public.snapshot_comments c
    join public.profiles p on p.id = c.user_id
    where c.snapshot_id = p_snapshot_id
    order by c.created_at asc;
end $$;

revoke all on function public.can_see_snapshot(bigint)          from public, anon;
revoke all on function public.snapshot_reaction_summary(bigint)  from public, anon;
revoke all on function public.get_snapshot_feed(int)             from public, anon;
revoke all on function public.get_snapshot_comments(bigint)      from public, anon;
grant execute on function public.can_see_snapshot(bigint)         to authenticated;
grant execute on function public.snapshot_reaction_summary(bigint) to authenticated;
grant execute on function public.get_snapshot_feed(int)           to authenticated;
grant execute on function public.get_snapshot_comments(bigint)    to authenticated;
```

Rollback: `drop function` delle 4 funzioni.

- [ ] **Step 2: Applicare la migration** (MCP `apply_migration`, name `snapshot_read_rpcs`).

- [ ] **Step 3: Verifica — feed come proprietario e come amico**

```sql
-- come OWNER: la propria istantanea è nel feed, con id valorizzato
select set_config('request.jwt.claims', '{"sub":"<OWNER>"}', true);
select id, user_id, username, reaction_summary, my_reaction, comment_count
from public.get_snapshot_feed(20) where id = <SNAP_ID>;
```
Atteso: una riga, `id = <SNAP_ID>`, `reaction_summary = {}`, `my_reaction = null`, `comment_count = 0`.

```sql
-- come VIEWER (amico di OWNER): vede la stessa istantanea
select set_config('request.jwt.claims', '{"sub":"<VIEWER>"}', true);
select count(*) from public.get_snapshot_feed(20) where id = <SNAP_ID>;
```
Atteso: `1`.

- [ ] **Step 4: Verifica — `can_see_snapshot` e commenti per estraneo**

```sql
select set_config('request.jwt.claims', '{"sub":"<STRANGER>"}', true);
select public.can_see_snapshot(<SNAP_ID>);            -- atteso: false
select * from public.get_snapshot_comments(<SNAP_ID>); -- atteso: errore 42501
```

- [ ] **Step 5: Verifica — `reaction_summary` aggrega per tipo**

```sql
insert into public.snapshot_reactions (snapshot_id,user_id,reaction_type) values
  (<SNAP_ID>,'<VIEWER>','heart'), (<SNAP_ID>,'<OWNER>','fire');
select public.snapshot_reaction_summary(<SNAP_ID>);
delete from public.snapshot_reactions where snapshot_id=<SNAP_ID>;
```
Atteso: `{"heart": 1, "fire": 1}`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260829130300_snapshot_read_rpcs.sql
git commit -m "feat(db): snapshot feed read RPCs (can_see_snapshot, get_snapshot_feed, get_snapshot_comments)"
```

---

## Task 5: Migration — RPC di scrittura + notifiche + `CLAUDE.md`

**Files:**
- Create: `supabase/migrations/20260829130400_snapshot_write_rpcs.sql`
- Modify: `CLAUDE.md` (sezione "funzioni che bypassano RLS")

**Interfaces:**
- Consumes: `can_see_snapshot`, `snapshot_reaction_summary` (Task 4); `notifications` colonne (Task 2); `snapshot_reactions`, `snapshot_comments` (Task 1).
- Produces:
  - `public.notify_snapshot_engagement(p_owner uuid, p_type text, p_snapshot_id bigint) → void` (interno)
  - `public.set_snapshot_reaction(p_snapshot_id bigint, p_reaction_type text) → jsonb` (ritorna il summary aggiornato)
  - `public.remove_snapshot_reaction(p_snapshot_id bigint) → jsonb`
  - `public.add_snapshot_comment(p_snapshot_id bigint, p_body text) → table(id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)`
  - `public.delete_snapshot_comment(p_comment_id bigint) → void`

- [ ] **Step 1: Scrivere il file migration**

```sql
-- RPC di scrittura per reazioni/commenti + generazione notifiche aggregate.
-- SECURITY DEFINER: scrivono righe legate a istantanee di altri utenti e
-- inseriscono notifiche sull'account del proprietario (la RLS di notifications
-- non concede INSERT ai client). Ogni funzione filtra con can_see_snapshot e
-- scrive sempre con user_id = auth.uid(). Vedi spec §5.3/§5.4 e CLAUDE.md.

create or replace function public.notify_snapshot_engagement(p_owner uuid, p_type text, p_snapshot_id bigint)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, type, snapshot_id, bucket_date, event_count, message)
  values (p_owner, p_type, p_snapshot_id, (now() at time zone 'utc')::date, 1, null)
  on conflict (user_id, type, snapshot_id, bucket_date) where type in ('snapshot_reaction','snapshot_comment')
  do update set event_count = public.notifications.event_count + 1,
                read = false,
                updated_at = now();
$$;

create or replace function public.set_snapshot_reaction(p_snapshot_id bigint, p_reaction_type text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  if p_reaction_type not in ('heart','fire','joy','wow','clap') then
    raise exception 'Invalid reaction type: %', p_reaction_type;
  end if;
  select user_id into v_owner from public.smokes where id = p_snapshot_id and photo_path is not null;
  if v_owner is null or not public.can_see_snapshot(p_snapshot_id) then
    raise exception 'Not allowed to react to this snapshot' using errcode = '42501';
  end if;
  insert into public.snapshot_reactions (snapshot_id, user_id, reaction_type)
  values (p_snapshot_id, (select auth.uid()), p_reaction_type)
  on conflict (snapshot_id, user_id)
  do update set reaction_type = excluded.reaction_type, created_at = now();
  if v_owner <> (select auth.uid()) then
    perform public.notify_snapshot_engagement(v_owner, 'snapshot_reaction', p_snapshot_id);
  end if;
  return public.snapshot_reaction_summary(p_snapshot_id);
end $$;

create or replace function public.remove_snapshot_reaction(p_snapshot_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from public.snapshot_reactions
  where snapshot_id = p_snapshot_id and user_id = (select auth.uid());
  return public.snapshot_reaction_summary(p_snapshot_id);
end $$;

create or replace function public.add_snapshot_comment(p_snapshot_id bigint, p_body text)
returns table (id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_body text; v_id bigint;
begin
  v_body := trim(p_body);
  if v_body = '' or char_length(v_body) > 500 then
    raise exception 'Invalid comment length';
  end if;
  select s.user_id into v_owner from public.smokes s where s.id = p_snapshot_id and s.photo_path is not null;
  if v_owner is null or not public.can_see_snapshot(p_snapshot_id) then
    raise exception 'Not allowed to comment on this snapshot' using errcode = '42501';
  end if;
  insert into public.snapshot_comments (snapshot_id, user_id, body)
  values (p_snapshot_id, (select auth.uid()), v_body)
  returning snapshot_comments.id into v_id;
  if v_owner <> (select auth.uid()) then
    perform public.notify_snapshot_engagement(v_owner, 'snapshot_comment', p_snapshot_id);
  end if;
  return query
    select c.id, c.user_id, p.username, p.avatar_url, c.body, c.created_at, true
    from public.snapshot_comments c
    join public.profiles p on p.id = c.user_id
    where c.id = v_id;
end $$;

create or replace function public.delete_snapshot_comment(p_comment_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_rows int;
begin
  delete from public.snapshot_comments
  where id = p_comment_id and user_id = (select auth.uid());
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Comment not found or not yours';
  end if;
end $$;

revoke all on function public.notify_snapshot_engagement(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.set_snapshot_reaction(bigint, text)   from public, anon;
revoke all on function public.remove_snapshot_reaction(bigint)      from public, anon;
revoke all on function public.add_snapshot_comment(bigint, text)    from public, anon;
revoke all on function public.delete_snapshot_comment(bigint)       from public, anon;
grant execute on function public.set_snapshot_reaction(bigint, text) to authenticated;
grant execute on function public.remove_snapshot_reaction(bigint)    to authenticated;
grant execute on function public.add_snapshot_comment(bigint, text)  to authenticated;
grant execute on function public.delete_snapshot_comment(bigint)     to authenticated;
```

Nota: `notify_snapshot_engagement` non ha `grant execute` a nessuno — è chiamata solo internamente dalle altre funzioni `SECURITY DEFINER` (che girano come owner), quindi va bene revocarla anche da `authenticated`.

Rollback: `drop function` delle 5 funzioni.

- [ ] **Step 2: Applicare la migration** (MCP `apply_migration`, name `snapshot_write_rpcs`).

- [ ] **Step 3: Verifica — amico reagisce, genera notifica sull'owner**

```sql
select set_config('request.jwt.claims', '{"sub":"<VIEWER>"}', true);
select public.set_snapshot_reaction(<SNAP_ID>, 'heart');   -- atteso: {"heart": 1}
select public.set_snapshot_reaction(<SNAP_ID>, 'fire');    -- atteso: {"fire": 1}  (sostituita, non {"heart":1,"fire":1})
```
Poi come postgres (senza claim):
```sql
select type, event_count, read, snapshot_id, bucket_date
from public.notifications where user_id = '<OWNER>' and snapshot_id = <SNAP_ID> and type = 'snapshot_reaction';
```
Atteso: una riga, `event_count = 2` (due chiamate stesso giorno), `read = false`, `bucket_date = current_date`.

- [ ] **Step 4: Verifica — estraneo rifiutato, commento troppo lungo rifiutato**

```sql
select set_config('request.jwt.claims', '{"sub":"<STRANGER>"}', true);
select public.set_snapshot_reaction(<SNAP_ID>, 'heart');           -- atteso: errore 42501
select set_config('request.jwt.claims', '{"sub":"<VIEWER>"}', true);
select public.add_snapshot_comment(<SNAP_ID>, repeat('x', 501));   -- atteso: "Invalid comment length"
select public.set_snapshot_reaction(<SNAP_ID>, 'thumbsup');        -- atteso: "Invalid reaction type"
```

- [ ] **Step 5: Verifica — commento + cancellazione altrui vietata**

```sql
select set_config('request.jwt.claims', '{"sub":"<VIEWER>"}', true);
select id from public.add_snapshot_comment(<SNAP_ID>, 'ciao');      -- => <CID>, is_mine=true
select set_config('request.jwt.claims', '{"sub":"<STRANGER>"}', true);
select public.delete_snapshot_comment(<CID>);                       -- atteso: "not found or not yours"
select set_config('request.jwt.claims', '{"sub":"<VIEWER>"}', true);
select public.delete_snapshot_comment(<CID>);                       -- atteso: OK
```
Cleanup finale (come postgres): `delete from public.snapshot_reactions where snapshot_id=<SNAP_ID>; delete from public.snapshot_comments where snapshot_id=<SNAP_ID>; delete from public.notifications where snapshot_id=<SNAP_ID>;`

- [ ] **Step 6: Aggiornare `CLAUDE.md`**

Nella sezione "Le funzioni che bypassano RLS (SECURITY DEFINER) vanno documentate qui sotto", aggiungere:

```markdown
  - `can_see_snapshot(p_snapshot_id)` — helper: vero se l'istantanea (riga `smokes` con `photo_path`) è tua o di un amico `accepted`. Usato da tutte le RPC feed per il check di visibilità.
  - `snapshot_reaction_summary(p_snapshot_id)` — aggrega `snapshot_reactions` per tipo (`{"heart":N,…}`); legge reazioni di altri utenti.
  - `get_snapshot_feed(limit_count)` — feed istantanee: join `smokes`+`profiles`+`friendships` di altri utenti + conteggi reazioni/commenti; sostituisce `get_friends_snapshots` per il feed e in più ritorna `smokes.id`.
  - `get_snapshot_comments(p_snapshot_id)` — commenti di un'istantanea + `profiles.username` (join cross-utente); solleva `42501` se `can_see_snapshot` è falso.
  - `set_snapshot_reaction(p_snapshot_id, p_reaction_type)` / `remove_snapshot_reaction(p_snapshot_id)` — upsert/delete della propria reazione su un'istantanea di un amico; `set_` genera la notifica aggregata sull'owner. Scrivono sempre con `user_id = auth.uid()`.
  - `add_snapshot_comment(p_snapshot_id, p_body)` — inserisce un commento (proprio) su un'istantanea di un amico + notifica aggregata sull'owner.
  - `delete_snapshot_comment(p_comment_id)` — cancella un commento solo se `user_id = auth.uid()`.
  - `notify_snapshot_engagement(p_owner, p_type, p_snapshot_id)` — interno (nessun `execute` concesso): `INSERT … ON CONFLICT` sulla riga notifiche del giorno per (owner, tipo, istantanea), incrementa `event_count` e rimette `read=false`. Aggregazione a finestra giorno-solare-UTC.
```

Aggiungere anche una riga nella sezione struttura/note (dove si parla di istantanee):

```markdown
- **Istantanee/feed**: un'istantanea è una riga `smokes` con `photo_path` non null. Reazioni in `snapshot_reactions` (una per utente/istantanea, 5 tipi fissi), commenti in `snapshot_comments` (thread piatto, 1–500 char), entrambe legate a `smokes.id`. "Cancellare un'istantanea" = `photo_path → null`: il trigger `trg_smokes_snapshot_cleanup_upd` su `smokes` fa il cascade di reazioni/commenti/notifiche. Il feed usa `get_snapshot_feed` (non più `get_friends_snapshots`, ancora in vita finché non rimosso). Spec/plan in `docs/superpowers/`.
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260829130400_snapshot_write_rpcs.sql CLAUDE.md
git commit -m "feat(db): snapshot reaction/comment write RPCs + aggregated notifications"
```

---

## Task 6: i18n — chiavi nuove

**Files:**
- Modify: `locales/it.json`, `locales/en.json`

**Interfaces:**
- Produces: chiavi disponibili a `t()`:
  `feed.emptyNoFriendsTitle`, `feed.emptyNoFriendsCta`, `feed.addFriendBtn`, `feed.emptyNoSnapshots`, `feed.loadError`, `feed.react`, `feed.reactionsA11y`, `feed.commentsCount` (param `{count}`), `feed.commentPlaceholder`, `feed.send`, `feed.deleteCommentConfirm`, `feed.you`, `notif.snapshotReactions` (param `{count}`), `notif.snapshotComments` (param `{count}`), `gallery.deleteSnapshotConfirmWithEngagement`.

- [ ] **Step 1: Aggiungere le chiavi a `locales/it.json`**

Nel blocco `"social"` (dopo `"noSnapshotsYet"`), o in un nuovo blocco `"feed"` allo stesso livello — **usare un blocco `"feed"` nuovo** per coerenza col codice. Prima di `"gallery"` o dove conviene alfabeticamente:

```json
  "feed": {
    "emptyNoFriendsTitle": "Il tuo feed è vuoto",
    "emptyNoFriendsCta": "Aggiungi amici per vedere le loro istantanee qui.",
    "addFriendBtn": "Aggiungi un amico",
    "emptyNoSnapshots": "Ancora nessuna istantanea. Quando tu o i tuoi amici allegate una foto a una sessione, compare qui.",
    "loadError": "Errore nel caricamento del feed.",
    "react": "Reagisci",
    "reactionsA11y": "Scegli una reazione",
    "commentsCount": "{count} commenti",
    "commentPlaceholder": "Scrivi un commento…",
    "send": "Invia",
    "deleteCommentConfirm": "Eliminare questo commento?",
    "you": "Tu"
  },
```

Nel blocco `"notif"` — non esiste: le notifiche usano chiavi sotto `"reminder"`. Aggiungere un blocco `"notif"` nuovo allo stesso livello:

```json
  "notif": {
    "snapshotReactions": "{count} reazioni alla tua istantanea",
    "snapshotComments": "{count} commenti alla tua istantanea"
  },
```

Nel blocco `"gallery"`, dopo `"deletePhotoConfirm"`:

```json
    "deleteSnapshotConfirmWithEngagement": "Eliminando questa istantanea perderai anche i commenti e le reazioni collegati. L'operazione non è reversibile. Continuare?",
```

- [ ] **Step 2: Aggiungere le stesse chiavi a `locales/en.json`** (stessa struttura, stesse posizioni):

```json
  "feed": {
    "emptyNoFriendsTitle": "Your feed is empty",
    "emptyNoFriendsCta": "Add friends to see their snapshots here.",
    "addFriendBtn": "Add a friend",
    "emptyNoSnapshots": "No snapshots yet. When you or your friends attach a photo to a session, it shows up here.",
    "loadError": "Couldn't load the feed.",
    "react": "React",
    "reactionsA11y": "Pick a reaction",
    "commentsCount": "{count} comments",
    "commentPlaceholder": "Write a comment…",
    "send": "Send",
    "deleteCommentConfirm": "Delete this comment?",
    "you": "You"
  },
  "notif": {
    "snapshotReactions": "{count} reactions on your snapshot",
    "snapshotComments": "{count} comments on your snapshot"
  },
```
```json
    "deleteSnapshotConfirmWithEngagement": "Deleting this snapshot also removes its comments and reactions. This can't be undone. Continue?",
```

- [ ] **Step 3: Verifica — JSON valido e chiavi presenti in entrambe le lingue**

```bash
node -e "const it=require('./locales/it.json'), en=require('./locales/en.json'); const need=[['feed','emptyNoFriendsTitle'],['feed','commentsCount'],['feed','you'],['notif','snapshotReactions'],['notif','snapshotComments'],['gallery','deleteSnapshotConfirmWithEngagement']]; for(const [a,b] of need){ if(!it[a]||!it[a][b]) throw new Error('IT manca '+a+'.'+b); if(!en[a]||!en[a][b]) throw new Error('EN manca '+a+'.'+b);} console.log('ok');"
```
Atteso: `ok`.

- [ ] **Step 4: Commit**

```bash
git add locales/it.json locales/en.json
git commit -m "i18n: feed / snapshot notification / delete-confirm strings"
```

---

## Task 7: Frontend — layout feed + `loadFeed`/`renderFeed` + empty state

**Files:**
- Modify: `app/index.html:589-593` (card Istantanee)
- Modify: `app.js` — sezione `// ========== ISTANTANEE (foto tue + amici) ==========` (~riga 2146–2221), riga ~1506 (`loadSnapshots()` → `loadFeed()`)
- Modify: `style.css` — nuova sezione `/* ========== FEED ISTANTANEE ========== */`

**Interfaces:**
- Consumes: RPC `get_snapshot_feed` (Task 4); chiavi i18n `feed.*` (Task 6); helper esistenti `escapeHtml`, `formatNotifTime`, `fallbackPlainPhoto`, `transformOpts`, `GALLERY_THUMB_TRANSFORM`, `openSnapshotViewer`, `showPage`.
- Produces: `let feedItems = []` (stato modulo); `async function loadFeed()`; `function renderFeed()`; `function feedCardHtml(item, index)`; contenitore DOM `#snapshotFeed`. `openSnapshotViewer(index)` ora indicizza `feedItems`. Un listener delegato su `#snapshotFeed` che gestisce `data-action` (in questo task solo `open-viewer` e `add-friend-cta`).

- [ ] **Step 1: HTML — sostituire il contenitore**

`app/index.html`, nella card `📸 Istantanee`:
```html
		<h3 data-i18n="social.snapshots">📸 Istantanee</h3>
		<p style="font-size:12px; color:var(--color-text-muted); margin-top:-8px;" data-i18n="social.snapshotsNote">Le foto più recenti tue e degli amici che hai aggiunto.</p>
		<div id="snapshotFeed" class="snapshot-feed"></div>
```
(rimuovere lo `style` grid inline e l'id `snapshotsGrid`).

- [ ] **Step 2: JS — riscrivere la sezione istantanee**

In `app.js`, sostituire il banner e il corpo `ISTANTANEE` con:
```javascript
// ========== FEED ISTANTANEE (foto tue + amici) ==========
let feedItems = [];
let feedHasFriends = null; // null = sconosciuto, bool dopo il primo load

async function loadFeed() {
	const el = document.getElementById('snapshotFeed');
	if (!el) return;
	el.innerHTML = '<div class="spinner"></div>';

	const { data, error } = await supabaseClient.rpc('get_snapshot_feed', { limit_count: 20 });
	if (error) {
		console.error('Errore feed:', error);
		el.innerHTML = `<p class="feed-empty">${t('feed.loadError')}</p>`;
		return;
	}
	feedItems = (data || []).map(it => ({ ...it, comments: null, commentsOpen: false }));

	if (feedItems.length === 0) {
		feedHasFriends = await hasAcceptedFriends();
		el.innerHTML = feedHasFriends
			? `<p class="feed-empty">${t('feed.emptyNoSnapshots')}</p>`
			: feedEmptyNoFriendsHtml();
		bindFeedDelegation(el);
		return;
	}

	const paths = feedItems.map(s => s.photo_path);
	const { data: signed, error: sErr } = await supabaseClient.storage
		.from('session-photos')
		.createSignedUrls(paths, 3600, transformOpts(GALLERY_THUMB_TRANSFORM));
	if (sErr || !signed) {
		el.innerHTML = `<p class="feed-empty">${t('feed.loadError')}</p>`;
		return;
	}
	feedItems.forEach((it, i) => { it.signedUrl = signed[i]?.signedUrl || null; });

	renderFeed();
}

async function hasAcceptedFriends() {
	const { data } = await supabaseClient
		.from('friendships')
		.select('id', { count: 'exact', head: true })
		.eq('user_id', currentUser.id)
		.eq('status', 'accepted');
	// head:true → data è null, il count è in `count`; usare invece una select leggera:
	return false; // placeholder — sostituito allo Step 3
}

function feedEmptyNoFriendsHtml() {
	return `
		<div class="feed-empty feed-empty-cta">
			<p class="feed-empty-title">${t('feed.emptyNoFriendsTitle')}</p>
			<p>${t('feed.emptyNoFriendsCta')}</p>
			<button type="button" class="action-btn" data-action="add-friend-cta">${t('feed.addFriendBtn')}</button>
		</div>`;
}

function renderFeed() {
	const el = document.getElementById('snapshotFeed');
	if (!el) return;
	el.innerHTML = feedItems.map((it, i) => feedCardHtml(it, i)).join('');
	bindFeedDelegation(el);
}

function feedCardHtml(it, index) {
	const mine = it.user_id === currentUser.id;
	const name = mine ? t('feed.you') : escapeHtml(it.username || '?');
	const avatar = it.avatar_url
		? `<img class="feed-avatar" src="${it.avatar_url}" alt="" loading="lazy">`
		: `<span class="feed-avatar feed-avatar-fallback">${(it.username || '?').slice(0,1).toUpperCase()}</span>`;
	const when = formatNotifTime(feedItemDate(it));
	const counts = reactionCountsHtml(it.reaction_summary);
	const img = it.signedUrl
		? `<img class="feed-img" src="${it.signedUrl}" data-path="${it.photo_path}" onerror="fallbackPlainPhoto(this)" loading="lazy" alt="">`
		: `<div class="feed-img feed-img-missing"></div>`;
	return `
		<article class="feed-card" data-index="${index}" data-snapshot-id="${it.id}">
			<header class="feed-head">
				${avatar}
				<span class="feed-name">${name}</span>
				<span class="feed-when">${when}</span>
			</header>
			<div class="feed-img-wrap" data-action="open-viewer" data-index="${index}">${img}</div>
			${counts ? `<div class="feed-counts">${counts}</div>` : ''}
			<div class="feed-actions">
				<button type="button" class="feed-react-btn" data-action="react-tap" data-index="${index}">
					<span class="feed-react-emoji">${it.my_reaction ? REACTION_EMOJI[it.my_reaction] : '🤍'}</span>
					<span class="feed-react-label">${it.my_reaction ? '' : t('feed.react')}</span>
					<span class="feed-react-caret" data-action="react-palette" data-index="${index}" role="button" aria-label="${t('feed.reactionsA11y')}">⌄</span>
				</button>
				<button type="button" class="feed-comment-btn" data-action="toggle-comments" data-index="${index}">
					💬 <span class="feed-comment-count">${it.comment_count}</span>
				</button>
			</div>
			<div class="feed-comments" data-comments-for="${index}" hidden></div>
		</article>`;
}

const REACTION_EMOJI = { heart: '❤️', fire: '🔥', joy: '😂', wow: '😮', clap: '👏' };
const REACTION_ORDER = ['heart', 'fire', 'joy', 'wow', 'clap'];

function reactionCountsHtml(summary) {
	if (!summary || typeof summary !== 'object') return '';
	return REACTION_ORDER
		.filter(k => summary[k] > 0)
		.map(k => `<span class="feed-count">${REACTION_EMOJI[k]} ${summary[k]}</span>`)
		.join('');
}

function feedItemDate(it) {
	// it.date (YYYY-MM-DD) + it.time (HH:MM) → ISO per formatNotifTime
	return `${it.date}T${(it.time || '00:00')}:00`;
}

let feedDelegationBound = false;
function bindFeedDelegation(el) {
	if (feedDelegationBound) return;
	feedDelegationBound = true;
	el.addEventListener('click', onFeedClick);
}

function onFeedClick(e) {
	const target = e.target.closest('[data-action]');
	if (!target) return;
	const action = target.dataset.action;
	const index = Number(target.dataset.index);
	if (action === 'add-friend-cta') {
		const input = document.getElementById('friendUsername');
		if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
		return;
	}
	if (action === 'open-viewer') { openSnapshotViewer(index); return; }
	// 'react-tap', 'react-palette', 'toggle-comments' → Task 8 / Task 9
}
```

- [ ] **Step 3: Sistemare `hasAcceptedFriends()` (niente placeholder)**

Sostituire il corpo con una `select` leggera (il pattern `head:true`+`count` non torna il numero in modo comodo qui):
```javascript
async function hasAcceptedFriends() {
	const { data, error } = await supabaseClient
		.from('friendships')
		.select('id')
		.eq('user_id', currentUser.id)
		.eq('status', 'accepted')
		.limit(1);
	if (error) { console.error('friendships check:', error); return true; } // in dubbio, non mostrare la CTA
	return (data || []).length > 0;
}
```

- [ ] **Step 4: Ripuntare `openSnapshotViewer` su `feedItems`**

Nella funzione `openSnapshotViewer(index)` (~riga 2189), sostituire `const s = snapshotItems[index];` con `const s = feedItems[index];`. Verificare che nessun altro riferimento a `snapshotItems` resti nel file:
```bash
grep -n "snapshotItems\|loadSnapshots\b" app.js
```
Atteso: 0 risultati dopo le modifiche (aggiornare anche la chiamata a riga ~1506: `loadSnapshots()` → `loadFeed()`).

- [ ] **Step 5: CSS — sezione feed (parte layout)**

In `style.css`, nuova sezione:
```css
/* ========== FEED ISTANTANEE ========== */
.snapshot-feed { display: flex; flex-direction: column; gap: 18px; }
.feed-card { border: 1px solid rgba(var(--overlay-rgb), 0.10); border-radius: 14px; overflow: hidden; background: rgba(var(--overlay-rgb), 0.03); }
.feed-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
.feed-avatar { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.feed-avatar-fallback { display: flex; align-items: center; justify-content: center; background: var(--color-primary, #4caf50); color: #fff; font-size: 13px; font-weight: 600; }
.feed-name { font-weight: 600; font-size: 14px; }
.feed-when { margin-left: auto; font-size: 12px; color: var(--color-text-muted); }
.feed-img-wrap { cursor: pointer; background: rgba(var(--overlay-rgb), 0.06); }
.feed-img { display: block; width: 100%; height: auto; max-height: 70vh; object-fit: cover; }
.feed-img-missing { width: 100%; aspect-ratio: 1; }
.feed-counts { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 12px 0; font-size: 13px; }
.feed-actions { display: flex; gap: 8px; padding: 10px 12px 12px; }
.feed-react-btn, .feed-comment-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(var(--overlay-rgb), 0.14); background: transparent; color: var(--color-text); border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
.feed-react-btn.is-active { border-color: var(--color-primary, #4caf50); }
.feed-react-caret { padding: 0 2px; opacity: 0.6; }
.feed-empty { text-align: center; color: var(--color-text-muted); font-size: 13px; padding: 20px 10px; }
.feed-empty-cta { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.feed-empty-title { font-weight: 600; color: var(--color-text); }
```

- [ ] **Step 6: Verifica — render non autenticato + niente errori**

`npx serve .` dalla root, Browser pane su `http://localhost:3000/app`. Non essendo loggati la pagina social non è raggiungibile; verificare invece:
- `read_console_messages` sulla home: nessun `ReferenceError`/`SyntaxError` da `app.js` (le nuove funzioni non rompono il parsing).
- `node -c app.js` per il syntax check.
```bash
node -c app.js && echo "syntax ok"
```
Atteso: `syntax ok`, console pulita.

- [ ] **Step 7: Verifica autenticata (Matteo)**

Chiedere a Matteo di aprire `joint-tracker.vercel.app/app` come `claude_test` (o il suo account) dopo il deploy — **oppure** in locale — e confermare via screenshot: il feed mostra le card (avatar, nome, foto full-width, action bar), e con un account senza amici appare la CTA "Aggiungi un amico". *(Questo step si chiude dopo il merge/deploy; segnare come fatto quando Matteo conferma.)*

- [ ] **Step 8: Commit**

```bash
git add app/index.html app.js style.css
git commit -m "feat(feed): vertical snapshot feed with card layout and empty states"
```

---

## Task 8: Frontend — reazioni (tap, long-press, palette)

**Files:**
- Modify: `app.js` — sezione `FEED ISTANTANEE` (aggiunge gestione reazioni)
- Modify: `style.css` — sezione feed (popover)

**Interfaces:**
- Consumes: RPC `set_snapshot_reaction`, `remove_snapshot_reaction` (Task 5); `feedItems`, `feedCardHtml`, `renderFeed`, `REACTION_EMOJI`, `REACTION_ORDER` (Task 7); `showMessage`, `t`.
- Produces: `async function applyReaction(index, type)`; `async function clearReaction(index)`; `function openReactionPalette(index, anchorEl)`; `function closeReactionPalette()`; pointer-handlers registrati nella delega di `#snapshotFeed`. Aggiorna in place `feedItems[i].reaction_summary` e `feedItems[i].my_reaction`, poi ri-renderizza solo quella card via `refreshFeedCard(index)`.

- [ ] **Step 1: JS — refresh di una singola card**

Aggiungere:
```javascript
function refreshFeedCard(index) {
	const el = document.getElementById('snapshotFeed');
	const card = el && el.querySelector(`.feed-card[data-index="${index}"]`);
	if (!card) return;
	const wasOpen = feedItems[index].commentsOpen;
	card.outerHTML = feedCardHtml(feedItems[index], index);
	if (wasOpen) toggleComments(index, true); // Task 9
}
```

- [ ] **Step 2: JS — applicare / togliere reazione (ottimistico con rollback)**

```javascript
async function applyReaction(index, type) {
	const it = feedItems[index];
	if (!it) return;
	const prevSummary = it.reaction_summary;
	const prevMine = it.my_reaction;
	// ottimistico
	it.reaction_summary = adjustSummary(prevSummary, prevMine, type);
	it.my_reaction = type;
	refreshFeedCard(index);
	const { data, error } = await supabaseClient.rpc('set_snapshot_reaction', {
		p_snapshot_id: it.id, p_reaction_type: type
	});
	if (error) {
		it.reaction_summary = prevSummary; it.my_reaction = prevMine;
		refreshFeedCard(index);
		showMessage(t('feed.loadError'));
		return;
	}
	it.reaction_summary = data || {};
	refreshFeedCard(index);
}

async function clearReaction(index) {
	const it = feedItems[index];
	if (!it || !it.my_reaction) return;
	const prevSummary = it.reaction_summary;
	const prevMine = it.my_reaction;
	it.reaction_summary = adjustSummary(prevSummary, prevMine, null);
	it.my_reaction = null;
	refreshFeedCard(index);
	const { data, error } = await supabaseClient.rpc('remove_snapshot_reaction', { p_snapshot_id: it.id });
	if (error) {
		it.reaction_summary = prevSummary; it.my_reaction = prevMine;
		refreshFeedCard(index);
		showMessage(t('feed.loadError'));
		return;
	}
	it.reaction_summary = data || {};
	refreshFeedCard(index);
}

function adjustSummary(summary, oldType, newType) {
	const s = { ...(summary || {}) };
	if (oldType && s[oldType]) { s[oldType]--; if (s[oldType] <= 0) delete s[oldType]; }
	if (newType) s[newType] = (s[newType] || 0) + 1;
	return s;
}
```

- [ ] **Step 3: JS — palette popover**

```javascript
let openPalette = null; // { index, node }

function openReactionPalette(index, anchorEl) {
	closeReactionPalette();
	const pal = document.createElement('div');
	pal.className = 'feed-palette';
	pal.setAttribute('role', 'menu');
	pal.innerHTML = REACTION_ORDER.map(k =>
		`<button type="button" class="feed-palette-btn" data-react="${k}" aria-label="${k}">${REACTION_EMOJI[k]}</button>`
	).join('');
	document.body.appendChild(pal);
	const r = anchorEl.getBoundingClientRect();
	pal.style.top = `${window.scrollY + r.top - pal.offsetHeight - 8}px`;
	pal.style.left = `${window.scrollX + r.left}px`;
	pal.addEventListener('click', (e) => {
		const b = e.target.closest('[data-react]');
		if (!b) return;
		applyReaction(index, b.dataset.react);
		closeReactionPalette();
	});
	openPalette = { index, node: pal };
	setTimeout(() => {
		document.addEventListener('click', paletteOutside, { once: true });
		document.addEventListener('scroll', closeReactionPalette, { once: true, capture: true });
		document.addEventListener('keydown', paletteEsc);
	}, 0);
}

function paletteOutside(e) {
	if (openPalette && !openPalette.node.contains(e.target)) closeReactionPalette();
}
function paletteEsc(e) { if (e.key === 'Escape') closeReactionPalette(); }
function closeReactionPalette() {
	if (!openPalette) return;
	openPalette.node.remove();
	openPalette = null;
	document.removeEventListener('keydown', paletteEsc);
}
```

- [ ] **Step 4: JS — gesti tap / long-press nella delega**

Estendere `bindFeedDelegation` con pointer handlers e completare `onFeedClick`:
```javascript
let pressTimer = null;
let pressFired = false;
let pressStart = null;

function bindFeedDelegation(el) {
	if (feedDelegationBound) return;
	feedDelegationBound = true;
	el.addEventListener('click', onFeedClick);
	el.addEventListener('pointerdown', onFeedPointerDown);
	el.addEventListener('pointerup', onFeedPointerUp);
	el.addEventListener('pointercancel', cancelPress);
	el.addEventListener('pointermove', onFeedPointerMove);
}

function onFeedPointerDown(e) {
	const btn = e.target.closest('[data-action="react-tap"]');
	if (!btn) return;
	if (e.target.closest('[data-action="react-palette"]')) return; // il caret lo gestisce il click
	pressFired = false;
	pressStart = { x: e.clientX, y: e.clientY };
	const index = Number(btn.dataset.index);
	pressTimer = setTimeout(() => {
		pressFired = true;
		openReactionPalette(index, btn);
	}, 450);
}
function onFeedPointerMove(e) {
	if (!pressStart) return;
	if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
}
function onFeedPointerUp() { clearTimeout(pressTimer); pressTimer = null; pressStart = null; }
function cancelPress() { clearTimeout(pressTimer); pressTimer = null; pressStart = null; }

function onFeedClick(e) {
	const target = e.target.closest('[data-action]');
	if (!target) return;
	const action = target.dataset.action;
	const index = Number(target.dataset.index);
	if (action === 'add-friend-cta') {
		const input = document.getElementById('friendUsername');
		if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
		return;
	}
	if (action === 'open-viewer') { openSnapshotViewer(index); return; }
	if (action === 'react-palette') { openReactionPalette(index, e.target.closest('.feed-react-btn')); return; }
	if (action === 'react-tap') {
		if (pressFired) { pressFired = false; return; } // il long-press ha già aperto la palette
		const it = feedItems[index];
		if (it.my_reaction) clearReaction(index); else applyReaction(index, 'heart');
		return;
	}
	if (action === 'toggle-comments') { toggleComments(index); return; } // Task 9
}
```

- [ ] **Step 5: JS — evidenziare il bottone quando ho reagito**

In `feedCardHtml`, aggiungere `is-active` alla classe del bottone reazione:
```javascript
<button type="button" class="feed-react-btn${it.my_reaction ? ' is-active' : ''}" data-action="react-tap" data-index="${index}">
```

- [ ] **Step 6: CSS — popover**

```css
.feed-palette { position: absolute; z-index: 3000; display: flex; gap: 4px; padding: 6px; border-radius: 999px; background: var(--color-bg, #fff); border: 1px solid rgba(var(--overlay-rgb), 0.18); box-shadow: 0 6px 24px rgba(0,0,0,0.18); }
.feed-palette-btn { border: none; background: transparent; font-size: 22px; line-height: 1; padding: 4px 6px; cursor: pointer; border-radius: 50%; }
.feed-palette-btn:hover, .feed-palette-btn:focus { background: rgba(var(--overlay-rgb), 0.12); }
```

- [ ] **Step 7: Verifica — syntax + comportamento SQL sottostante**

```bash
node -c app.js && echo ok
```
Simulare la sequenza tap/replace via SQL (già coperta in Task 5 Step 3): `set_snapshot_reaction` due volte con tipo diverso → il summary ritornato passa da `{"heart":1}` a `{"fire":1}`. Confermare che `adjustSummary('{"heart":1}', 'heart', 'fire')` in JS dia `{fire:1}`:
```bash
node -e "const f=(s,o,n)=>{s={...s};if(o&&s[o]){s[o]--;if(s[o]<=0)delete s[o]}if(n)s[n]=(s[n]||0)+1;return s}; console.log(JSON.stringify(f({heart:1},'heart','fire')))"
```
Atteso: `{"fire":1}`.

- [ ] **Step 8: Verifica autenticata (Matteo)** — dopo il deploy: tap veloce mette ❤️, ri-tap la toglie; tap-and-hold (o "⌄") apre la palette con 5 emoji; scegliere 🔥 sostituisce ❤️; il conteggio sotto la foto si aggiorna. Screenshot.

- [ ] **Step 9: Commit**

```bash
git add app.js style.css
git commit -m "feat(feed): emoji reactions with quick-tap, long-press palette"
```

---

## Task 9: Frontend — commenti

**Files:**
- Modify: `app.js` — sezione `FEED ISTANTANEE`
- Modify: `style.css` — sezione feed (commenti)

**Interfaces:**
- Consumes: RPC `get_snapshot_comments`, `add_snapshot_comment`, `delete_snapshot_comment` (Tasks 4–5); `feedItems`, `refreshFeedCard`, `escapeHtml`, `formatNotifTime`, `t`, `showMessage`.
- Produces: `async function toggleComments(index, forceOpen)`; `function renderComments(index)`; `async function submitComment(index)`; `async function removeComment(index, commentId)`. Estende `onFeedClick` con `send-comment` / `delete-comment` e un handler `keydown` sul textarea.

- [ ] **Step 1: JS — toggle + render lista**

```javascript
async function toggleComments(index, forceOpen) {
	const it = feedItems[index];
	if (!it) return;
	const box = document.querySelector(`#snapshotFeed .feed-comments[data-comments-for="${index}"]`);
	if (!box) return;
	const open = forceOpen || !it.commentsOpen;
	it.commentsOpen = open;
	box.hidden = !open;
	if (!open) return;
	if (it.comments === null) {
		box.innerHTML = '<div class="spinner"></div>';
		const { data, error } = await supabaseClient.rpc('get_snapshot_comments', { p_snapshot_id: it.id });
		it.comments = error ? [] : (data || []);
	}
	renderComments(index);
}

function renderComments(index) {
	const it = feedItems[index];
	const box = document.querySelector(`#snapshotFeed .feed-comments[data-comments-for="${index}"]`);
	if (!box) return;
	const list = (it.comments || []).map(c => `
		<div class="feed-comment" data-comment-id="${c.id}">
			<span class="feed-comment-name">${c.is_mine ? t('feed.you') : escapeHtml(c.username || '?')}</span>
			<span class="feed-comment-body">${escapeHtml(c.body)}</span>
			<span class="feed-comment-when">${formatNotifTime(c.created_at)}</span>
			${c.is_mine ? `<button type="button" class="feed-comment-del" data-action="delete-comment" data-index="${index}" data-comment-id="${c.id}" aria-label="${t('feed.deleteCommentConfirm')}">🗑</button>` : ''}
		</div>`).join('');
	box.innerHTML = `
		<div class="feed-comment-list">${list}</div>
		<div class="feed-comment-form">
			<textarea class="feed-comment-input" rows="1" maxlength="500" placeholder="${t('feed.commentPlaceholder')}" data-index="${index}"></textarea>
			<button type="button" class="action-btn feed-comment-send" data-action="send-comment" data-index="${index}">${t('feed.send')}</button>
		</div>`;
}
```

- [ ] **Step 2: JS — invio e cancellazione**

```javascript
async function submitComment(index) {
	const it = feedItems[index];
	const box = document.querySelector(`#snapshotFeed .feed-comments[data-comments-for="${index}"]`);
	const input = box && box.querySelector('.feed-comment-input');
	const sendBtn = box && box.querySelector('.feed-comment-send');
	if (!it || !input) return;
	const body = input.value.trim();
	if (!body) return;
	input.disabled = true; if (sendBtn) sendBtn.disabled = true;
	const { data, error } = await supabaseClient.rpc('add_snapshot_comment', {
		p_snapshot_id: it.id, p_body: body
	});
	input.disabled = false; if (sendBtn) sendBtn.disabled = false;
	if (error) { showMessage(t('feed.loadError')); return; }
	const row = Array.isArray(data) ? data[0] : data;
	it.comments = [...(it.comments || []), row];
	it.comment_count = (it.comment_count || 0) + 1;
	input.value = '';
	renderComments(index);
	updateCommentCount(index);
}

async function removeComment(index, commentId) {
	if (!confirm(t('feed.deleteCommentConfirm'))) return;
	const { error } = await supabaseClient.rpc('delete_snapshot_comment', { p_comment_id: commentId });
	if (error) { showMessage(t('feed.loadError')); return; }
	const it = feedItems[index];
	it.comments = (it.comments || []).filter(c => c.id !== commentId);
	it.comment_count = Math.max(0, (it.comment_count || 1) - 1);
	renderComments(index);
	updateCommentCount(index);
}

function updateCommentCount(index) {
	const card = document.querySelector(`#snapshotFeed .feed-card[data-index="${index}"] .feed-comment-count`);
	if (card) card.textContent = feedItems[index].comment_count;
}
```

- [ ] **Step 3: JS — estendere `onFeedClick` + keydown**

Nel corpo di `onFeedClick`, prima della riga finale, aggiungere:
```javascript
	if (action === 'send-comment') { submitComment(index); return; }
	if (action === 'delete-comment') {
		removeComment(index, Number(target.dataset.commentId));
		return;
	}
```
E in `bindFeedDelegation`, aggiungere un handler keydown per l'invio con Enter (desktop):
```javascript
	el.addEventListener('keydown', (e) => {
		const ta = e.target.closest('.feed-comment-input');
		if (!ta) return;
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submitComment(Number(ta.dataset.index));
		}
	});
```

- [ ] **Step 4: JS — `refreshFeedCard` riapre i commenti**

Verificare che `refreshFeedCard` (Task 8 Step 1) chiami `toggleComments(index, true)` quando `wasOpen`; dato che `feedCardHtml` ricrea `.feed-comments` vuoto e `hidden`, `toggleComments(index, true)` lo ripopola da `it.comments` (già in cache, nessuna RPC). OK così.

- [ ] **Step 5: CSS — commenti**

```css
.feed-comments { padding: 0 12px 12px; }
.feed-comment-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.feed-comment { font-size: 13px; line-height: 1.4; }
.feed-comment-name { font-weight: 600; margin-right: 6px; }
.feed-comment-when { color: var(--color-text-muted); font-size: 11px; margin-left: 6px; }
.feed-comment-del { border: none; background: transparent; cursor: pointer; font-size: 12px; margin-left: 6px; opacity: 0.6; }
.feed-comment-form { display: flex; gap: 8px; align-items: flex-end; }
.feed-comment-input { flex: 1; resize: none; border: 1px solid rgba(var(--overlay-rgb), 0.16); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 13px; background: transparent; color: var(--color-text); }
.feed-comment-send { margin-top: 0; width: auto; padding: 8px 14px; }
```

- [ ] **Step 6: Verifica**

```bash
node -c app.js && echo ok
```
SQL (Task 5 Step 5 già copre insert/delete/permessi). Confermare che `get_snapshot_comments` come amico ritorni `is_mine` corretto:
```sql
select set_config('request.jwt.claims', '{"sub":"<VIEWER>"}', true);
select id from public.add_snapshot_comment(<SNAP_ID>, 'da viewer');
select set_config('request.jwt.claims', '{"sub":"<OWNER>"}', true);
select username, is_mine, body from public.get_snapshot_comments(<SNAP_ID>);
```
Atteso: riga con `is_mine = false` per l'owner che guarda il commento del viewer. Cleanup: `delete from public.snapshot_comments where snapshot_id = <SNAP_ID>;`

- [ ] **Step 7: Verifica autenticata (Matteo)** — dopo deploy: aprire i commenti di un'istantanea, scrivere un commento (compare subito, contatore +1), cancellare il proprio (conferma, sparisce, −1), verificare che non compaia 🗑 sui commenti altrui. Screenshot.

- [ ] **Step 8: Commit**

```bash
git add app.js style.css
git commit -m "feat(feed): flat comment threads with inline composer and own-delete"
```

---

## Task 10: Frontend — conferma cancellazione istantanea

**Files:**
- Modify: `app.js` — `deletePhotoFromViewer()` (~riga 2228)

**Interfaces:**
- Consumes: `feedItems`, `currentViewerTs`, `smokes`, chiave `gallery.deleteSnapshotConfirmWithEngagement` (Task 6), `loadFeed` (Task 7).
- Produces: `deletePhotoFromViewer()` usa il testo di conferma esplicito quando l'istantanea ha reazioni/commenti, e chiama `loadFeed()` dopo la cancellazione.

- [ ] **Step 1: JS — modificare `deletePhotoFromViewer`**

Testo attuale (~riga 2228-2244):
```javascript
async function deletePhotoFromViewer() {
	if (!currentViewerTs) return;
	if (!confirm(t('gallery.deletePhotoConfirm'))) return;

	const session = smokes.find(s => s.ts === currentViewerTs);
	if (!session || !session.photo_path) return;
	...
```
Sostituire le prime righe con:
```javascript
async function deletePhotoFromViewer() {
	if (!currentViewerTs) return;

	const session = smokes.find(s => s.ts === currentViewerTs);
	if (!session || !session.photo_path) return;

	// se l'istantanea ha reazioni o commenti nel feed, avviso esplicito del cascade
	const inFeed = feedItems.find(it => it.ts === currentViewerTs);
	const hasEngagement = inFeed && (
		(inFeed.comment_count || 0) > 0 ||
		Object.values(inFeed.reaction_summary || {}).some(n => n > 0)
	);
	const msg = hasEngagement ? t('gallery.deleteSnapshotConfirmWithEngagement') : t('gallery.deletePhotoConfirm');
	if (!confirm(msg)) return;
	...
```
In fondo alla funzione, dopo `await loadGallery();`, aggiungere:
```javascript
	if (typeof loadFeed === 'function') await loadFeed();
```

- [ ] **Step 2: Verifica — syntax + cascade lato DB**

```bash
node -c app.js && echo ok
```
Il cascade è già verificato in Task 3 Step 3 (trigger su `photo_path → null`). Qui basta confermare che la UI chiami la conferma giusta: ispezione del diff + test manuale di Matteo.

- [ ] **Step 3: Verifica autenticata (Matteo)** — cancellare dal viewer un'istantanea **con** commenti/reazioni → compare il testo esplicito sul cascade; una **senza** → testo breve attuale. Dopo conferma, la card sparisce dal feed. Screenshot del dialog.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(feed): explicit cascade warning when deleting a snapshot with engagement"
```

---

## Task 11: Frontend — notifiche aggregate

**Files:**
- Modify: `app.js` — sezione `// ========== NOTIFICHE IN-APP ==========` (~righe 4107-4201)
- Modify: `CLAUDE.md` (backlog — nota Parte 2)

**Interfaces:**
- Consumes: colonne `notifications.type/event_count/snapshot_id/updated_at` (Task 2); RPC nessuna (lettura diretta con RLS esistente); chiavi `notif.snapshotReactions`, `notif.snapshotComments` (Task 6); `feedItems`, `showPage`, `t`, `formatNotifTime`.
- Produces: `loadNotifications()` ordina per `updated_at`; `renderNotifications()` genera il testo per i tipi `snapshot_reaction`/`snapshot_comment` da `event_count`; click su notifica con `snapshot_id` porta al feed; `subscribeToNotifications()` gestisce anche `UPDATE`.

- [ ] **Step 1: JS — `loadNotifications` ordina per `updated_at`**

```javascript
	const { data, error } = await supabaseClient
		.from('notifications')
		.select('*')
		.order('updated_at', { ascending: false })
		.limit(30);
```

- [ ] **Step 2: JS — `renderNotifications` con switch sul tipo**

```javascript
function notifText(n) {
	if (n.type === 'snapshot_reaction') return t('notif.snapshotReactions', { count: n.event_count });
	if (n.type === 'snapshot_comment')  return t('notif.snapshotComments',  { count: n.event_count });
	return n.message || '';
}

function renderNotifications() {
	const list = document.getElementById('notifList');
	if (!list) return;
	if (notifications.length === 0) {
		list.innerHTML = `<p style="padding:15px; text-align:center; color:var(--color-text-muted); font-size:13px;">${t('reminder.noNotifications')}</p>`;
		return;
	}
	list.innerHTML = notifications.map(n => `
		<div class="notif-row${n.snapshot_id ? ' notif-clickable' : ''}" ${n.snapshot_id ? `data-snapshot-id="${n.snapshot_id}"` : ''}
		     style="padding:12px 15px; border-bottom:1px solid rgba(var(--overlay-rgb),0.06); background:${n.read ? 'transparent' : 'rgba(76,175,80,0.08)'};">
			<p style="margin:0; font-size:13px; color:var(--color-text);">${escapeHtml(notifText(n))}</p>
			<small style="color:var(--color-text-muted);">${formatNotifTime(n.updated_at || n.created_at)}</small>
		</div>
	`).join('');
	if (!renderNotifications._bound) {
		renderNotifications._bound = true;
		list.addEventListener('click', (e) => {
			const row = e.target.closest('.notif-clickable');
			if (!row) return;
			goToSnapshot(Number(row.dataset.snapshotId));
		});
	}
}

function goToSnapshot(snapshotId) {
	const panel = document.getElementById('notifPanel');
	if (panel) panel.classList.remove('active');
	showPage('social');
	setTimeout(() => {
		const idx = feedItems.findIndex(it => it.id === snapshotId);
		if (idx >= 0) {
			const card = document.querySelector(`#snapshotFeed .feed-card[data-index="${idx}"]`);
			if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}, 400);
}
```
Nota: `notifText` viene passato a `escapeHtml` perché per i tipi legacy `n.message` è testo del DB; per i nuovi tipi è testo i18n senza HTML — `escapeHtml` è comunque innocuo.

- [ ] **Step 3: JS — `subscribeToNotifications` gestisce UPDATE**

```javascript
function subscribeToNotifications() {
	supabaseClient
		.channel('notifications-channel')
		.on('postgres_changes', {
			event: 'INSERT', schema: 'public', table: 'notifications',
			filter: `user_id=eq.${currentUser.id}`
		}, (payload) => {
			notifications.unshift(payload.new);
			renderNotifications();
			updateNotifBadge();
			showMessage('🔔 ' + notifText(payload.new));
		})
		.on('postgres_changes', {
			event: 'UPDATE', schema: 'public', table: 'notifications',
			filter: `user_id=eq.${currentUser.id}`
		}, (payload) => {
			const i = notifications.findIndex(n => n.id === payload.new.id);
			if (i >= 0) notifications[i] = payload.new;
			else notifications.unshift(payload.new);
			notifications.sort((a, b) =>
				new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
			renderNotifications();
			updateNotifBadge();
		})
		.subscribe();
}
```

- [ ] **Step 4: JS — `showMessage` legacy in `checkBreakNotifications` ecc.**

Verificare che nessun'altra parte del codice legga `n.message` assumendo che sia sempre valorizzato per le notifiche nuove: `grep -n "\.message" app.js` nella zona notifiche. `markAllNotificationsRead` e `updateNotifBadge` usano `n.read`/`n.id` → OK, nessuna modifica.

- [ ] **Step 5: CSS — cursore sulle notifiche cliccabili**

In `style.css`, sezione feed o notifiche:
```css
.notif-clickable { cursor: pointer; }
```

- [ ] **Step 6: `CLAUDE.md` — backlog Parte 2**

Nella sezione "Backlog / cose note da sistemare", aggiungere:
```markdown
- **Feed istantanee — Parte 2 non implementata**: vista profilo di un altro utente + archivio paginato delle sue istantanee oltre le ultime 20 (le righe restano in `smokes`, non vengono mai cancellate). Spec/plan della Parte 1 in `docs/superpowers/`. Da fare: `get_user_snapshots(p_user_id, limit, offset)` visibility-checked, modal profilo, rendere avatar/username del feed cliccabili. Al termine, valutare la rimozione di `get_friends_snapshots` (non più referenziato dopo la Parte 1).
- **Click su notifica istantanea "vecchia"**: `goToSnapshot` scrolla solo se l'istantanea è tra le ultime 20 del feed; per le più vecchie non fa nulla finché non c'è la vista archivio (Parte 2).
```

- [ ] **Step 7: Verifica**

```bash
node -c app.js && echo ok
node -e "const t=(k,p)=>k.replace('snapshotReactions','X'); console.log('smoke')"
```
SQL — simulare l'aggregazione realtime lato dati:
```sql
select set_config('request.jwt.claims', '{\"sub\":\"<VIEWER>\"}', true);
select public.set_snapshot_reaction(<SNAP_ID>, 'heart');
select set_config('request.jwt.claims', '{\"sub\":\"<STRANGER2>\"}', true); -- altro amico dell'owner, se disponibile
select public.set_snapshot_reaction(<SNAP_ID>, 'clap');
-- come postgres:
select type, event_count, read from public.notifications where snapshot_id=<SNAP_ID> and type='snapshot_reaction';
```
Atteso: una riga `snapshot_reaction`, `event_count = 2`, `read = false`. Cleanup come nei task precedenti.

- [ ] **Step 8: Verifica autenticata (Matteo)** — dopo deploy: far reagire/commentare `claude_test` su un'istantanea di Matteo → Matteo riceve **una** notifica "N reazioni…"/"N commenti…", il badge si aggiorna, e cliccandola arriva al feed sulla card giusta. Screenshot.

- [ ] **Step 9: Commit**

```bash
git add app.js style.css CLAUDE.md
git commit -m "feat(notifications): client-rendered aggregated snapshot notifications + realtime UPDATE"
```

---

## Task 12: Verifica end-to-end + aggiornamento spec/plan

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-feed-istantanee-design.md` (stato → Implemented, note eventuali scostamenti)

- [ ] **Step 1: `grep` di controllo — niente residui**

```bash
grep -n "snapshotItems\|loadSnapshots\b\|snapshotsGrid" app.js app/index.html
grep -n "onclick=" app/index.html | grep -i "feed\|snapshot"
```
Atteso: 0 risultati per il primo; nessun `onclick` inline nel markup del feed.

- [ ] **Step 2: Advisor Supabase**

Via MCP `get_advisors` (type `security`) sul progetto: nessun nuovo warning su `snapshot_reactions`, `snapshot_comments`, `snapshot_engagement`, o sulle nuove funzioni (in particolare: RLS abilitato, `search_path` fissato). Se la view `snapshot_engagement` genera un warning "security definer view" accettarlo consapevolmente (è voluto, vedi spec §4.5) o aggiungere `security_invoker = off` esplicito.

- [ ] **Step 3: Full feed load via SQL come i tre ruoli**

Come `<OWNER>`, `<VIEWER>`, `<STRANGER>`: `select count(*) from public.get_snapshot_feed(20);` — nessun errore, `<STRANGER>` non vede le istantanee di `<OWNER>` a meno che non siano amici.

- [ ] **Step 4: Checklist manuale di Matteo (post-deploy)**

Consolidare gli screenshot dei task 7–11. Confermare: feed verticale, reazioni (tap/hold/palette), commenti (crea/cancella), empty state senza amici, conferma cancellazione esplicita, notifica aggregata + badge + click→scroll.

- [ ] **Step 5: Aggiornare lo stato dello spec**

Header spec: `**Status:** Implemented (2026-…)`. Annotare eventuali scostamenti dal design emersi in implementazione.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-29-feed-istantanee-design.md
git commit -m "docs: mark feed istantanee spec as implemented"
```

- [ ] **Step 7: Handoff a Matteo**

Le migration sono già in produzione (applicate task per task via MCP). Restano:
- `git push origin feat/feed-istantanee` + merge in `main` (Matteo) → Vercel auto-deploy.
- Nessun redeploy di Edge Functions (non toccate).
- Il service worker si aggiorna da solo (`CACHE_NAME` deriva dall'hash di `app.js`, che cambia).

---

## Self-review

**Spec coverage:**

| Spec § | Requisito | Task |
|---|---|---|
| §1 / D3 | Decomposizione Parte 1 vs Parte 2 | Struttura del piano; Task 11 Step 6 (backlog Parte 2) |
| §4.1 | `snapshot_reactions` + RLS | Task 1 |
| §4.2 | `snapshot_comments` + RLS | Task 1 |
| §4.3 | Colonne aggregazione `notifications` + indice parziale | Task 2 |
| §4.4 | Trigger di cascade su `smokes` | Task 3 |
| §4.5 | Vista `snapshot_engagement` (punto 7) | Task 3 |
| §5.1 | `can_see_snapshot` | Task 4 |
| §5.2 | `get_snapshot_feed` (con `id`), `get_snapshot_comments` | Task 4 |
| §5.3 | `set/remove_snapshot_reaction`, `add/delete_snapshot_comment` | Task 5 |
| §5.4 | `notify_snapshot_engagement` | Task 5 |
| §6.1 | HTML `#snapshotFeed` | Task 7 |
| §6.2 | `loadFeed`/`renderFeed`, `openSnapshotViewer` ripuntato, reazioni, commenti | Task 7, 8, 9 |
| §6.2 | Conferma cancellazione + `loadFeed()` | Task 10 |
| §6.3 | Notifiche: ordine, switch tipo, realtime UPDATE, click→scroll | Task 11 |
| §6.4 | CSS sezione feed | Task 7, 8, 9 |
| §6.5 | i18n it+en | Task 6 |
| §7 | 4 file migration, applicate a mano | Task 1–5 |
| §8 | Verifica MCP con JWT simulato + browser | Ogni task, Step "Verifica" |
| §9 | `CLAUDE.md`: SECURITY DEFINER, sezione istantanee, backlog | Task 5 Step 6, Task 11 Step 6 |
| §10 | Rollout | Task 12 Step 7 |
| D4 | 5 emoji fisse | Global Constraints; Task 1 CHECK; Task 7 `REACTION_EMOJI` |
| D5 | Una reazione per utente, sostituzione, toggle off | Task 1 unique; Task 5 ON CONFLICT; Task 8 `clearReaction` |
| D6 | Tap / long-press / caret | Task 8 Step 4 |
| D7 | Riga conteggi "❤️ 5 🔥 2" | Task 7 `reactionCountsHtml` |
| D8 | Thread piatto, 1–500, no edit, own-delete | Task 1 CHECK; Task 5; Task 9 |
| D10 | Testo conferma esplicito condizionale | Task 10 Step 1 |
| D11/D12 | Finestra giorno solare, contatore che sale | Task 2, Task 5 `notify_snapshot_engagement` |
| D13 | Testo notifiche client-side | Task 11 Step 2 |
| D14 | Realtime UPDATE + ordine `updated_at` | Task 11 Step 1, 3 |
| D15 | Click notifica → social + scroll se in feed | Task 11 Step 2 (`goToSnapshot`) |
| D16 | Feed 20, no paginazione, no realtime | Task 7 `loadFeed` |
| D17 | 3 empty state | Task 7 Step 2–3 |
| D18 | Vista engagement interrogabile | Task 3 |
| D20 | Avatar con fallback iniziale, non cliccabile | Task 7 `feedCardHtml` |

Nessun requisito dello spec senza task.

**Placeholder scan:** Task 7 Step 2 introduce di proposito un `hasAcceptedFriends()` incompleto **con** commento `// placeholder — sostituito allo Step 3`, e lo Step 3 lo completa con codice reale — non è un placeholder lasciato pendente. Nessun altro TBD/TODO/"gestire gli edge case". Ogni step di codice ha il blocco completo.

**Type consistency:**
- `get_snapshot_feed` ritorna `reaction_summary jsonb`, `my_reaction text`, `comment_count int` → consumati in `feedCardHtml` come `it.reaction_summary` (oggetto), `it.my_reaction` (stringa/null), `it.comment_count` (numero). Coerente.
- `snapshot_reaction_summary` / `set_snapshot_reaction` / `remove_snapshot_reaction` ritornano tutti `jsonb` (stesso shape `{tipo: n}`) → `applyReaction`/`clearReaction` assegnano a `it.reaction_summary`. Coerente.
- `add_snapshot_comment` ritorna `table(...)` → `supabaseClient.rpc` restituisce un array; `submitComment` fa `Array.isArray(data) ? data[0] : data`. Coerente.
- Chiavi i18n con `{count}`: `feed.commentsCount`, `notif.snapshotReactions`, `notif.snapshotComments` — usate con `t(key, { count })`. Coerente con l'uso esistente (`reminder.minutesAgo`).
- `REACTION_EMOJI` keys (`heart|fire|joy|wow|clap`) = CHECK in Task 1 = lista in `set_snapshot_reaction` Task 5. Coerente.
- `formatNotifTime` accetta una stringa ISO; `feedItemDate` costruisce `YYYY-MM-DDTHH:MM:00`, `goToSnapshot`/commenti passano `created_at`/`updated_at` timestamptz. Coerente.

Correzioni applicate in review: nessuna incoerenza di tipo trovata.
