/**
 * camofox-manager.js — supervises the camofox-browser server that lives in this
 * project (./camofox-browser). One server process at a time; the proxy it uses is
 * fixed at start time (env PROXY_HOST/PROXY_PORT), so changing the exit path
 * (direct / warp / psiphon / socks5) restarts the server.
 *
 * Everything camofox touches stays inside this project directory:
 *   camofox-browser/.camoufox   Camoufox browser build (camoufox-js install dir)
 *   camofox-data/profiles       persisted session profiles (keyed by sha256(userId))
 *   camofox-data/cookies|uploads|traces
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CAMOFOX_DIR = path.join(__dirname, 'camofox-browser');
// camoufox-js installs the browser tree directly into CAMOUFOX_INSTALL_DIR
const CAMOUFOX_DIR = path.join(CAMOFOX_DIR, '.camoufox');
const DATA_DIR = path.join(__dirname, 'camofox-data');
const DEFAULT_PORT = 9379;
const VNC_PORT = 5902;
const NOVNC_PORT = 6082;
// URL noVNC yang siap dipakai: autoconnect (tanpa klik Connect) + resize=scale
// supaya desktop 1360x768 di-scale ke jendela browser, bukan digambar 1:1 —
// tanpa param itu bagian bawah/kanan terpotong (layar user biasanya < 1360x768
// setelah chrome browsernya sendiri).
const novncUrl = () => `http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale`;
// Ukuran layar browser: plugin `screen` di camofox-browser memakai nilai ini untuk
// Xvfb sekaligus mengunci ukuran jendela/layar yang dilaporkan Camoufox, jadi
// halaman selalu berukuran sama di mesin mana pun (VNC_RESOLUTION saat visible).
const SCREEN = { width: 1360, height: 768 };
const SCREEN_RESOLUTION = `${SCREEN.width}x${SCREEN.height}`;
// Bahasa UI browser: plugin `locale` di camofox-browser memaksa locale Camoufox,
// jadi dropbox.com selalu melayani teks English (katalog selector + pencocokan
// teks di register.js berasumsi begitu). BROWSER_LOCALE=off menonaktifkan.
const BROWSER_LOCALE = process.env.BROWSER_LOCALE || 'en-US';

let proc = null;
let spec = null;          // what the running server was started with
let currentBaseUrl = null;

function profileDirFor(userId) {
    return path.join(DATA_DIR, 'profiles', crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32));
}

function describeSpec(s) {
    return s.proxy ? `${s.proxy.protocol}://${s.proxy.host}:${s.proxy.port}` : 'direct';
}

function specKey(s) {
    return JSON.stringify([s.proxy ? [s.proxy.host, s.proxy.port, s.proxy.protocol] : null, !!s.visible, s.port]);
}

function isRunning() {
    return !!proc && proc.exitCode === null && !proc.killed;
}

function baseUrl() {
    return currentBaseUrl;
}

function getPort() {
    return spec ? spec.port : null;
}

function isVisible() {
    return !!(isRunning() && spec && spec.visible);
}

function killTree(signal = 'SIGTERM') {
    if (!proc || !proc.pid) return;
    const pid = proc.pid;
    try { process.kill(-pid, signal); } catch (_) { }        // process group (camoufox, Xvfb, VNC)
    try { proc.kill(signal); } catch (_) { }
}

function escapeForPkill(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function portBusy(port) {
    return new Promise((resolve) => {
        const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
        s.setTimeout(1500, () => { s.destroy(); resolve(false); });
        s.once('error', () => resolve(false));
        s.once('close', () => resolve(false));
    });
}

// Stop the server and make sure nothing of ours survives (scoped to our paths).
async function stop({ log = () => { } } = {}) {
    if (proc) {
        log(`[Camofox] Menghentikan server camofox (PID ${proc.pid})...`);
        killTree('SIGTERM');
        const gone = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), 6000);
            if (proc) proc.once('exit', () => { clearTimeout(t); resolve(true); });
            else { clearTimeout(t); resolve(true); }
        });
        if (!gone) {
            killTree('SIGKILL');
            await new Promise((r) => setTimeout(r, 800));
        }
    }
    proc = null; spec = null; currentBaseUrl = null;
    // Scoped cleanup: only processes whose command line points at this project or at
    // our own VNC/display ports. camofox starts x11vnc with -bg, websockify and Xvfb
    // detached, so they are NOT in our process group — without this they survive the
    // stop, keep holding 5902/6082, and the next visible run streams a dead display.
    const scoped = [
        escapeForPkill(path.join(CAMOFOX_DIR, 'server.js')),
        escapeForPkill(path.join(CAMOUFOX_DIR, 'browser')),
        `[x]11vnc.*-rfbport ${VNC_PORT}`,
        `[w]ebsockify.*127\\.0\\.0\\.1:${NOVNC_PORT}`,
        `[X]vfb.*-screen 0 ${SCREEN_RESOLUTION}x24`,
    ];
    for (const pattern of scoped) {
        try { require('child_process').execSync(`pkill -9 -f "${pattern}"`, { stdio: 'ignore' }); } catch (_) { }
    }
}

/**
 * Make sure a camofox server is up with the requested proxy/visibility, restart if
 * the request differs. Returns the baseUrl to drive it with camofox-client.
 */
