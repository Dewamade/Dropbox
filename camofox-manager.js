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
const crypto = require('crypto');
const { spawn } = require('child_process');

const CAMOFOX_DIR = path.join(__dirname, 'camofox-browser');
// camoufox-js installs the browser tree directly into CAMOUFOX_INSTALL_DIR
const CAMOUFOX_DIR = path.join(CAMOFOX_DIR, '.camoufox');
const DATA_DIR = path.join(__dirname, 'camofox-data');
const DEFAULT_PORT = 9379;
const VNC_PORT = 5902;
const NOVNC_PORT = 6082;
// Ukuran layar browser: plugin `screen` di camofox-browser memakai nilai ini untuk
// Xvfb sekaligus mengunci ukuran jendela/layar yang dilaporkan Camoufox, jadi
// halaman selalu berukuran sama di mesin mana pun (VNC_RESOLUTION saat visible).
const SCREEN = { width: 1360, height: 768 };
const SCREEN_RESOLUTION = `${SCREEN.width}x${SCREEN.height}`;

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
    // Scoped cleanup: only processes whose command line points at this project.
    const scoped = [
        path.join(CAMOFOX_DIR, 'server.js'),
        path.join(CAMOUFOX_DIR, 'browser'),
    ];
    for (const needle of scoped) {
        try { require('child_process').execSync(`pkill -9 -f "${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, { stdio: 'ignore' }); } catch (_) { }
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
                if (visible) console.log(`[Camofox] Browser terlihat lewat noVNC: http://localhost:${NOVNC_PORT}`);
                return currentBaseUrl;
            }
            lastErr = `HTTP ${r.status}`;
        } catch (e) { lastErr = e.message; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    await stop();
    throw new Error(`Server camofox tidak siap dalam ${timeoutMs / 1000} detik (${lastErr || 'health timeout'})`);
}

// Remove the persisted profile of a farmed user so the next email never inherits
// cookies/storage (fresh identity per account).
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
    profileDirFor,
    CAMOFOX_DIR,
    CAMOUFOX_DIR,
    DATA_DIR,
    DEFAULT_PORT,
    NOVNC_PORT,
};
