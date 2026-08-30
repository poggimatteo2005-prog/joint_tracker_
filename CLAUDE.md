# JointTracker — Contesto per Claude Code

## Cos'è
PWA per il tracking di sessioni cannabis con funzionalità social (sessioni condivise, classifiche amici, tolerance break). Frontend vanilla HTML/CSS/JS (no framework), backend Supabase, deploy su Vercel.

## Stack
- **Frontend**: HTML/CSS/JS vanilla, nessun bundler/framework
- **Backend**: Supabase (Postgres, Auth, Edge Functions, Storage se usato)
- **Hosting**: Vercel
- **Analytics**: Vercel Web Analytics
- **PWA**: Service worker per offline + push notifications

## Convenzioni di codice
- **Indentazione**: tab, non spazi (alcune sezioni più vecchie di `app.js` sono a 4 spazi per errore — se tocchi quelle righe uniformale a tab invece di aggiungere un terzo stile).
- **Naming**: camelCase per variabili e funzioni JS (`applyTheme`, `loadData`, `sessionParticipants`). Funzioni con verbo+nome (`applyTheme`, `setTheme`, `toggleTheme`, `initTheme`). Classi CSS in kebab-case flat (`.filter-toggle-btn`, `.history-date-row`), non BEM.
- **Organizzazione file**: niente cartella `src/`, file piatti nella root (`app.js`, `i18n.js`, `style.css`, `sw.js`). Un solo `style.css` per tutta la SPA (sotto `/app`), diviso in sezioni con banner di commento `/* ========== NOME SEZIONE ========== */` (stesso pattern usato in `app.js` con `// ========== NOME SEZIONE ==========`). Le pagine marketing statiche (`index.html`, `come-funziona.html`, `faq.html`, `blog/`) usano un CSS separato non hashato, `marketing.css`, per non passare dalla pipeline di hashing di esbuild di `style.css`/`app.js`/`i18n.js` (vedi `build.mjs`).
- **Stato lato client**: nessuno state manager — stato globale in `let`/`const` a livello di modulo in cima ad `app.js` (`currentUser`, `smokes`, `charts`, `notifications`, ecc.), mutato direttamente dalle funzioni. Flag booleani tipo `smokesLoaded`/`achievementsLoaded` sono usati per evitare race condition tra caricamento dati async e prima render.
- **Tema**: chiaro/scuro/auto via attributo `data-theme` su `<html>`, variabili CSS ridefinite in `:root[data-theme="dark"]`; preferenza salvata in `localStorage` (`jt_theme`).
- **i18n**: stringhe in `locales/it.json` / `locales/en.json`, gestite da `i18n.js` (non hardcodare testo utente-visibile direttamente in `app.js`/HTML).
- **Async**: `async`/`await` è lo standard (68 funzioni async in `app.js`); evita `.then()` a meno che tu non stia già dentro una catena esistente.
- **Eventi DOM**: `addEventListener`, mai `onclick=` inline nell'HTML.
- **HTML da dati utente**: passare sempre da `escapeHtml()` prima di iniettare testo libero di altri utenti (nomi posti, username, ecc.) via `innerHTML` — vedi il commento sopra la funzione in `app.js`.

