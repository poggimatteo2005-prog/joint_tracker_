# JointTracker — Feed Istantanee (feed + reazioni + commenti + notifiche) — Design

**Date:** 2026-08-29
**Status:** Implemented 2026-08-30 (branch `feat/feed-istantanee`, Parte 1). Piano: `docs/superpowers/plans/2026-08-29-feed-istantanee.md`.
**Author:** Matteo + Claude

## Scostamenti in implementazione

- **D13 (testo notifiche)**: usato l'helper `tn()` (plurale `_one`/`_other`) invece di `t(key, {count})` piatto — evita "1 commenti"/"1 reazioni" in italiano.
- **§4.3**: `notifications.message` reso `NULL`able (le righe aggregate non hanno testo statico) — non previsto nello spec originale, necessario per l'insert di `notify_snapshot_engagement`.
- **§4.5**: la view `snapshot_engagement` è `security_invoker = true` (non security-definer) — nessun consumatore client, e così non aggiunge un ERROR al linter Supabase.
- **§6.2 markup reazioni**: il caret della palette è un `<button>` fratello di `.feed-react-btn` dentro `.feed-react`, non uno span annidato (HTML valido).
- Verifica autenticata end-to-end (UI reazioni/commenti/notifiche realtime) delegata a Matteo post-deploy — l'ambiente SDD non può fare login. Le RPC e la visibilità sono verificate via SQL simulando i ruoli.

## 1. Goal

Trasformare la griglia 3×3 delle istantanee nella pagina Social in un **feed
verticale** stile Instagram, con **reazioni emoji**, **commenti** a thread piatto,
**notifiche in-app aggregate**, **empty state** e **conferma di cancellazione
esplicita** con cascade di reazioni/commenti.

Questa è la **Parte 1** di un lavoro in due tappe. La **Parte 2** (vista profilo
di un altro utente + archivio paginato delle sue istantanee vecchie) ha un suo
spec separato e si costruisce dopo aver spedito la Parte 1.

### Fuori scope (Parte 1 e, dove indicato, del tutto)

- Vista profilo di un altro utente / archivio istantanee oltre le ultime 20 → **Parte 2**.
- Reply-to-reply nei commenti → mai in questa feature.
- Segnalazione commenti → mai in questa feature.
- Emoji picker illimitato → mai (palette fissa a 5).
- Editing dei commenti dopo l'invio → mai.
- Apertura di istantanee di utenti fuori dalla cerchia amici/collegamenti.
- Notifiche **push** (OS-level) per reazioni/commenti → solo in-app.
- Realtime sul feed (conteggi/commenti che si aggiornano dal vivo mentre guardi) →
  esplicitamente escluso; il feed si ricarica all'apertura pagina + si aggiorna
  localmente dopo le proprie azioni. Le notifiche restano realtime come oggi.

## 2. Context / constraints discovered

Ispezionato contro il progetto Supabase live `afkxmbxcavwhurmdelfr` il 2026-08-29
(18 profili, 1561 righe `smokes`, 10 `friendships`, 26 `notifications`).

### Le "istantanee" non sono una tabella

Un'istantanea = una riga `public.smokes` con `photo_path IS NOT NULL`. La foto è
nel bucket Storage `session-photos` sotto `<user_id>/...`. Non esiste alcuna
tabella dedicata.

- **`public.smokes`**: PK `id` (bigint identity, immutabile), `ts` (epoch
  **millisecondi**, bigint — chiave usata lato client per le *proprie* righe),
  `user_id`, `type` (`fumo`/`erba`/misto), `my_fumo_grams`, `my_erba_grams`,
  `date` (date), `time` (text), `location_name` (varchar), `photo_path` (text),
  `shared_with` (jsonb), `not_mine` (bool). **RLS: solo-proprietario** su
  SELECT/INSERT/UPDATE/DELETE. Gli amici non leggono mai `smokes` direttamente.
- **`get_friends_snapshots(limit_count int default 24)`** — RPC `SECURITY
  DEFINER`, oggi unico modo per leggere le istantanee degli amici. Ritorna
  `user_id, username, ts, date, time, type, my_fumo_grams, my_erba_grams,
  location_name, photo_path`. **Non ritorna `smokes.id`** → oggi non esiste una
  chiave stabile a cui agganciare reazioni/commenti.
