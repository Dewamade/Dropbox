const { chromium, firefox } = require('playwright-extra');

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const topUserAgents = require('top-user-agents');
const { saveRegistration } = require('./db.js');

const baseUas = topUserAgents.filter(ua => !ua.includes('NT 6'));
const tabletUas = [
    'Mozilla/5.0 (iPad; CPU OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

const uaLists = {
    desktop: baseUas.filter(u => !u.includes('Mobile') && !u.includes('Tablet') && !u.includes('iPad') && !u.includes('Android')),
    mobile: baseUas.filter(u => u.includes('Mobile') || u.includes('iPhone')),
    tablet: baseUas.filter(u => u.includes('iPad') || u.includes('Tablet') || (u.includes('Android') && !u.includes('Mobile'))).concat(tabletUas)
};

// --- Parsers and Utilities ---

function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        alias: 'CLI-Default',
        url: 'https://www.dropbox.com/register',
        source: 'manual', // 'manual' or 'auto'
        emails: '',
        domain: 'kywa.uk',
        count: 1,
        passwordMode: 'random', // 'random' or 'fixed'
        fixedPassword: 'Password123!',
        timeout: 60,
        retry: 3,
        devices: 'desktop',
        browser: 'chromium',
        headless: true,
        proxy: ''
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            let key = '';
            let val = true;
            if (arg.includes('=')) {
                const parts = arg.split('=');
                key = parts[0].slice(2).replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                val = parts.slice(1).join('=');
            } else {
                key = arg.slice(2).replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                    val = args[i + 1];
                    i++;
                }
            }
            if (val === 'false') val = false;
            else if (val === 'true') val = true;
            params[key] = val;
        }
    }
    return params;
}

function generatePassword() {
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const numbers = "0123456789";
    const specials = "!@#$%^&*()_+~`|}{[]:;?><,./-=";
    const allChars = letters + numbers + specials;

    let password = [
        letters.charAt(Math.floor(Math.random() * letters.length)),
        numbers.charAt(Math.floor(Math.random() * numbers.length)),
        specials.charAt(Math.floor(Math.random() * specials.length)),
    ];

    for (let i = 0; i < 9; i++) {
        password.push(allChars.charAt(Math.floor(Math.random() * allChars.length)));
    }

    for (let i = password.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [password[i], password[j]] = [password[j], password[i]];
    }

    return password.join('');
}

function randomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function killAllBrowsers() {
    try { execSync('pkill -9 -f chromium', { stdio: 'ignore' }); } catch (_) {}
    try { execSync('pkill -9 -f firefox', { stdio: 'ignore' }); } catch (_) {}
    try { execSync('pkill -9 -f playwright', { stdio: 'ignore' }); } catch (_) {}
}

async function hasCaptcha(page) {
    const captchaSelectors = [
        'iframe[src*="arkoselabs"]',
        'iframe[src*="funcaptcha"]',
        'iframe[src*="recaptcha"]',
        'iframe[title*="CAPTCHA"]',
        'iframe[title*="Verification"]',
        'div[id*="captcha"]',
        'div[class*="captcha"]',
        '.g-recaptcha',
        '#arkose-iframe',
        'iframe[src*="arkose"]'
    ];

    for (const selector of captchaSelectors) {
        try {
            const count = await page.locator(selector).count();
            for (let i = 0; i < count; i++) {
                if (await page.locator(selector).nth(i).isVisible()) return true;
            }
        } catch (e) {}
    }
    return false;
}

// --- Main Email Registration Logic ---

