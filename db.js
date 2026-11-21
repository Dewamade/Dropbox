const path = require('path');
const fs = require('fs');


// Use JSON file as a simple database (no native compilation needed)
// Falls back gracefully

const DB_PATH = path.join(__dirname, 'history.json');
const SELECTOR_PATH = path.join(__dirname, 'selector.json');

// Isi awal katalog selector, dibaca langsung dari selector.json (TIDAK lewat
// getSelectors/saveSelectors supaya tidak rekursif lewat loadDB).
// Tanpa seed ini, history.json pertama berisi "selectors": {} dan register.js diam-diam
// memakai daftar fallback yang hardcoded di dalam kode: katalog — satu-satunya tempat
// DOM Dropbox bisa diperbaiki tanpa mengubah kode — baru terisi setelah seseorang
// menekan Reset di tab Selector. Persis itu yang terjadi pada deployment pertama.
function selectorsSeed() {
    try {
        if (fs.existsSync(SELECTOR_PATH)) {
            return JSON.parse(fs.readFileSync(SELECTOR_PATH, 'utf8'));
        }
    } catch (e) {
        // Katalog rusak: kosong berarti fallback in-code yang bekerja, jangan mati total.
    }
    return {};
}

function loadDB() {
    const defaults = {
        registrations: [],
        settings: {
            // TARGET
            aliasWorker: '',
            urlDropbox: '',
            // EMAIL
            emailSource: 'auto',
            domainEmail: '',
            count: 8,
            // PASSWORD
            passwordMode: 'fixed',
            fixedPassword: '',
            // TIMEOUT & RETRY (detik)
            globalTimeout: 30,
            globalRetry: 2,
            daemonTimeout: 120,
            // BROWSER & KONEKSI
            useHeadless: true,
            warpPort: 40000,
            // Satu jalur proxy saja: 'none' | 'warp' | 'psiphon'.
            // useDirect true  -> percobaan 1 selalu Direct, sisanya jalur ini.
            // useDirect false -> semua percobaan (termasuk pertama) lewat proxy;
            //                    tidak berlaku kalau proxyMode 'none'.
            proxyMode: 'warp',
            useDirect: true,
            psiphonRegions: [],
            // LAIN-LAIN
            idleTimeout: 600,
            debugProxy: false,
            // Live preview: default mati, sama dengan checkbox di UI (tanpa field ini
            // GET /api/settings mengembalikan undefined, jadi kontraknya tidak lengkap).
            enablePreview: false
        },
        selectors: {}
    };
    if (!fs.existsSync(DB_PATH)) {
        defaults.selectors = selectorsSeed();
        fs.writeFileSync(DB_PATH, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        const db = { ...defaults, ...data };
        // history.json lama atau buatan tangan tanpa katalog: isi dari selector.json
        // dan tulis sekali ke disk, supaya register.js (yang membaca katalog dari file
        // ini) melihat catalog yang sama dengan tab Selector.
        if (!db.selectors || Object.keys(db.selectors).length === 0) {
            const seed = selectorsSeed();
            if (Object.keys(seed).length > 0) {
                db.selectors = seed;
                fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
            }
        }
        return db;
    } catch (e) {
        // File rusak: jangan ditimpa (data user), tapi katalog tetap ikut di-seed.
        defaults.selectors = selectorsSeed();
        return defaults;
    }
}

function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

/**
 * Save a registration record (satu record = satu percobaan penuh atas satu email)
 * @param {object} rec
 * @param {string} rec.email
 * @param {string} rec.password
 * @param {string} rec.status - 'success' | 'VERIF' (akun jadi) | 'failed'
 * @param {string} rec.alias - Target alias
 * @param {string} rec.ip - IP keluar yang berhasil dipakai (kosong saat gagal)
 * @param {string} rec.connection - jalur keluar percobaan itu: 'direct' | 'warp' | 'psiphon'
 * @param {string} [rec.failClass] - untuk status 'failed': 'limit' | 'error'
 */
function saveRegistration({ email, password, status, alias = '', ip = '', connection = '', failClass = '' }) {
    const db = loadDB();
    db.registrations.push({
        id: Date.now(),
        email,
        password,
        status,
        alias,
        ip,
        connection,
        ...(status === 'failed' ? { failClass: failClass || 'error' } : {}),
        timestamp: new Date().toISOString()
    });
    saveDB(db);
}

/**
 * Get all registration records, newest first
 */
function getAllRegistrations() {
    const db = loadDB();
    return (db.registrations || []).slice().reverse();
}

/**
 * Clear all registration records (preserves settings and selectors)
 */
function clearRegistrations() {
    const db = loadDB();
    db.registrations = [];
    saveDB(db);
}

/**
 * Get selectors config from history.json
 */
function getSelectors() {
    const db = loadDB();
    return db.selectors || {};
}

/**
 * Save selectors config to history.json
 */
function saveSelectors(selectors) {
    const db = loadDB();
    db.selectors = selectors;
    saveDB(db);
}

/**
 * Reset selectors to defaults (sync from selector.json)
 */
function resetSelectors() {
    try {
        if (fs.existsSync(SELECTOR_PATH)) {
            const defaults = JSON.parse(fs.readFileSync(SELECTOR_PATH, 'utf8'));
            saveSelectors(defaults);
        } else {
            saveSelectors({});
        }
    } catch (e) {
        saveSelectors({});
    }
}

/**
 * Get application settings (full)
 */
function getSettingsFull() {
    const db = loadDB();
    return db.settings || {};
}

/**
 * Save application settings (full)
 */
function saveSettingsFull(settings) {
    const db = loadDB();
    db.settings = settings;
    saveDB(db);
}

module.exports = {
    saveRegistration,
    getAllRegistrations,
    clearRegistrations,
    getSettingsFull,
    saveSettingsFull,
    getSettings: getSettingsFull,   // backward compat alias
    saveSettings: saveSettingsFull,  // backward compat alias
    getSelectors,
    saveSelectors,
    resetSelectors
};