- **`public.friendships`**: `user_id`, `friend_id`, `status`
  (`pending`|`accepted`), unique `(user_id, friend_id)`. **Direzionale**:
  un'amicizia accettata = due righe (una per parte). RLS: gestisci le righe con
  `user_id = auth.uid()`; policy extra di SELECT sulle richieste ricevute
  (`friend_id = auth.uid()`).
- **`public.profiles`**: `id`, `username` (unique, CHECK anti-XSS
  `username !~ '[<>"''`&]'`), `avatar_url` (spesso NULL), `language`
  (`it`|`en`). **RLS: solo-proprietario.** La view `profiles_public`
  (`security_invoker = false`) espone `id, username, avatar_url` di tutti per
  ricerca amici/classifiche. **Nota**: già trovata in prod flippata a
  `security_invoker = on` per errore — verificare la definizione live prima di
  fidarsi delle migration.
- **`public.notifications`**: `id`, `user_id` (destinatario), `type` (default
  `'shared_session'`), `message` (testo pre-renderizzato, **oggi solo italiano**),
  `read` (bool default false), `created_at` (timestamptz default now()). RLS:
  destinatario può SELECT + UPDATE le proprie; **nessuna policy INSERT** — gli
  insert cross-utente passano da RPC `SECURITY DEFINER` (`send_friend_request`,
  `respond_friend_request`), i self-insert da `insert_own_notification(type,
  message)`.
  - Client: `loadNotifications()` (`.from('notifications').select('*').order('created_at',
    desc).limit(30)`), `renderNotifications()`, `updateNotifBadge()`,
    `subscribeToNotifications()` (canale `notifications-channel`, **solo evento
    INSERT**, filtro `user_id=eq.<id>`), `markAllNotificationsRead()` (update
    `read=true` sugli id non letti quando apri il pannello).
- **Nessuna tabella reazioni/commenti. Nessuna aggregazione di notifiche.**
- **Nessuna vista profilo di un altro utente** nell'app. Pagina Social
  (`app/index.html` da `#page-social`): richieste amicizia, gestione amici,
  classifiche (`leaderboardList`), card "📸 Istantanee" con
  `#snapshotsGrid` (grid 3 colonne). Il rendering istantanee attuale
  (`app.js` `loadSnapshots()` / `openSnapshotViewer()` ~riga 2146–2221) usa
  `onclick=` inline — in **violazione** di `CLAUDE.md` ("mai `onclick=` inline");
  la riscrittura lo corregge con event delegation.
- **Photo viewer modal** (`#photoViewerModal`, `openSnapshotViewer`,
  `deletePhotoFromViewer`): la cancellazione di una propria istantanea **non
  elimina la riga** — fa `storage.remove([path])` + `update smokes set photo_path
  = null` (la sessione resta loggata). `currentViewerTs` traccia la riga.
- **Guest mode**: la pagina Social è già bloccata per i guest (`#socialLocked`
  visibile, `#socialContent` no) → nessun caso reazioni/commenti da guest.
- **i18n**: stringhe in `locales/it.json` / `locales/en.json` via `i18n.js`
  `t(key, params)`. Mai hardcodare testo utente-visibile.
- **Sicurezza (`CLAUDE.md`)**: ogni tabella nuova con RLS **prima** del merge;
  ogni funzione `SECURITY DEFINER` documentata in `CLAUDE.md` con motivazione;
  `escapeHtml()` su ogni testo libero di altri utenti iniettato via `innerHTML`.
- **Deploy**: push su `main` → Vercel auto-deploya il frontend. **Le migration
  Supabase NON si applicano da un push** — a mano nell'SQL editor o via MCP.
  Claude Code non ha deploy access a DB/Edge Functions da questo repo.
- **Convenzioni**: tab (non spazi), `camelCase`, verbo+nome per le funzioni,
  classi CSS kebab-case flat, `addEventListener` mai `onclick=`, banner di
  sezione `// ========== NOME ==========` / `/* ========== NOME ========== */`,
  `async`/`await`, nessuna libreria nuova (progetto vanilla, occhio al bundle).
