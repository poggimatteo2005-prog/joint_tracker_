// ========== INIZIALIZZAZIONE SUPABASE ==========
	const SUPABASE_URL = 'https://afkxmbxcavwhurmdelfr.supabase.co';
	const SUPABASE_KEY = 'sb_publishable_1rc0ueZL6Y03qhk5jp_34w_ObCOCpCP';
	const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

	// ========== VARIABILI GLOBALI ==========
	let currentUser = null;
	let smokes = [];
	let smokesLoaded = false; // false finché loadData() non ha popolato smokes: evita di mostrare la scorta come "piena" prima di conoscere il consumato
	let currentLocation = { lat: null, lng: null, name: null };
	let mapInstance = null;
	let mapMarkers = [];
	let currentSocialTab = 'global';
	let charts = {};
	let userPlaces = []; // Array per i posti caricati dal DB
	let sessionParticipants = []; // { user_id, username, avatar_url }
	let isLocatingNow = false;
	let isOnline = navigator.onLine;
	let notifications = [];
	let sharedPeriod = 'month';
    let activeBreak = null;
    let pendingBreak = null; // pausa "pianificata" non ancora confermata (vedi ========== TOLERANCE BREAK ==========)
    let allBreaks = [];
	const VAPID_PUBLIC_KEY = 'BE2yG7kWhMrni1qk-uilMqHc7uGL92CZE6UaLt-sbTTHsDr4lDP6qiqnSJsxachx5kUJ7C-0dO46UeSjxOUwiG0';
	let userReminderSettings = { reminder_enabled: true, reminder_time: '20:00:00' };
	let unlockedAchievements = [];
let currentUserProfile = null; // { username, avatar_url } — popolato da loadUserProfile()
let friendsCountCache = 0;
let achievementsLoaded = false;
let isGuestMode = false;

// ========== TEMA (chiaro/scuro/automatico) ==========
function getStoredThemePref() {
	try { return localStorage.getItem('jt_theme') || 'dark'; } catch (e) { return 'dark'; }
}

function resolveTheme(pref) {
	if (pref === 'auto') {
		return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
	}
	return pref;
}

function applyTheme(pref) {
	document.documentElement.setAttribute('data-theme', resolveTheme(pref));

	document.querySelectorAll('#themeOptions label').forEach(l => l.classList.remove('selected'));
	const radio = document.querySelector(`input[name="themeChoice"][value="${pref}"]`);
	if (radio) {
		radio.checked = true;
		radio.parentElement.classList.add('selected');
	}
}

function setTheme(pref) {
	try { localStorage.setItem('jt_theme', pref); } catch (e) {}
	applyTheme(pref);
}

function toggleTheme() {
	const current = document.documentElement.getAttribute('data-theme');
	setTheme(current === 'dark' ? 'light' : 'dark');
}

function initTheme() {
	applyTheme(getStoredThemePref());
	if (window.matchMedia) {
		window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
			if (getStoredThemePref() === 'auto') applyTheme('auto');
		});
	}
}

