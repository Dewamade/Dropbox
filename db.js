const path = require('path');
const fs = require('fs');


// Use JSON file as a simple database (no native compilation needed)
// Falls back gracefully

const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}
const DB_PATH = path.join(DB_DIR, 'history.json');

function loadDB() {
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify({ registrations: [] }, null, 2));
    }
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        return { registrations: [] };
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
 * Clear all registration records
 */
function clearRegistrations() {
    saveDB({ registrations: [] });
}

module.exports = { saveRegistration, getAllRegistrations, clearRegistrations };