- **Nessun framework di test nel repo.**

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Accesso ai dati cross-utente | **Opzione A**: tutto via RPC `SECURITY DEFINER`. Le tabelle nuove hanno RLS restrittivo "solo le mie righe"; ogni lettura/scrittura su dati di amici passa da una RPC che filtra con `can_see_snapshot`. Coerente con l'intera feature social esistente. |
| D2 | Chiave dell'istantanea | `snapshot_id` = `smokes.id`. FK `ON DELETE CASCADE`. `get_snapshot_feed` estesa per **ritornare `id`** (oggi mancante). |
| D3 | Decomposizione | Feed + reazioni + commenti + notifiche + conferma cancellazione + empty state = **Parte 1** (questo spec). Vista profilo amico + archivio = Parte 2, spec separato, dopo. |
| D4 | Emoji reazioni | Palette **fissa a 5**: `heart` ❤️, `fire` 🔥, `joy` 😂, `wow` 😮, `clap` 👏. `CHECK` sul valore. Nessun picker. |
| D5 | Una reazione per utente/istantanea | `UNIQUE (snapshot_id, user_id)` + `INSERT … ON CONFLICT DO UPDATE reaction_type`. Selezionarne un'altra sostituisce. Tap sull'emoji già attiva = toggle off (`remove_snapshot_reaction`). |
| D6 | Gesto palette | Tap veloce = `heart` di default (o toggle off se ho già una reazione). Tap-and-hold ~450 ms (Pointer Events) = apre la palette. In più una "⌄" nel bottone apre la palette al tap (scopribilità + affidabilità mobile). |
| D7 | Conteggi reazioni | Riga sotto l'immagine, formato "❤️ 5  🔥 2", solo i tipi con `count > 0`. Da `reaction_summary jsonb` ritornato dalla RPC. |
| D8 | Commenti | Thread **piatto**. `body` 1–500 char. Nessun editing. Nessuna segnalazione. Ognuno cancella solo i propri (`delete_snapshot_comment` con `WHERE user_id = auth.uid()`). |
| D9 | Cancellazione istantanea | Client invariato (`storage.remove` + `photo_path = null`). Il **cascade** (reazioni + commenti + notifiche di quell'istantanea) lo fa un **trigger** su `smokes` (`AFTER UPDATE OF photo_path` quando va a NULL, **e** `AFTER DELETE`). FK `ON DELETE CASCADE` come rete di sicurezza per il delete vero della riga. |
| D10 | Conferma cancellazione | Se l'istantanea ha ≥1 reazione o ≥1 commento → `confirm()` con testo esplicito (chiave `gallery.deleteSnapshotConfirmWithEngagement`): «Eliminando questa istantanea perderai anche i commenti e le reazioni collegati. L'operazione non è reversibile.» Altrimenti resta il testo attuale. |
| D11 | Aggregazione notifiche | **Finestra = giorno solare (UTC)**. Colonna `bucket_date date`. Indice unico parziale `(user_id, type, snapshot_id, bucket_date)` per `type IN ('snapshot_reaction','snapshot_comment')`. Ogni evento: `INSERT … ON CONFLICT DO UPDATE event_count = event_count + 1, read = false, updated_at = now()`. Reazioni e commenti = due `type`/righe distinti. |
| D12 | Compromesso aggregazione | Se altri eventi arrivano **dopo** che hai letto la notifica, nello stesso giorno il contatore continua a salire (non riparte). Accettato esplicitamente. Il testo IT usa «N reazioni alla tua istantanea» (non «N *nuove*») per non mentire. |
| D13 | Testo notifiche nuove | Generato **lato client** in `renderNotifications()` da `type` + `event_count` (chiavi `notif.snapshotReactions` / `notif.snapshotComments`). I `type` legacy continuano a usare `n.message`. Risolve di sponda l'i18n (le notifiche legacy restano solo-IT, invariato). |
| D14 | Realtime notifiche | `subscribeToNotifications()` aggiunge il caso **UPDATE** (stesso canale/filtro): sostituisce la riga in `notifications[]`, riordina per `updated_at desc`, ri-renderizza, aggiorna badge. `loadNotifications()` ordina per `updated_at` invece di `created_at`. |
| D15 | Click su notifica istantanea | Apre la pagina Social e fa `scrollIntoView` sulla card se presente nel feed (match `snapshot_id`). Se l'istantanea è fuori dalle ultime 20, nessuna azione puntuale (l'apertura mirata di istantanee vecchie arriva con la Parte 2). |
| D16 | Feed | Ultime **20**, ordine `ts desc`, nessuna paginazione / infinite scroll. Nessuna subscription realtime. |
| D17 | Empty state | (a) zero amici accettati → card CTA «Aggiungi amici…» + bottone che fa `scrollIntoView` + focus sull'input aggiungi-amico esistente. (b) amici ma zero istantanee → messaggio. (c) errore RPC → messaggio d'errore. Mai sezione vuota. |
| D18 | Engagement counter (punto 7) | Vista `snapshot_engagement (snapshot_id, owner_id, reaction_count, comment_count)` interrogabile via SQL/MCP. Nessuna dashboard, nessuna UI. |
| D19 | Migration `get_friends_snapshots` | Resta in vita finché referenziata; una volta che il client usa solo `get_snapshot_feed`, si può rimuovere in una migration successiva (non in questa feature). |
| D20 | Avatar nel feed | Se `avatar_url` presente → `<img>`; altrimenti cerchietto con l'iniziale dello username. In Parte 1 avatar/username **non** cliccabili. |

