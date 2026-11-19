/**
 * proxy-manager.js — lifecycle of the local SOCKS5 exits used for account farming.
 * Every binary is executed from inside this project directory:
 *
 *   warp/warp      warp-go (rootless Cloudflare WARP → SOCKS5 127.0.0.1:40000).
 *                  reg.json lives in warp/. Deleting it and re-running `-reg`
 *                  registers a new WARP key, which changes the public exit IP.
 *   psiphon/…      psiphon-tunnel-core-x86_64 → SOCKS5 127.0.0.1:3080,
 *                  EgressRegion rewritten per attempt from the region pool.
 *
 * Only one exit is active at a time; the caller stops the others.
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const WARP_DIR = path.join(__dirname, 'warp');
const WARP_BIN = path.join(WARP_DIR, 'warp');
const WARP_REG = path.join(WARP_DIR, 'reg.json');
const PSIPHON_DIR = path.join(__dirname, 'psiphon');
const PSIPHON_BIN = path.join(PSIPHON_DIR, 'psiphon-tunnel-core-x86_64');
const PSIPHON_TEMPLATE = path.join(__dirname, 'psiphon.config');
const PSIPHON_CONFIG = path.join(PSIPHON_DIR, 'psiphon.config');
const PSIPHON_PORT = 3080;
const DEFAULT_WARP_PORT = 40000;

const ALL_PSIPHON_REGIONS = ["AT", "BE", "CA", "CH", "CZ", "DE", "DK", "ES", "FI", "FR", "GB", "IE", "IN", "IT", "JP", "LT", "NL", "NO", "PL", "RO", "RS", "SE", "SG", "US"];

let warpProc = null;
let warpState = { active: false, port: null, exitIp: null };
let psiphonProc = null;
let psiphonActive = false;

function vpnLog(line) {
    if (global.debugProxy && typeof global.safeSend === 'function') {
        global.safeSend({ type: 'vpn_log', message: line });
    }
}

function checkPort(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => { done = true; socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); if (!done) resolve(false); });
        socket.on('error', () => { if (!done) resolve(false); });
        socket.connect(port, host);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortCheck(abortController) {
    if (abortController && abortController.shouldStop) throw new Error('Pendaftaran dihentikan oleh pengguna.');
}

// Public exit IP through a SOCKS5 proxy — proves the tunnel really leaves the
// network. Several endpoints on purpose: api.ipify.org sometimes answers a
// Cloudflare challenge page (HTML) for a WARP egress range, and that must not
// be read as "no internet". cdn-cgi/trace is Cloudflare's own plain-text
// endpoint, always 200, and its `warp=` line proves the traffic left via WARP.
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,}$/;
const EXIT_IP_ENDPOINTS = [
    {
        url: 'https://www.cloudflare.com/cdn-cgi/trace',
        parse: (text) => {
            const ip = /(?:^|\n)\s*ip=(\S+)/.exec(text);
            if (!ip || !IP_RE.test(ip[1])) return null;
            const warp = /(?:^|\n)\s*warp=(\w+)/.exec(text);
            return { ip: ip[1], warp: warp ? warp[1] : null };
        },
    },
    {
        url: 'https://api.ipify.org?format=json',
        parse: (text) => { try { const ip = JSON.parse(text.trim()).ip; return IP_RE.test(ip) ? { ip } : null; } catch (_) { return null; } },
    },
    {
        url: 'https://ifconfig.me/ip',
        parse: (text) => { const ip = text.trim(); return IP_RE.test(ip) ? { ip } : null; },
    },
];

function fetchViaSocks(url, proxyHost, proxyPort, timeoutMs) {
    return new Promise((resolve) => {
        let SocksProxyAgent;
        try { ({ SocksProxyAgent } = require('socks-proxy-agent')); }
        catch (_) { return resolve(null); }
        const agent = new SocksProxyAgent(`socks5://${proxyHost}:${proxyPort}`);
        const req = https.get(url, { agent, timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// Resolves { ip, warp? } through the proxy, or null if no endpoint answered.
async function socksExitIp(proxyHost, proxyPort, timeoutMs = 12000) {
    for (const ep of EXIT_IP_ENDPOINTS) {
        const r = await fetchViaSocks(ep.url, proxyHost, proxyPort, timeoutMs);
        if (!r || r.status !== 200) continue;
        const parsed = ep.parse(r.body || '');
        if (parsed) return parsed;
    }
    return null;
}

// ── WARP (warp-go) ────────────────────────────────────────────────────────────
function warpStatus() {
    return { ...warpState, running: !!warpProc && warpProc.exitCode === null, registered: fs.existsSync(WARP_REG) };
}

async function stopWarp({ log = true } = {}) {
    if (warpProc) {
        const pid = warpProc.pid;
        try { warpProc.kill('SIGTERM'); } catch (_) { }
        await sleep(700);
        try { warpProc.kill('SIGKILL'); } catch (_) { }
        warpProc = null;
        if (log) console.log(`[Warp] ✓ Proses warp-go (PID ${pid}) dihentikan.`);
    }
    try { require('child_process').execSync(`pkill -9 -f "${WARP_BIN}"`, { stdio: 'ignore' }); } catch (_) { }
    warpState = { active: false, port: null, exitIp: null };
    global.warpExitIp = null;
}

// Register a new WARP key → Cloudflare assigns a different egress range.
function reRegisterWarp() {
    if (fs.existsSync(WARP_REG)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try { fs.copyFileSync(WARP_REG, path.join(WARP_DIR, `reg.json.${stamp}.bak`)); } catch (_) { }
        fs.rmSync(WARP_REG, { force: true });
        console.log('[Warp] reg.json dihapus, registrasi kunci WARP baru...');
    }
    const r = spawnSync(WARP_BIN, ['-reg'], { cwd: WARP_DIR, timeout: 60000, encoding: 'utf8' });
    (r.stdout || '').toString().split('\n').forEach((l) => { if (l.trim()) vpnLog(`[Warp -reg] ${l.trim()}`); });
    (r.stderr || '').toString().split('\n').forEach((l) => { if (l.trim()) console.log(`[Warp -reg] ${l.trim()}`); });
    if (!fs.existsSync(WARP_REG)) {
        throw new Error(`[Warp] Gagal registrasi ulang WARP (kode ${r.status}): ${(r.stderr || r.stdout || '').toString().trim().split('\n')[0] || 'reg.json tidak terbentuk'}`);
    }
    console.log('[Warp] ✓ Kunci WARP baru terdaftar (exit IP akan berubah).');
}

async function startWarp({ port = DEFAULT_WARP_PORT, rotate = false, abortController = null } = {}) {
    if (!fs.existsSync(WARP_BIN)) throw new Error(`Binary warp tidak ada: ${WARP_BIN} — jalankan ./setup.sh`);

    // Reuse an identical, healthy tunnel.
    if (warpState.active && warpState.port === port && !rotate) {
        if (await checkPort('127.0.0.1', port, 2000)) {
            console.log(`[Warp] Sudah aktif di 127.0.0.1:${port} (exit IP ${warpState.exitIp || 'unknown'}), memakai kembali.`);
            return { proxy: `socks5://127.0.0.1:${port}`, exitIp: warpState.exitIp };
        }
        console.log(`[Warp] Port ${port} tidak hidup lagi, restart...`);
    }

    await stopWarp();
    abortCheck(abortController);

    if (rotate || !fs.existsSync(WARP_REG)) reRegisterWarp();

    console.log(`[Warp] Menjalankan warp-go SOCKS5 di 127.0.0.1:${port}...`);
    warpProc = spawn(WARP_BIN, ['-l', `127.0.0.1:${port}`], { cwd: WARP_DIR });
    const onData = (stream) => (chunk) => chunk.toString().split('\n').forEach((line) => {
        const t = line.trim();
        if (!t) return;
        vpnLog(`[Warp ${stream}] ${t}`);
        if (stream === 'err') console.log(`[Warp] ${t}`);
    });
    warpProc.stdout.on('data', onData('out'));
    warpProc.stderr.on('data', onData('err'));
    warpProc.on('error', (err) => console.log(`[Warp] Gagal menjalankan warp-go: ${err.message}`));
    warpProc.on('exit', (code) => {
        if (warpState.active) console.log(`[Warp] Proses warp-go berhenti (kode ${code}).`);
        warpState.active = false;
    });

    let portReady = false;
    for (let i = 0; i < 45; i++) {
        abortCheck(abortController);
        if (await checkPort('127.0.0.1', port, 1500)) { portReady = true; break; }
        await sleep(1000);
    }
    if (!portReady) {
        await stopWarp();
        throw new Error(`[Warp] Port SOCKS5 ${port} tidak terbuka dalam 45 detik.`);
    }

    let probe = null;
    for (let i = 0; i < 3 && !probe; i++) {
        probe = await socksExitIp('127.0.0.1', port);
        if (!probe) await sleep(2000);
    }
    if (!probe) {
        await stopWarp();
        throw new Error('[Warp] Tunnel terbentuk tapi tidak bisa keluar ke internet (cek koneksi/registrasi WARP).');
    }
    const exitIp = probe.ip;
    warpState = { active: true, port, exitIp };
    global.warpExitIp = exitIp;
    console.log(`[Warp] ✓ WARP aktif — exit IP: ${exitIp}${probe.warp ? ` (cdn-cgi/trace warp=${probe.warp})` : ''}`);
    return { proxy: `socks5://127.0.0.1:${port}`, exitIp };
}

// ── Psiphon ───────────────────────────────────────────────────────────────────
function pickPsiphonRegion() {
    const selected = (global.psiphonRegions || []).filter((r) => ALL_PSIPHON_REGIONS.includes(r));
    const used = global.psiphonUsedRegions || [];
    const pool = selected.length ? selected : ALL_PSIPHON_REGIONS;
    let fresh = pool.filter((r) => !used.includes(r));
    if (fresh.length === 0) {
        console.log('[Psiphon] Semua negara terpilih sudah dicoba, mengulang dari pool...');
        fresh = pool;
    }
    const region = fresh[Math.floor(Math.random() * fresh.length)];
    if (!used.includes(region)) { used.push(region); global.psiphonUsedRegions = used; }
    return { region, remaining: fresh.filter((r) => r !== region) };
}

function writePsiphonConfig(region) {
    if (!fs.existsSync(PSIPHON_TEMPLATE)) throw new Error(`Config psiphon tidak ditemukan: ${PSIPHON_TEMPLATE}`);
    const config = JSON.parse(fs.readFileSync(PSIPHON_TEMPLATE, 'utf8'));
    config.EgressRegion = region;
    fs.mkdirSync(PSIPHON_DIR, { recursive: true });
    fs.writeFileSync(PSIPHON_CONFIG, JSON.stringify(config, null, 4), 'utf8');
    const listen = Array.isArray(config.LocalSOCKS) && config.LocalSOCKS[0];
    return { config, listen: listen || `127.0.0.1:${PSIPHON_PORT}` };
}

async function stopPsiphon({ log = true } = {}) {
    if (psiphonProc) {
        try { psiphonProc.kill('SIGKILL'); } catch (_) { }
        if (log) console.log(`[Psiphon] ✓ Proses psiphon-tunnel-core (PID ${psiphonProc.pid}) dihentikan.`);
    }
    psiphonProc = null;
    psiphonActive = false;
    global.psiphonRegion = null;
}

async function startPsiphon({ abortController = null, rotate = false } = {}) {
    if (!fs.existsSync(PSIPHON_BIN)) throw new Error(`Binary psiphon tidak ada: ${PSIPHON_BIN} — jalankan ./setup.sh`);

    if (!rotate && psiphonActive && psiphonProc && psiphonProc.exitCode === null && await checkPort('127.0.0.1', PSIPHON_PORT, 1500)) {
        const region = global.psiphonRegion ? ` (Region: ${global.psiphonRegion})` : '';
        console.log(`[Psiphon] Sudah aktif di 127.0.0.1:${PSIPHON_PORT}${region} (PID ${psiphonProc.pid}), memakai kembali.`);
        return { proxy: `socks5://127.0.0.1:${PSIPHON_PORT}`, region: global.psiphonRegion };
    }
    if (rotate) console.log('[Psiphon] Rotasi: restart tunnel + pilih negara baru...');
    await stopPsiphon({ log: false });
    abortCheck(abortController);

    const { region, remaining } = pickPsiphonRegion();
    console.log(`[Psiphon] EgressRegion → ${region} (sisa: ${remaining.join(', ') || '—'})`);
    const { listen } = writePsiphonConfig(region);
    const host = listen.split(':')[0] || '127.0.0.1';
    const port = parseInt(String(listen).split(':')[1], 10) || PSIPHON_PORT;

    psiphonProc = spawn(PSIPHON_BIN, ['-config', 'psiphon.config'], { cwd: PSIPHON_DIR });
    vpnLog('[Psiphon] Memulai psiphon-tunnel-core...');
    psiphonProc.stdout.on('data', (chunk) => chunk.toString().split('\n').forEach((l) => { if (l.trim()) vpnLog(`[Psiphon stdout] ${l.trim()}`); }));
    psiphonProc.stderr.on('data', (chunk) => chunk.toString().split('\n').forEach((line) => {
        const t = line.trim();
        if (!t) return;
        vpnLog(`[Psiphon stderr] ${t}`);
        try {
            const m = t.match(/\{.*\}/);
            if (m) {
                const j = JSON.parse(m[0]);
                if (j.noticeType === 'ConnectedServerRegion' && j.data && j.data.serverRegion) {
                    console.log(`[Psiphon] Terhubung ke region: ${j.data.serverRegion}`);
                    global.psiphonRegion = j.data.serverRegion;
                    if (typeof global.safeSend === 'function') {
                        global.safeSend({ type: 'info', info: { mode: `Psiphon (${j.data.serverRegion})` } });
                    }
                }
            }
        } catch (_) { }
    }));
    psiphonProc.on('error', (err) => console.log(`[Psiphon Error] Gagal menjalankan binary: ${err.message}`));

    console.log('[Psiphon] Menunggu tunnel + region terdeteksi...');
    let portReady = false, regionDetected = false;
    for (let i = 0; i < 30; i++) {
        abortCheck(abortController);
        if (!portReady) portReady = await checkPort(host, port, 1000);
        if (global.psiphonRegion) regionDetected = true;
        if (portReady && regionDetected) break;
        await sleep(1000);
    }
    if (!(portReady && regionDetected)) {
        await stopPsiphon({ log: false });
        throw new Error('Gagal mengaktifkan Psiphon proxy atau mendeteksi region dalam 30 detik.');
    }
    console.log(`[Psiphon] ✓ Terhubung ke region ${global.psiphonRegion}, port ${port} siap.`);
    await sleep(3000);
    psiphonActive = true;
    return { proxy: `socks5://127.0.0.1:${port}`, region: global.psiphonRegion };
}

async function stopAll() {
    await stopWarp();
    await stopPsiphon();
}

function psiphonStatus() {
    return {
        active: !!(psiphonActive && psiphonProc && psiphonProc.exitCode === null),
        region: global.psiphonRegion || null,
        usedRegions: global.psiphonUsedRegions || [],
        port: PSIPHON_PORT,
    };
}

// One snapshot for the dashboard: are the local exit engines up?
function status() {
    const w = warpStatus();
    const p = psiphonStatus();
    return {
        warp: w.running,
        warpPort: w.port || DEFAULT_WARP_PORT,
        warpExitIp: w.exitIp || null,
        warpRegistered: w.registered,
        psiphon: p.active,
        psiphonPort: p.port,
        psiphonRegion: p.region,
    };
}

module.exports = {
    startWarp,
    stopWarp,
    warpStatus,
    psiphonStatus,
    status,
    startPsiphon,
    stopPsiphon,
    stopAll,
    checkPort,
    socksExitIp,
    EXIT_IP_ENDPOINTS,
    DEFAULT_WARP_PORT,
    PSIPHON_PORT,
    ALL_PSIPHON_REGIONS,
};