// Neutralizza HTML in testo libero di altri utenti prima di inserirlo via innerHTML
// (es. il nome di un posto di un amico, mostrato nelle Istantanee).
function escapeHtml(str) {
	if (str === null || str === undefined) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Grammi personalmente consumati in una sessione (quota propria per le sessioni condivise,
// non il totale grezzo "grams" che in passato poteva riflettere l'importo di un altro partecipante).
function personalGrams(s) {
	// Tre modi di leggere "quanto conta questa sessione per le mie statistiche personali":
	// my_fumo/erba_grams (piu' recente, gestisce le condivise), fumo/erba_grams (contributo
	// scorta), grams (colonna storica, l'unica popolata sulle sessioni piu' vecchie create
	// prima che esistessero le altre colonne). Si prende il massimo cosi' nessuna sessione,
	// vecchia o nuova, risulta a 0 solo perche' una colonna piu' recente non e' stata valorizzata.
	const myTotal = (s.my_fumo_grams ?? 0) + (s.my_erba_grams ?? 0);
	const contribTotal = (s.fumo_grams ?? 0) + (s.erba_grams ?? 0);
	const rawTotal = s.grams ?? 0;
	return Math.max(myTotal, contribTotal, rawTotal);
}

// title/desc si leggono da locales/*.json tramite achTitle()/achDesc(), non da qui,
// così restano coerenti se la lingua cambia dopo il primo render.
const ACHIEVEMENTS = [
	{ key: 'first_session', icon: '🌱', check: () => smokes.length >= 1 },
	{ key: 'sessions_10', icon: '🔥', check: () => smokes.length >= 10 },
	{ key: 'sessions_100', icon: '💯', check: () => smokes.length >= 100 },
	{ key: 'sessions_500', icon: '🏆', check: () => smokes.length >= 500 },
	{ key: 'streak_7', icon: '📅', check: () => calculateStreak() >= 7 },
	{ key: 'streak_30', icon: '🗓️', check: () => calculateStreak() >= 30 },
	{ key: 'streak_100', icon: '💎', check: () => calculateStreak() >= 100 },
	{ key: 'first_purchase', icon: '🛒', check: () => typeof purchases !== 'undefined' && purchases.length >= 1 },
	{ key: 'first_friend', icon: '🤝', check: () => friendsCountCache >= 1 },
	{ key: 'first_shared', icon: '👥', check: () => smokes.some(s => Array.isArray(s.shared_with) && s.shared_with.length > 0) },
	{ key: 'explorer', icon: '🗺️', check: () => userPlaces.length >= 5 },
	{ key: 'globe_trotter', icon: '🌍', check: () => new Set(smokes.map(s => s.location_name).filter(Boolean)).size >= 5 },
];

function achTitle(key) { return t(`achievements.${key}.title`); }
function achDesc(key) { return t(`achievements.${key}.desc`); }


	// Gestione selezione Fumo/Erba
document.querySelectorAll('.substance-checkbox-group input[type="checkbox"]').forEach(checkbox => {
	checkbox.addEventListener('change', function() {
		const label = this.parentElement;
		if (this.checked) {
			label.classList.add('selected');
		} else {
			label.classList.remove('selected');
		}
	});
});

	// Evidenzia l'opzione selezionata nei gruppi "a chip" (contesto, umore)
	function syncTagRowVisual(radioName) {
		document.querySelectorAll(`input[name="${radioName}"]`).forEach(r => {
			r.parentElement.classList.toggle('selected', r.checked);
		});
	}

	function bindTagRowSelection(radioName) {
		document.querySelectorAll(`input[name="${radioName}"]`).forEach(input => {
			input.addEventListener('change', () => syncTagRowVisual(radioName));
		});
	}

	bindTagRowSelection('contextTag');
	bindTagRowSelection('moodRating');

	// Mostra messaggio quando entrambi selezionati
document.getElementById("fumo").addEventListener('change', updateDivideMessage);
document.getElementById("erba").addEventListener('change', updateDivideMessage);

function updateDivideMessage() {
    const hasFumo = document.getElementById("fumo").checked;
    const hasErba = document.getElementById("erba").checked;
    if (typeof renderContributorsPanel === 'function') renderContributorsPanel();
    const msgDiv = document.getElementById("divideMessage");
    const notMineToggle = document.getElementById("notMineToggle");

    // Mostra il toggle "non mia" se almeno uno è selezionato
    notMineToggle.style.display = (hasFumo || hasErba) ? "block" : "none";
    if (!hasFumo && !hasErba) document.getElementById("notMineCheck").checked = false;

    if (hasFumo && hasErba) {
        const gVal = document.querySelector('input[name="g"]:checked').value;
        const grams = gVal === "custom" ? parseFloat(document.getElementById("customGrams").value) || 0.5 : parseFloat(gVal);
        const fumo = (grams / 2).toFixed(1);
        const erba = (grams / 2).toFixed(1);
        msgDiv.style.display = "block";
        document.getElementById("divideText").textContent = `${fumo}g 🍫 + ${erba}g 🍃`;
    } else {
        msgDiv.style.display = "none";
    }
}

function toggleSharedSession() {
    if (isGuestMode) {
        // La UI è nascosta in guest mode, ma la checkbox esiste ancora nel DOM:
        // blindiamo comunque, niente account = niente amici da caricare.
        document.getElementById('sharedSessionCheck').checked = false;
        document.getElementById('sharedSessionPanel').style.display = 'none';
        return;
    }
    const checked = document.getElementById('sharedSessionCheck').checked;
    document.getElementById('sharedSessionPanel').style.display = checked ? 'block' : 'none';
    if (checked) {
        renderFriendsQuickList();
    } else {
        sessionParticipants = [];
        renderParticipantChips();
    }
}

async function getMyFriendsList() {
    const { data: friendships, error } = await supabaseClient
        .from('friendships')
        .select('friend_id')
        .eq('user_id', currentUser.id)
        .eq('status', 'accepted');

    if (error) {
        console.error('getMyFriendsList: errore nel caricare friendships', error);
        throw error;
    }
    if (!friendships || friendships.length === 0) return [];

    const friendIds = friendships.map(f => f.friend_id);

    const { data: profilesData, error: profilesError } = await supabaseClient
        .from('profiles_public')
        .select('id, username, avatar_url')
        .in('id', friendIds);

    if (profilesError) {
        console.error('getMyFriendsList: errore nel caricare profiles_public', profilesError);
        throw profilesError;
    }

    return profilesData || [];
}

// Cache dell'ultima lista amici resa dalla quick-list: quickAddParticipant()
// la consulta per id invece di ricevere username/avatar_url in un onclick inline
// (pattern user-string-in-onclick evitato — vedi Task 8).
let friendsQuickCache = [];

async function renderFriendsQuickList() {
    const el = document.getElementById('friendsQuickList');
    if (!el) return;
    el.innerHTML = `<p style="font-size:12px; color:var(--color-text-muted);">${t('common.loading')}</p>`;

    let friends;
    try {
        friends = await getMyFriendsList();
    } catch (e) {
        el.innerHTML = `<p style="font-size:12px; color:var(--warning-text, #c0392b);">${t('shared.friendsListLoadError') || 'Errore nel caricamento amici, riprova.'}</p>`;
        return;
    }

    if (friends.length === 0) {
        el.innerHTML = `<p style="font-size:12px; color:var(--color-text-muted);">${t('shared.noFriendsYet')}</p>`;
        return;
    }

    friendsQuickCache = friends;
    el.innerHTML = friends.map(f => `
		<button type="button" onclick="quickAddParticipant('${f.id}')" class="friend-quick-btn">
			${avatarMarkup(f.avatar_url, f.username, 22)}
			<span>+ ${escapeHtml(f.username)}</span>
		</button>
    `).join('');
}

function quickAddParticipant(id) {
    if (sessionParticipants.some(p => p.user_id === id)) return;
    const friend = friendsQuickCache.find(f => f.id === id);
    if (!friend) return;
    sessionParticipants.push({ user_id: id, username: friend.username, avatar_url: friend.avatar_url || null });
    renderParticipantChips();
}

async function searchParticipant() {
    const input = document.getElementById('participantSearch');
    const query = input.value.trim();
    if (!query) return;

    const { data, error } = await supabaseClient
        .from('profiles_public')
        .select('id, username, avatar_url')
        .ilike('username', query)
        .neq('id', currentUser.id);

    if (error || !data || data.length === 0) {
        return alert(t('shared.noUserFound'));
    }

    const match = data.find(u => u.username.toLowerCase() === query.toLowerCase()) || data[0];

    if (sessionParticipants.some(p => p.user_id === match.id)) {
        return alert(t('shared.alreadyAdded'));
    }

    sessionParticipants.push({ user_id: match.id, username: match.username, avatar_url: match.avatar_url || null });
    input.value = "";
    renderParticipantChips();
}

function removeParticipant(id) {
    sessionParticipants = sessionParticipants.filter(p => p.user_id !== id);
    renderParticipantChips();
}

function renderParticipantChips() {
    const el = document.getElementById('participantChips');
    if (!el) return;
    el.innerHTML = sessionParticipants.map(p => `
		<span class="participant-chip">${avatarMarkup(p.avatar_url, p.username, 18)} ${escapeHtml(p.username)} <button onclick="removeParticipant('${p.user_id}')">✕</button></span>
    `).join('');
    renderContributorsPanel();
}

function renderContributorsPanel() {
    const panel = document.getElementById('contributorsPanel');
    if (!panel) return;
    if (sessionParticipants.length === 0) { panel.innerHTML = ''; return; }

    const hasFumo = document.getElementById("fumo").checked;
    const hasErba = document.getElementById("erba").checked;
    const all = [{ user_id: currentUser.id, username: t('shared.you'), avatar_url: (currentUserProfile && currentUserProfile.avatar_url) || null }, ...sessionParticipants];

    let fumoTotal = 0, erbaTotal = 0;
    if (hasFumo && hasErba) {
        fumoTotal = parseFloat(document.getElementById("fumoGramsInput")?.value) || 0;
        erbaTotal = parseFloat(document.getElementById("erbaGramsInput")?.value) || 0;
    } else {
        const gVal = document.querySelector('input[name="g"]:checked')?.value;
        const grams = gVal === "custom" ? parseFloat(document.getElementById("customGrams")?.value) : parseFloat(gVal);
        if (hasFumo) fumoTotal = grams || 0;
        if (hasErba) erbaTotal = grams || 0;
    }

    let html = `<p style="font-size:12px; color:var(--color-text-muted); margin-top:0;">${t('shared.whoBroughtIt')}</p>`;

    const isFirstRender = document.querySelectorAll('.contrib-fumo, .contrib-erba').length === 0;

    if (hasFumo) {
        const prevChecked = Array.from(document.querySelectorAll('.contrib-fumo:checked')).map(el => el.value);
        const activeIds = isFirstRender ? all.map(p => p.user_id) : prevChecked;
        const share = activeIds.length > 0 ? (fumoTotal / activeIds.length).toFixed(2) : '0.00';

        html += `<label style="margin-top:10px; font-size:12px;">${t('shared.smokeBroughtBy')}</label>`;
        html += all.map(p => `
            <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <label style="display:flex; align-items:center; gap:4px; font-size:13px; font-weight:normal; flex:1; margin-top:0;">
                    <input type="checkbox" class="contrib-fumo" value="${p.user_id}"
                        ${activeIds.includes(p.user_id) ? 'checked' : ''}
                        onchange="renderContributorsPanel()" style="width:auto;"> ${avatarMarkup(p.avatar_url, p.username, 18)} ${escapeHtml(p.username)}
                </label>
                <input type="number" step="0.01" min="0" class="contrib-fumo-amt" data-user="${p.user_id}"
                    value="${activeIds.includes(p.user_id) ? share : '0.00'}"
                    style="width:70px; margin:0; padding:6px; font-size:13px; text-align:center;">
                <span style="font-size:12px; color:var(--color-text-muted);">g</span>
            </div>
        `).join('');
    }

    if (hasErba) {
        const prevChecked = Array.from(document.querySelectorAll('.contrib-erba:checked')).map(el => el.value);
        const activeIds = isFirstRender ? all.map(p => p.user_id) : prevChecked;
        const share = activeIds.length > 0 ? (erbaTotal / activeIds.length).toFixed(2) : '0.00';

        html += `<label style="margin-top:14px; font-size:12px;">${t('shared.weedBroughtBy')}</label>`;
        html += all.map(p => `
            <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <label style="display:flex; align-items:center; gap:4px; font-size:13px; font-weight:normal; flex:1; margin-top:0;">
                    <input type="checkbox" class="contrib-erba" value="${p.user_id}"
                        ${activeIds.includes(p.user_id) ? 'checked' : ''}
                        onchange="renderContributorsPanel()" style="width:auto;"> ${avatarMarkup(p.avatar_url, p.username, 18)} ${escapeHtml(p.username)}
                </label>
                <input type="number" step="0.01" min="0" class="contrib-erba-amt" data-user="${p.user_id}"
                    value="${activeIds.includes(p.user_id) ? share : '0.00'}"
                    style="width:70px; margin:0; padding:6px; font-size:13px; text-align:center;">
                <span style="font-size:12px; color:var(--color-text-muted);">g</span>
            </div>
        `).join('');
    }

    panel.innerHTML = html;
}


// Aggiorna il messaggio anche quando cambiano i grammi
document.querySelectorAll('input[name="g"]').forEach(r => {
	r.addEventListener('change', updateDivideMessage);
});

document.getElementById("customGrams").addEventListener('input', updateDivideMessage);
	// ========== AUTENTICAZIONE ==========
	async function checkAuth() {
		const { data: { session } } = await supabaseClient.auth.getSession();
		if (session) {
			currentUser = session.user;
		}
		await initI18n();
		if (session) {
			const hadGuestData = isGuestModeStored() && hasGuestData();
			isGuestMode = false;
			// showApp() e loadData() non dipendono l'una dall'altra: girano in parallelo
			// invece che in sequenza per dimezzare il tempo prima del primo render utile.
			await Promise.all([showApp(), loadData()]);
			if (hadGuestData) {
				await migrateGuestDataToAccount(currentUser.id);
			}
			await migrateGuestAvatar(currentUser.id);
		} else if (isGuestModeStored()) {
			// Rientra in guest mode senza ri-tracciare l'evento: è già stato tracciato
			// la prima volta che l'utente ha premuto "Prova senza registrarti".
			isGuestMode = true;
			currentUser = null;
			await Promise.all([showApp(), loadData()]);
		} else {
			showLoginPage();
			if (window.va) {
				window.va('pageview', { route: '/virtual/login-shown' });
			}
		}
	}

	let authMode = 'login'; // 'login' o 'signup': quale form ridisegnare al cambio lingua (vedi listener i18n:change)

	function showLoginPage() {
		authMode = 'login';
		document.getElementById('page-auth').classList.add('active');
		document.getElementById('header').style.display = 'none';
		document.querySelectorAll('.page:not(#page-auth)').forEach(p => p.classList.remove('active'));

		const content = document.getElementById('authContent');
		content.innerHTML = `
			<form onsubmit="handleAuth(event, 'login')">
				<label for="email">${t('auth.email')}</label>
				<input type="email" id="email" placeholder="${t('auth.emailPlaceholder')}" required>

				<label for="password">${t('auth.password')}</label>
				<input type="password" id="password" placeholder="${t('auth.passwordPlaceholder')}" required>

				<button type="submit" class="main-btn">${t('auth.login')}</button>
			</form>

			<p style="text-align: center; margin-top: 20px; color: var(--color-text-secondary);">
				${t('auth.noAccount')} <button type="button" onclick="toggleAuthMode()" style="background:none; border:none; padding:0; margin:0; font:inherit; cursor:pointer; color:var(--primary-light); text-decoration:underline;" data-signup-link>${t('auth.signupLink')}</button>
			</p>
		`;
	}

	function renderSignupForm() {
		authMode = 'signup';
		const content = document.getElementById('authContent');
		content.innerHTML = `
			<form onsubmit="handleAuth(event, 'signup')">
				<label for="username">${t('auth.nickname')}</label>
				<input type="text" id="reg-username" placeholder="${t('auth.chooseNickname')}" oninput="checkLiveUsername(this)" required>
				<span id="username-status" style="font-size: 12px; font-weight: bold;"></span>

				<label for="email">${t('auth.email')}</label>
				<input type="email" id="email" placeholder="${t('auth.emailPlaceholder')}" required>

				<label for="password">${t('auth.password')}</label>
				<input type="password" id="password" placeholder="${t('auth.passwordPlaceholder')}" required>

				<label for="confirm">${t('auth.confirmPassword')}</label>
				<input type="password" id="confirm" placeholder="${t('auth.repeatPassword')}" required>

				<button type="submit" class="main-btn">${t('auth.signup')}</button>
			</form>

			<p style="text-align: center; margin-top: 20px; color: var(--color-text-secondary);">
				${t('auth.haveAccount')} <button type="button" onclick="toggleAuthMode()" style="background:none; border:none; padding:0; margin:0; font:inherit; cursor:pointer; color:var(--primary-light); text-decoration:underline;">${t('auth.loginLink')}</button>
			</p>
		`;
	}

	function toggleAuthMode() {
		const content = document.getElementById('authContent');
		if (content.querySelector('[data-signup-link]')) {
			renderSignupForm();
		} else {
			showLoginPage();
		}
	}

	// Ridisegna il form di login/registrazione quando si cambia lingua dalle bandierine
	// nella pagina di login (il form è generato con t() al render, non con data-i18n).
	document.addEventListener('i18n:change', () => {
		const authPage = document.getElementById('page-auth');
		if (authPage && authPage.classList.contains('active')) {
			authMode === 'signup' ? renderSignupForm() : showLoginPage();
		}
	});

	async function checkLiveUsername(input) {
		const username = input.value.trim();
		const statusLabel = document.getElementById('username-status');

		if (username.length < 3) {
			statusLabel.innerText = t('auth.tooShort');
			statusLabel.style.color = "orange";
			return;
		}

		if (/[<>"'`&]/.test(username)) {
			statusLabel.innerText = t('auth.noSpecialChars');
			statusLabel.style.color = "red";
			input.style.borderColor = "red";
			return;
		}

		const { data } = await supabaseClient
			.from('profiles_public')
			.select('username')
			.eq('username', username)
			.single();

		if (data) {
			statusLabel.innerText = t('auth.usernameTaken');
			statusLabel.style.color = "red";
			input.style.borderColor = "red";
		} else {
			statusLabel.innerText = t('auth.usernameAvailable');
			statusLabel.style.color = "green";
			input.style.borderColor = "green";
		}
	}

	async function handleAuth(e, mode) {
		e.preventDefault();
		const username = document.getElementById('reg-username')?.value;
		const email = document.getElementById('email').value;
		const password = document.getElementById('password').value;
		const confirm = document.getElementById('confirm')?.value;

		if (mode === 'signup' && password !== confirm) {
			showError(t('auth.passwordsMismatch'));
			return;
		}

		if (mode === 'signup' && /[<>"'`&]/.test(username || '')) {
			showError(t('auth.nicknameNoSpecialChars'));
			return;
		}

		const content = document.getElementById('authContent');
		content.innerHTML = `<div class="spinner"></div><p style="text-align: center; margin-top: 10px;">${t('auth.oneMoment')}</p>`;

		try {
			let result;
			if (mode === 'login') {
				result = await supabaseClient.auth.signInWithPassword({ email, password });
			} else {
				result = await supabaseClient.auth.signUp({ 
					email, 
					password,
					options: {
						data: { username: username }
					} 
				});
			}

			if (result.error) {
				if (result.error.message.toLowerCase().includes("profiles_username_key") ||
					result.error.message.toLowerCase().includes("unique constraint")) {
					showError(t('auth.nicknameAlreadyTaken'));
				} else if (result.error.status === 429) {
					showError(t('auth.tooManyRequests'));
				} else {
					showError(result.error.message);
				}

				if (mode === 'login') {
					showLoginPage();
				} else {
					toggleAuthMode();
					setTimeout(() => {
						if(document.getElementById('email')) document.getElementById('email').value = email;
					}, 10);
				}
				return;
			}
			// 🆕 SE È SIGNUP, MOSTRA MESSAGGIO DI CONFERMA EMAIL
if (mode === 'signup') {
	if (window.va) {
		window.va('pageview', { route: '/virtual/signup-completed' });
	}
	content.innerHTML = `
		<div style="text-align: center; padding: 30px 20px;">
			<div style="font-size: 50px; margin-bottom: 20px;">📧</div>
			<h2 style="color: var(--primary); margin-bottom: 10px;">${t('auth.confirmEmailTitle')}</h2>
			<p style="color: var(--color-text-secondary); font-size: 16px; line-height: 1.6;">
				${t('auth.confirmEmailSentTo')}<br>
				<strong style="color: var(--primary);">${email}</strong>
			</p>
			<p style="color: var(--color-text-muted); font-size: 14px; margin-top: 20px;">
				${t('auth.checkInboxAndSpam')}
			</p>
			<hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
			<p style="color: var(--color-text-secondary); font-size: 13px; margin-bottom: 20px;">
				${t('auth.didntReceiveEmail')}
			</p>
			<button onclick="toggleAuthMode()" style="background: var(--primary); color: white; border: none; padding: 12px 30px; border-radius: 10px; cursor: pointer; font-weight: bold; font-size: 14px;">
				${t('auth.backToLogin')}
			</button>
		</div>
	`;
	return;
}
			const wasGuestWithData = isGuestMode && hasGuestData();
			currentUser = result.data.user;
			isGuestMode = false;
			await initI18n();
			await showApp();
			await loadData();
			if (wasGuestWithData) {
				await migrateGuestDataToAccount(currentUser.id);
			}
			await migrateGuestAvatar(currentUser.id);
			showMessage(t('auth.welcome'));
		} catch (err) {
			showError(err.message);
		}
	}

	async function showApp() {
		document.getElementById('page-auth').classList.remove('active');
		document.getElementById('header').style.display = 'flex';
		showPage('home');
		document.getElementById('emailDisplay').textContent = isGuestMode ? t('guest.emailDisplay') : currentUser.email;
		document.getElementById('date').value = toDateStr(new Date());
		document.getElementById('time').value = nowTimeStr();
		updateGuestBanner();
		applyGuestModeUI();

		const defaultRadio = document.querySelector('input[name="g"][value="0.3"]');
		if(defaultRadio) {
			defaultRadio.parentElement.classList.add('selected');
		}

		if (isGuestMode) {
			// Funzionalità multi-utente/lato server non disponibili in modalità ospite:
			// niente luoghi salvati, promemoria, notifiche, obiettivi, pause tolleranza.
			// Achievement e best streak restano attivi ma salvati in locale (vedi checkAchievements/updateBestStreak).
			userPlaces = [];
			notifications = [];
			try { unlockedAchievements = JSON.parse(localStorage.getItem('jt_guest_achievements') || '[]'); } catch (e) { unlockedAchievements = []; }
			achievementsLoaded = true;
			renderAchievements();
			getLocationAuto();
			await loadPurchases();
			renderAvatarSettings();
			return;
		}

		// 🆕 AUTO GEOLOCALIZZAZIONE AL CARICAMENTO
	subscribeToNotifications();
	getLocationAuto();

	// Query indipendenti: eseguite in parallelo invece che una dopo l'altra,
	// così la home aspetta il round-trip più lento invece della somma di tutti.
	await Promise.all([
		loadPurchases(),
		loadUserPlaces(),
		loadReminderSettings(),
		loadNotifications(),
		loadAchievements(),
		loadBreaks(),
		loadGoal(),
		checkOnboarding(),
		// popola currentUserProfile (username + avatar_url) subito: la propria
		// riga in leaderboard/contributori usa currentUserProfile?.avatar_url,
		// altrimenti mancava finché non si apriva Impostazioni (unico altro
		// chiamante). Scrive anche il DOM Impostazioni (sempre presente, nascosto).
		loadUserProfile()
	]);
	}

	function showError(msg) {
		const content = document.getElementById('authContent');
		const errorDiv = document.createElement('div');
		errorDiv.className = 'error';
		errorDiv.textContent = msg;
		content.insertBefore(errorDiv, content.firstChild);
	}

	function showMessage(msg) {
		document.getElementById('notif').textContent = msg;
		document.getElementById('notif').style.display = 'block';
		setTimeout(() => document.getElementById('notif').style.display = 'none', 2000);
	}

	// ========== OFFLINE: rilevamento e banner ==========
function updateOnlineStatus() {
	isOnline = navigator.onLine;
	const banner = document.getElementById('offlineBanner');
	if (!banner) return;
	banner.style.display = isOnline ? 'none' : 'block';

	if (isOnline) {
		flushPendingSessions();
	}
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ========== OFFLINE: cache locale degli ultimi dati caricati ==========
function cacheLocalData(key, data) {
	try {
		localStorage.setItem('jt_cache_' + key, JSON.stringify(data));
	} catch (e) {
		console.log('Impossibile salvare cache locale:', e);
	}
}

function getLocalCache(key) {
	try {
		const raw = localStorage.getItem('jt_cache_' + key);
		return raw ? JSON.parse(raw) : null;
	} catch (e) {
		return null;
	}
}

// ========== OFFLINE: coda di sessioni non ancora sincronizzate ==========
function getPendingSessions() {
	try {
		const raw = localStorage.getItem('jt_pending_sessions');
		return raw ? JSON.parse(raw) : [];
	} catch (e) {
		return [];
	}
}

function addPendingSession(payload) {
	const pending = getPendingSessions();
	pending.push(payload);
	localStorage.setItem('jt_pending_sessions', JSON.stringify(pending));
}

async function flushPendingSessions() {
	const pending = getPendingSessions();
	if (pending.length === 0) return;

	showMessage(tn('sync.syncingSessions', pending.length));

	const stillFailed = [];
	for (const payload of pending) {
		const { error } = await supabaseClient.from('smokes').insert(payload);
		if (error) stillFailed.push(payload);
	}

	localStorage.setItem('jt_pending_sessions', JSON.stringify(stillFailed));

	if (stillFailed.length === 0) {
		showMessage(t('sync.allSynced'));
		await loadData();
	} else {
		showMessage(tn('sync.syncFailedRetry', stillFailed.length));
	}
}

	// ========== MODALITA' OSPITE: storage locale ==========
	const GUEST_MODE_KEY = 'jt_guest_mode';
	const GUEST_SMOKES_KEY = 'jt_guest_smokes';
	const GUEST_PURCHASES_KEY = 'jt_guest_purchases';

	function isGuestModeStored() {
		try { return localStorage.getItem(GUEST_MODE_KEY) === '1'; } catch (e) { return false; }
	}

	function hasGuestData() {
		return getGuestSmokes().length > 0 || getGuestPurchases().length > 0;
	}

	function getGuestSmokes() {
		try {
			const raw = localStorage.getItem(GUEST_SMOKES_KEY);
			return raw ? JSON.parse(raw) : [];
		} catch (e) { return []; }
	}

	function setGuestSmokes(arr) {
		localStorage.setItem(GUEST_SMOKES_KEY, JSON.stringify(arr));
	}

	function getGuestPurchases() {
		try {
			const raw = localStorage.getItem(GUEST_PURCHASES_KEY);
			return raw ? JSON.parse(raw) : [];
		} catch (e) { return []; }
	}

	function setGuestPurchases(arr) {
		localStorage.setItem(GUEST_PURCHASES_KEY, JSON.stringify(arr));
	}

	// Id locale univoco per record creati in guest mode: sempre positivo,
	// generato da timestamp+contatore per evitare collisioni se due salvataggi
	// capitano nello stesso millisecondo (es. tap rapidi).
	let guestIdCounter = 0;
	function genGuestId() {
		guestIdCounter++;
		return Date.now() * 1000 + (guestIdCounter % 1000);
	}

	function updateGuestBanner() {
		const banner = document.getElementById('guestModeBanner');
		if (banner) banner.style.display = isGuestMode ? 'block' : 'none';
	}

	// Mostra/nasconde le funzionalità non disponibili in modalità ospite (sessioni condivise,
	// foto, social, promemoria/push, backup) e la card di conversione account nelle Impostazioni.
	function applyGuestModeUI() {
		const setVisible = (id, visible) => {
			const el = document.getElementById(id);
			if (el) el.style.display = visible ? '' : 'none';
		};

		setVisible('sharedSessionFeature', !isGuestMode);
		setVisible('sharedSessionLocked', isGuestMode);
		setVisible('photoFeature', !isGuestMode);
		setVisible('photoLocked', isGuestMode);

		setVisible('profileCard', true);                 // sempre visibile: i guest ci scelgono un preset
		setVisible('profileIdentityBlock', !isGuestMode); // email + nickname solo per account registrati
		setVisible('guestConvertCard', isGuestMode);
		setVisible('remindersPushCard', !isGuestMode);
		setVisible('remindersPushLocked', isGuestMode);
		setVisible('backupCard', !isGuestMode);
		setVisible('backupLocked', isGuestMode);

		setVisible('socialContent', !isGuestMode);
		setVisible('socialLocked', isGuestMode);

		setVisible('galleryCard', !isGuestMode);
		setVisible('galleryLocked', isGuestMode);

		const logoutBtn = document.getElementById('logoutBtn');
		if (logoutBtn) logoutBtn.textContent = isGuestMode ? t('guest.exitToLogin') : t('settings.logout');
	}

	// Il cambio lingua ri-applica le traduzioni statiche (data-i18n) e sovrascriverebbe
	// il testo del bottone logout impostato via JS in applyGuestModeUI(): lo riallineiamo.
	document.addEventListener('i18n:change', () => applyGuestModeUI());

	async function enterGuestMode() {
		isGuestMode = true;
		try { localStorage.setItem(GUEST_MODE_KEY, '1'); } catch (e) {}
		currentUser = null;
		await initI18n();
		if (window.va) {
			window.va('pageview', { route: '/virtual/guest-mode-started' });
		}
		await showApp();
		await loadData();
	}

	// Torna alla schermata di login mantenendo i dati locali (non li cancella):
	// l'utente può rientrare in modalità ospite in qualsiasi momento e ritrovarli.
	function exitGuestMode() {
		isGuestMode = false;
		try { localStorage.removeItem(GUEST_MODE_KEY); } catch (e) {}
		smokes = [];
		purchases = [];
		updateGuestBanner();
		showLoginPage();
	}

	async function logout() {
		if (isGuestMode) {
			exitGuestMode();
			return;
		}
		await supabaseClient.auth.signOut();
		currentUser = null;
		smokes = [];
		showLoginPage();
	}

	// Porta l'utente ospite alla schermata di registrazione senza toccare i dati locali:
	// se abbandona il form può tornare in modalità ospite e ritrovare tutto.
	function startGuestConversion() {
		showLoginPage();
		toggleAuthMode();
	}

	// Chiamata dopo che l'utente, precedentemente in modalità ospite, ottiene una sessione
	// Supabase valida (signup con autologin, oppure primo login dopo conferma email).
	// Copia smokes/purchases locali su Supabase con lo user_id reale, poi ripulisce il locale
	// SOLO se tutto è andato a buon fine: in caso di errore i dati restano (duplicati temporanei
	// preferibili a una perdita) e si riprova al prossimo login.
	async function migrateGuestDataToAccount(userId) {
		if (!hasGuestData()) {
			try { localStorage.removeItem(GUEST_MODE_KEY); } catch (e) {}
			return;
		}

		const guestSmokes = getGuestSmokes();
		const guestPurchases = getGuestPurchases();

		const loadingTimer = setTimeout(() => {
			showMessage(t('guest.migrating'));
		}, 1000);

		try {
			if (guestSmokes.length > 0) {
				const payload = guestSmokes.map(({ id, ...rest }) => ({ ...rest, user_id: userId }));
				const { error } = await supabaseClient.from('smokes').insert(payload);
				if (error) throw error;
			}

			if (guestPurchases.length > 0) {
				const payload = guestPurchases.map(({ id, ...rest }) => ({ ...rest, user_id: userId }));
				const { error } = await supabaseClient.from('purchases').insert(payload);
				if (error) throw error;
			}

			// Tutto migrato con successo: ripuliamo solo i dati guest, non le preferenze (tema/lingua).
			setGuestSmokes([]);
			setGuestPurchases([]);
			try {
				localStorage.removeItem(GUEST_MODE_KEY);
				localStorage.removeItem('jt_guest_achievements');
				localStorage.removeItem('jt_guest_best_streak');
			} catch (e) {}

			clearTimeout(loadingTimer);
			showMessage(t('guest.migrationSuccess'));
			if (window.va) {
				window.va('pageview', { route: '/virtual/guest-converted' });
			}

			await loadData();
			await loadPurchases();
		} catch (err) {
			clearTimeout(loadingTimer);
			console.error('Errore migrazione dati guest:', err);
			showMessage(t('guest.migrationError'));
		}
	}

	// ========== CARICAMENTO DATI ==========
	async function loadData() {
		if (isGuestMode) {
			smokes = getGuestSmokes().slice().sort((a, b) => b.ts - a.ts);
			smokesLoaded = true;
			update({ deferHeavy: true });
			return;
		}
		const { data, error } = await supabaseClient
			.from('smokes')
			.select('*')
			.order('ts', { ascending: false });

		if (error) {
			console.error('Errore caricamento dati:', error);
			const cached = getLocalCache('smokes');
			if (cached) {
				smokes = cached;
				smokesLoaded = true;
				update({ deferHeavy: true });
				showMessage(t('sync.offlineDataStale'));
			}
			return;
		}

		smokes = data || [];
		smokesLoaded = true;
		cacheLocalData('smokes', smokes);
		update({ deferHeavy: true });
	}

	// ========== SALVATAGGIO DATI ==========
	async function saveData() {
	if (isLocatingNow) {
		if (!confirm(t('add.stillLocatingConfirm'))) return;
	}
	const hasFumo = document.getElementById("fumo").checked;
	const hasErba = document.getElementById("erba").checked;

	if (!hasFumo && !hasErba) {
		return alert(t('add.selectSmokeOrWeed'));
	}

	let fumo_grams = 0;
	let erba_grams = 0;

	if (hasFumo && hasErba) {
		fumo_grams = parseFloat(document.getElementById("fumoGramsInput").value) || 0;
		erba_grams = parseFloat(document.getElementById("erbaGramsInput").value) || 0;
		if (fumo_grams <= 0 && erba_grams <= 0) {
			return alert(t('add.enterAtLeastOneQuantity'));
		}
	} else {
		const gVal = document.querySelector('input[name="g"]:checked').value;
		const grams = gVal === "custom" ? parseFloat(document.getElementById("customGrams").value) : parseFloat(gVal);
		if(!grams || grams <= 0) return alert(t('add.enterValidWeight'));
		if (hasFumo) fumo_grams = grams; else erba_grams = grams;
	}

	const date = document.getElementById("date").value;
	const time = document.getElementById("time").value || nowTimeStr();
	const ts = Date.now();

	let finalLocationName = currentLocation.name || null;
	if (currentLocation.lat && currentLocation.lng && typeof userPlaces !== 'undefined') {
		userPlaces.forEach(p => {
			const d = getDist(currentLocation.lat, currentLocation.lng, p.latitude, p.longitude);
			if (d <= (p.radius || 50)) finalLocationName = p.name;
		});
	}

	const contextTag = document.querySelector('input[name="contextTag"]:checked')?.value || null;
	const moodRatingRaw = document.querySelector('input[name="moodRating"]:checked')?.value || '';
	const moodRating = moodRatingRaw ? parseInt(moodRatingRaw) : null;

	let photoPath = null;
	if (selectedPhotoFile && !isGuestMode) {
		if (navigator.onLine) {
			photoPath = await uploadSessionPhoto(ts);
			if (!photoPath) showMessage(t('add.photoNotUploaded'));
		} else {
			showMessage(t('add.offlinePhotoNotAttached'));
		}
	}

	const isShared = !isGuestMode && document.getElementById('sharedSessionCheck')?.checked && sessionParticipants.length > 0;

	if (isGuestMode) {
		const payload = {
			id: genGuestId(),
			type: (hasFumo && hasErba) ? "fumo-erba" : (hasFumo ? "fumo" : "erba"),
			grams: fumo_grams + erba_grams,
			fumo_grams, erba_grams,
			my_fumo_grams: fumo_grams,
			my_erba_grams: erba_grams,
			date, time, ts,
			latitude: currentLocation.lat || null,
			longitude: currentLocation.lng || null,
			location_name: finalLocationName,
			not_mine: document.getElementById("notMineCheck").checked,
			context_tag: contextTag,
			mood_rating: moodRating,
			photo_path: null,
		};
		const guestSmokes = getGuestSmokes();
		guestSmokes.push(payload);
		setGuestSmokes(guestSmokes);
	} else if (isShared) {
		const all = [{ user_id: currentUser.id }, ...sessionParticipants];
		const fumoContribs = Array.from(document.querySelectorAll('.contrib-fumo:checked')).map(el => el.value);
		const erbaContribs = Array.from(document.querySelectorAll('.contrib-erba:checked')).map(el => el.value);

		const fumoAmounts = {};
		document.querySelectorAll('.contrib-fumo-amt').forEach(el => {
			fumoAmounts[el.dataset.user] = parseFloat(el.value) || 0;
		});
		const erbaAmounts = {};
		document.querySelectorAll('.contrib-erba-amt').forEach(el => {
			erbaAmounts[el.dataset.user] = parseFloat(el.value) || 0;
		});

		const participants = all.map(p => ({
			user_id: p.user_id,
			fumo_grams: fumoContribs.includes(p.user_id) ? (fumoAmounts[p.user_id] || 0) : 0,
			erba_grams: erbaContribs.includes(p.user_id) ? (erbaAmounts[p.user_id] || 0) : 0,
			my_fumo_grams: fumo_grams,
			my_erba_grams: erba_grams,
			not_mine: !fumoContribs.includes(p.user_id) && !erbaContribs.includes(p.user_id)
		}));

		const { error } = await supabaseClient.rpc('create_shared_session', {
			p_date: date, p_time: time, p_ts: ts,
			p_latitude: currentLocation.lat || null,
			p_longitude: currentLocation.lng || null,
			p_location_name: finalLocationName,
			p_participants: participants,
			p_context_tag: contextTag,
			p_mood_rating: moodRating,
			p_photo_path: photoPath
		});

		if (error) {
			console.error('Errore salvataggio condiviso:', error);
			alert(t('add.sharedSessionSaveError'));
			return;
		}
	} else {
		const payload = {
			type: (hasFumo && hasErba) ? "fumo-erba" : (hasFumo ? "fumo" : "erba"),
			grams: fumo_grams + erba_grams,
			fumo_grams, erba_grams,
			my_fumo_grams: fumo_grams,
			my_erba_grams: erba_grams,
			date, time, ts,
			user_id: currentUser.id,
			latitude: currentLocation.lat || null,
			longitude: currentLocation.lng || null,
			location_name: finalLocationName,
			not_mine: document.getElementById("notMineCheck").checked,
			context_tag: contextTag,
			mood_rating: moodRating,
			photo_path: photoPath,
		};

		if (!navigator.onLine) {
			addPendingSession(payload);
			showMessage(t('add.offlineSessionSavedLocally'));
		} else {
			const { error } = await supabaseClient.from('smokes').insert(payload);

			if (error) {
				// rete instabile: non perdere la sessione, mettila in coda
				addPendingSession(payload);
				showMessage(t('add.unstableConnectionSavedLocally'));
			}
		}
	}

	showMessage(t('add.sessionSaved'));
	document.getElementById("fumo").checked = false;
	document.getElementById("erba").checked = false;
	document.getElementById("notMineCheck").checked = false;
	document.getElementById("notMineToggle").style.display = "none";
	document.querySelectorAll('.substance-checkbox-group label').forEach(l => l.classList.remove('selected'));
	const defaultContextTag = document.querySelector('input[name="contextTag"][value=""]');
	if (defaultContextTag) defaultContextTag.checked = true;
	document.querySelectorAll('input[name="moodRating"]').forEach(r => { r.checked = false; });
	syncTagRowVisual('contextTag');
	syncTagRowVisual('moodRating');
	clearSelectedPhoto();
	sessionParticipants = [];
	document.getElementById('sharedSessionCheck').checked = false;
	document.getElementById('sharedSessionPanel').style.display = 'none';
	renderParticipantChips();
	
	await loadData();
	getLocationAuto();

	// Dopo loadData(): "smokes" è fresco, così runBreakDetection() (chiamata da loadBreaks()
	// dentro handleSessionLoggedForBreaks) calcola il gap sull'ultima sessione vera, non su
	// dati stantii che potrebbero far ricreare erroneamente una pausa appena chiusa.
	if (!isGuestMode) {
		await handleSessionLoggedForBreaks(date);
	}
}
	async function deleteItem(ts) {
		if(!confirm(t('history.confirmDeleteEntry'))) return;

		if (isGuestMode) {
			setGuestSmokes(getGuestSmokes().filter(s => s.ts !== ts));
			await loadData();
			return;
		}

		const { error } = await supabaseClient.from('smokes').delete().eq('ts', ts);

		if (error) {
			console.error('Errore eliminazione:', error);
			return;
		}

		await loadData();
	}

	// 1. Funzione per salvare un nuovo posto preferito
async function addNewPlace() {
    const nameInput = document.getElementById('newPlaceName');
    const name = nameInput.value.trim();
    
    if (!name) {
        return alert(t('places.enterPlaceName'));
    }

    if (!currentLocation.lat || !currentLocation.lng) {
        return alert(t('places.needGpsFirst'));
    }

    const { error } = await supabaseClient.from('places').insert({
        name: name,
        latitude: currentLocation.lat,
        longitude: currentLocation.lng,
        user_id: currentUser.id
    });

    if (error) {
        console.error('Errore salvataggio posto:', error);
        alert(t('places.saveError'));
    } else {
        nameInput.value = "";
        showMessage(t('places.saved'));
        await loadUserPlaces(); // Ricarica la lista per vederlo subito
    }
}

	function toggleAdvancedSearch() {
    const panel = document.getElementById('advancedPlaceSearch');
    const btn = document.getElementById('btnToggleAdvanced');
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
    btn.textContent = isVisible ? t('places.searchOnMap') : t('places.closeMap');
    if (!isVisible) {
        loadMapLibs().then(() => setTimeout(() => initAddPlaceMap(), 150));
    }
}

	
// 2. Funzione per caricare i posti dal database
async function loadUserPlaces() {
    if (!currentUser) return;
    
    const { data, error } = await supabaseClient
        .from('places')
        .select('*')
        .order('name', { ascending: true });

    if (!error) {
        userPlaces = data || [];
        renderUserPlaces();
    }
}

// 3. Funzione per mostrare la lista nell'interfaccia
function renderUserPlaces() {
    const list = document.getElementById('userPlacesList');
    if (!list) return;

    if (userPlaces.length === 0) {
        list.innerHTML = `<p style="font-size: 12px; color: var(--color-text-muted); text-align: center;">${t('places.noPlacesSaved')}</p>`;
        return;
    }

    list.innerHTML = userPlaces.map(p => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(var(--overlay-rgb),0.05); border-radius: 8px; margin-bottom: 5px;">
            <span style="font-size: 14px; font-weight: 500;">${p.name}</span>
            <button onclick="deletePlace(${p.id})" style="background: none; border: none; color: var(--danger); cursor: pointer; font-size: 16px;">🗑️</button>
        </div>
    `).join('');
}

// 4. Funzione per eliminare un posto
async function deletePlace(id) {
    if (!confirm(t('places.confirmDeletePlace'))) return;

    const { error } = await supabaseClient
        .from('places')
        .delete()
        .eq('id', id);

    if (!error) {
        await loadUserPlaces();
    }
}

	// ========== GEOLOCALIZZAZIONE ==========
	function getLocation() {
		if (!navigator.geolocation) {
			alert(t('places.geolocationNotSupported'));
			return;
		}

		const btn = event.target;
		btn.disabled = true;
		btn.textContent = t('places.locatingShort');
		showMessage(t('add.searchingLocation'));

		navigator.geolocation.getCurrentPosition(
			async (position) => {
				const lat = position.coords.latitude;
				const lng = position.coords.longitude;

				currentLocation = { lat, lng, name: null };

				const displayEl = document.getElementById('locationDisplay');
				if (displayEl) {
					displayEl.value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
				}

				try {
					const response = await fetch(
						`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`
					);
					const data = await response.json();

					if (data.address) {
						const city = data.address.city || data.address.town || data.address.village || t('places.unknownLocation');
						currentLocation.name = city;
						if (displayEl) {
							displayEl.value = city;
						}
					}
				} catch (err) {
					console.log("Reverse geocoding non disponibile");
				}

				showMessage(t('places.locationSaved'));
				btn.disabled = false;
				btn.textContent = t('add.getLocation');
			},
			(error) => {
				console.error("Errore geolocalizzazione:", error);
				alert(t('places.locationError', { message: error.message }));
				btn.disabled = false;
				btn.textContent = t('add.getLocation');
			}
		);
	}
function getLocationAuto() {
	if (!navigator.geolocation) {
		return;
	}

	// 🆕 MOSTRA CHE STA CERCANDO
	const displayEl = document.getElementById('locationDisplay');
	displayEl.value = t('add.searchingLocation');
	displayEl.style.color = "#FF9800";

	navigator.geolocation.getCurrentPosition(
		async (position) => {
			const lat = position.coords.latitude;
			const lng = position.coords.longitude;

			currentLocation = { lat, lng, name: null };
			displayEl.value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
			displayEl.style.color = "#2e7d32"; // Verde quando trovata

			let recognizedPlace = null;
if (userPlaces && userPlaces.length > 0) {
    userPlaces.forEach(p => {
        const d = getDist(lat, lng, p.latitude, p.longitude);
        if (d <= 50) {
            recognizedPlace = p.name;
        }
    });
}

if (recognizedPlace) {
    currentLocation.name = recognizedPlace;
    displayEl.value = "📍 " + recognizedPlace;
    displayEl.style.color = "#2e7d32";
} else {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`
        );
        const data = await response.json();

        if (data.address) {
            const city = data.address.city || data.address.town || data.address.village || t('places.locationFallback');
            currentLocation.name = city;
            displayEl.value = city;
        }
    } catch (err) {
        console.log("Reverse geocoding non disponibile");
    }
}
		},
		(error) => {
			displayEl.value = t('places.locatingError'); // Rosso se errore
			displayEl.style.color = "#ff3b30";
			console.log("Geolocalizzazione: " + error.message);
		}
	);
}

	function getDist(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Raggio Terra in metri
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

	
	async function fixOldSessions() {
    const statusEl = document.getElementById('fixStatus');
    statusEl.textContent = t('places.checkingInProgress');

    if (userPlaces.length === 0) {
        statusEl.textContent = t('places.noPlacesForReference');
        return;
    }

    let updated = 0;
    let toUpdate = [];

    smokes.forEach(s => {
        if (!s.latitude || !s.longitude) return;

        userPlaces.forEach(p => {
            const d = getDist(s.latitude, s.longitude, p.latitude, p.longitude);
            if (d <= 50 && s.location_name !== p.name) {
                toUpdate.push({ id: s.id, newName: p.name });
            }
        });
    });

    if (toUpdate.length === 0) {
        statusEl.textContent = t('places.noSessionsToUpdate');
        return;
    }

    for (const item of toUpdate) {
        const { error } = await supabaseClient
            .from('smokes')
            .update({ location_name: item.newName })
            .eq('id', item.id);

        if (!error) updated++;
    }

    await loadData();
    statusEl.textContent = tn('places.sessionsUpdated', updated);
    showMessage(tn('places.sessionsUpdated', updated));
}

	let addPlaceMapInstance = null;
let addPlaceMarker = null;
let selectedPinLocation = { lat: null, lng: null };

function initAddPlaceMap() {
    if (addPlaceMapInstance) return; // già inizializzata

    addPlaceMapInstance = L.map('addPlaceMap').setView([45.07, 7.68], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(addPlaceMapInstance);

    // Click sulla mappa → piazza il pin
    addPlaceMapInstance.on('click', function(e) {
        placePin(e.latlng.lat, e.latlng.lng);
    });
}

function placePin(lat, lng) {
    if (addPlaceMarker) addPlaceMapInstance.removeLayer(addPlaceMarker);

    addPlaceMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            html: `<div style="background:#2e7d32; width:32px; height:32px; border-radius:50%; 
                              display:flex; align-items:center; justify-content:center; 
                              font-size:18px; border:3px solid white; 
                              box-shadow:0 2px 8px rgba(0,0,0,0.3);">📌</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        })
    }).addTo(addPlaceMapInstance);

    selectedPinLocation = { lat, lng };
    document.getElementById('selectedPinInfo').style.display = 'block';
    document.getElementById('selectedPinInfo').textContent = `📌 ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    document.getElementById('btnSaveFromMap').style.display = 'block';
}

async function searchAddress() {
    const query = document.getElementById('searchAddressInput').value.trim();
    if (!query) return alert(t('places.enterAddress'));

    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`
        );
        const data = await response.json();

        if (!data || data.length === 0) {
            return alert(t('places.addressNotFound'));
        }

        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);

        addPlaceMapInstance.setView([lat, lng], 17);
        placePin(lat, lng);

        document.getElementById('selectedPinInfo').textContent = `📌 ${data[0].display_name.split(',').slice(0,3).join(',')}`;
    } catch (err) {
        alert(t('places.searchError'));
    }
}

async function addPlaceFromMap() {
    const name = document.getElementById('newPlaceName').value.trim();
    if (!name) return alert(t('places.enterPlaceNameFirst'));
    if (!selectedPinLocation.lat) return alert(t('places.selectPointFirst'));

    const { error } = await supabaseClient.from('places').insert({
        name: name,
        latitude: selectedPinLocation.lat,
        longitude: selectedPinLocation.lng,
        user_id: currentUser.id
    });

    if (error) {
        alert(t('places.saveError'));
    } else {
        document.getElementById('newPlaceName').value = "";
        document.getElementById('searchAddressInput').value = "";
        document.getElementById('selectedPinInfo').style.display = 'none';
        document.getElementById('btnSaveFromMap').style.display = 'none';
        if (addPlaceMarker) addPlaceMapInstance.removeLayer(addPlaceMarker);
        selectedPinLocation = { lat: null, lng: null };
        showMessage(t('places.saved'));
        await loadUserPlaces();
    }
}
	
	// ========== NAVIGAZIONE PAGINE ==========
	function showPage(p) {
		document.querySelectorAll(".page").forEach(pg => pg.classList.remove("active"));
		document.getElementById("page-" + p).classList.add("active");

		document.querySelectorAll(".menu-content button").forEach(btn => btn.classList.remove("active-tab"));
		const pageToIndex = { 'home': 0, 'add': 1, 'history': 2, 'gallery': 3, 'stats': 4, 'goals': 5, 'charts': 6, 'map': 7, 'social': 8, 'stock': 9, 'settings': 10 };
		const activeBtn = document.querySelectorAll(".menu-content button")[pageToIndex[p]];
		if(activeBtn) activeBtn.classList.add("active-tab");

		refreshPageDynamicContent(p);
	}

	// Ricarica i dati/render dinamici di una pagina. Estratto da showPage() così può essere
	// richiamato anche al cambio lingua, per aggiornare il testo generato via JS senza reload.
	function refreshPageDynamicContent(p) {
		if (p === 'gallery' && !isGuestMode) loadGallery();

		if (p === 'map') {
			loadUserPlaces();
			loadMapLibs().then(() => {
				setTimeout(() => {
					initMap();
					updateMap();
				}, 100);
			});
		}

		if (p === 'social' && !isGuestMode) {
			loadSocial();
			loadFriendRequests();
			const feedOpen = !feedCollapsedPref();
			toggleSnapshotFeed(feedOpen);
			if (feedOpen) loadFeed(); // lazy: se la sezione è chiusa il feed si carica solo all'apertura
		}
		if (p === 'stock' || p === 'charts') loadPurchases();
		if (p === 'charts') loadChartJs().then(renderCharts);
		if (p === 'settings') {
		    applyGuestModeUI();
		    if (!isGuestMode) {
		        loadUserProfile();
		        loadReminderSettings();
		        loadPushDevices();
		        loadBackupStatus();
		    }
		}
		update();
	}

	function getCurrentPageName() {
		const activePage = document.querySelector('.page.active');
		return activePage ? activePage.id.replace('page-', '') : null;
	}

	document.addEventListener('i18n:change', () => {
		const p = getCurrentPageName();
		if (p && p !== 'auth') refreshPageDynamicContent(p);
		if (document.getElementById('tutorialModal')?.style.display === 'flex') renderTutorialStep();
	});

	// ========== CARICAMENTO LAZY: Leaflet/MarkerCluster e Chart.js ==========
	// Non sono in index.html: pesano ~174 KiB e servono solo nelle pagine Mappa/Grafici.
	// Le funzioni sotto li iniettano a runtime la prima volta che servono davvero, e
	// mantengono in cache la stessa Promise così le chiamate successive sono no-op.
	function loadScriptOnce(src) {
		return new Promise((resolve, reject) => {
			const s = document.createElement('script');
			s.src = src;
			s.onload = resolve;
			s.onerror = () => reject(new Error('Impossibile caricare ' + src));
			document.head.appendChild(s);
		});
	}

	function loadStyleOnce(href) {
		return new Promise((resolve, reject) => {
			const l = document.createElement('link');
			l.rel = 'stylesheet';
			l.href = href;
			l.onload = resolve;
			l.onerror = () => reject(new Error('Impossibile caricare ' + href));
			document.head.appendChild(l);
		});
	}

	let _mapLibsPromise = null;
	function loadMapLibs() {
		if (_mapLibsPromise) return _mapLibsPromise;
		_mapLibsPromise = Promise.all([
			loadStyleOnce('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'),
			loadStyleOnce('https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css'),
			loadStyleOnce('https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css')
		])
			.then(() => loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'))
			.then(() => loadScriptOnce('https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js'));
		return _mapLibsPromise;
	}

	let _chartJsPromise = null;
	function loadChartJs() {
		if (typeof Chart !== 'undefined') return Promise.resolve();
		if (_chartJsPromise) return _chartJsPromise;
		_chartJsPromise = loadScriptOnce('https://cdn.jsdelivr.net/npm/chart.js');
		return _chartJsPromise;
	}

	// ========== MAPPA (CORRETTA DAL PRIMO CODICE) ==========
	let markerClusterGroup = null; // Aggiungi questa variabile globale all'inizio

function initMap() {
    if (mapInstance) mapInstance.remove();
    mapInstance = L.map('mapContainer').setView([45.46, 9.19], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
        attribution: '© OpenStreetMap'
    }).addTo(mapInstance);

    // Inizializziamo il gruppo di cluster
    markerClusterGroup = L.markerClusterGroup();
    mapInstance.addLayer(markerClusterGroup);
}

function updateMap() {
    if (!mapInstance) initMap();
    
    markerClusterGroup.clearLayers();
    
    const filter = document.querySelector('input[name="mapFilter"]:checked').value;
    let filteredSmokes = smokes;
    
    if (filter === 'fumo') filteredSmokes = smokes.filter(s => s.fumo_grams > 0);
    else if (filter === 'erba') filteredSmokes = smokes.filter(s => s.erba_grams > 0);

    const savedPlaceNames = userPlaces.map(p => p.name);
    
    const grouped = {};
    const singles = [];

    filteredSmokes.forEach(s => {
        if (!s.latitude || !s.longitude) return;

        if (s.location_name && savedPlaceNames.includes(s.location_name)) {
            if (!grouped[s.location_name]) {
                grouped[s.location_name] = {
                    name: s.location_name,
                    lat: s.latitude,
                    lng: s.longitude,
                    count: 0,
                    grams: 0
                };
            }
            grouped[s.location_name].count++;
            grouped[s.location_name].grams += personalGrams(s);
        } else {
            singles.push(s);
        }
    });

    let totalCount = 0;
    let totalGrams = 0;
    let bounds = L.latLngBounds();

    // Marker raggruppati per posti salvati (etichetta verde)
    Object.values(grouped).forEach(place => {
        const markerEl = L.divIcon({
            html: `<div style="background: #2e7d32; min-width: 50px; padding: 6px 10px; border-radius: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; color: white; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 2px solid white; text-align: center; white-space: nowrap;">
                🌿 ${place.name}<br>
                <span style="font-size: 11px; font-weight: normal;">${place.count}x · ${place.grams.toFixed(1)}g</span>
            </div>`,
            iconSize: null,
            iconAnchor: [25, 20]
        });

        const marker = L.marker([place.lat, place.lng], { icon: markerEl })
            .bindPopup(`<strong>📍 ${place.name}</strong><br>${t('places.sessionsPopup', { count: place.count })}<br>${t('places.totalPopup', { grams: place.grams.toFixed(1) })}`);

        markerClusterGroup.addLayer(marker);
        bounds.extend([place.lat, place.lng]);
        totalCount += place.count;
        totalGrams += place.grams;
    });

    // Marker singoli normali (cerchio colorato con emoji)
    singles.forEach(s => {
        let color, icon;
        if (s.type === 'fumo-erba') { color = '#66BB6A'; icon = '🍫🍃'; }
        else if (s.type === 'erba') { color = '#4CAF50'; icon = '🍃'; }
        else { color = '#8B4513'; icon = '🍫'; }

        const markerEl = L.divIcon({
            html: `<div style="background: ${color}; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 3px solid white;">${icon}</div>`,
            iconSize: [40, 40]
        });

        const marker = L.marker([s.latitude, s.longitude], { icon: markerEl })
            .bindPopup(`<strong>${s.location_name || t('places.locationFallback')}</strong><br>${s.date} ${s.time}<br>${parseFloat(personalGrams(s).toFixed(2))}g`);

        markerClusterGroup.addLayer(marker);
        bounds.extend([s.latitude, s.longitude]);
        totalCount++;
        totalGrams += personalGrams(s);
    });

    if (totalCount > 0) {
        mapInstance.fitBounds(bounds, { padding: [50, 50] });
    }

    document.getElementById('mapStats').innerHTML = `
        <div class="stat-box"><big>${totalCount}</big><small>${t('places.statSessions')}</small></div>
        <div class="stat-box"><big>${totalGrams.toFixed(1)}g</big><small>${t('places.statTotal')}</small></div>
    `;
}

	// ========== AGGIORNAMENTO GENERALE ==========
	// opts.deferHeavy: true solo dal primo caricamento dati (vedi loadData()). Il rendering
	// visibile subito in Home parte comunque sincrono; il resto (registro, grafici, insight...)
	// non è ancora visibile a quel punto e viene rimandato a dopo il first paint con
	// requestIdleCallback, così non allunga il tempo prima che l'utente veda qualcosa.
	function update(opts) {
		opts = opts || {};

		checkReminderBanner();
		renderHomeSummary();
		renderMiniWidget();

		const renderRest = () => {
			updateHistory();
			updateStats();
			renderCharts();
			renderPeriodComparison();
			renderInsights();
			renderContextStats();
			renderGoalCard();
			renderBreakCard();
			renderStockPage();
			if (achievementsLoaded) checkAchievements();
		};

		if (opts.deferHeavy && 'requestIdleCallback' in window) {
			requestIdleCallback(renderRest, { timeout: 1500 });
		} else {
			renderRest();
		}
	}

	// ========== HOME: riepilogo ==========
	function renderHomeSummary() {
		const greetingEl = document.getElementById('homeGreeting');
		if (!greetingEl) return;

		document.getElementById('homeHeroCard')?.classList.remove('is-loading');

		const hour = new Date().getHours();
		const greeting = hour < 6 ? t('home.greetingNight') : hour < 12 ? t('home.greetingMorning') : hour < 18 ? t('home.greetingAfternoon') : t('home.greetingEvening');
		greetingEl.textContent = greeting;

		document.getElementById('homeStreak').textContent = calculateStreak();

		const now = new Date();
		const currentMonthKey = getMonthKey(now);
		const monthSmokes = smokes.filter(s => getMonthKey(s.date) === currentMonthKey);
		const monthGrams = monthSmokes.reduce((sum, s) => sum + (s.my_fumo_grams ?? s.fumo_grams ?? 0) + (s.my_erba_grams ?? s.erba_grams ?? 0), 0);
		document.getElementById('homeMonthStat').textContent = tn('home.monthStat', monthSmokes.length, { grams: monthGrams.toFixed(1) });

		const reminderLine = document.getElementById('homeReminderLine');
		if (userReminderSettings && userReminderSettings.reminder_enabled && userReminderSettings.reminder_time) {
			reminderLine.textContent = t('home.reminderAt', { time: userReminderSettings.reminder_time.slice(0, 5) });
			reminderLine.style.display = 'inline';
		} else {
			reminderLine.style.display = 'none';
		}

		const teaserEl = document.getElementById('homeAchievementTeaser');
		if (unlockedAchievements.length > 0) {
			const lastKey = unlockedAchievements[unlockedAchievements.length - 1];
			const lastAch = ACHIEVEMENTS.find(a => a.key === lastKey);
			if (lastAch) {
				teaserEl.textContent = t('home.lastAchievement', { icon: lastAch.icon, title: achTitle(lastAch.key) });
				teaserEl.style.display = 'block';
			}
		} else {
			teaserEl.style.display = 'none';
		}
	}

// ========== HOME: stato pausa attiva ==========
// Unico punto che decide se mostrare la card home dedicata alla pausa (spec §8): legge
// activeBreak, la stessa variabile mantenuta da loadBreaks()/runBreakDetection() per
// rilevamento, notifiche e card statistiche — nessuna logica duplicata.
const BREAK_MILESTONES = [2, 7, 14, 28];

function renderHomeBreakState() {
	const normalCard = document.getElementById('homeHeroCard');
	const breakCardEl = document.getElementById('homeBreakHero');
	if (!normalCard || !breakCardEl) return;

	if (!activeBreak) {
		breakCardEl.style.display = 'none';
		normalCard.style.display = '';
		return;
	}

	normalCard.style.display = 'none';
	breakCardEl.style.display = '';

	const start = new Date(activeBreak.start_date);
	const today = new Date();
	const days = Math.max(0, Math.floor((today - start) / (1000 * 60 * 60 * 24)));

	document.getElementById('homeBreakDays').textContent = days;

	const nextMilestone = BREAK_MILESTONES.find(m => m > days);
	const prevMilestone = [...BREAK_MILESTONES].reverse().find(m => m <= days);

	const progressLabel = document.getElementById('homeBreakProgressLabel');
	const progressBar = document.getElementById('homeBreakProgressBar');
	if (nextMilestone) {
		const prevAnchor = prevMilestone || 0;
		const pct = Math.min(100, Math.round(((days - prevAnchor) / (nextMilestone - prevAnchor)) * 100));
		progressBar.style.width = pct + '%';
		progressLabel.textContent = tn('breaks.homeNextMilestone', nextMilestone - days, { days: nextMilestone - days, milestone: nextMilestone });
	} else {
		progressBar.style.width = '100%';
		progressLabel.textContent = t('breaks.homeMilestonesComplete');
	}

	document.getElementById('homeBreakMicroText').textContent = prevMilestone ? t(`breaks.milestone${prevMilestone}Short`) : t('breaks.homeJustStarted');

	const recordEl = document.getElementById('homeBreakRecord');
	const pastDurations = allBreaks
		.filter(b => b.id !== activeBreak.id && !b.attempted && b.end_date)
		.map(b => Math.ceil((new Date(b.end_date) - new Date(b.start_date)) / (1000 * 60 * 60 * 24)));
	const record = pastDurations.length ? Math.max(...pastDurations) : null;

	if (record !== null) {
		recordEl.style.display = 'block';
		recordEl.textContent = days > record
			? t('breaks.homeNewRecord', { days: record })
			: t('breaks.homeRecordGap', { days: record - days });
	} else {
		recordEl.style.display = 'none';
	}
}

// ========== TOLERANCE BREAK: notifiche milestone scientifici + check-in (spec §7/§9) ==========
// Testi basati su Hirvonen et al. 2012 (Molecular Psychiatry) e D'Souza et al. 2016
// (Biological Psychiatry: CNNI) sul recupero dei recettori CB1 — nota informativa di
// popolazione, non un consiglio medico personalizzato: disclaimer sempre incluso nel
// messaggio dei milestone scientifici. Il check-in generico usa un copy diverso, in
// rotazione, e non compare mai lo stesso giorno di un milestone (priorità al messaggio
// scientifico). Le notifiche passano dalla RPC insert_own_notification (SECURITY DEFINER,
// vedi CLAUDE.md) perché la RLS di "notifications" non concede INSERT diretto agli utenti.
const BREAK_CHECKIN_KEYS = ['breaks.checkin1', 'breaks.checkin2', 'breaks.checkin3'];

async function checkBreakNotifications(brk) {
	if (!brk) return;

	const days = Math.max(0, Math.floor((new Date() - new Date(brk.start_date)) / (1000 * 60 * 60 * 24)));
	const notified = brk.notified_milestones || [];
	// Tutti i milestone raggiunti e non ancora notificati, non solo il primo: se l'utente
	// non apre l'app per un po' e "salta" più traguardi, li recupera tutti in un colpo solo
	// invece di riceverli uno per volta nei prossimi accessi.
	const dueMilestones = BREAK_MILESTONES.filter(m => days >= m && !notified.includes(m));

	if (dueMilestones.length > 0) {
		for (const milestone of dueMilestones) {
			await insertBreakNotification(t(`breaks.milestone${milestone}`) + ' ' + t('breaks.milestoneDisclaimer'));
		}
		const updatedNotified = [...notified, ...dueMilestones];
		await supabaseClient.from('tolerance_breaks')
			.update({ notified_milestones: updatedNotified })
			.eq('id', brk.id);
		brk.notified_milestones = updatedNotified;
		return; // priorità ai messaggi scientifici: niente check-in lo stesso giorno
	}

	if (days > 0 && days % 3 === 0 && !BREAK_MILESTONES.includes(days) && brk.last_checkin_notified_day !== days) {
		const key = BREAK_CHECKIN_KEYS[(days / 3) % BREAK_CHECKIN_KEYS.length];
		await insertBreakNotification(t(key, { days }));
		await supabaseClient.from('tolerance_breaks')
			.update({ last_checkin_notified_day: days })
			.eq('id', brk.id);
		brk.last_checkin_notified_day = days;
	}
}

async function insertBreakNotification(message, type = 'tolerance_break_milestone') {
	await supabaseClient.rpc('insert_own_notification', { p_type: type, p_message: message });
}

// ========== TOLERANCE BREAK: suggerimento proattivo di pausa ==========
// A differenza del rilevamento (spec §1, reagisce a un gap già avvenuto), questo osserva
// il consumo CORRENTE: se resta sostenuto a livello moderato/pesante (stessa classificazione
// di classifyPreBreakLevel/getPeriodAverage, nessuna duplicazione) per BREAK_SUGGESTION_MIN_DAYS
// giorni consecutivi, manda un unico avviso in-app gentile (mai push, per restare leggero) e
// lo ripete al massimo ogni BREAK_SUGGESTION_REPEAT_DAYS giorni se l'utente non agisce. Lo stato
// "elevated_since"/"last_break_suggestion_at" vive su user_stats (un solo avviso alla volta,
// niente notifiche se una pausa è già attiva o pianificata — vedi il chiamante in loadBreaks()).
const BREAK_SUGGESTION_MIN_DAYS = 14;
const BREAK_SUGGESTION_REPEAT_DAYS = 21;

async function checkBreakSuggestion() {
	const today = toDateStr(new Date());
	const windowStart = shiftDateStr(today, -29);
	const level = classifyPreBreakLevel(getPeriodAverage(windowStart, today).jointsPerDay);

	const { data: stats } = await supabaseClient
		.from('user_stats')
		.select('elevated_since, last_break_suggestion_at')
		.eq('user_id', currentUser.id)
		.maybeSingle();

	if (level === 'light') {
		if (stats && stats.elevated_since) {
			await supabaseClient.from('user_stats')
				.upsert({ user_id: currentUser.id, elevated_since: null }, { onConflict: 'user_id' });
		}
		return;
	}

	if (!stats || !stats.elevated_since) {
		await supabaseClient.from('user_stats')
			.upsert({ user_id: currentUser.id, elevated_since: today }, { onConflict: 'user_id' });
		return; // primo giorno rilevato sopra soglia: aspettiamo che diventi "sostenuto"
	}

	const daysSustained = Math.floor((new Date(today) - new Date(stats.elevated_since)) / (1000 * 60 * 60 * 24));
	if (daysSustained < BREAK_SUGGESTION_MIN_DAYS) return;

	const daysSinceLastSuggestion = stats.last_break_suggestion_at
		? Math.floor((new Date() - new Date(stats.last_break_suggestion_at)) / (1000 * 60 * 60 * 24))
		: Infinity;
	if (daysSinceLastSuggestion < BREAK_SUGGESTION_REPEAT_DAYS) return;

	const key = level === 'heavy' ? 'breaks.suggestionHeavy' : 'breaks.suggestionModerate';
	await insertBreakNotification(t(key), 'break_suggestion');
	await supabaseClient.from('user_stats')
		.upsert({ user_id: currentUser.id, last_break_suggestion_at: new Date().toISOString() }, { onConflict: 'user_id' });
}

// ========== TUTORIAL PRIMO ACCESSO ==========
// title/text sono chiavi di traduzione, non testo diretto, così il tutorial resta
// coerente se l'utente cambia lingua mentre è aperto (vedi listener i18n:change).
const TUTORIAL_SLIDES = [
	{ icon: '🌿', titleKey: 'tutorial.slide1Title', textKey: 'tutorial.slide1Text' },
	{ icon: '➕', titleKey: 'tutorial.slide2Title', textKey: 'tutorial.slide2Text' },
	{ icon: '📦', titleKey: 'tutorial.slide3Title', textKey: 'tutorial.slide3Text' },
	{ icon: '📊', titleKey: 'tutorial.slide4Title', textKey: 'tutorial.slide4Text' },
	{ icon: '🎯', titleKey: 'tutorial.slide5Title', textKey: 'tutorial.slide5Text' },
	{ icon: '👥', titleKey: 'tutorial.slide6Title', textKey: 'tutorial.slide6Text' },
	{ icon: '⚙️', titleKey: 'tutorial.slide7Title', textKey: 'tutorial.slide7Text' }
];

let tutorialStep = 0;

function renderTutorialStep() {
	const slide = TUTORIAL_SLIDES[tutorialStep];
	document.getElementById('tutorialSlide').innerHTML = `
		<div style="text-align:center; padding:10px 0;">
			<div style="font-size:48px; margin-bottom:15px;">${slide.icon}</div>
			<h3 style="margin-bottom:10px;">${t(slide.titleKey)}</h3>
			<p style="color:var(--color-text-secondary); font-size:14px; line-height:1.6;">${t(slide.textKey)}</p>
		</div>
	`;

	document.getElementById('tutorialDots').innerHTML = TUTORIAL_SLIDES.map((_, i) =>
		`<span style="width:7px; height:7px; border-radius:50%; background:${i === tutorialStep ? 'var(--primary-light)' : 'rgba(var(--overlay-rgb),0.2)'};"></span>`
	).join('');

	document.getElementById('tutorialPrevBtn').style.display = tutorialStep === 0 ? 'none' : 'block';
	document.getElementById('tutorialSkipBtn').style.display = tutorialStep === TUTORIAL_SLIDES.length - 1 ? 'none' : 'block';
	document.getElementById('tutorialNextBtn').textContent = tutorialStep === TUTORIAL_SLIDES.length - 1 ? t('tutorial.start') : t('modals.tutorialNext');
}

function openTutorial() {
	tutorialStep = 0;
	renderTutorialStep();
	document.getElementById('tutorialModal').style.display = 'flex';
}

function tutorialNext() {
	if (tutorialStep < TUTORIAL_SLIDES.length - 1) {
		tutorialStep++;
		renderTutorialStep();
	} else {
		finishTutorial();
	}
}

function tutorialPrev() {
	if (tutorialStep > 0) {
		tutorialStep--;
		renderTutorialStep();
	}
}

function skipTutorial() {
	finishTutorial();
}

async function finishTutorial() {
	document.getElementById('tutorialModal').style.display = 'none';
	await supabaseClient.from('profiles').update({ onboarding_completed: true }).eq('id', currentUser.id);
}

async function checkOnboarding() {
	const { data } = await supabaseClient.from('profiles').select('onboarding_completed').eq('id', currentUser.id).single();
	if (data && data.onboarding_completed === false) {
		openTutorial();
	}
}

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

// Solo un file sotto questo prefisso (bucket pubblico "avatars") è reso come <img>.
// Qualsiasi altra URL in avatar_url degrada all'iniziale — impedisce che un valore
// manomesso (RLS permette a un utente di scrivere stringhe arbitrarie sulla propria
// riga profiles) diventi un <img src> remoto nella leaderboard di tutti gli altri.
// Vincolato anche lato DB dal CHECK profiles_avatar_url_shape.
const AVATAR_URL_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/avatars/`;

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
	} else if (typeof avatarUrl === 'string' && avatarUrl.startsWith(AVATAR_URL_PREFIX)) {
		return `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="" `
			+ `width="${px}" height="${px}" loading="lazy" referrerpolicy="no-referrer" `
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

// Migra il preset avatar da localStorage al profilo dell'utente. Chiamata
// a ogni ingresso in un account (login/signup), indipendentemente dal fatto
// che ci fossero smokes/purchases guest da migrare.
async function migrateGuestAvatar(userId) {
	const val = getGuestAvatar();
	if (!val) return;
	try {
		const { error } = await supabaseClient.from('profiles').upsert({ id: userId, avatar_url: val });
		if (error) throw error;
		// logout -> preset da guest -> login: un file avatar caricato in una
		// sessione precedente resterebbe orfano ora che avatar_url è un preset.
		// currentUser è impostato qui, quindi il guard di removeUploadedAvatarFiles passa.
		await removeUploadedAvatarFiles();
		clearGuestAvatar();
		if (currentUserProfile) currentUserProfile.avatar_url = val;
	} catch (e) {
		console.error('migrateGuestAvatar:', e); // i dati guest restano, si riprova al prossimo login
	}
}

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
		// upsert PRIMA: se fallisce, il file avatar esistente resta intatto (spec §10).
		const { error } = await supabaseClient.from('profiles').upsert({ id: currentUser.id, avatar_url: value });
		if (error) throw error;
		await removeUploadedAvatarFiles(); // solo dopo il successo: non lasciare orfana la vecchia foto
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
		// upsert PRIMA: se fallisce, il file avatar esistente resta intatto (spec §10).
		const { error } = await supabaseClient.from('profiles').upsert({ id: currentUser.id, avatar_url: null });
		if (error) throw error;
		await removeUploadedAvatarFiles(); // solo dopo il successo
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
	// Solo la leaderboard, e solo se è la pagina attiva (spec §5.3: le altre
	// superfici si aggiornano al prossimo caricamento). loadFeed() NON va chiamato
	// qui: resetta comments/commentsOpen (chiude i thread aperti) e fa un
	// get_snapshot_feed + createSignedUrls per ogni click preset.
	if (document.getElementById('page-social')?.classList.contains('active')) {
		if (typeof loadSocial === 'function') loadSocial();
	}
}

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

	// Mostrare il modal PRIMA di misurare: da display:none il viewport ha
	// clientWidth 0 -> minScale 0 -> transform NaN.
	document.getElementById('avatarCropError').style.display = 'none';
	document.getElementById('avatarCropConfirmBtn').disabled = false;
	document.getElementById('avatarCropModal').style.display = 'flex';

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
		renderAvatarSettings(); // ripristina preview (avatar corrente invariato in caso d'errore)
	}
}

function setAvatarPreviewLoading(on) {
	const preview = document.getElementById('avatarPreview');
	if (preview) preview.classList.toggle('avatar-loading', !!on);
}

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
	const otherPath = `${currentUser.id}/avatar.${ext === 'webp' ? 'jpg' : 'webp'}`;
	const contentType = ext === 'webp' ? 'image/webp' : 'image/jpeg';

	// Ordine: upload -> upsert profiles -> pulizia dell'ALTRA estensione.
	// Qualsiasi errore prima della pulizia -> throw, niente cancellato: un
	// avatar funzionante resta intatto (spec §10). upsert:true sovrascrive
	// il file con lo stesso nome; non si tocca mai il nome appena scritto.
	const up = await supabaseClient.storage.from(AVATARS_BUCKET)
		.upload(path, blob, { upsert: true, contentType });
	if (up.error) throw up.error;

	const pub = supabaseClient.storage.from(AVATARS_BUCKET).getPublicUrl(path);
	const publicUrl = `${pub.data.publicUrl}?v=${Date.now()}`;

	const { error } = await supabaseClient.from('profiles').upsert({ id: currentUser.id, avatar_url: publicUrl });
	if (error) throw error;

	// L'estensione può cambiare tra un upload e l'altro (webp<->jpg): rimuovi
	// solo il file dell'altra estensione, best-effort, dopo il successo.
	try {
		await supabaseClient.storage.from(AVATARS_BUCKET).remove([otherPath]);
	} catch (e) { /* best-effort: può non esistere */ }

	currentUserProfile = { ...(currentUserProfile || {}), avatar_url: publicUrl };
	renderAvatarSettings();
	refreshMountedAvatars();
}