## 4. Data model

### 4.1 `snapshot_reactions`

```
id            bigint  generated always as identity primary key
snapshot_id   bigint  not null references public.smokes(id) on delete cascade
user_id       uuid    not null references auth.users(id)   on delete cascade
reaction_type text    not null check (reaction_type in ('heart','fire','joy','wow','clap'))
created_at    timestamptz not null default now()
unique (snapshot_id, user_id)
```
Indice: `(snapshot_id)`.
RLS: `enable`. Policy unica `for all using (user_id = auth.uid()) with check (user_id = auth.uid())`.

### 4.2 `snapshot_comments`

```
id           bigint generated always as identity primary key
snapshot_id  bigint not null references public.smokes(id) on delete cascade
user_id      uuid   not null references auth.users(id)   on delete cascade
body         text   not null check (char_length(body) between 1 and 500)
created_at   timestamptz not null default now()
```
Indice: `(snapshot_id, created_at)`.
RLS: `enable`. Policy `for select using (user_id = auth.uid())`, `for insert with check (user_id = auth.uid())`, `for delete using (user_id = auth.uid())`. **No UPDATE.**

### 4.3 Alter `notifications`

```
alter table public.notifications
  add column snapshot_id bigint references public.smokes(id) on delete cascade,
  add column event_count int not null default 1,
  add column bucket_date date,
  add column updated_at  timestamptz not null default now();

update public.notifications set updated_at = created_at where updated_at is null;

create unique index notifications_daily_agg
  on public.notifications (user_id, type, snapshot_id, bucket_date)
  where type in ('snapshot_reaction','snapshot_comment');
```

### 4.4 Trigger di cascade su `smokes`

```
create function public.cascade_snapshot_engagement_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- UPDATE: solo quando la foto viene rimossa; DELETE: sempre
  if tg_op = 'UPDATE' and (old.photo_path is null or new.photo_path is not null) then
    return null;
  end if;
  delete from public.snapshot_reactions where snapshot_id = old.id;
  delete from public.snapshot_comments  where snapshot_id = old.id;
  delete from public.notifications      where snapshot_id = old.id;
  return null;
end $$;

create trigger trg_smokes_snapshot_cleanup_upd
  after update of photo_path on public.smokes
  for each row execute function public.cascade_snapshot_engagement_delete();

create trigger trg_smokes_snapshot_cleanup_del
  after delete on public.smokes
  for each row execute function public.cascade_snapshot_engagement_delete();
```

### 4.5 Vista engagement

```
create view public.snapshot_engagement as
select s.id as snapshot_id, s.user_id as owner_id,
       (select count(*) from public.snapshot_reactions r where r.snapshot_id = s.id) as reaction_count,
       (select count(*) from public.snapshot_comments  c where c.snapshot_id = s.id) as comment_count
from public.smokes s
where s.photo_path is not null;
```
Solo per interrogazione owner/MCP. (Se in futuro serve lato client, va rivista la
semantica RLS della view.)

