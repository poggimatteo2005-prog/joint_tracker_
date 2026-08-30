# JointTracker — Avatar utente (upload libero + preset) — Design

**Date:** 2026-08-30
**Status:** Draft — in attesa di review di Matteo. Piano: da generare dopo l'approvazione.
**Author:** Matteo + Claude

## 1. Goal

Dare **identità visiva** agli utenti ovunque compaia uno username: leaderboard
(3 tab), modal statistiche amico, card partecipanti delle sessioni condivise,
feed istantanee (foto + commenti), card Profilo in Impostazioni.

Due modalità per impostare il proprio avatar:

- **Upload libero**: scelta file (galleria/camera su mobile) → **crop quadrato
  interattivo** (pan + zoom) client-side → resize a 256×256 + compressione →
  upload su Supabase Storage.
- **Preset**: griglia di 8 emoji a tema, selezione con un tap. Nessun upload.

Fallback quando l'avatar non è impostato: **iniziale dello username** su sfondo
a colore deterministico (mai "immagine rotta").

### Fuori scope

- Avatar animati / GIF / video.
- Crop non quadrato, filtri, rotazione manuale, editing post-upload (si ricarica
  e si rifà il crop).
- Avatar nell'header dell'app: **oggi l'header non mostra username né nome**
  (`homeGreeting` è la stringa statica "Ciao 👋"), quindi non c'è una superficie
  "dove è già mostrato lo username" da agganciare lì. Se in futuro l'header o il
  saluto verranno personalizzati col nome, l'avatar si aggiunge in quel momento
  riusando `avatarMarkup()`.
- Moderazione / segnalazione di avatar offensivi (nessun flusso di reporting
  nell'app; il bucket è owner-write, quindi un avatar è rimovibile solo dal suo
  proprietario o via admin diretto su Storage).
- Image Transformations di Supabase per servire thumbnail di dimensioni diverse:
  il progetto è sul piano **Free** (`SUPABASE_IMAGE_TRANSFORMS_ENABLED = false`
  in `app.js`), quindi si serve un unico file 256×256 a tutte le dimensioni di
  render. È abbastanza piccolo da non essere un problema (~15–40 KB in WebP).
- Push notification o qualunque evento legato al cambio avatar.

## 2. Context / constraints scoperti

Ispezionato contro il repo `C:\Users\Matteo\code\joint_tracker_` e il progetto
Supabase live `afkxmbxcavwhurmdelfr` il 2026-08-30.

### 2.1 `profiles.avatar_url` esiste già ma non è mai scritto

Schema live `public.profiles`: `id uuid PK`, `username text`, **`avatar_url text`
nullable (nessun default, nessun vincolo)**, `reminder_enabled`, `reminder_time`,
`onboarding_completed`, `language`.

- RLS `profiles`: unica policy `"Gestione completa proprio profilo"` — `ALL` con
  `auth.uid() = id`. Scrivere `avatar_url` col proprio id è già permesso, come
  già fa `updateProfile()` per `username`.
- Nessuna UI oggi legge o scrive `avatar_url`. Nessun upload avatar esiste.

### 2.2 La view cross-utente `profiles_public` espone già `avatar_url`

`create view public.profiles_public as select id, username, avatar_url from
public.profiles;` con `security_invoker = false` (semantica security-definer:
bypassa la RLS di `profiles` per esporre `id/username/avatar_url` di **tutti** i
profili a qualsiasi utente loggato). `grant select ... to authenticated`.

- **Attenzione documentata** (CLAUDE.md, memoria progetto): in produzione questa
  view è già stata trovata silenziosamente flippata a `security_invoker = on`,
  rompendo ricerca amici / classifica senza errore visibile. Prima di
  implementare, **verificare la definizione live** via MCP Supabase
  (`pg_get_viewdef`, `reloptions`) e che `avatar_url` sia effettivamente
  selezionato. Nessuna modifica prevista a questa view da questo lavoro — se
  serve un fix di `security_invoker`, è un pre-requisito separato.

### 2.3 Il feed istantanee rende GIÀ `avatar_url` come URL grezzo

`feedCardHtml()` in `app.js` (~riga 2242):

```js
const avatar = it.avatar_url
    ? `<img class="feed-avatar" src="${escapeHtml(it.avatar_url)}" alt="" loading="lazy">`
    : `<span class="feed-avatar feed-avatar-fallback">${escapeHtml((it.username || '?').slice(0,1).toUpperCase())}</span>`;
```

