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

let globalState = {
    progress: { current: 0, total: 0, status: 'Standby', successCount: 0, failedCount: 0, verifCount: 0 },
    stats: { timeouts: 0, errors: 0 },
    info: { alias: '-', mode: '-', email: '-', ip: '-', ua: '-' },
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
let socks5Host = savedSettings.socks5Host || '';
let warpPort = savedSettings.warpPort || proxyManager.DEFAULT_WARP_PORT;
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
let useDirect = savedSettings.useDirect !== false;
let useWarp = savedSettings.useWarp || false;
let useSocks5 = savedSettings.useSocks5 || false;
let usePsiphon = savedSettings.usePsiphon || false;
let psiphonRegions = savedSettings.psiphonRegions || [];
global.psiphonRegions = psiphonRegions;
let enablePreview = savedSettings.enablePreview || false;

function setWorkerStatus(newStatus) {
    if (workerStatus === newStatus) return;
    workerStatus = newStatus;
    console.log(`[Worker] Status berubah ke: ${workerStatus}`);
    
    // Broadcast status update
    safeSend({ type: 'worker_status', status: workerStatus });
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
        socks5Host,
        warpPort,
        debugProxy,
        aliasWorker,
        urlDropbox,
        emailSource,
        domainEmail,
        count,
        passwordMode,
        fixedPassword,
        globalRetry,
        useDirect,
        useWarp,
        useSocks5,
        usePsiphon,
        enablePreview
    });
});