async function ensureRunning({ proxy = null, visible = false, port = DEFAULT_PORT, abortController = null, timeoutMs = 60000 } = {}) {
    if (!fs.existsSync(path.join(CAMOFOX_DIR, 'server.js'))) {
        throw new Error(`camofox-browser belum terpasang di ${CAMOFOX_DIR} — jalankan ./setup.sh`);
    }
    if (!fs.existsSync(path.join(CAMOUFOX_DIR, 'browser')) && !fs.existsSync(path.join(CAMOUFOX_DIR, '.camoufox', 'browser'))) {
        throw new Error(`Camoufox browser belum terunduh di ${CAMOUFOX_DIR}/.camoufox — jalankan ./setup.sh`);
    }

    const desired = { proxy, visible, port };
    if (isRunning() && specKey(spec) === specKey(desired)) return currentBaseUrl;
    if (isRunning()) {
        console.log(`[Camofox] Keluar lewat ${describeSpec(spec)} → ${describeSpec(desired)}, restart server...`);
        await stop({ log: (m) => console.log(m) });
    }

    for (const dir of [DATA_DIR, path.join(DATA_DIR, 'profiles'), path.join(DATA_DIR, 'cookies'), path.join(DATA_DIR, 'uploads'), path.join(DATA_DIR, 'traces')]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Server baru = tidak ada sesi hidup (tab mati bersama servernya), jadi apa
    // pun yang masih tersimpan di camofox-data/ adalah state sesi lama: plugin
    // `persistence` camofox menulis profiles/<hash>/storage-state.json (cookies +
    // localStorage) saat sesi ditutup DAN saat server shutdown, termasuk sesi yang
    // tidak sempat ditutup (proses di-KILL, batch crashed). Sesi memang selalu
    // memakai userId baru (register.js) sehingga state itu tidak akan dibaca lagi,
    // tapi dibuang di sini supaya tiap start mulai benar-benar dari nol.
    wipeSessionState();

    // A camofox server left running by an earlier run (another node process) is
    // invisible to our own state but still holds the port: spawning on top of it
    // dies with EADDRINUSE while the readiness probe below "succeeds" against that
    // stale server, and every tab request then fails. Clear ours before spawning.
    if (await portBusy(port)) {
        console.log(`[Camofox] Port ${port} sudah dipakai server camofox — membersihkan proses milik proyek ini...`);
        await stop({ log: (m) => console.log(m) });
        const until = Date.now() + 8000;
        while (await portBusy(port) && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
        if (await portBusy(port)) {
            throw new Error(`Port ${port} masih dipakai proses di luar proyek ini — hentikan dulu (lihat: pgrep -fa camofox-browser/server.js).`);
        }
    }

    const env = {
        ...process.env,
        // A CUDA libOpenCL.so.1 earlier on the loader path breaks Camoufox's GPU
        // path (renderers die right after tab creation) — start clean, like the
        // upstream start-clean.sh does.
        LD_LIBRARY_PATH: '',
        CAMOFOX_PORT: String(port),
        CAMOFOX_BIND_HOST: '127.0.0.1',
        CAMOUFOX_INSTALL_DIR: CAMOUFOX_DIR,
        CAMOUFOX_BASE: '',
        CAMOFOX_PROFILE_DIR: path.join(DATA_DIR, 'profiles'),
        CAMOFOX_COOKIES_DIR: path.join(DATA_DIR, 'cookies'),
        CAMOFOX_UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
        CAMOFOX_TRACES_DIR: path.join(DATA_DIR, 'traces'),
        // A registration run is long-lived: don't let idle sweeps kill the tab.
        SESSION_TIMEOUT_MS: '1200000',
        TAB_INACTIVITY_MS: '900000',
        BROWSER_IDLE_TIMEOUT_MS: '600000',
        HANDLER_TIMEOUT_MS: '60000',
        NAVIGATE_TIMEOUT_MS: '60000',
        BUILDREFS_TIMEOUT_MS: '15000',
        BROWSER_RSS_RESTART_THRESHOLD_MB: '8192',
        SCREEN_RESOLUTION,
        BROWSER_LOCALE,
        NODE_ENV: 'production',
    };
    if (proxy) {
        env.PROXY_PROTOCOL = proxy.protocol || 'socks5';
        env.PROXY_HOST = String(proxy.host);
        env.PROXY_PORT = String(proxy.port);
        env.PROXY_STRATEGY = 'static';
    }
    if (visible) {
        env.ENABLE_VNC = '1';
        env.VNC_PORT = String(VNC_PORT);
        env.NOVNC_PORT = String(NOVNC_PORT);
        env.VNC_RESOLUTION = SCREEN_RESOLUTION;
    }

    console.log(`[Camofox] Menjalankan camofox-browser di port ${port} via ${describeSpec(desired)}...`);
    proc = spawn(process.execPath, [path.join(CAMOFOX_DIR, 'server.js')], {
        cwd: CAMOFOX_DIR,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    spec = desired;
    currentBaseUrl = `http://127.0.0.1:${port}`;

    const tagLine = (stream) => (chunk) => {
        chunk.toString().split('\n').forEach((lineRaw) => {
            const line = lineRaw.trim();
            if (!line) return;
            if (process.env.DEBUG_CAMOFOX) console.log(`[Camofox ${stream}] ${line}`);
        });
    };
    proc.stdout.on('data', tagLine('out'));
    proc.stderr.on('data', tagLine('err'));
    proc.on('exit', (code, signal) => {
        console.log(`[Camofox] Server berhenti (kode ${code}, sinyal ${signal}).`);
        proc = null; spec = null; currentBaseUrl = null;
    });

    // Readiness: /health must report ok.
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
        if (abortController && abortController.shouldStop) { await stop(); throw new Error('Pendaftaran dihentikan oleh pengguna.'); }
        if (!proc) throw new Error('Server camofox berhenti saat start — cek ./setup.sh dan log camofox');
        try {
            const r = await fetch(`${currentBaseUrl}/health`, { signal: AbortSignal.timeout(4000) });
            const j = await r.json().catch(() => ({}));
            if (r.ok && (j.status === 'ok' || j.ok === true || r.status === 200)) {
                console.log(`[Camofox] ✓ Server siap di ${currentBaseUrl}`);
                if (visible) console.log(`[Camofox] Browser terlihat lewat noVNC: ${novncUrl()}`);
                return currentBaseUrl;
            }
            lastErr = `HTTP ${r.status}`;
        } catch (e) { lastErr = e.message; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    await stop();
    throw new Error(`Server camofox tidak siap dalam ${timeoutMs / 1000} detik (${lastErr || 'health timeout'})`);
}

// Hapus SEMUA state sesi camofox yang tertinggal: profiles/ (storage-state.json =
// cookies + localStorage per userId), cookies/, uploads/, traces/. Dipanggil dari
// ensureRunning() sebelum server baru spawn — pada titik itu tidak ada sesi hidup,
// jadi semuanya milik run sebelumnya (sesi yang tidak sempat ditutup, proses
// di-KILL, batch crashed). Nama direktori tidak perlu diketahui: yang bersih
// adalah seluruh isinya.
const SESSION_STATE_DIRS = ['profiles', 'cookies', 'uploads', 'traces'];

function wipeSessionState() {
    const cleared = [];
    for (const name of SESSION_STATE_DIRS) {
        const dir = path.join(DATA_DIR, name);
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch (_) { continue; }
        if (!entries.length) continue;
        for (const entry of entries) {
            try { fs.rmSync(path.join(dir, entry), { recursive: true, force: true }); } catch (_) { }
        }
        cleared.push(`${entries.length} ${name}`);
    }
    if (cleared.length) console.log(`[Camofox] State sesi lama dibersihkan (${cleared.join(', ')}).`);
    return cleared;
}

// Separuhnya yang per-sesi: profil user yang baru selesai. `DELETE
// /sessions/:userId` hanya menutup tab; plugin persistence justru MENULIS
// storage-state.json saat sesi ditutup, jadi direktorinya harus dihapus dari sisi
// kita. Dipanggil register.js lewat closeBrowserSession().
function cleanupProfile(userId) {
    const dir = profileDirFor(userId);
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`[Camofox] ✓ Profil ${String(userId).slice(0, 24)} dibersihkan.`);
        }
    } catch (e) { console.log(`[Camofox] Gagal membersihkan profil: ${e.message}`); }
}

process.on('exit', () => { killTree('SIGKILL'); });

// Snapshot for the dashboard: is the server up, with what exit, and is the
// browser visible (noVNC) — plus whether the local install looks complete.
function status() {
    let profileCount = 0;
    try { profileCount = fs.readdirSync(path.join(DATA_DIR, 'profiles')).length; } catch (_) { }
    return {
        running: isRunning(),
        port: getPort(),
        visible: isVisible(),
        vncPort: VNC_PORT,
        novncPort: NOVNC_PORT,
        novncUrl: novncUrl(),
        screen: SCREEN_RESOLUTION,
        installed: fs.existsSync(path.join(CAMOFOX_DIR, 'server.js')),
        browserInstalled: fs.existsSync(path.join(CAMOUFOX_DIR, 'browser')) || fs.existsSync(path.join(CAMOUFOX_DIR, '.camoufox', 'browser')),
        profileCount,
        proxy: spec && spec.proxy ? `${spec.proxy.protocol}://${spec.proxy.host}:${spec.proxy.port}` : null,
    };
}

module.exports = {
    ensureRunning,
    stop,
    isRunning,
    status,
    baseUrl,
    getPort,
    isVisible,
    cleanupProfile,
    wipeSessionState,
    profileDirFor,
    novncUrl,
    CAMOFOX_DIR,
    CAMOUFOX_DIR,
    DATA_DIR,
    DEFAULT_PORT,
    NOVNC_PORT,
};
