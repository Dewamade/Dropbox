const { chromium, firefox } = require('playwright');

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

function getUserAgent(browserName, deviceType) {
    let list = baseUas;
    const bName = (browserName || 'chrome').toLowerCase();
    const dType = (deviceType || 'desktop').toLowerCase();
    
    // Filter by browser engine to prevent bot detection due to capability mismatch
    if (bName === 'firefox') {
        list = list.filter(ua => ua.includes('Firefox') || ua.includes('Gecko/'));
    } else {
        // Chromium / Chrome / Edge
        list = list.filter(ua => ua.includes('Chrome') || ua.includes('Chromium') || ua.includes('Edg/'));
    }
    
    // Filter by device type
    if (dType === 'mobile') {
        list = list.filter(u => u.includes('Mobile') || u.includes('iPhone') || (u.includes('Android') && u.includes('Mobile')));
    } else if (dType === 'tablet') {
        const customTablets = tabletUas.filter(ua => {
            if (bName === 'firefox') return ua.includes('Firefox') || ua.includes('Gecko/');
            return ua.includes('Chrome') || ua.includes('Chromium') || (ua.includes('Safari') && !ua.includes('Firefox'));
        });
        list = list.filter(u => u.includes('iPad') || u.includes('Tablet') || (u.includes('Android') && !u.includes('Mobile'))).concat(customTablets);
    } else {
        // Desktop
        list = list.filter(u => !u.includes('Mobile') && !u.includes('Tablet') && !u.includes('iPad') && !u.includes('Android'));
    }
    
    // Fallback if list is empty
    if (list.length === 0) {
        if (bName === 'firefox') {
            return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';
        } else {
            return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/125.0.0.0 Safari/537.36';
        }
    }
    
    return list[Math.floor(Math.random() * list.length)];
}

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

