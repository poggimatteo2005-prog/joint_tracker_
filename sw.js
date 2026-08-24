// sw.js — gestisce sia le notifiche push sia il caching per l'uso offline

const CACHE_NAME = 'jointtracker-v11';
// Cache separata, a nome fisso (non legata all'hash di app.js), per le foto della
// galleria: i byte di una foto non cambiano tra un deploy e l'altro, quindi non deve
// essere svuotata ad ogni release come la cache dell'app shell (vedi ACTIVE_CACHES sotto).
const PHOTO_CACHE_NAME = 'jointtracker-photos-v1';

// Chart.js e Leaflet/MarkerCluster NON sono precaricati qui: sono ~174 KiB usati solo
// nelle pagine Grafici/Mappa e vengono iniettati a runtime (vedi loadChartJs()/loadMapLibs()
// in app.js) solo quando servono davvero. Il fetch handler sotto li mette comunque in
// cache-first automaticamente alla prima richiesta reale, quindi restano disponibili offline.
const PRECACHE_URLS = [
  '/app',
  '/app/index.html',
  '/style.css',
  '/app.js',
  '/i18n.js',
  '/manifest.json',
  '/icon-192.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// ========== INSTALLAZIONE: precarica i file essenziali ==========
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(
        PRECACHE_URLS.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.log('Impossibile precaricare:', url, err);
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ========== ATTIVAZIONE: rimuove le cache vecchie ==========
self.addEventListener('activate', function (event) {
  const ACTIVE_CACHES = [CACHE_NAME, PHOTO_CACHE_NAME];
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return ACTIVE_CACHES.indexOf(key) === -1; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// Riconosce le richieste GET che scaricano l'immagine vera e propria (URL gia' firmata,
// con ?token=...) tra tutte le chiamate a Supabase — sia signed URL semplici che con
// Image Transformations. Il metodo GET + la presenza del token sono fondamentali: la
// STESSA base URL (/storage/v1/object/sign/session-photos/...) e' usata anche dalla
// chiamata POST che genera il token (createSignedUrl/createSignedUrls, senza ?token=
// nella query). Intercettarla per errore rompeva la generazione del link firmato,
// perche' cacheFirstPhoto la ri-emetteva sempre come GET senza body ne' header di auth.
function isGalleryPhotoRequest(request) {
  const url = request.url;
  return request.method === 'GET' && url.includes('supabase.co') && url.includes('/storage/v1/') && url.includes('/session-photos/') && url.includes('token=');
}

// Le signed URL cambiano token ad ogni richiesta, ma i byte dell'immagine dietro un
// dato path+trasformazione no: usiamo come chiave di cache l'URL senza il token, così
// le richieste successive fanno hit invece di riscaricare l'immagine ogni volta.
function photoCacheKey(url) {
  const u = new URL(url);
  u.searchParams.delete('token');
  return u.toString();
}

async function cacheFirstPhoto(request) {
  const cacheKey = photoCacheKey(request.url);
  const cache = await caches.open(PHOTO_CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    // Un <img> cross-origin genera una request "no-cors": rifetchare quella stessa
    // request darebbe una response opaca con status sempre 0 (mai 200, anche se va a
    // buon fine), quindi non verrebbe mai messa in cache. Supabase Storage supporta
    // CORS, quindi rifacciamo la fetch esplicitamente in modalita' 'cors' sul solo URL
    // per ottenere una response leggibile/cacheabile invece di una opaca.
    const response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (response.ok) {
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (err) {
    return cached || Response.error();
  }
}

// ========== FETCH: strategia diversa per API vs risorse statiche ==========
self.addEventListener('fetch', function (event) {
  const url = event.request.url;

  if (isGalleryPhotoRequest(event.request)) {
    event.respondWith(cacheFirstPhoto(event.request));
    return;
  }

  // Le chiamate a Supabase (dati/API) e ai servizi di geocoding devono SEMPRE andare
  // in rete: i dati devono essere freschi, mai serviti dalla cache.
  if (url.includes('supabase.co') || url.includes('nominatim.openstreetmap.org')) {
    return; // lascia che il browser gestisca la richiesta normalmente
  }

  // Lo script di Vercel Speed Insights e le sue chiamate beacon (spesso POST, non
  // cacheabili dalla Cache API) devono sempre andare in rete: altrimenti lo script
  // resterebbe in cache fino al prossimo deploy invece di aggiornarsi, e i tentativi
  // di cache.put() sulle POST del beacon genererebbero errori innocui ma rumorosi.
  if (url.includes('/_vercel/speed-insights/')) {
    return;
  }

  // Per tutto il resto (app shell, librerie): cache-first, con aggiornamento in background
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      const networkFetch = fetch(event.request).then(function (response) {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(function () {
        return cached; // offline: usa la cache se la rete fallisce
      });

      return cached || networkFetch;
    })
  );
});

// ========== PUSH: ricezione notifiche (invariato) ==========
self.addEventListener('push', function (event) {
  let data = { title: '🌿 JointTracker', body: 'Non hai ancora segnato nulla oggi!' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    // fallback al messaggio di default se il payload non è JSON valido
  }

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || '/app' }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/app';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
