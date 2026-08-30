# Avatar utente (upload libero + preset) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dare a ogni utente un avatar (foto ritagliata quadrata caricata su Storage, oppure un'icona preset) e mostrarlo ovunque compaia uno username: leaderboard (3 tab), modal statistiche amico, sessioni condivise, feed istantanee + commenti, card Profilo.

**Architecture:** `profiles.avatar_url` (già esistente, già in `profiles_public`) diventa il singolo campo che contiene o una URL pubblica (`https://…/avatars/{uid}/avatar.{ext}?v=…`), o un sentinel `preset:<key>`, o `null`. Un unico helper `avatarMarkup()` in `app.js` interpreta le tre forme — **nessun** altro punto del codice legge `avatar_url` direttamente. Nuovo bucket Storage pubblico `avatars` con RLS che consente scrittura solo sul prefisso `{auth.uid()}/`. Le RPC leaderboard/stats **non si toccano**: gli avatar arrivano con una singola query client-side su `profiles_public`. Crop interattivo pan+zoom in vanilla JS (Pointer Events + canvas), export a 256×256 WebP. Guest: solo preset in `localStorage`, migrato al signup.

**Tech Stack:** HTML/CSS/JS vanilla (nessun bundler/framework), `supabase-js` già presente, Supabase Storage + Postgres (progetto `afkxmbxcavwhurmdelfr`, piano **Free** → niente Image Transforms, niente branching), i18n custom (`i18n.js` → `t()` / `tn()`), deploy Vercel su push a `main`.

**Spec:** [`docs/superpowers/specs/2026-08-30-avatar-utente-design.md`](../specs/2026-08-30-avatar-utente-design.md) — leggere prima di iniziare; il piano argomenta dallo spec.

## Global Constraints

- **RLS obbligatorio** su ogni oggetto Storage nuovo (`CLAUDE.md`). Il bucket `avatars` è pubblico in **lettura**; scrittura/update/delete solo dove `(storage.foldername(name))[1] = auth.uid()::text`.
- **`escapeHtml()`** su ogni testo libero di altri utenti iniettato via `innerHTML` — qui: `username` dentro `avatarMarkup()` (iniziale + `alt`). `escapeHtml` esiste già in `app.js`.
- **Mai `onclick=` inline** nel JS/HTML nuovo — `addEventListener` / event delegation. (Il codice esistente che si tocca usa `onclick=` inline: **non** convertirlo se non è la riga che stai già modificando; le righe nuove seguono la regola.)
- **Indentazione: tab.** `camelCase` per JS. Classi CSS **kebab-case flat**. Banner di sezione `// ========== NOME ==========` (JS) e `/* ========== NOME ========== */` (CSS).
- **Nessuna libreria/dipendenza nuova.** Vanilla, attenzione al bundle (PageSpeed).
- **Testo utente-visibile solo via `t()`**, chiave in **entrambi** `locales/it.json` e `locales/en.json`.
- **Preset: esattamente 8**, chiavi interne stabili: `leaf herb sprout evergreen sun moon fire sparkle` → 🍃 🌿 🌱 🌲 ☀️ 🌙 🔥 ✨. Stored come `preset:<key>`.
- **Un solo file avatar per utente**, nome fisso `avatar.webp` o `avatar.jpg` sotto `{uid}/`. Cache-buster `?v=<epoch_ms>` in `avatar_url` a ogni upload.
- **Export crop: canvas 256×256**, `toBlob('image/webp', 0.85)` con fallback `image/jpeg`.
- **Validazione upload:** tipo ∈ `{image/jpeg, image/png, image/webp}`, dimensione pre-compressione ≤ 10 MB, decodifica `Image` obbligatoria.
- **Guest:** nessun upload. Solo preset in `localStorage` chiave `jt_guest_avatar` (valore `preset:<key>`). Migrato in fase di login/signup.
- **Migration NON auto-applicata da git push** — applicata a mano via Supabase MCP `apply_migration` sul progetto `afkxmbxcavwhurmdelfr` (che è **produzione**). Modifiche additive; il task migration include lo SQL di rollback.
- **`profiles_public`** è una view `security_invoker = false` (semantica security-definer). In passato è stata trovata flippata a `on` in prod rompendo tutto silenziosamente — **verificare la definizione live** (Task 1 Step 1) prima di fidarsi.
- **Branch:** `feat/avatar-utente` (già creato, contiene il commit dello spec `d0fc5cd`). Nessun push finché Matteo non lo chiede.

---

## File structure

**Creare:**
- `supabase/migrations/20260830120000_add_avatars_bucket.sql` — bucket `avatars` + 4 policy su `storage.objects`.

**Modificare:**
- `app.js`:
  - nuovo globale `currentUserProfile` (in cima, `// ========== VARIABILI GLOBALI ==========`).
  - nuova sezione `// ========== AVATAR ==========` (helper `avatarMarkup`, `hslFromHash`, `PRESET_AVATARS`, `presetEmoji`, `avatarImgFallback`, `fetchAvatarMap`; UI settings `renderAvatarSettings`, `selectPresetAvatar`, `removeAvatar`, `handleAvatarFileSelected`; crop `openAvatarCrop`/`exportCroppedAvatar` + listener; upload `uploadAvatarBlob`, `removeUploadedAvatarFiles`; guest `getGuestAvatar`/`setGuestAvatar`/`clearGuestAvatar`, `migrateGuestAvatar`).
  - `loadUserProfile()` (~riga 3524) — select estesa, popola `currentUserProfile`, chiama `renderAvatarSettings()`.
  - `feedCardHtml()` (~riga 2239) — markup avatar inline → `avatarMarkup()`.
  - `renderComments()` (~riga 2504) — mini-avatar per riga commento.
  - `loadSocial()` (~riga 3286) e `loadSharedLeaderboard()` (~riga 3363) — join `fetchAvatarMap`, avatar nella riga.
  - `viewFriendStats()` (~riga 3465) — fetch singolo + avatar accanto al nome.
  - `getMyFriendsList()` (~riga 208), `renderFriendsQuickList()` (~riga 221), `searchParticipant()` (~riga 253), `quickAddParticipant()` (~riga 247), `renderParticipantChips()` (~riga 284), `renderContributorsPanel()` (~riga 293) — portare `avatar_url` in `sessionParticipants` e renderizzarlo.
  - `checkAuth()` (~riga 382) e il blocco post-signup (~riga 591) — chiamata a `migrateGuestAvatar()`.
  - `applyGuestModeUI()` (~riga 783) — `profileCard` sempre visibile; nasconde solo il blocco identità per i guest.
- `app/index.html`:
  - `#profileCard` (~riga 773) — wrapper `#profileIdentityBlock`, nuova sezione avatar, `<input type=file>` nascosto.
  - nuovo `#avatarCropModal` vicino agli altri modal (dopo `#friendModal`, ~riga 631).
- `style.css` — nuova sezione `/* ========== AVATAR ========== */`; riconciliare `.feed-avatar*` (righe 973–974).
- `locales/it.json`, `locales/en.json` — blocco chiavi `settings.avatar*`.
- `CLAUDE.md` — "Aree sensibili": bucket `avatars` + invariante "solo `avatarMarkup()` legge `avatar_url`"; backlog.

**NON serve toccare** `build.mjs` / `vercel.json`: nessun asset nuovo (i preset sono emoji inline), `app.js`/`style.css`/`i18n.js` passano già dalla pipeline di hashing esistente.

---

## Verifica — come si testano le cose in questo repo

Nessun framework di test. Tre modi (come nel piano feed):

1. **SQL via Supabase MCP** (`execute_sql` / `apply_migration` sul progetto `afkxmbxcavwhurmdelfr` = **produzione**). Per simulare un utente in una singola chiamata (transaction-local):
   ```sql
   select set_config('request.jwt.claims', '{"sub":"<UUID>","email":"x@y.z","role":"authenticated"}', true);
   -- …statement che usa auth.uid()…
   ```
   Per lo Storage: `auth.uid()` dentro le policy legge la stessa claim.

2. **Browser pane** su `npx serve .` dalla root del repo. La **modalità ospite è raggiungibile senza login** ("🚀 Prova senza registrarti") → il preset picker, la preview, la validazione file e il **crop modal** sono verificabili qui. L'`avatarMarkup()` si prova in console.

3. **Flussi autenticati** (upload reale su Storage, avatar nelle leaderboard/feed di utenti reali): li verifica **Matteo** con l'account `claude_test` (`e0346ed5-45b6-4c42-bd46-c129a21798b3`) via screenshot — la regola password del progetto vieta a Claude di fare login.

**Dati per i test SQL** (l'esecutore li recupera all'inizio di Task 1):
```sql
select id from auth.users where deleted_at is null limit 2;   -- => <USER_A>, <USER_B>
```
Nel piano: `<USER_A>`, `<USER_B>` (due utenti reali distinti).

---

## Task 1: Migration — bucket `avatars` + policy Storage

**Files:**
- Create: `supabase/migrations/20260830120000_add_avatars_bucket.sql`

**Interfaces:**
- Produces: bucket Storage `avatars` (public read). Policy su `storage.objects`: SELECT aperta a tutti per `bucket_id='avatars'`; INSERT/UPDATE/DELETE per `authenticated` solo se `(storage.foldername(name))[1] = auth.uid()::text`.

- [ ] **Step 1: Verifica pre-flight di `profiles_public` (MCP `execute_sql`)**

```sql
select pg_get_viewdef('public.profiles_public'::regclass, true);
select relname, reloptions from pg_class where relname = 'profiles_public';
```
Atteso: la `viewdef` seleziona `id, username, avatar_url` da `profiles`; `reloptions` **non** contiene `security_invoker=true` (o è `NULL`). Se `security_invoker=true` → **fermarsi**: va rimesso a `false` come pre-requisito (`alter view public.profiles_public set (security_invoker = false);`) e va segnalato a Matteo che le migration sono di nuovo disallineate. Se `avatar_url` non è nella select → aggiungerlo (`create or replace view … select id, username, avatar_url …`) come Step 1b prima di procedere.