## 5. RPC layer (`SECURITY DEFINER`, `set search_path = public`)

Tutte: `revoke all on function … from public; grant execute … to authenticated;`
e voce in `CLAUDE.md`.

### 5.1 Helper

**`can_see_snapshot(p_snapshot_id bigint) returns boolean`**
`true` se esiste `smokes` con quell'`id`, `photo_path is not null`, e
(`user_id = auth.uid()` **o** esiste `friendships` `user_id = auth.uid() and
friend_id = <owner> and status = 'accepted'`).

### 5.2 Lettura

**`get_snapshot_feed(limit_count int default 20) returns table(...)`**
Per ogni istantanea visibile (mia o di un amico accettato, `photo_path not null`),
ordine `ts desc`, limite `limit_count`:
`id bigint, user_id uuid, username text, avatar_url text, ts bigint, date date,
"time" text, type text, my_fumo_grams numeric, my_erba_grams numeric,
location_name text, photo_path text, reaction_summary jsonb, my_reaction text,
comment_count int`.
`reaction_summary` = `jsonb_object_agg(reaction_type, cnt)` per quell'istantanea
(o `'{}'`). `my_reaction` = il mio `reaction_type` o `null`.

**`get_snapshot_comments(p_snapshot_id bigint) returns table(id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)`**
`can_see_snapshot` falso → `raise exception`. Altrimenti ordine `created_at asc`.

### 5.3 Scrittura

**`set_snapshot_reaction(p_snapshot_id bigint, p_reaction_type text) returns jsonb`**
- `p_reaction_type` non in lista → exception. `can_see_snapshot` falso → exception.
- `insert into snapshot_reactions … on conflict (snapshot_id, user_id) do update set reaction_type = excluded.reaction_type, created_at = now()`.
- se `owner <> auth.uid()` → `perform notify_snapshot_engagement(owner, 'snapshot_reaction', p_snapshot_id)`.
- ritorna il `reaction_summary` aggiornato.

**`remove_snapshot_reaction(p_snapshot_id bigint) returns jsonb`**
`delete from snapshot_reactions where snapshot_id = p_snapshot_id and user_id =
auth.uid()`. Ritorna il `reaction_summary` aggiornato. Non tocca le notifiche.

**`add_snapshot_comment(p_snapshot_id bigint, p_body text) returns table(id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)`**
- `can_see_snapshot` falso → exception. `trim(p_body)` vuoto o > 500 → exception.
- insert; se `owner <> auth.uid()` → `notify_snapshot_engagement(owner, 'snapshot_comment', p_snapshot_id)`.
- ritorna la riga creata (con `username`/`avatar_url`, `is_mine = true`).

**`delete_snapshot_comment(p_comment_id bigint) returns void`**
`delete … where id = p_comment_id and user_id = auth.uid()`; `not found` → exception.

### 5.4 Helper notifiche

**`notify_snapshot_engagement(p_owner uuid, p_type text, p_snapshot_id bigint) returns void`** (interno, chiamato solo dalle RPC sopra)
```
insert into public.notifications (user_id, type, snapshot_id, bucket_date, event_count, message)
values (p_owner, p_type, p_snapshot_id, (now() at time zone 'utc')::date, 1, null)
on conflict (user_id, type, snapshot_id, bucket_date) where type in ('snapshot_reaction','snapshot_comment')
do update set event_count = public.notifications.event_count + 1,
             read = false,
             updated_at = now();
```

## 6. Frontend

### 6.1 HTML (`app/index.html`)

Nella card "📸 Istantanee": `#snapshotsGrid` (grid) → `#snapshotFeed`
(contenitore verticale). Aggiornare `data-i18n` della nota se cambia il testo.
Nessun nuovo modal (il feed espande i commenti inline; il photo viewer esistente
resta).

### 6.2 `app.js` — sezione `// ========== FEED ISTANTANEE ==========`

Sostituisce l'attuale sezione `ISTANTANEE`. Stato modulo: `let feedItems = [];`

