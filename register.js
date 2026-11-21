/**
 * register.js — Dropbox signup automation driven by camofox (Camoufox anti-detect
 * browser) instead of Playwright+Firefox. The browser is a separate, long-running
 * server (./camofox-browser) reached over REST; one *session* (userId) per email,
 * destroyed afterwards, so every account gets a clean profile.
 *
 * Exit paths (direct / warp / psiphon / socks5) are set by proxy-manager plus the
 * camofox PROXY_* env; changing the path restarts the camofox server.
 *
 * The failure vocabulary is a contract with server.js — keep it:
 *   throw new Error('BROWSER_KILL_REQUIRED: …')  → caller resets session / rotates IP
 *   throw new Error('NO_URL_CHANGE')             → soft retry of the same step
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const camofox = require('./camofox-manager');
const { CamofoxClient } = require('./camofox-client');
const proxy = require('./proxy-manager');

const DROPBOX_DIST = path.join(__dirname, 'dropbox-app', '.dropbox-dist');
const DROPBOX_DAEMON = path.join(DROPBOX_DIST, 'dropboxd');
const DAEMON_HOME = path.join(__dirname, 'dropbox-app');
const SCREENSHOT_DIR = path.join(__dirname, 'data');

// The daemon normally runs in a throwaway container. Only its read-only binary tree is
// mounted; the device state (.dropbox/) and the sync folder (Dropbox/) live in the
// container's tmpfs, and the hostname + machine-id are regenerated per run — so every
// account really does face a brand-new machine and the cli_link URL always appears.
// (A host_id that is already linked never prints that URL again.)
const DOCKER_IMAGE = 'ubuntu:24.04';
const CONTAINER_DIST = '/opt/dropbox/.dropbox-dist';
const CONTAINER_DAEMON = path.posix.join(CONTAINER_DIST, 'dropboxd');

function randomHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

// ── Selector catalogue (selector.json, editable from the dashboard) ───────────
let cachedSelectors = null;
function loadSelectors() {
    if (cachedSelectors) return cachedSelectors;
    try {
        cachedSelectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'selector.json'), 'utf8'));
        console.log('[Selector] Dimuat dari selector.json');
    } catch (_) {
        console.log('[Selector] selector.json tidak ditemukan, menggunakan default.');
        cachedSelectors = {};
    }
    return cachedSelectors;
}

function getSelectors(key) {
    const sel = loadSelectors();
    if (Array.isArray(sel[key])) return sel[key];
    if (sel.selectors && Array.isArray(sel.selectors[key])) return sel.selectors[key];
    return [];
}

// ── Process cleanup (reached from server.js through global) ──────────────────
let activeClient = null;
let dropboxProc = null;
let dropboxContainer = null;       // container name while the daemon runs in Docker
let dropboxMode = null;            // 'docker' | 'native'
let dockerUsable = null;           // cached answer of hasDocker()

function hasDocker() {
    if (dockerUsable === null) {
        try {
            execSync('docker version --format {{.Server.Version}}', { stdio: 'pipe' });
            dockerUsable = true;
        } catch (_) {
            dockerUsable = false;
        }
    }
    return dockerUsable;
}

// Pull the daemon image once, streaming its output into the log.
let imagePresent = null;
async function ensureDaemonImage() {
    try { execSync(`docker image inspect ${DOCKER_IMAGE}`, { stdio: 'pipe' }); imagePresent = true; return true; } catch (_) { }
    console.log(`[dropboxd] Image ${DOCKER_IMAGE} belum ada — menariknya...`);
    await new Promise((resolve) => {
        const p = spawn('docker', ['pull', DOCKER_IMAGE]);
        p.stdout.on('data', (c) => console.log(`[dropboxd] ${c.toString().trim()}`));
        p.stderr.on('data', (c) => console.log(`[dropboxd] ${c.toString().trim()}`));
        p.on('exit', (code) => resolve(code === 0));
        p.on('error', () => resolve(false));
    }).then((ok) => {
        if (!ok) throw new Error(`[dropboxd] docker pull ${DOCKER_IMAGE} gagal — jalankan ./setup.sh`);
        imagePresent = true;
    });
    return true;
}

// What the dashboard shows under Status Mesin Lokal.
function daemonStatus() {
    const docker = hasDocker();
    if (docker && imagePresent === null) {
        try { execSync(`docker image inspect ${DOCKER_IMAGE}`, { stdio: 'pipe' }); imagePresent = true; } catch (_) { imagePresent = false; }
    }
    return {
        mode: docker ? 'docker' : 'native',
        docker,
        image: DOCKER_IMAGE,
        imagePresent: docker ? imagePresent : null,
        running: !!(dropboxProc && dropboxProc.exitCode === null),
        container: dropboxContainer,
    };
}

// Start the daemon process. Docker is the normal path: a container that never existed
// before IS a fresh machine. Without a docker daemon we fall back to running the
// binary directly, which forces freshness by deleting the host-side device state.
async function startDropboxDaemon(tag) {
    if (!fs.existsSync(DROPBOX_DAEMON)) throw new Error(`Dropbox daemon tidak ada: ${DROPBOX_DAEMON} — jalankan ./setup.sh`);

    if (hasDocker()) {
        await ensureDaemonImage();
        const name = `dropbox-link-${tag}-${randomHex(3)}`;
        const hostname = `pc-${randomHex(3)}`;
        const machineId = randomHex(16);
        dropboxMode = 'docker';
        dropboxContainer = name;
        console.log(`[dropboxd] Perangkat baru via Docker (${DOCKER_IMAGE}, hostname ${hostname}, machine-id ${machineId}) — state di tmpfs, hanya .dropbox-dist yang di-mount (ro).`);
        dropboxProc = spawn('docker', [
            'run', '-i', '--rm', '--init', '--name', name, '--net=host',
            '--hostname', hostname,
            '-v', `${DROPBOX_DIST}:${CONTAINER_DIST}:ro`,
            '--tmpfs', '/root/.dropbox',
            '--tmpfs', '/root/Dropbox',
            DOCKER_IMAGE, 'sh', '-c',
            `mkdir -p /var/lib/dbus; printf '%s\\n' '${machineId}' > /etc/machine-id; cp /etc/machine-id /var/lib/dbus/machine-id; exec ${CONTAINER_DAEMON}`,
        ]);
        return;
    }

    // Fallback: satu akun = satu identitas perangkat. State lama menyimpan host_id yang
    // sudah ter-link; daemon yang sudah ter-link tidak pernah mencetak URL cli_link lagi,
    // jadi langkah ini selalu timeout (akun berikutnya hanya jadi VERIF).
    for (const stale of ['.dropbox', 'Dropbox']) {
        const p = path.join(DAEMON_HOME, stale);
        if (fs.existsSync(p)) {
            fs.rmSync(p, { recursive: true, force: true });
            console.log(`[dropboxd] State lama dihapus (${stale}/) — perangkat baru untuk akun ini.`);
        }
    }
    dropboxMode = 'native';
    dropboxContainer = null;
    console.log('[dropboxd] Docker tidak tersedia — menjalankan daemon langsung di host.');
    // HOME dipaku di dropbox-app/ supaya state (.dropbox/) dan folder sync (Dropbox/)
    // tidak pernah muncul di luar proyek. DISPLAY/DBus dihapus: dengan display, daemon
    // 278.x membuka jendela GUI (Firefox bawaannya) dan tidak mencetak apa pun; tanpa
    // display ia mode CLI headless dan mencetak URL cli_link.
    const daemonEnv = { ...process.env, HOME: DAEMON_HOME };
    ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'].forEach((v) => delete daemonEnv[v]);
    fs.mkdirSync(DAEMON_HOME, { recursive: true });
    dropboxProc = spawn(DROPBOX_DAEMON, [], { cwd: path.dirname(DROPBOX_DAEMON), env: daemonEnv });
}

function killDropboxDaemon({ log = true } = {}) {
    if (dropboxContainer) {
        try { execSync(`docker kill ${dropboxContainer}`, { stdio: 'ignore' }); } catch (_) { }
        try { execSync(`docker rm -f ${dropboxContainer}`, { stdio: 'ignore' }); } catch (_) { }
        dropboxContainer = null;
    }
    if (dropboxProc) {
        try { dropboxProc.kill('SIGTERM'); } catch (_) { }
        dropboxProc = null;
    }
    // Pola mencocokkan direktori dist-nya, bukan nama binary: daemon native exec() ke
    // .dropbox-dist/dropbox-lnx.x86_64-<ver>/dropbox, dan argv `docker run` kita juga
    // memuat path itu — jadi satu pkill membersihkan kedua jalur.
    try { execSync(`pkill -9 -f "${DROPBOX_DIST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, { stdio: 'ignore' }); } catch (_) { }
    if (log) console.log('[Kill] Proses Dropbox daemon dihentikan.');
}

// Sesi yang masih "hidup" setelah akun tercipta, yaitu selama langkah menghubungkan
// perangkat. Sesi TIDAK boleh dimatikan di langkah itu: akun sudah dibuat dan tab
// masih login, jadi kegagalan di sini cukup diulang dengan sesi yang sama lewat
// retryDeviceConnect(). Sesi ditutup hanya bila langkah selesai, user menghentikan,
// atau error memang mengharuskan mulai dari awal — closeBrowserSession() selalu
// mengosongkan ini, jadi tidak ada sesi palsu yang tertinggal.
let liveRun = null;

async function closeBrowserSession() {
    liveRun = null;
    if (activeClient) {
        const userId = activeClient.userId;
        try { await activeClient.destroy(); } catch (_) { }
        camofox.cleanupProfile(userId);
        activeClient = null;
    }
}

async function killAllVpnProxy() {
    await proxy.stopAll();
    console.log('[Kill] Semua proses Psiphon/Warp dihentikan paksa dan status di-reset.');
}

// Full stop: browser session + daemon + tunnels (the camofox server itself stays
// up unless stopEverything({ server:true }) is asked for).
async function stopEverything({ server = false } = {}) {
    await closeBrowserSession();
    killDropboxDaemon({ log: false });
    await proxy.stopAll();
    if (server) await camofox.stop({ log: () => console.log() });
    console.log('[Kill] Semua sesi browser, daemon, dan proxy dihentikan.');
}

global.closeBrowserSession = closeBrowserSession;
global.retryDeviceConnect = retryDeviceConnect;
global.killDropboxDaemon = killDropboxDaemon;
global.isDropboxRunning = () => !!(dropboxProc && dropboxProc.exitCode === null);
global.killAllVpnProxy = killAllVpnProxy;
global.stopEverything = stopEverything;
global.warpStatus = proxy.warpStatus;
global.previewScreenshot = async () => {
    if (!activeClient || !activeClient.tabId) return null;
    return await activeClient.screenshot({ fullPage: true });
};

// ── Small helpers ────────────────────────────────────────────────────────────
function askQuestion(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans.trim()); }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortCheck(abortController) {
    if (abortController && abortController.shouldStop) throw new Error('Pendaftaran dihentikan oleh pengguna.');
}

function generatePassword() {
    const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const specials = '!@#$%^&*()_+~`|}{[]:;?><,./-=';
    const allChars = letters + numbers + specials;

    const password = [
        letters.charAt(Math.floor(Math.random() * letters.length)),
        numbers.charAt(Math.floor(Math.random() * numbers.length)),
        specials.charAt(Math.floor(Math.random() * specials.length)),
    ];
    for (let i = 0; i < 9; i++) password.push(allChars.charAt(Math.floor(Math.random() * allChars.length)));
    for (let i = password.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [password[i], password[j]] = [password[j], password[i]];
    }
    return password.join('');
}

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

function getNameFromEmail(email) {
    if (!email) return getRandomName();
    const prefix = email.split('@')[0];
    if (prefix.includes('.')) {
        const parts = prefix.split('.');
        const firstPart = parts[0].replace(/[0-9]/g, '');
        const lastPart = parts[1].replace(/[0-9]/g, '');
        if (firstPart && lastPart) {
            const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
            return { first: capitalize(firstPart), last: capitalize(lastPart) };
        }
    }
    return getRandomName();
}

// Human-like pause between actions (camoufox humanizes input, not the waits).
function humanPause(minMs, maxMs) {
    return sleep(minMs + Math.random() * (maxMs - minMs));
}

async function checkTooManyAttempts(cf) {
    const text = (await cf.bodyText()).toLowerCase();
    const hit = ['too many attempts', 'please try later', 'terlalu banyak percobaan', 'coba lagi nanti']
        .some((keyword) => text.includes(keyword));
    if (hit) throw new Error('BROWSER_KILL_REQUIRED: Too many attempts. Please try later.');
}

// Satu pemeriksaan "batas" Dropbox: rate-limit halaman atau CAPTCHA yang muncul.
// Keduanya bukan kegagalan teknis (timeout/proxy/daemon) — yang memulihkannya
// IP keluar + profil baru, atau manusia yang menyelesaikan CAPTCHA lewat noVNC.
// Karena itu keduanya dilaporkan sebagai LIMIT: di pesan error, dan server.js
// memisahkan penghitungnya dari Error.
async function checkPageLimit(cf, { headless }) {
    await checkTooManyAttempts(cf);
    // Mode terlihat = ada manusia di noVNC yang bisa menyelesaikannya; di situ
    // CAPTCHA bukan alasan untuk membatalkan percobaan.
    if (headless && await reportCaptcha(cf)) {
        throw new Error('BROWSER_KILL_REQUIRED: CAPTCHA_DETECTED: CAPTCHA terlihat di halaman — tidak ada yang menyelesaikannya (mode headless).');
    }
}

async function reportCaptcha(cf) {
    let captchaSelectors = getSelectors('captcha');
    if (captchaSelectors.length === 0) {
        captchaSelectors = ['iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]', 'iframe[src*="recaptcha"]', 'iframe[title*="CAPTCHA"]', 'div[class*="captcha"]', '.g-recaptcha'];
    }
    const hit = await cf.findVisible(captchaSelectors);
    return !!hit;
}

// ── Proxy / browser path ─────────────────────────────────────────────────────
function parseSocks5Host(proxyHost) {
    const raw = String(proxyHost || '127.0.0.1:1080');
    const [host, port] = raw.includes(':') ? raw.split(':') : [raw, '1080'];
    return { host, port: parseInt(port, 10) || 1080 };
}

/**
 * Bring up the requested exit and a camofox server that uses it.
 * Returns { baseUrl, proxyType, exitIp, mode } — `mode` is what the UI shows.
 */