- [ ] **Step 2: Recuperare due user id reali (MCP)**

```sql
select id from auth.users where deleted_at is null limit 2;
```
Annotare come `<USER_A>` e `<USER_B>`.

- [ ] **Step 3: Scrivere il file migration**

```sql
-- Bucket avatar: lettura pubblica (niente signed URL — gli avatar sono già
-- esposti a ogni utente loggato via profiles_public, e pubblici sono cacheabili
-- dalla CDN). Scrittura consentita solo sul proprio prefisso {auth.uid()}/.
-- Path convention: {user_id}/avatar.webp  (o avatar.jpg in fallback).
-- Vedi docs/superpowers/specs/2026-08-30-avatar-utente-design.md §6.1.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

create policy "Avatar: lettura pubblica"
  on storage.objects for select
  using ( bucket_id = 'avatars' );

create policy "Avatar: insert solo proprio prefisso"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Avatar: update solo proprio prefisso"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Avatar: delete solo proprio prefisso"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

Rollback (in un commento in fondo al file):
```sql
-- ROLLBACK:
-- drop policy "Avatar: lettura pubblica" on storage.objects;
-- drop policy "Avatar: insert solo proprio prefisso" on storage.objects;
-- drop policy "Avatar: update solo proprio prefisso" on storage.objects;
-- drop policy "Avatar: delete solo proprio prefisso" on storage.objects;
-- delete from storage.buckets where id = 'avatars';   -- solo se il bucket è vuoto
```

- [ ] **Step 4: Applicare la migration (MCP `apply_migration`, name `add_avatars_bucket`)**

- [ ] **Step 5: Verifica — policy esistono e il prefisso è isolato**

```sql
-- le 4 policy risultano su storage.objects
select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'Avatar:%'
order by policyname;
```
Atteso: 4 righe (`delete`, `insert`, `select`, `update`).

```sql
-- USER_A può scrivere sotto il proprio prefisso, non sotto quello di USER_B.
select set_config('request.jwt.claims',
  '{"sub":"<USER_A>","role":"authenticated"}', true);

insert into storage.objects (bucket_id, name, owner, metadata)
values ('avatars', '<USER_A>/avatar.webp', '<USER_A>', '{}'::jsonb);        -- atteso: OK

insert into storage.objects (bucket_id, name, owner, metadata)
values ('avatars', '<USER_B>/avatar.webp', '<USER_A>', '{}'::jsonb);        -- atteso: errore RLS (new row violates row-level security policy)
```

```sql
-- lettura pubblica anche senza claim autenticato
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select count(*) from storage.objects where bucket_id = 'avatars';           -- atteso: >= 1 (vede la riga di USER_A)
```

```sql
-- cleanup della riga di test (come postgres / service role)
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
delete from storage.objects where bucket_id = 'avatars' and name = '<USER_A>/avatar.webp';
```

- [ ] **Step 6: Aggiornare `CLAUDE.md`**

Nella sezione **"## Aree sensibili (chiedere conferma prima di modificare)"**, aggiungere in fondo:

```markdown
- **Bucket Storage `avatars`** (pubblico in lettura, primo bucket pubblico del progetto): path `{user_id}/avatar.{webp|jpg}`, scrittura RLS solo sul proprio prefisso. `profiles.avatar_url` contiene o la URL pubblica del file (`…/avatars/{uid}/avatar.ext?v={epoch}`), o un sentinel `preset:<key>` (8 preset fissi), o `null`. **Invariante**: solo l'helper `avatarMarkup()` in `app.js` interpreta `avatar_url` — nessun altro punto fa `<img src=${…avatar_url}>`. Se aggiungi una superficie che mostra un utente, chiama `avatarMarkup()`.
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260830120000_add_avatars_bucket.sql CLAUDE.md
git commit -m "feat(db): public avatars storage bucket + own-prefix write RLS"
```

---

## Task 2: i18n — chiavi avatar

**Files:**
- Modify: `locales/it.json`, `locales/en.json`

**Interfaces:**
- Produces: chiavi disponibili a `t()` sotto `settings`: `avatarTitle`, `avatarUploadMode`, `avatarPresetMode`, `avatarChooseImage`, `avatarRemove`, `avatarGuestHint`, `avatarCropTitle`, `avatarCropZoom`, `avatarCropConfirm`, `avatarCropCancel`, `avatarUpdated`, `avatarRemoved`, `avatarUploadError`, `avatarUploading`, `avatarFormatError`, `avatarTooLarge`.

- [ ] **Step 1: Aggiungere le chiavi a `locales/it.json`**

Nel blocco `"settings"` (dopo `"achievements"` o dove conviene, comunque dentro `settings`):

```json
    "avatarTitle": "Immagine del profilo",
    "avatarUploadMode": "Carica foto",
    "avatarPresetMode": "Scegli icona",
    "avatarChooseImage": "Scegli immagine",
    "avatarRemove": "Rimuovi",
    "avatarGuestHint": "Crea un account per caricare una tua foto. Per ora puoi scegliere un'icona.",
    "avatarCropTitle": "Ritaglia l'avatar",
    "avatarCropZoom": "Zoom",
    "avatarCropConfirm": "Conferma",
    "avatarCropCancel": "Annulla",
    "avatarUpdated": "Immagine del profilo aggiornata",
    "avatarRemoved": "Immagine del profilo rimossa",
    "avatarUploadError": "Caricamento non riuscito, riprova.",
    "avatarUploading": "Caricamento…",
    "avatarFormatError": "Formato non supportato. Usa JPG, PNG o WebP.",
    "avatarTooLarge": "Immagine troppo grande (massimo 10 MB).",
```

- [ ] **Step 2: Aggiungere le stesse chiavi a `locales/en.json`** (stesso blocco `"settings"`, stesse chiavi):

```json
    "avatarTitle": "Profile picture",
    "avatarUploadMode": "Upload photo",
    "avatarPresetMode": "Pick an icon",
    "avatarChooseImage": "Choose image",
    "avatarRemove": "Remove",
    "avatarGuestHint": "Create an account to upload a photo. For now you can pick an icon.",
    "avatarCropTitle": "Crop your avatar",
    "avatarCropZoom": "Zoom",
    "avatarCropConfirm": "Confirm",
    "avatarCropCancel": "Cancel",
    "avatarUpdated": "Profile picture updated",
    "avatarRemoved": "Profile picture removed",
    "avatarUploadError": "Upload failed, please try again.",
    "avatarUploading": "Uploading…",
    "avatarFormatError": "Unsupported format. Use JPG, PNG or WebP.",
    "avatarTooLarge": "Image too large (10 MB max).",
```

- [ ] **Step 3: Verifica — JSON valido e chiavi in entrambe le lingue**

```bash
node -e "const it=require('./locales/it.json'),en=require('./locales/en.json');const k=['avatarTitle','avatarUploadMode','avatarPresetMode','avatarChooseImage','avatarRemove','avatarGuestHint','avatarCropTitle','avatarCropZoom','avatarCropConfirm','avatarCropCancel','avatarUpdated','avatarRemoved','avatarUploadError','avatarUploading','avatarFormatError','avatarTooLarge'];for(const x of k){if(!it.settings||!it.settings[x])throw new Error('IT manca settings.'+x);if(!en.settings||!en.settings[x])throw new Error('EN manca settings.'+x);}console.log('ok');"
```
Atteso: `ok`.

- [ ] **Step 4: Commit**

```bash
git add locales/it.json locales/en.json
git commit -m "i18n: avatar settings strings"
```

---

## Task 3: Core — helper `avatarMarkup` + CSS `.avatar*` + refactor feed

**Files:**
- Modify: `app.js` — nuovo globale `currentUserProfile`; nuova sezione `// ========== AVATAR ==========` (parte 1: helper di render); `feedCardHtml()` (~riga 2247).
- Modify: `style.css` — nuova sezione `/* ========== AVATAR ========== */`; righe 973–974 (`.feed-avatar`, `.feed-avatar-fallback`).