- **`loadFeed()`** (era `loadSnapshots`): `rpc('get_snapshot_feed', {limit_count: 20})`
  → `feedItems` → batch `createSignedUrls(paths, 3600, transformOpts(GALLERY_THUMB_TRANSFORM))`
  → render. Empty state secondo D17 (per sapere se ho amici: campo nel payload
  o count separata `get_friends_leaderboard`). Chiamata dove oggi c'è
  `loadSnapshots()` (`app.js` ~1506).
- **`openSnapshotViewer(index)`**: oggi legge `snapshotItems[index]`. Va
  ripuntata su `feedItems` (rinominare la variabile o adeguare il riferimento);
  il modal `#photoViewerModal` e la logica interna restano invariati.
- **`renderFeed()`**: template string per card (§ anatomia sotto). Un solo
  `addEventListener('click' / 'pointerdown' …)` sul contenitore, dispatch su
  `data-action` + `data-snapshot-id` / `data-comment-id`. `escapeHtml` su
  `username`, `location_name`.
- **Card**: header (avatar D20 + username/"Tu" + timestamp relativo con la logica
  di `formatNotifTime`) · immagine full-width (`loading="lazy"`,
  `onerror=fallbackPlainPhoto`, tap → `openSnapshotViewer`) ·
  riga conteggi (`reaction_summary`, D7) · action bar (bottone reazione con la mia
  reazione o 🤍 + "⌄"; bottone "💬 N").
- **Reazioni** (D5/D6):
  - `pointerdown` sul bottone → timer 450 ms → `openReactionPalette(snapshotId, anchorEl)`.
    `pointerup`/`pointercancel`/`pointermove` oltre ~10 px prima del timer →
    annulla timer → tap: se `my_reaction` → `remove_snapshot_reaction`; else
    `set_snapshot_reaction(id,'heart')`.
  - "⌄" → `openReactionPalette` direttamente.
  - `openReactionPalette`: popover assoluto, 5 bottoni, `role="menu"`. Scelta →
    `set_snapshot_reaction(id, type)`. Chiude su tap-fuori / `Escape` / scroll.
    Un solo popover per volta.
  - Ogni RPC ritorna `reaction_summary`; aggiorno `feedItems[i]` +
    `my_reaction`, ri-renderizzo solo quella card. Ottimistico con rollback su errore.
- **Commenti** (D8):
  - `toggle-comments`: prima apertura → `get_snapshot_comments(id)` →
    `feedItems[i].comments`; render lista sotto la card; ri-tap chiude.
  - Lista: avatar + username/"Tu" + `escapeHtml(body)` + timestamp; se `is_mine`,
    🗑 → `confirm` leggero → `delete_snapshot_comment` → rimozione locale, `comment_count--`.
  - Composer: `<textarea>` auto-grow 1 riga, contatore verso i 500, bottone invia
    (disabilitato mentre in volo). `Enter` invia / `Shift+Enter` a capo su
    desktop. Invio → `add_snapshot_comment(id, body)` → append riga ritornata,
    `comment_count++`, svuota.
- **`deletePhotoFromViewer()`**: se la sessione ha reazioni/commenti (lo so dal
  `feedItems` corrispondente, o da una count al volo) → `confirm(t('gallery.deleteSnapshotConfirmWithEngagement'))`;
  altrimenti testo attuale. Dopo la cancellazione: oltre a `loadData()`/`loadGallery()`,
  anche `loadFeed()`.

### 6.3 `app.js` — sezione notifiche

- **`loadNotifications()`**: `.order('updated_at', {ascending:false})`.
- **`renderNotifications()`**: switch su `n.type`:
  - `'snapshot_reaction'` → `t('notif.snapshotReactions', {count: n.event_count})`
  - `'snapshot_comment'` → `t('notif.snapshotComments', {count: n.event_count})`
  - altro → `n.message` (invariato)
  - click su riga con `snapshot_id` → vai a pagina Social + `scrollIntoView` card se presente (D15).
- **`subscribeToNotifications()`**: aggiungere handler `event: 'UPDATE'` sullo
  stesso canale/filtro → sostituisci in `notifications[]` per `id`, riordina per
  `updated_at`, `renderNotifications()` + `updateNotifBadge()`. INSERT invariato.

### 6.4 CSS (`style.css`) — sezione `/* ========== FEED ISTANTANEE ========== */`

