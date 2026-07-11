const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { saveRegistration, getAllRegistrations, clearRegistrations, getSettingsFull, saveSettingsFull } = require('./db.js');
const { registerSingleEmail: _registerSingleEmail } = require('./register.js');

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

app.get('/api/uas', (_req, res) => {
    const topUserAgents = require('top-user-agents');
    const baseUas = topUserAgents.filter(ua => !ua.includes('NT 6'));
    
    const tabletUas = [
        'Mozilla/5.0 (iPad; CPU OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
        'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];

    res.json({
        desktop: baseUas.filter(u => !u.includes('Mobile') && !u.includes('Tablet') && !u.includes('iPad') && !u.includes('Android')),
        mobile: baseUas.filter(u => u.includes('Mobile') || u.includes('iPhone')),
        tablet: baseUas.filter(u => u.includes('iPad') || u.includes('Tablet') || (u.includes('Android') && !u.includes('Mobile'))).concat(tabletUas)
    });
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
let globalTimeout = savedSettings.globalTimeout || 30000;
let daemonTimeout = savedSettings.daemonTimeout || 240000;
let useHeadless = savedSettings.useHeadless !== false;
let socks5Host = savedSettings.socks5Host || '';
let uaMode = savedSettings.uaMode || 'extension';
let deviceTypes = savedSettings.deviceTypes ? JSON.parse(savedSettings.deviceTypes) : [];
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
        uaMode,
        deviceTypes,
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
        usePsiphon
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
        globalTimeout: typeof body.globalTimeout === 'number' ? body.globalTimeout : (parseInt(body.globalTimeout) || currentSettings.globalTimeout || 30000),
        globalRetry: typeof body.globalRetry === 'number' ? body.globalRetry : (parseInt(body.globalRetry) || currentSettings.globalRetry || 2),
        daemonTimeout: typeof body.daemonTimeout === 'number' ? body.daemonTimeout : (parseInt(body.daemonTimeout) || currentSettings.daemonTimeout || 240000),

        // ── BROWSER & KONEKSI ───────────────────
        useHeadless: typeof body.useHeadless === 'boolean' ? body.useHeadless : (body.useHeadless !== undefined ? !!body.useHeadless : currentSettings.useHeadless),
        socks5Host: body.socks5Host !== undefined ? body.socks5Host : currentSettings.socks5Host,
        uaMode: body.uaMode || currentSettings.uaMode,                     // 'generate' | 'extension'
        deviceTypes: body.deviceTypes ? (typeof body.deviceTypes === 'string' ? body.deviceTypes : JSON.stringify(body.deviceTypes)) : currentSettings.deviceTypes,

        // Proxy type booleans
        useDirect:  body.useDirect  !== undefined ? !!body.useDirect  : (currentSettings.useDirect  !== false),
        useWarp:    body.useWarp    !== undefined ? !!body.useWarp    : (currentSettings.useWarp    || false),
        useSocks5:  body.useSocks5  !== undefined ? !!body.useSocks5  : (currentSettings.useSocks5  || false),
        usePsiphon: body.usePsiphon !== undefined ? !!body.usePsiphon : (currentSettings.usePsiphon || false),

        // ── LAIN-LAIN ───────────────────────────
        idleTimeout: typeof body.idleTimeout === 'number' ? body.idleTimeout : (parseInt(body.idleTimeout) || currentSettings.idleTimeout || 600),
        debugProxy: typeof body.debugProxy === 'boolean' ? body.debugProxy : (body.debugProxy !== undefined ? !!body.debugProxy : currentSettings.debugProxy)
    };

    // Ensure deviceTypes is stored as a string in the JSON file
    if (typeof mergedSettings.deviceTypes !== 'string') {
        mergedSettings.deviceTypes = JSON.stringify(mergedSettings.deviceTypes);
    }

    // 3. Save the merged settings to file
    saveSettingsFull(mergedSettings);

    // 4. Update in-memory application state (crucial for running processes)
    globalTimeout = mergedSettings.globalTimeout;
    daemonTimeout = mergedSettings.daemonTimeout;
    useHeadless = mergedSettings.useHeadless;
    socks5Host = mergedSettings.socks5Host;
    uaMode = mergedSettings.uaMode;
    deviceTypes = JSON.parse(mergedSettings.deviceTypes);
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

// ── Selector Management API ─────────────────────────────────────────────────
let selectors = {};
try {
    selectors = require('./selector.json');
    console.log('[Server] Selectors loaded from selector.json');
} catch (e) {
    console.error('[Server] Failed to load selector.json:', e.message);
    selectors = {};
}

app.get('/api/selectors', (_req, res) => {
    res.json(selectors);
});

app.post('/api/selectors', (req, res) => {
    const body = req.body || {};
    
    // Merge incoming fields into the persisted selectors object
    for (const key of Object.keys(body)) {
        if (key === 'captchaSelectors') continue; // exclude auto-detect selectors
        selectors[key] = body[key];
    }

    // Write back to file
    const fs = require('fs');
    const pathToSelector = path.join(__dirname, 'selector.json');
    try {
        fs.writeFileSync(pathToSelector, JSON.stringify(selectors, null, 2), 'utf8');
        console.log('[Server] Selectors saved to selector.json');
        res.json({ ok: true });
    } catch (e) {
        console.error('[Server] Failed to save selectors:', e.message);
        res.status(500).json({ error: e.message });
    }
});

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
                if (global.killAllBrowsers) global.killAllBrowsers();
                if (global.killAllBox64) global.killAllBox64();
                if (global.killAllVpnProxy) global.killAllVpnProxy();
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

                const { 
                    action, alias, url, emails: emailsRaw, emailMode, domain, count, 
                    globalTimeout, globalRetry, daemonTimeout,
                    useDirect, useWarp, useSocks5, usePsiphon, socks5Host, useHeadless, passwordMode, fixedPassword, uaMode, deviceTypes, debugProxy 
                } = data;

                global.debugProxy = !!debugProxy;
                
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
                let uaRotationIndex = 0;

                // Pre-fetch UAs for rotation
                const topUserAgents = require('top-user-agents');
                const baseUas = topUserAgents.filter(ua => !ua.includes('NT 6'));
                const tabletUas = [
                    'Mozilla/5.0 (iPad; CPU OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
                    'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                ];
                const uaLists = {
                    desktop: baseUas.filter(u => !u.includes('Mobile') && !u.includes('Tablet') && !u.includes('iPad') && !u.includes('Android')),
                    mobile: baseUas.filter(u => u.includes('Mobile') || u.includes('iPhone')),
                    tablet: baseUas.filter(u => u.includes('iPad') || u.includes('Tablet') || (u.includes('Android') && !u.includes('Mobile'))).concat(tabletUas)
                };

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

                        // ── Warp restart helper ───────────────────────────────────────────
                        const runWarpRestart = async () => {
                            const { exec } = require('child_process');
                            const runCmd = (cmd, tms = 8000) => new Promise(resolve => {
                                const proc = exec(cmd, { timeout: tms }, () => resolve());
                                if (global.debugProxy) {
                                    proc.stdout.on('data', (data) => {
                                        data.toString().split('\n').forEach(line => {
                                            const trimmed = line.trim();
                                            if (trimmed) safeSend({ type: 'vpn_log', message: `[Warp Command: ${cmd}] ${trimmed}` });
                                        });
                                    });
                                    proc.stderr.on('data', (data) => {
                                        data.toString().split('\n').forEach(line => {
                                            const trimmed = line.trim();
                                            if (trimmed) safeSend({ type: 'vpn_log', message: `[Warp Command Err: ${cmd}] ${trimmed}` });
                                        });
                                    });
                                }
                                setTimeout(resolve, tms + 500);
                            });

                            const checkWarp = (desiredStatus) => new Promise(resolve => {
                                const proc = exec('warp-ctl status', { timeout: 3000 }, (err, stdout) => {
                                    if (err) return resolve(false);
                                    const out = (stdout || '').toLowerCase();
                                    if (desiredStatus === 'stop' && (out.includes('berhenti') || out.includes('disconnected'))) resolve(true);
                                    else if (desiredStatus === 'start' && (out.includes('terhubung') || out.includes('connected'))) resolve(true);
                                    else resolve(false);
                                });
                                if (global.debugProxy) {
                                    proc.stdout.on('data', (data) => {
                                        data.toString().split('\n').forEach(line => {
                                            const trimmed = line.trim();
                                            if (trimmed) safeSend({ type: 'vpn_log', message: `[Warp Status] ${trimmed}` });
                                        });
                                    });
                                }
                            });

                            console.log(`\n[Warp Restart] Menjalankan: warp-ctl stop`);
                            await runCmd('warp-ctl stop', 5000);
                            
                            // Poll stop for up to 10s
                            for(let i = 0; i < 10; i++) {
                                if (await checkWarp('stop')) {
                                    console.log(`[Warp Restart] ✓ Status: BERHENTI`);
                                    break;
                                }
                                await new Promise(r => setTimeout(r, 1000));
                            }
                            
                            console.log(`[Warp Restart] Menunggu 1 detik...`);
                            await new Promise(r => setTimeout(r, 1000));

                            console.log(`[Warp Restart] Menjalankan: warp-ctl start (Max 60x percobaan)...`);
                            let started = false;
                            for (let i = 0; i < 60; i++) {
                                await runCmd('warp-ctl start', 2000);
                                if (await checkWarp('start')) {
                                    started = true;
                                    console.log(`[Warp Restart] ✓ Status: TERHUBUNG pada percobaan ke-${i + 1}`);
                                    break;
                                }
                                await new Promise(r => setTimeout(r, 1000));
                            }

                            if (!started) console.log(`[Warp Restart] ⚠️ Peringatan: Status TERHUBUNG gagal dicapai setelah 60 percobaan.`);

                            console.log(`[Warp Restart] Menunggu 10 detik agar koneksi stabil...`);
                            await new Promise(r => setTimeout(r, 10000));
                        };

                        // ── Helper: run inner browser retry loop for a given proxyType ───
                        const runBrowserLoop = async (proxyType, proxyHost, phaseLabel, isPhaseRetry) => {
                            let attempts = 0;
                            while (!registrationSuccess && attempts < maxAttempts) {
                                if (shouldStop) break;
                                attempts++;

                                const isRetry = isPhaseRetry || attempts > 1;
                                if (attempts > 1 || isPhaseRetry) {
                                    console.log(`\n[Mencoba Kembali] ${phaseLabel} — Attempt ${attempts}/${maxAttempts} untuk ${email}`);
                                }
                                
                                // Rotate UA for each attempt
                                let selectedUaString = '';
                                let selectedDeviceType = '';
                                if (uaMode !== 'extension' && deviceTypes && deviceTypes.length > 0) {
                                    selectedDeviceType = deviceTypes[uaRotationIndex % deviceTypes.length];
                                    const list = uaLists[selectedDeviceType] || uaLists.desktop;
                                    selectedUaString = list[Math.floor(Math.random() * list.length)];
                                    uaRotationIndex++;
                                }

                                try {
                                    currentAbortController = { shouldStop: false, abort: null };
                                    const result = await _registerSingleEmail(
                                        url, email, proxyType, proxyHost, false,
                                        currentAbortController, useHeadless,
                                        passwordMode, fixedPassword, globalTimeout, daemonTimeout, alias, maxAttempts, isRetry, uaMode, selectedUaString, selectedDeviceType
                                    );

                                    if (result && result.success) {
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
                                        const pct = Math.round((successCount / emails.length) * 100);
                                        safeSend(ws, {
                                            type: 'progress',
                                            current: successCount + 1,
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
                                    } else if (result === true) {
                                        // backward compat
                                        registrationSuccess = true;
                                        successCount++;
                                        const usedPwd = passwordMode === 'fixed' ? fixedPassword : '(random)';
                                        console.log(`✓ Pendaftaran sukses untuk ${email}`);
                                        safeSend(ws, { type: 'email_success', email: email });
                                        // Update progress ring for this successful email (backward compat)
                                        const pct = Math.round((successCount / emails.length) * 100);
                                        safeSend(ws, {
                                            type: 'progress',
                                            current: successCount + 1,
                                            total: emails.length,
                                            status: `Berhasil: ${email}`,
                                            successCount,
                                            failedCount,
                                            verifCount,
                                            success: true
                                        });
                                        try { saveRegistration(email, usedPwd, 'success', alias, '', '', emailTimeouts, emailErrors); } catch (_) {}
                                    } else {
                                        console.log(`⚠️ Pendaftaran ${email} mengembalikan hasil tidak valid (Attempt ${attempts}).`);
                                        if (global.killAllBrowsers) global.killAllBrowsers();
                                        if (global.killAllBox64) global.killAllBox64();
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
                                    
                                    console.log(`\n❌ Error attempt ${attempts}/${maxAttempts} [${phaseLabel}]: ${errMsg.replace('BROWSER_KILL_REQUIRED: ', '').split('\n')[0]}`);
                                    // Always kill browsers after any failure
                                    if (global.killAllBrowsers) global.killAllBrowsers();
                                    if (global.killAllBox64) global.killAllBox64();

                                    if (errMsg.toLowerCase().includes('too many attempts')) {
                                        console.log(`🔄 Deteksi 'Too many attempts'. Langsung memicu rotasi IP / Fase berikutnya...`);
                                        break;
                                    }

                                    if (attempts < maxAttempts) {
                                        console.log(`🔄 Kill selesai, meluncurkan browser baru untuk percobaan ${attempts + 1}/${maxAttempts}...`);
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

                            if (currentPhase === 'warp') {
                                const maxWarpRestarts = maxAttempts;
                                let warpRestartCount = 0;

                                while (!registrationSuccess && !shouldStop) {
                                    if (warpRestartCount > 0) {
                                        if (warpRestartCount > maxWarpRestarts) break;
                                        console.log(`\n🔁 [Warp Restart ${warpRestartCount}/${maxWarpRestarts}] Restart Warp sebelum mencoba ulang...`);
                                        try { await runWarpRestart(); } catch (e) {
                                            console.log(`⚠️ Gagal restart Warp: ${e.message}`);
                                        }
                                    }

                                    await runBrowserLoop('warp', null, `Warp+Socks5${warpRestartCount > 0 ? ` (Restart ${warpRestartCount})` : ''}`, warpRestartCount > 0);

                                    if (registrationSuccess) break;

                                    warpRestartCount++;
                                    if (warpRestartCount > maxWarpRestarts) {
                                        console.log(`\n❌ GAGAL TOTAL [Warp+Socks5]: Semua ${maxAttempts} percobaan browser × ${maxWarpRestarts} Warp Restart sudah habis untuk ${email}.`);
                                        break;
                                    }
                                }
                            } else if (currentPhase === 'psiphon') {
                                const maxPsiphonRestarts = maxAttempts;
                                let psiphonRestartCount = 0;

                                while (!registrationSuccess && !shouldStop) {
                                    await runBrowserLoop('psiphon', null, `Psiphon${psiphonRestartCount > 0 ? ` (Restart ${psiphonRestartCount})` : ''}`, psiphonRestartCount > 0);

                                    if (registrationSuccess) break;

                                    psiphonRestartCount++;
                                    if (psiphonRestartCount > maxPsiphonRestarts) {
                                        console.log(`\n❌ GAGAL TOTAL [Psiphon]: Semua ${maxAttempts} percobaan browser × ${maxPsiphonRestarts} Psiphon Restart sudah habis untuk ${email}.`);
                                        break;
                                    }
                                }
                            } else if (currentPhase === 'socks5') {
                                await runBrowserLoop('socks5', currentHost, phaseLabel, phaseIdx > 0);
                            } else {
                                await runBrowserLoop('direct', null, phaseLabel, phaseIdx > 0);
                            }

                            if (registrationSuccess) { globalDone = true; break; }

                            if (phaseIdx < phases.length - 1) {
                                console.log(`\n⚠️ Fase ${phaseLabel} habis. Beralih ke fase berikutnya...`);
                            }
                        }

                        // ── Handle total failure ──────────────────────────────────────────
                        if (!registrationSuccess && !shouldStop) {
                            const phaseSummary = phases.map(p => p.type === 'warp' ? 'Warp+Socks5' : (p.type === 'psiphon' ? 'Psiphon' : (p.type === 'socks5' ? 'Socks5 Only' : 'Direct Connection'))).join(' → ');
                            console.log(`\n❌ GAGAL TOTAL [${phaseSummary}]: Semua percobaan untuk ${email} sudah habis.`);
                            console.log(`🛠️ Kill paksa semua proses browser dan box64...`);
                            if (global.killAllBrowsers) global.killAllBrowsers();
                            if (global.killAllBox64) global.killAllBox64();

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
                    safeSend({
                        type: 'progress',
                        current: processedCount,
                        total: emails.length,
                        status: shouldStop ? 'Proses dihentikan oleh pengguna.' : 'Semua email selesai diproses.',
                        successCount,
                        failedCount
                    });
                } catch (err) {
                    console.error('Error saat menjalankan proses pendaftaran:', err);
                    safeSend({ type: 'status', status: 'error' });
                } finally {
                    isRunning = false;
                    activeWs = null;
                    global.activeWs = null;
                    if (global.killAllBrowsers) global.killAllBrowsers();
                    if (global.killAllBox64) global.killAllBox64();
                    if (global.killAllVpnProxy) global.killAllVpnProxy();
                    
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
server.listen(PORT, () => {
    originalLog(`===================================================`);
    originalLog(`Server berjalan di http://localhost:${PORT}`);
    originalLog(`Buka URL di atas untuk mengakses Dashboard Pendaftaran`);
    originalLog(`===================================================`);
    
    // Initialize status to BOOT and start the 3-minute idle timer
    setWorkerStatus('BOOT');
    startIdleTimer();
});