// ========== FOTO SESSIONE ==========
let selectedPhotoFile = null;

// Ridimensiona lato client prima dell'upload (max 1600px sul lato lungo, JPEG q0.8):
// le foto da smartphone sono spesso 3-8MB, questo taglia drasticamente storage/banda
// senza differenza visibile nella galleria/viewer dell'app.
function compressImage(file, maxDim, quality) {
	return new Promise(resolve => {
		if (!file.type.startsWith('image/') || file.type === 'image/gif') {
			resolve(file); // GIF non tocca: la compressione via canvas perderebbe l'animazione
			return;
		}
		const img = new Image();
		const objectUrl = URL.createObjectURL(file);
		img.onload = () => {
			URL.revokeObjectURL(objectUrl);
			let { width, height } = img;
			const scale = Math.min(1, maxDim / Math.max(width, height));
			width = Math.round(width * scale);
			height = Math.round(height * scale);

			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			canvas.getContext('2d').drawImage(img, 0, 0, width, height);

			canvas.toBlob(blob => {
				if (!blob) { resolve(file); return; }
				resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
			}, 'image/jpeg', quality);
		};
		img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); }; // es. HEIC non decodificabile dal browser: carica l'originale
		img.src = objectUrl;
	});
}

async function handlePhotoSelected(event) {
	const file = event.target.files[0];
	if (!file) return;

	if (file.size > 8 * 1024 * 1024) {
		alert(t('gallery.photoTooLarge'));
		event.target.value = '';
		return;
	}

	selectedPhotoFile = await compressImage(file, 1600, 0.8);
	const reader = new FileReader();
	reader.onload = e => {
		document.getElementById('photoPreview').src = e.target.result;
		document.getElementById('photoPreviewWrap').style.display = 'block';
	};
	reader.readAsDataURL(selectedPhotoFile);
}