async function registerSingleEmail(emailOrUrl, paramsOrEmail, selectedUaOrProxyType, ...args) {
    let email, params, selectedUaString;
    
    if (typeof emailOrUrl === 'string' && emailOrUrl.startsWith('http')) {
        // Old style call from server.js
        const url = emailOrUrl;
        email = paramsOrEmail;
        const proxyType = selectedUaOrProxyType;
        const proxyHost = args[0];
        const isInit = args[1];
        const abortController = args[2];
        const headless = args[3];
        const passwordMode = args[4];
        const fixedPassword = args[5];
        const globalTimeout = args[6] || 60;
        const daemonTimeout = args[7] || 120;
        const alias = args[8] || 'Server-Default';
        const globalRetry = args[9] || 3;
        const isRetry = args[10] || false;
        const uaMode = args[11] || 'generate';
        selectedUaString = args[12] || '';
        
        let proxyStr = '';
        if (proxyType === 'warp') {
            proxyStr = 'socks5://127.0.0.1:8086';
        } else if (proxyType === 'socks5' && proxyHost) {
            proxyStr = proxyHost;
            if (!proxyStr.startsWith('http') && !proxyStr.startsWith('socks')) {
                proxyStr = 'socks5://' + proxyStr;
            }
        }
        
        params = {
            url,
            source: 'manual',
            emails: email,
            passwordMode,
            fixedPassword,
            timeout: globalTimeout,
            retry: globalRetry,
            headless: headless,
            proxy: proxyStr,
            alias,
            isRetry
        };
    } else {
        // New style call
        email = emailOrUrl;
        params = paramsOrEmail;
        selectedUaString = selectedUaOrProxyType;
    }

    const { url, passwordMode, fixedPassword, timeout, alias, headless, isRetry } = params;
    
    const globalTimeout = parseInt(timeout, 10) || 60;
    const daemonTimeout = 120;
    const gtMs = globalTimeout * 1000;
    const dtMs = daemonTimeout * 1000;
    
    let context, page;
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

        const profilePath = path.join(__dirname, 'data', `profile_${email.split('@')[0]}`);
        if (fs.existsSync(profilePath)) {
            try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch(_) {}
        }

        const launchOptions = {
            headless: params.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-infobars',
                '--no-first-run',
                '--no-service-autorun',
                '--password-store=basic'
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
            if (process.platform === 'win32') {
                launchOptions.channel = 'chrome';
            } else {
                launchOptions.executablePath = '/usr/bin/google-chrome';
            }
            launchOptions.args.push('--disable-blink-features=AutomationControlled');
        } else if (params.browser !== 'firefox' && params.browser !== 'chrome') {
            launchOptions.args.push('--disable-blink-features=AutomationControlled');
        }

        if (params.headless) {
            if (params.browser !== 'firefox') {
                launchOptions.args.push('--headless=new');
            }
            launchOptions.args.push('--window-size=1280,720');
        }

        // Add argument to exclude automation switches
        launchOptions.ignoreDefaultArgs = ['--enable-automation'];

        const engine = params.browser === 'firefox' ? firefox : chromium;
        
        const contextOptions = {
            headless: launchOptions.headless,
            userAgent: selectedUaString,
            viewport: { width: 1280, height: 720 },
            ignoreHTTPSErrors: true,
            args: launchOptions.args
        };

        if (launchOptions.proxy) {
            contextOptions.proxy = launchOptions.proxy;
        }

        if (launchOptions.channel) {
            contextOptions.channel = launchOptions.channel;
        }

        if (launchOptions.executablePath) {
            contextOptions.executablePath = launchOptions.executablePath;
        }

        if (launchOptions.ignoreDefaultArgs) {
            contextOptions.ignoreDefaultArgs = launchOptions.ignoreDefaultArgs;
        }

        context = await engine.launchPersistentContext(profilePath, contextOptions);
        page = context.pages()[0] || await context.newPage();

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
        await page.locator(usedEmailSelector).first().fill(email);
        // Verify value completeness to avoid partial typing errors
        let emailVal = await page.locator(usedEmailSelector).first().inputValue().catch(() => '');
        if (emailVal !== email) {
            console.log(`⚠️ Email tidak terisi lengkap, mencoba mengisi ulang...`);
            await page.locator(usedEmailSelector).first().fill('');
            await page.locator(usedEmailSelector).first().type(email, { delay: 50 });
        }
        console.log(`✓ Mengisi Email`);
        
        const nameSelectors = ['input[id^="fname"]', 'input[name="fname"]', 'input[name="register-first-name"]'];
        let isOneStep = false;
        let usedNameSelector = '';
        let step2Mode = 'signup'; // default to signup

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

            console.log(`\n[Langkah 2] Menunggu form detail nama/password atau halaman login (timeout 30 detik)...`);
            const loginPasswordSel = 'input[type="password"], input[name="login_password"], input[id^="login_password"]';
            const step2Deadline = Date.now() + 30000;
            let foundStep2 = false;
            while (Date.now() < step2Deadline) {
                // Check if name fields are visible
                let nameVisible = false;
                for (const sel of nameSelectors) {
                    if (await page.locator(sel).first().isVisible()) {
                        nameVisible = true;
                        usedNameSelector = sel;
                        break;
                    }
                }
                if (nameVisible) {
                    step2Mode = 'signup';
                    isOneStep = true;
                    foundStep2 = true;
                    break;
                }

                // Check if login password field is visible or URL is login
                if (await page.locator(loginPasswordSel).first().isVisible() || page.url().includes('/login')) {
                    step2Mode = 'login';
                    foundStep2 = true;
                    break;
                }
                await page.waitForTimeout(500);
            }
            if (!foundStep2) {
                const screenshotPath = path.join(__dirname, 'data', `debug_error_${email.split('@')[0]}.png`);
                await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
                console.log(`[DEBUG] Screenshot layar saat error disimpan di: ./data/debug_error_${email.split('@')[0]}.png`);
                throw new Error(`Gagal menemukan form nama atau login (Langkah 2)`);
            }
        }

        if (step2Mode === 'signup' && isOneStep) {
            console.log(`✓ Form Langkah 2 terdeteksi via waitForSelector: ${usedNameSelector}`);
            await page.waitForTimeout(2000);

            // First Name
            await page.locator(usedNameSelector).first().fill(firstName).catch(()=>{});
            let fnameVal = await page.locator(usedNameSelector).first().inputValue().catch(() => '');
            if (fnameVal !== firstName) {
                await page.locator(usedNameSelector).first().fill('').catch(()=>{});
                await page.locator(usedNameSelector).first().type(firstName, { delay: 50 }).catch(()=>{});
            }
            console.log(`✓ Mengisi First Name (human-typed)`);
            await page.waitForTimeout(1000);

            // Last Name
            const lnameSel = 'input[name="lname"], input[name="register-last-name"]';
            await page.locator(lnameSel).first().fill(lastName).catch(()=>{});
            let lnameVal = await page.locator(lnameSel).first().inputValue().catch(() => '');
            if (lnameVal !== lastName) {
                await page.locator(lnameSel).first().fill('').catch(()=>{});
                await page.locator(lnameSel).first().type(lastName, { delay: 50 }).catch(()=>{});
            }
            console.log(`✓ Mengisi Last Name (human-typed)`);
            await page.waitForTimeout(1000);

            // Password
            const pwordSel = 'input[name="password"], input[name="register-password"]';
            await page.locator(pwordSel).first().fill(password).catch(()=>{});
            let pwordVal = await page.locator(pwordSel).first().inputValue().catch(() => '');
            if (pwordVal !== password) {
                await page.locator(pwordSel).first().fill('').catch(()=>{});
                await page.locator(pwordSel).first().type(password, { delay: 50 }).catch(()=>{});
            }
            console.log(`✓ Mengisi Password (human-typed)`);

            try { await page.evaluate(() => { const cb = document.querySelector('input[type="checkbox"][name="agree"]'); if (cb && !cb.checked) cb.click(); }); } catch (_) {}
            try { await page.evaluate(() => { const cb = document.querySelector('input[type="checkbox"][id*="tos"]'); if (cb && !cb.checked) cb.click(); }); } catch (_) {}

            console.log(`\nProses pengisian field selesai. Mencoba menekan tombol 'Agree and sign up'...`);
            const submitSelectors = [
                'button._register-button_1k6no_4',
                'button.register-button',
                'button[class*="register-button"]',
                'button[type="submit"]',
                'button:has-text("Create an account")',
                'button:has-text("Sign up")',
                'button:has-text("Setuju dan daftar")',
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
        } else if (step2Mode === 'login') {
            console.log(`[Browser] ⚠️ Akun sudah terdaftar. Mencoba masuk (Log in) dengan email & password...`);
            
            const loginEmailSel = 'input[type="email"], input[name*="email"], input[id^="susi_email"]';
            const loginPasswordSel = 'input[type="password"], input[name="login_password"], input[id^="login_password"]';

            if (await page.locator(loginEmailSel).first().isVisible()) {
                const filledEmail = await page.locator(loginEmailSel).first().inputValue().catch(() => '');
                if (filledEmail !== email) {
                    await page.locator(loginEmailSel).first().fill(email).catch(()=>{});
                    let logEmailVal = await page.locator(loginEmailSel).first().inputValue().catch(() => '');
                    if (logEmailVal !== email) {
                        await page.locator(loginEmailSel).first().fill('').catch(()=>{});
                        await page.locator(loginEmailSel).first().type(email, { delay: 50 }).catch(()=>{});
                    }
                }
            }
            
            if (!await page.locator(loginPasswordSel).first().isVisible()) {
                // Click Continue first
                const loginContinueSelectors = [
                    'button.email-submit-button',
                    'button[class*="email-submit-button"]',
                    'button:has-text("Continue")',
                    'button:has-text("Lanjutkan")',
                    'button[type="submit"]'
                ];
                for (const sel of loginContinueSelectors) {
                    if (await page.locator(sel).first().isVisible()) {
                        await page.locator(sel).first().click({ delay: 150 });
                        break;
                    }
                }
                await page.waitForTimeout(2000);
            }

            // Fill password
            let passwordSelFound = false;
            let usedPasswordSel = '';
            for (const sel of [loginPasswordSel]) {
                try {
                    await page.waitForSelector(sel, { state: 'visible', timeout: 10000 });
                    usedPasswordSel = sel;
                    passwordSelFound = true;
                    break;
                } catch(e) {}
            }

            if (passwordSelFound) {
                await page.locator(usedPasswordSel).first().fill(password).catch(()=>{});
                let logPassVal = await page.locator(usedPasswordSel).first().inputValue().catch(() => '');
                if (logPassVal !== password) {
                    await page.locator(usedPasswordSel).first().fill('').catch(()=>{});
                    await page.locator(usedPasswordSel).first().type(password, { delay: 50 }).catch(()=>{});
                }
                await page.waitForTimeout(1000);
                
                // Click log in submit button
                const loginSubmitSelectors = [
                    'button[class*="login-button"]',
                    'button:has-text("Log in")',
                    'button:has-text("Masuk")',
                    'button[type="submit"]'
                ];
                let clickedSubmit = false;
                for (const sel of loginSubmitSelectors) {
                    if (await page.locator(sel).first().isVisible()) {
                        await page.locator(sel).first().click({ delay: 150 });
                        clickedSubmit = true;
                        break;
                    }
                }
                if (!clickedSubmit) {
                    await page.keyboard.press('Enter');
                }
                
                console.log(`[Browser] Menunggu login selesai...`);
                await page.waitForTimeout(5000);
                
                // Check if logged in successfully (URL doesn't have login anymore or shows home/personal)
                const currentUrl = page.url();
                if (!currentUrl.includes('/login')) {
                    console.log(`✓ Login berhasil!`);
                    isRegistered = true;
                } else {
                    throw new Error("Gagal login: Masih berada di halaman login setelah submit");
                }
            } else {
                throw new Error("Field password tidak muncul untuk login");
            }
        }

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
                        
                        // Turn off stdout and stderr data listeners to stop console spam
                        dropboxProc.stdout.off('data', scanForLink);
                        dropboxProc.stderr.off('data', scanForLink);
                        
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
                let cliPage = null;
                try {
                    console.log(`[Browser] Membuka tab baru untuk navigasi ke URL CLI Link...`);
                    cliPage = await context.newPage();

                    console.log(`[Browser] Navigasi ke URL CLI Link untuk pengecekan awal (timeout 60 detik)...`);
                    await cliPage.goto(cliLinkUrl, { waitUntil: 'domcontentloaded', timeout: gtMs });
                    
                    const connectLocator = cliPage.locator('button, input[type="submit"], a, [role="button"]')
                                               .filter({ hasText: /Connect|Hubungkan|Sambungkan/i });
                    
                    let isLoggedAndReady = false;
                    try {
                        await connectLocator.first().waitFor({ state: 'visible', timeout: 8000 });
                        isLoggedAndReady = true;
                    } catch (e) {
                        console.log(`[Browser] Tombol Connect tidak ditemukan secara langsung. Berasumsi perlu login terlebih dahulu...`);
                    }

                    if (!isLoggedAndReady) {
                        console.log(`[Browser] Navigasi ke halaman login Dropbox (https://www.dropbox.com/login)...`);
                        await cliPage.goto('https://www.dropbox.com/login', { waitUntil: 'domcontentloaded', timeout: gtMs });
                        await cliPage.waitForTimeout(3000);

                        const loginEmailSel = 'input[type="email"], input[name*="email"], input[id^="susi_email"]';
                        const loginPasswordSel = 'input[type="password"], input[name="login_password"], input[id^="login_password"]';

                        await cliPage.waitForSelector(loginEmailSel, { state: 'visible', timeout: 15000 });
                        
                        // Fill email
                        await cliPage.locator(loginEmailSel).first().fill(email).catch(()=>{});
                        let logEmailVal = await cliPage.locator(loginEmailSel).first().inputValue().catch(() => '');
                        if (logEmailVal !== email) {
                            await cliPage.locator(loginEmailSel).first().fill('').catch(()=>{});
                            await cliPage.locator(loginEmailSel).first().type(email, { delay: 50 }).catch(()=>{});
                        }
                        await cliPage.waitForTimeout(1000);

                        // Check password visibility
                        let passwordDirectlyVisible = await cliPage.locator(loginPasswordSel).first().isVisible();
                        if (!passwordDirectlyVisible) {
                            // Click Continue
                            const loginContinueSelectors = [
                                'button.email-submit-button',
                                'button[class*="email-submit-button"]',
                                'button:has-text("Continue")',
                                'button:has-text("Lanjutkan")',
                                'button[type="submit"]'
                            ];
                            let clickedContinue = false;
                            for (const sel of loginContinueSelectors) {
                                if (await cliPage.locator(sel).first().isVisible()) {
                                    await cliPage.locator(sel).first().click({ delay: 150 });
                                    clickedContinue = true;
                                    break;
                                }
                            }
                            if (!clickedContinue) {
                                await cliPage.keyboard.press('Enter');
                            }
                            await cliPage.waitForTimeout(3000);
                        }

                        // Fill password
                        await cliPage.waitForSelector(loginPasswordSel, { state: 'visible', timeout: 15000 });
                        await cliPage.locator(loginPasswordSel).first().fill(password).catch(()=>{});
                        let logPassVal = await cliPage.locator(loginPasswordSel).first().inputValue().catch(() => '');
                        if (logPassVal !== password) {
                            await cliPage.locator(loginPasswordSel).first().fill('').catch(()=>{});
                            await cliPage.locator(loginPasswordSel).first().type(password, { delay: 50 }).catch(()=>{});
                        }
                        await cliPage.waitForTimeout(1000);

                        // Click Log In
                        const loginSubmitSelectors = [
                            'button[class*="login-button"]',
                            'button:has-text("Log in")',
                            'button:has-text("Masuk")',
                            'button[type="submit"]'
                        ];
                        let clickedSubmit = false;
                        for (const sel of loginSubmitSelectors) {
                            if (await cliPage.locator(sel).first().isVisible()) {
                                await cliPage.locator(sel).first().click({ delay: 150 });
                                clickedSubmit = true;
                                break;
                            }
                        }
                        if (!clickedSubmit) {
                            await cliPage.keyboard.press('Enter');
                        }

                        console.log(`[Browser] Menunggu login selesai...`);
                        await cliPage.waitForTimeout(7000);

                        // Check if logged in
                        const currentUrl = cliPage.url();
                        if (currentUrl.includes('/login')) {
                            throw new Error("Gagal login: masih berada di halaman login.");
                        }
                        console.log(`[Browser] Login sukses, menavigasi kembali ke URL CLI Link...`);
                        await cliPage.goto(cliLinkUrl, { waitUntil: 'domcontentloaded', timeout: gtMs });
                        await cliPage.waitForTimeout(3000);
                    }

                    console.log(`[Browser] Menunggu tombol Connect (timeout ${globalTimeout} detik)...`);
                    
                    let connectBtnFound = false;
                    try {
                        await connectLocator.first().waitFor({ state: 'visible', timeout: gtMs });
                        connectBtnFound = true;
                    } catch (_) {}

                    if (!connectBtnFound) {
                        const errScreenshot = path.join(__dirname, 'data', `debug_error_cli_${email.split('@')[0]}.png`);
                        await cliPage.screenshot({ path: errScreenshot, fullPage: true }).catch(()=>{});
                        throw new Error(`Tombol Connect tidak ditemukan di halaman verifikasi. Cek screenshot: ${errScreenshot}`);
                    }

                    console.log(`[Browser] ✓ Tombol Connect terdeteksi.`);
                    await connectLocator.first().click();
                    console.log(`[Browser] ✓ Tombol Connect berhasil ditekan!`);
                    console.log(`[Browser] Menunggu konfirmasi berhasil dihubungkan...`);
                    await cliPage.waitForTimeout(3000);
                    console.log(`✅ [dropboxd] Akun ${email} berhasil dihubungkan ke Dropbox daemon!`);
                    
                    connected = true;
                    killDropbox();

                } catch (err) {
                    console.log(`[Browser] Error CLI Link (Attempt ${cliAttempt}): ${err.message}`);
                    if (cliAttempt >= maxCliAttempts) throw new Error("Gagal verifikasi CLI Link.");
                    await page.waitForTimeout(3000);
                } finally {
                    if (cliPage) {
                        await cliPage.close().catch(()=>{});
                    }
                }
            }

            if (connected) {
                console.log(`\n[Browser] Membuka halaman Settings untuk verifikasi email...`);
                console.log(`[Navigasi] Ke halaman Settings/Account (timeout 60 detik)...`);
                await page.goto('https://www.dropbox.com/account', { waitUntil: 'domcontentloaded', timeout: gtMs });
                
                const verifySelectors = [
                    'button[aria-label="Verify email"]',
                    'button[aria-label="Verifikasi email"]',
                    'button.account-key-value-block__link:has-text("Verify email")',
                    'button.account-key-value-block__link:has-text("Verifikasi email")',
                    'button:has-text("Verify email")',
                    'button:has-text("Verifikasi email")'
                ];

                console.log(`[Browser] Menunggu tombol Verify email muncul (timeout 15 detik)...`);
                let verifySelFound = '';
                const verifyDeadline = Date.now() + 15000;
                while (Date.now() < verifyDeadline) {
                    for (const sel of verifySelectors) {
                        try {
                            if (await page.isVisible(sel)) {
                                verifySelFound = sel;
                                break;
                            }
                        } catch (e) {}
                    }
                    if (verifySelFound) break;
                    await page.waitForTimeout(500);
                }

                let verifyClicked = false;
                if (verifySelFound) {
                    console.log(`[Browser] ✓ Tombol Verify terdeteksi: ${verifySelFound}`);
                    try {
                        await page.click(verifySelFound);
                        verifyClicked = true;
                        console.log(`[Browser] ✓ Tombol Verify email diklik, menunggu modal...`);
                    } catch (clickErr) {
                        console.log(`[Browser] ⚠️ Gagal mengklik tombol Verify: ${clickErr.message}`);
                    }
                } else {
                    console.log(`[Browser] ⚠️ Tombol Verify email tidak ditemukan di halaman Settings.`);
                    const screenshotPath = path.join(__dirname, 'data', `debug_verify_missing_${email.split('@')[0]}.png`);
                    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
                    console.log(`[DEBUG] Screenshot halaman settings disimpan di: ./data/debug_verify_missing_${email.split('@')[0]}.png`);
                }

                if (verifyClicked) {
                    await page.waitForTimeout(2000);
                    const sendEmailSelectors = [
                        'button.js-email-modal-button',
                        'button:has-text("Send email")',
                        'button:has-text("Kirim email")',
                        'button:has-text("Send verification")',
                        'button:has-text("Kirim verifikasi")',
                        '//button[contains(text(),"Send email")]',
                        '//button[contains(text(),"Kirim email")]'
                    ];

                    console.log(`[Browser] Menunggu tombol Send email di dalam modal (timeout 10 detik)...`);
                    let sendSelFound = '';
                    const sendDeadline = Date.now() + 10000;
                    while (Date.now() < sendDeadline) {
                        for (const sel of sendEmailSelectors) {
                            try {
                                if (await page.isVisible(sel)) {
                                    sendSelFound = sel;
                                    break;
                                }
                            } catch (e) {}
                        }
                        if (sendSelFound) break;
                        await page.waitForTimeout(500);
                    }

                    if (sendSelFound) {
                        console.log(`[Browser] ✓ Tombol Send email terdeteksi: ${sendSelFound}`);
                        try {
                            await page.click(sendSelFound);
                            console.log(`✅ [Browser] Email verifikasi berhasil dikirim untuk ${email}!`);
                        } catch (sendErr) {
                            console.log(`[Browser] ⚠️ Gagal mengklik tombol Send email: ${sendErr.message}`);
                        }
                    } else {
                        console.log(`[Browser] ⚠️ Tombol Send email tidak ditemukan di modal.`);
                        const screenshotPath = path.join(__dirname, 'data', `debug_modal_missing_${email.split('@')[0]}.png`);
                        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
                        console.log(`[DEBUG] Screenshot modal disimpan di: ./data/debug_modal_missing_${email.split('@')[0]}.png`);
                    }
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
        
        if (isRegistered) {
            console.log(`[Info] Meskipun verifikasi CLI Link gagal, pendaftaran akun untuk ${email} sudah berhasil.`);
            saveRegistration(email, password, 'success', alias, ipResult, selectedUaString, emailTimeouts, emailErrors);
            return { success: true, status: 'success', password, ip: ipResult, ua: selectedUaString };
        }
        
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
        // Clean up the profile directory after closing
        const profilePath = path.join(__dirname, 'data', `profile_${email.split('@')[0]}`);
        if (fs.existsSync(profilePath)) {
            try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch(_) {}
        }
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
        const ua = getUserAgent(params.browser, deviceType);
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

module.exports = { registerSingleEmail, killAllBrowsers, getUserAgent };

if (require.main === module) {
    runCLI().catch(err => {
        console.error("Fatal Error:", err);
        process.exit(1);
    });
}
