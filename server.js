const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { registerSingleEmail, getProxiflyProxy } = require('./register.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

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

// Expose safeSend and activeWs globally so register.js can use them
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
                global.activeWs = ws; // sync global for register.js
                safeSend(ws, { type: 'status', status: 'running' });

                const { url, emails: emailsRaw, useProxy, useHeadless } = data;
                const emails = emailsRaw.split(';')
                                        .map(e => e.trim())
                                        .filter(e => e.length > 0);

                if (emails.length === 0) {
                    safeSend(ws, { type: 'log', message: 'Error: Tidak ada email valid!' });
                    safeSend(ws, { type: 'status', status: 'error' });
                    isRunning = false;
                    activeWs = null;
                    global.activeWs = null;
                    return;
                }

                console.log(`[Server] Memulai pendaftaran massal untuk ${emails.length} email.`);

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

                        let proxy = null;
                        if (useProxy) {
                            console.log('Mengambil proxy baru dari Proxifly...');
                            proxy = await getProxiflyProxy();
                        }

                        // Retry logic for proxy errors or "Too many attempts"
                        let registrationSuccess = false;
                        let attempts = 0;
                        const maxAttempts = 3;
                        let currentProxy = proxy;

                        while (!registrationSuccess && attempts < maxAttempts) {
                            if (shouldStop || activeWs !== ws) break;
                            attempts++;
                            if (attempts > 1) {
                                if (useProxy) {
                                    console.log(`\n[Mencoba Kembali] Mencoba mendaftarkan ulang ${email} dengan proxy baru (Percobaan ke-${attempts} dari ${maxAttempts})...`);
                                    currentProxy = await getProxiflyProxy();
                                } else {
                                    console.log(`\n[Mencoba Kembali] Mencoba mendaftarkan ulang ${email} (Percobaan ke-${attempts} dari ${maxAttempts})...`);
                                }
                            }

                            try {
                                currentAbortController = { shouldStop: false, abort: null };
                                const result = await registerSingleEmail(url, email, currentProxy, false, currentAbortController, useHeadless);
                                if (result) {
                                    registrationSuccess = true;
                                    successCount++;
                                    console.log(`✓ Pendaftaran sukses untuk ${email}`);
                                    safeSend(ws, { type: 'email_success', email: email });
                                } else {
                                    failedCount++;
                                    console.log(`Pendaftaran untuk ${email} selesai dengan status tidak berhasil (halaman ditutup/timeout).`);
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
                                    'net::err',
                                    'timeout',
                                    'connection',
                                    'proxy',
                                    'tunnel'
                                ].some(keyword => errorMsg.includes(keyword));

                                const isTooManyAttempts = errorMsg.includes('too many attempts') || errorMsg.includes('please try later') || errorMsg.includes('terlalu banyak percobaan') || errorMsg.includes('coba lagi nanti');

                                if (isTooManyAttempts && attempts < maxAttempts) {
                                    console.log(`Terdeteksi pesan "Too many attempts". Mencoba kembali...`);
                                } else if (useProxy && isConnectionError && attempts < maxAttempts) {
                                    console.log(`Terdeteksi masalah koneksi/proxy. Mengambil proxy baru dan mencoba kembali...`);
                                } else {
                                    console.log(`Sudah mencapai batas maksimal percobaan atau kesalahan permanen. Melewati email ini.`);
                                    failedCount++;
                                    break;
                                }
                            } finally {
                                currentAbortController = null;
                            }
                        }

                        // Anti-tracking delay: Add a random delay between 5 to 15 seconds between registrations
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
