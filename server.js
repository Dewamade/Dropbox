const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { saveRegistration, getAllRegistrations, clearRegistrations, getSettingsFull, saveSettingsFull, getSelectors, saveSelectors, resetSelectors } = require('./db.js');
const { registerSingleEmail: _registerSingleEmail, daemonStatus } = require('./register.js');
const camofox = require('./camofox-manager');
const proxyManager = require('./proxy-manager');

// ── Random name generator (syllable-based) ──────────────────────────────────
function getRandomName() {
    const startConsonants = ['B', 'C', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'T', 'W', 'Y', 'Br', 'Cl', 'Dr', 'Fr', 'Gr', 'Pr', 'Sh', 'St', 'Tr'];
    const midVowels = ['a', 'e', 'i', 'o', 'u', 'ay', 'ee', 'ea', 'ie', 'oa', 'y'];
    const endConsonants = ['d', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'ck', 'ld', 'nd', 'ng', 'nt', 'th'];

    const makeSyllable = () => {
        const onset = startConsonants[Math.floor(Math.random() * startConsonants.length)];
        const vowel = midVowels[Math.floor(Math.random() * midVowels.length)];
        const coda = Math.random() > 0.25 ? endConsonants[Math.floor(Math.random() * endConsonants.length)] : '';
        return onset + vowel + coda;
    };

    const makeName = () => {
        let name = makeSyllable();
        if (Math.random() > 0.5) {
            const suffix = ['on', 'an', 'en', 'er', 'et', 'ie', 'y', 'al', 'us', 'a', 'is'][Math.floor(Math.random() * 11)];
            name = name.substring(0, name.length - (name.length > 4 ? 1 : 0)) + suffix;
        }
        return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    };

    return { first: makeName(), last: makeName() };
}

// Re-export getRandomName for register.js if needed
global.getRandomName = getRandomName;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── History REST endpoints ──────────────────────────────────────────────────
app.get('/api/history', (_req, res) => {
    res.json(getAllRegistrations());
});

app.delete('/api/history', (_req, res) => {
    clearRegistrations();
    res.json({ ok: true });
});

