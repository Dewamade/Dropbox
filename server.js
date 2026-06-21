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

                        // ── Warp restart helper ───────────────────────────────────────────
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
                        };

                        // ── Helper: run inner browser retry loop for a given proxyType ───
                        const runBrowserLoop = async (proxyType, phaseLabel, isPhaseRetry) => {
                            let attempts = 0;
                            while (!registrationSuccess && attempts < maxAttempts) {
                                if (shouldStop || activeWs !== ws) break;
                                attempts++;

                                const isRetry = isPhaseRetry || attempts > 1;
                                if (attempts > 1 || isPhaseRetry) {
                                    console.log(`\n[Mencoba Kembali] ${phaseLabel} — Attempt ${attempts}/${maxAttempts} untuk ${email}`);
                                }

                                try {
                                    currentAbortController = { shouldStop: false, abort: null };
                                    const result = await registerSingleEmail(
                                        url, email, proxyType, false,
                                        currentAbortController, useHeadless,
                                        passwordMode, fixedPassword, globalTimeout, daemonTimeout, alias, maxAttempts, isRetry
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
                                        try {
                                            saveRegistration(email, result.password, finalStatus, alias, result.ip, result.ua);
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
                                        try { saveRegistration(email, usedPwd, 'success', alias, '', ''); } catch (_) {}
                                    } else {
                                        console.log(`⚠️ Pendaftaran ${email} mengembalikan hasil tidak valid (Attempt ${attempts}).`);
                                        if (global.killAllBrowsers) global.killAllBrowsers();
                                        if (global.killAllBox64) global.killAllBox64();
                                    }

                                } catch (error) {
                                    if (shouldStop) break;
                                    const errMsg = (error.message || '');
                                    console.log(`\n❌ Error attempt ${attempts}/${maxAttempts} [${phaseLabel}]: ${errMsg.replace('BROWSER_KILL_REQUIRED: ', '').split('\n')[0]}`);
                                    // Always kill browsers after any failure
                                    if (global.killAllBrowsers) global.killAllBrowsers();
                                    if (global.killAllBox64) global.killAllBox64();
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

                        // ── Build phase list: Direct first, then Warp ─────────────────────
                        const phases = [];
                        if (useDirect) phases.push('direct');
                        if (useWarp)   phases.push('warp');
                        if (phases.length === 0) phases.push('direct'); // safety fallback

                        let globalDone = false;

                        for (let phaseIdx = 0; phaseIdx < phases.length && !globalDone; phaseIdx++) {
                            if (shouldStop || activeWs !== ws) break;

                            const currentPhase = phases[phaseIdx];
                            const phaseLabel = currentPhase === 'warp' ? 'Warp+Socks5' : 'Direct Connection';
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

                                    await runBrowserLoop('warp', `Warp+Socks5${warpRestartCount > 0 ? ` (Restart ${warpRestartCount})` : ''}`, warpRestartCount > 0);

                                    if (registrationSuccess) break;

                                    warpRestartCount++;
                                    if (warpRestartCount > maxWarpRestarts) {
                                        console.log(`\n❌ GAGAL TOTAL [Warp+Socks5]: Semua ${maxAttempts} percobaan browser × ${maxWarpRestarts} Warp Restart sudah habis untuk ${email}.`);
                                        break;
                                    }
                                }
                            } else {
                                await runBrowserLoop('direct', 'Direct Connection', phaseIdx > 0);
                            }

                            if (registrationSuccess) { globalDone = true; break; }

                            if (phaseIdx < phases.length - 1) {
                                console.log(`\n⚠️ Fase ${phaseLabel} habis. Beralih ke fase berikutnya...`);
                            }
                        }

                        // ── Handle total failure ──────────────────────────────────────────
                        if (!registrationSuccess && !shouldStop) {
                            const phaseSummary = phases.map(p => p === 'warp' ? 'Warp+Socks5' : 'Direct Connection').join(' → ');
                            console.log(`\n❌ GAGAL TOTAL [${phaseSummary}]: Semua percobaan untuk ${email} sudah habis.`);
                            console.log(`🛠️ Kill paksa semua proses browser dan box64...`);
                            if (global.killAllBrowsers) global.killAllBrowsers();
                            if (global.killAllBox64) global.killAllBox64();

                            failedCount++;
                            try {
                                saveRegistration(email, passwordMode === 'fixed' ? fixedPassword : '(random)', 'failed', alias, '', '');
                            } catch (_) {}

                            console.log(`🚫 Menghentikan semua proses pendaftaran dan masuk ke mode IDLE.`);
                            shouldStop = true;  // stop entire batch → idle
                        }

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