app.post('/api/settings/apply', (req, res) => {
    const body = req.body || {};
    
    // 1. Get current settings to use as base (preventing data loss)
    const currentSettings = getSettingsFull();
    
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
        socks5Host: body.socks5Host !== undefined ? body.socks5Host : currentSettings.socks5Host,
        warpPort: (typeof body.warpPort === 'number' ? body.warpPort : parseInt(body.warpPort)) || currentSettings.warpPort || proxyManager.DEFAULT_WARP_PORT,

        // Proxy type booleans
        useDirect:  body.useDirect  !== undefined ? !!body.useDirect  : (currentSettings.useDirect  !== false),
        useWarp:    body.useWarp    !== undefined ? !!body.useWarp    : (currentSettings.useWarp    || false),
        useSocks5:  body.useSocks5  !== undefined ? !!body.useSocks5  : (currentSettings.useSocks5  || false),
        usePsiphon: body.usePsiphon !== undefined ? !!body.usePsiphon : (currentSettings.usePsiphon || false),
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
    socks5Host = mergedSettings.socks5Host;
    warpPort = mergedSettings.warpPort;
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
    useDirect = mergedSettings.useDirect;
    useWarp = mergedSettings.useWarp;
    useSocks5 = mergedSettings.useSocks5;
    usePsiphon = mergedSettings.usePsiphon;
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
                // Reset progress state so refresh doesn't show stale data
                globalState.progress = { current: 0, total: 0, status: 'Dihentikan', successCount: 0, failedCount: 0, verifCount: 0 };
                globalState.stats = { timeouts: 0, errors: 0 };
                globalState.info = { alias: '-', mode: '-', email: '-', ip: '-', ua: '-' };
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
                
                // Reset state on new run
                globalState.progress = { current: 0, total: 0, status: 'Memulai...', successCount: 0, failedCount: 0, verifCount: 0 };
                globalState.stats = { timeouts: 0, errors: 0 };
                globalState.info = { alias: '-', mode: '-', email: '-', ip: '-', ua: '-' };
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
                    useDirect, useWarp, useSocks5, usePsiphon, socks5Host, warpPort: clientWarpPort, useHeadless, passwordMode, fixedPassword, debugProxy,
                    psiphonRegions: clientPsiphonRegions
                } = data;

                global.debugProxy = !!debugProxy;
                const activeWarpPort = parseInt(clientWarpPort, 10) || warpPort || proxyManager.DEFAULT_WARP_PORT;
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
                let failedCount = 0;
                let verifCount = 0;
                let processedCount = 0;

                try {
                    for (let i = 0; i < emails.length; i++) {
                        if (shouldStop) {
                            break;
                        }
                        processedCount = i + 1;
                        const email = emails[i];
                        let emailTimeouts = 0;
                        let emailErrors = 0;
                        
                        // Send initial stats to UI for the new email
                        safeSend(ws, { type: 'email_stats', timeouts: emailTimeouts, errors: emailErrors });
                        safeSend(ws, {
                            type: 'progress',
                            current: i + 1,
                            total: emails.length,
                            status: `Memproses email ke-${i+1} dari ${emails.length} (${email})`,
                            successCount,
                            failedCount,
                            verifCount,
                            success: false
                        });

                        let registrationSuccess = false;
                        const maxAttempts = globalRetry || 3;

                        // ── Helper: run inner browser retry loop for a given proxyType ───
                        const runBrowserLoop = async (proxyType, proxyHost, phaseLabel, isPhaseRetry) => {
                            // Any hard reset between attempts: drop the browser session
                            // (camofox profile + tab) and the daemon, keep the server up.
                            const resetSession = async () => {
                                if (global.closeBrowserSession) await global.closeBrowserSession();
                                if (global.killDropboxDaemon) global.killDropboxDaemon({ log: false });
                            };

                            // Pencatatan hasil sukses — dipakai jalur normal maupun
                            // jalur pengulangan device connect dengan sesi yang sama.
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
                                // Update progress ring for this successful email
                                safeSend(ws, {
                                    type: 'progress',
                                    current: processedCount,
                                    total: emails.length,
                                    status: `Berhasil: ${email}`,
                                    successCount,
                                    failedCount,
                                    verifCount,
                                    success: true
                                });
                                try {
                                    saveRegistration(email, result.password, finalStatus, alias, result.ip, result.ua, emailTimeouts, emailErrors);
                                } catch (dbErr) {
                                    originalError('DB save error:', dbErr.message);
                                }
                            };

                            let attempts = 0;
                            while (!registrationSuccess && attempts < maxAttempts) {
                                if (shouldStop) break;
                                attempts++;

                                const isRetry = isPhaseRetry || attempts > 1;
                                if (attempts > 1 || isPhaseRetry) {
                                    console.log(`\n[Mencoba Kembali] ${phaseLabel} — Attempt ${attempts}/${maxAttempts} untuk ${email}`);
                                }

                                try {
                                    currentAbortController = { shouldStop: false, abort: null };
                                    const result = await _registerSingleEmail(
                                        url, email, proxyType, proxyHost,
                                        currentAbortController, useHeadless,
                                        passwordMode, fixedPassword, globalTimeout, daemonTimeout, alias, maxAttempts, isRetry,
                                        { warpPort: activeWarpPort }
                                    );

                                    if (result && result.success) {
                                        handleSuccess(result);
                                    } else {
                                        console.log(`⚠️ Pendaftaran ${email} mengembalikan hasil tidak valid (Attempt ${attempts}).`);
                                        await resetSession();
                                    }

                                } catch (error) {
                                    if (shouldStop) break;
                                    const errMsg = (error.message || '');
                                    
                                    if (errMsg.toLowerCase().includes('timeout')) {
                                        emailTimeouts++;
                                    } else {
                                        emailErrors++;
                                    }
                                    safeSend(ws, { type: 'email_stats', timeouts: emailTimeouts, errors: emailErrors });
                                    
                                    console.log(`\n❌ Error attempt ${attempts}/${maxAttempts} [${phaseLabel}]: ${errMsg.replace(/^(BROWSER_KILL_REQUIRED|DEVICE_CONNECT_FAILED): /, '').split('\n')[0]}`);

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
                                            if (resumed && resumed.success) handleSuccess(resumed);
                                        } catch (resumeError) {
                                            console.log(`❌ Pengulangan device connect gagal: ${(resumeError.message || '').split('\n')[0]}`);
                                        }
                                        // retryDeviceConnect menutup sesi sendiri saat langkah
                                        // selesai; kalau masih gagal, loop fase di bawah yang memutuskan.
                                        if (registrationSuccess) continue;
                                        await resetSession();
                                    } else {
                                        await resetSession();
                                    }

                                    if (errMsg.toLowerCase().includes('too many attempts')) {
                                        console.log(`🔄 Deteksi 'Too many attempts'. Langsung memicu rotasi IP / Fase berikutnya...`);
                                        break;
                                    }

                                    if (attempts < maxAttempts) {
                                        console.log(`🔄 Sesi direset, memulai percobaan ${attempts + 1}/${maxAttempts} dengan sesi (dan IP) baru...`);
                                        await new Promise(r => setTimeout(r, 2000));
                                    } else {
                                        console.log(`🛑 Batas ${maxAttempts} percobaan browser tercapai untuk fase ${phaseLabel}.`);
                                    }
                                } finally {
                                    currentAbortController = null;
                                }
                            }
                        };

                        // ── Build phase list: Direct first, then Warp, then Psiphon, then Socks5 ───────────────
                        const phases = [];
                        if (useDirect)  phases.push({ type: 'direct', host: null });
                        if (useWarp)    phases.push({ type: 'warp', host: null });
                        if (usePsiphon) phases.push({ type: 'psiphon', host: null });
                        if (useSocks5)  phases.push({ type: 'socks5', host: socks5Host });
                        if (phases.length === 0) phases.push({ type: 'direct', host: null }); // safety fallback

                        let globalDone = false;

                        for (let phaseIdx = 0; phaseIdx < phases.length && !globalDone; phaseIdx++) {
                            if (shouldStop) break;

                            const currentPhase = phases[phaseIdx].type;
                            const currentHost = phases[phaseIdx].host;
                            const phaseLabel = currentPhase === 'warp' ? 'Warp+Socks5' : (currentPhase === 'psiphon' ? 'Psiphon' : (currentPhase === 'socks5' ? `Socks5 Only (${currentHost})` : 'Direct Connection'));
                            console.log(`\n[Phase ${phaseIdx + 1}/${phases.length}] Memulai dengan mode: ${phaseLabel}`);

                            // Rotasi IP keluar (restart WARP/reg.json, region Psiphon) dan
                            // sesi browser baru sudah ditangani registerSingleEmail saat
                            // isRetry=true, jadi satu loop percobaan per fase sudah cukup.
                            await runBrowserLoop(currentPhase, currentHost, phaseLabel, phaseIdx > 0);

                            if (registrationSuccess) { globalDone = true; break; }

                            if (phaseIdx < phases.length - 1) {
                                console.log(`\n⚠️ Fase ${phaseLabel} habis. Beralih ke fase berikutnya...`);
                            }
                        }

                        // ── Handle total failure ──────────────────────────────────────────
                        if (!registrationSuccess && !shouldStop) {
                            const phaseSummary = phases.map(p => p.type === 'warp' ? 'Warp+Socks5' : (p.type === 'psiphon' ? 'Psiphon' : (p.type === 'socks5' ? 'Socks5 Only' : 'Direct Connection'))).join(' → ');
                            console.log(`\n❌ GAGAL TOTAL [${phaseSummary}]: Semua percobaan untuk ${email} sudah habis.`);
                            console.log(`🛠️ Mereset sesi browser dan menghentikan daemon...`);
                            if (global.closeBrowserSession) await global.closeBrowserSession();
                            if (global.killDropboxDaemon) global.killDropboxDaemon({ log: false });

                            failedCount++;
                            try {
                                saveRegistration(email, passwordMode === 'fixed' ? fixedPassword : '(random)', 'failed', alias, '', '', emailTimeouts, emailErrors);
                            } catch (_) {}

                            console.log(`🚫 Menghentikan semua proses pendaftaran dan masuk ke mode IDLE.`);
                            shouldStop = true;  // stop entire batch → idle
                        }

                    } // End of email loop

                    const finalStatus = shouldStop ? 'stopped' : 'success';
                    safeSend({ type: 'status', status: finalStatus });
                    // Only send progress summary when completed (not when stopped) —
                    // to avoid overwriting the stop handler's globalState reset
                    if (!shouldStop) {
                        safeSend({
                            type: 'progress',
                            current: processedCount,
                            total: emails.length,
                            status: 'Semua email selesai diproses.',
                            successCount,
                            failedCount
                        });
                    }
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
                    // Reset progress so refresh shows 0% after finish
                    globalState.progress = { current: 0, total: 0, status: 'Selesai', successCount: 0, failedCount: 0, verifCount: 0 };
                    globalState.stats = { timeouts: 0, errors: 0 };
                    globalState.info = { alias: '-', mode: '-', email: '-', ip: '-', ua: '-' };

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