async function ensureExitPath(proxyType, proxyHost, { abortController, isRetry, headless, warpPort }) {
    let proxySpec = null;
    let exitIp = null;
    let mode = 'Direct Connection';

    if (proxyType === 'warp') {
        await proxy.stopPsiphon();
        const r = await proxy.startWarp({
            port: warpPort || proxy.DEFAULT_WARP_PORT,
            rotate: !!isRetry || !!global.warpRotateNext,
            abortController,
        });
        global.warpRotateNext = false;
        const u = new URL(r.proxy);
        proxySpec = { host: u.hostname, port: Number(u.port), protocol: 'socks5' };
        exitIp = r.exitIp;
        mode = 'Warp+Socks5';
    } else if (proxyType === 'psiphon') {
        await proxy.stopWarp();
        const r = await proxy.startPsiphon({ abortController, rotate: !!isRetry });
        const u = new URL(r.proxy);
        proxySpec = { host: u.hostname, port: Number(u.port), protocol: 'socks5' };
        mode = global.psiphonRegion ? `Psiphon (${global.psiphonRegion})` : 'Psiphon';
    } else if (proxyType === 'socks5') {
        await proxy.stopWarp();
        await proxy.stopPsiphon();
        const { host, port } = parseSocks5Host(proxyHost);
        proxySpec = { host, port, protocol: 'socks5' };
        mode = `Socks5 Only (${host}:${port})`;
        console.log(`[Proxy] Menggunakan custom Socks5 ${host}:${port}`);
    } else {
        await proxy.stopWarp();
        await proxy.stopPsiphon();
    }

    const baseUrl = await camofox.ensureRunning({
        proxy: proxySpec,
        visible: headless === false,
        abortController,
    });
    return { baseUrl, proxySpec, exitIp, mode };
}

