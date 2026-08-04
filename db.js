const path = require('path');
const fs = require('fs');


// Use JSON file as a simple database (no native compilation needed)
// Falls back gracefully

const DB_PATH = path.join(__dirname, 'history.json');
const SELECTOR_PATH = path.join(__dirname, 'selector.json');

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
            // TIMEOUT & RETRY
            globalTimeout: 30000,
            globalRetry: 2,
            daemonTimeout: 240000,
            // BROWSER & KONEKSI
            useHeadless: true,
            socks5Host: '',
            uaMode: 'extension',
            deviceTypes: '[]',
            useDirect: true,
            useWarp: false,
            useSocks5: false,
            usePsiphon: false,
            psiphonRegions: [],
            // LAIN-LAIN
            idleTimeout: 600,
            debugProxy: false
        },
        selectors: {}
    };
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        return { ...defaults, ...data };
    } catch (e) {
        return defaults;
    }
}

function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

/**
 * Save a registration record
 * @param {string} email
 * @param {string} password
 * @param {string} status - 'success' | 'failed'
 * @param {string} alias - Target alias
 * @param {string} ip - Public IP used
 * @param {string} ua - User Agent used
 * @param {number} timeouts - Number of timeouts
 * @param {number} errors - Number of errors
 */
function saveRegistration(email, password, status, alias, ip, ua, timeouts = 0, errors = 0) {
    const db = loadDB();
    db.registrations.push({
        id: Date.now(),
        email,
        password,
        status,
        alias: alias || '',
        ip: ip || '',
        ua: ua || '',
        timeouts: timeouts || 0,
        errors: errors || 0,
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