Card feed, riga conteggi, action bar, popover reazioni, sezione commenti inline,
empty state. Classi kebab-case flat. Rispetta `data-theme="dark"` con le variabili
CSS esistenti. Nessuna libreria.

### 6.5 i18n

Nuove chiavi in **`locales/it.json` e `locales/en.json`**:
`feed.*` (empty state amici / empty state istantanee / errore, label "Reagisci",
"commenti", "commento", placeholder composer, "Invia", "Aggiungi un amico"),
`notif.snapshotReactions`, `notif.snapshotComments`,
`gallery.deleteSnapshotConfirmWithEngagement`.

## 7. Migrations

Un file per argomento in `supabase/migrations/` (prefisso data `20260829…`):

1. `…_snapshot_reactions_comments.sql` — tabelle 4.1 + 4.2, RLS, policy, indici.
2. `…_notifications_aggregation.sql` — alter 4.3 (colonne, backfill, indice parziale).
3. `…_snapshot_engagement_cascade.sql` — trigger 4.4 + funzione, vista 4.5.
4. `…_snapshot_feed_rpcs.sql` — helper 5.1/5.4 + RPC 5.2/5.3, grant/revoke.

**Nessuna si applica con `git push`.** Ogni file va lanciato a mano nell'SQL
editor Supabase o via MCP `apply_migration`. Il piano di implementazione avrà un
check "applicata in produzione" per ciascuna.

## 8. Verifica (nessun framework di test nel repo)

- **DB/RPC via Supabase MCP**, simulando utenti con
  `select set_config('request.jwt.claims', '{"sub":"<uuid>"}', true);` prima di
  ogni chiamata:
  - amico: `get_snapshot_feed` include l'istantanea; `set_snapshot_reaction` /
    `add_snapshot_comment` OK; genera/aggrega la notifica sull'owner.
  - non-amico: ogni RPC su quell'istantanea → exception.
  - doppia reazione dello stesso utente → una riga, `reaction_type` sostituito.
  - due reazioni/commenti stesso giorno stesso owner → **una** notifica
    `event_count = 2`; giorno diverso → riga nuova.
  - `update smokes set photo_path = null` → trigger cancella
    reazioni/commenti/notifiche di quell'`id`; `delete` riga → idem + FK cascade.
  - `char_length(body) > 500` → exception.
  - `can_see_snapshot` con istantanea senza foto → falso.
- **UI non autenticata**: `npx serve .` + Browser pane — rendering feed, empty
  state, popover, console/network puliti, dark mode.
- **UI autenticata**: non posso loggarmi (regola password del progetto). Verifica
  con account `claude_test` chiesta a Matteo via screenshot, oppure query MCP che
  replicano la logica client.

## 9. `CLAUDE.md` — aggiornamenti

- Nuova sezione istantanee/feed: le istantanee restano righe `smokes`; reazioni e
  commenti in `snapshot_reactions` / `snapshot_comments` legate a `smokes.id`;
  cancellazione istantanea = `photo_path → null` + trigger di cascade.
- Elenco funzioni `SECURITY DEFINER`: aggiungere `can_see_snapshot`,
  `get_snapshot_feed`, `get_snapshot_comments`, `set_snapshot_reaction`,
  `remove_snapshot_reaction`, `add_snapshot_comment`, `delete_snapshot_comment`,
  `notify_snapshot_engagement` con motivazione (join cross-utente su
  `smokes`/`profiles`/`friendships` altrimenti vietati da RLS; filtro
  `can_see_snapshot`).
- Backlog: Parte 2 (profilo amico + archivio); eventuale rimozione di
  `get_friends_snapshots` quando non più referenziata (D19); notifiche push per
  reazioni/commenti (rimandate).

## 10. Rollout

1. Applicare le 4 migration in prod (SQL editor / MCP), in ordine.
2. Merge frontend su `main` → Vercel auto-deploy.
3. Smoke test con `claude_test` (Matteo) + verifica MCP.
4. Service worker: la modifica tocca `app.js`/`style.css`/`app/index.html` →
   `CACHE_NAME` si bumpa da solo (derivato dall'hash di `app.js`). Nessun
   intervento manuale sul SW.