function clearSelectedPhoto() {
	selectedPhotoFile = null;
	document.getElementById('photoInput').value = '';
	document.getElementById('photoPreviewWrap').style.display = 'none';
	document.getElementById('photoPreview').src = '';
}

async function uploadSessionPhoto(ts) {
	if (!selectedPhotoFile) return null;
	const extMatch = /\.([a-zA-Z0-9]+)$/.exec(selectedPhotoFile.name);
	const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
	const path = `${currentUser.id}/${ts}.${ext}`;

	const { error } = await supabaseClient.storage
		.from('session-photos')
		.upload(path, selectedPhotoFile, { upsert: true, contentType: selectedPhotoFile.type || 'image/jpeg' });

	if (error) { console.error('Errore upload foto:', error); return null; }
	return path;
}

// ========== GALLERIA FOTO ==========
// Thumbnail via Supabase Image Transformations: 300x300 invece dell'originale a piena
// risoluzione. Richiede piano Pro+ (progetto attuale: Free, verificato via MCP il
// 2026-08-21) — su Free la richiesta fallirebbe sempre, aggiungendo un round-trip
// fallito ad ogni foto prima del fallback. Tenuto spento finché non si passa a Pro:
// basta girare questo flag a true (e abilitare il toggle in Storage > Settings).
const SUPABASE_IMAGE_TRANSFORMS_ENABLED = false;
const GALLERY_THUMB_TRANSFORM = { width: 300, height: 300, resize: 'cover', quality: 70 };
const GALLERY_VIEWER_TRANSFORM = { width: 1600, quality: 80 };

function transformOpts(transform) {
	return SUPABASE_IMAGE_TRANSFORMS_ENABLED ? { transform } : {};
}

async function fallbackPlainPhoto(img) {
	if (img.dataset.fallbackDone) return;
	img.dataset.fallbackDone = '1';
	const path = img.dataset.path;
	if (!path) return;
	const { data, error } = await supabaseClient.storage.from('session-photos').createSignedUrl(path, 3600);
	if (!error && data) img.src = data.signedUrl;
}

async function loadGallery() {
	const el = document.getElementById('galleryGrid');
	if (!el) return;
	el.innerHTML = '<div class="spinner"></div>';

	const withPhotos = [...smokes].filter(s => s.photo_path).sort((a, b) => b.ts - a.ts);

	if (withPhotos.length === 0) {
		el.innerHTML = `<p style="grid-column:1/-1; text-align:center; color:var(--color-text-muted); font-size:13px; padding:20px 0;">${t('gallery.noPhotosYet')}</p>`;
		return;
	}

	const paths = withPhotos.map(s => s.photo_path);
	const { data, error } = await supabaseClient.storage.from('session-photos').createSignedUrls(paths, 3600, transformOpts(GALLERY_THUMB_TRANSFORM));

	if (error || !data) {
		el.innerHTML = `<p style="grid-column:1/-1; text-align:center; color:var(--color-text-muted); font-size:13px;">${t('gallery.loadPhotosError')}</p>`;
		return;
	}

	el.innerHTML = withPhotos.map((s, i) => {
		const signed = data[i]?.signedUrl;
		if (!signed) return '';
		return `
			<div onclick="openPhotoViewer(${s.ts})" style="aspect-ratio:1; border-radius:10px; overflow:hidden; cursor:pointer; background:rgba(var(--overlay-rgb),0.08);">
				<img src="${signed}" data-path="${s.photo_path}" onerror="fallbackPlainPhoto(this)" loading="lazy" style="width:100%; height:100%; object-fit:cover; display:block;">
			</div>
		`;
	}).join('');
}

let currentViewerTs = null;

async function openPhotoViewer(ts) {
	const session = smokes.find(s => s.ts === ts);
	if (!session || !session.photo_path) return;

	currentViewerTs = ts;
	document.getElementById('photoViewerImg').removeAttribute('src'); // non src='': stringa vuota risolve all'URL della pagina e spara un error event spurio, che ora verrebbe intercettato dall'onerror di fallbackPlainPhoto
	document.getElementById('photoViewerInfo').innerHTML = `<p style="text-align:center; color:var(--color-text-muted);">${t('common.loading')}</p>`;
	document.getElementById('photoViewerDeleteBtn').style.display = 'block';
	document.getElementById('photoViewerModal').style.display = 'flex';

	const { data, error } = await supabaseClient.storage.from('session-photos').createSignedUrl(session.photo_path, 3600, transformOpts(GALLERY_VIEWER_TRANSFORM));

	if (error || !data) {
		document.getElementById('photoViewerInfo').innerHTML = `<p style="text-align:center; color:var(--danger);">${t('gallery.loadPhotoError')}</p>`;
		return;
	}

	const viewerImg = document.getElementById('photoViewerImg');
	viewerImg.dataset.path = session.photo_path;
	viewerImg.dataset.fallbackDone = '';
	viewerImg.onerror = () => fallbackPlainPhoto(viewerImg);
	viewerImg.src = data.signedUrl;
	document.getElementById('photoViewerInfo').innerHTML = `
		<strong>${formatShortDate(session.date)} · ${session.time}</strong><br>
		<span style="color:var(--color-text-muted); font-size:13px;">
			${session.type === 'fumo' ? t('common.smoke') : session.type === 'erba' ? t('common.weed') : t('common.smokeWeed')} · ${parseFloat(personalGrams(session).toFixed(2))}g
			${session.location_name ? ' · 📍 ' + session.location_name : ''}
		</span>
	`;
}

// ========== FEED ISTANTANEE (foto tue + amici) ==========
let feedItems = [];
let feedHasFriends = null; // null = sconosciuto, bool dopo il primo load

// Sezione istantanee a tendina. Stato persistito in localStorage 'jt_feed_collapsed'
// ('1' = chiusa). Default aperta. Il feed è lazy: non si carica finché la sezione
// non è aperta (evita il round-trip di get_snapshot_feed + signed URL se guardi
// solo la classifica).
function feedCollapsedPref() {
	try { return localStorage.getItem('jt_feed_collapsed') === '1'; } catch (e) { return false; }
}

function toggleSnapshotFeed(forceOpen) {
	const panel = document.getElementById('snapshotFeedPanel');
	const btn = document.getElementById('snapshotFeedToggle');
	if (!panel || !btn) return;
	const open = typeof forceOpen === 'boolean' ? forceOpen : !panel.classList.contains('open');
	panel.classList.toggle('open', open);
	btn.classList.toggle('is-open', open);
	btn.setAttribute('aria-expanded', String(open));
	try { localStorage.setItem('jt_feed_collapsed', open ? '0' : '1'); } catch (e) {}
	// apertura manuale (utente) → carica il feed se non è già stato caricato in questa visita
	if (open && typeof forceOpen !== 'boolean' && !isGuestMode && currentUser) loadFeed();
}

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
	const { data, error } = await supabaseClient
		.from('friendships')
		.select('id')
		.eq('user_id', currentUser.id)
		.eq('status', 'accepted')
		.limit(1);
	if (error) { console.error('friendships check:', error); return true; } // in dubbio, non mostrare la CTA
	return (data || []).length > 0;
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
	const avatar = avatarMarkup(it.avatar_url, it.username, 30);
	const when = formatNotifTime(Number(it.ts));
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
				<div class="feed-react">
					<button type="button" class="feed-react-btn${it.my_reaction ? ' is-active' : ''}" data-action="react-tap" data-index="${index}">
						<span class="feed-react-emoji">${it.my_reaction ? REACTION_EMOJI[it.my_reaction] : '🤍'}</span>
						<span class="feed-react-label">${it.my_reaction ? '' : t('feed.react')}</span>
					</button>
					<button type="button" class="feed-react-caret" data-action="react-palette" data-index="${index}" aria-label="${t('feed.reactionsA11y')}">⌄</button>
				</div>
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

function refreshFeedCard(index) {
	const el = document.getElementById('snapshotFeed');
	const card = el && el.querySelector(`.feed-card[data-index="${index}"]`);
	if (!card) return;
	const it = feedItems[index];
	if (!it) return;
	const wasOpen = it.commentsOpen;
	const draft = card.querySelector('.feed-comment-input')?.value;
	card.outerHTML = feedCardHtml(it, index);
	if (wasOpen && typeof toggleComments === 'function') toggleComments(index, true); // toggleComments → Task 9
	if (typeof draft === 'string' && draft !== '') {
		const input = document.querySelector(`#snapshotFeed .feed-comments[data-comments-for="${index}"] .feed-comment-input`);
		if (input) {
			input.value = draft;
			input.focus();
			input.setSelectionRange(draft.length, draft.length);
		}
	}
}

// Reazione ottimistica con rollback: applico subito in locale, poi confermo via RPC.
async function applyReaction(index, type) {
	const it = feedItems[index];
	if (!it) return;
	const prevSummary = it.reaction_summary;
	const prevMine = it.my_reaction;
	it.reaction_summary = adjustSummary(prevSummary, prevMine, type);
	it.my_reaction = type;
	refreshFeedCard(index);
	const { data, error } = await supabaseClient.rpc('set_snapshot_reaction', {
		p_snapshot_id: it.id, p_reaction_type: type
	});
	if (error) {
		it.reaction_summary = prevSummary;
		it.my_reaction = prevMine;
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
		it.reaction_summary = prevSummary;
		it.my_reaction = prevMine;
		refreshFeedCard(index);
		showMessage(t('feed.loadError'));
		return;
	}
	it.reaction_summary = data || {};
	refreshFeedCard(index);
}

// Pura: clona il summary, decrementa/rimuove oldType, incrementa newType (newType null = solo rimozione).
function adjustSummary(summary, oldType, newType) {
	const s = { ...(summary || {}) };
	if (oldType && s[oldType]) {
		s[oldType]--;
		if (s[oldType] <= 0) delete s[oldType];
	}
	if (newType) s[newType] = (s[newType] || 0) + 1;
	return s;
}

let openPalette = null; // { index, node }

function openReactionPalette(index, anchorEl) {
	closeReactionPalette();
	if (!anchorEl) return;
	const pal = document.createElement('div');
	pal.className = 'feed-palette';
	pal.setAttribute('role', 'menu');
	pal.innerHTML = REACTION_ORDER.map(k =>
		`<button type="button" class="feed-palette-btn" role="menuitem" data-react="${k}" aria-label="${t('feed.reactionName.' + k)}">${REACTION_EMOJI[k]}</button>`
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
		document.addEventListener('click', paletteOutside);
		document.addEventListener('scroll', closeReactionPalette, { once: true, capture: true });
		document.addEventListener('keydown', paletteEsc);
	}, 0);
}

function paletteOutside(e) {
	if (openPalette && !openPalette.node.contains(e.target)) closeReactionPalette();
}
function paletteEsc(e) {
	if (e.key === 'Escape') closeReactionPalette();
}
function closeReactionPalette() {
	if (!openPalette) return;
	openPalette.node.remove();
	openPalette = null;
	document.removeEventListener('keydown', paletteEsc);
	document.removeEventListener('click', paletteOutside);
	document.removeEventListener('scroll', closeReactionPalette, { capture: true });
}

let feedDelegationBound = false;
let pressTimer = null;
let pressFired = false;
let pressStart = null;

function bindFeedDelegation(el) {
	if (feedDelegationBound) return;
	feedDelegationBound = true;
	el.addEventListener('click', onFeedClick);
	el.addEventListener('keydown', onFeedKeydown);
	el.addEventListener('pointerdown', onFeedPointerDown);
	el.addEventListener('pointerup', onFeedPointerUp);
	el.addEventListener('pointercancel', cancelPress);
	el.addEventListener('pointermove', onFeedPointerMove);
}

function onFeedKeydown(e) {
	const ta = e.target.closest('.feed-comment-input');
	if (!ta) return;
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		submitComment(Number(ta.dataset.index));
	}
}

function onFeedPointerDown(e) {
	const btn = e.target.closest('[data-action="react-tap"]');
	if (!btn) return;
	if (e.target.closest('[data-action="react-palette"]')) return; // il caret lo gestisce il click
	pressFired = false;
	pressStart = { x: e.clientX, y: e.clientY };
	const index = Number(btn.dataset.index);
	const anchor = btn.closest('.feed-react');
	clearTimeout(pressTimer);
	pressTimer = setTimeout(() => {
		pressFired = true;
		openReactionPalette(index, anchor);
	}, 450);
}
function onFeedPointerMove(e) {
	if (!pressStart) return;
	if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
}
function onFeedPointerUp() {
	clearTimeout(pressTimer);
	pressTimer = null;
	pressStart = null;
}
function cancelPress() {
	clearTimeout(pressTimer);
	pressTimer = null;
	pressStart = null;
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
	if (action === 'react-palette') { openReactionPalette(index, e.target.closest('.feed-react')); return; }
	if (action === 'react-tap') {
		if (pressFired) {
			pressFired = false;
			e.stopPropagation(); // non far propagare al listener outside-click che chiuderebbe la palette appena aperta
			return;
		}
		const it = feedItems[index];
		if (!it) return;
		if (it.my_reaction) clearReaction(index); else applyReaction(index, 'heart');
		return;
	}
	if (action === 'toggle-comments') { toggleComments(index); return; }
	if (action === 'send-comment') { submitComment(index); return; }
	if (action === 'delete-comment') { removeComment(index, Number(target.dataset.commentId)); return; }
}

// ---- Commenti (thread piatto) ----
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
			${avatarMarkup(c.avatar_url, c.username, 22)}
			<div class="feed-comment-main">
				<span class="feed-comment-name">${c.is_mine ? t('feed.you') : escapeHtml(c.username || '?')}</span>
				<span class="feed-comment-body">${escapeHtml(c.body)}</span>
				<span class="feed-comment-when">${formatNotifTime(c.created_at)}</span>
				${c.is_mine ? `<button type="button" class="feed-comment-del" data-action="delete-comment" data-index="${index}" data-comment-id="${c.id}" aria-label="${t('feed.deleteCommentConfirm')}">🗑</button>` : ''}
			</div>
		</div>`).join('');
	box.innerHTML = `
		<div class="feed-comment-list">${list}</div>
		<div class="feed-comment-form">
			<textarea class="feed-comment-input" rows="1" maxlength="500" placeholder="${t('feed.commentPlaceholder')}" data-index="${index}"></textarea>
			<button type="button" class="action-btn feed-comment-send" data-action="send-comment" data-index="${index}">${t('feed.send')}</button>
		</div>`;
}

async function submitComment(index) {
	const it = feedItems[index];
	const box = document.querySelector(`#snapshotFeed .feed-comments[data-comments-for="${index}"]`);
	const input = box && box.querySelector('.feed-comment-input');
	const sendBtn = box && box.querySelector('.feed-comment-send');
	if (!it || !input) return;
	const body = input.value.trim();
	if (!body) return;
	input.disabled = true;
	if (sendBtn) sendBtn.disabled = true;
	const { data, error } = await supabaseClient.rpc('add_snapshot_comment', { p_snapshot_id: it.id, p_body: body });
	input.disabled = false;
	if (sendBtn) sendBtn.disabled = false;
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
	if (!it) return;
	it.comments = (it.comments || []).filter(c => c.id !== commentId);
	it.comment_count = Math.max(0, (it.comment_count || 1) - 1);
	renderComments(index);
	updateCommentCount(index);
}

function updateCommentCount(index) {
	const el = document.querySelector(`#snapshotFeed .feed-card[data-index="${index}"] .feed-comment-count`);
	if (el && feedItems[index]) el.textContent = feedItems[index].comment_count;
}

async function openSnapshotViewer(index) {
	const s = feedItems[index];
	if (!s) return;

	const isMe = s.user_id === currentUser.id;
	currentViewerTs = isMe ? s.ts : null;

	document.getElementById('photoViewerImg').removeAttribute('src'); // non src='': stringa vuota risolve all'URL della pagina e spara un error event spurio, che ora verrebbe intercettato dall'onerror di fallbackPlainPhoto
	document.getElementById('photoViewerInfo').innerHTML = `<p style="text-align:center; color:var(--color-text-muted);">${t('common.loading')}</p>`;
	document.getElementById('photoViewerDeleteBtn').style.display = isMe ? 'block' : 'none';
	document.getElementById('photoViewerModal').style.display = 'flex';

	const { data, error } = await supabaseClient.storage.from('session-photos').createSignedUrl(s.photo_path, 3600, transformOpts(GALLERY_VIEWER_TRANSFORM));

	if (error || !data) {
		document.getElementById('photoViewerInfo').innerHTML = `<p style="text-align:center; color:var(--danger);">${t('gallery.loadPhotoError')}</p>`;
		return;
	}

	const viewerImg = document.getElementById('photoViewerImg');
	viewerImg.dataset.path = s.photo_path;
	viewerImg.dataset.fallbackDone = '';
	viewerImg.onerror = () => fallbackPlainPhoto(viewerImg);
	viewerImg.src = data.signedUrl;
	const grams = (s.my_fumo_grams || 0) + (s.my_erba_grams || 0);
	document.getElementById('photoViewerInfo').innerHTML = `
		<strong>${isMe ? t('shared.you') : escapeHtml(s.username)}</strong> · ${formatShortDate(s.date)} · ${s.time}<br>
		<span style="color:var(--color-text-muted); font-size:13px;">
			${s.type === 'fumo' ? t('common.smoke') : s.type === 'erba' ? t('common.weed') : t('common.smokeWeed')} · ${grams.toFixed(2)}g
			${s.location_name ? ' · 📍 ' + escapeHtml(s.location_name) : ''}
		</span>
	`;
}

function closePhotoViewer() {
	document.getElementById('photoViewerModal').style.display = 'none';
	currentViewerTs = null;
}

async function deletePhotoFromViewer() {
	if (!currentViewerTs) return;

	const session = smokes.find(s => s.ts === currentViewerTs);
	if (!session || !session.photo_path) return;

	// se l'istantanea ha reazioni o commenti, avviso esplicito del cascade.
	// dal feed uso i conteggi già in memoria; dalla Galleria (feed non caricato) chiedo al server.
	let hasEngagement;
	const inFeed = feedItems.find(it => it.ts === currentViewerTs);
	if (inFeed) {
		hasEngagement = (inFeed.comment_count || 0) > 0 ||
			Object.values(inFeed.reaction_summary || {}).some(n => n > 0);
	} else {
		try {
			const { data } = await supabaseClient.rpc('snapshot_engagement_counts', { p_snapshot_id: session.id });
			const row = Array.isArray(data) ? data[0] : data;
			hasEngagement = !!row && ((row.reaction_count || 0) > 0 || (row.comment_count || 0) > 0);
		} catch {
			hasEngagement = false;
		}
	}
	const msg = hasEngagement ? t('gallery.deleteSnapshotConfirmWithEngagement') : t('gallery.deletePhotoConfirm');
	if (!confirm(msg)) return;

	await supabaseClient.storage.from('session-photos').remove([session.photo_path]);
	const { error } = await supabaseClient.from('smokes').update({ photo_path: null }).eq('ts', currentViewerTs);

	if (error) { alert(t('gallery.deletePhotoError')); return; }

	closePhotoViewer();
	showMessage(t('gallery.photoRemoved'));
	await loadData();
	await loadGallery();
	// aggiorna il feed solo se la sezione è aperta (altrimenti si ricarica alla prossima apertura)
	const feedPanel = document.getElementById('snapshotFeedPanel');
	if (typeof loadFeed === 'function' && feedPanel && feedPanel.classList.contains('open')) await loadFeed();
}

// ========== MODIFICA POSIZIONE A POSTERIORI ==========
let editingLocationTs = null;
let editLocationPicked = null; // { lat, lng, name } scelto via GPS o posto salvato

function openEditLocationModal(ts) {
	const session = smokes.find(s => s.ts === ts);
	if (!session) return;

	editingLocationTs = ts;
	editLocationPicked = null;

	document.getElementById('editLocationSessionInfo').textContent =
		t('modals.editLocationSessionInfo', { date: formatShortDate(session.date), time: session.time }) +
		(session.location_name ? t('modals.editLocationCurrent', { name: session.location_name }) : t('modals.editLocationNone'));
	document.getElementById('editLocationManualInput').value = session.location_name || '';

	const listEl = document.getElementById('editLocationPlacesList');
	if (userPlaces.length === 0) {
		listEl.innerHTML = `<p style="font-size:12px; color:var(--color-text-muted);">${t('modals.noPlacesUseGpsOrType')}</p>`;
	} else {
		listEl.innerHTML = `
			<label style="margin-top:0; font-size:12px;">${t('modals.yourSavedPlaces')}</label>
			<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
				${userPlaces.map(p => `
					<button type="button" onclick="pickSavedPlaceForEdit(${p.id})"
						style="background:rgba(76,175,80,0.12); border:1px solid rgba(76,175,80,0.3); color:var(--heading); border-radius:20px; padding:6px 12px; font-size:13px; cursor:pointer;">
						📍 ${p.name}
					</button>
				`).join('')}
			</div>
		`;
	}

	document.getElementById('editLocationModal').style.display = 'flex';
}

function closeEditLocationModal() {
	document.getElementById('editLocationModal').style.display = 'none';
	editingLocationTs = null;
	editLocationPicked = null;
}

function pickSavedPlaceForEdit(placeId) {
	const place = userPlaces.find(p => p.id === placeId);
	if (!place) return;
	editLocationPicked = { lat: place.latitude, lng: place.longitude, name: place.name };
	document.getElementById('editLocationManualInput').value = place.name;
	showMessage(t('modals.placeSelected', { name: place.name }));
}

function useCurrentLocationForEdit() {
	if (!navigator.geolocation) return alert(t('places.geolocationNotSupported'));

	showMessage(t('modals.locatingPosition'));
	navigator.geolocation.getCurrentPosition(async (position) => {
		const lat = position.coords.latitude;
		const lng = position.coords.longitude;
		let name = null;

		userPlaces.forEach(p => {
			const d = getDist(lat, lng, p.latitude, p.longitude);
			if (d <= (p.radius || 50)) name = p.name;
		});

		if (!name) {
			try {
				const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
				const data = await response.json();
				if (data.address) name = data.address.city || data.address.town || data.address.village || null;
			} catch (e) {
				console.log('Reverse geocoding non disponibile');
			}
		}

		editLocationPicked = { lat, lng, name };
		document.getElementById('editLocationManualInput').value = name || '';
		showMessage(t('modals.locationFound'));
	}, (error) => {
		alert(t('places.locationError', { message: error.message }));
	});
}

async function saveEditedLocation() {
	if (!editingLocationTs) return;
	const manualName = document.getElementById('editLocationManualInput').value.trim();

	const update = editLocationPicked
		? { latitude: editLocationPicked.lat, longitude: editLocationPicked.lng, location_name: manualName || editLocationPicked.name || null }
		: { location_name: manualName || null };

	if (isGuestMode) {
		const guestSmokes = getGuestSmokes();
		const session = guestSmokes.find(s => s.ts === editingLocationTs);
		if (session) Object.assign(session, update);
		setGuestSmokes(guestSmokes);
	} else {
		const { error } = await supabaseClient.from('smokes').update(update).eq('ts', editingLocationTs);
		if (error) { alert(t('modals.locationSaveError')); return; }
	}

	showMessage(t('modals.locationUpdated'));
	closeEditLocationModal();
	await loadData();
}

// ========== STORICO: ricerca e filtri ==========
function getFilteredHistorySmokes() {
	const query = (document.getElementById('historySearch')?.value || '').trim().toLowerCase();
	const type = document.getElementById('historyTypeFilter')?.value || 'all';
	const from = document.getElementById('historyDateFrom')?.value || '';
	const to = document.getElementById('historyDateTo')?.value || '';

	return smokes.filter(s => {
		if (type !== 'all' && s.type !== type) return false;
		if (from && s.date < from) return false;
		if (to && s.date > to) return false;
		if (query && !(s.location_name || '').toLowerCase().includes(query)) return false;
		return true;
	});
}

function isHistoryFilterActive() {
	const query = document.getElementById('historySearch')?.value || '';
	const type = document.getElementById('historyTypeFilter')?.value || 'all';
	const from = document.getElementById('historyDateFrom')?.value || '';
	const to = document.getElementById('historyDateTo')?.value || '';
	return !!(query || type !== 'all' || from || to);
}

function applyHistoryFilters() {
	const active = isHistoryFilterActive();
	const resetBtn = document.getElementById('historyFilterReset');
	if (resetBtn) resetBtn.style.display = active ? 'block' : 'none';
	const badge = document.getElementById('historyFilterBadge');
	if (badge) badge.style.display = active ? 'block' : 'none';
	updateHistory();
}

function resetHistoryFilters() {
	const search = document.getElementById('historySearch');
	const type = document.getElementById('historyTypeFilter');
	const from = document.getElementById('historyDateFrom');
	const to = document.getElementById('historyDateTo');
	if (search) search.value = '';
	if (type) type.value = 'all';
	if (from) from.value = '';
	if (to) to.value = '';
	applyHistoryFilters();
}

function toggleHistoryFilterPanel(forceOpen) {
	const panel = document.getElementById('historyFilterPanel');
	const btn = document.getElementById('historyFilterToggle');
	if (!panel || !btn) return;
	const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !panel.classList.contains('open');
	panel.classList.toggle('open', shouldOpen);
	btn.classList.toggle('is-open', shouldOpen);
	btn.setAttribute('aria-expanded', String(shouldOpen));
}