**Interfaces:**
- Produces:
  - `let currentUserProfile = null;` — dopo `loadUserProfile()`: `{ username, avatar_url }`.
  - `const PRESET_AVATARS = { leaf:'🍃', herb:'🌿', sprout:'🌱', evergreen:'🌲', sun:'☀️', moon:'🌙', fire:'🔥', sparkle:'✨' }`
  - `const PRESET_KEYS = Object.keys(PRESET_AVATARS)`
  - `presetEmoji(key) -> string | null`
  - `hslFromHash(str) -> string` (es. `"hsl(210 55% 45%)"`)
  - `avatarMarkup(avatarUrl, username, sizePx = 32) -> string` (HTML già escaped, safe per `innerHTML`)
  - `avatarImgFallback(imgEl) -> void` (globale — usata nell'attributo `onerror`)
- Consumes: `escapeHtml` (esistente).

- [ ] **Step 1: Aggiungere il globale `currentUserProfile`**

In `app.js`, sezione `// ========== VARIABILI GLOBALI ==========`, dopo `let unlockedAchievements = [];` (~riga 26):

```javascript
let currentUserProfile = null; // { username, avatar_url } — popolato da loadUserProfile()
```

- [ ] **Step 2: Scrivere la sezione AVATAR (parte 1: render)**

In `app.js`, aggiungere una nuova sezione (collocarla vicino a `// ========== FOTO SESSIONE ==========`, ~riga 1989, prima di essa):

```javascript
// ========== AVATAR ==========
// profiles.avatar_url può essere: una URL http(s) (foto caricata), un sentinel
// "preset:<key>", oppure null. avatarMarkup() è l'UNICO punto che interpreta il
// campo — ogni superficie che mostra un utente passa di qui. Vedi
// docs/superpowers/specs/2026-08-30-avatar-utente-design.md §3.

const PRESET_AVATARS = {
	leaf: '🍃', herb: '🌿', sprout: '🌱', evergreen: '🌲',
	sun: '☀️', moon: '🌙', fire: '🔥', sparkle: '✨',
};
const PRESET_KEYS = Object.keys(PRESET_AVATARS);

function presetEmoji(key) {
	return Object.prototype.hasOwnProperty.call(PRESET_AVATARS, key) ? PRESET_AVATARS[key] : null;
}

// Hash deterministico (djb2) -> tinta stabile per l'iniziale di fallback.
// S/L fissi scelti per reggere sia tema chiaro che scuro con testo bianco.
function hslFromHash(str) {
	let h = 5381;
	const s = String(str || '?');
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return `hsl(${Math.abs(h) % 360} 45% 45%)`;
}

// Ritorna markup HTML per un avatar. `username` serve solo per l'iniziale e l'alt.
function avatarMarkup(avatarUrl, username, sizePx = 32) {
	const name = String(username || '?');
	const initial = escapeHtml(name.trim().slice(0, 1).toUpperCase() || '?');
	const px = Math.round(sizePx);
	const fontPx = Math.round(px * 0.44);
	const dims = `width:${px}px;height:${px}px;`;

	if (typeof avatarUrl === 'string' && avatarUrl.startsWith('preset:')) {
		const emoji = presetEmoji(avatarUrl.slice(7));
		if (emoji) {
			return `<span class="avatar avatar-preset" style="${dims}font-size:${Math.round(px * 0.55)}px;" aria-hidden="true">${emoji}</span>`;
		}
		// key ignota -> degrada a iniziale
	} else if (typeof avatarUrl === 'string' && /^https?:\/\//i.test(avatarUrl)) {
		return `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}" `
			+ `width="${px}" height="${px}" loading="lazy" `
			+ `data-initial="${initial}" data-hue="${escapeHtml(hslFromHash(name))}" `
			+ `onerror="avatarImgFallback(this)">`;
	}

	return `<span class="avatar avatar-fallback" style="${dims}font-size:${fontPx}px;background:${hslFromHash(name)};">${initial}</span>`;
}

// Sostituisce un <img> avatar rotto (file 404) con l'iniziale colorata,
// senza rifare query (initial/hue sono nei data-attr). Stesso pattern di fallbackPlainPhoto.
function avatarImgFallback(img) {
	if (img.dataset.fallbackDone) return;
	img.dataset.fallbackDone = '1';
	const span = document.createElement('span');
	span.className = 'avatar avatar-fallback';
	span.style.cssText = `width:${img.width}px;height:${img.height}px;font-size:${Math.round(img.width * 0.44)}px;background:${img.dataset.hue || 'hsl(140 45% 45%)'};`;
	span.textContent = img.dataset.initial || '?';
	img.replaceWith(span);
}
```

- [ ] **Step 3: CSS — sezione AVATAR**

In `style.css`, nuova sezione (collocarla vicino alle sezioni componenti, prima di `/* ========== FEED ISTANTANEE ========== */`):

```css
/* ========== AVATAR ========== */
.avatar {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 50%;
	object-fit: cover;
	flex: 0 0 auto;
	overflow: hidden;
	color: #fff;
	font-weight: 700;
	line-height: 1;
	vertical-align: middle;
	user-select: none;
}
.avatar-preset { background: rgba(76, 175, 80, 0.15); }
:root[data-theme="dark"] .avatar-preset { background: rgba(76, 175, 80, 0.22); }
.avatar-fallback { /* background impostato inline da hslFromHash */ }
```

- [ ] **Step 4: Refactor `feedCardHtml()` per usare `avatarMarkup()`**

In `app.js`, `feedCardHtml()` (~riga 2242). Sostituire:

```javascript
	const avatar = it.avatar_url
		? `<img class="feed-avatar" src="${escapeHtml(it.avatar_url)}" alt="" loading="lazy">`
		: `<span class="feed-avatar feed-avatar-fallback">${escapeHtml((it.username || '?').slice(0, 1).toUpperCase())}</span>`;
```

con:

```javascript
	const avatar = avatarMarkup(it.avatar_url, it.username, 30);