## Sicurezza — regole non negoziabili
- Ogni nuova tabella Supabase DEVE avere RLS abilitato prima del merge
- Le funzioni che bypassano RLS (SECURITY DEFINER) vanno documentate qui sotto con motivazione:
  - `create_shared_session(...)` — inserisce righe in `smokes` (e notifiche) per gli ALTRI partecipanti della sessione condivisa, non solo per chi chiama; la RLS di `smokes` altrimenti permetterebbe solo insert sulle proprie righe.
  - `get_friend_stats(target_user_id)`, `get_global_leaderboard()`, `get_friends_leaderboard(current_user_id)` — aggregano `smokes` di ALTRI utenti (amici o globale) per classifiche/statistiche; la RLS su `smokes` restringe normalmente la lettura alle proprie righe.
  - `send_friend_request(target_username)` — cerca profili di altri utenti per username e inserisce una notifica sull'account del destinatario.
  - `respond_friend_request(requester_id, accept)` — su accept scrive la riga di amicizia "di ritorno" (di proprietà del richiedente) e una notifica per lui; la RLS normalmente permette di scrivere solo le proprie righe.
  - `remove_friend(target_id)` — cancella la riga di amicizia in ENTRAMBE le direzioni (l'accettazione ne crea due, una per parte); senza bypass RLS un utente potrebbe cancellare solo la propria riga, lasciando l'altro a vederti ancora come amico.
  - `get_pending_friend_requests()` — legge `friendships` + `profiles.username` di chi ha mandato la richiesta (join cross-utente).
  - `profiles_public` (view, non funzione, ma stessa semantica: `security_invoker = false`) — espone solo `id, username, avatar_url` di TUTTI i profili per ricerca amici/classifica, bypassando la RLS di `profiles` che limita ognuno al proprio profilo. **Attenzione**: in produzione questa view è già stata trovata silenziosamente flippata a `security_invoker = on` (probabile modifica manuale in Supabase Studio mai tracciata in una migration) rompendo la ricerca amici senza errori visibili — se il comportamento sembra inconsistente rispetto alle migration, verifica sempre la definizione live via MCP Supabase (`pg_get_viewdef`, `reloptions`) prima di fidarti dei file in `supabase/migrations/`.
  - `insert_own_notification(p_type, p_message)` — `notifications` non ha una policy INSERT per utenti normali (le notifiche cross-utente passano già da funzioni SECURITY DEFINER dedicate, es. `send_friend_request`). Usata dal sistema tolerance break per le notifiche in-app di milestone CB1/check-in: inserisce sempre e solo con `user_id = auth.uid()`, quindi un utente può notificare solo se stesso.
  - `admin_dashboard_stats()` — dashboard di amministrazione owner-only (`/admin`): aggrega `auth.users`, e `smokes`/`tolerance_breaks`/`profiles` di TUTTI gli utenti per crescita/utilizzo/adozione feature; la RLS normalmente limita ognuno alle proprie righe e `auth.users` non è raggiungibile dal client. Protetta da un controllo email hardcoded su `auth.jwt() ->> 'email'` (solo `poggi.matteo.2005@gmail.com`), `execute` concesso solo a `authenticated` e revocato da `anon`/`public`. Nessuna tabella nuova, quindi nessuna nuova RLS policy.
  - `can_see_snapshot(p_snapshot_id)` — helper: vero se l'istantanea (riga `smokes` con `photo_path`) è tua o di un amico `accepted`. Usato da tutte le RPC feed per il check di visibilità.
  - `snapshot_reaction_summary(p_snapshot_id)` — aggrega `snapshot_reactions` per tipo (`{"heart":N,…}`); legge reazioni di altri utenti.
  - `get_snapshot_feed(limit_count)` — feed istantanee: join `smokes`+`profiles`+`friendships` di altri utenti + conteggi reazioni/commenti; sostituisce `get_friends_snapshots` per il feed e in più ritorna `smokes.id`.
  - `get_snapshot_comments(p_snapshot_id)` — commenti di un'istantanea + `profiles.username` (join cross-utente); solleva `42501` se `can_see_snapshot` è falso.
  - `set_snapshot_reaction(p_snapshot_id, p_reaction_type)` / `remove_snapshot_reaction(p_snapshot_id)` — upsert/delete della propria reazione su un'istantanea di un amico; `set_` genera la notifica aggregata sull'owner. Scrivono sempre con `user_id = auth.uid()`.
  - `add_snapshot_comment(p_snapshot_id, p_body)` — inserisce un commento (proprio) su un'istantanea di un amico + notifica aggregata sull'owner.
  - `delete_snapshot_comment(p_comment_id)` — cancella un commento solo se `user_id = auth.uid()`.
  - `notify_snapshot_engagement(p_owner, p_type, p_snapshot_id)` — interno (nessun `execute` concesso): `INSERT … ON CONFLICT` sulla riga notifiche del giorno per (owner, tipo, istantanea), incrementa `event_count` e rimette `read=false`. Aggregazione a finestra giorno-solare-UTC.
  - `snapshot_engagement_counts(p_snapshot_id)` — ritorna `(reaction_count, comment_count)` di un'istantanea; gated su `can_see_snapshot` (`42501` se falso). Usata dalla conferma di cancellazione nel path Galleria, dove `feedItems` non è popolato. `snapshot_reaction_summary` non è più eseguibile da `authenticated`/`anon` (revocata: la chiamano solo RPC SECURITY DEFINER che girano come owner).
- Mai esporre chiavi service_role lato client
- Edge Functions: validare sempre l'input, mai fidarsi di dati dal client

## Aree sensibili (chiedere conferma prima di modificare)
- Esiste una pagina admin privata a `/admin` (`admin.html`, standalone, `noindex`, non linkata da nessuna parte) — vedi `docs/superpowers/specs/2026-08-28-admin-dashboard-design.md`. Nota: `/admin` è dentro lo scope del service worker (`/sw.js` → scope `/`) e servito cache-first; un deploy che tocca solo `admin.html` (non `app.js`) non bumpa `CACHE_NAME`, quindi l'owner vede la versione precedente per un load — hard-reload dopo un hotfix solo-admin.
- Service worker (cache invalidation puo rompere l'app per utenti esistenti)
- Schema RLS policies
- Logica guest mode / migrazione da guest ad account registrato
- Sistema achievements (se cambia la logica, gli achievement già sbloccati non devono sparire)
- **Istantanee/feed**: un'istantanea è una riga `smokes` con `photo_path` non null. Reazioni in `snapshot_reactions` (una per utente/istantanea, 5 tipi fissi), commenti in `snapshot_comments` (thread piatto, 1–500 char), entrambe legate a `smokes.id`. "Cancellare un'istantanea" = `photo_path → null`: il trigger `trg_smokes_snapshot_cleanup_upd` su `smokes` fa il cascade di reazioni/commenti/notifiche. Il feed usa `get_snapshot_feed` (non più `get_friends_snapshots`, ancora in vita finché non rimosso). Spec/plan in `docs/superpowers/`.
- **Bucket Storage `avatars`** (pubblico in lettura, primo bucket pubblico del progetto): path `{user_id}/avatar.{webp|jpg}`, scrittura RLS solo sul proprio prefisso (`(storage.foldername(name))[1] = auth.uid()::text`), backstop bucket 2 MB + mime `image/{webp,jpeg,png}`. `profiles.avatar_url` contiene o la URL pubblica del file (`…/avatars/{uid}/avatar.ext?v={epoch}`), o un sentinel `preset:<key>` (8 preset fissi), o `null`. **Invariante**: solo l'helper `avatarMarkup()` in `app.js` interpreta `avatar_url` — nessun altro punto fa `<img src=${…avatar_url}>`. Se aggiungi una superficie che mostra un utente, chiama `avatarMarkup()`. Migration `20260830120000_add_avatars_bucket.sql`, applicata a prod via MCP. Spec/plan in `docs/superpowers/`. Due note aggiuntive: (a) la policy SELECT del bucket è `to public`, quindi un chiamante anon può fare `storage.list()` sul bucket e leggere tutti i nomi delle cartelle `{uid}/` (numero utenti + UUID) — non è un segreto, è inerente ai bucket pubblici; (b) `profiles.avatar_url` è ora vincolato dal CHECK `profiles_avatar_url_shape` (`null` | `preset:%` | prefisso URL pubblica del bucket avatars), migration `20260830140000_constrain_avatar_url.sql`.

## Comandi utili
```
# Build di produzione (minifica + cache-busting via hash, genera dist/)
# — normalmente lo lancia Vercel da solo (buildCommand in vercel.json), utile in locale solo per debug della build
npm run build

# Sviluppo locale: nessun bundler/dev server necessario, i sorgenti (app.js, style.css, i18n.js)
# vengono serviti cosi' come sono. Basta un qualsiasi static server sulla root, es.:
npx serve .

# Rigenerare le icone PWA (standard/maskable/splash) a partire da icon-512.png
powershell -ExecutionPolicy Bypass -File generate-pwa-assets.ps1

# Deploy: push su main del repo GitHub -> Vercel fa auto-deploy (build + dist/) da solo
git push origin main

# Migration Supabase: NON applicate in automatico da un push. Vanno lanciate a mano
# nell'SQL editor di Supabase (o via CLI se autenticata) — Claude Code non ha accesso
# di deploy al DB o alle Edge Functions da questo repo.
supabase functions deploy <nome-funzione>   # es. send-reminders, weekly-backup, check-low-stock, list-backups
```

## Note su performance
- Obiettivo: mantenere punteggio PageSpeed alto (lighthouse). Attenzione a:
  - dimensione bundle JS (niente librerie pesanti se evitabile, dato che è vanilla)
  - lazy loading immagini
  - service worker caching strategy

## Backlog / cose note da sistemare
- **Avatar utente — leaderboard/modal amico**: leaderboard e modal amico prendono l'avatar via `fetchAvatarMap()` (join client su `profiles_public`), non dalle RPC leaderboard che non lo ritornano; le RPC dovrebbero ritornare `avatar_url` se utilizzate di nuovo altrove. Guest mode: `jt_guest_avatar` in `localStorage` usa solo i preset, migrato a login via `migrateGuestAvatar()`.
- **Avatar — Image Transforms**: si serve un unico file 256×256 a ogni dimensione di render (piano Free, `SUPABASE_IMAGE_TRANSFORMS_ENABLED=false`). Se si passa a Pro, valutare un thumb 64px per leaderboard/commenti.
- **Avatar — moderazione**: nessun flusso per segnalare/rimuovere un avatar offensivo di un altro utente; l'unico rimedio è agire direttamente su Storage/`profiles` come owner. `avatar_url` non può più essere una URL esterna (il CHECK `profiles_avatar_url_shape` lo blocca), quindi un avatar offensivo è sempre o un valore `preset:` o un file in Storage che il proprietario può cancellare.
- **Backfill dati storici sessioni condivise non applicato**: `supabase/migrations/20260819160500_backfill_shared_session_stats.sql` contiene solo la query di PREVIEW attiva; la UPDATE che corregge `my_fumo_grams`/`my_erba_grams`/`type` sulle righe storiche di sessioni condivise (bug fixato per le nuove righe da `20260819160000_fix_shared_session_personal_stats.sql`) è commentata e va lanciata a mano nell'SQL editor dopo aver controllato la preview.
- **Verificare se le migration "NOT applied automatically" sono state effettivamente eseguite in produzione**: `20260819160000_fix_shared_session_personal_stats.sql` e `20260819170000_fix_leaderboard_legacy_data_fallback.sql` sono marcate esplicitamente come da lanciare a mano nell'SQL editor Supabase, non da CLI/push automatico — controllare lo stato live (es. via MCP Supabase) prima di assumere che il fix sia in produzione, specie visto il caso già noto di `profiles_public` disallineata dalle migration.
- **Image Transformations di Supabase Storage disattivate**: `SUPABASE_IMAGE_TRANSFORMS_ENABLED = false` in `app.js` (vicino a `GALLERY_THUMB_TRANSFORM`) perché il progetto è sul piano Free (le richieste fallirebbero sempre). Da riattivare (flag + toggle in Storage > Settings) se/quando si passa a Pro.
- **Redeploy manuale della Edge Function `send-reminders`**: il codice sorgente in `supabase/functions/send-reminders/index.ts` punta già a `/app` (aggiornato per il restructure SEO del 2026-08-21) e ora sospende anche il reminder standard durante una tolerance break attiva (feature del 2026-08-22), ma le Edge Functions non si deployano da un push su GitHub — va rilanciato manualmente `supabase functions deploy send-reminders` (o dalla dashboard) per far arrivare i fix in produzione; verificare che sia già stato fatto.
- **Notifiche push per milestone/check-in della tolerance break non implementate**: il sistema tolerance break (feature del 2026-08-22) manda notifiche milestone CB1 (giorni 2/7/14/28) e check-in generico solo in-app (tabella `notifications`, calcolate client-side in `app.js` `checkBreakNotifications`). Le equivalenti notifiche push (OS-level, tramite `send-reminders` o una nuova edge function) sono state rimandate di proposito — se servono in futuro, riusare le colonne `notified_milestones`/`last_checkin_notified_day` di `tolerance_breaks` come tracking condiviso lato server, con attenzione alla race tra client e cron sullo stesso array.
- **Indentazione mista in `app.js`**: porzioni del file usano 4 spazi invece di tab (vedi "Convenzioni di codice"); da normalizzare col tempo, non c'è ancora un lint/format automatico nel repo che lo impedisca.
- **Feed istantanee — Parte 2 non implementata**: vista profilo di un altro utente + archivio paginato delle sue istantanee oltre le ultime 20 (le righe restano in `smokes`, non vengono mai cancellate). Spec/plan della Parte 1 in `docs/superpowers/`. Da fare: `get_user_snapshots(p_user_id, limit, offset)` visibility-checked, modal profilo, rendere avatar/username del feed cliccabili. Al termine, valutare la rimozione di `get_friends_snapshots` (non più referenziato dopo la Parte 1).
- **Click su notifica istantanea "vecchia"**: `goToSnapshot` scrolla solo se l'istantanea è tra le ultime 20 del feed; per le più vecchie non fa nulla finché non c'è la vista archivio (Parte 2).
- **`notifications` non è nella publication `supabase_realtime`**: le notifiche in-app (incluse quelle nuove aggregate per reazioni/commenti) compaiono solo al reload finché non si fa `alter publication supabase_realtime add table public.notifications`. Poi verificare il carico: `markAllNotificationsRead` fa un update bulk → l'echo guard è già in `subscribeToNotifications` (handler UPDATE, salta il re-render quando `payload.new.read===true` e la riga locale era già letta).
- **Il proprietario di un'istantanea non può moderare i commenti altrui sulla propria foto** — thread piatto, niente segnalazione né rimozione; l'unica azione è cancellare la propria istantanea (cascade di reazioni/commenti/notifiche).
- **Righe notifiche fantasma dopo un cascade delete**: quando si cancella un'istantanea (`photo_path → null`), il trigger elimina lato server le righe `notifications` collegate, ma il client non le rimuove dall'array `notifications` (nessuna subscription DELETE) → la riga resta visibile fino al reload.