// ── One registration ─────────────────────────────────────────────────────────
async function registerSingleEmail(
    url, email, proxyType = 'direct', proxyHost = '', abortController = null,
    headless = true, passwordMode = 'random', fixedPassword = '',
    globalTimeout = 30, daemonTimeout = 120, alias = '', globalRetry = 3, isRetry = false,
    { warpPort = proxy.DEFAULT_WARP_PORT } = {}
) {
    const gtMs = globalTimeout * 1000;
    if (proxyType !== 'psiphon') global.psiphonRegion = null;

    console.log(`\n==========================================`);
    console.log(`Memulai pendaftaran untuk email: ${email}`);
    console.log(`Proxy: ${proxyType === 'psiphon' ? 'Psiphon (SOCKS5)' : proxyType === 'socks5' ? 'SOCKS5 manual' : proxyType === 'warp' ? 'WARP (Cloudflare SOCKS5)' : 'TIDAK ADA (Direct Connection)'}`);
    console.log(`==========================================`);

    const { first: firstName, last: lastName } = getNameFromEmail(email);
    const password = (passwordMode === 'fixed' && fixedPassword) ? fixedPassword : generatePassword();
    console.log(`- First Name: ${firstName}`);
    console.log(`- Last Name : ${lastName}`);
    console.log(`- Password  : ${password}`);

    abortCheck(abortController);
    const { baseUrl, exitIp, mode } = await ensureExitPath(proxyType, proxyHost, { abortController, isRetry, headless, warpPort });

    // One clean profile per email: userId keys camofox's persisted profile.
    const userId = `dropbox-${String(email).split('@')[0]}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const cf = new CamofoxClient({ baseUrl, userId });
    activeClient = cf;
    global.currentUserId = userId;
    global.camofoxTab = null;

    let serverIp = exitIp || 'Unknown';
    // IP keluar percobaan ini untuk server (global.currentExitIp = jembatan modul yang
    // sudah ada): record riwayat Blocked/Error harus menyebut IP yang benar-benar
    // dipakai. Kosong = belum terukur, dan server menuliskannya sebagai '-'.
    global.currentExitIp = serverIp === 'Unknown' ? '' : serverIp;
    let userAgent = 'Unknown';
    let finalStatus = 'VERIF';
    let keepSessionAlive = false;

    try {
        // ── Preflight: exit IP + UA as the browser really sees them ──────────
        console.log(`[Camofox] Membuat sesi ${userId}`);
        await cf.createTab(proxy.EXIT_IP_ENDPOINTS[0].url);
        global.camofoxTab = cf.tabId;
        console.log(`[Camofox] Cek IP/UA via browser (timeout ${globalTimeout} detik)...`);
        // IP dibaca ulang lewat browser (bukan dari proxy manager) supaya benar-benar
        // yang terlihat tab yang dilaporkan; endpoint sama dengan proxy-manager:
        // cdn-cgi/trace selalu menjawab, ipify kadang menantang egress WARP.
        for (const [i, ep] of proxy.EXIT_IP_ENDPOINTS.entries()) {
            if (i > 0) {
                await cf.navigate(ep.url, { timeoutMs: Math.max(gtMs, 15000) });
                await cf.settle({ timeoutMs: 5000 });
            }
            let body = '';
            try {
                body = String(await cf.evaluate(`document.body ? document.body.innerText : ''`, { timeoutMs: Math.max(gtMs, 15000) }) || '');
            } catch (e) {
                console.log(`[Camofox] Gagal baca IP dari halaman: ${e.message.split('\n')[0]}`);
            }
            const parsed = ep.parse(body);
            if (parsed) {
                serverIp = parsed.ip;
                global.currentExitIp = serverIp;
                if (parsed.warp) console.log(`[Camofox] cdn-cgi/trace: warp=${parsed.warp}`);
                break;
            } else if (body.trim()) {
                console.log(`[Camofox] ${new URL(ep.url).host} tidak mengembalikan IP (halaman tantangan/blokir), coba endpoint lain.`);
            }
        }
        userAgent = await cf.evaluate('navigator.userAgent', { timeoutMs: 10000 }).catch(() => 'Unknown');
        console.log(`[Server] Public IP (via browser/${mode}): ${serverIp}`);
        console.log(`[Camofox] User Agent: ${userAgent}`);

        if (typeof global.safeSend === 'function') {
            global.safeSend({ type: 'info', info: { alias: alias || '-', mode, email, ip: serverIp, ua: userAgent } });
        }

        if (!serverIp || serverIp === 'Unknown') {
            throw new Error('BROWSER_KILL_REQUIRED: Exit IP tidak terbaca — koneksi keluar mati.');
        }

        if (abortController && abortController.shouldStop) throw new Error('Pendaftaran dihentikan oleh pengguna.');

        let isRegistered = false;
        let tabAttempt = 0;
        const maxTabAttempts = globalRetry || 3;

        while (tabAttempt < maxTabAttempts && !isRegistered) {
            tabAttempt++;
            if (tabAttempt > 1) console.log(`\n[Tab Reload] Mencoba ulang pendaftaran di tab yang sama (Percobaan ${tabAttempt}/${maxTabAttempts})...`);

            try {
                console.log(`[Navigasi] Ke: ${url}`);
                await cf.navigate(url, { timeoutMs: Math.max(gtMs, 30000) });
                await cf.settle({ timeoutMs: Math.min(gtMs, 20000) });
                await checkPageLimit(cf, { headless });

                console.log('Mencari form input pendaftaran...');
                await humanPause(2000, 4000);

                // Optional: dismiss cookie banners if any are present.
                try {
                    const cookieHit = await cf.findVisible(['button[data-testid="accept-cookies"]', '#consent-accept-button']);
                    if (cookieHit) {
                        await cf.clickVisible([cookieHit.selector]);
                        console.log('✓ Menutup banner cookie');
                        await sleep(1000);
                    }
                } catch (_) { }

                // ── STEP 1: email + Continue ─────────────────────────────────
                console.log(`\n[Langkah 1] Menunggu field email muncul (timeout ${globalTimeout} detik)...`);
                let emailSelectors = getSelectors('email_field');
                if (emailSelectors.length === 0) {
                    emailSelectors = ['input[name="email2"]', 'input[type="email2"]', 'input[placeholder*="Email2"]', 'input[placeholder*="email2"]', 'input[id*="email2"]'];
                }
                let activeEmailSelector = await cf.waitForVisible(emailSelectors, gtMs, {
                    abortController,
                    onPoll: ({ remainingMs, first }) => {
                        if (first) return;
                        if (remainingMs < gtMs * 0.5) cf.scroll('down', 200);
                    },
                });
                if (!activeEmailSelector) {
                    throw new Error(`BROWSER_KILL_REQUIRED: Field email tidak muncul dalam ${globalTimeout} detik.`);
                }
                console.log(`✓ Field email ditemukan: ${activeEmailSelector}`);
                await cf.typeVisible([activeEmailSelector], email);
                console.log('✓ Mengisi Email');

                await humanPause(500, 1300);

                console.log(`Mengklik tombol 'Continue'...`);
                let continueSelectors = getSelectors('continue_button');
                if (continueSelectors.length === 0) continueSelectors = ['button.email-submit-button', 'button[type="submit"]'];
                const clickedContinue = await cf.clickVisible(continueSelectors);
                if (clickedContinue) {
                    console.log(`✓ Mengklik Continue: ${clickedContinue}`);
                } else {
                    console.log('Peringatan: Tombol Continue tidak terdeteksi, menekan Enter di field email...');
                    await cf.typeVisible([activeEmailSelector], '', { submit: true });
                }

                await sleep(2000);
                await checkPageLimit(cf, { headless });

                // ── STEP 2: name + password + TOS + submit ───────────────────
                const step2Timeout = Math.max(Math.round(globalTimeout / 2), 10);
                console.log(`\n[Langkah 2] Menunggu form nama dan password (timeout ${step2Timeout} detik)...`);
                let firstNameSelectors = getSelectors('first_name');
                if (firstNameSelectors.length === 0) {
                    firstNameSelectors = ['input[id^="fname"]', 'input[name="fname"]', 'input[autocomplete="given-name"]', 'input[placeholder*="First name"]', 'input[placeholder*="Nama depan"]'];
                }
                const step2Selector = await cf.waitForVisible(firstNameSelectors, step2Timeout * 1000, {
                    abortController,
                    onPoll: ({ first }) => { if (!first) cf.scroll('down', 200); },
                });
                if (!step2Selector) {
                    throw new Error(`BROWSER_KILL_REQUIRED: Form Langkah 2 tidak muncul dalam ${step2Timeout} detik.`);
                }
                console.log(`✓ Form Langkah 2 terdeteksi: ${step2Selector}`);

                await cf.typeVisible([step2Selector], firstName);
                console.log('✓ Mengisi First Name');
                await humanPause(400, 1000);

                let lastNameSelectors = getSelectors('last_name');
                if (lastNameSelectors.length === 0) {
                    lastNameSelectors = ['input[id^="lname"]', 'input[name="lname"]', 'input[autocomplete="family-name"]', 'input[placeholder*="Last name"]', 'input[placeholder*="Nama belakang"]'];
                }
                if (await cf.typeVisible(lastNameSelectors, lastName)) console.log('✓ Mengisi Last Name');
                await humanPause(400, 1000);

                let passwordSelectors = getSelectors('password');
                if (passwordSelectors.length === 0) {
                    passwordSelectors = ['input[id^="password"]', 'input[name="password"]', 'input[type="password"]', 'input[placeholder*="Password"]', 'input[placeholder*="Kata sandi"]'];
                }
                const pwSelector = await cf.typeVisible(passwordSelectors, password);
                if (!pwSelector) throw new Error('BROWSER_KILL_REQUIRED: Field password tidak terisi.');
                console.log('✓ Mengisi Password');
                await humanPause(600, 1400);

                let checkboxSelectors = getSelectors('tos_checkbox');
                if (checkboxSelectors.length === 0) {
                    checkboxSelectors = ['input[type="checkbox"][name="tos_agree"]', 'input[type="checkbox"]', '.agree-checkbox'];
                }
                const checked = await cf.isChecked(checkboxSelectors);
                if (checked === false) {
                    await cf.clickVisible(checkboxSelectors);
                    console.log('✓ Menyetujui syarat dan ketentuan (TOS)');
                } else if (checked === null) {
                    console.log('Catatan: checkbox TOS tidak ditemukan (mungkin tidak diperlukan).');
                }
                await sleep(1000);

                let submitSelectors = getSelectors('submit_button');
                if (submitSelectors.length === 0) submitSelectors = ['button[type="submit"]', 'button:has-text("Agree and sign up")', 'button:has-text("Daftar")'];
                console.log(`\nMencoba menekan tombol 'Agree and sign up'...`);
                const submitted = await cf.clickVisible(submitSelectors);
                if (submitted) console.log(`✓ Berhasil mengklik tombol Daftar: ${submitted}`);
                else {
                    console.log('Tombol Daftar tidak ketemu, mengirim form dengan Enter...');
                    await cf.typeVisible([pwSelector], '', { submit: true });
                }

                console.log('Catatan: jika muncul CAPTCHA di browser, selesaikan manual lewat noVNC.');
                console.log(`\n[Langkah 3] Menunggu redirect URL sukses pendaftaran (timeout ${globalTimeout} detik)...`);
                const regDeadline = Date.now() + gtMs;
                while (Date.now() < regDeadline) {
                    await sleep(2000);
                    await checkPageLimit(cf, { headless });
                    const currentUrl = await cf.currentUrl();
                    if (currentUrl.includes('trial_first') || currentUrl.includes('verify_email') ||
                        (!currentUrl.includes('/register') && !currentUrl.includes('/login') &&
                            (currentUrl.includes('/home') || currentUrl.includes('/personal') || currentUrl.includes('/dashboard') || currentUrl.includes('dropbox.com/h')))) {
                        console.log(`\n✓ Pendaftaran/Verifikasi terdeteksi! URL saat ini: ${currentUrl}`);
                        isRegistered = true;
                        break;
                    }
                }

                if (!isRegistered) {
                    console.log(`\n⚠️ URL tidak berubah dalam ${globalTimeout} detik setelah menekan tombol daftar.`);
                    throw new Error('NO_URL_CHANGE');
                }
            } catch (innerError) {
                if (innerError.message === 'Pendaftaran dihentikan oleh pengguna.') throw innerError;
                const errMsg = (innerError.message || '').toLowerCase();

                if (innerError.message && innerError.message.includes('BROWSER_KILL_REQUIRED')) throw innerError;
                if (innerError.message === 'NO_URL_CHANGE') {
                    throw new Error(`BROWSER_KILL_REQUIRED: URL tidak berubah setelah ${globalTimeout} detik.`);
                }

                const isBrowserError = ['target closed', 'context', 'ns_error', 'session', 'connection refused', 'crashed', 'http 40', 'http 50', 'timeout']
                    .some((k) => errMsg.includes(k));
                if (isBrowserError) {
                    console.log(`\n💥 Error berat browser/sesi (Percobaan ${tabAttempt}): ${innerError.message.split('\n')[0]}`);
                    throw new Error(`BROWSER_KILL_REQUIRED: ${innerError.message}`);
                }

                console.log(`\n⚠️ Error ringan (Percobaan ${tabAttempt}/${maxTabAttempts}): ${innerError.message.split('\n')[0]}`);
                if (tabAttempt >= maxTabAttempts) {
                    throw new Error(`BROWSER_KILL_REQUIRED: Batas ${maxTabAttempts} percobaan tab tercapai. ${innerError.message}`);
                }
                console.log('[Tab Reload] Memuat ulang URL dan mengulangi pendaftaran...');
                await cf.refresh({ timeoutMs: Math.max(gtMs, 30000) }).catch(() => { });
                await sleep(2000);
            }
        }

        if (!isRegistered) throw new Error(`Pendaftaran gagal setelah mencoba ${maxTabAttempts} kali reload tab.`);

        // ── Registered: link the Dropbox daemon, then trigger the verification email ──
        console.log('✅ Pendaftaran berhasil! Memulai menghubungkan perangkat...');
        await sleep(1500);

        const deviceOpts = { email, password, url, gtMs, globalTimeout, daemonTimeout, maxCliAttempts: globalRetry || 3, maxVerifAttempts: globalRetry || 3 };
        // Akun sudah ada dan tab masih login: catat sesi supaya caller bisa mengulang
        // HANYA langkah menghubungkan perangkat dengan sesi yang sama.
        liveRun = { cf, opts: deviceOpts, password, ip: serverIp || '', ua: userAgent || '' };

        try {
            finalStatus = await linkDaemonAndVerifyEmail(cf, { ...deviceOpts, abortController });
        } catch (verifError) {
            keepSessionAlive = true;
            console.log(`[Info] Gagal menghubungkan perangkat: ${verifError.message}`);
            throw new Error(`DEVICE_CONNECT_FAILED: ${verifError.message}`);
        } finally {
            killDropboxDaemon({ log: false });
        }

        if (finalStatus !== 'VERIF') {
            console.log(`⏳ Jeda 5 detik setelah pendaftaran sukses untuk ${email}...`);
            await sleep(5000);
        }

        return { success: true, status: finalStatus, password, ip: serverIp || '', ua: userAgent || '' };
    } catch (error) {
        // console.* is hijacked into JSON, which turns an Error into {} — log the text.
        console.error(`Terjadi error untuk email ${email}: ${error && error.message ? error.message : error}`);
        throw error;
    } finally {
        if (abortController && typeof abortController.abort === 'function') {
            try { await abortController.abort(); } catch (_) { }
            abortController.abort = null;
        }
        if (keepSessionAlive && liveRun) {
            console.log(`[Sesi] Sesi DIPERTAHANKAN untuk ${email} — akun sudah dibuat; ulangi langkah menghubungkan perangkat (retryDeviceConnect) tanpa login ulang.`);
        } else {
            console.log(`Menutup sesi camofox untuk ${email}...`);
            await closeBrowserSession();
            global.currentUserId = null;
            global.camofoxTab = null;
        }
        killDropboxDaemon({ log: false });
    }
}

// ── Ulangi langkah menghubungkan perangkat dengan SESI YANG SAMA ──────────────
// Dipanggil caller setelah registerSingleEmail melempar 'DEVICE_CONNECT_FAILED:'.
// Akun sudah tercipta dan tab masih login, jadi yang diulang hanya device connect +
// permintaan email verifikasi — tanpa profil baru dan tanpa login ulang. Sesi ditutup
// di akhir fungsi ini karena langkahnya sudah selesai (sukses maupun VERIF).
async function retryDeviceConnect({ abortController } = {}) {
    if (!liveRun || !liveRun.cf || liveRun.cf !== activeClient) {
        throw new Error('DEVICE_CONNECT_FAILED: tidak ada sesi hidup yang bisa dilanjutkan.');
    }
    const { cf, opts, password, ip, ua } = liveRun;
    console.log(`\n[Device Connect] Mengulang langkah menghubungkan perangkat dengan sesi yang sama (${opts.email})...`);
    let finalStatus = 'VERIF';
    try {
        finalStatus = await linkDaemonAndVerifyEmail(cf, { ...opts, abortController });
    } catch (error) {
        console.log(`[Info] Device connect tetap gagal di sesi yang sama: ${error.message}`);
    } finally {
        killDropboxDaemon({ log: false });
    }
    await closeBrowserSession();
    global.currentUserId = null;
    global.camofoxTab = null;
    return { success: true, status: finalStatus, password, ip, ua };
}

// ── Login recovery at the cli_link page ──────────────────────────────────────
// Bukti (data/debug_error_cli_confirm_*.png): kadang halaman cli_link justru
// menampilkan form login Dropbox ("Masuk" di kanan atas), bukan tombol Connect —
// sesi browser yang dipakai mendaftar sudah tidak login (mis. IP keluar berubah di
// tengah alur). Kalau begitu, login ulang dengan email + password akun yang baru
// dibuat, lalu lanjut ke tombol Connect seperti biasa.
async function ensureDropboxLogin(cf, { email, password, gtMs, abortController }) {
    let emailSel = getSelectors('cli_login_email');
    if (!Array.isArray(emailSel) || emailSel.length === 0) {
        emailSel = ['input[id^="susi_email"]', 'input[id^="susi"][type="email"]', 'input[type="email"]', 'input[name*="email" i]'];
    }
    let passSel = getSelectors('cli_login_password');
    if (!Array.isArray(passSel) || passSel.length === 0) {
        passSel = ['input[type="password"]', 'input[id*="password" i]', 'input[name*="password" i]'];
    }

    const loginField = await cf.waitForVisible(emailSel, 5000, { pollMs: 700, abortController });
    if (!loginField) return false;                       // sesi masih login
    if (!password) throw new Error('Halaman cli_link meminta login, tapi password akun tidak diketahui.');

    console.log(`[Browser] Sesi tidak login di halaman cli_link — login ulang sebagai ${email} (field: ${loginField})...`);
    await cf.typeVisible([loginField], email, { submit: true });

    const pwField = await cf.waitForVisible(passSel, Math.min(gtMs, 20000), { pollMs: 700, abortController });
    if (!pwField) throw new Error('Form login Dropbox tidak menampilkan field password.');
    await cf.typeVisible([pwField], password, { submit: true });

    const deadline = Date.now() + Math.min(gtMs, 30000);
    while (Date.now() < deadline) {
        abortCheck(abortController);
        await sleep(1000);
        const stillForm = await cf.findVisible(passSel, { timeoutMs: 4000 }).catch(() => null)
            || await cf.findVisible(emailSel, { timeoutMs: 4000 }).catch(() => null);
        if (!stillForm) {
            console.log('[Browser] ✓ Login ulang berhasil, halaman cli_link sekarang bertopeng akun.');
            return true;
        }
    }
    throw new Error('Login ulang di halaman cli_link tidak berhasil.');
}

// URL cli_link: satu pola untuk log DAN untuk halaman yang dibuka browser.
// Dipisah sebagai konstanta supaya filter log dan pencarian URL tidak pernah
// berbeda paham tentang bentuk URL-nya.
const CLI_LINK_URL_RE = /https:\/\/www\.dropbox\.com\/cli_link[^\s"'<]*/i;

// Daemon linking + verify-email. Returns 'success' | 'VERIF'.
async function linkDaemonAndVerifyEmail(cf, { email, password, gtMs, globalTimeout, daemonTimeout, maxCliAttempts, maxVerifAttempts, abortController }) {
    // ── Start the local Dropbox daemon (binary lives in ./dropbox-app) ───────
    console.log('\n[dropboxd] Memulai proses Dropbox daemon...');
    await startDropboxDaemon(String(email).split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 24) || 'account');

    let cliLinkUrl = null;
    let isLinked = false;

    // Satu pendengar per stream: retryDeviceConnect() memanggil fungsi ini lagi
    // pada daemon yang SAMA, dan listener lama masih menempel di process yang
    // sama -> tanpa pembersihan ini baris output (termasuk URL-nya) tercetak
    // dua kali.
    dropboxProc.stdout.removeAllListeners('data');
    dropboxProc.stderr.removeAllListeners('data');

    const onDaemon = (chunk) => {
        const text = chunk.toString();
        text.split('\n').forEach((line) => {
            const t = line.trim();
            if (!t || t.includes('Try to launch using bash instead')) return;
            // Baris "To link this computer: type this url … https://…cli_link_nonce?…"
            // dicetak ulang daemon terus-menerus selama belum ter-link. URL-nya cuma
            // boleh muncul satu kali di konsol — yaitu lewat baris ✓ di bawah.
            if (CLI_LINK_URL_RE.test(t)) return;
            console.log(`[dropboxd] ${t}`);
        });
        // Nonce TIDAK sekali-pakai: selama belum ter-link daemon mencetak ulang URL
        // yang SAMA, jadi hanya URL yang benar-benar BERBEDA yang dilaporkan
        // (retry membuka nonce yang sudah ada, bukan yang baru).
        const m = text.match(CLI_LINK_URL_RE);
        if (m && m[0] !== cliLinkUrl) {
            cliLinkUrl = m[0];
            console.log(`[dropboxd] ✓ URL CLI Link ditemukan: ${cliLinkUrl}`);
        }
        if (text.includes('This computer is now linked to Dropbox')) isLinked = true;
    };
    dropboxProc.stdout.on('data', onDaemon);
    dropboxProc.stderr.on('data', onDaemon);
    dropboxProc.on('error', (err) => console.log(`[dropboxd] Gagal menjalankan daemon: ${err.message}`));
    dropboxProc.on('exit', (code, signal) => console.log(`[dropboxd] Proses daemon berhenti (code=${code} signal=${signal}).`));

    const startedAt = Date.now();
    while (!cliLinkUrl && Date.now() - startedAt < daemonTimeout * 1000) {
        abortCheck(abortController);
        if (dropboxProc && dropboxProc.exitCode !== null && !cliLinkUrl) {
            const hint = dropboxMode === 'docker' && dropboxProc.exitCode === 125
                ? ' — container tidak bisa dibuat (image / mount / docker permission)'
                : (dropboxMode === 'docker' ? ' — periksa `docker ps -a` dan `docker logs`' : '');
            throw new Error(`[dropboxd] Proses berhenti (mode ${dropboxMode}, kode ${dropboxProc.exitCode}) sebelum URL ditemukan${hint}`);
        }
        await sleep(200);
    }
    if (!cliLinkUrl) {
        killDropboxDaemon({ log: false });
        throw new Error(`[dropboxd] Timeout ${daemonTimeout} detik — URL cli_link tidak muncul`);
    }

    // ── Click "Connect" on the cli_link page ─────────────────────────────────
    let connectSelectors = getSelectors('cliLink');
    if (!Array.isArray(connectSelectors) || connectSelectors.length === 0) {
        connectSelectors = [
            'input[type="submit"][value*="Hubungkan"]',
            'input[type="submit"][value*="Connect"]',
            'button:has-text("Hubungkan")',
            'button:has-text("Connect")',
            'a:has-text("Hubungkan")',
            'a:has-text("Connect")',
            'button[type="submit"]',
            'input[type="submit"]'
        ];
    }

    let connected = false;
    let cliAttempt = 0;
    while (!connected && cliAttempt < maxCliAttempts) {
        cliAttempt++;
        try {
            // Nonce yang dicetak daemon tidak berubah-ubah selama ia belum ter-link
            // (bukan sekali-pakai), jadi retry cukup membuka ulang URL yang sama.
            console.log(`[Browser] Navigasi ke URL CLI Link (Attempt ${cliAttempt}/${maxCliAttempts})...`);
            await cf.navigate(cliLinkUrl, { timeoutMs: Math.max(gtMs, 30000) });
            await cf.settle({ timeoutMs: Math.min(gtMs, 15000) });

            await ensureDropboxLogin(cf, { email, password, gtMs, abortController });

            const found = await cf.waitForVisible(connectSelectors, Math.min(gtMs * 1000, 25000), { abortController });
            if (isLinked) {
                console.log('[Browser] ✓ Daemon melaporkan perangkat sudah ter-link (tanpa perlu klik).');
                connected = true;
                killDropboxDaemon({ log: false });
                continue;
            }
            if (!found) {
                await saveErrorScreenshot(cf, email, 'cli');
                throw new Error('Tombol Connect tidak ditemukan di halaman verifikasi.');
            }
            console.log(`[Browser] ✓ Tombol Connect terdeteksi: ${found}`);

            await cf.clickVisible([found]);
            console.log('[Browser] ✓ Tombol Connect ditekan, menunggu konfirmasi daemon...');

            const linkDeadline = Date.now() + gtMs;
            while (Date.now() < linkDeadline && !isLinked) await sleep(500);
            if (!isLinked) {
                await saveErrorScreenshot(cf, email, 'cli_confirm');
                let pageHint = '';
                try {
                    pageHint = (await cf.bodyText() || '').replace(/\s+/g, ' ').trim().slice(0, 300);
                } catch (_) { }
                if (pageHint) console.log(`[Browser] Teks halaman cli_link setelah klik: ${pageHint}`);
                throw new Error(`Konfirmasi 'This computer is now linked to Dropbox' tidak muncul setelah ${globalTimeout} detik.`);
            }

            console.log(`✅ [dropboxd] Akun ${email} berhasil dihubungkan ke Dropbox daemon!`);
            connected = true;
            killDropboxDaemon({ log: false });
        } catch (err) {
            if (err.message === 'Pendaftaran dihentikan oleh pengguna.') throw err;
            console.log(`[Browser] Error CLI Link (Attempt ${cliAttempt}): ${err.message}`);
            if (cliAttempt >= maxCliAttempts) throw new Error('Gagal verifikasi CLI Link.');
            await sleep(3000);
        }
    }

    // ── Ask Dropbox to send the verification email ───────────────────────────
    console.log('\n[Browser] Membuka halaman Settings untuk verifikasi email...');
    let emailSent = false;
    let verifAttempt = 0;

    while (verifAttempt < maxVerifAttempts && !emailSent) {
        verifAttempt++;
        if (verifAttempt > 1) console.log(`\n[Tab Reload] Mencoba ulang verifikasi email (Percobaan ${verifAttempt}/${maxVerifAttempts})...`);
        try {
            abortCheck(abortController);
            console.log('[Navigasi] Ke halaman Settings/Account...');
            await cf.navigate('https://www.dropbox.com/account', { timeoutMs: Math.max(gtMs, 30000) });
            await cf.settle({ timeoutMs: Math.min(gtMs, 15000) });

            let verifySelectors = getSelectors('verify_email');
            if (verifySelectors.length === 0) {
                verifySelectors = ['button[aria-label="Verify email"]', 'button.account-key-value-block__link:has-text("Verify email")', 'button:xtext("verify email|verifikasikan|verifikasi email")', 'a:xtext("verify email|verifikasikan|verifikasi email")', 'button.account-key-value-block__link'];
            }
            const verifyHit = await cf.waitForVisible(verifySelectors, gtMs * 1000, {
                abortController,
                onPoll: ({ first }) => { if (!first) cf.scroll('down', 200); },
            });
            if (!verifyHit) throw new Error('Tombol Verify email tidak ditemukan.');
            console.log(`[Browser] ✓ Tombol Verify terdeteksi: ${verifyHit}`);
            await cf.clickVisible([verifyHit]);
            console.log('[Browser] ✓ Tombol Verify diklik, menunggu modal...');

            let sendEmailSelectors = getSelectors('send_email');
            if (sendEmailSelectors.length === 0) {
                sendEmailSelectors = ['button:has-text("Send email")', 'button:has-text("Kirim email")', 'button.js-email-modal-button.dig-Button--primary', 'button[data-testid*="send-email"]', 'button[type="submit"].js-email-modal-button'];
            }
            const sendHit = await cf.waitForVisible(sendEmailSelectors, 15000, { abortController });
            if (!sendHit) throw new Error('Tombol Send email tidak ditemukan di modal.');
            await cf.clickVisible([sendHit]);
            console.log('[Browser] ✓ Tombol Send email diklik.');

            let resendSelectors = getSelectors('resend_email');
            if (resendSelectors.length === 0) {
                resendSelectors = ['button:has-text("Resend")', 'button:has-text("Kirim ulang")', 'button:has-text("Resend email")', 'button:has-text("Resend verification")', 'button[data-testid*="resend"]'];
            }
            const resendHit = await cf.waitForVisible(resendSelectors, 20000, { abortController });
            if (!resendHit) throw new Error('Tombol Resend tidak muncul di modal (verifikasi gagal/tidak terkirim).');

            console.log(`✅ [Browser] Email verifikasi berhasil dikirim untuk ${email} (tombol Resend terdeteksi)!`);
            emailSent = true;
        } catch (err) {
            if (err.message === 'Pendaftaran dihentikan oleh pengguna.') throw err;
            console.log(`\n⚠️ Error saat navigasi/verifikasi email (Percobaan ${verifAttempt}/${maxVerifAttempts}): ${err.message}`);
            await saveErrorScreenshot(cf, email, 'verif');
            if (verifAttempt >= maxVerifAttempts) console.log('Batas maksimal percobaan verifikasi email tercapai.');
            await sleep(2000);
        }
    }
    return emailSent ? 'success' : 'VERIF';
}

async function saveErrorScreenshot(cf, email, tag) {
    try {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const file = path.join(SCREENSHOT_DIR, `debug_error_${tag}_${String(email).split('@')[0]}.png`);
        const buf = await cf.screenshot({ fullPage: true });
        fs.writeFileSync(file, buf);
        console.log(`[Debug] Screenshot disimpan: ${file}`);
    } catch (_) { }
}

// ── CLI mode ─────────────────────────────────────────────────────────────────
async function run() {
    console.log('=== Dropbox Automated Signup Script (camofox) ===');

    const argValue = (name) => {
        const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
        if (!a) return null;
        return a.includes('=') ? a.split('=')[1] : 'true';
    };

    const proxyArg = argValue('proxy') || 'false';
    const proxyType = ['direct', 'warp', 'psiphon', 'socks5'].includes(proxyArg) ? proxyArg : (proxyArg === 'true' ? 'warp' : 'direct');
    const headlessArg = argValue('headless');
    const headless = headlessArg === null ? true : headlessArg !== 'false';

    console.log(`Proxy: ${proxyType.toUpperCase()} | Browser: camofox (headless=${headless}${headless ? '' : ', noVNC http://localhost:' + camofox.NOVNC_PORT})`);

    let url = await askQuestion('Masukkan URL Dropbox (misal: https://www.dropbox.com/register): ');
    if (!url) { url = 'https://www.dropbox.com/register'; console.log(`Menggunakan default URL: ${url}`); }

    const bulkEmailsInput = await askQuestion("Masukkan daftar Email (pisahkan dengan tanda ';' misal: email1@gmail.com;email2@gmail.com): ");
    if (!bulkEmailsInput) { console.error('Error: Alamat email wajib diisi!'); return; }
    const emails = bulkEmailsInput.split(';').map((e) => e.trim()).filter((e) => e.length > 0);
    if (emails.length === 0) { console.error('Error: Tidak ada email valid yang ditemukan!'); return; }

    console.log(`\nDitemukan ${emails.length} email yang akan didaftarkan.`);

    for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        console.log(`\n--- Memproses email ke-${i + 1} dari ${emails.length} ---`);

        let ok = false;
        let attempts = 0;
        const maxAttempts = 3;
        let current = proxyType;
        while (!ok && attempts < maxAttempts) {
            attempts++;
            if (attempts > 1 && proxyType !== 'direct') {
                console.log(`\n[Mencoba Kembali] ${email} dengan IP keluar baru (Percobaan ${attempts}/${maxAttempts})...`);
                if (proxyType === 'warp') global.warpRotateNext = true;
            }
            try {
                const result = await registerSingleEmail(url, email, current, '', null, headless, 'random', '', 60, 120, '', 3, attempts > 1, { warpPort: parseInt(process.env.WARP_PORT || '40000', 10) });
                ok = !!result;
            } catch (error) {
                console.log(`\n⚠️ Kesalahan registrasi: ${error.message}`);
                const msg = error.message || '';
                // Akun sudah dibuat dan sesi masih login: ulangi HANYA langkah
                // menghubungkan perangkat, jangan mulai dari awal.
                if (msg.startsWith('DEVICE_CONNECT_FAILED')) {
                    try {
                        const resumed = await retryDeviceConnect();
                        ok = !!(resumed && resumed.success);
                    } catch (resumeError) {
                        console.log(`\n⚠️ Pengulangan device connect gagal: ${resumeError.message}`);
                        await closeBrowserSession();
                    }
                    continue;
                }
                const lower = msg.toLowerCase();
                const tooMany = ['too many attempts', 'please try later', 'terlalu banyak percobaan'].some((k) => lower.includes(k));
                const connection = ['net::err', 'timeout', 'connection', 'proxy', 'tunnel'].some((k) => lower.includes(k));
                if (!((tooMany || (proxyType !== 'direct' && connection)) && attempts < maxAttempts)) {
                    console.log('Batas percobaan tercapai atau kesalahan permanen. Melewati email ini.');
                    break;
                }
            }
        }
    }

    await stopEverything();
    console.log('\nSemua email telah diproses. Script selesai.');
}

if (require.main === module) {
    run().catch((e) => { console.error(e); process.exitCode = 1; });
} else {
    module.exports = {
        registerSingleEmail,
        retryDeviceConnect,
        getRandomName,
        getSelectors,
        loadSelectors,
        stopEverything,
        closeBrowserSession,
        killDropboxDaemon,
        daemonStatus,
    };
}
