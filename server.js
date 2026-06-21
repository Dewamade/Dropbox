const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { registerSingleEmail } = require('./register.js');
const { saveRegistration, getAllRegistrations, clearRegistrations } = require('./db.js');

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
// ────────────────────────────────────────────────────────────────────────────

// Keep track of active connection for console redirection
let activeWs = null;
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function safeSend(socket, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify(payload));
        } catch (e) {
            originalError('WS send error:', e.message);
        }
    }
}

// Expose globally so register.js can use them via console.log
global.safeSend = safeSend;
global.activeWs = null;

console.log = (...args) => {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalLog.apply(console, args);
    safeSend(activeWs, { type: 'log', message: msg });
};

console.error = (...args) => {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalError.apply(console, args);
    safeSend(activeWs, { type: 'log', message: `[ERROR] ${msg}` });
};

console.warn = (...args) => {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalWarn.apply(console, args);
    safeSend(activeWs, { type: 'log', message: `[WARNING] ${msg}` });
};

let isRunning = false;
let shouldStop = false;
let currentAbortController = null;

wss.on('connection', (ws) => {
    originalLog('Client connected via WebSocket');

    // Send current status
    safeSend(ws, { type: 'status', status: isRunning ? 'running' : 'idle' });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

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
                safeSend(ws, { type: 'status', status: 'stopped' });
                return;
            }

            if (data.action === 'start') {
                if (isRunning) {
                    safeSend(ws, { type: 'log', message: '⚠️ Pendaftaran sedang berjalan!' });
                    return;
                }

                isRunning = true;
                shouldStop = false;
                activeWs = ws;
                global.activeWs = ws;
                safeSend(ws, { type: 'status', status: 'running' });

                const { 
                    action, alias, url, emails: emailsRaw, emailMode, domain, count, 
                    globalTimeout, globalRetry, daemonTimeout,
                    useDirect, useWarp, useHeadless, passwordMode, fixedPassword 
                } = data;
                
                let emails = [];
                if (emailMode === 'auto') {
                    // Generate random emails
                    for (let i = 0; i < count; i++) {
                        const randomString = Math.random().toString(36).substring(2, 8 + Math.floor(Math.random() * 3)); // 6-8 chars
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
                        if (shouldStop || activeWs !== ws) {
                            break;
                        }
                        processedCount = i + 1;
                        const email = emails[i];
                        safeSend(ws, {
                            type: 'progress',
                            current: i + 1,
                            total: emails.length,
                            status: `Memproses email ke-${i+1} dari ${emails.length} (${email})`,
                            successCount,
                            failedCount,
                            verifCount
                        });

                        let registrationSuccess = false;
                        const maxAttempts = globalRetry || 3;
                        const maxWarpRetries = useWarp ? maxAttempts : 0;
                        let proxyType = useWarp ? 'warp' : 'direct';

                        // Warp restart helper
                        const runWarpRestart = async () => {
                            const { exec } = require('child_process');
                            const runCmd = (cmd, tms = 8000) => new Promise(resolve => {
                                exec(cmd, { timeout: tms }, () => resolve());
                                setTimeout(resolve, tms + 500);
                            });
                            console.log(`\n[Warp Restart] Menjalankan: warp-ctl stop`);
                            await runCmd('warp-ctl stop', 6000);
                            console.log(`[Warp Restart] Menunggu 2 detik...`);
                            await new Promise(r => setTimeout(r, 2000));
                            console.log(`[Warp Restart] Menjalankan: warp-ctl start`);
                            await runCmd('warp-ctl start', 6000);
                            console.log(`[Warp Restart] Menunggu 10 detik agar koneksi stabil...`);
                            await new Promise(r => setTimeout(r, 10000));
                            // Force warp state to reset so register.js will re-init
                            const regMod = require('./register.js');
                        };

                        // \u2550\u2550 OUTER WARP RETRY LOOP \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
                        let warpRetryCount = 0;
                        let outerDone = false;

                        while (!outerDone) {
                            if (shouldStop || activeWs !== ws) break;

                            // \u2550\u2550 INNER BROWSER RETRY LOOP \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
                            let attempts = 0;

                            while (!registrationSuccess && attempts < maxAttempts) {
                                if (shouldStop || activeWs !== ws) break;
                                attempts++;

                                const isWarpRetry = warpRetryCount > 0;
                                const isBrowserRetry = attempts > 1;

                                if (isBrowserRetry || isWarpRetry) {
                                    console.log(`\n[Mencoba Kembali] Browser Attempt ${attempts}/${maxAttempts}${isWarpRetry ? ` (Warp Restart ke-${warpRetryCount}/${maxWarpRetries})` : ''} — ${email}`);
                                }

                                try {
                                    currentAbortController = { shouldStop: false, abort: null };
                                    const result = await registerSingleEmail(
                                        url, email, proxyType, false,
                                        currentAbortController, useHeadless,
                                        passwordMode, fixedPassword, globalTimeout, daemonTimeout, alias, maxAttempts, isBrowserRetry || isWarpRetry
                                    );

                                    if (result && result.success) {
                                        registrationSuccess = true;
                                        outerDone = true;
                                        const finalStatus = result.status || 'success';
                                        if (finalStatus === 'VERIF') {
                                            verifCount++;
                                        } else {
                                            successCount++;
                                        }
                                        console.log(`\u2713 Pendaftaran ${finalStatus} untuk ${email} (password: ${result.password})`);
                                        safeSend(ws, { type: 'email_success', email: email });
                                        try {
                                            saveRegistration(email, result.password, finalStatus, alias, result.ip, result.ua);
                                        } catch (dbErr) {
                                            originalError('DB save error:', dbErr.message);
                                        }
                                    } else if (result === true) {
                                        // backward compat
                                        registrationSuccess = true;
                                        outerDone = true;
                                        successCount++;
                                        const usedPwd = passwordMode === 'fixed' ? fixedPassword : '(random)';
                                        console.log(`\u2713 Pendaftaran sukses untuk ${email}`);
                                        safeSend(ws, { type: 'email_success', email: email });
                                        try {
                                            saveRegistration(email, usedPwd, 'success', alias, '', '');
                                        } catch (dbErr) {
                                            originalError('DB save error:', dbErr.message);
                                        }
                                    } else {
                                        // Result false/null — treat as failure needing retry
                                        console.log(`\u26a0\ufe0f Pendaftaran untuk ${email} mengembalikan hasil tidak valid (Attempt ${attempts}).`);
                                        if (global.killAllBrowsers) global.killAllBrowsers();
                                        if (global.killAllBox64) global.killAllBox64();
                                    }

                                } catch (error) {
                                    if (shouldStop) { outerDone = true; break; }

                                    const errMsg = (error.message || '');
                                    const needsKill = errMsg.startsWith('BROWSER_KILL_REQUIRED') ||
                                        errMsg.toLowerCase().includes('timeout') ||
                                        errMsg.toLowerCase().includes('net::err') ||
                                        errMsg.toLowerCase().includes('connection') ||
                                        errMsg.toLowerCase().includes('proxy') ||
                                        errMsg.toLowerCase().includes('ns_error');

                                    console.log(`\n\u274c Error attempt ${attempts}/${maxAttempts}: ${errMsg.replace('BROWSER_KILL_REQUIRED: ', '').split('\\n')[0]}`);

                                    // Always kill browsers after any failure
                                    if (global.killAllBrowsers) global.killAllBrowsers();
                                    if (global.killAllBox64) global.killAllBox64();

                                    if (attempts < maxAttempts) {
                                        console.log(`\ud83d\udd04 Kill browser selesai, meluncurkan browser baru untuk percobaan ${attempts + 1}/${maxAttempts}...`);
                                        await new Promise(r => setTimeout(r, 2000));
                                        // continue inner loop
                                    } else {
                                        console.log(`\ud83d\uded1 Batas ${maxAttempts} percobaan browser tercapai untuk ${email}.`);
                                        // Fall through to warp retry check below
                                    }

                                } finally {
                                    currentAbortController = null;
                                }
                            } // end inner browser loop

                            if (registrationSuccess) break; // done
                            if (shouldStop || activeWs !== ws) break;

                            // \u2550\u2550 Check warp retry \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
                            if (useWarp && warpRetryCount < maxWarpRetries) {
                                warpRetryCount++;
                                console.log(`\n\ud83d\udd01 [Warp Retry ${warpRetryCount}/${maxWarpRetries}] Semua percobaan browser habis. Restart Warp dan coba ulang...`);
                                try { await runWarpRestart(); } catch (e) {
                                    console.log(`\u26a0\ufe0f Gagal restart Warp: ${e.message}`);
                                }
                                // Reset warp state so register.js will re-init on next attempt
                                const regModule = require('./register.js');
                                // Continue outer loop
                            } else {
                                // \u2550\u2550 Total failure \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
                                console.log(`\n\u274c GAGAL TOTAL: Semua percobaan browser${useWarp ? ` dan Warp Restart (${maxWarpRetries}x)` : ''} untuk ${email} sudah habis.`);
                                console.log(`\ud83d\udee0\ufe0f Kill paksa semua proses browser dan box64...`);
                                if (global.killAllBrowsers) global.killAllBrowsers();
                                if (global.killAllBox64) global.killAllBox64();

                                failedCount++;
                                try {
                                    saveRegistration(email, passwordMode === 'fixed' ? fixedPassword : '(random)', 'failed', alias, '', '');
                                } catch (_) {}

                                console.log(`\ud83d\udead Menghentikan semua proses pendaftaran dan masuk ke mode IDLE.`);
                                shouldStop = true;  // Stop entire batch → idle
                                outerDone = true;
                            }

                        } // end outer warp loop


                    }

                    if (activeWs === ws) {
                        const finalStatus = shouldStop ? 'stopped' : 'success';
                        safeSend(ws, { type: 'status', status: finalStatus });
                        safeSend(ws, {
                            type: 'progress',
                            current: processedCount,
                            total: emails.length,
                            status: shouldStop ? 'Proses dihentikan oleh pengguna.' : 'Semua email selesai diproses.',
                            successCount,
                            failedCount
                        });
                    }
                } catch (err) {
                    console.error('Error saat menjalankan proses pendaftaran:', err);
                    if (activeWs === ws) {
                        safeSend(ws, { type: 'status', status: 'error' });
                    }
                } finally {
                    isRunning = false;
                    activeWs = null;
                    global.activeWs = null;
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
});
