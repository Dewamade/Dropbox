/**
 * locale — kunci bahasa browser (default en-US) untuk Camoufox.
 *
 * dropbox.com melayani UI sesuai bahasa sesi (pernah muncul "Verifikasikan" /
 * "Lanjutkan"), dan katalog selector + pencocokan teks di register.js berasumsi
 * teks English. Camoufox menentukan bahasa dari `locale:*` di CAMOU_CONFIG
 * (navigator.language, navigator.languages, dan headers.Accept-Language diturunkan
 * dari sana — lihat camoufox-js: handleLocales menulis locale:language/region).
 *
 * Opsi `locale` saat launch TIDAK bisa dipakai dari plugin: camofox sudah
 * membuat CAMOU_CONFIG di buildLaunchOptionsWithGeoipFallback() SEBELUM event
 * 'browser:launching' dilempar, jadi mengubah options.locale di sini tidak
 * berpengaruh. Yang bekerja (sama seperti plugin screen) adalah menulis ulang
 * CAMOU_CONFIG_* di env child.
 *
 * Aktif dari camofox.config.json:
 *   "plugins": { "locale": { "enabled": true, "locale": "en-US" } }
 * Manager menimpanya lewat BROWSER_LOCALE; BROWSER_LOCALE=off (atau nilai tidak
 * valid) = jangan memaksa apa pun, Camoufox/profil bebas seperti biasa.
 */

const DEFAULT_LOCALE = 'en-US';
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})*$/;

// 'en-US' -> { language: 'en', region: 'US' }
function splitLocale(value) {
    const [language, ...rest] = String(value).split('-');
    return { language, region: rest[0] };
}

export function register(app, ctx, settings = {}) {
    const log = ctx.log;
    const requested = process.env.BROWSER_LOCALE ?? settings.locale;
    const locale = String(requested ?? DEFAULT_LOCALE).trim();

    if (locale.toLowerCase() === 'off' || !LOCALE_RE.test(locale)) {
        log('warn', `locale: tidak memaksa bahasa (nilai "${locale}" tidak valid atau off)`);
        return;
    }
    const { language, region } = splitLocale(locale);
    if (!region) {
        log('warn', `locale: butuh bahasa-wilayah (mis. en-US), "${locale}" dilewati`);
        return;
    }

    ctx.events.on('browser:launching', ({ options }) => {
        const env = options.env;
        if (!env) return;
        const names = Object.keys(env)
            .filter((k) => /^CAMOU_CONFIG_\d+$/.test(k))
            .sort((a, b) => Number(a.split('_')[2]) - Number(b.split('_')[2]));
        if (!names.length) {
            log('warn', 'locale: CAMOU_CONFIG tidak ditemukan, bahasa tidak dikunci');
            return;
        }
        let cfg;
        try {
            cfg = JSON.parse(names.map((n) => env[n]).join(''));
        } catch (err) {
            log('warn', 'locale: konfigurasi camoufox tidak terbaca, bahasa tidak dikunci', { error: err.message });
            return;
        }
        for (const k of Object.keys(cfg)) if (/^locale(:|$)/.test(k)) delete cfg[k];
        Object.assign(cfg, {
            'locale:language': language,
            'locale:region': region,
            'locale:all': `${language}-${region}, ${language}`,
        });
        // Chunking yang sama dipakai camoufox-js (nilai env dibatasi ukurannya).
        const chunkSize = process.platform === 'win32' ? 2047 : 32767;
        const json = JSON.stringify(cfg);
        names.forEach((n) => delete env[n]);
        for (let i = 0, part = 1; i < json.length; i += chunkSize, part += 1) {
            env[`CAMOU_CONFIG_${part}`] = json.slice(i, i + chunkSize);
        }
        log('info', 'locale: bahasa browser dikunci', { locale });
    });
}