Le RPC `get_snapshot_feed`, `get_snapshot_comments`, `add_snapshot_comment`
ritornano già `p.avatar_url` grezzo da `profiles`.

**Conseguenza vincolante**: se si introduce un sentinel `preset:<key>` in
`avatar_url`, questo markup lo passerebbe a `<img src="preset:leaf">` → immagine
rotta. Quindi **ogni** consumatore di `avatar_url` deve passare per un unico
resolver condiviso. Il feed viene rifattorizzato su quel resolver (netto
miglioramento: oggi non ha `onerror`).

I commenti del feed (`renderComments()`, ~riga 2504) oggi rendono **solo il
nome**, nessun avatar, pur avendo `c.avatar_url` disponibile dalla RPC.

### 2.4 Le RPC leaderboard / friend-stats NON ritornano avatar

`get_global_leaderboard()` → `(user_id, username, total_g, total_j)`
`get_friends_leaderboard(current_user_id)` → idem
`get_friends_shared_leaderboard(period)` → `(friend_id, username, ...)` — chiave
`friend_id`, non `user_id`
`get_friend_stats(target_user_id)` → `(fumo_g, erba_g)` — nemmeno lo username

Tutte `SECURITY DEFINER`. **Decisione (D1): non si toccano.** Gli avatar si
recuperano client-side con una singola query `profiles_public` (vedi §5.2).

### 2.5 Esiste già un helper di compressione immagine

`compressImage(file, maxDim, quality)` in `app.js` (~riga 1995): carica in
`Image`, ridimensiona con canvas mantenendo l'aspect ratio, `toBlob('image/jpeg',
quality)`. Su `img.onerror` (es. HEIC non decodificabile) ritorna il file
originale.

- **Non fa crop quadrato** e non gestisce la matematica di un transform pan/zoom.
  Il crop avatar ha bisogno di una propria funzione di export (§4.4). Il tail
  (`toBlob` + wrap in `File`/`Blob`) è concettualmente simile ma la geometria è
  diversa → funzione separata, non riuso forzato.
- L'orientamento EXIF è gestito implicitamente dal browser quando disegna un
  `HTMLImageElement` su canvas (comportamento di default moderno, `image-
  orientation: from-image`). Il path foto esistente si affida alla stessa cosa →
  coerente.

### 2.6 Storage: `session-photos` è privato, `avatars` sarà il primo bucket pubblico

`session-photos`: privato, accesso via `createSignedUrl` (TTL 3600s). Path
`<user_id>/<ts>.<ext>`. Upload con `{ upsert: true }`.

Non c'è CSP nell'app (`vercel.json` non definisce `Content-Security-Policy`),
quindi caricare `<img>` da `*.supabase.co/storage/v1/object/public/...` non è
bloccato.

### 2.7 Guest mode e migrazione

- `isGuestMode` (bool globale). Chiavi `localStorage`: `jt_guest_mode`,
  `jt_guest_smokes`, `jt_guest_purchases`, `jt_guest_achievements`,
  `jt_guest_best_streak`.
- Pattern preset già usato per gli achievement: salvati in
  `localStorage jt_guest_achievements`, migrati in
  `migrateGuestDataToAccount(userId)` (~riga 861), poi
  `localStorage.removeItem('jt_guest_achievements')`.
- `migrateGuestDataToAccount` è chiamata da due punti (signup post-conferma ~riga
  383, e conversione esplicita ~riga 592).
- I guest **non compaiono** in leaderboard, feed, sessioni condivise (tutte
  feature `!isGuestMode`). L'unico posto dove l'avatar di un guest si vede è la
  card Profilo in Impostazioni (e la propria riga "tu" nel feed, ma il feed è
  disabilitato in guest). Quindi per i guest serve solo: preset picker → render
  nella card Profilo → migrazione.

### 2.8 Nessun framework di test

Repo vanilla, nessun bundler, nessun lint/test runner (CLAUDE.md). Verifica =
review statica del diff + test manuale + check dei ruoli SQL via MCP.

### 2.9 Nessuna cache di profilo lato client

`let currentUser = null;` è l'unico globale utente. `loadUserProfile()` legge
`username` e lo scrive nel DOM senza conservarlo. Serve un nuovo globale
`currentUserProfile` (§3.1).

## 3. Data model

### 3.1 Formati di `profiles.avatar_url`

Un solo campo, tre casi:

| Valore | Significato | Render |
|---|---|---|
| `https://<proj>.supabase.co/storage/v1/object/public/avatars/<uid>/avatar.<ext>?v=<ts>` | Immagine caricata | `<img>` |
| `preset:<key>` | Uno degli 8 preset (`preset:leaf`, `preset:herb`, …) | `<span>` con emoji su sfondo tinta |
| `null` / `''` | Nessun avatar | `<span>` iniziale username, colore da hash |

