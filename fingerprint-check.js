/**
 * fingerprint-check.js
 * Script untuk mendiagnosis dan memperlihatkan fingerprint browser Playwright
 * yang terlihat oleh server/bot-detector seperti Arkose Labs / Dropbox.
 * 
 * Jalankan dengan: node fingerprint-check.js
 * Setelah browser terbuka, ia akan mencetak hasilnya di konsol.
 */

const { chromium } = require('playwright');

async function run() {
    console.log("=== Playwright Browser Fingerprint Diagnostic Tool ===\n");
    console.log("Membuka browser...");

    const browser = await chromium.launch({
        headless: false,
        args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
        ]
    });

    const context = await browser.newContext({
        viewport: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });

    // Script untuk mengambil semua data fingerprint dari browser
    await context.addInitScript(() => {
        window._fingerprintData = {};
    });

    const page = await context.newPage();

    // Gunakan bot.sannysoft.com untuk visual test, sekaligus kita extract info sendiri
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });

    const fingerprint = await page.evaluate(() => {
        const results = {};

        // 1. navigator.webdriver - DETEKSI UTAMA BOT
        results['navigator.webdriver'] = navigator.webdriver;

        // 2. User-Agent
        results['userAgent'] = navigator.userAgent;

        // 3. Platform
        results['platform'] = navigator.platform;

        // 4. Plugins count (biasanya 0 pada headless/bot)
        results['pluginsLength'] = navigator.plugins.length;
        const pluginNames = [];
        for (let i = 0; i < navigator.plugins.length; i++) {
            pluginNames.push(navigator.plugins[i].name);
        }
        results['pluginNames'] = pluginNames;

        // 5. Languages
        results['languages'] = navigator.languages;
        results['language'] = navigator.language;

        // 6. Hardware Concurrency (CPU cores)
        results['hardwareConcurrency'] = navigator.hardwareConcurrency;

        // 7. Device Memory (GB) - biasanya undefined pada bot
        results['deviceMemory'] = navigator.deviceMemory;

        // 8. DoNotTrack
        results['doNotTrack'] = navigator.doNotTrack;

        // 9. Chrome Object - dipakai bot detector untuk cek apakah Chrome asli
        results['hasWindowChrome'] = typeof window.chrome !== 'undefined';
        results['hasWindowChromeRuntime'] = typeof window.chrome !== 'undefined' && typeof window.chrome.runtime !== 'undefined';

        // 10. Canvas fingerprint - apakah bisa diambil
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 50;
            const ctx = canvas.getContext('2d');
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#f60';
            ctx.fillRect(125, 1, 62, 20);
            ctx.fillStyle = '#069';
            ctx.font = '11pt Arial';
            ctx.fillText('Cwm fjordbank glyphs vext quiz', 2, 15);
            results['canvasFingerprint'] = canvas.toDataURL().substring(0, 80) + '...';
        } catch (e) {
            results['canvasFingerprint'] = 'ERROR: ' + e.message;
        }

        // 11. WebGL Info
        try {
            const gl = document.createElement('canvas').getContext('webgl');
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            results['webGLVendor'] = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
            results['webGLRenderer'] = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        } catch (e) {
            results['webGL'] = 'ERROR: ' + e.message;
        }

        // 12. Screen Dimensions
        results['screenWidth'] = screen.width;
        results['screenHeight'] = screen.height;
        results['screenColorDepth'] = screen.colorDepth;
        results['screenPixelDepth'] = screen.pixelDepth;
        results['outerWidth'] = window.outerWidth;
        results['outerHeight'] = window.outerHeight;
        results['devicePixelRatio'] = window.devicePixelRatio;

        // 13. Timezone
        results['timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
        results['timezoneOffset'] = new Date().getTimezoneOffset();

        // 14. Max Touch Points (biasanya 0 pada non-mobile)
        results['maxTouchPoints'] = navigator.maxTouchPoints;

        // 15. Connection Info (Network type)
        if (navigator.connection) {
            results['connectionType'] = navigator.connection.effectiveType;
            results['connectionRtt'] = navigator.connection.rtt;
        } else {
            results['connectionInfo'] = 'navigator.connection not available';
        }

        // 16. Permissions API
        results['permissionsApiAvailable'] = typeof navigator.permissions !== 'undefined';

        // 17. Cek Chrome CDP (Chrome DevTools Protocol) - sering dipakai untuk deteksi bot
        results['hasAutomationProperty'] = Object.prototype.toString.call(window.__selenium_unwrapped) !== '[object Undefined]' ||
                                            Object.prototype.toString.call(window.__webdriver_script_fn) !== '[object Undefined]';

        // 18. JS Memory
        if (window.performance && window.performance.memory) {
            results['jsHeapSizeLimitMB'] = Math.round(window.performance.memory.jsHeapSizeLimit / 1048576);
        }

        return results;
    });

    console.log("\n============================================================");
    console.log("HASIL FINGERPRINT BROWSER:");
    console.log("============================================================\n");

    const criticalIssues = [];
    const warnings = [];

    for (const [key, value] of Object.entries(fingerprint)) {
        const display = JSON.stringify(value);
        console.log(`  ${key.padEnd(35)}: ${display}`);

        // Analisis item kritis
        if (key === 'navigator.webdriver' && value === true) {
            criticalIssues.push('❌ navigator.webdriver = true  → TERDETEKSI SEBAGAI BOT!');
        }
        if (key === 'navigator.webdriver' && value === undefined) {
            console.log(`    ✓ webdriver tidak terdeteksi`);
        }
        if (key === 'pluginsLength' && value === 0) {
            warnings.push('⚠️  Plugins = 0  → Tidak natural, browser asli biasanya punya 2-5 plugin');
        }
        if (key === 'hasWindowChrome' && value === false) {
            criticalIssues.push('❌ window.chrome tidak ada → Bot detector akan mendeteksi ini!');
        }
        if (key === 'deviceMemory' && (value === undefined || value === null)) {
            warnings.push('⚠️  deviceMemory tidak tersedia → Fingerprint terlihat aneh');
        }
        if (key === 'hardwareConcurrency' && (value === undefined || value === 0)) {
            warnings.push('⚠️  hardwareConcurrency = 0 → Sangat tidak natural');
        }
    }

    console.log("\n============================================================");
    console.log("ANALISIS RISIKO:");
    console.log("============================================================");

    if (criticalIssues.length > 0) {
        console.log("\n[KRITIS] Isu berikut PASTI terdeteksi sebagai bot:");
        criticalIssues.forEach(i => console.log("  " + i));
    } else {
        console.log("\n✅ Tidak ada isu kritis yang langsung terdeteksi.");
    }

    if (warnings.length > 0) {
        console.log("\n[PERINGATAN] Isu berikut berpotensi meningkatkan kecurigaan:");
        warnings.forEach(w => console.log("  " + w));
    }

    console.log("\n============================================================");
    console.log("FAKTOR TRACKING DROPBOX (ARKOSE LABS):");
    console.log("============================================================");
    console.log(` IP Address         : ⚠️  Dropbox/Arkose PASTI melacak IP Anda!`);
    console.log(`                      Banyak registrasi dari 1 IP = "too many attempts".`);
    console.log(`                      SOLUSI: Gunakan proxy/VPN yang berbeda per email.`);
    console.log(` Mouse Movement     : Dropbox menganalisis pola gerakan mouse.`);
    console.log(`                      Bot tidak bergerak seperti manusia.`);
    console.log(`                      SOLUSI: Tambah simulasi gerakan mouse.`);
    console.log(` Timing / Speed     : Pengisian form terlalu cepat → dicurigai bot.`);
    console.log(`                      SOLUSI: Tambah delay acak antar keystroke.`);
    console.log(` Browser Context    : Setiap context baru = fingerprint berbeda.`);
    console.log(`                      Ini sudah diterapkan di script utama. ✓`);
    console.log(` Cookies / Session  : Context baru = cookie bersih setiap kali. ✓`);
    console.log(` Canvas Fingerprint : Sudah ada noise di script utama. ✓`);

    // Lakukan juga tes di halaman bot-checking
    console.log("\n============================================================");
    console.log("Membuka halaman uji bot (bot.sannysoft.com)...");
    console.log("Perhatikan hasil yang muncul di browser (hijau = lolos, merah = terdeteksi)");
    console.log("============================================================\n");
    
    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    console.log("Halaman bot.sannysoft.com terbuka.");
    console.log("Lihat hasilnya di browser. Tekan Ctrl+C di terminal untuk keluar.\n");

    await new Promise(resolve => {
        page.on('close', resolve);
    });

    await browser.close();
}

run().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