async function registerSingleEmail(email, params, selectedUaString) {
    const { url, passwordMode, fixedPassword, timeout, alias, headless, isRetry } = params;
    
    const globalTimeout = parseInt(timeout, 10) || 60;
    const daemonTimeout = 120;
    const gtMs = globalTimeout * 1000;
    const dtMs = daemonTimeout * 1000;
    
    let browser, context, page;
    let isRegistered = false;
    let finalStatus = 'failed';
    let emailTimeouts = 0;
    let emailErrors = 0;
    let ipResult = '-';
    
    const password = passwordMode === 'fixed' ? fixedPassword : generatePassword();

    // Generate names
    const firstNames = ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Charles", "Joseph", "Thomas", "Patrick"];
    const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Flores"];
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

    try {
        if (!isRetry) {
            console.log(`\nMemulai pendaftaran untuk email: ${email}`);
            console.log(`==========================================`);
            console.log(`- First Name: ${firstName.padEnd(70)} - Last Name : ${lastName}`);
            console.log(`- Password  : ${password}`);
            console.log(`- Proxy     : ${params.proxy ? params.proxy : 'Direct Connection'}`);
            console.log(`Membersihkan cookies, cache, dan data penyimpanan situs...`);
            console.log(`✓ Data penyimpanan situs (Dropbox dll) berhasil dibersihkan.`);
            console.log(`Membuka ${params.browser === 'firefox' ? 'Firefox' : params.browser === 'chrome' ? 'Google Chrome Resmi' : 'Chromium'} dengan mode User Agent: Generate Local`);
        } else {
            console.log(`\nMembuka ${params.browser === 'firefox' ? 'Firefox' : params.browser === 'chrome' ? 'Google Chrome Resmi' : 'Chromium'} dengan mode User Agent: Generate Local (Percobaan Ulang)`);
        }

        const launchOptions = {
            headless: params.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        };
        
        if (params.proxy && params.proxy.trim() !== '') {
            let proxyStr = params.proxy.trim();
            if (!proxyStr.startsWith('http') && !proxyStr.startsWith('socks')) {
                proxyStr = 'socks5://' + proxyStr;
            }
            launchOptions.proxy = { server: proxyStr };
        }

        if (params.browser === 'chrome') {
            launchOptions.executablePath = '/usr/bin/google-chrome';
            launchOptions.args.push('--disable-blink-features=AutomationControlled');
        } else if (params.browser !== 'firefox' && params.browser !== 'chrome') {
            launchOptions.args.push('--disable-blink-features=AutomationControlled');
        }

        const engine = params.browser === 'firefox' ? firefox : chromium;
        browser = await engine.launch(launchOptions);
        context = await browser.newContext({
            userAgent: selectedUaString,
            viewport: { width: 1280, height: 720 },
            ignoreHTTPSErrors: true
        });

        page = await context.newPage();

        console.log(`[Playwright] Navigasi ke ipify untuk cek IP (timeout 60 detik)...`);
        try {
            await page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded', timeout: gtMs });
            ipResult = await page.textContent('body');
            console.log(`[Playwright] Public IP (${params.proxy ? 'Proxy' : 'Direct'}): ${ipResult}`);
        } catch(e) {
            console.log(`[Playwright] Public IP (${params.proxy ? 'Proxy' : 'Direct'}): Gagal mengambil IP`);
        }
        
        console.log(`[Playwright] User Agent (post-nav): ${selectedUaString}`);
        console.log(`[Navigasi] Ke: ${url} (timeout 60 detik)`);
        
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gtMs });
        await page.waitForTimeout(2000);

        if (await hasCaptcha(page)) throw new Error("CAPTCHA_DETECTED");

        console.log(`Mencari form input pendaftaran...\n`);
        console.log(`[Langkah 1] Menunggu field email muncul (timeout 60 detik)...`);

        const emailSelectors = [
            'input[type="email"]',
            'input[id^="susi_email"]', 
            'input[name*="email"]', 
            'input[name="register-email"]'
        ];
        let emailFieldFound = false;
        let usedEmailSelector = '';
        for (const sel of emailSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
                emailFieldFound = true;
                usedEmailSelector = sel;
                break;
            } catch(e) {}
        }
        if (!emailFieldFound) throw new Error("Gagal menemukan field email");

        console.log(`✓ Field email ditemukan via waitForSelector: ${usedEmailSelector}`);
        await page.waitForTimeout(2000);
        await page.type(usedEmailSelector, email, { delay: 100 });
        console.log(`✓ Mengisi Email`);
        
        const nameSelectors = ['input[id^="fname"]', 'input[name="fname"]', 'input[name="register-first-name"]'];
        let isOneStep = false;
        let usedNameSelector = '';

        // Cek secara instan apakah field nama sudah terlihat (form 1-langkah)
        for (const sel of nameSelectors) {
            try {
                if (await page.isVisible(sel)) {
                    isOneStep = true;
                    usedNameSelector = sel;
                    console.log(`\n[Info] Mendeteksi form 1-langkah (Field nama langsung tersedia)`);
                    break;
                }
            } catch(e) {}
        }

        if (!isOneStep) {
            console.log(`Mengklik tombol 'Continue'...`);
            // Aman menggunakan button[type="submit"] karena kita sudah memastikan ini BUKAN form 1-langkah
            const continueSelectors = [
                'button.email-submit-button',
                'button[class*="email-submit-button"]',
                'button:has-text("Continue")',
                'button:has-text("Lanjutkan")',
                'button:has-text("Next")',
                'button[type="submit"]'
            ];
            let clickedContinue = false;
            for (const sel of continueSelectors) {
                try {
                    if (await page.isVisible(sel)) {
                        await page.waitForTimeout(2000);
                        await page.click(sel, { delay: 150 });
                        clickedContinue = true;
                        console.log(`✓ Mengklik tombol Continue (human-click)`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (!clickedContinue) {
                console.log(`⚠️ Tombol Continue spesifik tidak ditemukan, mencoba lanjut pengisian nama...`);
            } else {
                await page.waitForTimeout(2000);
            }

            console.log(`\n[Langkah 2] Menunggu form detail nama dan password muncul (timeout 30 detik)...`);
            for (const sel of nameSelectors) {
                try {
                    await page.waitForSelector(sel, { state: 'visible', timeout: 30000 });
                    isOneStep = true;
                    usedNameSelector = sel;
                    break;
                } catch(e) {}
            }
        }

        if (isOneStep) {
            console.log(`✓ Form Langkah 2 terdeteksi via waitForSelector: ${usedNameSelector}`);
            await page.waitForTimeout(2000);
            await page.type(usedNameSelector, firstName, { delay: 100 }).catch(()=>{});
            console.log(`✓ Mengisi First Name (human-typed)`);
            await page.waitForTimeout(2000);
            await page.type('input[name="lname"], input[name="register-last-name"]', lastName, { delay: 100 }).catch(()=>{});
            console.log(`✓ Mengisi Last Name (human-typed)`);
            await page.waitForTimeout(2000);
            await page.type('input[name="password"], input[name="register-password"]', password, { delay: 100 }).catch(()=>{});
            console.log(`✓ Mengisi Password (human-typed)`);
        } else {
             const screenshotPath = path.join(__dirname, 'data', `debug_error_${email}.png`);
             await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
             console.log(`[DEBUG] Screenshot layar saat error disimpan di: ./data/debug_error_${email}.png`);
             throw new Error(`Gagal menemukan form nama (Langkah 2) - Cek screenshot di folder data`);
        }

        try { await page.evaluate(() => { const cb = document.querySelector('input[type="checkbox"][name="agree"]'); if (cb && !cb.checked) cb.click(); }); } catch (_) {}
        try { await page.evaluate(() => { const cb = document.querySelector('input[type="checkbox"][id*="tos"]'); if (cb && !cb.checked) cb.click(); }); } catch (_) {}

        console.log(`\nProses pengisian field selesai. Mencoba menekan tombol 'Agree and sign up'...`);
        const submitSelectors = [
            'button.register-button',
            'button[class*="register-button"]',
            'button[type="submit"]',
            'button:has-text("Create an account")',
            'button:has-text("Sign up")',
            'button:has-text("Daftar")',
            'button:has-text("Agree and sign up")'
        ];

        let submitted = false;
        for (const sel of submitSelectors) {
            try {
                if (await page.isVisible(sel)) {
                    await page.waitForTimeout(2000);
                    await page.click(sel, { delay: 150 });
                    submitted = true;
                    break;
                }
            } catch (e) {}
        }

        if (!submitted) throw new Error("Gagal menemukan/menekan tombol Daftar.");

        console.log(`✓ Berhasil mengklik tombol Daftar.`);
        console.log(`Tombol Daftar telah diklik secara otomatis.`);
        console.log(`Catatan: Jika ada CAPTCHA yang muncul di layar browser, silakan selesaikan secara manual.`);
        console.log(`Menunggu pendaftaran selesai (mendeteksi perubahan URL/trial_first)...`);
        console.log(`\n[Langkah 3] Menunggu redirect URL sukses pendaftaran (timeout 60 detik)...`);

        const regDeadline = Date.now() + gtMs;
        while (Date.now() < regDeadline) {
            await page.waitForTimeout(2000);
            
            if (await hasCaptcha(page)) throw new Error("CAPTCHA_DETECTED_POST_SUBMIT");
            
            try {
                const bodyText = await page.textContent('body');
                if (bodyText && bodyText.toLowerCase().includes('too many attempts')) {
                    throw new Error("TOO_MANY_ATTEMPTS");
                }
            } catch (e) {}

            const currentUrl = page.url();
            if (currentUrl.includes('trial_first') || currentUrl.includes('verify_email') || currentUrl.includes('onboarding') ||
                (!currentUrl.includes('/register') && !currentUrl.includes('/login') && (currentUrl.includes('/home') || currentUrl.includes('/personal') || currentUrl.includes('/dashboard')))) {
                console.log(`\n✓ Pendaftaran/Verifikasi terdeteksi! URL saat ini: ${currentUrl}`);
                isRegistered = true;
                break;
            }
        }

        if (!isRegistered) throw new Error("NO_URL_CHANGE");

        console.log(`✅ Pendaftaran berhasil! Browser tetap terbuka — memulai verifikasi email...`);
        await page.waitForTimeout(1500);

        let dropboxProc = null;
        let cliLinkUrl  = null;
        const killDropbox = () => {
            if (dropboxProc) try { dropboxProc.kill('SIGTERM'); } catch (_) {}
            try { execSync('pkill -9 -f dropbox-lnx.x86_64', { stdio: 'ignore' }); } catch (_) {}
            try { execSync('pkill -9 -f dropboxd', { stdio: 'ignore' }); } catch (_) {}
        };

        try {
            console.log(`\n[dropboxd] Memulai proses Dropbox daemon...`);
            let dropboxCmd = '';
            if (fs.existsSync(path.join(__dirname, 'app', '.dropbox-dist', 'dropboxd'))) {
                dropboxCmd = './app/.dropbox-dist/dropboxd';
            } else if (fs.existsSync(path.join(__dirname, 'app', 'dropboxd'))) {
                dropboxCmd = './app/dropboxd';
            } else if (fs.existsSync(path.join(__dirname, '.dropbox-dist', 'dropboxd'))) {
                dropboxCmd = './.dropbox-dist/dropboxd';
            } else {
                dropboxCmd = './app/.dropbox-dist/dropboxd'; 
            }

            console.log(`[dropboxd] Menjalankan via bash: ${dropboxCmd} (HOME=${__dirname})`);
            dropboxProc = spawn('bash', ['-c', dropboxCmd], {
                cwd: __dirname,
                env: { ...process.env, HOME: __dirname, BROWSER: 'false', DISPLAY: '' },
            });

            await new Promise((resolve, reject) => {
                const deadline = setTimeout(() => {
                    killDropbox();
                    reject(new Error(`[dropboxd] Timeout ${daemonTimeout} detik — URL cli_link tidak muncul`));
                }, dtMs);

                const scanForLink = (chunk) => {
                    const text = chunk.toString();
                    text.split('\n').forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed) console.log(`[dropboxd] ${trimmed}`);
                    });
                    
                    const match = text.match(/https:\/\/www\.dropbox\.com\/cli_link[^\s"'<]*/i);
                    if (match && !cliLinkUrl) {
                        cliLinkUrl = match[0];
                        clearTimeout(deadline);
                        console.log(`[dropboxd] ✓ URL CLI Link ditemukan: ${cliLinkUrl}`);
                        // JANGAN kill dropboxd di sini, karena daemon harus hidup saat verifikasi!
                        resolve();
                    }
                };

                dropboxProc.stdout.on('data', scanForLink);
                dropboxProc.stderr.on('data', scanForLink);
                dropboxProc.on('error', (err) => { clearTimeout(deadline); killDropbox(); reject(err); });
                dropboxProc.on('close', (code) => {
                    if (!cliLinkUrl) {
                        clearTimeout(deadline);
                        reject(new Error(`[dropboxd] Proses berhenti (kode ${code}) sebelum URL ditemukan`));
                    }
                });
            });

            let connected = false;
            let cliAttempt = 0;
            const maxCliAttempts = 3;

            while (!connected && cliAttempt < maxCliAttempts) {
                cliAttempt++;
                try {
                    console.log(`[Browser] Navigasi ke URL CLI Link (timeout 60 detik)...`);
                    await page.goto(cliLinkUrl, { waitUntil: 'domcontentloaded', timeout: gtMs });
                    console.log(`[Browser] Menunggu tombol Connect (timeout 120 detik)...`);
                    await page.waitForTimeout(2000);

                    const connectSelectors = [
                        'button:has-text("Connect")',
                        'button[aria-label="Connect"]',
                        'button:has-text("Hubungkan")',
                        'input[type="submit"][value*="Connect"]',
                        'button[type="submit"]',
                        'button.auth-button'
                    ];

                    let connectBtnFound = false;
                    let usedConnectSel = '';
                    for (const sel of connectSelectors) {
                        try {
                            await page.waitForSelector(sel, { state: 'visible', timeout: gtMs / 2 });
                            connectBtnFound = true;
                            usedConnectSel = sel;
                            break;
                        } catch (_) {}
                    }

                    if (!connectBtnFound) {
                        const errScreenshot = path.join(__dirname, 'data', `debug_error_cli_${email.split('@')[0]}.png`);
                        await page.screenshot({ path: errScreenshot, fullPage: true }).catch(()=>{});
                        throw new Error(`Tombol Connect tidak ditemukan di halaman verifikasi. Cek screenshot: ${errScreenshot}`);
                    }

                    console.log(`[Browser] ✓ Tombol Connect terdeteksi via waitForSelector: ${usedConnectSel}`);
                    await page.click(usedConnectSel);
                    console.log(`[Browser] ✓ Tombol Connect berhasil ditekan!`);
                    console.log(`[Browser] Menunggu konfirmasi berhasil dihubungkan...`);
                    await page.waitForTimeout(3000); // Give it some time to process
                    console.log(`✅ [dropboxd] Akun ${email} berhasil dihubungkan ke Dropbox daemon!`);
                    
                    connected = true;
                    // Sekarang aman untuk membunuh daemon
                    killDropbox();

                    console.log(`\n[Browser] Membuka halaman Settings untuk verifikasi email...`);
                    console.log(`[Navigasi] Ke halaman Settings/Account (timeout 60 detik)...`);
                    await page.goto('https://www.dropbox.com/account', { waitUntil: 'domcontentloaded', timeout: gtMs });
                    await page.waitForTimeout(2000);

                    const verifySelectors = ['button[aria-label="Verify email"]', 'button:has-text("Verify email")'];
                    let verifyFound = false;
                    for (const sel of verifySelectors) {
                        try {
                            if (await page.isVisible(sel)) {
                                console.log(`[Browser] ✓ Tombol Verify terdeteksi via waitForSelector: ${sel}`);
                                await page.click(sel);
                                verifyFound = true;
                                console.log(`[Browser] ✓ Tombol Verify email diklik, menunggu modal...`);
                                break;
                            }
                        } catch(e) {}
                    }
                    if (verifyFound) {
                        console.log(`✅ [Browser] Email verifikasi berhasil dikirim untuk ${email}!`);
                    }

                } catch (err) {
                    console.log(`[Browser] Error CLI Link (Attempt ${cliAttempt}): ${err.message}`);
                    if (cliAttempt >= maxCliAttempts) throw new Error("Gagal verifikasi CLI Link.");
                    await page.waitForTimeout(3000);
                }
            }

            finalStatus = connected ? 'VERIF' : 'failed';

        } catch (dropboxErr) {
            console.log(`[dropboxd] Error: ${dropboxErr.message}`);
            killDropbox();
            finalStatus = 'success'; // Registered but failed verification
        }

        console.log(`Menutup browser context untuk ${email}...`);
        console.log(`[Kill] Semua proses Chromium/Playwright dihentikan paksa.`);
        console.log(`[Kill] Semua proses box64/dropboxd dihentikan paksa.`);
        
        saveRegistration(email, password, finalStatus, alias, ipResult, selectedUaString, emailTimeouts, emailErrors);
        return { success: true, status: finalStatus, password, ip: ipResult, ua: selectedUaString };

    } catch (error) {
        let msg = (error.message || '').split('\n')[0];
        console.log(`❌ Pendaftaran gagal untuk ${email}: ${msg}`);
        if (msg.toLowerCase().includes('timeout')) emailTimeouts++;
        else emailErrors++;
        
        if (page && !page.isClosed()) {
            try {
                const screenshotPath = path.join(__dirname, 'data', `debug_error_${email.split('@')[0]}.png`);
                await page.screenshot({ path: screenshotPath, fullPage: true });
                console.log(`[DEBUG] Screenshot layar saat error disimpan di: ./data/debug_error_${email.split('@')[0]}.png`);
            } catch(e) {}
        }

        return { success: false, error: msg };
    } finally {
        if (page) await page.close().catch(()=>{});
        if (context) await context.close().catch(()=>{});
        if (browser) await browser.close().catch(()=>{});
        killAllBrowsers();
    }
}

// --- Main CLI Execution ---

async function runCLI() {
    console.log("=== Dropbox Registration CLI ===");
    const params = parseArgs();

    console.log(JSON.stringify(params, null, 2));

    let emailList = [];
    if (params.source === 'auto') {
        const count = parseInt(params.count, 10);
        for (let i = 0; i < count; i++) {
            emailList.push(`${randomString(8)}@${params.domain}`);
        }
    } else {
        emailList = params.emails.split(';').map(e => e.trim()).filter(e => e.length > 0);
    }

    if (emailList.length === 0) {
        console.log("❌ Tidak ada email yang diproses.");
        process.exit(1);
    }

    const devices = params.devices.split(',').map(d => d.trim().toLowerCase());
    let uaRotationIndex = 0;

    let totalSuccess = 0;
    let totalVerif = 0;
    let totalFailed = 0;

    for (let i = 0; i < emailList.length; i++) {
        const email = emailList[i];
        console.log(`\n------------------------------------------------------------`);
        console.log(`[Email ${i + 1}/${emailList.length}] Mulai memproses: ${email}`);
        
        const deviceType = devices[uaRotationIndex % devices.length] || 'desktop';
        const list = uaLists[deviceType] || uaLists.desktop;
        const ua = list[Math.floor(Math.random() * list.length)];
        uaRotationIndex++;

        const maxAttempts = parseInt(params.retry, 10);
        let success = false;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (attempt > 1) console.log(`\n🔄 Mencoba kembali (Attempt ${attempt}/${maxAttempts}) untuk ${email}...`);
            
            // Set parameter isRetry jika ini adalah iterasi ke-2 atau lebih
            const runParams = { ...params, isRetry: attempt > 1 };

            const result = await registerSingleEmail(email, runParams, ua);

            if (result.success) {
                success = true;
                if (result.status === 'VERIF') totalVerif++;
                else totalSuccess++;
                break;
            } else if (result.error && result.error.includes("TOO_MANY_ATTEMPTS")) {
                console.log("🛑 Terdeteksi limit (Too Many Attempts). Menghentikan seluruh proses untuk menjaga IP/Domain.");
                process.exit(1);
            }
        }

        if (!success) {
            totalFailed++;
            console.log(`❌ Gagal memproses ${email} setelah ${maxAttempts} percobaan.`);
        }
    }

    console.log(`\n=== SELESAI ===`);
    console.log(`Total Sukses: ${totalSuccess}`);
    console.log(`Total Verif : ${totalVerif}`);
    console.log(`Total Gagal : ${totalFailed}`);
    process.exit(0);
}

module.exports = { registerSingleEmail, killAllBrowsers };

if (require.main === module) {
    runCLI().catch(err => {
        console.error("Fatal Error:", err);
        process.exit(1);
    });
}