- **`?v=<ts>`** (`Date.now()` al momento dell'upload) è un cache-buster: il file
  ha nome fisso (`avatar.webp`/`avatar.jpg`) e `upsert:true` lo sovrascrive; senza
  querystring nuova, CDN e browser mostrerebbero la vecchia immagine.
- **Nome file fisso**: solo `avatar.webp` o `avatar.jpg`. Mai altri nomi → il
  cleanup del vecchio file è deterministico (`remove` di entrambi i nomi noti,
  §5.1) senza dover fare `list`.
- **`preset:<key>`** con `key` da un set chiuso (§3.3). Chiave stabile: emoji e
  stile possono cambiare senza migrare i dati. `key` sconosciuta → si degrada a
  fallback iniziale.

Guest: stesso schema di valori ma solo `preset:<key>` o assente, in
`localStorage jt_guest_avatar`.

### 3.2 Helper di render condiviso — `avatarMarkup(avatarUrl, username, sizePx)`

Nuova funzione in `app.js`, **unico** punto che sa interpretare `avatar_url`.
Ritorna una stringa HTML già escaped, sicura per `innerHTML`.

```
avatarMarkup(avatarUrl, username, sizePx = 32) -> string
```

- `avatarUrl` inizia con `preset:` e la key è nota →
  `<span class="avatar avatar-preset" style="width/height/font-size">{emoji}</span>`
- `avatarUrl` è una URL http(s) →
  `<img class="avatar" src="{escaped}" width={sizePx} height={sizePx}
   loading="lazy" alt="" onerror="avatarImgFallback(this)">`
  - `data-fallback-initial` / `data-fallback-hue` sull'`<img>` per permettere a
    `avatarImgFallback()` di sostituire con lo `<span>` iniziale senza rifare
    query (stesso pattern di `fallbackPlainPhoto`).
- altrimenti (null, vuoto, `preset:` con key ignota) →
  `<span class="avatar avatar-fallback" style="width/height/font-size;
   background: {hslFromHash(username||'?')}">{firstLetter}</span>`

Helper interni:
- `hslFromHash(str)` — hash deterministico (djb2 o simile, ~5 righe) → hue
  0–359; `hsl(hue, 55%, 45%)` chiaro / il CSS gestisce l'aggiustamento dark via
  `.avatar-fallback` se serve (testo sempre bianco, contrasto ok su S/L fissi).
- `PRESET_AVATARS` — mappa `{ leaf: '🍃', herb: '🌿', ... }` (§3.3).
- `presetEmoji(key)` — `PRESET_AVATARS[key] || null`.

`escapeHtml()` già esiste e va usato su `username` prima di metterlo
nell'iniziale e nell'`alt`.

### 3.3 Set preset (D2)

8 preset, coerenti col palette verde/natura dell'app, volutamente "adulti"
(niente faccine):

| key | emoji |
|---|---|
| `leaf` | 🍃 |
| `herb` | 🌿 |
| `sprout` | 🌱 |
| `evergreen` | 🌲 |
| `sun` | ☀️ |
| `moon` | 🌙 |
| `fire` | 🔥 |
| `sparkle` | ✨ |

Renderizzati come emoji centrata su un cerchio con `background` a tinta
`--primary` (es. `rgba(76,175,80,0.15)`), coerente in dark/light.

### 3.4 `currentUserProfile` (nuovo globale)

`let currentUserProfile = null;` in cima ad `app.js`. Popolato da
`loadUserProfile()` con `{ username, avatar_url }` (la select passa da
`select('username')` a `select('username, avatar_url')`). Usato da:

- render della preview avatar nella card Profilo
- stato "selezionato" nel preset picker
- render della propria riga nel feed / leaderboard senza query extra su sé stessi

In guest mode `currentUserProfile` non è popolato dal DB; la preview legge
`localStorage jt_guest_avatar` direttamente.

## 4. Frontend — impostare l'avatar

### 4.1 UI nella card Profilo (`app/index.html`, `#profileCard`)

Nuovo blocco in cima alla card, sopra "Loggato come":

```
┌ 👤 Profilo ───────────────────────────┐
│  [ avatar preview 72px ]  [ Rimuovi ] │   ← "Rimuovi" solo se avatar impostato
│                                       │
│  ( • Carica foto )  ( Scegli icona )  │   ← due bottoni-tab, uno attivo
│                                       │
│  ── modo "Carica foto" ──             │
│  [ Scegli immagine ]                  │   ← trigger dell'<input type=file> nascosto
│  <testo errore inline, hidden>        │
│                                       │
│  ── modo "Scegli icona" ──            │
│  [🍃][🌿][🌱][🌲]                     │   ← griglia tap, selezionato evidenziato
│  [☀️][🌙][🔥][✨]                     │
└───────────────────────────────────────┘
```

- `<input type="file" accept="image/jpeg,image/png,image/webp" hidden>` — **senza**
  attributo `capture` (così su mobile l'utente sceglie tra galleria e camera).
- Preview via `avatarMarkup(currentAvatarValue, username, 72)`.
- Durante l'upload: overlay spinner sulla preview (`.avatar-loading`), bottoni
  disabilitati.
- Errore upload/validazione: testo rosso inline sotto il bottone (i18n),
  l'avatar corrente resta invariato.
- Guest: il modo "Carica foto" mostra un hint ("Crea un account per caricare una
  foto") invece del bottone; il preset picker funziona.

### 4.2 Validazione client (D3)

All'evento `change` dell'input file, prima di aprire il crop:

1. `file.type` ∈ `{image/jpeg, image/png, image/webp}` → altrimenti errore
   `settings.avatarFormatError`.
2. `file.size <= 10 * 1024 * 1024` → altrimenti `settings.avatarTooLarge`.
3. `new Image()` + `URL.createObjectURL(file)`; `img.onerror` → errore
   `settings.avatarFormatError` (es. HEIC su desktop non decodificabile) e
   abort. Non si tenta di caricare l'originale non decodificato (a differenza di
   `compressImage`), perché senza decodifica non si può né croppare né
   ridimensionare.

### 4.3 Crop modal interattivo (D4 — pan + zoom)

Nuovo modal `#avatarCropModal` (riusa `.modal` / `.modal-content` esistenti).

Struttura:

```
┌ Ritaglia l'avatar ───────────────┐
│  ┌───────────────┐               │
│  │   viewport    │  ← quadrato, es. min(280px, 80vw), overflow:hidden
│  │   [ <img> ]   │     <img> in position:absolute, transform: translate() scale()
│  └───────────────┘               │
│  Zoom  [────●─────]              │  ← <input type="range">
│  ( Annulla )      ( Conferma )   │
└──────────────────────────────────┘
```

Interazione (vanilla, **nessuna libreria**):

- **State**: `{ scale, tx, ty }` + dimensioni naturali immagine + dimensione
  viewport.
- **Init**: `scale` = "cover" del viewport (`viewport / min(imgW, imgH)`),
  immagine centrata (`tx = ty` per centrare).
- **Drag**: Pointer Events. `pointerdown` su un solo pointer → registra offset;
  `pointermove` → aggiorna `tx/ty`; `pointerup/cancel` → fine. `setPointer
  Capture`.
- **Pinch zoom**: due pointer attivi → `scale` proporzionale al rapporto delle
  distanze correnti/iniziali tra i due punti; il punto medio resta ancorato.
- **Slider zoom**: `input` sul range → `scale` assoluto tra `minScale` (cover) e
  `minScale * 4`. Sincronizzato con lo stato pinch.
- **Clamp** (dopo ogni cambiamento): `scale >= minScale`; `tx/ty` vincolati in
  modo che l'immagine copra sempre il viewport (nessun bordo vuoto).
- **Annulla**: chiude, resetta `<input type=file>`, nessuna modifica.
- **Conferma**: chiama `exportCroppedAvatar()` (§4.4) → `uploadAvatarBlob()`
  (§5.1).

Mobile: `touch-action: none` sul viewport per non far scrollare la pagina
durante drag/pinch.

### 4.4 Export — `exportCroppedAvatar(img, state) -> Promise<Blob>`

- Dal transform corrente, calcola il rettangolo sorgente in coordinate immagine
  naturali che corrisponde al viewport visibile:
  `sSize = viewportPx / scale`
  `sx = (-tx) / scale + offsetCentraturaX`
  `sy = (-ty) / scale + offsetCentraturaY`
  (la formula esatta dipende da come è definito l'origine del transform; il
  piano espliciterà i segni con un test manuale visivo).
- `canvas` 256×256; `ctx.imageSmoothingQuality = 'high'`;
  `ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, 256, 256)`.
- `canvas.toBlob(blob => …, 'image/webp', 0.85)`. Se `blob` è `null` (browser
  senza encoder WebP — raro nel 2026), retry `'image/jpeg', 0.85`.
- Ritorna `{ blob, ext }` con `ext` `'webp'` o `'jpg'`.
- Target dimensione: 256×256 WebP @0.85 ≈ 15–40 KB, ben sotto i ~200 KB. Nessun
  loop di ri-compressione necessario a questa risoluzione.

### 4.5 Preset picker

`selectPresetAvatar(key)`:

- **Guest**: `localStorage.setItem('jt_guest_avatar', 'preset:' + key)` →
  re-render preview. Fine.
- **Registrato**:
  1. `removeUploadedAvatarFiles()` (§5.1) — se prima c'era una foto, togliла da
     Storage per non lasciare file orfani. Ignora errori.
  2. `profiles.upsert({ id: currentUser.id, avatar_url: 'preset:' + key })`.
  3. `currentUserProfile.avatar_url = 'preset:' + key`; re-render preview +
     eventuali superfici montate.
  4. Errore DB → messaggio inline, nessun cambiamento di stato locale.

### 4.6 Rimozione

`removeAvatar()`:

- **Guest**: `localStorage.removeItem('jt_guest_avatar')` → re-render.
- **Registrato**: `removeUploadedAvatarFiles()` +
  `profiles.upsert({ id, avatar_url: null })` → `currentUserProfile.avatar_url =
  null` → re-render.

## 5. Frontend — upload e distribuzione

### 5.1 `uploadAvatarBlob({ blob, ext })`

Precondizione: `!isGuestMode` (il modo "Carica foto" non è raggiungibile da
guest).

1. `path = `${currentUser.id}/avatar.${ext}``.
2. `removeUploadedAvatarFiles()` — `supabaseClient.storage.from('avatars').remove([
   `${currentUser.id}/avatar.webp`, `${currentUser.id}/avatar.jpg` ])`. Ignora
   errori (file può non esistere). Serve perché l'estensione può cambiare tra
   upload (webp↔jpg) lasciando due file.
3. `storage.from('avatars').upload(path, blob, { upsert: true, contentType:
   ext === 'webp' ? 'image/webp' : 'image/jpeg' })`. Su errore → throw →
   gestito dal chiamante (messaggio inline, stato invariato).
4. `publicUrl = storage.from('avatars').getPublicUrl(path).data.publicUrl + '?v='
   + Date.now()`.
5. `profiles.upsert({ id: currentUser.id, avatar_url: publicUrl })`. Su errore →
   throw.
6. `currentUserProfile.avatar_url = publicUrl`; re-render preview + superfici
   montate; chiudi crop modal; `showMessage(t('settings.avatarUpdated'))`.

Stato di caricamento: la preview mostra `.avatar-loading` da step 2 a step 6;
"Conferma" nel crop modal disabilitato e con spinner.

### 5.2 Superfici di render (tutte via `avatarMarkup`)

| # | Superficie | File / funzione | Come arriva `avatar_url` |
|---|---|---|---|
| 1 | Card Profilo (preview) | `app/index.html #profileCard`, nuova `renderAvatarSettings()` | `currentUserProfile` / `localStorage` (guest) |
| 2 | Leaderboard — Mondiale & Amici | `loadSocial()` (~3329) | dopo `data`, `profiles_public.select('id,avatar_url').in('id', ids)` → `Map`; `avatarMarkup(map.get(u.user_id), u.username, 32)` prima del rank |
| 3 | Leaderboard — Insieme | `loadSharedLeaderboard()` (~3389) | idem, ma la chiave riga è `u.friend_id` |
| 4 | Modal statistiche amico | `viewFriendStats(targetId, username)` (~3465) | singola `profiles_public.select('avatar_url').eq('id', targetId).maybeSingle()`; avatar accanto a `#modalFriendName` |
| 5 | Quick-list amici (sessione condivisa) | `getMyFriendsList()` (~208) + `renderFriendsQuickList()` (~221) | `getMyFriendsList` passa a `select('id, username, avatar_url')`; il bottone mostra l'avatar |
| 6 | Chip partecipanti + preview sessione | `sessionParticipants` (~16), `renderParticipantChips()` (~285), preview panel (~296) | `sessionParticipants` entries diventano `{ user_id, username, avatar_url }`; popolati da quick-list e da `searchParticipant()` (~258, aggiungi `avatar_url` alla select) |
| 7 | Feed istantanee — card | `feedCardHtml()` (~2239) | RPC `get_snapshot_feed` già ritorna `it.avatar_url`; **sostituisci** il markup inline con `avatarMarkup(it.avatar_url, it.username, <size attuale>)` |
| 8 | Feed istantanee — commenti | `renderComments()` (~2504) | RPC già ritorna `c.avatar_url`; aggiungi un avatar piccolo (20–24px) davanti a `.feed-comment-name` |

Note:
- **D5**: nelle superfici 2/3, una sola query `.in('id', ids)` per render. La
  leaderboard mondiale può avere molti utenti, ma la lista è comunque già
  renderizzata interamente client-side; una `.in()` con N id è un solo
  round-trip. Nessun caching cross-render nella v1 (semplicità); si può
  aggiungere una `Map` a livello modulo dopo, se il profiling lo giustifica.
- La propria riga ("tu") usa `currentUserProfile.avatar_url` senza aspettare la
  query batch (che comunque la conterrebbe).
- `escapeHtml` su `username`/`friend_id`/`user_id` già presente nei punti di
  `onclick` — non regredire.

### 5.3 Quando le superfici si aggiornano dopo un cambio avatar

- Card Profilo: subito (re-render locale).
- Feed / leaderboard / sessioni: al prossimo caricamento della pagina/pannello
  (nessuna propagazione realtime; coerente con il resto dell'app, il feed non è
  realtime per scelta — vedi spec feed §1).

## 6. Backend — Supabase

### 6.1 Migration `supabase/migrations/20260830HHMMSS_add_avatars_bucket.sql`

```sql
-- Bucket avatar: lettura pubblica, scrittura solo sul proprio prefisso {uid}/.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Lettura pubblica (anche anon: le pagine marketing non la usano, ma il costo è nullo
-- e semplifica il render — nessun signed URL).
create policy "Avatar pubblici in lettura"
  on storage.objects for select
  using ( bucket_id = 'avatars' );

-- Scrittura/aggiornamento/cancellazione solo su file sotto {auth.uid()}/...
create policy "Utente scrive solo il proprio avatar (insert)"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Utente scrive solo il proprio avatar (update)"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Utente scrive solo il proprio avatar (delete)"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

- **D6**: bucket **pubblico** (niente signed URL). Gli avatar non sono dati
  sensibili e sono già esposti via `profiles_public` a ogni utente loggato;
  pubblico li rende cacheabili dalla CDN e semplifica ogni render.
- `storage.foldername(name)` è la funzione ufficiale Supabase per splittare il
  path; `[1]` è la prima cartella (`{uid}`).
- Nessun limite di dimensione a livello bucket (il piano Free non lo espone in
  modo affidabile via SQL); il gate reale è la validazione client + il fatto che
  il file caricato è sempre un 256×256 generato dal canvas, non l'originale.
- **Applicazione**: manuale nell'SQL editor Supabase (o CLI se autenticata) —
  come ogni migration di questo repo. Da fare **prima** del deploy del
  frontend.

### 6.2 Verifiche pre-implementazione (via MCP)

1. `pg_get_viewdef('public.profiles_public')` contiene `avatar_url` e
   `reloptions` NON contiene `security_invoker=true` (vedi §2.2). Se è flippata,
   fixare come pre-requisito separato.
2. Nessun bucket `avatars` già esistente con config diversa.

## 7. Guest mode

- Chiave: `localStorage jt_guest_avatar`, valore `preset:<key>` o assente.
- Solo preset. Il modo "Carica foto" in card Profilo mostra un hint invece del
  bottone quando `isGuestMode`.
- Preview in card Profilo: legge `localStorage jt_guest_avatar`.
- **Migrazione** — in `migrateGuestDataToAccount(userId)` (~riga 861), dopo
  l'insert di smokes/purchases andato a buon fine e insieme alla pulizia di
  `jt_guest_achievements`:

  ```js
  const guestAvatar = localStorage.getItem('jt_guest_avatar');
  if (guestAvatar && guestAvatar.startsWith('preset:')) {
      await supabaseClient.from('profiles').upsert({ id: userId, avatar_url: guestAvatar });
  }
  localStorage.removeItem('jt_guest_avatar');
  ```

  Se l'utente aveva già impostato un avatar durante l'onboarding post-signup,
  l'`upsert` lo sovrascrive col preset guest — accettabile (il guest ha scelto
  quel preset prima, è la sua intenzione più recente prima della conversione).
  In pratica il picker non è raggiungibile tra signup e migrazione.

## 8. i18n

Nuove chiavi in `locales/it.json` e `locales/en.json`, sotto `settings`:

| chiave | it (esempio) |
|---|---|
| `settings.avatarTitle` | "Immagine del profilo" |
| `settings.avatarUploadMode` | "Carica foto" |
| `settings.avatarPresetMode` | "Scegli icona" |
| `settings.avatarChooseImage` | "Scegli immagine" |
| `settings.avatarRemove` | "Rimuovi" |
| `settings.avatarGuestHint` | "Crea un account per caricare una tua foto." |
| `settings.avatarCropTitle` | "Ritaglia l'avatar" |
| `settings.avatarCropZoom` | "Zoom" |
| `settings.avatarCropConfirm` | "Conferma" |
| `settings.avatarCropCancel` | "Annulla" |
| `settings.avatarUpdated` | "Immagine del profilo aggiornata" |
| `settings.avatarUploadError` | "Caricamento non riuscito, riprova." |
| `settings.avatarUploading` | "Caricamento…" |
| `settings.avatarFormatError` | "Formato non supportato. Usa JPG, PNG o WebP." |
| `settings.avatarTooLarge` | "Immagine troppo grande (max 10 MB)." |

Nessuna stringa hardcoded in `app.js`/HTML (convenzione progetto).

## 9. CSS

Nuova sezione in `style.css`: `/* ========== AVATAR ========== */`.

- `.avatar` — base: `border-radius:50%`, `object-fit:cover`, `display:inline-flex`,
  `align-items/justify-content:center`, `flex-shrink:0`, `overflow:hidden`,
  `font-weight:700`, `color:#fff`, `line-height:1`, `vertical-align:middle`.
  Dimensione via attributi `width/height` inline + `font-size` inline (≈
  `sizePx * 0.45`).
- `.avatar-preset` — `background: rgba(76,175,80,0.15)`; l'emoji eredita
  `font-size`.
- `.avatar-fallback` — `background` inline da `hslFromHash`.
- `.avatar-loading` — overlay con spinner (riusa `.spinner` esistente) e
  `opacity` ridotta sull'avatar sotto.
- Card Profilo: `.avatar-settings`, `.avatar-settings-row` (preview + rimuovi),
  `.avatar-mode-tabs`, `.avatar-preset-grid` (grid 4×2, gap, tap target ≥
  40px), `.avatar-preset-cell.is-selected` (bordo `--primary`).
- Crop modal: `.avatar-crop-viewport` (quadrato, `overflow:hidden`,
  `touch-action:none`, `position:relative`), `.avatar-crop-img`
  (`position:absolute`, `transform-origin: 0 0`, `will-change: transform`,
  `user-select:none`, `-webkit-user-drag:none`), `.avatar-crop-zoom` (range).
- Feed: `.feed-avatar` esistente va riconciliato con `.avatar` (o
  `feedCardHtml` smette di usare `.feed-avatar` e passa a `.avatar` con size
  inline; verificare che il layout `.feed-head` regga — probabile aggiustamento
  di `gap`). `.feed-comment` guadagna un avatar piccolo → `display:flex` sulla
  riga commento.
- Dark mode: i preset e il fallback usano colori a contrasto fisso (testo
  bianco su S/L scelti per reggere entrambi i temi); verificare a occhio.

## 10. Error handling — riepilogo

| Situazione | Comportamento |
|---|---|
| File type non ammesso | Errore inline `avatarFormatError`, input resettato, nessun crop |
| File > 10 MB | Errore inline `avatarTooLarge` |
| `img.onerror` (decodifica fallita) | Errore inline `avatarFormatError`, abort |
| `toBlob` WebP → null | Retry JPEG; se anche quello fallisce → errore inline |
| `storage.upload` errore (rete/permessi) | Errore inline `avatarUploadError`, avatar corrente invariato, crop modal resta aperto |
| `profiles.upsert` errore | Come sopra; il file è già su Storage ma `avatar_url` non aggiornato → prossimo upload lo sovrascrive (nessun orfano permanente perché il nome è fisso) |
| `remove` vecchio file fallisce | Ignorato (best-effort) |
| `<img>` avatar 404 a render (file cancellato lato Storage) | `onerror` → `avatarImgFallback()` sostituisce con iniziale |
| `profiles_public` ritorna vuoto per un id (view rotta / utente cancellato) | `map.get()` undefined → `avatarMarkup` degrada a iniziale |
| Preset key sconosciuta (dati vecchi / manomessi) | `avatarMarkup` degrada a iniziale |

## 11. Testing

Nessun framework nel repo → verifica manuale + statica + SQL.

### 11.1 Manuale (Matteo, post-deploy — Claude non può fare login)

- Upload JPG, PNG, WebP → crop pan+zoom+slider → Conferma → avatar quadrato
  corretto, visibile subito, `?v=` cambia a ogni upload.
- Cambio da foto a foto (verifica: nessun doppio file webp+jpg residuo in
  Storage).
- Preset: selezione, stato "selezionato", persistenza dopo reload.
- Passaggio foto → preset (verifica: file Storage rimosso).
- Rimuovi avatar → torna all'iniziale colorata.
- File 12 MB → rifiutato. File `.txt` rinominato `.jpg` → `img.onerror` →
  rifiutato.
- Guest: preset picker (no upload) → registrazione → avatar migrato,
  `jt_guest_avatar` rimosso.
- Superfici: leaderboard ×3, modal amico, quick-list + chip + preview sessione
  condivisa, feed card, feed commenti — tutte mostrano avatar reale / preset /
  iniziale correttamente.
- Dark mode su tutte le superfici.
- Rete lenta (throttle): stato di loading visibile, errore gestito.

### 11.2 SQL / ruoli (Claude, via MCP prima e dopo la migration)

- Post-migration: le 4 policy esistono su `storage.objects`.
- Simulare `auth.uid()` = utente A: `insert`/`update`/`delete` su
  `avatars/{B}/avatar.webp` **negato**; su `avatars/{A}/avatar.webp`
  **permesso**.
- `select` su `avatars/...` permesso anche senza JWT (ruolo `anon`).
- `profiles_public` ritorna `avatar_url` per un id arbitrario (view non rotta).

### 11.3 Statica

- Review del diff: `avatarMarkup` è l'**unico** punto che interpreta
  `avatar_url` (nessun `<img src=${...avatar_url}` rimasto altrove — in
  particolare il vecchio markup in `feedCardHtml`).
- `escapeHtml` mantenuto su tutti gli input utente nei template.
- Nessuna stringa user-visible hardcoded.
- Indentazione a tab nelle righe nuove/toccate.

## 12. Decisioni (indice)

- **D1**: le RPC leaderboard/friend-stats non si toccano; avatar via join
  client-side su `profiles_public`.
- **D2**: 8 preset emoji a tema natura/verde, chiavi stabili `preset:<key>`.
- **D3**: validazione client: `jpeg/png/webp`, ≤ 10 MB pre-compressione, decode
  obbligatoria.
- **D4**: crop interattivo pan + zoom (pinch + slider), vanilla, export a
  256×256 WebP (fallback JPEG).
- **D5**: una query `profiles_public.in(ids)` per render di leaderboard, nessun
  cache cross-render nella v1.
- **D6**: bucket `avatars` pubblico in lettura, scrittura RLS sul prefisso
  `{uid}/`, nome file fisso `avatar.{webp|jpg}` + cache-buster `?v=`.
- **D7**: guest = solo preset in `localStorage jt_guest_avatar`, migrato in
  `migrateGuestDataToAccount`.
- **D8**: header dell'app fuori scope (non mostra nome/username oggi).

## 13. Ordine di implementazione (bozza per il piano)

1. Migration bucket + policy; applicare a prod; verifiche §6.2 / §11.2.
2. `avatarMarkup` + `hslFromHash` + `PRESET_AVATARS` + `avatarImgFallback` +
   CSS `.avatar*`. Rifattorizzare `feedCardHtml` su `avatarMarkup` (nessun
   cambiamento visibile atteso per chi ha già un avatar-URL). Regressione zero.
3. `currentUserProfile` globale + `loadUserProfile` estesa.
4. Card Profilo: UI avatar (preview + tabs + preset grid + rimuovi) + i18n.
5. Crop modal + `exportCroppedAvatar` + `uploadAvatarBlob` +
   `removeUploadedAvatarFiles` + `selectPresetAvatar` + `removeAvatar`.
6. Superfici 2–6 e 8 (leaderboard, modal amico, sessioni condivise, commenti
   feed).
7. Guest: hint, `jt_guest_avatar`, migrazione.
8. Test manuale completo (Matteo) + review statica.