// ── Live status of the local engines (WARP / Psiphon / camofox / daemon) ──
app.get('/api/proxy/status', (_req, res) => {
    try {
        res.json({
            ...proxyManager.status(),
            camofox: camofox.status(),
            daemon: daemonStatus(),
            dropboxDaemon: !!(global.isDropboxRunning && global.isDropboxRunning()),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Exit IP CAMOUFOX, bukan IP browser yang membuka dashboard. Jalur yang dipakai =
// pin server browser yang sedang hidup (camofox.status().proxy; null = direct),
// atau jalur yang dipilih di pengaturan kalau engine belum jalan. Diukur dari sisi
// host lewat jalur yang sama (direct = rute host, proxy = SOCKS5 yang sama), jadi
// baris log ini tidak menyalakan browser. Angka yang diukur DI DALAM tab tetap
// dicetak engine sendiri sebagai `[Server] Public IP (via browser/<mode>)`.
app.get('/api/exit-ip', async (_req, res) => {
    try {
        const cs = camofox.status();
        const engineRunning = cs.running;
        let proxy = null;
        if (engineRunning) {
            if (cs.proxy) {
                const u = new URL(cs.proxy);
                proxy = { host: u.hostname, port: Number(u.port) };
            }
        } else {
            const st = proxyManager.status();
            if (proxyMode === 'warp') {
                if (!st.warp) return res.json({ ok: false, reason: 'engine belum jalan dan WARP belum aktif' });
                proxy = { host: '127.0.0.1', port: warpPort };
            } else if (proxyMode === 'psiphon') {
                if (!st.psiphon) return res.json({ ok: false, reason: 'engine belum jalan dan Psiphon belum aktif' });
                proxy = { host: '127.0.0.1', port: st.psiphonPort };
            }
        }
        const found = proxy
            ? await proxyManager.socksExitIp(proxy.host, proxy.port)
            : await proxyManager.directExitIp();
        if (!found) return res.json({ ok: false, reason: 'tidak ada endpoint exit-IP yang menjawab' });
        const port = proxy ? proxy.port : null;
        const exitPath = !port ? 'direct' : port === warpPort ? 'warp' : port === proxyManager.PSIPHON_PORT ? 'psiphon' : 'socks5';
        res.json({ ok: true, ip: found.ip, warp: found.warp, endpoint: found.endpoint, via: found.via, exitPath, engineRunning });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Force a new exit IP: WARP gets a fresh key (reg.json regenerated), Psiphon
// restarts the tunnel and picks a new country. Refused while a batch runs —
// rotating mid-registration would pull the proxy out from under the open tab.
app.post('/api/proxy/rotate', async (req, res) => {
    if (isRunning) return res.status(409).json({ error: 'Batch sedang berjalan — hentikan dulu sebelum rotasi IP.' });
    const type = (req.body && req.body.type) === 'psiphon' ? 'psiphon' : 'warp';
    try {
        const r = type === 'psiphon'
            ? await proxyManager.startPsiphon({ rotate: true })
            : await proxyManager.startWarp({ port: warpPort, rotate: true });
        res.json({ ok: true, type, ...r, ...proxyManager.status() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ────────────────────────────────────────────────────────────────────────────

// Keep track of active connection for console redirection
let activeWs = null;
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

// Satu bentuk payload penghitung untuk UI — setiap cabang yang mengubah angka
// WAJIB mengirim progress dengan field ini (kalau tidak, kartunya basi):
//   successCount = akun jadi dan terverifikasi
//   limitCount   = percobaan mentok di "batas" Dropbox (rate-limit atau CAPTCHA);
//                  kartunya di UI bernama Blocked
//   errorCount   = percobaan gagal karena masalah teknis (timeout, proxy/daemon
//                  tidak bisa start, field/tombol tidak muncul, dst.)
//   verifCount   = akun jadi tapi belum terverifikasi. Tidak punya kartu di UI
//                  (kartu ketiga = Blocked), tapi tetap dikirim karena
//                  cincin progress menghitung VERIF sebagai selesai.
const counterFields = (successCount = 0, limitCount = 0, errorCount = 0, verifCount = 0) =>
    ({ successCount, limitCount, errorCount, verifCount });

// Kontrak klasifikasi kegagalan lintas modul (register.js → server.js):
// kondisi batas ditandai di pesan error-nya — 'Too many attempts…' dari
// checkTooManyAttempts dan 'CAPTCHA_DETECTED: …' dari checkPageLimit. Yang
// memulihkan keduanya adalah IP keluar + profil browser baru (atau manusia
// yang menyelesaikan CAPTCHA di noVNC), bukan perbaikan teknis, jadi masuk
// Blocked ('limit'). Selain itu = Error.
const LIMIT_ERROR_PATTERN = /too many attempts|please try later|terlalu banyak percobaan|coba lagi nanti|captcha/i;
const isLimitFailure = (message) => LIMIT_ERROR_PATTERN.test(String(message || ''));

let globalState = {
    progress: { current: 0, total: 0, status: 'Standby', ...counterFields() },
    stats: { timeouts: 0, errors: 0 },
    info: { alias: '-', mode: '-', email: '-', ip: '-', ua: '-' },
    // Batch terakhir berhenti karena tombol Hentikan / anggaran rentetan habis (bukan
    // target tercapai). label worker (pill + badge) membacanya untuk menampilkan
    // TERHENTI alih-alih FINISH — ikut terkirim lewat sync_state di `state`, jadi
    // halaman yang dimuat ulang menampilkan label yang sama dengan halaman yang terbuka.
    lastBatchStopped: false,
    logs: []
};

// --- Worker Status Management ---
let workerStatus = 'BOOT';
let sessionTimeout = null;
let warningTimeout = null;
let sessionExpiryTime = 0;

// Load persisted settings (full)
const savedSettings = getSettingsFull();
let idleDurationMs = (savedSettings.idleTimeout || 600) * 1000; // Configurable idle timeout (default: 10 minutes)

// Other persisted settings
// Unit: SECONDS (register.js multiplies by 1000). Kept identical to the units the
// UI sends and selector.json's defaults declare.
let globalTimeout = savedSettings.globalTimeout || 30;
let daemonTimeout = savedSettings.daemonTimeout || 120;
let useHeadless = savedSettings.useHeadless !== false;
let warpPort = savedSettings.warpPort || proxyManager.DEFAULT_WARP_PORT;
// Satu jalur proxy saja ('none' | 'warp' | 'psiphon'). Field boolean lama
// (useWarp/useSocks5/usePsiphon) hanya dibaca sekali untuk memigrasi
// history.json yang dibuat sebelum pengaturan ini ada.
const normalizeProxyMode = (v, legacy) => {
    if (v === 'none' || v === 'warp' || v === 'psiphon') return v;
    if (legacy) {
        if (legacy.useWarp) return 'warp';
        if (legacy.usePsiphon) return 'psiphon';
    }
    return 'none';
};
let proxyMode = normalizeProxyMode(savedSettings.proxyMode, savedSettings);
// Direct adalah jalur yang bisa dipilih sendiri, boleh bersama satu jalur proxy:
//   Direct + proxy  -> percobaan 1 Direct, percobaan 2..N lewat proxy
//   hanya proxy     -> SEMUA percobaan (mulai dari yang pertama) lewat proxy
//   Direct saja     -> semua percobaan Direct
// Tanpa proxy dipilih, Direct tidak boleh dilepas: tidak ada jalur lain yang bisa
// dijalankan. Default true = perilaku lama (Direct selalu pertama).
const normalizeUseDirect = (v, mode) => (mode === 'none' ? true : (v === undefined ? true : !!v));
let useDirect = normalizeUseDirect(savedSettings.useDirect, proxyMode);
let debugProxy = savedSettings.debugProxy || false;

// New settings fields (persisted but not used as in-memory globals yet)
let aliasWorker = savedSettings.aliasWorker || '';
let urlDropbox = savedSettings.urlDropbox || '';
let emailSource = savedSettings.emailSource || 'auto';
let domainEmail = savedSettings.domainEmail || '';
let count = savedSettings.count || 8;
let passwordMode = savedSettings.passwordMode || 'fixed';
let fixedPassword = savedSettings.fixedPassword || '';
let globalRetry = savedSettings.globalRetry || 2;
let psiphonRegions = savedSettings.psiphonRegions || [];
global.psiphonRegions = psiphonRegions;
let enablePreview = savedSettings.enablePreview || false;

function setWorkerStatus(newStatus) {
    if (workerStatus === newStatus) return;
    workerStatus = newStatus;
    console.log(`[Worker] Status berubah ke: ${workerStatus}`);
    
    // Broadcast status update. `stopped` = batch terakhir dihentikan (bukan target
    // tercapai); UI memakai itu untuk melabeli FINISH sebagai TERHENTI.
    safeSend({ type: 'worker_status', status: workerStatus, stopped: !!globalState.lastBatchStopped });
}

function startIdleTimer() {
    clearIdleTimer();
    sessionExpiryTime = Date.now() + idleDurationMs;
    const warningMs = Math.max(0, idleDurationMs - 60000); // show warning 60s before

    if (warningMs > 0) {
        warningTimeout = setTimeout(() => {
            console.log(`[Worker] Sesi idle terdeteksi. Mengirim peringatan ke client.`);
            safeSend({ type: 'idle_warning', secondsLeft: 60 });
        }, warningMs);
    } else {
        // Timeout <= 60s, send warning immediately
        safeSend({ type: 'idle_warning', secondsLeft: Math.round(idleDurationMs / 1000) });
    }

    // Terminate/set idle after idleDurationMs
    sessionTimeout = setTimeout(() => {
        console.log(`[Worker] Sesi idle berakhir. Mengubah status ke IDLE.`);
        setWorkerStatus('IDLE');
    }, idleDurationMs);
}

function clearIdleTimer() {
    sessionExpiryTime = 0;
    if (sessionTimeout) {
        clearTimeout(sessionTimeout);
        sessionTimeout = null;
    }
    if (warningTimeout) {
        clearTimeout(warningTimeout);
        warningTimeout = null;
    }
}

// REST Endpoints for Worker Status
app.get('/api/worker-stat', (_req, res) => {
    let secondsLeft = 0;
    if (sessionExpiryTime > 0) {
        secondsLeft = Math.max(0, Math.round((sessionExpiryTime - Date.now()) / 1000));
    }
    res.json({ status: workerStatus, secondsLeft });
});

app.post('/api/worker-stat/boot', (_req, res) => {
    setWorkerStatus('BOOT');
    startIdleTimer();
    res.json({ ok: true });
});

app.post('/api/worker-stat/extend', (_req, res) => {
    if (workerStatus === 'BOOT' || workerStatus === 'FINISH') {
        startIdleTimer();
        safeSend({ type: 'idle_warning_cancel' });
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'Tidak dapat memperpanjang sesi dalam status saat ini' });
    }
});

app.post('/api/worker-stat/idle', (_req, res) => {
    if (workerStatus === 'BOOT' || workerStatus === 'FINISH') {
        clearIdleTimer();
        setWorkerStatus('IDLE');
        safeSend({ type: 'idle_warning_cancel' });
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'Tidak dapat mengubah status ke IDLE dalam status saat ini' });
    }
});

app.get('/api/settings', (_req, res) => {
    const allSettings = getSettingsFull();
    // Also include in-memory globals that may not be persisted yet
    res.json({
        ...allSettings,
        idleTimeout: parseInt(idleDurationMs / 1000),
        globalTimeout,
        daemonTimeout,
        useHeadless,
        warpPort,
        proxyMode,
        useDirect,
        debugProxy,
        aliasWorker,
        urlDropbox,
        emailSource,
        domainEmail,
        count,
        passwordMode,
        fixedPassword,
        globalRetry,
        enablePreview
    });
});

app.post('/api/settings/apply', (req, res) => {
    const body = req.body || {};
    
    // 1. Get current settings to use as base (preventing data loss)
    const currentSettings = getSettingsFull();

    // Jalur keluar selalu divalidasi sepasang: proxy tunggal + apakah Direct
    // dipakai. proxyMode 'none' memaksa useDirect true (tanpa itu tidak ada
    // jalur yang bisa dijalankan).
    const mergedProxyMode = normalizeProxyMode(body.proxyMode !== undefined ? body.proxyMode : currentSettings.proxyMode, currentSettings);
    const mergedUseDirect = normalizeUseDirect(body.useDirect !== undefined ? body.useDirect : currentSettings.useDirect, mergedProxyMode);
    
    // 2. Create the merged settings object — capture EVERY field from the UI form
    const mergedSettings = {
        // ── TARGET ──────────────────────────────
        aliasWorker: body.aliasWorker !== undefined ? body.aliasWorker : currentSettings.aliasWorker,
        urlDropbox: body.urlDropbox !== undefined ? body.urlDropbox : currentSettings.urlDropbox,

        // ── EMAIL ───────────────────────────────
        emailSource: body.emailSource || currentSettings.emailSource,       // 'manual' | 'auto'
        domainEmail: body.domainEmail !== undefined ? body.domainEmail : currentSettings.domainEmail,
        count: typeof body.count === 'number' ? body.count : (parseInt(body.count) || currentSettings.count || 8),

        // ── PASSWORD ────────────────────────────
        passwordMode: body.passwordMode || currentSettings.passwordMode,    // 'fixed' | 'random'
        fixedPassword: body.fixedPassword !== undefined ? body.fixedPassword : currentSettings.fixedPassword,

        // ── TIMEOUT & RETRY ─────────────────────
        globalTimeout: typeof body.globalTimeout === 'number' ? body.globalTimeout : (parseInt(body.globalTimeout) || currentSettings.globalTimeout || 30),
        globalRetry: typeof body.globalRetry === 'number' ? body.globalRetry : (parseInt(body.globalRetry) || currentSettings.globalRetry || 2),
        daemonTimeout: typeof body.daemonTimeout === 'number' ? body.daemonTimeout : (parseInt(body.daemonTimeout) || currentSettings.daemonTimeout || 120),

        // ── BROWSER & KONEKSI ───────────────────
        useHeadless: typeof body.useHeadless === 'boolean' ? body.useHeadless : (body.useHeadless !== undefined ? !!body.useHeadless : currentSettings.useHeadless),
        warpPort: (typeof body.warpPort === 'number' ? body.warpPort : parseInt(body.warpPort)) || currentSettings.warpPort || proxyManager.DEFAULT_WARP_PORT,

        // Jalur keluar: satu proxy maksimum + Direct boleh dipilih/dilepas.
        proxyMode: mergedProxyMode,
        useDirect: mergedUseDirect,
        psiphonRegions: body.psiphonRegions !== undefined ? (Array.isArray(body.psiphonRegions) ? body.psiphonRegions : []) : (currentSettings.psiphonRegions || []),

        // ── LAIN-LAIN ───────────────────────────
        idleTimeout: typeof body.idleTimeout === 'number' ? body.idleTimeout : (parseInt(body.idleTimeout) || currentSettings.idleTimeout || 600),
        debugProxy: typeof body.debugProxy === 'boolean' ? body.debugProxy : (body.debugProxy !== undefined ? !!body.debugProxy : currentSettings.debugProxy),
        enablePreview: body.enablePreview !== undefined ? !!body.enablePreview : (currentSettings.enablePreview || false)
    };

    // 3. Save the merged settings to file
    saveSettingsFull(mergedSettings);

    // 4. Update in-memory application state (crucial for running processes)
    globalTimeout = mergedSettings.globalTimeout;
    daemonTimeout = mergedSettings.daemonTimeout;
    useHeadless = mergedSettings.useHeadless;
    warpPort = mergedSettings.warpPort;
    proxyMode = mergedSettings.proxyMode;
    useDirect = mergedSettings.useDirect;
    debugProxy = mergedSettings.debugProxy;

    // New settings fields — update in-memory globals too
    aliasWorker = mergedSettings.aliasWorker;
    urlDropbox = mergedSettings.urlDropbox;
    emailSource = mergedSettings.emailSource;
    domainEmail = mergedSettings.domainEmail;
    count = mergedSettings.count;
    passwordMode = mergedSettings.passwordMode;
    fixedPassword = mergedSettings.fixedPassword;
    globalRetry = mergedSettings.globalRetry;
    psiphonRegions = mergedSettings.psiphonRegions;
    global.psiphonRegions = psiphonRegions;
    enablePreview = mergedSettings.enablePreview;
    
    // Apply idle timeout (restart timer if needed)
    if (body.idleTimeout !== undefined) {
        const secs = parseInt(body.idleTimeout);
        if (!isNaN(secs) && secs >= 30) {
            idleDurationMs = secs * 1000;
            console.log(`[Settings] Idle timeout diperbarui ke ${secs} detik.`);            
            // Restart idle timer if it's currently active
            if (sessionTimeout && (workerStatus === 'BOOT' || workerStatus === 'FINISH')) {
                startIdleTimer();
            }
        }
    }

    res.json({ ok: true });
});

// ── Selector Management Endpoints ────────────────────────────────────────────
app.get('/api/selectors', (_req, res) => {
    const selectors = getSelectors();
    // If no stored selectors, return defaults from selector.json
    if (Object.keys(selectors).length === 0) {
        try {
            const fs = require('fs');
            const path = require('path');
            const selectorPath = path.join(__dirname, 'selector.json');
            if (fs.existsSync(selectorPath)) {
                const defaults = JSON.parse(fs.readFileSync(selectorPath, 'utf8'));
                return res.json(defaults);
            }
        } catch (_) {}
    }
    res.json(selectors);
});

app.put('/api/selectors', (req, res) => {
    const selectors = req.body || {};
    saveSelectors(selectors);
    // Also write to selector.json for persistence alongside history.json
    try {
        const fs = require('fs');
        const path = require('path');
        const selectorPath = path.join(__dirname, 'selector.json');
        fs.writeFileSync(selectorPath, JSON.stringify(selectors, null, 2));
    } catch (e) {
        console.warn('[Selectors] Failed to write selector.json:', e.message);
    }
    res.json({ ok: true });
});

app.post('/api/selectors/reset', (_req, res) => {
    resetSelectors();
    // Also reload defaults from selector.json
    try {
        const fs = require('fs');
        const path = require('path');
        const selectorPath = path.join(__dirname, 'selector.json');
        if (fs.existsSync(selectorPath)) {
            const defaults = JSON.parse(fs.readFileSync(selectorPath, 'utf8'));
            saveSelectors(defaults);
        }
    } catch (_) {}
    res.json({ ok: true });
});
// ────────────────────────────────────────────────────────────────────────────

function safeSend(socketOrPayload, maybePayload) {
    let payload = maybePayload;
    if (arguments.length === 1) {
        payload = socketOrPayload;
    }
    if (!payload || !payload.type) return;

    if (payload.type === 'log') {
        globalState.logs.push(payload);
        if (globalState.logs.length > 100) globalState.logs.shift();
    } else if (payload.type === 'progress') {
        globalState.progress = { ...globalState.progress, ...payload };
    } else if (payload.type === 'info') {
        globalState.info = { ...globalState.info, ...payload.info };
    } else if (payload.type === 'email_stats') {
        globalState.stats = { ...globalState.stats, ...payload };
    }

    if (payload.type === 'sync_state' || payload.type === 'pong') {
        let socket = arguments.length === 2 ? socketOrPayload : null;
        if (socket && socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify(payload)); } catch (e) {}
        }
        return;
    }

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(payload));
            } catch (e) {}
        }
    });
}

// Expose globally so register.js can use them via console.log
global.safeSend = safeSend;
global.activeWs = null; // Kept for backward compatibility with register.js

console.log = (...args) => {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalLog.apply(console, args);
    safeSend({ type: 'log', message: msg });
};

console.error = (...args) => {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalError.apply(console, args);
    safeSend({ type: 'log', message: `[ERROR] ${msg}` });
};

console.warn = (...args) => {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalWarn.apply(console, args);
    safeSend({ type: 'log', message: `[WARNING] ${msg}` });
};

let isRunning = false;
let shouldStop = false;
let currentAbortController = null;

wss.on('connection', (ws) => {
    originalLog('Client connected via WebSocket');

    let secondsLeft = 0;
    if (sessionExpiryTime > 0) {
        secondsLeft = Math.max(0, Math.round((sessionExpiryTime - Date.now()) / 1000));
    }

    // Send current status and full sync state
    safeSend(ws, { type: 'status', status: isRunning ? 'running' : 'idle' });
    safeSend(ws, {
        type: 'sync_state',
        isRunning,
        workerStatus,
        secondsLeft,
        state: globalState
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.action === 'ping') {
                safeSend(ws, { type: 'pong' });
                return;
            }

            if (data.action === 'stop') {
                if (!isRunning) return;
                shouldStop = true;
                console.log('🛑 Perintah Hentikan diterima dari UI.');
                if (currentAbortController) {
                    currentAbortController.shouldStop = true;
                    if (typeof currentAbortController.abort === 'function') {
                        await currentAbortController.abort();
                    }
                }
                if (global.closeBrowserSession) await global.closeBrowserSession();
                if (global.killDropboxDaemon) global.killDropboxDaemon({ log: false });
                if (global.killAllVpnProxy) await global.killAllVpnProxy();
                // Hentikan TIDAK mereset penghitung/status: hasil batch terakhir tetap
                // terbaca (juga setelah refresh, lewat sync_state). Yang mereset semua
                // state hanyalah action 'start' (tombol Mulai Pendaftaran).
                globalState.progress = { ...globalState.progress, status: 'Dihentikan' };
                safeSend(ws, { type: 'status', status: 'stopped' });
                return;
            }

            if (data.action === 'start') {
                if (isRunning) {
                    safeSend(ws, { type: 'log', message: '⚠️ Pendaftaran sedang berjalan!' });
                    return;
                }

                clearIdleTimer();
                setWorkerStatus('PROCESSING');

                isRunning = true;
                shouldStop = false;
                activeWs = ws;
                global.activeWs = ws;
                
                // Reset state on new run — SATU-satunya tempat penghitung dan info
                // di-nol-kan (Hentikan dan akhir batch sengaja mempertahankannya).
                globalState.progress = { current: 0, total: 0, status: 'Memulai...', ...counterFields() };
                globalState.stats = { timeouts: 0, errors: 0 };
                globalState.info = { alias: '-', mode: '-', email: '-', ip: '-', ua: '-' };
                globalState.lastBatchStopped = false;
                globalState.logs = [];

                safeSend(ws, { type: 'status', status: 'running' });

                // ── Live Preview: screenshot interval ─────────────
                global.livePreview = !!data.enablePreview;
                let screenshotInterval = null;
                if (global.livePreview) {
                    screenshotInterval = setInterval(async () => {
                        try {
                            if (typeof global.previewScreenshot !== 'function') return;
                            const buf = await global.previewScreenshot();
                            if (buf) safeSend({ type: 'preview', data: buf.toString('base64'), mime: 'image/png' });
                        } catch (_) { /* session may be closing */ }
                    }, 1500);
                }

                const { 
                    action, alias, url, emails: emailsRaw, emailMode, domain, count, 
                    globalTimeout, globalRetry, daemonTimeout,
                    proxyMode: clientProxyMode, useDirect: clientUseDirect, warpPort: clientWarpPort, useHeadless, passwordMode, fixedPassword, debugProxy,
                    psiphonRegions: clientPsiphonRegions
                } = data;

                global.debugProxy = !!debugProxy;
                const activeWarpPort = parseInt(clientWarpPort, 10) || warpPort || proxyManager.DEFAULT_WARP_PORT;
                // Payload start dari UI menang atas state tersimpan; kalau tidak dikirim,
                // pakai pengaturan yang aktif.
                const activeProxyMode = ['none', 'warp', 'psiphon'].includes(clientProxyMode) ? clientProxyMode : proxyMode;
                const activeUseDirect = normalizeUseDirect(clientUseDirect !== undefined ? clientUseDirect : useDirect, activeProxyMode);
                global.psiphonRegions = Array.isArray(clientPsiphonRegions) ? clientPsiphonRegions : [];
                global.psiphonUsedRegions = [];
                
                let emails = [];
                if (emailMode === 'auto') {
                    // Generate random emails using dynamically generated first name and last name
                    for (let i = 0; i < count; i++) {
                        const { first, last } = getRandomName();
                        const randomDigits = Math.floor(10 + Math.random() * 90); // 2 random digits
                        const randomString = `${first.toLowerCase()}.${last.toLowerCase()}${randomDigits}`;
                        emails.push(`${randomString}@${domain}`);
                    }
                } else {
                    emails = emailsRaw.split(';')
                                      .map(e => e.trim())
                                      .filter(e => e.length > 0);
                }

                if (emails.length === 0) {
                    safeSend(ws, { type: 'log', message: 'Error: Tidak ada email valid!' });
                    safeSend(ws, { type: 'status', status: 'error' });
                    isRunning = false;
                    activeWs = null;
                    global.activeWs = null;
                    return;
                }

                console.log(`[Server] Memulai pendaftaran massal untuk ${emails.length} email.`);
                console.log(`[Server] Mode Password: ${passwordMode === 'fixed' ? `Fixed (${fixedPassword})` : 'Random'}`);

                let successCount = 0;
                let limitCount = 0;
                let errorCount = 0;
                let verifCount = 0;
                let accountsDone = 0;

                // ── Anggaran percobaan = globalRetry, TAPI bukan per email: ──────────
                //    globalRetry = berapa percobaan BERURUTAN yang boleh gagal; setiap
                //    keberhasilan me-reset hitungan ini. Tiap percobaan selalu
                //    IDENTITAS BARU: nama + email baru, profil camofox baru (register.js
                //    membuat userId unik per panggilan + profil lama dihapus) dan IP
                //    keluar baru (isRetry=true -> WARP reg.json baru / region Psiphon
                //    baru). 'Too many attempts' / CAPTCHA menempel pada identitas + IP
                //    keluar, jadi mengulang email yang sama tidak pernah menolong.
                //    Percobaan pertama dalam satu rentetan = Direct HANYA kalau
                //    jalur Direct dipilih di UI (useDirect) DAN belum ada jalur yang
                //    terbukti berhasil; begitu satu akun jadi lewat sebuah jalur,
                //    percobaan pertama akun berikutnya MELANJUTKAN jalur itu (IP-nya
                //    terbukti jalan, memulainya lagi dari Direct cuma membakar satu
                //    percobaan). Sisanya selalu jalur proxy tunggal yang dipilih
                //    ('none' = tidak ada proxy, jadi Direct terus). Direct dilepas +
                //    satu proxy dipilih = batch berjalan lewat proxy itu dari
                //    percobaan pertama, retry sampai anggaran rentetan habis
                //    (globalRetry). workingPath hidup hanya selama batch ini:
                //    'Mulai Pendaftaran' baru = mulai lagi dari Direct.
                const maxAttempts = Math.max(1, globalRetry || 3);
                const wantedAccounts = emails.length;
                const pathLabelOf = (type) => {
                    if (type === 'warp') return `WARP (SOCKS5 127.0.0.1:${activeWarpPort})`;
                    if (type === 'psiphon') return `Psiphon (SOCKS5 127.0.0.1:${proxyManager.PSIPHON_PORT})`;
                    return 'Direct (IP asli, tanpa proxy)';
                };
                let workingPath = null;
                const firstPathOfBatch = () => (activeUseDirect ? 'direct' : activeProxyMode);
                const pathFor = (attemptNo) => {
                    if (activeProxyMode === 'none') return 'direct';
                    if (attemptNo > 1) return activeProxyMode;
                    return workingPath || firstPathOfBatch();
                };
                // Percobaan pertama yang TIDAK lagi memakai aturan Direct-dulu,
                // supaya log bisa menjelaskan alasannya.
                const isContinuedPath = (attemptNo, type) =>
                    attemptNo === 1 && !!workingPath && type !== firstPathOfBatch();
                // Cara jalur dipakai, untuk satu baris rencana di log: hanya dipakai
                // untuk menjelaskan apa yang akan dijalankan, tidak untuk alur.
                const pathPlanText = () => {
                    if (activeProxyMode === 'none') return 'Semua percobaan lewat Direct (tidak ada proxy dipilih)';
                    if (!activeUseDirect) return `Semua percobaan lewat ${activeProxyMode.toUpperCase()} (Direct tidak dipilih)`;
                    return 'Percobaan 1 lewat Direct, sisanya lewat ' + activeProxyMode.toUpperCase()
                        + `; begitu satu akun jadi lewat ${activeProxyMode.toUpperCase()}, akun berikutnya mulai dari jalur itu lagi`;
                };

                // Sumber identitas: email dari daftar dipakai sekali (mode manual),
                // sesudah itu nama + email baru di domain yang sama — generator yang
                // sama dengan mode 'auto'.
                let poolIndex = 0;
                let lastDomain = String(emails[0]).split('@')[1] || domain || '';
                const nextIdentity = () => {
                    if (poolIndex < emails.length) {
                        const e = emails[poolIndex++];
                        lastDomain = String(e).split('@')[1] || lastDomain;
                        return e;
                    }
                    const { first, last } = getRandomName();
                    const digits = Math.floor(10 + Math.random() * 90);
                    return `${first.toLowerCase()}.${last.toLowerCase()}${digits}@${lastDomain}`;
                };

                console.log(`[Server] Target ${wantedAccounts} akun; maksimum ${maxAttempts} percobaan berturut-turut tanpa keberhasilan — tiap percobaan memakai email + nama + profil + IP keluar baru, keberhasilan me-reset hitungan. ${pathPlanText()}.`);

                // Kelas kegagalan percobaan TERAKHIR dalam rentetan ini ('limit' |
                // 'error') — dari pesan error TERAKHIR percobaan itu, karena itulah
                // yang menahannya. Dipakai hanya untuk memilih kata di log batch.
                let lastFailClass = null;
                let emailTimeouts = 0;
                let emailErrors = 0;

                try {
                    // ── Satu percobaan = satu identitas. Mengembalikan true kalau
                    //    akun jadi (success/VERIF). GAGAL: penghitung Blocked/Error dan
                    //    record riwayat ditulis di sini juga, SEKETIKA setelah kegagalan
                    //    terlihat — bukan setelah anggaran retry habis.
                    async function runAttempt({ proxyType, phaseLabel, email, attempt, isRetry }) {
                        let registrationSuccess = false;

                        // IP keluar percobaan INI saja. Engine (register.js) mengisinya
                        // begitu jalur keluar benar-benar terukur; record riwayat gagal
                        // harus menyebut IP yang dipakai percobaan itu, dan '-' kalau
                        // kematian terjadi sebelum ada IP terukur (proxy mati, tab gagal).
                        global.currentExitIp = '';

                        // Any hard reset between attempts: drop the browser session
                        // (camofox profile + tab) and the daemon, keep the server up.
                        const resetSession = async () => {
                            if (global.closeBrowserSession) await global.closeBrowserSession();
                            if (global.killDropboxDaemon) global.killDropboxDaemon({ log: false });
                        };

                        // Pencatatan hasil sukses — dipakai jalur normal maupun jalur
                        // pengulangan device connect dengan sesi yang sama.
                        const handleSuccess = (result) => {
                            registrationSuccess = true;
                            const finalStatus = result.status || 'success';
                            if (finalStatus === 'VERIF') {
                                verifCount++;
                            } else {
                                successCount++;
                            }
                            console.log(`✓ Pendaftaran ${finalStatus} untuk ${email} (password: ${result.password})`);
                            safeSend(ws, { type: 'email_success', email: email });
                            // Update progress ring: akun ini sudah jadi.
                            safeSend(ws, {
                                type: 'progress',
                                current: accountsDone + 1,
                                total: wantedAccounts,
                                status: `Berhasil: ${email}`,
                                ...counterFields(successCount, limitCount, errorCount, verifCount),
                                success: true
                            });
                            try {
                                saveRegistration({ email, password: result.password, status: finalStatus, alias, ip: result.ip, connection: proxyType });
                            } catch (dbErr) {
                                originalError('DB save error:', dbErr.message);
                            }
                        };

                        // Hasil akhir sebuah percobaan yang GAGAL: kartu Blocked/Error naik
                        // dan record riwayat ditulis SEKARANG, tidak menunggu anggaran
                        // retry habis. Blocked ('limit') = 'too many attempts' / CAPTCHA
                        // (kelas dari pesan error terakhir); Error ('error') = sisanya
                        // (timeout, proxy/daemon tidak jalan, tombol tidak ketemu, dst).
                        const failAttempt = (failClass) => {
                            lastFailClass = failClass;
                            // IP keluar yang TERUKUR pada percobaan inilah yang dicatat,
                            // supaya "kenapa blocked ini terjadi" bisa ditelusuri ke satu
                            // IP/profil. '' (→ '-' di tabel) berarti belum ada IP terukur.
                            const failIp = global.currentExitIp || '';
                            // Satu baris yang menyebut SEMUA yang perlu diketahui soal
                            // kegagalan ini: kelas, percobaan ke-N, jalur keluar, dan
                            // identitas yang dipakai. Baris `❌ Error percobaan …` hanya
                            // punya pesan; emailnya baru terlihat di sini.
                            console.log(`[FAIL] ${failClass === 'limit' ? 'Blocked (batas Dropbox / CAPTCHA)' : 'Error (kegagalan teknis)'} — percobaan ${attempt}/${maxAttempts} via ${phaseLabel} → ${email}`);
                            if (failClass === 'limit') limitCount++; else errorCount++;
                            try {
                                saveRegistration({
                                    email,
                                    password: passwordMode === 'fixed' ? fixedPassword : '(random)',
                                    status: 'failed',
                                    alias,
                                    ip: failIp,
                                    connection: proxyType,
                                    failClass
                                });
                            } catch (_) {}
                            safeSend(ws, {
                                type: 'progress',
                                current: accountsDone + 1,
                                total: wantedAccounts,
                                status: `Gagal ${failClass === 'limit' ? 'Blocked' : 'Error'}: ${email}`,
                                ...counterFields(successCount, limitCount, errorCount, verifCount),
                                success: false
                            });
                        };

                        if (isRetry) {
                            console.log(`\n[Mencoba Kembali] Percobaan ${attempt}/${maxAttempts} via ${phaseLabel} — email + nama BARU: ${email} (profil browser baru, IP keluar baru)`);
                        }

                        try {
                            currentAbortController = { shouldStop: false, abort: null };
                            const result = await _registerSingleEmail(
                                url, email, proxyType, null, // WARP/Psiphon = SOCKS5 lokal di register.js
                                currentAbortController, useHeadless,
                                passwordMode, fixedPassword, globalTimeout, daemonTimeout, alias, maxAttempts, isRetry,
                                { warpPort: activeWarpPort }
                            );

                            if (result && result.success) {
                                handleSuccess(result);
                                return true;
                            }

                            // Objek tanpa hasil = kegagalan teknis, jadi dihitung sebagai
                            // ERROR dan percobaan berikutnya sudah pasti email yang baru.
                            console.log(`⚠️ Pendaftaran ${email} mengembalikan hasil tidak valid (Percobaan ${attempt}/${maxAttempts}).`);
                            await resetSession();
                            emailErrors++;
                            safeSend(ws, { type: 'email_stats', timeouts: emailTimeouts, errors: emailErrors });
                            failAttempt('error');
                            return false;

                        } catch (error) {
                            if (shouldStop) return false;
                            const errMsg = (error.message || '');
                            let failClass = isLimitFailure(errMsg) ? 'limit' : 'error';

                            if (errMsg.toLowerCase().includes('timeout')) {
                                emailTimeouts++;
                            } else {
                                emailErrors++;
                            }
                            safeSend(ws, { type: 'email_stats', timeouts: emailTimeouts, errors: emailErrors });

                            console.log(`\n❌ Error percobaan ${attempt}/${maxAttempts} [${phaseLabel}]: ${errMsg.replace(/^(BROWSER_KILL_REQUIRED|DEVICE_CONNECT_FAILED): /, '').split('\n')[0]}`);

                            // Kegagalan di langkah menghubungkan perangkat: akun
                            // sudah dibuat dan tab masih login, jadi sesi TIDAK
                            // dimatikan — cukup ulangi langkah itu dengan sesi yang
                            // sama. Sesi baru dilepas untuk kegagalan yang memang
                            // mengharuskan mulai dari awal.
                            if (errMsg.startsWith('DEVICE_CONNECT_FAILED') && global.retryDeviceConnect) {
                                console.log(`🔌 Sesi dipertahankan — mengulang langkah menghubungkan perangkat tanpa login ulang...`);
                                currentAbortController = { shouldStop, abort: null };
                                try {
                                    const resumed = await global.retryDeviceConnect({ abortController: currentAbortController });
                                    if (resumed && resumed.success) {
                                        handleSuccess(resumed);
                                        return true;
                                    }
                                } catch (resumeError) {
                                    // Kelas diambil dari pesan TERAKHIR — kalau yang
                                    // gagal adalah pengulangannya, itulah yang menahan
                                    // akun ini, bukan kegagalan pertama.
                                    const resumeMsg = (resumeError.message || '');
                                    failClass = isLimitFailure(resumeMsg) ? 'limit' : 'error';
                                    console.log(`❌ Pengulangan device connect gagal: ${resumeMsg.split('\n')[0]}`);
                                }
                                // retryDeviceConnect menutup sesi sendiri saat langkah selesai.
                                await resetSession();
                            } else {
                                await resetSession();
                            }

                            failAttempt(failClass);
                            return false;
                        } finally {
                            currentAbortController = null;
                        }
                    }

                    // ── Satu percobaan = satu identitas. Anggaran = maxAttempts
                    //    kegagalan BERURUTAN; keberhasilan me-reset hitungan dan
                    //    menghitung satu akun. Email dari daftar hanya kolam awal:
                    //    begitu terpakai, identitas berikutnya nama + email baru di
                    //    domain yang sama.
                    let attemptsWithoutSuccess = 0;
                    while (accountsDone < wantedAccounts && !shouldStop) {
                        const attempt = ++attemptsWithoutSuccess;
                        const isRetry = attempt > 1;
                        const proxyType = pathFor(attempt);
                        const phaseLabel = pathLabelOf(proxyType);
                        const email = nextIdentity();
                        // Kartu timeout/error adalah milik SATU identitas: reset tiap
                        // percobaan, karena tiap percobaan identitas baru.
                        emailTimeouts = 0;
                        emailErrors = 0;
                        lastFailClass = null;

                        console.log(`\n[Jalur keluar] ${phaseLabel} — percobaan ${attempt} dari ${maxAttempts} (rentetan tanpa keberhasilan)${
                            isContinuedPath(attempt, proxyType) ? ' — melanjutkan jalur yang sudah berhasil' : ''}`);
                        safeSend(ws, { type: 'email_stats', timeouts: 0, errors: 0 });
                        safeSend(ws, {
                            type: 'progress',
                            current: accountsDone + 1,
                            total: wantedAccounts,
                            status: `Mencoba ${email} — percobaan ${attempt}/${maxAttempts} via ${phaseLabel}`,
                            ...counterFields(successCount, limitCount, errorCount, verifCount),
                            success: false
                        });

                        const ok = await runAttempt({ proxyType, phaseLabel, email, attempt, isRetry });
                        // Hentikan ditekan di tengah percobaan: tidak ada yang dihitung.
                        if (shouldStop) break;

                        if (ok) {
                            // Jalur yang menghasilkan akun ini dipakai lagi oleh
                            // percobaan pertama akun berikutnya (IP-nya terbukti
                            // jalan); baru batch berikutnya kembali ke Direct.
                            workingPath = proxyType;
                            accountsDone++;
                            attemptsWithoutSuccess = 0;   // keberhasilan me-reset anggaran
                            continue;
                        }

                        if (attempt >= maxAttempts) {
                            console.log(`\n🛑 Batas ${maxAttempts} percobaan berturut-turut tanpa keberhasilan tercapai (percobaan terakhir via ${phaseLabel}).`);
                            console.log(`🚫 Menghentikan semua proses pendaftaran dan masuk ke mode IDLE.`);
                            shouldStop = true;
                            break;
                        }

                        console.log(`🔄 ${lastFailClass === 'limit'
                            ? 'Batas Dropbox terdeteksi (rate-limit / CAPTCHA)'
                            : 'Kegagalan teknis'} — lanjut percobaan ${attempt + 1}/${maxAttempts} dengan email + nama + profil + IP keluar baru...`);
                        await new Promise((r) => setTimeout(r, 2000));
                    }

                    const finalStatus = shouldStop ? 'stopped' : 'success';
                    safeSend({ type: 'status', status: finalStatus });
                    // Ringkasan akhir selalu dikirim (juga saat berhenti): penghitung
                    // sengaja dipertahankan sampai Mulai Pendaftaran berikutnya, jadi
                    // halaman yang terbuka TIDAK boleh menampilkan angka basi/nol.
                    safeSend({
                        type: 'progress',
                        current: accountsDone,
                        total: wantedAccounts,
                        status: shouldStop
                            ? 'Batch dihentikan.'
                            : `Target ${wantedAccounts} akun tercapai.`,
                        ...counterFields(successCount, limitCount, errorCount, verifCount)
                    });
                    console.log(`📊 Ringkasan batch: ${accountsDone} dari ${wantedAccounts} akun jadi — ${successCount} sukses, ${verifCount} VERIF (akun jadi, belum terverifikasi), ${limitCount} BLOCKED (batas Dropbox), ${errorCount} ERROR tercatat.`);
                } catch (err) {
                    console.error('Error saat menjalankan proses pendaftaran:', err);
                    safeSend({ type: 'status', status: 'error' });
                } finally {
                    isRunning = false;
                    activeWs = null;
                    global.activeWs = null;
                    if (global.closeBrowserSession) await global.closeBrowserSession();
                    if (global.killDropboxDaemon) global.killDropboxDaemon({ log: false });
                    await proxyManager.stopAll();
                    // Stop live preview interval
                    if (screenshotInterval) clearInterval(screenshotInterval);
                    global.livePreview = false;
                    // Penghitung batch TETAP di sini (hanya 'start' yang mereset), supaya
                    // refresh halaman menampilkan hasil batch terakhir. Yang diganti hanya
                    // label statusnya — 'Dihentikan' kalau berhenti di tengah, 'Selesai'
                    // kalau semua email diproses.
                    globalState.progress = { ...globalState.progress, status: shouldStop ? 'Dihentikan' : 'Selesai' };
                    globalState.lastBatchStopped = !!shouldStop;

                    setWorkerStatus('FINISH');
                    startIdleTimer();
                }
            }
        } catch (err) {
            originalError('Error parsing WS message:', err);
        }
    });

    ws.on('close', () => {
        originalLog('Client disconnected');
        if (activeWs === ws) {
            activeWs = null;
            global.activeWs = null;
        }
    });
});

const PORT = process.env.PORT || 3000;

// Child processes (camofox server + Xvfb/x11vnc, warp-go, psiphon, dropboxd) must
// not survive the dashboard — kill the whole tree on shutdown/restart.
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    originalLog(`\n[Server] ${signal} diterima, membersihkan proses anak...`);
    try {
        if (global.closeBrowserSession) await global.closeBrowserSession();
        if (global.killDropboxDaemon) global.killDropboxDaemon({ log: false });
        await proxyManager.stopAll();
        await camofox.stop({ log: (m) => originalLog(m) });
    } catch (e) {
        originalError('[Server] Pembersihan selesai dengan error:', e.message);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
    originalLog(`===================================================`);
    originalLog(`Server berjalan di http://localhost:${PORT}`);
    originalLog(`Buka URL di atas untuk mengakses Dashboard Pendaftaran`);
    originalLog(`===================================================`);
    
    // Initialize status to BOOT and start the 3-minute idle timer
    setWorkerStatus('BOOT');
    startIdleTimer();
});
