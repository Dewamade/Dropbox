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
                            failedCount
                        });

                        let registrationSuccess = false;
                        let attempts = 0;
                        const maxAttempts = globalRetry || 3;
                        let proxyType = 'direct';

                        while (!registrationSuccess && attempts < maxAttempts) {
                            if (shouldStop || activeWs !== ws) break;
                            attempts++;
                            
                            if (attempts === 1) {
                                if (useDirect) {
                                    proxyType = 'direct';
                                } else if (useWarp) {
                                    proxyType = 'warp';
                                } else {
                                    proxyType = 'direct';
                                }
                            } else {
                                if (useWarp) {
                                    proxyType = 'warp';
                                } else {
                                    proxyType = 'direct';
                                }
                            }

                            if (attempts > 1) {
                                console.log(`\n[Mencoba Kembali] Mencoba mendaftarkan ulang ${email} dengan mode ${proxyType.toUpperCase()} (Percobaan ke-${attempts} dari ${maxAttempts})...`);
                            }

                            try {
                                currentAbortController = { shouldStop: false, abort: null };
                                const result = await registerSingleEmail(
                                    url, email, proxyType, false,
                                    currentAbortController, useHeadless,
                                    passwordMode, fixedPassword, globalTimeout, daemonTimeout, alias
                                );
                                if (result && result.success) {
                                    registrationSuccess = true;
                                    successCount++;
                                    console.log(`✓ Pendaftaran sukses untuk ${email} (password: ${result.password})`);
                                    safeSend(ws, { type: 'email_success', email: email });
                                    // Save to history DB
                                    try {
                                        saveRegistration(email, result.password, 'success', alias, result.ip);
                                    } catch (dbErr) {
                                        originalError('DB save error:', dbErr.message);
                                    }
                                } else if (result === true) {
                                    // backward compat: result is plain boolean true
                                    registrationSuccess = true;
                                    successCount++;
                                    const usedPwd = passwordMode === 'fixed' ? fixedPassword : '(random)';
                                    console.log(`✓ Pendaftaran sukses untuk ${email}`);
                                    safeSend(ws, { type: 'email_success', email: email });
                                    try {
                                        saveRegistration(email, usedPwd, 'success', alias, '');
                                    } catch (dbErr) {
                                        originalError('DB save error:', dbErr.message);
                                    }
                                } else {
                                    failedCount++;
                                    console.log(`Pendaftaran untuk ${email} selesai dengan status tidak berhasil (halaman ditutup/timeout).`);
                                    try {
                                        saveRegistration(email, passwordMode === 'fixed' ? fixedPassword : '(random)', 'failed', alias, '');
                                    } catch (_) {}
                                    break;
                                }
                            } catch (error) {
                                if (shouldStop) {
                                    console.log(`Pendaftaran untuk ${email} dihentikan.`);
                                    break;
                                }
                                console.log(`\n⚠️ Terjadi kesalahan saat registrasi: ${error.message}`);

                                const errorMsg = (error.message || '').toLowerCase();
                                const isConnectionError = [
                                    'net::err', 'timeout', 'connection', 'proxy', 'tunnel'
                                ].some(keyword => errorMsg.includes(keyword));

                                const isTooManyAttempts = errorMsg.includes('too many attempts') || errorMsg.includes('please try later') || errorMsg.includes('terlalu banyak percobaan') || errorMsg.includes('coba lagi nanti');

                                if (isTooManyAttempts && attempts < maxAttempts) {
                                    console.log(`Terdeteksi pesan "Too many attempts". Mencoba kembali...`);
                                } else if (isConnectionError && attempts < maxAttempts) {
                                    console.log(`Terdeteksi masalah koneksi/timeout. Mencoba kembali...`);
                                } else {
                                    console.log(`Sudah mencapai batas maksimal percobaan atau kesalahan permanen. Melewati email ini.`);
                                    failedCount++;
                                    try {
                                        saveRegistration(email, passwordMode === 'fixed' ? fixedPassword : '(random)', 'failed', alias, '');
                                    } catch (_) {}
                                    break;
                                }
                            } finally {
                                currentAbortController = null;
                            }
                        }

                        // Anti-tracking delay
                        if (i < emails.length - 1 && activeWs === ws && !shouldStop) {
                            const delay = Math.floor(Math.random() * 10000) + 5000;
                            console.log(`Jeda anti-tracking: Menunggu selama ${(delay/1000).toFixed(1)} detik sebelum memproses email berikutnya...`);
                            const startTime = Date.now();
                            while (Date.now() - startTime < delay && !shouldStop && activeWs === ws) {
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
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