function updateHistory() {
	const hList = document.getElementById("historyList");
	hList.innerHTML = "";

	const filterActive = isHistoryFilterActive();
	const visibleSmokes = filterActive ? getFilteredHistorySmokes() : smokes;

	if (smokes.length === 0) {
		hList.innerHTML = `<p style='text-align:center; color:var(--color-text-muted);'>${t('history.noDataYet')}</p>`;
	} else if (visibleSmokes.length === 0) {
		hList.innerHTML = `<p style='text-align:center; color:var(--color-text-muted);'>${t('history.noResultsForFilters')}</p>`;
	} else {
		const months = t('common.months');
		const byYear = {};

		visibleSmokes.forEach(s => {
			const d = new Date(s.date);
			const year = d.getFullYear();
			const monthIndex = d.getMonth();
			const monthName = months[monthIndex];
			const mKey = `${monthName} ${year}`;
			
			if (!byYear[year]) byYear[year] = {};
			if (!byYear[year][mKey]) byYear[year][mKey] = {};
			if (!byYear[year][mKey][s.date]) byYear[year][mKey][s.date] = [];
			byYear[year][mKey][s.date].push(s);
		});

		// ANNI DECRESCENTI
		const years = Object.keys(byYear).sort((a, b) => b - a);

		years.forEach(year => {
			let yearGrams = 0;
			let monthsHtml = "";

			// MESI DECRESCENTI (più recente primo)
			const monthKeysWithDates = Object.keys(byYear[year]).map(mKey => {
				const firstDateOfMonth = Math.max(...Object.keys(byYear[year][mKey]).map(d => new Date(d).getTime()));
				return { mKey, firstDateOfMonth };
			});
			const monthKeys = monthKeysWithDates.sort((a, b) => b.firstDateOfMonth - a.firstDateOfMonth).map(x => x.mKey);

			monthKeys.forEach(mKey => {
				let mGrams = 0;
				let daysHtml = "";

				// GIORNI DECRESCENTI (più recente primo)
				const dayKeys = Object.keys(byYear[year][mKey]).sort((a, b) => new Date(b) - new Date(a));
				
				dayKeys.forEach(dKey => {
					const daySmokes = byYear[year][mKey][dKey];
					const dayWeight = daySmokes.reduce((sum, s) => sum + personalGrams(s), 0);
					mGrams += dayWeight;
					yearGrams += dayWeight;

					const dDisplay = formatShortDate(dKey);

					// SESSIONI DECRESCENTI PER ORA
					const sortedSmokes = [...daySmokes].sort((a, b) => b.time.localeCompare(a.time));

					let itemsHtml = sortedSmokes.map(s => `
    <div class="history-item">
        <div>
            <span style="font-weight: bold; color: var(--primary);">${s.time}</span> - <b>${s.type === 'fumo' ? '🍫' : s.type === 'erba' ? '🍃' : '🍫🍃'}</b> ${parseFloat(personalGrams(s).toFixed(2))}g
            ${s.not_mine ? `<span style="background:var(--warning-bg); color:var(--warning-text); font-size:11px; padding:1px 7px; border-radius:20px; margin-left:4px; font-weight:600;">${t('history.notMineBadge')}</span>` : ''}
            <br><small style="color: var(--color-text-muted);">${s.location_name ? `📍 ${s.location_name}` : `📍 <em>${t('history.noLocation')}</em>`} <button type="button" onclick="openEditLocationModal(${s.ts})" style="background:none; border:none; padding:0; margin:0; font:inherit; color:var(--primary-light); cursor:pointer; text-decoration:underline;">${t('history.editLink')}</button>${s.photo_path ? ` · <button type="button" onclick="openPhotoViewer(${s.ts})" style="background:none; border:none; padding:0; margin:0; font:inherit; cursor:pointer;">📷</button>` : ''}</small>
        </div>
        <button class="del-btn" onclick="deleteItem(${s.ts})">🗑️</button>
    </div>
`).join('');

					// TUTTO CHIUSO (display: none)
					daysHtml += `
						<div class="day-group">
							<div class="day-header" onclick="toggleAccordion(this)">
								<span>📅 ${dDisplay}</span>
								<span>${dayWeight.toFixed(1)}g <span class="chevron">▼</span></span>
							</div>
							<div class="day-content" style="display: none;">${itemsHtml}</div>
						</div>`;
				});

				// TUTTO CHIUSO (display: none)
				monthsHtml += `
					<div class="month-group">
						<div class="month-header" onclick="toggleAccordion(this)">
							<span>📂 ${mKey}</span>
							<span>${mGrams.toFixed(1)}g <span class="chevron">▼</span></span>
						</div>
						<div class="month-content" style="display: none;">${daysHtml}</div>
					</div>`;
			});

			// TUTTO CHIUSO (display: none)
			hList.innerHTML += `
				<div class="year-group">
					<div class="year-header" onclick="toggleAccordion(this)">
						<span>📅 ${year}</span>
						<span>${yearGrams.toFixed(1)}g <span class="chevron">▼</span></span>
					</div>
					<div class="year-content" style="display: none;">${monthsHtml}</div>
				</div>`;
		});
	}
}

	function updateStats() {
		let totF = 0, totE = 0;
smokes.forEach(s => { 
	totF += (s.my_fumo_grams ?? s.fumo_grams ?? 0);
	totE += (s.my_erba_grams ?? s.erba_grams ?? 0);
});

		document.getElementById("sFumo").innerText = totF.toFixed(2);
		document.getElementById("sErba").innerText = totE.toFixed(2);
		document.getElementById("sJTot").innerText = smokes.length;
		document.getElementById("sGTot").innerText = (totF + totE).toFixed(2);

		let diffDays = 1;
		if (smokes.length > 0) {
			const sortedSmokes = [...smokes].sort((a,b) => new Date(a.date) - new Date(b.date));
			const firstJ = new Date(sortedSmokes[0].date);
			const today = new Date();
			diffDays = Math.ceil(Math.abs(today - firstJ) / (1000 * 60 * 60 * 24)) || 1;
		}
		document.getElementById("streakFootnoteText").textContent = tn('stats.streakFootnote', diffDays, { days: diffDays });

		document.getElementById("avgDaily").innerText = (smokes.length / diffDays).toFixed(2);
		document.getElementById("avgMonthly").innerText = ((smokes.length / diffDays) * 30.44).toFixed(1);
		document.getElementById("avgYearly").innerText = ((smokes.length / diffDays) * 365.25).toFixed(1);
		document.getElementById("avgGrams").innerText = ((totF + totE) / diffDays).toFixed(2) + "g";

		const streak = calculateStreak();
		const box = document.getElementById("streakBox");
		if (streak >= 3) {
			document.getElementById("streakDays").innerText = streak;
			updateBestStreak(streak).then(best => {
				document.getElementById("bestStreak").innerText = best;
			});
			box.style.display = "grid";
		} else {
			box.style.display = "none";
		}

		updateStatsPlaces();
	}

	function calculateStreak() {
		if (smokes.length === 0) return 0;

		const days = [...new Set(smokes.map(s => s.date))].sort();
		let streak = 1;

		for (let i = days.length - 1; i > 0; i--) {
			const today = new Date(days[i]);
			const yesterday = new Date(days[i - 1]);
			today.setHours(0,0,0,0);
			yesterday.setHours(0,0,0,0);
			const diff = (today - yesterday) / (1000 * 60 * 60 * 24);
			if (diff === 1) streak++;
			else break;
		}

		const last = new Date(days[days.length - 1]);
		const now = new Date();
		last.setHours(0,0,0,0);
		now.setHours(0,0,0,0);
		const diffFromToday = (now - last) / (1000 * 60 * 60 * 24);
		if (diffFromToday > 1) return 0;

		return streak;
	}

	async function updateBestStreak(currentStreak) {
		if (isGuestMode) {
			let best = 0;
			try { best = parseInt(localStorage.getItem('jt_guest_best_streak') || '0', 10) || 0; } catch (e) {}
			if (currentStreak > best) {
				best = currentStreak;
				try { localStorage.setItem('jt_guest_best_streak', String(best)); } catch (e) {}
			}
			return best;
		}

		const { data } = await supabaseClient.from('user_stats').select('best_streak').eq('user_id', currentUser.id).maybeSingle();

		let best = data?.best_streak || 0;
		if (currentStreak > best) {
			await supabaseClient.from('user_stats').upsert({
				user_id: currentUser.id,
				best_streak: currentStreak
			}, { onConflict: 'user_id' });
			best = currentStreak;
		}
		return best;
	}

	function updateStatsPlaces() {
    const el = document.getElementById('statsPlaces');
    if (!el) return;

    // Raggruppa tutte le sessioni per location_name
    const grouped = {};
    smokes.forEach(s => {
        const name = s.location_name || t('stats.unknownPlace');
        if (!grouped[name]) grouped[name] = { j: 0, fumo: 0, erba: 0 };
        grouped[name].j++;
        grouped[name].fumo += (s.my_fumo_grams ?? s.fumo_grams ?? 0);
        grouped[name].erba += (s.my_erba_grams ?? s.erba_grams ?? 0);
    });

    if (Object.keys(grouped).length === 0) {
        el.innerHTML = `<p style="text-align:center; color:var(--color-text-muted); font-size:13px;">${t('stats.noDataWithLocation')}</p>`;
        return;
    }

    const savedNames = userPlaces.map(p => p.name);

    // Dividi in salvati e altri
    const saved = Object.entries(grouped).filter(([name]) => savedNames.includes(name));
    const others = Object.entries(grouped).filter(([name]) => !savedNames.includes(name));

    // Ordina per numero di joint decrescente
    saved.sort((a, b) => b[1].j - a[1].j);
    others.sort((a, b) => b[1].j - a[1].j);

    const renderRow = ([name, data], isSaved) => `
        <div style="display:flex; justify-content:space-between; align-items:center; 
                    padding: 12px; margin-bottom: 8px; border-radius: 12px;
                    background: ${isSaved ? 'rgba(76,175,80,0.08)' : 'rgba(var(--overlay-rgb),0.05)'};
                    border: 1px solid ${isSaved ? 'rgba(76,175,80,0.2)' : 'rgba(var(--overlay-rgb),0.07)'};">
            <div>
                <span style="font-weight:600; font-size:14px;">${isSaved ? '📍' : '🌍'} ${name}</span><br>
                <small style="color:var(--color-text-muted);">🍫 ${data.fumo.toFixed(1)}g &nbsp; 🍃 ${data.erba.toFixed(1)}g</small>
            </div>
            <div style="text-align:right;">
                <span style="font-size:18px; font-weight:700; color:var(--primary);">${data.j}</span><br>
                <small style="color:var(--color-text-muted);">${t('stats.jointUnit')}</small>
            </div>
        </div>
    `;

    let html = '';

    if (saved.length > 0) {
        html += saved.map(e => renderRow(e, true)).join('');
    }

    if (others.length > 0) {
        if (saved.length > 0) {
            html += '<hr style="margin: 12px 0;">';
        }
        html += others.map(e => renderRow(e, false)).join('');
    }

    el.innerHTML = html;
}

	function renderCharts() {
		renderCalendarHeatmap();

		// Chart.js viene caricato solo quando si apre la pagina Grafici (vedi loadChartJs()):
		// finché non è pronto, ci si ferma qui e si ridisegna quando refreshPageDynamicContent lo richiama.
		if (typeof Chart === 'undefined') return;

		Object.values(charts).forEach(c => { try { c.destroy(); } catch(e) {} });
		charts = {};

		let gramsFumo = smokes.reduce((sum, s) => sum + (s.my_fumo_grams ?? s.fumo_grams ?? 0), 0);
let gramsErba = smokes.reduce((sum, s) => sum + (s.my_erba_grams ?? s.erba_grams ?? 0), 0);

// Grafico a ciambella
const ctxPie = document.getElementById("cPie");
if (ctxPie) {
	charts.pie = new Chart(ctxPie, {
		type: 'doughnut',
		data: { 
			labels: [t('charts.labelSmoke'), t('charts.labelWeed')],
			datasets: [{ 
				data: [gramsFumo, gramsErba], 
				backgroundColor: ['#795548', '#4CAF50'] 
			}]
		},
				options: { maintainAspectRatio: false }
			});
		}

		// Grafico spesa mensile (ultimi 6 mesi)
		const ctxSpending = document.getElementById("cSpending");
		if (ctxSpending && typeof purchases !== 'undefined') {
			const monthsBack = 6;
			const monthLabels = [];
			const monthKeys = [];
			const now = new Date();

			for (let i = monthsBack - 1; i >= 0; i--) {
				const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
				const key = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
				monthKeys.push(key);
				monthLabels.push(d.toLocaleDateString(localeCode(), { month: 'short', year: '2-digit' }));
			}

			const spendingByMonth = computeMonthlySpending(monthKeys);

			charts.spending = new Chart(ctxSpending, {
				type: 'bar',
				data: {
					labels: monthLabels,
					datasets: [{
						label: t('charts.datasetSpending'),
						data: spendingByMonth,
						backgroundColor: '#9c27b0'
					}]
				},
				options: {
					maintainAspectRatio: false,
					plugins: {
						tooltip: {
							callbacks: {
								label: (ctx) => `€${ctx.parsed.y.toFixed(2)}`
							}
						}
					}
				}
			});
		}

		// Grafico ultimi 7 giorni
		const last7 = [...Array(7)].map((_,i) => { let d = new Date(); d.setDate(d.getDate()-i); return d.toISOString().split('T')[0]; }).reverse();
		const weightData = last7.map(d => smokes.filter(s => s.date === d).reduce((acc, curr) => acc + personalGrams(curr), 0));

		const ctxWeight = document.getElementById("cWeight");
		if (ctxWeight) {
			charts.weight = new Chart(ctxWeight, {
				type: 'line',
				data: { 
					labels: last7.map(d => d.slice(8)), 
					datasets: [{ 
						label: t('charts.datasetGrams'),
						data: weightData,
						borderColor: '#2e7d32', 
						backgroundColor: 'rgba(46,125,50,0.1)', 
						fill: true 
					}]
				},
				options: { maintainAspectRatio: false }
			});
		}

		// Grafico completo giornaliero
		const dailyMap = {};
		smokes.forEach(s => { if (!dailyMap[s.date]) dailyMap[s.date] = 0; dailyMap[s.date]++; });
		const sortedDates = Object.keys(dailyMap).sort();
		const dailyCounts = sortedDates.map(d => dailyMap[d]);

		const ctxDaily = document.getElementById("cDailyAll");
		if (ctxDaily) {
			charts.dailyAll = new Chart(ctxDaily, {
				type: 'line',
				data: { 
					labels: sortedDates.map(formatShortDate),
					datasets: [{
						label: t('charts.datasetJoints'),
						data: dailyCounts,
						borderColor: '#1b5e20', 
						backgroundColor: 'rgba(27,94,32,0.1)', 
						fill: true, 
						tension: 0.3 
					}]
				},
				options: { maintainAspectRatio: false }
			});
		}

		// Grafico giorni della settimana
		const weekDays = { "Domenica": 0, "Lunedì": 0, "Martedì": 0, "Mercoledì": 0, "Giovedì": 0, "Venerdì": 0, "Sabato": 0 };
		smokes.forEach(s => { 
			const d = new Date(s.date); 
			const dayIndex = d.getDay(); 
			const names = Object.keys(weekDays); 
			weekDays[names[dayIndex]]++; 
		});

		const ctxWeek = document.getElementById("cWeekDays");
		if (ctxWeek) {
			charts.week = new Chart(ctxWeek, {
				type: 'bar',
				data: {
					labels: t('common.weekdays'),
					datasets: [{
						label: t('charts.datasetJoints'),
						data: Object.values(weekDays),
						backgroundColor: '#66bb6a' 
					}]
				},
				options: { maintainAspectRatio: false }
			});
		}

		// Grafico fasce orarie
		const hours = { Notte: 0, Mattina: 0, Pomeriggio: 0, Sera: 0 };
		smokes.forEach(s => { 
			if (!s.time || typeof s.time !== "string") return; 
			const h = parseInt(s.time.split(':')[0]); 
			if(h >= 0 && h < 6) hours.Notte++;
			else if(h >= 6 && h < 12) hours.Mattina++;
			else if(h >= 12 && h < 18) hours.Pomeriggio++;
			else hours.Sera++;
		});

		const ctxTime = document.getElementById("cTime");
		if (ctxTime) {
			charts.time = new Chart(ctxTime, {
				type: 'polarArea',
				data: {
					labels: [t('charts.timeSlotNight'), t('charts.timeSlotMorning'), t('charts.timeSlotAfternoon'), t('charts.timeSlotEvening')],
					datasets: [{
						data: Object.values(hours),
						backgroundColor: ['#2c3e50','#f1c40f','#e67e22','#2980b9'] 
					}]
				},
				options: { maintainAspectRatio: false }
			});
		}
	}

	function toggleAccordion(el) {
		const content = el.nextElementSibling;
		const isVisible = content.style.display === "block";
		content.style.display = isVisible ? "none" : "block";
		const chevron = el.querySelector('.chevron');
		if (chevron) {
			chevron.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(180deg)';
		}
	}

	async function resetAll() {
		const conferma = confirm(t('settings.resetConfirmQuestion'));

		if (conferma) {
			const confirmWord = t('settings.resetConfirmWord');
			const confermaFinale = prompt(t('settings.resetConfirmPrompt', { word: confirmWord }));

			if (confermaFinale === confirmWord) {
				try {
					if (isGuestMode) {
						setGuestSmokes([]);
					} else {
						const { error } = await supabaseClient
							.from('smokes')
							.delete()
							.eq('user_id', currentUser.id);

						if (error) throw error;
					}

					showMessage(t('settings.resetDone'));
					await loadData();
					showPage('add');
				} catch (err) {
					console.error(err);
					alert(t('settings.resetError'));
				}
			} else {
				alert(t('settings.resetCancelled'));
			}
		}
	}

	// ========== SOCIAL ==========
	function switchSocialTab(tab) {
		currentSocialTab = tab;
		document.getElementById('tab-global').classList.toggle('active', tab === 'global');
		document.getElementById('tab-friends').classList.toggle('active', tab === 'friends');
		document.getElementById('tab-shared').classList.toggle('active', tab === 'shared');
		document.getElementById('sharedPeriodToggle').style.display = tab === 'shared' ? 'flex' : 'none';
		loadSocial();
	}

	function setSharedPeriod(period) {
	sharedPeriod = period;
	document.getElementById('periodMonthBtn').className = period === 'month' ? 'action-btn' : 'secondary-btn';
	document.getElementById('periodAllBtn').className = period === 'all' ? 'action-btn' : 'secondary-btn';
	loadSocial();
}

	async function loadSocial() {
		const list = document.getElementById('leaderboardList');
		if (!list) return;

		list.innerHTML = '<div class="spinner"></div>';

		if (!currentUser) {
			list.innerHTML = `<p style='text-align:center;'>${t('social.loginToSeeLeaderboard')}</p>`;
			return;
		}

		if (currentSocialTab === 'shared') {
			return loadSharedLeaderboard();
		}

		const isGlobal = currentSocialTab === 'global';
		const rpcName = isGlobal ? 'get_global_leaderboard' : 'get_friends_leaderboard';
		const params = isGlobal ? {} : { current_user_id: currentUser.id };

		try {
			const { data, error } = await supabaseClient.rpc(rpcName, params);

			if (error) {
				console.error("Errore Supabase RPC:", error);
				list.innerHTML = `<p class='error'>${t('social.fetchDataError')}</p>`;
				return;
			}

			if (!data || data.length === 0) {
				list.innerHTML = `<p style='text-align:center; padding: 20px;'>
					${isGlobal ? t('social.noGlobalData') : t('social.noFriendsAddWithNickname')}
				</p>`;
				return;
			}

			let sharedMap = {};
			if (!isGlobal) {
				const { data: sharedData } = await supabaseClient.rpc('get_all_friends_shared_stats');
				if (sharedData) {
					sharedData.forEach(s => { sharedMap[s.friend_id] = s; });
				}
			}

			list.innerHTML = data.map((u, i) => {
				const rankStr = i < 3 ? ['🥇','🥈','🥉'][i] : `#${i+1}`;
				const rankClass = i < 3 ? 'top3' : '';
				const isMe = u.user_id === currentUser.id;

				const shared = sharedMap[u.user_id];
				const sharedBadge = (!isGlobal && shared && shared.sessions_together > 0)
					? `<br><small style="color: var(--primary-light); font-weight:600;">${t('social.togetherBadge', { count: shared.sessions_together })}</small>`
					: '';

				const av = avatarMarkup(u.avatar_url, u.username, 30);

				return `
					<div class="lb-item" onclick="viewFriendStats('${u.user_id}')"
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
			}).join('');

		} catch (err) {
			console.error("Errore generico loadSocial:", err);
			list.innerHTML = `<p class='error'>${t('social.connectionError')}</p>`;
		}
	}

	async function loadSharedLeaderboard() {
		const list = document.getElementById('leaderboardList');

		try {
			const { data, error } = await supabaseClient.rpc('get_friends_shared_leaderboard', { period: sharedPeriod });

			if (error) {
				console.error("Errore leaderboard condivise:", error);
				list.innerHTML = `<p class='error'>${t('social.fetchDataError')}</p>`;
				return;
			}

			const filtered = (data || []).filter(u => u.sessions_together > 0);

			if (filtered.length === 0) {
				list.innerHTML = `<p style='text-align:center; padding: 20px;'>
					${sharedPeriod === 'month' ? t('social.noSharedSessionsMonth') : t('social.noSharedSessionsEver')}
				</p>`;
				return;
			}

			list.innerHTML = filtered.map((u, i) => {
				const rankStr = i < 3 ? ['🥇','🥈','🥉'][i] : `#${i+1}`;
				const rankClass = i < 3 ? 'top3' : '';

				return `
					<div class="lb-item" onclick="viewFriendStats('${u.friend_id}')">
						<div style="display: flex; align-items: center; gap: 8px;">
							<span class="lb-rank ${rankClass}">${rankStr}</span>
							${avatarMarkup(u.avatar_url, u.username, 30)}
							<span style="font-weight: 500;">🤝 ${escapeHtml(u.username)}</span>
						</div>
						<div style="text-align: right;">
							<span style="font-weight: bold; color: var(--primary);">${u.sessions_together}</span><br>
							<small style="color: var(--color-text-muted);">${t('social.gramsTogetherSuffix', { grams: Number(u.grams_together).toFixed(1) })}</small>
						</div>
					</div>
				`;
			}).join('');

		} catch (err) {
			console.error("Errore generico leaderboard condivise:", err);
			list.innerHTML = `<p class='error'>${t('social.connectionError')}</p>`;
		}
	}

	async function addFriend() {
		const username = document.getElementById('friendUsername').value.trim();
		if (!username) return alert(t('social.enterNickname'));

		const { error } = await supabaseClient.rpc('send_friend_request', { target_username: username });

		if (error) {
			if (error.message && error.message.includes('non trovato')) alert(t('social.userNotFound'));
			else if (error.message && error.message.includes('te stesso')) alert(t('social.cantAddYourself'));
			else if (error.message && error.message.includes('gia')) alert(t('social.requestAlreadySentOrFriends'));
			else alert(t('social.requestSendError'));
		} else {
			showMessage(t('social.requestSent'));
			document.getElementById('friendUsername').value = "";
			if(currentSocialTab === 'friends') loadSocial();
		}
	}

	async function loadFriendRequests() {
		const el = document.getElementById('friendRequestsList');
		if (!el) return;

		const { data, error } = await supabaseClient.rpc('get_pending_friend_requests');
		if (error) { console.error('Errore richieste amicizia:', error); return; }

		if (!data || data.length === 0) {
			el.style.display = 'none';
			el.innerHTML = '';
			return;
		}

		el.style.display = 'block';
		el.innerHTML = `
			<h3 style="margin-top:0;">${t('social.friendRequestsTitle')}</h3>
			${data.map(r => `
				<div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(76,175,80,0.08); border-radius:10px; margin-bottom:8px;">
					<span style="font-weight:600; font-size:14px;">👤 ${r.username}</span>
					<div style="display:flex; gap:8px;">
						<button class="action-btn" onclick="respondFriendRequest('${r.requester_id}', true)" style="margin-top:0; padding:8px 14px;">${t('social.accept')}</button>
						<button class="secondary-btn" onclick="respondFriendRequest('${r.requester_id}', false)" style="margin-top:0; padding:8px 14px;">${t('social.reject')}</button>
					</div>
				</div>
			`).join('')}
		`;
	}

	async function respondFriendRequest(requesterId, accept) {
		const { error } = await supabaseClient.rpc('respond_friend_request', { requester_id: requesterId, accept });
		if (error) { alert(t('social.respondError')); return; }

		showMessage(accept ? t('social.friendshipAccepted') : t('social.requestRejected'));
		await loadFriendRequests();
		if (currentSocialTab === 'friends') loadSocial();
	}

	let currentModalFriendId = null;

	async function viewFriendStats(targetId) {
		const { data, error } = await supabaseClient.rpc('get_friend_stats', { target_user_id: targetId });

		if (error || !data || data.length === 0) return alert(t('social.unableToLoadStats'));

		document.getElementById('modaleFumo').innerText = data[0].fumo_g.toFixed(1);
		document.getElementById('modaleErba').innerText = data[0].erba_g.toFixed(1);
		const uname = (data[0].username) || '';
		document.getElementById('modalFriendName').innerText = uname ? t('social.statsOf', { username: uname }) : t('social.stats');
		const avEl = document.getElementById('modalFriendAvatar');
		if (avEl) avEl.innerHTML = avatarMarkup(data[0].avatar_url, uname, 40);

		const { data: shared } = await supabaseClient.rpc('get_shared_stats', { target_user_id: targetId });
		const sharedEl = document.getElementById('modaleShared');
		if (sharedEl && shared && shared[0]) {
			sharedEl.innerText = t('social.sessionsTogetherLine', { count: shared[0].sessions_together, grams: Number(shared[0].grams_together).toFixed(1) });
		} else if (sharedEl) {
			sharedEl.innerText = "";
		}

		currentModalFriendId = targetId;
		const removeBtn = document.getElementById('btnRemoveFriendModal');
		if (removeBtn) removeBtn.style.display = (currentSocialTab === 'friends') ? 'block' : 'none';

		document.getElementById('friendModal').style.display = 'flex';
	}

	async function removeFriendFromModal() {
		if (!currentModalFriendId) return;
		if (!confirm(t('social.confirmRemoveFriendship'))) return;

		const { error } = await supabaseClient.rpc('remove_friend', { target_id: currentModalFriendId });
		if (error) { alert(t('social.removeFriendshipError')); return; }

		showMessage(t('social.friendshipRemoved'));
		closeFriendModal();
		loadSocial();
	}

	function closeFriendModal() {
		document.getElementById('friendModal').style.display = 'none';
	}

	// ========== PROFILO ==========
	async function updateProfile() {
		const newName = document.getElementById('usernameInput').value.trim();
		if(newName.length < 3) return alert(t('settings.nicknameMinLength'));
		if(/[<>"'`&]/.test(newName)) return alert(t('auth.nicknameNoSpecialChars'));

		const { error } = await supabaseClient
			.from('profiles')
			.upsert({ id: currentUser.id, username: newName });

		if (error) {
			alert(error.code === '23505' ? t('settings.nicknameTaken') : t('settings.profileSaveError'));
		} else {
			showMessage(t('settings.nicknameUpdated'));
			document.getElementById('usernameInput').value = "";
			loadUserProfile();
		}
	}

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


    async function loadAchievements() {
	const { data, error } = await supabaseClient
		.from('achievements_unlocked')
		.select('achievement_key');

	if (!error) {
		unlockedAchievements = (data || []).map(a => a.achievement_key);
	}

	const { count } = await supabaseClient
		.from('friendships')
		.select('id', { count: 'exact', head: true })
		.eq('user_id', currentUser.id);
	friendsCountCache = count || 0;

	achievementsLoaded = true;
	await checkAchievements();
	renderAchievements();
}

async function checkAchievements() {
	for (const ach of ACHIEVEMENTS) {
		if (unlockedAchievements.includes(ach.key)) continue;
		if (ach.check()) {
			unlockedAchievements.push(ach.key);
			if (isGuestMode) {
				try { localStorage.setItem('jt_guest_achievements', JSON.stringify(unlockedAchievements)); } catch (e) {}
			} else {
				await supabaseClient.from('achievements_unlocked').upsert({
					user_id: currentUser.id,
					achievement_key: ach.key
				}, { onConflict: 'user_id,achievement_key' });
			}
			showMessage(t('achievements.unlocked', { title: achTitle(ach.key) }));
		}
	}
	renderAchievements();
}

function renderAchievements() {
	const el = document.getElementById('achievementsList');
	if (!el) return;

	el.innerHTML = ACHIEVEMENTS.map(ach => {
		const unlocked = unlockedAchievements.includes(ach.key);
		return `
			<div style="display:flex; align-items:center; gap:12px; padding:12px; margin-bottom:8px; border-radius:12px;
						background:${unlocked ? 'rgba(76,175,80,0.1)' : 'rgba(var(--overlay-rgb),0.05)'};
						border:1px solid ${unlocked ? 'rgba(76,175,80,0.25)' : 'rgba(var(--overlay-rgb),0.07)'};
						opacity:${unlocked ? '1' : '0.5'};">
				<span style="font-size:28px; filter:${unlocked ? 'none' : 'grayscale(100%)'};">${ach.icon}</span>
				<div>
					<div style="font-weight:700; font-size:14px; color:${unlocked ? 'var(--heading)' : 'var(--color-text-muted)'};">${achTitle(ach.key)}</div>
					<div style="font-size:12px; color:var(--color-text-muted);">${achDesc(ach.key)}</div>
				</div>
			</div>
		`;
	}).join('');
}

async function loadBreaks(skipDetection) {
	if (isGuestMode) return; // tolerance break non disponibile in modalità ospite

	const { data, error } = await supabaseClient
		.from('tolerance_breaks')
		.select('*')
		.order('start_date', { ascending: false });

	if (error) { console.error('Errore caricamento pause:', error); return; }

	allBreaks = data || [];
	activeBreak = allBreaks.find(b => b.is_active) || null;
	pendingBreak = allBreaks.find(b => b.origin === 'planned' && !b.confirmed_at && !b.attempted) || null;

	if (!skipDetection) {
		const changed = await runBreakDetection();
		if (changed) { await loadBreaks(true); return; }
	}

	renderBreakCard();
	renderHomeBreakState();
	if (activeBreak) {
		await checkBreakNotifications(activeBreak);
	} else if (!pendingBreak) {
		await checkBreakSuggestion();
	}
}

// ========== TOLERANCE BREAK: soglia scalata e retrodatazione (single source of truth) ==========

// Ultima sessione registrata (qualunque data), o null. Si basa solo sulle sessioni
// registrate in "smokes", non sugli acquisti in Scorte: comprare non implica consumare.
function getLastSessionDate() {
	if (smokes.length === 0) return null;
	return smokes.reduce((max, s) => (s.date > max ? s.date : max), smokes[0].date);
}

// Regola unica di retrodatazione (spec §2), usata sia dal rilevamento automatico che dalla
// conferma di una pausa pianificata: la pausa è iniziata il giorno dopo l'ultima sessione
// REALE, non quando l'utente/sistema se ne accorge.
function computeRetroactiveStartDate(fallbackDateStr) {
	const last = getLastSessionDate();
	return last ? shiftDateStr(last, 1) : fallbackDateStr;
}

// Livello di consumo pre-pausa (spec §1, tabella soglie).
function classifyPreBreakLevel(jointsPerDay) {
	if (jointsPerDay < 1) return 'light';
	if (jointsPerDay <= 3) return 'moderate';
	return 'heavy';
}

// Soglia minima di giorni senza sessioni per classificare un gap come tolerance break,
// scalata sul consumo medio pre-pausa (media J/day sui 30gg precedenti l'ultima sessione,
// stesso metodo di getPeriodAverage()/"Real Averages" — riuso, nessuna duplicazione).
// Range da letteratura: Hirvonen et al. 2012, Molecular Psychiatry (recupero recettori CB1
// avviato entro 48h, significativo entro 7gg, quasi completo entro ~28gg in fumatori
// cronici quotidiani); D'Souza et al. 2016, Biological Psychiatry: CNNI (conferma il
// pattern di recupero rapido nei primi giorni). Letteratura di settore indica tempi di
// recupero percepito più lunghi (3-4 settimane) per utilizzatori pesanti quotidiani
// rispetto ai moderati (1-2 settimane). Nota informativa, non un consiglio medico.
function getBreakThresholdDays(jointsPerDay) {
	const level = classifyPreBreakLevel(jointsPerDay);
	if (level === 'light') return 3;
	if (level === 'moderate') return jointsPerDay <= 2 ? 4 : 5;
	if (jointsPerDay <= 5) return 5;
	if (jointsPerDay <= 7) return 6;
	return 7;
}

// Soglia applicabile a una pausa che inizia il giorno "startDateStr": stesso calcolo del
// rilevamento (media J/day sui 30gg precedenti), riusato anche per decidere a posteriori se
// una pausa già chiusa era abbastanza lunga da contare davvero (vedi handleSessionLoggedForBreaks/
// endBreak più sotto).
function getBreakThresholdForBreakStart(startDateStr) {
	const windowEnd = shiftDateStr(startDateStr, -1);
	const windowStart = shiftDateStr(windowEnd, -29);
	return getBreakThresholdDays(getPeriodAverage(windowStart, windowEnd).jointsPerDay);
}

// Confronta lo stato attuale (activeBreak/pendingBreak) con l'ultima sessione registrata e,
// se il gap supera la soglia scalata, crea o conferma una pausa nel DB. Ritorna true se ha
// scritto qualcosa (il chiamante deve ricaricare allBreaks). Unico punto che decide se un
// gap è una vera tolerance break, sia per il rilevamento automatico (spec §1) sia per la
// conferma di una pausa pianificata (spec §4) — stessa regola in entrambi i flussi.
async function runBreakDetection() {
	if (activeBreak) return false; // già una pausa attiva, niente da rilevare

	const lastSession = getLastSessionDate();
	if (!lastSession) return false;

	const todayStr = toDateStr(new Date());
	const gapDays = Math.floor((new Date(todayStr) - new Date(lastSession)) / (1000 * 60 * 60 * 24));
	const threshold = getBreakThresholdForBreakStart(shiftDateStr(lastSession, 1));

	if (gapDays < threshold) return false;

	if (pendingBreak) {
		const { error } = await supabaseClient
			.from('tolerance_breaks')
			.update({
				is_active: true,
				confirmed_at: new Date().toISOString(),
				start_date: computeRetroactiveStartDate(pendingBreak.planned_start_date || todayStr)
			})
			.eq('id', pendingBreak.id);
		return !error;
	}

	const { error } = await supabaseClient.from('tolerance_breaks').insert({
		user_id: currentUser.id,
		start_date: computeRetroactiveStartDate(todayStr),
		origin: 'auto',
		is_active: true,
		confirmed_at: new Date().toISOString()
	});
	return !error;
}

// Chiude una pausa attiva o interrompe un tentativo pianificato non ancora confermato quando
// l'utente registra una nuova sessione (spec §5 e seconda metà di §4). "date" è la data della
// sessione appena salvata (l'utente può inserire sessioni retroattive, non è sempre oggi).
//
// Caso particolare: una sessione dimenticata e aggiunta in ritardo (con data retroattiva) può
// "riempire" il buco che aveva fatto scattare il rilevamento automatico, lasciando una pausa
// chiusa quasi subito dopo essere iniziata (es. 0 giorni) — un falso positivo dovuto solo al
// ritardo con cui è stata segnata, non a una pausa vera. Se la durata finale risulta sotto la
// stessa soglia che l'avrebbe fatta scattare (getBreakThresholdForBreakStart), la eliminiamo
// invece di lasciarla come voce fantasma nello storico.
async function handleSessionLoggedForBreaks(date) {
	if (activeBreak) {
		const result = await closeOrDiscardBreak(activeBreak, date);
		if (result.discarded && !result.error) showMessage(t('breaks.discardedTooShort'));
	} else if (pendingBreak) {
		await supabaseClient
			.from('tolerance_breaks')
			.update({ attempted: true, end_date: date })
			.eq('id', pendingBreak.id);
	} else {
		return;
	}
	await loadBreaks();
}

// Chiude una pausa attiva sulla data "endDate": se la durata risultante è sotto la soglia
// che l'avrebbe qualificata come pausa vera (falso positivo, tipicamente una sessione
// dimenticata e aggiunta in ritardo — vedi sopra), la elimina invece di salvarla. Usata sia
// dalla chiusura automatica su nuova sessione sia dal tasto manuale "Interrompi pausa".
async function closeOrDiscardBreak(brk, endDate) {
	const durationDays = Math.max(0, Math.ceil((new Date(endDate) - new Date(brk.start_date)) / (1000 * 60 * 60 * 24)));
	const threshold = getBreakThresholdForBreakStart(brk.start_date);

	if (durationDays < threshold) {
		const { error } = await supabaseClient.from('tolerance_breaks').delete().eq('id', brk.id);
		return { discarded: true, error };
	}
	const { error } = await supabaseClient.from('tolerance_breaks').update({ is_active: false, end_date: endDate }).eq('id', brk.id);
	return { discarded: false, error };
}

function getAvgPricePerGram() {
	if (typeof purchases === 'undefined') return null;
	const priced = purchases.filter(p => p.price && p.grams);
	if (priced.length === 0) return null;
	const totalPrice = priced.reduce((s, p) => s + parseFloat(p.price), 0);
	const totalGrams = priced.reduce((s, p) => s + parseFloat(p.grams), 0);
	return totalGrams > 0 ? totalPrice / totalGrams : null;
}

function getAvgDailyGramsBeforeBreak(breakStartDate) {
	const before = smokes.filter(s => s.date < breakStartDate && !s.not_mine);
	if (before.length === 0) return 0;
	const totalGrams = before.reduce((s, x) => s + (x.my_fumo_grams ?? x.fumo_grams ?? 0) + (x.my_erba_grams ?? x.erba_grams ?? 0), 0);
	const dates = [...new Set(before.map(s => s.date))].sort();
	const firstDate = new Date(dates[0]);
	const lastDate = new Date(breakStartDate);
	const diffDays = Math.max(1, Math.ceil((lastDate - firstDate) / (1000 * 60 * 60 * 24)));
	return totalGrams / diffDays;
}

// ========== CONFRONTO PRIMA/DOPO PAUSA ==========

// Finestra di confronto per una pausa conclusa: pari alla durata della pausa,
// clampata tra 7 e 30 giorni. Stessa finestra usata sia per "prima" che per "dopo",
// per rendere il confronto simmetrico.
function getBreakComparisonWindowDays(startDate, endDate) {
	const durationDays = Math.max(1, Math.ceil((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)));
	return Math.min(30, Math.max(7, durationDays));
}

function shiftDateStr(dateStr, deltaDays) {
	const d = new Date(dateStr);
	d.setDate(d.getDate() + deltaDays);
	return toDateStr(d);
}

function getEarliestSmokeDate() {
	if (smokes.length === 0) return null;
	return smokes.reduce((min, s) => (s.date < min ? s.date : min), smokes[0].date);
}

// Media giornaliera (grammi e sessioni/"J") su un periodo fisso [startStr, endStr],
// estremi inclusi, dividendo sempre per il numero totale di giorni del periodo — zero
// incluso per i giorni senza sessioni registrate. Stesso metodo della card "Real Averages".
function getPeriodAverage(startStr, endStr) {
	const inRange = smokes.filter(s => !s.not_mine && s.date >= startStr && s.date <= endStr);
	const totalGrams = inRange.reduce((s, x) => s + (x.my_fumo_grams ?? x.fumo_grams ?? 0) + (x.my_erba_grams ?? x.erba_grams ?? 0), 0);
	const totalDays = Math.round((new Date(endStr) - new Date(startStr)) / (1000 * 60 * 60 * 24)) + 1;
	return {
		gramsPerDay: totalGrams / totalDays,
		jointsPerDay: inRange.length / totalDays
	};
}

function pctChange(before, after) {
	if (before <= 0) return null;
	return ((after - before) / before) * 100;
}

// Confronto prima/dopo per una tolerance break conclusa. Ritorna uno stato 'pending'
// se la finestra "dopo" non è ancora trascorsa per intero, 'insufficient_before' se
// non c'è abbastanza storico prima della pausa, altrimenti 'ready' con le medie.
function getBreakComparison(brk) {
	if (brk.attempted || !brk.end_date) return null;

	const windowDays = getBreakComparisonWindowDays(brk.start_date, brk.end_date);
	const beforeEnd = shiftDateStr(brk.start_date, -1);
	const beforeStart = shiftDateStr(brk.start_date, -windowDays);
	const afterStart = shiftDateStr(brk.end_date, 1);
	const afterEnd = shiftDateStr(brk.end_date, windowDays);

	const todayStr = toDateStr(new Date());
	if (todayStr <= afterEnd) {
		const daysRemaining = Math.ceil((new Date(afterEnd) - new Date(todayStr)) / (1000 * 60 * 60 * 24)) + 1;
		return { status: 'pending', daysRemaining };
	}

	const earliest = getEarliestSmokeDate();
	if (!earliest || earliest > beforeStart) {
		return { status: 'insufficient_before' };
	}

	const before = getPeriodAverage(beforeStart, beforeEnd);
	const after = getPeriodAverage(afterStart, afterEnd);

	return {
		status: 'ready',
		windowDays,
		before,
		after,
		gramsChangePct: pctChange(before.gramsPerDay, after.gramsPerDay),
		jointsChangePct: pctChange(before.jointsPerDay, after.jointsPerDay)
	};
}

function renderBreakComparisonHtml(brk) {
	const cmp = getBreakComparison(brk);
	if (!cmp) return '';

	if (cmp.status === 'pending') {
		return `<div style="margin-top:6px; font-size:12px; color:var(--color-text-muted); text-align:center;">${tn('breaks.comparisonPending', cmp.daysRemaining, { days: cmp.daysRemaining })}</div>`;
	}
	if (cmp.status === 'insufficient_before') {
		return `<div style="margin-top:6px; font-size:12px; color:var(--color-text-muted); text-align:center;">${t('breaks.comparisonInsufficientData')}</div>`;
	}

	function pctBadge(pct) {
		if (pct === null) return '';
		const isSame = Math.abs(pct) < 0.5;
		const isUp = pct > 0;
		const color = isSame ? 'var(--color-text-muted)' : (isUp ? '#FF9800' : '#2196F3');
		const arrow = isSame ? '→' : (isUp ? '▲' : '▼');
		return `<span style="color:${color}; font-weight:600;">${arrow} ${Math.abs(pct).toFixed(0)}%</span>`;
	}

	const { before, after, gramsChangePct, jointsChangePct } = cmp;

	return `
		<div style="margin-top:8px; padding:10px; border-radius:10px; background:rgba(var(--overlay-rgb),0.05); font-size:12px;">
			<div style="display:flex; justify-content:space-between; color:var(--color-text-muted); margin-bottom:6px;">
				<span>${t('breaks.comparisonBefore')}</span>
				<span>${tn('breaks.comparisonWindowDays', cmp.windowDays, { days: cmp.windowDays })}</span>
				<span>${t('breaks.comparisonAfter')}</span>
			</div>
			<div style="display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:6px; font-weight:700; font-size:14px;">
				<span style="text-align:left;">${before.gramsPerDay.toFixed(2)}${t('breaks.comparisonGramsPerDay')}</span>
				<span style="text-align:center; font-size:12px;">${pctBadge(gramsChangePct)}</span>
				<span style="text-align:right;">${after.gramsPerDay.toFixed(2)}${t('breaks.comparisonGramsPerDay')}</span>
			</div>
			<div style="display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:6px; margin-top:4px; color:var(--color-text-secondary);">
				<span style="text-align:left;">${before.jointsPerDay.toFixed(2)}${t('breaks.comparisonJointsPerDay')}</span>
				<span style="text-align:center; font-size:12px;">${pctBadge(jointsChangePct)}</span>
				<span style="text-align:right;">${after.jointsPerDay.toFixed(2)}${t('breaks.comparisonJointsPerDay')}</span>
			</div>
		</div>
	`;
}

function renderBreakCard() {
	const el = document.getElementById('breakCard');
	if (!el) return;

	if (activeBreak) {
		const start = new Date(activeBreak.start_date);
		const today = new Date();
		const days = Math.max(0, Math.floor((today - start) / (1000 * 60 * 60 * 24)));

		const avgDaily = getAvgDailyGramsBeforeBreak(activeBreak.start_date);
		const pricePerGram = getAvgPricePerGram();
		const savedGrams = avgDaily * days;
		const savedMoney = pricePerGram ? (savedGrams * pricePerGram) : null;

		el.innerHTML = `
			<div style="text-align:center; padding:10px;">
				<div style="font-size:36px; font-weight:800; color:var(--primary);">${days}</div>
				<div style="font-size:13px; color:var(--color-text-secondary); margin-bottom:15px;">${t('breaks.daysWithoutSmoking')}</div>
				${savedMoney !== null ? `<div style="font-size:15px; font-weight:700; color:#9c27b0;">${t('breaks.moneySaved', { amount: savedMoney.toFixed(2) })}</div>` : ''}
				<div style="font-size:12px; color:var(--color-text-muted); margin-top:4px;">${t('breaks.gramsNotConsumed', { grams: savedGrams.toFixed(1) })}</div>
				<button class="secondary-btn" onclick="endBreak()" style="margin-top:15px;">${t('breaks.endBreak')}</button>
			</div>
		`;
	} else if (pendingBreak) {
		el.innerHTML = `
			<div style="text-align:center; padding:10px;">
				<div style="font-size:28px;">💤</div>
				<p style="font-size:13px; color:var(--color-text-secondary); margin:8px 0 4px;">${t('breaks.pendingExplain')}</p>
				<button class="secondary-btn" onclick="cancelPendingBreak()" style="margin-top:10px;">${t('breaks.cancelPending')}</button>
			</div>
		`;
	} else {
		el.innerHTML = `
			<p style="text-align:center; color:var(--color-text-muted); font-size:13px; margin-bottom:10px;">${t('breaks.noActiveBreak')}</p>
			<button class="main-btn" onclick="startBreak()" style="margin-top:0;">${t('breaks.startBreak')}</button>
		`;
	}

	renderBreakHistory();
}

function renderBreakHistory() {
	const el = document.getElementById('breakHistory');
	if (!el) return;

	const past = allBreaks.filter(b => !b.is_active && b.id !== (pendingBreak && pendingBreak.id));
	if (past.length === 0) { el.innerHTML = ''; return; }

	el.innerHTML = `<hr style="margin:15px 0;"><p style="font-size:12px; color:var(--color-text-muted); margin-bottom:8px;">${t('breaks.previousBreaks')}</p>` +
		past.map(b => {
			if (b.attempted) {
				return `<div style="padding:8px 0; border-bottom:1px solid rgba(var(--overlay-rgb),0.06); font-size:13px; color:var(--color-text-muted);">
					<div style="display:flex; justify-content:space-between;">
						<span>${t('breaks.attemptedLabel')}</span>
						<span>${formatShortDate(b.planned_start_date || b.start_date)} → ${formatShortDate(b.end_date)}</span>
					</div>
				</div>`;
			}
			const days = Math.ceil((new Date(b.end_date) - new Date(b.start_date)) / (1000 * 60 * 60 * 24));
			return `<div style="padding:8px 0; border-bottom:1px solid rgba(var(--overlay-rgb),0.06); font-size:13px;">
				<div style="display:flex; justify-content:space-between; align-items:center;">
					<span>${formatShortDate(b.start_date)} <a href="javascript:void(0)" onclick="editBreakStartDate(${b.id})" title="${t('breaks.editStartDate')}" style="opacity:0.55; text-decoration:none;">✏️</a> → ${formatShortDate(b.end_date)}</span>
					<span style="font-weight:600; color:var(--primary);">${tn('breaks.durationDays', days, { days })}</span>
				</div>
				${renderBreakComparisonHtml(b)}
			</div>`;
		}).join('');
}

async function editBreakStartDate(breakId) {
	const brk = allBreaks.find(b => b.id === breakId);
	if (!brk) return;

	const input = prompt(t('breaks.editStartDatePrompt'), brk.start_date);
	if (!input) return;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) { alert(t('breaks.editStartDateInvalid')); return; }

	const { error } = await supabaseClient
		.from('tolerance_breaks')
		.update({ start_date: input, manually_edited: true })
		.eq('id', breakId);

	if (error) { alert(t('breaks.editStartDateError')); return; }
	showMessage(t('breaks.editStartDateSaved'));
	await loadBreaks();
}

// Formatta una data locale come YYYY-MM-DD usando i componenti locali (getFullYear/getMonth/getDate),
// evitando toISOString() che converte in UTC e può far slittare il giorno di uno per i fusi orari > UTC.
function toDateStr(d) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowTimeStr() {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const HEATMAP_COLORS = ['#a5d6a7', '#4caf50', '#2e7d32', '#1b5e20'];

function renderCalendarHeatmap() {
	const el = document.getElementById('calendarHeatmap');
	if (!el) return;

	const counts = {};
	smokes.forEach(s => { counts[s.date] = (counts[s.date] || 0) + 1; });

	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const start = new Date(today);
	start.setDate(start.getDate() - 364);
	start.setDate(start.getDate() - start.getDay()); // allinea a domenica

	const monthNames = t('common.monthsShort');
	const weeks = [];
	const cursor = new Date(start);
	while (cursor <= today) {
		const week = [];
		for (let d = 0; d < 7; d++) {
			if (cursor > today) {
				week.push(null);
			} else {
				const dateStr = toDateStr(cursor);
				week.push({ date: dateStr, month: cursor.getMonth(), count: counts[dateStr] || 0 });
			}
			cursor.setDate(cursor.getDate() + 1);
		}
		weeks.push(week);
	}

	// Scala dei colori basata solo sui giorni davvero visibili nella griglia (ultimi 12 mesi),
	// non su tutto lo storico: un singolo giorno fuori finestra con tante sessioni sbiadiva
	// tutta la heatmap visibile facendola sembrare piatta.
	const visibleCounts = weeks.flat().filter(Boolean).map(d => d.count);
	const maxCount = Math.max(1, ...visibleCounts);

	function colorFor(count) {
		if (count === 0) return 'rgba(var(--overlay-rgb),0.08)';
		const ratio = count / maxCount;
		if (ratio > 0.75) return HEATMAP_COLORS[3];
		if (ratio > 0.5) return HEATMAP_COLORS[2];
		if (ratio > 0.25) return HEATMAP_COLORS[1];
		return HEATMAP_COLORS[0];
	}

	let lastMonth = null;
	const labelsHtml = weeks.map(week => {
		const firstValid = week.find(d => d);
		let label = '';
		if (firstValid && firstValid.month !== lastMonth) {
			label = monthNames[firstValid.month];
			lastMonth = firstValid.month;
		}
		// flex:0 0 11px (non solo width) evita che il testo del mese forzi la colonna ad
		// allargarsi e disallinei le colonne successive rispetto alla griglia dei giorni sotto.
		return `<div style="flex:0 0 11px; width:11px; overflow:visible; font-size:9px; color:var(--color-text-muted); white-space:nowrap;">${label}</div>`;
	}).join('');

	const gridHtml = weeks.map(week => `
		<div style="display:flex; flex:0 0 11px; flex-direction:column; gap:3px;">
			${week.map(d => d
				? `<div title="${tn('charts.heatmapTooltip', d.count, { date: formatShortDate(d.date) })}" style="width:11px; height:11px; border-radius:2px; background:${colorFor(d.count)};"></div>`
				: `<div style="width:11px; height:11px;"></div>`
			).join('')}
		</div>
	`).join('');

	el.innerHTML = `
		<div style="display:flex; gap:3px; margin-bottom:4px;">${labelsHtml}</div>
		<div style="display:flex; gap:3px;">${gridHtml}</div>
	`;

	const legend = document.getElementById('heatmapLegend');
	if (legend) {
		legend.innerHTML = ['rgba(var(--overlay-rgb),0.08)', ...HEATMAP_COLORS].map(c =>
			`<span style="width:11px; height:11px; border-radius:2px; background:${c}; display:inline-block;"></span>`
		).join('');
	}
}

// ========== OBIETTIVI PERSONALI ==========
let activeGoal = null;

async function loadGoal() {
	const { data, error } = await supabaseClient
		.from('user_goals')
		.select('*')
		.eq('is_active', true)
		.maybeSingle();

	if (error) { console.error('Errore caricamento obiettivo:', error); return; }
	activeGoal = data || null;
	renderGoalCard();
}

function getWeekStart(d) {
	const date = new Date(d);
	const day = date.getDay();
	const diff = (day === 0 ? -6 : 1) - day; // porta a lunedì
	date.setDate(date.getDate() + diff);
	date.setHours(0, 0, 0, 0);
	return date;
}

function renderGoalCard() {
	const el = document.getElementById('goalCard');
	if (!el) return;

	if (!activeGoal) {
		el.innerHTML = `
			<p style="text-align:center; color:var(--color-text-muted); font-size:13px; margin-bottom:10px;">${t('goals.noGoalSet')}</p>
			<select id="goalMetric" style="margin-top:0;">
				<option value="sessions">${t('goals.metricSessions')}</option>
				<option value="grams">${t('goals.metricGrams')}</option>
			</select>
			<select id="goalPeriod" style="margin-top:10px;">
				<option value="week">${t('goals.periodWeek')}</option>
				<option value="month">${t('goals.periodMonth')}</option>
			</select>
			<input type="number" id="goalTarget" min="0.1" step="0.1" placeholder="${t('goals.targetPlaceholder')}" style="margin-top:10px;">
			<button class="main-btn" onclick="setGoal()" style="margin-top:10px;">${t('goals.setGoal')}</button>
		`;
		return;
	}

	const now = new Date();
	let periodStart, periodLabel;
	if (activeGoal.period === 'week') {
		periodStart = getWeekStart(now);
		periodLabel = t('goals.periodThisWeek');
	} else {
		periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
		periodLabel = t('goals.periodThisMonth');
	}
	const periodStartStr = toDateStr(periodStart);

	const periodSmokes = smokes.filter(s => s.date >= periodStartStr && !s.not_mine);
	const isSessions = activeGoal.metric === 'sessions';
	const current = isSessions
		? periodSmokes.length
		: periodSmokes.reduce((sum, s) => sum + personalGrams(s), 0);
	const target = parseFloat(activeGoal.target_value);

	const pct = Math.min(100, (current / target) * 100);
	const isOver = current > target;
	const barColor = isOver ? '#f44336' : pct > 75 ? '#FF9800' : '#4CAF50';
	const unit = isSessions ? '' : 'g';
	const metricLabel = isSessions ? t('goals.metricLabelSessions') : t('goals.metricLabelGrams');
	const decimals = isSessions ? 0 : 1;

	el.innerHTML = `
		<div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
			<span style="font-size:13px; color:var(--color-text-secondary);">${metricLabel} ${periodLabel}</span>
			<span style="font-weight:700; color:${barColor};">${current.toFixed(decimals)}${unit} / ${target.toFixed(decimals)}${unit}</span>
		</div>
		<div style="background:rgba(var(--overlay-rgb),0.12); border-radius:8px; height:10px; overflow:hidden;">
			<div style="height:100%; width:100%; background:${barColor}; border-radius:8px; transition: transform 0.5s ease; transform:scaleX(${pct / 100}); transform-origin:left;"></div>
		</div>
		${isOver ? `<p style="font-size:12px; color:var(--danger); margin-top:8px; text-align:center;">${t('goals.goalExceeded', { period: periodLabel })}</p>` : ''}
		<button class="secondary-btn" onclick="removeGoal()" style="margin-top:12px;">${t('goals.removeGoal')}</button>
	`;
}

async function setGoal() {
	const metric = document.getElementById('goalMetric').value;
	const period = document.getElementById('goalPeriod').value;
	const target = parseFloat(document.getElementById('goalTarget').value);
	if (!target || target <= 0) return alert(t('goals.enterValidValue'));

	if (activeGoal) {
		await supabaseClient.from('user_goals').update({ is_active: false }).eq('id', activeGoal.id);
	}

	const { error } = await supabaseClient.from('user_goals').insert({
		user_id: currentUser.id,
		metric, period,
		target_value: target,
		is_active: true
	});

	if (error) { alert(t('goals.goalSaveError')); return; }
	showMessage(t('goals.goalSet'));
	await loadGoal();
}

async function removeGoal() {
	if (!activeGoal) return;
	if (!confirm(t('goals.confirmRemoveGoal'))) return;

	const { error } = await supabaseClient.from('user_goals').update({ is_active: false }).eq('id', activeGoal.id);
	if (error) { alert(t('common.removeError')); return; }

	activeGoal = null;
	showMessage(t('goals.goalRemoved'));
	renderGoalCard();
}

function getMonthKey(date) {
	const d = new Date(date);
	return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
}

// ========== RIEPILOGO ANNUALE ("WRAPPED") ==========
function openWrapped(year) {
	const years = [...new Set(smokes.map(s => new Date(s.date).getFullYear()))].sort((a, b) => b - a);
	if (years.length === 0) return alert(t('wrapped.noData'));
	const targetYear = year || years[0];
	renderWrapped(targetYear, years);
	document.getElementById('wrappedModal').style.display = 'flex';
}

function closeWrapped() {
	document.getElementById('wrappedModal').style.display = 'none';
}

function renderWrapped(year, years) {
	const yearSmokes = smokes.filter(s => new Date(s.date).getFullYear() === year);
	document.getElementById('wrappedTitle').textContent = t('wrapped.title', { year });

	const selector = years.length > 1 ? `
		<select onchange="openWrapped(parseInt(this.value))" style="margin-top:0; margin-bottom:15px;">
			${years.map(y => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
		</select>
	` : '';

	if (yearSmokes.length === 0) {
		document.getElementById('wrappedContent').innerHTML = `${selector}<p style="text-align:center; color:var(--color-text-muted);">${t('wrapped.noDataForYear', { year })}</p>`;
		return;
	}

	const totalGrams = yearSmokes.reduce((sum, s) => sum + personalGrams(s), 0);
	const totalSessions = yearSmokes.length;
	const uniqueDays = new Set(yearSmokes.map(s => s.date)).size;

	const dayNames = t('common.weekdays');
	const dayCounts = [0, 0, 0, 0, 0, 0, 0];
	yearSmokes.forEach(s => dayCounts[new Date(s.date).getDay()]++);
	const topDayIdx = dayCounts.indexOf(Math.max(...dayCounts));

	const placeCounts = {};
	yearSmokes.forEach(s => { if (s.location_name) placeCounts[s.location_name] = (placeCounts[s.location_name] || 0) + 1; });
	const topPlace = Object.entries(placeCounts).sort((a, b) => b[1] - a[1])[0];

	const monthNames = t('common.months');
	const monthCounts = Array(12).fill(0);
	yearSmokes.forEach(s => monthCounts[new Date(s.date).getMonth()]++);
	const topMonthIdx = monthCounts.indexOf(Math.max(...monthCounts));

	const sharedCount = yearSmokes.filter(s => Array.isArray(s.shared_with) && s.shared_with.length > 0).length;

	const yearPurchases = purchases.filter(p => p.date && new Date(p.date).getFullYear() === year && p.price);
	const totalSpent = yearPurchases.reduce((sum, p) => sum + parseFloat(p.price), 0);

	document.getElementById('wrappedContent').innerHTML = `
		${selector}
		<div class="stat-grid" style="margin-bottom:15px;">
			<div class="stat-box"><big>${totalSessions}</big><small>${t('wrapped.statSessions')}</small></div>
			<div class="stat-box"><big>${totalGrams.toFixed(1)}</big><small>${t('wrapped.statGrams')}</small></div>
			<div class="stat-box"><big>${uniqueDays}</big><small>${t('wrapped.statActiveDays')}</small></div>
			<div class="stat-box"><big>${sharedCount}</big><small>${t('wrapped.statShared')}</small></div>
		</div>
		<div style="font-size:13px; line-height:2;">
			<div>${t('wrapped.favoriteDay', { day: `<strong>${dayNames[topDayIdx]}</strong>` })}</div>
			<div>${t('wrapped.mostActiveMonth', { month: `<strong>${monthNames[topMonthIdx]}</strong>`, count: monthCounts[topMonthIdx] })}</div>
			${topPlace ? `<div>${t('wrapped.favoritePlace', { place: `<strong>${topPlace[0]}</strong>`, count: topPlace[1] })}</div>` : ''}
			${totalSpent > 0 ? `<div>${t('wrapped.totalSpent', { amount: `<strong>${totalSpent.toFixed(2)}</strong>` })}</div>` : ''}
		</div>
	`;
}

// ========== INSIGHT AUTOMATICI ==========
function renderInsights() {
	const el = document.getElementById('insightsList');
	if (!el) return;

	if (smokes.length < 5) {
		el.innerHTML = `<p style="text-align:center; color:var(--color-text-muted); font-size:13px;">${t('insights.needMoreData')}</p>`;
		return;
	}

	const insights = [];
	const dayNames = t('common.weekdays');
	const dayCounts = [0, 0, 0, 0, 0, 0, 0];
	const hourSlots = { Notte: 0, Mattina: 0, Pomeriggio: 0, Sera: 0 };
	const placeCounts = {};

	smokes.forEach(s => {
		const d = new Date(s.date);
		dayCounts[d.getDay()]++;
		if (s.time && typeof s.time === 'string') {
			const h = parseInt(s.time.split(':')[0]);
			if (h >= 0 && h < 6) hourSlots.Notte++;
			else if (h < 12) hourSlots.Mattina++;
			else if (h < 18) hourSlots.Pomeriggio++;
			else hourSlots.Sera++;
		}
		if (s.location_name) placeCounts[s.location_name] = (placeCounts[s.location_name] || 0) + 1;
	});

	const topDayIdx = dayCounts.indexOf(Math.max(...dayCounts));
	if (dayCounts[topDayIdx] > 0) {
		const pct = Math.round((dayCounts[topDayIdx] / smokes.length) * 100);
		insights.push(t('insights.topDay', { day: dayNames[topDayIdx], pct }));
	}

	const topSlot = Object.entries(hourSlots).sort((a, b) => b[1] - a[1])[0];
	if (topSlot && topSlot[1] > 0) {
		const pct = Math.round((topSlot[1] / smokes.length) * 100);
		const slotLabel = { Notte: t('insights.slotNight'), Mattina: t('insights.slotMorning'), Pomeriggio: t('insights.slotAfternoon'), Sera: t('insights.slotEvening') }[topSlot[0]];
		insights.push(t('insights.topSlot', { slot: slotLabel, pct }));
	}

	const topPlace = Object.entries(placeCounts).sort((a, b) => b[1] - a[1])[0];
	if (topPlace) {
		insights.push(t('insights.topPlace', { place: topPlace[0], count: topPlace[1] }));
	}

	const now = new Date();
	const currentMonthKey = getMonthKey(now);
	const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const lastMonthKey = getMonthKey(lastMonthDate);
	const currentCount = smokes.filter(s => getMonthKey(s.date) === currentMonthKey).length;
	const lastCount = smokes.filter(s => getMonthKey(s.date) === lastMonthKey).length;
	if (lastCount > 0) {
		const diffPct = Math.round(((currentCount - lastCount) / lastCount) * 100);
		if (Math.abs(diffPct) >= 10) {
			insights.push(diffPct > 0
				? t('insights.moreThisMonth', { pct: diffPct })
				: t('insights.lessThisMonth', { pct: Math.abs(diffPct) }));
		}
	}

	const totalGrams = smokes.reduce((sum, s) => sum + personalGrams(s), 0);
	const avgPerSession = totalGrams / smokes.length;
	insights.push(t('insights.avgPerSession', { grams: avgPerSession.toFixed(2) }));

	el.innerHTML = insights.map(i => `
		<div style="padding:10px 12px; margin-bottom:8px; border-radius:10px; background:rgba(var(--overlay-rgb),0.05); font-size:13px; line-height:1.5;">${i}</div>
	`).join('');
}

// ========== CONTESTO & UMORE ==========
// Le etichette vivono già in locales/*.json come label dei radio button nella pagina Aggiungi
// (add.contextRelax ecc.) - qui le si riusa invece di duplicarle in un secondo oggetto.
const CONTEXT_TAG_KEYS = { relax: 'add.contextRelax', social: 'add.contextSocial', creativo: 'add.contextCreative', sonno: 'add.contextSleep' };
function contextTagLabel(tag) { return CONTEXT_TAG_KEYS[tag] ? t(CONTEXT_TAG_KEYS[tag]) : tag; }

function renderContextStats() {
	const el = document.getElementById('contextStatsList');
	if (!el) return;

	const tagged = smokes.filter(s => s.context_tag);
	if (tagged.length === 0) {
		el.innerHTML = `<p style="text-align:center; color:var(--color-text-muted); font-size:13px;">${t('context.noTaggedYet')}</p>`;
		return;
	}

	const grouped = {};
	tagged.forEach(s => {
		if (!grouped[s.context_tag]) grouped[s.context_tag] = { count: 0, moodSum: 0, moodCount: 0 };
		grouped[s.context_tag].count++;
		if (s.mood_rating) {
			grouped[s.context_tag].moodSum += s.mood_rating;
			grouped[s.context_tag].moodCount++;
		}
	});

	el.innerHTML = Object.entries(grouped).sort((a, b) => b[1].count - a[1].count).map(([tag, data]) => {
		const avgMood = data.moodCount > 0 ? (data.moodSum / data.moodCount).toFixed(1) : null;
		return `
			<div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(var(--overlay-rgb),0.05); border-radius:10px; margin-bottom:6px;">
				<span style="font-size:13px; font-weight:600;">${contextTagLabel(tag)}</span>
				<span style="font-size:12px; color:var(--color-text-muted);">${t('context.sessionsLabel', { count: data.count })}${avgMood ? t('context.avgMoodSuffix', { avg: avgMood }) : ''}</span>
			</div>
		`;
	}).join('');
}

function renderPeriodComparison() {
	const el = document.getElementById('periodComparison');
	if (!el) return;

	const now = new Date();
	const currentMonthKey = getMonthKey(now);
	const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const lastMonthKey = getMonthKey(lastMonthDate);

	const currentSmokes = smokes.filter(s => getMonthKey(s.date) === currentMonthKey);
	const lastSmokes = smokes.filter(s => getMonthKey(s.date) === lastMonthKey);

	const currentCount = currentSmokes.length;
	const lastCount = lastSmokes.length;

	const currentGrams = currentSmokes.reduce((sum, s) => sum + (s.my_fumo_grams ?? s.fumo_grams ?? 0) + (s.my_erba_grams ?? s.erba_grams ?? 0), 0);
	const lastGrams = lastSmokes.reduce((sum, s) => sum + (s.my_fumo_grams ?? s.fumo_grams ?? 0) + (s.my_erba_grams ?? s.erba_grams ?? 0), 0);

	function renderDiff(current, last) {
		if (last === 0 && current === 0) return `<span style="color:var(--color-text-muted); font-size:12px;">${t('period.noData')}</span>`;
		if (last === 0) return `<span style="color:var(--primary); font-size:12px; font-weight:600;">${t('period.newThisMonth')}</span>`;
		const pct = ((current - last) / last) * 100;
		const isSame = Math.abs(pct) < 0.5;
		const isUp = pct > 0;
		const color = isSame ? 'var(--color-text-muted)' : (isUp ? '#FF9800' : '#2196F3');
		const arrow = isSame ? '→' : (isUp ? '▲' : '▼');
		return `<span style="color:${color}; font-size:12px; font-weight:600;">${arrow} ${Math.abs(pct).toFixed(0)}%</span>`;
	}

	function renderRow(label, current, last, suffix) {
		const displayVal = suffix === 'g' ? current.toFixed(1) : current;
		return `
			<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid rgba(var(--overlay-rgb),0.06);">
				<span style="font-size:13px; color:var(--color-text-secondary);">${label}</span>
				<div style="text-align:right;">
					<div style="font-weight:700; font-size:15px;">${displayVal}${suffix}</div>
					${renderDiff(current, last)}
				</div>
			</div>
		`;
	}

	el.innerHTML = `
		${renderRow(t('period.sessions'), currentCount, lastCount, '')}
		${renderRow(t('period.totalGrams'), currentGrams, lastGrams, 'g')}
		<p style="font-size:11px; color:var(--color-text-muted); margin-top:8px; text-align:center;">${t('period.lastMonthSummary', { count: lastCount, grams: lastGrams.toFixed(1) })}</p>
	`;
}

// Il tasto "Inizia una pausa": psicologicamente identico a prima (l'utente ha la sensazione
// di iniziare subito), ma sotto il cofano crea una pausa "pianificata" (spec §4) che si
// conferma da sola con data retrodatata solo se il gap senza sessioni supera la soglia
// scalata (vedi runBreakDetection). Se logghi una sessione prima che scatti, resta nello
// storico come tentativo non completato invece di sparire.
async function startBreak() {
	const today = toDateStr(new Date());
	const { error } = await supabaseClient.from('tolerance_breaks').insert({
		user_id: currentUser.id,
		start_date: today,
		planned_start_date: today,
		origin: 'planned',
		is_active: false
	});

	if (error) { alert(t('breaks.startBreakError')); return; }
	showMessage(t('breaks.breakStarted'));
	await loadBreaks();
}

async function cancelPendingBreak() {
	if (!pendingBreak) return;
	if (!confirm(t('breaks.confirmCancelPending'))) return;

	const { error } = await supabaseClient.from('tolerance_breaks').delete().eq('id', pendingBreak.id);
	if (error) { alert(t('breaks.cancelPendingError')); return; }
	showMessage(t('breaks.pendingCancelled'));
	await loadBreaks();
}

async function endBreak() {
	if (!activeBreak) return;
	if (!confirm(t('breaks.confirmEndBreak'))) return;

	const today = toDateStr(new Date());
	const result = await closeOrDiscardBreak(activeBreak, today);

	if (result.error) { alert(t('breaks.endBreakError')); return; }
	showMessage(result.discarded ? t('breaks.discardedTooShort') : t('breaks.breakEnded'));
	await loadBreaks();
}

// ========== PROMEMORIA (banner in-app) ==========
function checkReminderBanner() {
	const banner = document.getElementById('reminderBanner');
	const textEl = document.getElementById('reminderBannerText');
	if (!banner || !textEl) return;

	if (sessionStorage.getItem('reminderDismissed') === 'today') {
		banner.style.display = 'none';
		return;
	}

	const today = new Date().toISOString().split('T')[0];
	const hasToday = smokes.some(s => s.date === today);

	if (hasToday) {
		banner.style.display = 'none';
		return;
	}

	const streak = calculateStreak();
	if (streak >= 1) {
		textEl.textContent = t('reminder.streakRisk', { streak });
	} else {
		textEl.textContent = t('reminder.nothingLoggedToday');
	}
	banner.style.display = 'block';
}

function dismissReminderBanner() {
	sessionStorage.setItem('reminderDismissed', 'today');
	document.getElementById('reminderBanner').style.display = 'none';
}

// ========== NOTIFICHE IN-APP ==========
async function loadNotifications() {
	const { data, error } = await supabaseClient
		.from('notifications')
		.select('*')
		.order('updated_at', { ascending: false })
		.limit(30);

	if (error) { console.error('Errore notifiche:', error); return; }

	notifications = data || [];
	renderNotifications();
	updateNotifBadge();
}

function notifText(n) {
	if (n.type === 'snapshot_reaction') return tn('notif.snapshotReactions', n.event_count || 1);
	if (n.type === 'snapshot_comment') return tn('notif.snapshotComments', n.event_count || 1);
	return n.message || '';
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

function renderNotifications() {
	const list = document.getElementById('notifList');
	if (!list) return;

	if (notifications.length === 0) {
		list.innerHTML = `<p style="padding:15px; text-align:center; color:var(--color-text-muted); font-size:13px;">${t('reminder.noNotifications')}</p>`;
		return;
	}

	list.innerHTML = notifications.map(n => `
		<div class="notif-row${n.snapshot_id ? ' notif-clickable' : ''}"${n.snapshot_id ? ` data-snapshot-id="${n.snapshot_id}"` : ''} style="padding:12px 15px; border-bottom:1px solid rgba(var(--overlay-rgb),0.06); background:${n.read ? 'transparent' : 'rgba(76,175,80,0.08)'};">
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

function formatNotifTime(iso) {
	const d = new Date(iso);
	const now = new Date();
	const diffMin = Math.floor((now - d) / 60000);
	if (diffMin < 1) return t('reminder.justNow');
	if (diffMin < 60) return t('reminder.minutesAgo', { count: diffMin });
	const diffH = Math.floor(diffMin / 60);
	if (diffH < 24) return t('reminder.hoursAgo', { count: diffH });
	return d.toLocaleDateString(localeCode());
}

function updateNotifBadge() {
	const badge = document.getElementById('notifBadge');
	if (!badge) return;
	const unread = notifications.filter(n => !n.read).length;
	if (unread > 0) {
		badge.textContent = unread > 9 ? '9+' : unread;
		badge.style.display = 'flex';
	} else {
		badge.style.display = 'none';
	}
}

async function toggleNotifications() {
	const panel = document.getElementById('notifPanel');
	const menu = document.getElementById('menu');
	if (menu) menu.classList.remove('active');

	const isOpening = !panel.classList.contains('active');
	panel.classList.toggle('active');

	if (isOpening) {
		await markAllNotificationsRead();
	}
}

async function markAllNotificationsRead() {
	const unreadIds = notifications.filter(n => !n.read).map(n => n.id);
	if (unreadIds.length === 0) return;

	notifications.forEach(n => n.read = true);
	renderNotifications();
	updateNotifBadge();

	await supabaseClient.from('notifications').update({ read: true }).in('id', unreadIds);
}

function subscribeToNotifications() {
	supabaseClient
		.channel('notifications-channel')
		.on('postgres_changes', {
			event: 'INSERT',
			schema: 'public',
			table: 'notifications',
			filter: `user_id=eq.${currentUser.id}`
		}, (payload) => {
			notifications.unshift(payload.new);
			renderNotifications();
			updateNotifBadge();
			showMessage('🔔 ' + notifText(payload.new));
		})
		.on('postgres_changes', {
			event: 'UPDATE',
			schema: 'public',
			table: 'notifications',
			filter: `user_id=eq.${currentUser.id}`
		}, (payload) => {
			const i = notifications.findIndex(x => x.id === payload.new.id);
			// echo di markAllNotificationsRead: bulk update read=true su righe già lette localmente.
			// Rimpiazzo la riga ma salto il re-render per non ripaginare N volte su un click.
			if (i >= 0 && payload.new.read === true && notifications[i].read === true) {
				notifications[i] = payload.new;
				return;
			}
			if (i >= 0) notifications[i] = payload.new;
			else notifications.unshift(payload.new);
			notifications.sort((a, b) =>
				new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
			renderNotifications();
			updateNotifBadge();
		})
		.subscribe();
}

// ========== IMPOSTAZIONI PROMEMORIA ==========
async function loadReminderSettings() {
	const { data } = await supabaseClient
		.from('profiles')
		.select('reminder_enabled, reminder_time')
		.eq('id', currentUser.id)
		.single();

	if (data) {
		userReminderSettings = data;
		document.getElementById('reminderEnabledCheck').checked = data.reminder_enabled;
		if (data.reminder_time) {
			document.getElementById('reminderTimeInput').value = data.reminder_time.slice(0, 5);
		}
	}
}

async function saveReminderSettings() {
	const enabled = document.getElementById('reminderEnabledCheck').checked;
	const time = document.getElementById('reminderTimeInput').value;

	const { error } = await supabaseClient
		.from('profiles')
		.update({ reminder_enabled: enabled, reminder_time: time })
		.eq('id', currentUser.id);

	if (error) {
		alert(t('settings.saveReminderError'));
	} else {
		showMessage(t('settings.preferencesSaved'));
	}
}

// ========== NOTIFICHE PUSH ==========
function urlBase64ToUint8Array(base64String) {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
	return outputArray;
}

async function enablePushNotifications() {
	const statusEl = document.getElementById('pushStatus');

	if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
		statusEl.textContent = t('settings.pushNotSupported');
		return;
	}

	try {
		statusEl.textContent = t('settings.pushActivating');

		const registration = await navigator.serviceWorker.register('/sw.js');
		await navigator.serviceWorker.ready;

		const permission = await Notification.requestPermission();
		if (permission !== 'granted') {
			statusEl.textContent = t('settings.pushPermissionDenied');
			return;
		}

		const subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
		});

		const subJson = subscription.toJSON();

		const { error } = await supabaseClient.from('push_subscriptions').upsert({
			user_id: currentUser.id,
			endpoint: subJson.endpoint,
			p256dh: subJson.keys.p256dh,
			auth: subJson.keys.auth
		}, { onConflict: 'endpoint' });

		if (error) {
			statusEl.textContent = t('settings.pushSubscriptionSaveError');
			console.error(error);
			return;
		}

		statusEl.textContent = t('settings.pushActivated');
		loadPushDevices();
	} catch (err) {
		console.error(err);
		statusEl.textContent = t('settings.pushActivationError');
	}
}

// ========== STATO BACKUP AUTOMATICI (solo metadati, mai il contenuto) ==========
async function loadBackupStatus() {
	const el = document.getElementById('backupStatusList');
	if (!el) return;
	el.innerHTML = `<p style="font-size:12px; color:var(--color-text-muted); text-align:center;">${t('common.loading')}</p>`;

	try {
		const { data, error } = await supabaseClient.functions.invoke('list-backups');
		if (error || !data?.ok) throw error || new Error('Risposta non valida');

		if (!data.files || data.files.length === 0) {
			el.innerHTML = `<p style="font-size:12px; color:var(--color-text-muted); text-align:center;">${t('settings.noBackupsYet')}</p>`;
			return;
		}

		el.innerHTML = data.files.slice(0, 5).map(f => `
			<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid rgba(var(--overlay-rgb),0.06); font-size:12px;">
				<span>${f.name}</span>
				<span style="color:var(--color-text-muted);">${new Date(f.created_at).toLocaleDateString(localeCode())}</span>
			</div>
		`).join('');
	} catch (err) {
		console.error('Errore stato backup:', err);
		el.innerHTML = `<p style="font-size:12px; color:var(--color-text-muted); text-align:center;">${t('settings.backupStatusError')}</p>`;
	}
}

// ========== GESTIONE DISPOSITIVI PUSH ==========
async function getCurrentPushEndpoint() {
	try {
		if (!('serviceWorker' in navigator)) return null;
		const reg = await navigator.serviceWorker.getRegistration();
		if (!reg) return null;
		const sub = await reg.pushManager.getSubscription();
		return sub ? sub.endpoint : null;
	} catch (e) {
		return null;
	}
}

async function loadPushDevices() {
	const { data, error } = await supabaseClient
		.from('push_subscriptions')
		.select('id, endpoint, created_at')
		.order('created_at', { ascending: false });

	if (error) { console.error('Errore caricamento dispositivi push:', error); return; }
	await renderPushDevices(data || []);
}

async function renderPushDevices(devices) {
	const el = document.getElementById('pushDevicesList');
	if (!el) return;

	if (devices.length === 0) {
		el.innerHTML = `<p style="text-align:center; color:var(--color-text-muted); font-size:13px;">${t('settings.noPushDevices')}</p>`;
		return;
	}

	const currentEndpoint = await getCurrentPushEndpoint();

	el.innerHTML = devices.map(d => {
		const isThis = d.endpoint === currentEndpoint;
		const dateStr = new Date(d.created_at).toLocaleDateString(localeCode());
		return `
			<div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(var(--overlay-rgb),0.05); border-radius:10px; margin-bottom:6px;">
				<div>
					<span style="font-size:13px; font-weight:600;">${t('settings.deviceLabel')}${isThis ? ` <span style="color:var(--primary); font-size:11px;">${t('settings.thisDeviceSuffix')}</span>` : ''}</span><br>
					<small style="color:var(--color-text-muted);">${t('settings.activatedOn', { date: dateStr })}</small>
				</div>
				<button onclick="revokePushDevice(${d.id})" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:16px;">🗑️</button>
			</div>
		`;
	}).join('');
}

async function revokePushDevice(id) {
	if (!confirm(t('settings.confirmRevokeDevice'))) return;
	const { error } = await supabaseClient.from('push_subscriptions').delete().eq('id', id);
	if (error) { alert(t('common.removeError')); return; }
	showMessage(t('settings.deviceRemoved'));
	loadPushDevices();
}


		// ========== SCORTE / ACQUISTI ==========
let purchases = [];
let activeFumoStock = null;
let activeErbaStock = null;
let currentBuyType = null;
let pendingCloseStock = null; // scorta in attesa di chiusura (usato dai modal)
let sessionsToFix = []; // sessioni del periodo da correggere

async function loadPurchases() {
    if (isGuestMode) {
        purchases = getGuestPurchases().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
        activeFumoStock = purchases.find(p => p.type === 'fumo' && !p.is_closed) || null;
        activeErbaStock = purchases.find(p => p.type === 'erba' && !p.is_closed) || null;
        renderStockPage();
        renderMiniWidget();
        return;
    }
    const { data, error } = await supabaseClient
        .from('purchases')
        .select('*')
        .order('date', { ascending: false });

    if (error) {
        console.error('Errore caricamento acquisti:', error);
        const cached = getLocalCache('purchases');
        if (cached) {
            purchases = cached;
            activeFumoStock = purchases.find(p => p.type === 'fumo' && !p.is_closed) || null;
            activeErbaStock = purchases.find(p => p.type === 'erba' && !p.is_closed) || null;
            renderStockPage();
            renderMiniWidget();
        }
        return;
    }

    purchases = data || [];
    cacheLocalData('purchases', purchases);
    activeFumoStock = purchases.find(p => p.type === 'fumo' && !p.is_closed) || null;
    activeErbaStock = purchases.find(p => p.type === 'erba' && !p.is_closed) || null;

    renderStockPage();
    renderMiniWidget();
}

// ========== CALCOLO GRAMMI CONSUMATI DA UNA DATA ==========
// Calcola i grammi consumati tra due date (esclude sessioni "non mia")
function gramsConsumedSince(type, sinceDate, untilDate = null) {
    return smokes
        .filter(s => {
            if (s.not_mine) return false; // escludi sessioni non tue
            if (s.date < sinceDate) return false;
            if (untilDate && s.date > untilDate) return false;
            return true;
        })
        .reduce((sum, s) => sum + (type === 'fumo' ? (s.fumo_grams || 0) : (s.erba_grams || 0)), 0);
}

// Dato un tipo, restituisce lista acquisti aperti ordinati dal più vecchio (FIFO)
function getOpenPurchasesFIFO(type) {
    return purchases
        .filter(p => p.type === type && !p.is_closed)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Calcola i grammi consumati per uno specifico acquisto (FIFO)
// Scala dal più vecchio: il consumo del 2° parte solo dopo che il 1° è esaurito
function gramsConsumedForPurchase(purchase) {
    const type = purchase.type;
    const openFIFO = getOpenPurchasesFIFO(type);
    const idx = openFIFO.findIndex(p => p.id === purchase.id);
    if (idx === -1) return 0;

    // Consumo totale dal giorno del primo acquisto aperto
    const oldestDate = openFIFO[0].date;
    const totalConsumed = gramsConsumedSince(type, oldestDate);

    // Somma i grammi degli acquisti più vecchi (quelli prima di questo nella lista FIFO)
    let gramsBeforeThis = 0;
    for (let i = 0; i < idx; i++) {
        gramsBeforeThis += parseFloat(openFIFO[i].grams);
    }

    // Quanto è stato consumato "dentro" questo acquisto
    const consumedIntoThis = Math.max(0, totalConsumed - gramsBeforeThis);
    return Math.min(consumedIntoThis, parseFloat(purchase.grams));
}

// Grammi rimanenti per un acquisto specifico
function gramsRemainingForPurchase(purchase) {
    const consumed = gramsConsumedForPurchase(purchase);
    return Math.max(0, parseFloat(purchase.grams) - consumed);
}

// Quanto era stato consumato di un acquisto specifico, cumulativamente, fino a una certa data
// (stessa logica FIFO di gramsConsumedForPurchase ma "congelata" a una data, e includendo anche
// gli acquisti gia' chiusi: serve a ricostruire quanto e' stato fumato mese per mese, non solo
// lo stato attuale).
function gramsConsumedForPurchaseAsOf(purchase, asOfDate) {
    const type = purchase.type;
    const allOfType = purchases
        .filter(p => p.type === type && p.date <= asOfDate)
        .sort((a, b) => new Date(a.date) - new Date(b.date) || a.id - b.id);

    const idx = allOfType.findIndex(p => p.id === purchase.id);
    if (idx === -1) return 0; // l'acquisto non era ancora stato registrato a quella data

    const oldestDate = allOfType[0].date;
    const totalConsumed = gramsConsumedSince(type, oldestDate, asOfDate);

    let gramsBeforeThis = 0;
    for (let i = 0; i < idx; i++) {
        gramsBeforeThis += parseFloat(allOfType[i].grams);
    }

    const consumedIntoThis = Math.max(0, totalConsumed - gramsBeforeThis);
    return Math.min(consumedIntoThis, parseFloat(purchase.grams));
}

// Spesa "reale" per mese: il prezzo di un acquisto viene spalmato sui mesi in cui quella
// scorta e' stata effettivamente fumata (grammi consumati in quel mese * prezzo/grammo),
// non tutto sul mese in cui e' stato comprato.
function computeMonthlySpending(monthKeys) {
    const priced = purchases.filter(p => p.price && p.grams);

    return monthKeys.map(key => {
        const [y, m] = key.split('-').map(Number);
        const monthEnd = toDateStr(new Date(y, m, 0));
        const prevMonthEnd = toDateStr(new Date(y, m - 1, 0));

        return priced.reduce((sum, p) => {
            const upToEnd = gramsConsumedForPurchaseAsOf(p, monthEnd);
            const upToPrev = gramsConsumedForPurchaseAsOf(p, prevMonthEnd);
            const consumedInMonth = Math.max(0, upToEnd - upToPrev);
            const pricePerGram = parseFloat(p.price) / parseFloat(p.grams);
            return sum + consumedInMonth * pricePerGram;
        }, 0);
    });
}

function computeDailyRate(type, daysWindow = 14) {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - daysWindow);
	const cutoffStr = cutoff.toISOString().split('T')[0];

	const recentGrams = smokes
		.filter(s => !s.not_mine && s.date >= cutoffStr)
		.reduce((sum, s) => sum + (type === 'fumo' ? (s.fumo_grams || 0) : (s.erba_grams || 0)), 0);

	return recentGrams / daysWindow;
}

function getTotalRemaining(type) {
	return getOpenPurchasesFIFO(type).reduce((sum, p) => sum + gramsRemainingForPurchase(p), 0);
}

function renderStockPrediction(type) {
	const remaining = getTotalRemaining(type);
	if (remaining <= 0) return '';

	const dailyRate = computeDailyRate(type);
	if (dailyRate <= 0) {
		return `<p style="font-size:12px; color:var(--color-text-muted); margin-top:10px; text-align:center;">${t('stock.consumptionTooLowToEstimate')}</p>`;
	}

	const daysLeft = Math.round(remaining / dailyRate);
	const exhaustDate = new Date();
	exhaustDate.setDate(exhaustDate.getDate() + daysLeft);
	const dateStr = exhaustDate.toLocaleDateString(localeCode(), { day: 'numeric', month: 'short' });

	const urgencyColor = daysLeft > 7 ? '#4CAF50' : daysLeft > 3 ? '#FF9800' : '#f44336';

	return `
		<div style="background:rgba(var(--overlay-rgb),0.05); border-radius:10px; padding:10px; margin-top:10px; text-align:center;">
			<span style="font-size:13px; color:${urgencyColor}; font-weight:600;">
				${tn('stock.durationEstimate', daysLeft, { days: daysLeft, date: dateStr })}
			</span>
		</div>
	`;
}

// ========== RENDER PAGINA STOCK ==========
function renderStockPage() {
    if (!smokesLoaded) return; // consumato ancora sconosciuto: evita di mostrare la scorta come piena per errore
    renderStockCard('fumo');
    renderStockCard('erba');
    renderPurchaseHistory();
}



function renderStockCard(type, stock) {
    const emoji = type === 'fumo' ? '🍫' : '🍃';
    const color = type === 'fumo' ? '#795548' : 'var(--heading)';
    const colorLight = type === 'fumo' ? 'rgba(139,69,19,0.1)' : 'rgba(76,175,80,0.1)';
    const displayEl = document.getElementById(`stock${type.charAt(0).toUpperCase()+type.slice(1)}Display`);
    const closeBtn = document.getElementById(`btnClose${type.charAt(0).toUpperCase()+type.slice(1)}`);

    const openPurchases = getOpenPurchasesFIFO(type);

    if (openPurchases.length === 0) {
        displayEl.innerHTML = `<p style="text-align:center; color:var(--color-text-muted); font-size:13px;">${t('stock.noActiveStock')}</p>`;
        if (closeBtn) closeBtn.style.display = 'none';
        return;
    }

    // Nascondi il vecchio tasto globale (ora è inline per acquisto)
    if (closeBtn) closeBtn.style.display = 'none';

    let html = '';

    openPurchases.forEach((p, idx) => {
        const isOldest = idx === 0;
        const consumed = gramsConsumedForPurchase(p);
        const remaining = gramsRemainingForPurchase(p);
        const pct = Math.min(100, Math.max(0, (remaining / parseFloat(p.grams)) * 100));
        const priceStr = p.price ? ` · €${p.price}` : '';
        const barColor = pct > 50 ? '#4CAF50' : pct > 20 ? '#FF9800' : '#f44336';

        const oldestLabel = isOldest && openPurchases.length > 1
            ? `<span style="background:var(--warning-bg); color:var(--warning-text); font-size:11px; padding:2px 8px; border-radius:20px; margin-left:6px;">${t('stock.inUseBadge')}</span>`
            : '';

        html += `
            <div style="background:${colorLight}; border-radius:12px; padding:14px; margin-bottom:${idx < openPurchases.length-1 ? '12px' : '0'};">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span style="font-size:13px; color:var(--color-text-secondary);">
                        ${emoji} ${t('stock.purchaseOfDate', { date: formatShortDate(p.date) })}${oldestLabel}
                    </span>
                    <span style="font-weight:700; color:${color};">${p.grams}g${priceStr}</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <span style="font-size:13px; color:var(--color-text-secondary);">${t('stock.consumedLabel')}</span>
                    <span style="font-weight:600; color:var(--color-text-secondary);">${consumed.toFixed(2)}g</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span style="font-size:14px; font-weight:700; color:${color};">${t('stock.remainingLabel')}</span>
                    <span style="font-size:18px; font-weight:800; color:${color};">${remaining.toFixed(2)}g</span>
                </div>
                <div style="background:rgba(var(--overlay-rgb),0.12); border-radius:8px; height:10px; overflow:hidden;">
                    <div style="height:100%; width:100%; background:${barColor}; border-radius:8px; transition: transform 0.5s ease; transform:scaleX(${pct / 100}); transform-origin:left;"></div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
                    <span style="font-size:11px; color:var(--color-text-muted);">${t('stock.percentRemaining', { pct: pct.toFixed(0) })}</span>
                    ${isOldest ? `<button onclick="closeStock('${type}', ${p.id})" style="background:none; border:none; color:var(--danger); font-size:12px; font-weight:bold; cursor:pointer; text-decoration:underline; padding:0;">${t('stock.outOfThisStock')}</button>` : ''}
                </div>
            </div>
        `;
    });

    html += renderStockPrediction(type);
    displayEl.innerHTML = html;
}



// ========== MINI WIDGET PAGINA AGGIUNGI ==========
function renderMiniWidget() {
    const widget = document.getElementById('miniStockWidget');
    if (!widget) return;
    if (!smokesLoaded) return; // consumato ancora sconosciuto: meglio non mostrare nulla che mostrare "piena" per errore
    document.getElementById('homeStockCard')?.classList.remove('is-loading');
    const noStockMsg = document.getElementById('homeNoStock');

    const openFumo = getOpenPurchasesFIFO('fumo');
    const openErba = getOpenPurchasesFIFO('erba');

    if (openFumo.length === 0 && openErba.length === 0) {
        widget.style.display = 'none';
        if (noStockMsg) noStockMsg.style.display = 'block';
        return;
    }

    widget.style.display = 'block';
    if (noStockMsg) noStockMsg.style.display = 'none';

    // FUMO — scala dal più vecchio
    if (openFumo.length > 0) {
        const oldest = openFumo[0];
        const remaining = gramsRemainingForPurchase(oldest);
        const pct = Math.min(100, (remaining / parseFloat(oldest.grams)) * 100);
        document.getElementById('miniFumoGrams').textContent = remaining.toFixed(2) + 'g';
        document.getElementById('miniFumoBar').style.transform = 'scaleX(' + (pct / 100) + ')';
    } else {
        document.getElementById('miniFumoGrams').textContent = '–';
        document.getElementById('miniFumoBar').style.transform = 'scaleX(0)';
    }

    // ERBA — scala dal più vecchio
    if (openErba.length > 0) {
        const oldest = openErba[0];
        const remaining = gramsRemainingForPurchase(oldest);
        const pct = Math.min(100, (remaining / parseFloat(oldest.grams)) * 100);
        document.getElementById('miniErbaGrams').textContent = remaining.toFixed(2) + 'g';
        document.getElementById('miniErbaBar').style.transform = 'scaleX(' + (pct / 100) + ')';
    } else {
        document.getElementById('miniErbaGrams').textContent = '–';
        document.getElementById('miniErbaBar').style.transform = 'scaleX(0)';
    }
}

// ========== STORICO ACQUISTI ==========
function renderPurchaseHistory() {
    const el = document.getElementById('purchaseHistory');
    if (!el) return;

    if (purchases.length === 0) {
        el.innerHTML = `<p style="text-align:center; color:var(--color-text-muted); font-size:13px;">${t('stock.noPurchasesRegistered')}</p>`;
        return;
    }

    el.innerHTML = purchases.map(p => {
        const emoji = p.type === 'fumo' ? '🍫' : '🍃';
        const label = p.type === 'fumo' ? t('charts.labelSmoke') : t('charts.labelWeed');
        const priceStr = p.price ? ` · <span style="color:var(--warning);">€${p.price}</span>` : '';

        const statusStr = p.is_closed
            ? `<span style="background:rgba(var(--overlay-rgb),0.08); color:var(--color-text-muted); font-size:11px; padding:2px 8px; border-radius:20px;">${t('stock.closedBadge')}</span>`
            : `<span style="background:rgba(76,175,80,0.12); color:var(--primary); font-size:11px; padding:2px 8px; border-radius:20px;">${t('stock.activeBadge')}</span>`;

        let consumedStr = '–';
        let barHtml = '';

        if (!p.is_closed) {
            const consumed = gramsConsumedForPurchase(p);
            const remaining = gramsRemainingForPurchase(p);
            const pct = Math.min(100, Math.max(0, (remaining / parseFloat(p.grams)) * 100));
            const barColor = pct > 50 ? '#4CAF50' : pct > 20 ? '#FF9800' : '#f44336';
            consumedStr = t('stock.consumedRemainingLine', { consumed: consumed.toFixed(2), remaining: remaining.toFixed(2) });
            barHtml = `
                <div style="background:rgba(var(--overlay-rgb),0.12); border-radius:6px; height:6px; overflow:hidden; margin-top:6px;">
                    <div style="height:100%; width:100%; background:${barColor}; border-radius:6px; transition: transform 0.5s ease; transform:scaleX(${pct / 100}); transform-origin:left;"></div>
                </div>
            `;
        } else if (p.closed_at) {
            const days = Math.max(0, Math.round((new Date(p.closed_at) - new Date(p.date)) / 86400000));
            consumedStr = tn('stock.closedOnDuration', days, { date: formatShortDate(p.closed_at), days });
        }

        return `
            <div style="padding:12px; border-bottom:1px solid rgba(var(--overlay-rgb),0.07);">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="font-weight:700;">${emoji} ${label}</span>
                        ${statusStr}<br>
                        <small style="color:var(--color-text-muted);">${formatShortDate(p.date)} · ${p.grams}g${priceStr}</small><br>
                        <small style="color:var(--color-text-muted);">${consumedStr}</small>
                    </div>
                    <button onclick="deletePurchase(${p.id})" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:18px;">🗑️</button>
                </div>
                ${barHtml}
            </div>
        `;
    }).join('');
}

// ========== MODAL ACQUISTO ==========
function openBuyModal(type) {
    currentBuyType = type;
    document.getElementById('buyModalTitle').textContent =
        t('stock.buyModalTitleFor', { type: type === 'fumo' ? t('add.smoke') : t('add.weed') });
    document.getElementById('buyGrams').value = '';
    document.getElementById('buyPrice').value = '';
    document.getElementById('buyDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('buyModal').style.display = 'flex';
}

function closeBuyModal() {
    document.getElementById('buyModal').style.display = 'none';
    currentBuyType = null;
}

async function savePurchase() {
    const grams = parseFloat(document.getElementById('buyGrams').value);
    const price = parseFloat(document.getElementById('buyPrice').value) || null;
    const date = document.getElementById('buyDate').value;

    if (!grams || grams <= 0) return alert(t('stock.enterValidQuantity'));
    if (!date) return alert(t('stock.enterDate'));

    // Se c'è già una scorta attiva dello stesso tipo, chiedi conferma
    const existing = currentBuyType === 'fumo' ? activeFumoStock : activeErbaStock;
    if (existing) {
        const typeLabel = currentBuyType === 'fumo' ? t('stock.typeSmoke') : t('stock.typeWeed');
        if (!confirm(t('stock.confirmAddSeparatePurchase', { type: typeLabel }))) return;
    }

    if (isGuestMode) {
        const guestPurchases = getGuestPurchases();
        guestPurchases.push({ id: genGuestId(), type: currentBuyType, grams, price, date, closed_at: null, is_closed: false });
        setGuestPurchases(guestPurchases);
    } else {
        const { error } = await supabaseClient.from('purchases').insert({
            user_id: currentUser.id,
            type: currentBuyType,
            grams,
            price,
            date,
            is_closed: false
        });

        if (error) { alert(t('stock.saveError')); return; }
    }

    closeBuyModal();
    showMessage(t('stock.purchaseRegistered'));
    await loadPurchases();
}

async function deletePurchase(id) {
    if (!confirm(t('stock.confirmDeletePurchase'))) return;
    if (isGuestMode) {
        setGuestPurchases(getGuestPurchases().filter(p => p.id !== id));
        showMessage(t('stock.purchaseDeleted'));
        await loadPurchases();
        return;
    }
    const { error } = await supabaseClient.from('purchases').delete().eq('id', id);
    if (!error) { showMessage(t('stock.purchaseDeleted')); await loadPurchases(); }
}

// ========== CHIUSURA SCORTA + CONTROLLO DISCREPANZA ==========
function closeStock(type, purchaseId) {
    const stock = purchases.find(p => p.id === purchaseId);
    if (!stock) return;

    const consumed = gramsConsumedForPurchase(stock);
    const diff = consumed - parseFloat(stock.grams);
    const absDiff = Math.abs(diff);
    const threshold = 0.3;

    pendingCloseStock = { type, stock, consumed, diff };

    sessionsToFix = smokes.filter(s => {
        if (s.not_mine) return false;
        const gram = type === 'fumo' ? s.fumo_grams : s.erba_grams;
        return s.date >= stock.date && gram > 0;
    });

    if (absDiff <= threshold) {
        confirmCloseStock();
        return;
    }

    const typeLabel = type === 'fumo' ? t('stock.typeSmoke') : t('stock.typeWeed');
    let msg = '';
    if (diff > 0) {
        msg = t('stock.discrepancyExcess', { consumed: consumed.toFixed(2), type: typeLabel, grams: stock.grams, diff: absDiff.toFixed(2) });
    } else {
        msg = t('stock.discrepancyShortfall', { consumed: consumed.toFixed(2), type: typeLabel, grams: stock.grams, diff: absDiff.toFixed(2) });
    }

    document.getElementById('discrepancyText').innerHTML = msg;
    document.getElementById('discrepancyModal').style.display = 'flex';
}

// Annulla: chiude il modal senza chiudere la scorta (niente più "ignora e chiudi comunque")
function closeDiscrepancyModal() {
    document.getElementById('discrepancyModal').style.display = 'none';
    pendingCloseStock = null;
    sessionsToFix = [];
}

// Scala tutte le sessioni proporzionalmente
async function fixProportional() {
    if (!pendingCloseStock) return;
    const { type, stock, consumed } = pendingCloseStock;

    if (consumed === 0) { confirmCloseStock(); return; }

    const factor = stock.grams / consumed; // es. 0.85 se hai segnato troppo

    const guestSmokes = isGuestMode ? getGuestSmokes() : null;

    for (const s of sessionsToFix) {
        const oldGram = type === 'fumo' ? (s.fumo_grams || 0) : (s.erba_grams || 0);
        const newGram = parseFloat((oldGram * factor).toFixed(2));
        const newTotal = parseFloat(((s.grams || 0) - oldGram + newGram).toFixed(2));

        const updateObj = type === 'fumo'
            ? { fumo_grams: newGram, grams: newTotal }
            : { erba_grams: newGram, grams: newTotal };

        if (isGuestMode) {
            const rec = guestSmokes.find(g => g.id === s.id);
            if (rec) Object.assign(rec, updateObj);
        } else {
            await supabaseClient.from('smokes').update(updateObj).eq('id', s.id);
        }
    }

    if (isGuestMode) setGuestSmokes(guestSmokes);

    document.getElementById('discrepancyModal').style.display = 'none';
    showMessage(t('stock.sessionsRecalculated'));
    await loadData();
    confirmCloseStock();
}

// Mostra lista sessioni modificabili manualmente
function fixManual() {
    document.getElementById('discrepancyModal').style.display = 'none';
    const { type, stock } = pendingCloseStock;

    document.getElementById('manualFixHint').textContent =
        t('stock.manualFixHint', { type: type === 'fumo' ? t('stock.typeSmoke') : t('stock.typeWeed'), grams: stock.grams });

    const listEl = document.getElementById('manualFixList');
    listEl.innerHTML = sessionsToFix.map(s => {
        const gram = type === 'fumo' ? (s.fumo_grams || 0) : (s.erba_grams || 0);
        return `
            <div style="display:flex; justify-content:space-between; align-items:center;
                        padding:10px; border-bottom:1px solid rgba(var(--overlay-rgb),0.07);">
                <div>
                    <span style="font-weight:600;">${formatShortDate(s.date)}</span>
                    <span style="color:var(--color-text-muted); font-size:12px;"> ${s.time}</span><br>
                    <small style="color:var(--color-text-muted);">${t('stock.sessionTotal', { grams: s.grams })}</small>
                </div>
                <input type="number" step="0.01" min="0"
                       data-id="${s.id}"
                       data-type="${type}"
                       data-total="${s.grams}"
                       data-old="${gram}"
                       value="${gram}"
                       style="width:80px; text-align:center; margin:0; font-weight:700; color:var(--heading);">
            </div>
        `;
    }).join('');

    document.getElementById('manualFixModal').style.display = 'flex';
}

async function saveManualFix() {
    const inputs = document.querySelectorAll('#manualFixList input[data-id]');
    const guestSmokes = isGuestMode ? getGuestSmokes() : null;

    for (const input of inputs) {
        const id = input.dataset.id;
        const type = input.dataset.type;
        const oldTotal = parseFloat(input.dataset.total);
        const oldGram = parseFloat(input.dataset.old);
        const newGram = parseFloat(input.value) || 0;
        const newTotal = parseFloat((oldTotal - oldGram + newGram).toFixed(2));

        const updateObj = type === 'fumo'
            ? { fumo_grams: newGram, grams: newTotal }
            : { erba_grams: newGram, grams: newTotal };

        if (isGuestMode) {
            const rec = guestSmokes.find(g => g.id === Number(id));
            if (rec) Object.assign(rec, updateObj);
        } else {
            await supabaseClient.from('smokes').update(updateObj).eq('id', id);
        }
    }

    if (isGuestMode) setGuestSmokes(guestSmokes);

    closeManualFix();
    showMessage(t('stock.sessionsFixed'));
    await loadData();
    confirmCloseStock();
}

function closeManualFix() {
    document.getElementById('manualFixModal').style.display = 'none';
}

// Chiusura effettiva della scorta nel DB
async function confirmCloseStock() {
    document.getElementById('discrepancyModal').style.display = 'none';
    if (!pendingCloseStock) return;

    const { stock } = pendingCloseStock;
    const closedAt = new Date().toISOString().split('T')[0];

    if (isGuestMode) {
        const guestPurchases = getGuestPurchases();
        const rec = guestPurchases.find(p => p.id === stock.id);
        if (rec) Object.assign(rec, { is_closed: true, closed_at: closedAt });
        setGuestPurchases(guestPurchases);
    } else {
        const { error } = await supabaseClient
            .from('purchases')
            .update({ is_closed: true, closed_at: closedAt })
            .eq('id', stock.id);

        if (error) { alert(t('stock.closeStockError')); return; }
    }

    showMessage(t('stock.stockClosed'));
    pendingCloseStock = null;
    sessionsToFix = [];
    await loadPurchases();
}
		


	// ========== INIZIALIZZAZIONE ==========
	document.getElementById("date").value = toDateStr(new Date());
	document.getElementById("time").value = nowTimeStr();

	document.querySelectorAll('input[name="g"]').forEach(r => {
		r.addEventListener("change", e => {
			document.querySelectorAll(".grams-row label").forEach(l => l.classList.remove("selected"));
			e.target.parentElement.classList.add("selected");
			document.getElementById("customGrams").style.display = e.target.value === "custom" ? "block" : "none";
		});
	});

	// ========== GESTIONE MENU DROPDOWN ==========

function toggleMenu() {
	const menu = document.getElementById('menu');
	menu.classList.toggle('active');
}

// Chiudi il menu quando clicchi su un bottone
document.addEventListener('DOMContentLoaded', function() {
	const feedToggle = document.getElementById('snapshotFeedToggle');
	if (feedToggle) feedToggle.addEventListener('click', () => toggleSnapshotFeed());

	const menuButtons = document.querySelectorAll('#menu button');
	menuButtons.forEach(btn => {
		btn.addEventListener('click', function() {
			setTimeout(() => {
				document.getElementById('menu').classList.remove('active');
			}, 100);
		});
	});

	// Chiudi menu/notifiche se clicchi fuori
	document.addEventListener('click', function(event) {
		const menu = document.getElementById('menu');
		const hamburgerBtn = document.getElementById('hamburgerBtn');
		const notifPanel = document.getElementById('notifPanel');
		const notifBtn = document.getElementById('notifBtn');

		if (menu && hamburgerBtn && !menu.contains(event.target) && !hamburgerBtn.contains(event.target)) {
			menu.classList.remove('active');
		}
		if (notifPanel && notifBtn && !notifPanel.contains(event.target) && !notifBtn.contains(event.target)) {
			notifPanel.classList.remove('active');
		}
	});
});
	

	// ========== SERVICE WORKER: registrazione per il caching offline ==========
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW non registrato:', err));
	}
	updateOnlineStatus();

	initTheme();
	checkAuth();

// ========== PWA INSTALL: bottone custom (Chromium) + istruzioni manuali (iOS) ==========
let deferredInstallPrompt = null;

function isStandaloneMode() {
	return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIOSDevice() {
	return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

// Chrome/Edge/Android: il browser spara questo evento invece di mostrare da solo
// il proprio prompt d'installazione. Lo salviamo per poterlo attivare noi dal bottone custom.
window.addEventListener('beforeinstallprompt', function(e) {
	e.preventDefault();
	deferredInstallPrompt = e;
	updateInstallUI();
});

window.addEventListener('appinstalled', function() {
	deferredInstallPrompt = null;
	updateInstallUI();
});

// Safari/iOS non implementa beforeinstallprompt: se l'app non è già installata,
// mostriamo le istruzioni manuali per "Aggiungi a Home" invece del bottone.
function updateInstallUI() {
	const card = document.getElementById('installAppCard');
	const androidBtn = document.getElementById('installAppBtn');
	const iosHint = document.getElementById('installAppIosHint');
	if (!card || !androidBtn || !iosHint) return;

	if (isStandaloneMode()) {
		card.style.display = 'none';
		return;
	}

	if (deferredInstallPrompt) {
		card.style.display = 'block';
		androidBtn.style.display = 'block';
		iosHint.style.display = 'none';
	} else if (isIOSDevice()) {
		card.style.display = 'block';
		androidBtn.style.display = 'none';
		iosHint.style.display = 'block';
	} else {
		card.style.display = 'none';
	}
}

async function installApp() {
	if (!deferredInstallPrompt) return;
	deferredInstallPrompt.prompt();
	await deferredInstallPrompt.userChoice;
	deferredInstallPrompt = null;
	updateInstallUI();
}

updateInstallUI();