```

- [ ] **Step 5: Riconciliare il CSS del feed**

In `style.css` righe ~973–974, sostituire:

```css
.feed-avatar { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.feed-avatar-fallback { display: flex; align-items: center; justify-content: center; background: var(--color-primary, #4caf50); color: #fff; font-size: 13px; font-weight: 600; }
```

con (le classi `.feed-avatar*` non sono più generate da `feedCardHtml`, ma potrebbero comparire in cache di vecchie sessioni: si lasciano come alias inoffensivo per una release, poi si tolgono):

```css
/* .feed-avatar* deprecati: feedCardHtml ora usa .avatar (vedi sezione AVATAR).
   Alias temporaneo per HTML servito da cache pre-deploy. */
.feed-avatar { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.feed-avatar-fallback { display: flex; align-items: center; justify-content: center; background: var(--color-primary, #4caf50); color: #fff; font-size: 13px; font-weight: 600; }
```

(Nessun cambiamento funzionale in questo step — solo il commento. Lo step esiste per non lasciare il refactor a metà: se un futuro task rimuove `.feed-avatar*`, parte da qui.)

- [ ] **Step 6: Verifica — helper in isolamento (browser pane)**

Avviare `npx serve .` dalla root, aprire `http://localhost:3000/app/` nel Browser pane, poi in console:

```js
avatarMarkup('preset:leaf', 'Bob', 32)
// atteso: <span class="avatar avatar-preset" style="width:32px;height:32px;font-size:18px;" aria-hidden="true">🍃</span>

avatarMarkup('preset:zzz', 'Bob', 32)
// atteso: fallback -> <span class="avatar avatar-fallback" ...>B</span>

avatarMarkup(null, 'ada lovelace', 40)
// atteso: <span class="avatar avatar-fallback" style="...background:hsl(... );">A</span>

avatarMarkup('https://example.com/x.jpg', '<script>', 24)
// atteso: <img ... alt="&lt;script&gt;" data-initial="&lt;" ... onerror="avatarImgFallback(this)">

hslFromHash('bob') === hslFromHash('bob')   // atteso: true (deterministico)
```

Verificare anche che il feed (se raggiungibile — richiede login, altrimenti delega a Matteo) non sia visivamente regredito.

- [ ] **Step 7: Commit**

```bash
git add app.js style.css
git commit -m "feat: shared avatarMarkup() helper + .avatar styles; feed uses it"
```

---

## Task 4: Settings — card Profilo con sezione avatar + preset picker

**Files:**
- Modify: `app/index.html` — `#profileCard` (~riga 773).
- Modify: `app.js` — `applyGuestModeUI()` (~riga 783); `loadUserProfile()` (~riga 3524); sezione AVATAR (parte 2: UI settings).

**Interfaces:**
- Consumes: `avatarMarkup`, `PRESET_AVATARS`, `PRESET_KEYS`, `currentUserProfile`, `isGuestMode`, `currentUser`, `supabaseClient`, `t`, `showMessage`, `escapeHtml`.
- Produces:
  - `getGuestAvatar() -> string | null`, `setGuestAvatar(val)`, `clearGuestAvatar()` (localStorage `jt_guest_avatar`)
  - `currentAvatarValue() -> string | null` — l'avatar attivo (DB per registrati, localStorage per guest)
  - `renderAvatarSettings() -> void` — popola preview + griglia preset + stato
  - `selectPresetAvatar(key) -> Promise<void>`
  - `removeAvatar() -> Promise<void>`
  - `setAvatarMode(mode) -> void` (`'upload' | 'preset'`)
  - DOM: `#avatarPreview`, `#avatarModeUpload`, `#avatarModePreset`, `#avatarPresetGrid`, `#avatarRemoveBtn`, `#avatarError`, `#avatarFileInput`, `#avatarUploadPane`, `#avatarPresetPane`, `#avatarGuestHint`, `#profileIdentityBlock`

- [ ] **Step 1: HTML — ristrutturare `#profileCard`**

In `app/index.html`, sostituire il contenuto di `<div class="card" id="profileCard">` (righe ~773–781) con:

```html
	<div class="card" id="profileCard">
		<h3 data-i18n="settings.profile">👤 Profilo</h3>

		<div class="avatar-settings">
			<div class="avatar-settings-row">
				<span id="avatarPreview"></span>
				<button type="button" class="secondary-btn avatar-remove-btn" id="avatarRemoveBtn" onclick="removeAvatar()" data-i18n="settings.avatarRemove" style="display:none;">Rimuovi</button>
			</div>

			<div class="avatar-mode-tabs">
				<button type="button" id="avatarModeUpload" class="avatar-mode-tab active" onclick="setAvatarMode('upload')" data-i18n="settings.avatarUploadMode">Carica foto</button>
				<button type="button" id="avatarModePreset" class="avatar-mode-tab" onclick="setAvatarMode('preset')" data-i18n="settings.avatarPresetMode">Scegli icona</button>
			</div>

			<div id="avatarUploadPane" class="avatar-pane">
				<p id="avatarGuestHint" style="display:none; font-size:12px; color:var(--color-text-muted); margin:6px 0 0;" data-i18n="settings.avatarGuestHint">Crea un account per caricare una tua foto.</p>
				<button type="button" class="action-btn" id="avatarChooseBtn" onclick="document.getElementById('avatarFileInput').click()" data-i18n="settings.avatarChooseImage">Scegli immagine</button>
				<input type="file" id="avatarFileInput" accept="image/jpeg,image/png,image/webp" hidden onchange="handleAvatarFileSelected(event)">
			</div>

			<div id="avatarPresetPane" class="avatar-pane" style="display:none;">
				<div class="avatar-preset-grid" id="avatarPresetGrid"></div>
			</div>

			<p id="avatarError" class="avatar-error" style="display:none;"></p>
		</div>

		<div id="profileIdentityBlock">
			<p style="font-size:12px; color:var(--color-text-muted); margin-top:-8px;"><span data-i18n="settings.loggedInAs">Loggato come</span> <strong id="settingsEmailDisplay">...</strong></p>
			<p><span data-i18n="settings.currentNickname">Il tuo nickname attuale:</span> <strong id="currentUsernameDisplay" style="color: var(--primary);">...</strong></p>

			<label for="usernameInput" data-i18n="settings.changeNickname">Cambia Nickname</label>
			<input type="text" id="usernameInput" data-i18n-placeholder="settings.newNicknamePlaceholder" placeholder="Nuovo nickname">
			<button class="action-btn" onclick="updateProfile()" data-i18n="settings.updateName">Aggiorna Nome</button>
		</div>
	</div>
```

(Nota: gli `onclick=` inline qui seguono lo stile del resto di `#profileCard` esistente — coerenza col file. La logica nuova non-triviale sta nelle funzioni JS.)

- [ ] **Step 2: JS — `applyGuestModeUI()`: `profileCard` sempre visibile**

In `app.js`, `applyGuestModeUI()` (~riga 794), sostituire:

```javascript
		setVisible('profileCard', !isGuestMode);
```

con:

```javascript
		setVisible('profileCard', true);                 // sempre visibile: i guest ci scelgono un preset
		setVisible('profileIdentityBlock', !isGuestMode); // email + nickname solo per account registrati
```

- [ ] **Step 3: JS — sezione AVATAR parte 2 (UI settings)**

Appendere alla sezione `// ========== AVATAR ==========` di `app.js`:

```javascript
// --- stato/preferenza avatar guest (solo preset) ---
const GUEST_AVATAR_KEY = 'jt_guest_avatar';
function getGuestAvatar() {
	try {
		const v = localStorage.getItem(GUEST_AVATAR_KEY);
		return v && v.startsWith('preset:') ? v : null;
	} catch (e) { return null; }
}
function setGuestAvatar(val) { try { localStorage.setItem(GUEST_AVATAR_KEY, val); } catch (e) {} }
function clearGuestAvatar() { try { localStorage.removeItem(GUEST_AVATAR_KEY); } catch (e) {} }

function currentAvatarValue() {
	return isGuestMode ? getGuestAvatar() : (currentUserProfile && currentUserProfile.avatar_url) || null;
}

let avatarMode = 'upload'; // 'upload' | 'preset'
function setAvatarMode(mode) {
	avatarMode = mode;
	document.getElementById('avatarModeUpload').classList.toggle('active', mode === 'upload');
	document.getElementById('avatarModePreset').classList.toggle('active', mode === 'preset');
	document.getElementById('avatarUploadPane').style.display = mode === 'upload' ? '' : 'none';
	document.getElementById('avatarPresetPane').style.display = mode === 'preset' ? '' : 'none';
	clearAvatarError();
}

function clearAvatarError() {
	const el = document.getElementById('avatarError');
	if (el) { el.style.display = 'none'; el.textContent = ''; }
}
function showAvatarError(msg) {
	const el = document.getElementById('avatarError');
	if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function renderAvatarSettings() {
	const preview = document.getElementById('avatarPreview');
	if (!preview) return;
	const val = currentAvatarValue();
	const name = (currentUserProfile && currentUserProfile.username) || (currentUser && currentUser.email) || '?';
	preview.innerHTML = avatarMarkup(val, name, 72);

	document.getElementById('avatarRemoveBtn').style.display = val ? '' : 'none';

	// guest: niente upload
	const guest = isGuestMode;
	document.getElementById('avatarGuestHint').style.display = guest ? 'block' : 'none';
	document.getElementById('avatarChooseBtn').style.display = guest ? 'none' : '';

	// griglia preset
	const grid = document.getElementById('avatarPresetGrid');
	grid.innerHTML = PRESET_KEYS.map(key => {
		const selected = val === `preset:${key}`;
		return `<button type="button" class="avatar-preset-cell${selected ? ' is-selected' : ''}" `
			+ `data-preset-key="${key}" onclick="selectPresetAvatar('${key}')" aria-pressed="${selected}">`
			+ `${PRESET_AVATARS[key]}</button>`;
	}).join('');
}

async function selectPresetAvatar(key) {
	if (!PRESET_KEYS.includes(key)) return;
	clearAvatarError();
	const value = `preset:${key}`;

	if (isGuestMode) {
		setGuestAvatar(value);
		renderAvatarSettings();
		return;
	}

	try {
		await removeUploadedAvatarFiles(); // best-effort: se c'era una foto, non lasciarla orfana
		const { error } = await supabaseClient.from('profiles').upsert({ id: currentUser.id, avatar_url: value });
		if (error) throw error;
		currentUserProfile = { ...(currentUserProfile || {}), avatar_url: value };
		renderAvatarSettings();
		refreshMountedAvatars();
		showMessage(t('settings.avatarUpdated'));
	} catch (e) {
		console.error('selectPresetAvatar:', e);
		showAvatarError(t('settings.avatarUploadError'));
	}
}

async function removeAvatar() {
	clearAvatarError();
	if (isGuestMode) {
		clearGuestAvatar();
		renderAvatarSettings();
		return;
	}
	try {
		await removeUploadedAvatarFiles();
		const { error } = await supabaseClient.from('profiles').upsert({ id: currentUser.id, avatar_url: null });
		if (error) throw error;
		currentUserProfile = { ...(currentUserProfile || {}), avatar_url: null };
		renderAvatarSettings();
		refreshMountedAvatars();
		showMessage(t('settings.avatarRemoved'));
	} catch (e) {
		console.error('removeAvatar:', e);
		showAvatarError(t('settings.avatarUploadError'));
	}
}

// Ridisegna le superfici avatar attualmente montate nel DOM dopo un cambio.
// Le pagine non montate si aggiornano al loro prossimo load.
function refreshMountedAvatars() {
	if (document.getElementById('page-social')?.classList.contains('active')) {
		if (typeof loadSocial === 'function') loadSocial();
	}
	if (document.getElementById('snapshotFeed')?.children.length) {
		if (typeof loadFeed === 'function') loadFeed();
	}
}
```

- [ ] **Step 4: JS — `loadUserProfile()` popola `currentUserProfile` e la UI**

In `app.js`, `loadUserProfile()` (~riga 3524). Sostituire il corpo con:

```javascript
	async function loadUserProfile() {
		const emailEl = document.getElementById('settingsEmailDisplay');
		if (emailEl) emailEl.textContent = currentUser.email;

		const { data, error } = await supabaseClient
			.from('profiles')
			.select('username, avatar_url')
			.eq('id', currentUser.id)
			.single();

		if (!error && data) {
			currentUserProfile = { username: data.username || null, avatar_url: data.avatar_url || null };
			if (data.username) {
				document.getElementById('currentUsernameDisplay').innerText = data.username;
				document.getElementById('usernameInput').value = data.username;
			}
		}
		renderAvatarSettings();
	}
```

- [ ] **Step 5: JS — render avatar settings anche per i guest**

In `app.js`, dentro `showApp()` blocco `if (isGuestMode) { … }` (~riga 615), aggiungere in fondo al blocco:

```javascript
		renderAvatarSettings();
```

(Per gli utenti registrati ci pensa `loadUserProfile()`.)

- [ ] **Step 6: CSS — layout sezione avatar settings**

Appendere alla sezione `/* ========== AVATAR ========== */` di `style.css`:

```css
.avatar-settings { margin: 4px 0 16px; }
.avatar-settings-row { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.avatar-remove-btn { margin-top: 0; width: auto; padding: 6px 14px; font-size: 13px; }
.avatar-mode-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.avatar-mode-tab {
	flex: 1; padding: 8px 10px; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600;
	border: 1px solid rgba(var(--overlay-rgb), 0.14); background: transparent; color: var(--color-text-secondary);
}
.avatar-mode-tab.active { background: rgba(76, 175, 80, 0.14); border-color: rgba(76, 175, 80, 0.4); color: var(--heading); }
.avatar-pane { margin-top: 4px; }
.avatar-preset-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.avatar-preset-cell {
	aspect-ratio: 1; min-height: 44px; border-radius: 12px; cursor: pointer; font-size: 22px;
	border: 1px solid rgba(var(--overlay-rgb), 0.12); background: rgba(var(--overlay-rgb), 0.04);
	display: flex; align-items: center; justify-content: center;
}
.avatar-preset-cell.is-selected { border-color: var(--primary); background: rgba(76, 175, 80, 0.16); }
.avatar-error { color: var(--danger); font-size: 13px; margin: 8px 0 0; }
```

- [ ] **Step 7: Verifica — preset picker come guest (browser pane)**

`npx serve .`, Browser pane su `http://localhost:3000/app/`, cliccare "🚀 Prova senza registrarti", andare in ⚙️ Impostazioni:

1. La card "👤 Profilo" è visibile; email/nickname **non** ci sono; c'è "Immagine del profilo".
2. Preview mostra l'iniziale colorata (fallback).
3. "Carica foto" mostra l'hint "Crea un account…", nessun bottone "Scegli immagine".
4. Tab "Scegli icona" → griglia 4×2 di emoji.
5. Tap su 🍃 → cella selezionata (bordo), preview diventa 🍃 su cerchio verde, appare "Rimuovi".
6. Reload pagina → il preset 🍃 persiste (letto da `localStorage jt_guest_avatar`).
7. Console: `localStorage.getItem('jt_guest_avatar')` → `"preset:leaf"`.
8. "Rimuovi" → torna all'iniziale, `jt_guest_avatar` rimosso.
9. Toggle tema scuro → preview e celle leggibili.

- [ ] **Step 8: Commit**

```bash
git add app/index.html app.js style.css
git commit -m "feat: avatar section in profile settings + preset picker (guest + registered)"
```

---

## Task 5: Crop modal — pan/zoom + export 256×256

**Files:**
- Modify: `app/index.html` — nuovo `#avatarCropModal` dopo `#friendModal` (~riga 631).
- Modify: `app.js` — sezione AVATAR (parte 3: crop); `style.css` — crop modal.

**Interfaces:**
- Consumes: `t`, classi modal esistenti (`.modal`, `.modal-content`, `.card`).
- Produces:
  - `handleAvatarFileSelected(event) -> void` — validazione + apertura crop
  - `openAvatarCrop(img, objectUrl) -> void`
  - `closeAvatarCrop() -> void`
  - `exportCroppedAvatar() -> Promise<{ blob: Blob, ext: 'webp'|'jpg' }>`
  - `confirmAvatarCrop() -> Promise<void>` — `exportCroppedAvatar()` → `uploadAvatarBlob()`
  - `setAvatarPreviewLoading(on) -> void`
  - stato modulo `avatarCrop = { objectUrl, natW, natH, V, scale, minScale, tx, ty, pointers: Map, pinchStartDist, pinchStartScale }`

> **Dipendenza:** `confirmAvatarCrop()` chiama `uploadAvatarBlob()`, definita in **Task 6**. Fino a Task 6 un upload reale fallisce con errore inline nel modal (atteso, gestito dal try/catch) — la verifica di questo task copre solo il flusso guest/preset e la **geometria del crop**, non un upload andato a buon fine.

- [ ] **Step 1: HTML — `#avatarCropModal`**

In `app/index.html`, dopo la chiusura di `#friendModal` (~riga 631), aggiungere:

```html
<!-- MODAL RITAGLIO AVATAR -->
<div id="avatarCropModal" class="modal" style="display:none;">
	<div class="modal-content card">
		<h3 data-i18n="settings.avatarCropTitle">Ritaglia l'avatar</h3>
		<div class="avatar-crop-viewport" id="avatarCropViewport">
			<img class="avatar-crop-img" id="avatarCropImg" alt="" draggable="false">
		</div>
		<label class="avatar-crop-zoom-label" data-i18n="settings.avatarCropZoom">Zoom</label>
		<input type="range" id="avatarCropZoom" class="avatar-crop-zoom" min="1" max="4" step="0.01" value="1">
		<p id="avatarCropError" class="avatar-error" style="display:none;"></p>
		<div class="avatar-crop-actions">
			<button type="button" class="secondary-btn" onclick="closeAvatarCrop()" data-i18n="settings.avatarCropCancel">Annulla</button>
			<button type="button" class="action-btn" id="avatarCropConfirmBtn" onclick="confirmAvatarCrop()" data-i18n="settings.avatarCropConfirm">Conferma</button>
		</div>
	</div>
</div>
```

- [ ] **Step 2: JS — sezione AVATAR parte 3 (crop): file select + geometria**

Appendere alla sezione `// ========== AVATAR ==========`:

```javascript
// --- crop interattivo (pan + zoom), vanilla ---
const AVATAR_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const AVATAR_OUT_SIZE = 256;

let avatarCrop = null;

function handleAvatarFileSelected(event) {
	const input = event.target;
	const file = input.files && input.files[0];
	if (!file) return;
	clearAvatarError();

	if (!AVATAR_ACCEPTED_TYPES.includes(file.type)) {
		showAvatarError(t('settings.avatarFormatError'));
		input.value = '';
		return;
	}
	if (file.size > AVATAR_MAX_BYTES) {
		showAvatarError(t('settings.avatarTooLarge'));
		input.value = '';
		return;
	}

	const url = URL.createObjectURL(file);
	const img = new Image();
	img.onload = () => { openAvatarCrop(img, url); };
	img.onerror = () => {
		URL.revokeObjectURL(url);
		showAvatarError(t('settings.avatarFormatError'));
		input.value = '';
	};
	img.src = url;
}

function openAvatarCrop(img, objectUrl) {
	const viewport = document.getElementById('avatarCropViewport');
	const imgEl = document.getElementById('avatarCropImg');
	const V = viewport.clientWidth; // viewport quadrato: clientWidth === clientHeight (CSS)

	const natW = img.naturalWidth;
	const natH = img.naturalHeight;
	const minScale = V / Math.min(natW, natH);

	imgEl.src = objectUrl;
	imgEl.style.width = natW + 'px';
	imgEl.style.height = natH + 'px';

	avatarCrop = {
		objectUrl, natW, natH, V,
		minScale, scale: minScale,
		tx: (V - natW * minScale) / 2,
		ty: (V - natH * minScale) / 2,
		pointers: new Map(),
		pinchStartDist: 0, pinchStartScale: 0,
	};
	clampAvatarCrop();
	applyAvatarCropTransform();

	const zoom = document.getElementById('avatarCropZoom');
	zoom.min = '1'; zoom.max = '4'; zoom.value = '1';

	document.getElementById('avatarCropError').style.display = 'none';
	document.getElementById('avatarCropConfirmBtn').disabled = false;
	document.getElementById('avatarCropModal').style.display = 'flex';
}

function closeAvatarCrop() {
	if (avatarCrop && avatarCrop.objectUrl) URL.revokeObjectURL(avatarCrop.objectUrl);
	avatarCrop = null;
	document.getElementById('avatarCropModal').style.display = 'none';
	const input = document.getElementById('avatarFileInput');
	if (input) input.value = '';
}

// Vincola scale >= minScale e tx/ty in modo che l'immagine copra sempre il viewport.
function clampAvatarCrop() {
	const c = avatarCrop;
	if (c.scale < c.minScale) c.scale = c.minScale;
	const dispW = c.natW * c.scale;
	const dispH = c.natH * c.scale;
	c.tx = Math.min(0, Math.max(c.V - dispW, c.tx));
	c.ty = Math.min(0, Math.max(c.V - dispH, c.ty));
}

function applyAvatarCropTransform() {
	const c = avatarCrop;
	const imgEl = document.getElementById('avatarCropImg');
	imgEl.style.transform = `translate(${c.tx}px, ${c.ty}px) scale(${c.scale})`;
	// sync slider (scale relativo a minScale, range 1..4)
	const zoom = document.getElementById('avatarCropZoom');
	const rel = c.scale / c.minScale;
	if (Math.abs(parseFloat(zoom.value) - rel) > 0.01) zoom.value = String(Math.min(4, Math.max(1, rel)));
}

// Zoom mantenendo ancorato il punto immagine sotto (px, py) in coord viewport.
function zoomAvatarCropAround(newScale, px, py) {
	const c = avatarCrop;
	newScale = Math.min(c.minScale * 4, Math.max(c.minScale, newScale));
	const ix = (px - c.tx) / c.scale;
	const iy = (py - c.ty) / c.scale;
	c.scale = newScale;
	c.tx = px - ix * newScale;
	c.ty = py - iy * newScale;
	clampAvatarCrop();
	applyAvatarCropTransform();
}
```

- [ ] **Step 3: JS — gestione pointer (drag + pinch) + slider**

Appendere:

```javascript
function initAvatarCropInteractions() {
	const viewport = document.getElementById('avatarCropViewport');
	if (!viewport || viewport.dataset.wired) return;
	viewport.dataset.wired = '1';

	viewport.addEventListener('pointerdown', e => {
		if (!avatarCrop) return;
		viewport.setPointerCapture(e.pointerId);
		avatarCrop.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (avatarCrop.pointers.size === 2) {
			const pts = [...avatarCrop.pointers.values()];
			avatarCrop.pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
			avatarCrop.pinchStartScale = avatarCrop.scale;
		}
	});

	viewport.addEventListener('pointermove', e => {
		if (!avatarCrop || !avatarCrop.pointers.has(e.pointerId)) return;
		const prev = avatarCrop.pointers.get(e.pointerId);
		const cur = { x: e.clientX, y: e.clientY };
		avatarCrop.pointers.set(e.pointerId, cur);

		if (avatarCrop.pointers.size === 1) {
			avatarCrop.tx += cur.x - prev.x;
			avatarCrop.ty += cur.y - prev.y;
			clampAvatarCrop();
			applyAvatarCropTransform();
		} else if (avatarCrop.pointers.size === 2) {
			const pts = [...avatarCrop.pointers.values()];
			const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
			if (avatarCrop.pinchStartDist > 0) {
				const rect = document.getElementById('avatarCropViewport').getBoundingClientRect();
				const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
				const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
				zoomAvatarCropAround(avatarCrop.pinchStartScale * (dist / avatarCrop.pinchStartDist), midX, midY);
			}
		}
	});

	const endPointer = e => {
		if (!avatarCrop) return;
		avatarCrop.pointers.delete(e.pointerId);
		if (avatarCrop.pointers.size < 2) avatarCrop.pinchStartDist = 0;
	};
	viewport.addEventListener('pointerup', endPointer);
	viewport.addEventListener('pointercancel', endPointer);

	document.getElementById('avatarCropZoom').addEventListener('input', e => {
		if (!avatarCrop) return;
		const rel = parseFloat(e.target.value) || 1;
		const c = avatarCrop;
		zoomAvatarCropAround(c.minScale * rel, c.V / 2, c.V / 2);
	});
}
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initAvatarCropInteractions);
} else {
	initAvatarCropInteractions();
}
```

(`app.js` è tutto top-level, nessun IIFE; c'è già un handler `document.addEventListener('DOMContentLoaded', function() { … })` ~riga 5438 e chiamate top-level in fondo al file. La guard `readyState` sopra funziona in entrambi i casi; in alternativa aggiungere `initAvatarCropInteractions();` dentro l'handler esistente ~riga 5438.)

- [ ] **Step 4: JS — export + confirm**

Appendere:

```javascript
async function exportCroppedAvatar() {
	const c = avatarCrop;
	const img = document.getElementById('avatarCropImg');
	// regione visibile in coordinate immagine-naturali
	const sSize = c.V / c.scale;
	const sx = -c.tx / c.scale;
	const sy = -c.ty / c.scale;

	const canvas = document.createElement('canvas');
	canvas.width = AVATAR_OUT_SIZE;
	canvas.height = AVATAR_OUT_SIZE;
	const ctx = canvas.getContext('2d');
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, AVATAR_OUT_SIZE, AVATAR_OUT_SIZE);

	const toBlob = (type, q) => new Promise(res => canvas.toBlob(res, type, q));
	let blob = await toBlob('image/webp', 0.85);
	let ext = 'webp';
	if (!blob) { blob = await toBlob('image/jpeg', 0.85); ext = 'jpg'; }
	if (!blob) throw new Error('toBlob returned null');
	return { blob, ext };
}

async function confirmAvatarCrop() {
	const btn = document.getElementById('avatarCropConfirmBtn');
	const errEl = document.getElementById('avatarCropError');
	errEl.style.display = 'none';
	btn.disabled = true;
	const previous = currentAvatarValue();
	setAvatarPreviewLoading(true);
	try {
		const out = await exportCroppedAvatar();
		await uploadAvatarBlob(out); // Task 6
		closeAvatarCrop();
		showMessage(t('settings.avatarUpdated'));
	} catch (e) {
		console.error('confirmAvatarCrop:', e);
		errEl.textContent = t('settings.avatarUploadError');
		errEl.style.display = 'block';
		btn.disabled = false;
	} finally {
		setAvatarPreviewLoading(false);
		renderAvatarSettings(); // ripristina preview (previous invariato in caso d'errore)
		void previous;
	}
}

function setAvatarPreviewLoading(on) {
	const preview = document.getElementById('avatarPreview');
	if (preview) preview.classList.toggle('avatar-loading', !!on);
}
```

- [ ] **Step 5: CSS — crop modal + loading**

Appendere alla sezione `/* ========== AVATAR ========== */`:

```css
.avatar-loading { opacity: 0.45; position: relative; }
.avatar-crop-viewport {
	position: relative; width: min(280px, 78vw); height: min(280px, 78vw);
	margin: 8px auto 12px; overflow: hidden; border-radius: 50%;
	background: rgba(var(--overlay-rgb), 0.08); touch-action: none; cursor: grab;
}
.avatar-crop-img {
	position: absolute; top: 0; left: 0; transform-origin: 0 0;
	will-change: transform; user-select: none; -webkit-user-drag: none; max-width: none;
}
.avatar-crop-zoom-label { display: block; font-size: 12px; color: var(--color-text-muted); margin-bottom: 4px; }
.avatar-crop-zoom { width: 100%; margin-bottom: 12px; }
.avatar-crop-actions { display: flex; gap: 10px; }
.avatar-crop-actions button { flex: 1; margin-top: 0; }
```

- [ ] **Step 6: Verifica — crop come guest (browser pane)**

> Il crop modal è puro client-side: per verificarlo senza login, **temporaneamente** in console rendere visibile il bottone anche ai guest, oppure usare `document.getElementById('avatarFileInput').click()` direttamente. NON committare modifiche di test.

`npx serve .`, guest, ⚙️ Impostazioni, console:
```js
document.getElementById('avatarChooseBtn').style.display = '';
```
Poi "Scegli immagine" → scegliere un JPG orizzontale (es. 3000×2000):
1. Modal si apre, immagine centrata, copre il cerchio, nessun bordo vuoto.
2. Drag → l'immagine si sposta, si ferma ai bordi (mai gap).
3. Slider zoom → ingrandisce attorno al centro; drag ancora vincolato.
4. Su desktop con trackpad/emulazione touch: pinch (se disponibile).
5. "Conferma" → (upload fallirà come guest / senza `uploadAvatarBlob` se Task 6 non c'è ancora — atteso errore inline nel modal, non crash). Con Task 6 presente e login: upload reale (verifica Matteo).
6. Provare un file `.gif` → errore "Formato non supportato", modal non si apre.
7. Provare un file > 10MB → errore "troppo grande".

Verifica geometria dell'export in console (dopo aver aperto il crop):
```js
// simula: exportCroppedAvatar deve produrre un blob quadrato ~256px
exportCroppedAvatar().then(o => { console.log(o.ext, o.blob.size); const i=new Image(); i.onload=()=>console.log(i.width,i.height); i.src=URL.createObjectURL(o.blob); });
// atteso: 256 256, size tra ~8KB e ~60KB
```

- [ ] **Step 7: Commit**

```bash
git add app/index.html app.js style.css
git commit -m "feat: interactive pan/zoom avatar crop modal + 256px webp export"
```

---

## Task 6: Upload pipeline — `uploadAvatarBlob` + cleanup

Completa il wiring di `confirmAvatarCrop()` (Task 5): dopo questo task l'upload reale funziona end-to-end.

**Files:**
- Modify: `app.js` — sezione AVATAR (parte 4: upload).

**Interfaces:**
- Consumes: `currentUser`, `supabaseClient`, `currentUserProfile`, `renderAvatarSettings`, `refreshMountedAvatars`, `t`.
- Produces:
  - `removeUploadedAvatarFiles() -> Promise<void>` — best-effort, cancella `{uid}/avatar.webp` e `{uid}/avatar.jpg`
  - `uploadAvatarBlob({ blob, ext }) -> Promise<void>` — throw su errore Storage/DB

- [ ] **Step 1: JS — sezione AVATAR parte 4**

Appendere alla sezione `// ========== AVATAR ==========`:

```javascript
// --- upload / cleanup Storage ---
const AVATARS_BUCKET = 'avatars';

async function removeUploadedAvatarFiles() {
	if (isGuestMode || !currentUser) return;
	try {
		await supabaseClient.storage.from(AVATARS_BUCKET).remove([
			`${currentUser.id}/avatar.webp`,
			`${currentUser.id}/avatar.jpg`,
		]);
	} catch (e) { /* best-effort: il file può non esistere */ }
}

async function uploadAvatarBlob({ blob, ext }) {
	if (isGuestMode || !currentUser) throw new Error('upload avatar non disponibile in guest');
	const path = `${currentUser.id}/avatar.${ext}`;
	const contentType = ext === 'webp' ? 'image/webp' : 'image/jpeg';

	// nome file può cambiare estensione tra upload -> togli entrambi prima
	await removeUploadedAvatarFiles();

	const up = await supabaseClient.storage.from(AVATARS_BUCKET)
		.upload(path, blob, { upsert: true, contentType });
	if (up.error) throw up.error;

	const pub = supabaseClient.storage.from(AVATARS_BUCKET).getPublicUrl(path);
	const publicUrl = `${pub.data.publicUrl}?v=${Date.now()}`;

	const { error } = await supabaseClient.from('profiles').upsert({ id: currentUser.id, avatar_url: publicUrl });
	if (error) throw error;

	currentUserProfile = { ...(currentUserProfile || {}), avatar_url: publicUrl };
	renderAvatarSettings();
	refreshMountedAvatars();
}
```

- [ ] **Step 2: Verifica — funzioni definite, nessun errore di sintassi**

```bash
node -e "require('fs').readFileSync('app.js','utf8'); new Function(require('fs').readFileSync('app.js','utf8')); console.log('parse ok');"
```
Atteso: `parse ok` (il `new Function` fa solo il parse — le API browser non vengono eseguite).

Browser pane (guest), console:
```js
typeof uploadAvatarBlob === 'function' && typeof removeUploadedAvatarFiles === 'function'
// atteso: true
uploadAvatarBlob({ blob: new Blob(['x']), ext: 'webp' }).catch(e => console.log('atteso throw:', e.message))
// atteso: throw "upload avatar non disponibile in guest"
```

Upload reale end-to-end: **Matteo** con `claude_test` — carica una foto, verifica:
- appare subito in card Profilo;
- Storage `avatars/e0346ed5-.../avatar.webp` esiste, ~15–40KB;
- `select avatar_url from profiles where id = 'e0346ed5-...'` → URL con `?v=`;
- ricaricare e ri-caricare un'altra foto → un solo file, `?v=` cambiato.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: avatar upload to storage + old-file cleanup + profiles.avatar_url write"
```

---

## Task 7: Guest → account — migrazione avatar

**Files:**
- Modify: `app.js` — sezione AVATAR (`migrateGuestAvatar`); `checkAuth()` (~riga 382); blocco post-signup (~riga 591).

**Interfaces:**
- Consumes: `getGuestAvatar`, `clearGuestAvatar`, `supabaseClient`.
- Produces: `migrateGuestAvatar(userId) -> Promise<void>` — se `jt_guest_avatar` presente, `profiles.upsert({ id, avatar_url })`, poi rimuove la chiave. Idempotente, non-throw (logga e basta).

- [ ] **Step 1: JS — `migrateGuestAvatar`**

Appendere alla sezione `// ========== AVATAR ==========`:

```javascript
// Chiamata a ogni ingresso in un account (login/signup), indipendentemente dal
// fatto che ci fossero smokes/purchases guest da migrare (migrateGuestDataToAccount
// esce presto se non ci sono dati). Un guest può aver scelto solo un preset.
async function migrateGuestAvatar(userId) {
	const val = getGuestAvatar();
	if (!val) return;
	try {
		const { error } = await supabaseClient.from('profiles').upsert({ id: userId, avatar_url: val });
		if (error) throw error;
		clearGuestAvatar();
		if (currentUserProfile) currentUserProfile.avatar_url = val;
	} catch (e) {
		console.error('migrateGuestAvatar:', e); // i dati guest restano, si riprova al prossimo login
	}
}
```

- [ ] **Step 2: JS — chiamare da `checkAuth()`**

In `app.js` (~riga 381-384), dentro `if (session) { … }`, dopo il blocco `if (hadGuestData) { await migrateGuestDataToAccount(...); }`:

```javascript
			await migrateGuestAvatar(currentUser.id);
```

- [ ] **Step 3: JS — chiamare dal blocco post-signup**

In `app.js` (~riga 591-593), dopo `if (wasGuestWithData) { await migrateGuestDataToAccount(currentUser.id); }`:

```javascript
			await migrateGuestAvatar(currentUser.id);
```

- [ ] **Step 4: JS — pulizia chiave nella migrazione dati esistente**

In `migrateGuestDataToAccount()` (~riga 890-894), nel blocco che rimuove le chiavi guest, **non** serve toccare `jt_guest_avatar` (lo gestisce `migrateGuestAvatar`). Lasciare invariato. (Step di conferma esplicita: nessuna modifica qui.)

- [ ] **Step 5: Verifica**

`node -e` parse check (come Task 6 Step 2).

Flusso completo — **Matteo**:
1. Guest, sceglie preset ✨ (`jt_guest_avatar = "preset:sparkle"`), nessuna sessione registrata.
2. Registrazione nuovo account / login.
3. Dopo l'ingresso: card Profilo mostra ✨; `select avatar_url from profiles where id=<nuovo>` → `preset:sparkle`; `localStorage.getItem('jt_guest_avatar')` → `null`.

SQL sanity (MCP): nessuno — è tutto client + upsert su `profiles` già coperto da RLS.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: migrate guest preset avatar into profile on login/signup"
```

---

## Task 8: Superfici — leaderboard ×3 + modal amico

**Files:**
- Modify: `app.js` — `fetchAvatarMap` (sezione AVATAR); `loadSocial()` (~riga 3286); `loadSharedLeaderboard()` (~riga 3363); `viewFriendStats()` (~riga 3465).
- Modify: `app/index.html` — `#friendModal` header (~riga 620); `style.css` — riga leaderboard.

**Interfaces:**
- Consumes: `avatarMarkup`, `supabaseClient`, `currentUserProfile`.
- Produces: `fetchAvatarMap(ids) -> Promise<Map<string, string|null>>` — batch `profiles_public.select('id,avatar_url').in('id', ids)`.

- [ ] **Step 1: JS — `fetchAvatarMap`**

Appendere alla sezione `// ========== AVATAR ==========`:

```javascript
// Batch: id utente -> avatar_url (grezzo da profiles_public). Una query per render.
async function fetchAvatarMap(ids) {
	const uniq = [...new Set((ids || []).filter(Boolean))];
	const map = new Map();
	if (uniq.length === 0) return map;
	const { data, error } = await supabaseClient
		.from('profiles_public')
		.select('id, avatar_url')
		.in('id', uniq);
	if (error) { console.error('fetchAvatarMap:', error); return map; }
	(data || []).forEach(r => map.set(r.id, r.avatar_url || null));
	return map;
}
```

- [ ] **Step 2: JS — `loadSocial()` (tab Mondiale + Amici)**

In `app.js`, `loadSocial()` (~riga 3329-3355). Dopo che `data` è validato e prima del `list.innerHTML = data.map(...)`, aggiungere il fetch degli avatar:

```javascript
			const avatarMap = await fetchAvatarMap(data.map(u => u.user_id));
```

Poi, dentro il `.map((u, i) => { … })`, modificare il markup della riga per inserire l'avatar. Sostituire il blocco `return \`<div class="lb-item" …>\`` con:

```javascript
				const av = avatarMarkup(
					u.user_id === currentUser.id ? (currentUserProfile && currentUserProfile.avatar_url) : avatarMap.get(u.user_id),
					u.username, 30);

				return `
					<div class="lb-item" onclick="viewFriendStats('${u.user_id}', '${escapeHtml(u.username)}')"
						 style="${isMe ? 'background: rgba(76, 175, 80, 0.1);' : ''}">
						<div style="display: flex; align-items: center; gap: 8px;">
							<span class="lb-rank ${rankClass}">${rankStr}</span>
							${av}
							<span style="font-weight: ${isMe ? 'bold' : '500'};">
								${escapeHtml(u.username)} ${isMe ? t('social.youSuffix') : ''}
								${sharedBadge}
							</span>
						</div>
						<div style="text-align: right;">
							<span style="font-weight: bold; color: var(--primary);">${Number(u.total_g).toFixed(1)}g</span><br>
							<small style="color: var(--color-text-muted);">${u.total_j} ${t('stats.jointUnit')}</small>
						</div>
					</div>
				`;
```

(Nota: qui si aggiunge anche `escapeHtml(u.username)` nell'`onclick` e nel testo — oggi manca; è una regola del progetto e la riga viene comunque riscritta.)

- [ ] **Step 3: JS — `loadSharedLeaderboard()` (tab Insieme)**

In `app.js`, `loadSharedLeaderboard()` (~riga 3363+). Leggere il corpo attuale della funzione, individuare il `.map(...)` che rende le righe (chiave `u.friend_id`). Prima del `.map`, aggiungere:

```javascript
			const avatarMap = await fetchAvatarMap(data.map(u => u.friend_id));
```

Nel markup della riga, inserire `${avatarMarkup(avatarMap.get(u.friend_id), u.username, 30)}` subito dopo lo `<span class="lb-rank …">`, dentro il contenitore flex (aggiungere `gap:8px` al flex come nello Step 2). Mantenere `escapeHtml(u.username)` ovunque il nome sia iniettato.

- [ ] **Step 4: JS — `viewFriendStats()` (modal amico)**

In `app.js`, `viewFriendStats(targetId, username)` (~riga 3465). Dopo `document.getElementById('modalFriendName').innerText = …` (o dove si imposta il titolo), aggiungere:

```javascript
		const { data: prof } = await supabaseClient
			.from('profiles_public').select('avatar_url').eq('id', targetId).maybeSingle();
		const avEl = document.getElementById('modalFriendAvatar');
		if (avEl) avEl.innerHTML = avatarMarkup(prof && prof.avatar_url, username, 40);
```

- [ ] **Step 5: HTML — slot avatar nel modal amico**

In `app/index.html`, `#friendModal` (~riga 622). Sostituire:

```html
		<h3 id="modalFriendName" data-i18n="social.stats">Statistiche</h3>
```

con:

```html
		<div style="display:flex; align-items:center; gap:10px;">
			<span id="modalFriendAvatar"></span>
			<h3 id="modalFriendName" data-i18n="social.stats" style="margin:0;">Statistiche</h3>
		</div>
```

- [ ] **Step 6: CSS — riga leaderboard**

In `style.css`, cercare `.lb-item` e assicurare che il contenitore del nome sia `display:flex; align-items:center; gap:8px`. Se `.lb-rank` ha un `margin-right` fisso, ridurlo/rimuoverlo (ora c'è `gap`). Aggiungere se serve:

```css
.lb-item .avatar { flex: 0 0 auto; }
```

- [ ] **Step 7: Verifica**

`node -e` parse check.

SQL (MCP): `select id, avatar_url from profiles_public where avatar_url is not null limit 5;` — confermare che la view espone il campo.

**Matteo** (login): tab Mondiale/Amici/Insieme mostrano avatar (foto/preset/iniziale) accanto al rank; la propria riga usa il proprio avatar; tap su una riga → modal amico con avatar accanto al titolo. Tema scuro ok.

- [ ] **Step 8: Commit**

```bash
git add app.js app/index.html style.css
git commit -m "feat: avatars in leaderboard (3 tabs) + friend stats modal"
```

---

## Task 9: Superfici — sessioni condivise (quick-list, chip, contributori, ricerca)

**Files:**
- Modify: `app.js` — `getMyFriendsList()` (~riga 208), `renderFriendsQuickList()` (~riga 221), `quickAddParticipant()` (~riga 247), `searchParticipant()` (~riga 253), `renderParticipantChips()` (~riga 284), `renderContributorsPanel()` (~riga 293), commento globale `sessionParticipants` (~riga 16).
- Modify: `style.css` — `.participant-chip`.

**Interfaces:**
- `sessionParticipants` entries: `{ user_id, username, avatar_url }` (era `{ user_id, username }`).
- Consumes: `avatarMarkup`.

- [ ] **Step 1: JS — `getMyFriendsList()` seleziona `avatar_url`**

In `app.js` (~riga 210), cambiare:

```javascript
        .select('id, username')
```
in:
```javascript
        .select('id, username, avatar_url')
```

- [ ] **Step 2: JS — `renderFriendsQuickList()` mostra l'avatar**

In `app.js` (~riga 239-244), sostituire il template del bottone con:

```javascript
    el.innerHTML = friends.map(f => `
        <button type="button" onclick="quickAddParticipant('${f.id}','${escapeHtml(f.username)}','${escapeHtml(f.avatar_url || '')}')"
            class="friend-quick-btn">
            ${avatarMarkup(f.avatar_url, f.username, 22)}
            <span>+ ${escapeHtml(f.username)}</span>
        </button>
    `).join('');
```

(sostituisce lo stile inline con una classe `.friend-quick-btn` — vedi Step 7.)

- [ ] **Step 3: JS — `quickAddParticipant()` porta l'avatar**

In `app.js` (~riga 247-251):

```javascript
function quickAddParticipant(id, username, avatarUrl) {
    if (sessionParticipants.some(p => p.user_id === id)) return;
    sessionParticipants.push({ user_id: id, username, avatar_url: avatarUrl || null });
    renderParticipantChips();
}
```

- [ ] **Step 4: JS — `searchParticipant()` seleziona e usa `avatar_url`**

In `app.js` (~riga 259-261): `.select('id, username')` → `.select('id, username, avatar_url')`.
Nel punto in cui un risultato viene aggiunto a `sessionParticipants` (~riga 270-274), includere `avatar_url: match.avatar_url || null`.

- [ ] **Step 5: JS — `renderParticipantChips()` mostra l'avatar**

In `app.js` (~riga 287-289):

```javascript
    el.innerHTML = sessionParticipants.map(p => `
        <span class="participant-chip">${avatarMarkup(p.avatar_url, p.username, 18)} ${escapeHtml(p.username)} <button onclick="removeParticipant('${p.user_id}')">✕</button></span>
    `).join('');
```

- [ ] **Step 6: JS — `renderContributorsPanel()` mostra l'avatar accanto al nome**

In `app.js`, `renderContributorsPanel()` (~riga 300): la riga `const all = [{ user_id: currentUser.id, username: t('shared.you') }, ...sessionParticipants];` diventa:

```javascript
    const all = [{ user_id: currentUser.id, username: t('shared.you'), avatar_url: (currentUserProfile && currentUserProfile.avatar_url) || null }, ...sessionParticipants];
```

Nei due `all.map(p => …)` (blocchi `hasFumo` ~riga 323 e `hasErba` ~riga 344), dentro la `<label>` prima di `${p.username}` inserire:

```javascript
                    ${avatarMarkup(p.avatar_url, p.username, 18)}
```

(e passare `p.username` per `escapeHtml` se non già fatto: `${escapeHtml(p.username)}`).

- [ ] **Step 7: JS + comment — aggiornare l'annotazione di `sessionParticipants`**

In `app.js` riga 16:

```javascript
	let sessionParticipants = []; // { user_id, username, avatar_url }
```

- [ ] **Step 8: CSS**

Appendere a `style.css` (sezione AVATAR o vicino agli stili sessione):

```css
.friend-quick-btn {
	display: inline-flex; align-items: center; gap: 6px;
	background: rgba(76,175,80,0.12); border: 1px solid rgba(76,175,80,0.3);
	color: var(--heading); border-radius: 20px; padding: 5px 12px 5px 6px; font-size: 13px; cursor: pointer;
}
.participant-chip { display: inline-flex; align-items: center; gap: 6px; }
```

(Verificare che `.participant-chip` esistente non entri in conflitto — se ha già `display`, unire le regole.)

- [ ] **Step 9: Verifica**

`node -e` parse check.

**Matteo** (login, con almeno un amico accettato): pagina Aggiungi → sessione condivisa → la quick-list amici mostra gli avatar; aggiungendo un amico il chip mostra l'avatar; il pannello "chi ha portato cosa" mostra l'avatar accanto a ogni nome; la ricerca per nickname porta l'avatar nel chip.

- [ ] **Step 10: Commit**

```bash
git add app.js style.css
git commit -m "feat: avatars in shared-session friend list, chips, contributors, search"
```

---

## Task 10: Feed commenti + CLAUDE.md + backlog

**Files:**
- Modify: `app.js` — `renderComments()` (~riga 2504).
- Modify: `style.css` — `.feed-comment`.
- Modify: `CLAUDE.md` — backlog.

**Interfaces:**
- Consumes: `avatarMarkup`. La RPC `get_snapshot_comments` / `add_snapshot_comment` ritorna già `avatar_url` per riga.

- [ ] **Step 1: JS — mini-avatar per commento**

In `app.js`, `renderComments()` (~riga 2508-2514), sostituire il template della riga commento con:

```javascript
		const list = (it.comments || []).map(c => `
			<div class="feed-comment" data-comment-id="${c.id}">
				${avatarMarkup(c.avatar_url, c.username, 22)}
				<div class="feed-comment-main">
					<span class="feed-comment-name">${c.is_mine ? t('feed.you') : escapeHtml(c.username || '?')}</span>
					<span class="feed-comment-body">${escapeHtml(c.body)}</span>
					<span class="feed-comment-when">${formatNotifTime(c.created_at)}</span>
					${c.is_mine ? `<button type="button" class="feed-comment-del" data-action="delete-comment" data-index="${index}" data-comment-id="${c.id}" aria-label="${t('feed.deleteCommentConfirm')}">🗑</button>` : ''}
				</div>
			</div>`).join('');
```

- [ ] **Step 2: CSS — layout riga commento con avatar**

In `style.css`, `.feed-comment` (~riga 994) — assicurare:

```css
.feed-comment { display: flex; align-items: flex-start; gap: 8px; }
.feed-comment-main { flex: 1; min-width: 0; }
```

(mantenere le regole esistenti `.feed-comment-name`, `.feed-comment-body`, `.feed-comment-when`, `.feed-comment-del`).

- [ ] **Step 3: Verifica**

`node -e` parse check. **Matteo**: aprire i commenti di un'istantanea → ogni commento ha l'avatar dell'autore a sinistra; il proprio commento usa il proprio avatar.

- [ ] **Step 4: `CLAUDE.md` — backlog**

Nella sezione **"## Backlog / cose note da sistemare"**, aggiungere:

```markdown
- **Avatar utente (2026-08-30)**: `profiles.avatar_url` = URL pubblica del file in bucket `avatars` (`{uid}/avatar.{webp|jpg}?v=…`), oppure `preset:<key>` (8 preset), oppure `null`. Reso **solo** da `avatarMarkup()` in `app.js` — non fare `<img src=${…avatar_url}>` altrove. Leaderboard/modal amico prendono l'avatar con `fetchAvatarMap()` (join client su `profiles_public`), le RPC leaderboard non lo ritornano. Migration `20260830120000_add_avatars_bucket.sql` applicata a prod via MCP. Guest: solo preset in `localStorage jt_guest_avatar`, migrato da `migrateGuestAvatar()` al login. Spec/plan in `docs/superpowers/`.
- **Avatar — Image Transforms**: si serve un unico file 256×256 a ogni dimensione di render (piano Free, `SUPABASE_IMAGE_TRANSFORMS_ENABLED=false`). Se si passa a Pro, valutare un thumb 64px per leaderboard/commenti.
- **Avatar — moderazione**: nessun flusso per segnalare/rimuovere un avatar offensivo di un altro utente; l'unico rimedio è agire direttamente su Storage/`profiles` come owner.
```

- [ ] **Step 5: Commit**

```bash
git add app.js style.css CLAUDE.md
git commit -m "feat: avatars in feed comments; docs (CLAUDE.md avatar notes + backlog)"
```

---

## Self-review (fatto in fase di stesura)

**Spec coverage:**
- §1 upload+preset → Task 4 (preset), 5 (crop), 6 (upload).
- §3.1 formati `avatar_url` → Task 3 (`avatarMarkup`), 6 (`?v=`), 4 (`preset:`).
- §3.2 helper → Task 3.
- §3.3 8 preset → Task 3 (`PRESET_AVATARS`), Global Constraints.
- §3.4 `currentUserProfile` → Task 3 Step 1, Task 4 Step 4.
- §4.1 UI card → Task 4 Step 1.
- §4.2 validazione → Task 5 Step 2 (`handleAvatarFileSelected`).
- §4.3 crop pan/zoom → Task 5 Step 2-3.
- §4.4 export → Task 5 Step 4.
- §4.5 preset picker → Task 4 Step 3.
- §4.6 rimozione → Task 4 Step 3 (`removeAvatar`).
- §5.1 `uploadAvatarBlob` → Task 6.
- §5.2 superfici 1-8 → Task 3 (feed card #7), 4 (settings #1), 8 (leaderboard #2/3, modal #4), 9 (sessioni #5/6), 10 (commenti #8).
- §6.1 migration → Task 1.
- §6.2 verifiche pre-impl → Task 1 Step 1.
- §7 guest → Task 4 (localStorage), Task 7 (migrazione).
- §8 i18n → Task 2.
- §9 CSS → Task 3, 4, 5, 8, 9, 10 (per superficie).
- §10 error handling → Task 5 Step 4 (`confirmAvatarCrop`), Task 4 (`showAvatarError`), Task 3 (`avatarImgFallback`).
- §11 testing → ogni task ha Step di verifica.

**Placeholder scan:** nessun "TBD/TODO" operativo. Task 5 header nota l'inversione con Task 6 e la risolve (Task 6 "eseguire prima"). Task 3 Step 5 è volutamente no-op documentato (spiegato).

**Type consistency:**
- `avatarMarkup(avatarUrl, username, sizePx)` — firma identica in tutti i call site (Task 3, 4, 8, 9, 10).
- `sessionParticipants` entry `{ user_id, username, avatar_url }` — coerente tra Task 9 Step 1-7.
- `fetchAvatarMap(ids) -> Map` — Task 8 Step 1, usato in Step 2-3.
- `currentUserProfile` `{ username, avatar_url }` — Task 3, 4, 6, 7, 8, 9.
- `uploadAvatarBlob({ blob, ext })` — Task 6 produce, Task 5 Step 4 consuma con la stessa forma `{ blob, ext }` ritornata da `exportCroppedAvatar()`.
- `getGuestAvatar()/setGuestAvatar()/clearGuestAvatar()` — Task 4 definisce, Task 7 usa.

---

## Execution Handoff

*(Popolato dallo skill al termine.)*
