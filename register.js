const { chromium, devices } = require('playwright');
const readline = require('readline');
const https = require('https');

// Helper function to get user input from the console
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

// Helper function to generate a random string/password that meets the criteria:
// - At least 8 characters
// - At least 1 letter (uppercase/lowercase)
// - At least 1 number
// - At least 1 special character
function generatePassword() {
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const numbers = "0123456789";
    const specials = "!@#$%^&*()_+~`|}{[]:;?><,./-=";
    const allChars = letters + numbers + specials;

    // Guarantee at least one of each required type
    let password = [
        letters.charAt(Math.floor(Math.random() * letters.length)),
        numbers.charAt(Math.floor(Math.random() * numbers.length)),
        specials.charAt(Math.floor(Math.random() * specials.length)),
    ];

    // Fill the rest up to 12 characters randomly
    for (let i = 0; i < 9; i++) {
        password.push(allChars.charAt(Math.floor(Math.random() * allChars.length)));
    }

    // Shuffle the array to randomize the positions of the guaranteed characters
    for (let i = password.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [password[i], password[j]] = [password[j], password[i]];
    }

    return password.join('');
}

// Helper function to detect if any CAPTCHA elements are visible on the page
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
            const locators = page.locator(selector);
            const count = await locators.count();
            for (let i = 0; i < count; i++) {
                if (await locators.nth(i).isVisible()) {
                    return true;
                }
            }
        } catch (e) {}
    }
    return false;
}

// Helper function to detect if "Too many attempts" error is displayed
async function checkTooManyAttempts(page) {
    try {
        const textContent = await page.innerText('body');
        const hasError = [
            'too many attempts',
            'please try later',
            'terlalu banyak percobaan',
            'coba lagi nanti'
        ].some(keyword => textContent.toLowerCase().includes(keyword));

        if (hasError) {
            throw new Error("Too many attempts. Please try later.");
        }
    } catch (e) {
        if (e.message.includes("Too many attempts")) {
            throw e;
        }
    }
}

// List of emulated mobile devices in Playwright
const MOBILE_DEVICE_NAMES = [
    'iPhone 12',
    'iPhone 13',
    'iPhone 14',
    'iPhone 12 Pro Max',
    'iPhone 13 Pro Max',
    'iPhone 14 Pro Max',
    'Pixel 5',
    'Pixel 7',
    'Galaxy S20',
    'Galaxy S21',
    'Galaxy S22 Ultra'
];

// List of emulated tablet devices in Playwright
const TABLET_DEVICE_NAMES = [
    'iPad Mini',
    'iPad (gen 7)',
    'iPad Pro 11',
    'Galaxy Tab S4'
];

// Helper function to randomize OS and browser versions inside base user agents to keep them highly varied
function randomizeUserAgent(baseUserAgent) {
    let ua = baseUserAgent;

    if (ua.includes('iPhone') || ua.includes('iPad')) {
        // Randomize iOS version (15.0 to 17.5)
        const major = Math.floor(Math.random() * 3) + 15; // 15, 16, 17
        const minor = Math.floor(Math.random() * 6); // 0 to 5
        const iosVer = `${major}_${minor}`;
        const safariVer = `${major}.${minor}`;
        
        ua = ua.replace(/iPhone OS \d+_\d+/, `iPhone OS ${iosVer}`)
               .replace(/CPU OS \d+_\d+/, `CPU OS ${iosVer}`)
               .replace(/Version\/\d+\.\d+(\.\d+)?/, `Version/${safariVer}`);
    } else if (ua.includes('Android')) {
        // Randomize Android version (12 to 14)
        const androidVer = Math.floor(Math.random() * 3) + 12; // 12, 13, 14
        
        // Randomize Chrome version (122 to 125)
        const chromeMajor = Math.floor(Math.random() * 4) + 122; // 122, 123, 124, 125
        const chromeBuild = Math.floor(Math.random() * 100);
        const chromePatch = Math.floor(Math.random() * 150);
        const chromeVer = `${chromeMajor}.0.${6000 + chromeBuild}.${chromePatch}`;
        
        ua = ua.replace(/Android \d+/, `Android ${androidVer}`)
               .replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${chromeVer}`);
    }

    return ua;
}

function getRandomBrowserProfile() {
    const deviceName = 'Galaxy S21';
    // Galaxy S21 tidak terdefinisi secara bawaan di Playwright, sehingga kita buat profilnya secara manual
    const deviceProfile = {
        userAgent: 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        defaultBrowserType: 'chromium'
    };

    const ua = randomizeUserAgent(deviceProfile.userAgent);
    console.log(`Menggunakan Profil Perangkat: ${deviceName}`);
    console.log(`User-Agent: ${ua}`);
    return {
        isMobile: true,
        isTablet: false,
        deviceName: deviceName,
        contextOptions: {
            ...deviceProfile,
            userAgent: ua,
            locale: 'en-US',
            timezoneId: 'America/New_York'
        }
    };
}

// Helper function to generate a natural-looking random name
function getRandomName() {
    const firstNames = [
        "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles",
        "Daniel", "Matthew", "Anthony", "Mark", "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kenneth",
        "Kevin", "Brian", "George", "Edward", "Ronald", "Timothy", "Jason", "Jeffrey", "Ryan", "Jacob",
        "Gary", "Nicholas", "Eric", "Jonathan", "Stephen", "Larry", "Justin", "Scott", "Brandon", "Benjamin",
        "Samuel", "Gregory", "Alexander", "Frank", "Patrick", "Raymond", "Jack", "Dennis", "Jerry", "Tyler",
        "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen",
        "Lisa", "Nancy", "Betty", "Sandra", "Margaret", "Ashley", "Kimberly", "Emily", "Donna", "Michelle",
        "Carol", "Amanda", "Dorothy", "Melissa", "Deborah", "Stephanie", "Rebecca", "Sharon", "Laura", "Cynthia",
        "Kathleen", "Amy", "Shirley", "Angela", "Helen", "Anna", "Brenda", "Pamela", "Nicole", "Emma"
    ];

    const lastNames = [
        "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
        "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
        "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
        "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
        "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts",
        "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker", "Cruz", "Edwards", "Collins", "Reyes",
        "Stewart", "Morris", "Morales", "Murphy", "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper"
    ];

    const first = firstNames[Math.floor(Math.random() * firstNames.length)];
    const last = lastNames[Math.floor(Math.random() * lastNames.length)];
    return { first, last };
}

// Cache untuk menyimpan daftar proxy yang sudah diunduh (hindari fetch berulang)
let _proxyListCache = null;

// Helper function to fetch proxy list from Proxifly GitHub SG proxy list
async function getProxiflyProxy() {
    return new Promise((resolve) => {
        // Gunakan cache jika sudah tersedia dan masih ada proxy yang belum dipakai
        if (_proxyListCache && _proxyListCache.length > 0) {
            // Ambil proxy pertama dari cache (sudah di-shuffle), lalu hapus dari daftar
            const proxyObj = _proxyListCache.shift();
            const proxyStr = proxyObj.proxy; // format: "socks5://ip:port" atau "http://ip:port"
            const anon = proxyObj.anonymity || 'unknown';
            const city = proxyObj.geolocation?.city || 'SG';
            console.log(`✓ Proxy dipilih dari cache: ${proxyStr} [${anon}, ${city}]`);
            return resolve(proxyStr);
        }

        // Fetch segar dari GitHub raw URL
        console.log('Mengunduh daftar proxy SG dari Proxifly GitHub...');
        const options = {
            hostname: 'raw.githubusercontent.com',
            path: '/proxifly/free-proxy-list/main/proxies/countries/SG/data.json',
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; node-https/1.0)'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    let parsed = JSON.parse(data);
                    if (!Array.isArray(parsed) || parsed.length === 0) {
                        console.log('⚠️  Daftar proxy SG kosong atau format tidak valid, lanjut tanpa proxy.');
                        return resolve(null);
                    }

                    // Saring proxy: hanya mendukung SOCKS5 atau HTTP dengan HTTPS enabled
                    parsed = parsed.filter(p => p.protocol === 'socks5' || (p.protocol === 'http' && p.https === true));
                    console.log(`✓ Berhasil memfilter proxy. Tersisa ${parsed.length} proxy yang mendukung HTTPS.`);

                    if (parsed.length === 0) {
                        console.log('⚠️  Tidak ada proxy SG yang mendukung HTTPS, lanjut tanpa proxy.');
                        return resolve(null);
                    }

                    // Urutkan berdasarkan score tertinggi, lalu acak untuk variasi
                    parsed.sort((a, b) => (b.score || 0) - (a.score || 0));

                    // Shuffle 50% teratas untuk variasi sambil tetap mengutamakan proxy berkualitas
                    const topHalf = parsed.slice(0, Math.ceil(parsed.length / 2));
                    for (let i = topHalf.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [topHalf[i], topHalf[j]] = [topHalf[j], topHalf[i]];
                    }
                    const rest = parsed.slice(Math.ceil(parsed.length / 2));

                    // Simpan ke cache (top half diacak + sisanya)
                    _proxyListCache = [...topHalf, ...rest];

                    console.log(`✓ ${_proxyListCache.length} proxy SG berhasil dimuat.`);

                    // Ambil proxy pertama
                    const proxyObj = _proxyListCache.shift();
                    const proxyStr = proxyObj.proxy;
                    const anon = proxyObj.anonymity || 'unknown';
                    const city = proxyObj.geolocation?.city || 'SG';
                    console.log(`✓ Proxy dipilih: ${proxyStr} [${anon}, ${city}]`);
                    resolve(proxyStr);

                } catch (e) {
                    console.log(`⚠️  Gagal parse daftar proxy SG: ${e.message}, lanjut tanpa proxy.`);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.log(`⚠️  Error mengunduh proxy SG (${e.message}), lanjut tanpa proxy.`);
            resolve(null);
        });

        req.end();
    });
}

// Single registration process for one email
async function registerSingleEmail(url, email, browser, proxyServer) {
    console.log(`\n==========================================`);
    console.log(`Memulai pendaftaran untuk email: ${email}`);
    if (proxyServer) {
        console.log(`Menggunakan Proxy   : ${proxyServer}`);
    } else {
        console.log(`Menggunakan Proxy   : TIDAK ADA (koneksi langsung)`);
    }
    console.log(`==========================================`);

    const { first: firstName, last: lastName } = getRandomName();
    const password = generatePassword();

    console.log(`- First Name: ${firstName}`);
    console.log(`- Last Name : ${lastName}`);
    console.log(`- Password  : ${password}`);

    // Create a new browser context with a random device profile (Mobile/Desktop)
    const profile = getRandomBrowserProfile();
    const contextOptions = { ...profile.contextOptions };

    // Inject proxy into this context if one is available
    if (proxyServer) {
        contextOptions.proxy = { server: proxyServer };
    }

    const context = await browser.newContext(contextOptions);

    const userAgent = contextOptions.userAgent || '';
    const isApple = userAgent.includes('Macintosh') || userAgent.includes('iPhone') || userAgent.includes('iPad');
    const isAndroid = userAgent.includes('Android');
    const isMobileDevice = !!profile.isMobile;

    // Advanced evasions to make browser tracking significantly harder
    await context.addInitScript(({ isApple, isAndroid, isMobileDevice }) => {
        // 1. Evade navigator.webdriver
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}

        // 2. Mock Plugins list (only on desktop to match genuine browsers)
        if (!isMobileDevice) {
            try {
                const pluginData = [
                    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', version: '' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgieooff', description: 'Portable Document Format', version: '' },
                    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', version: '' },
                    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', version: '' },
                ];
                Object.defineProperty(navigator, 'plugins', { get: () => pluginData });
                Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: pluginData[0] }] });
            } catch (e) {}
        } else {
            // Mobile Safari / Chrome has empty or different plugins
            try {
                Object.defineProperty(navigator, 'plugins', { get: () => [] });
                Object.defineProperty(navigator, 'mimeTypes', { get: () => [] });
            } catch (e) {}
        }

        // 3. Obfuscate Canvas fingerprinting (Universal)
        try {
            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function(type) {
                if (type === 'image/png' && this.width === 220 && this.height === 30) {
                    const ctx = this.getContext('2d');
                    const r = Math.floor(Math.random() * 3) - 1;
                    ctx.fillStyle = `rgba(0,0,0,0.0${r})`;
                    ctx.fillRect(0, 0, 1, 1);
                }
                return originalToDataURL.apply(this, arguments);
            };
        } catch (e) {}

        // 4. Custom chrome object presence (Only for Non-Apple desktop / Android browsers)
        if (!isApple) {
            try {
                if (!window.chrome) {
                    window.chrome = {
                        app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
                        runtime: { PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' }, RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' } },
                        loadTimes: function() { return { commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000 }; },
                        csi: function() { return { startE: Date.now(), onloadT: Date.now(), pageT: Date.now() / 1000, tran: 15 }; }
                    };
                }
            } catch (e) {}
        } else {
            // Delete chrome object on Apple devices if somehow injected
            try { delete window.chrome; } catch (e) {}
        }

        // 5. Override permissions API
        try {
            const originalQuery = navigator.permissions.query;
            navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters);
        } catch (e) {}

        // 6. Spoof hardwareConcurrency & deviceMemory
        if (isApple && isMobileDevice) {
            try { Object.defineProperty(navigator, 'deviceMemory', { get: () => undefined }); } catch (e) {}
            try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 6 }); } catch (e) {}
        } else {
            try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 }); } catch (e) {}
            try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }); } catch (e) {}
        }

        // 7. Spoof WebGL Vendor/Renderer to match platform
        try {
            const getParameterOriginal = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
                    return isApple ? 'Apple Inc.' : 'Intel Inc.';
                }
                if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL
                    return isApple ? 'Apple GPU' : 'Intel Iris OpenGL Engine';
                }
                return getParameterOriginal.apply(this, [parameter]);
            };
        } catch (e) {}

        // 8. AudioContext fingerprint noise (Universal)
        try {
            const AudioCtxOrig = window.AudioContext || window.webkitAudioContext;
            if (AudioCtxOrig) {
                const createOscillatorOrig = AudioCtxOrig.prototype.createOscillator;
                AudioCtxOrig.prototype.createOscillator = function() {
                    const osc = createOscillatorOrig.apply(this, arguments);
                    const originalConnect = osc.connect.bind(osc);
                    osc.connect = function(dest) {
                        return originalConnect(dest);
                    };
                    return osc;
                };
            }
        } catch (e) {}

        // 9. Spoof screen dimensions ONLY for desktop (Playwright mobile emulation handles mobile dimensions natively)
        if (!isMobileDevice) {
            try {
                Object.defineProperty(screen, 'width', { get: () => window.innerWidth || 1920 });
                Object.defineProperty(screen, 'height', { get: () => window.innerHeight || 1080 });
                Object.defineProperty(screen, 'availWidth', { get: () => window.innerWidth || 1920 });
                Object.defineProperty(screen, 'availHeight', { get: () => (window.innerHeight - 40) || 1040 });
            } catch (e) {}
        }
    }, { isApple, isAndroid, isMobileDevice });

    const page = await context.newPage();

    // Helper to simulate human-like typing (random delay between each keypress)
    async function humanType(selector, text) {
        await page.click(selector);
        await page.waitForTimeout(200 + Math.random() * 300);
        // Clear any existing value first
        await page.fill(selector, '');
        for (const char of text) {
            await page.type(selector, char, { delay: 80 + Math.random() * 120 });
        }
    }

    // Helper to simulate a random mouse movement before clicking
    async function humanClick(selector) {
        const el = page.locator(selector).first();
        const box = await el.boundingBox();
        if (box) {
            // Move mouse to a random starting position first
            await page.mouse.move(
                Math.random() * 300,
                Math.random() * 300
            );
            await page.waitForTimeout(100 + Math.random() * 200);
            // Move gradually toward the target
            await page.mouse.move(
                box.x + box.width / 2 + (Math.random() * 6 - 3),
                box.y + box.height / 2 + (Math.random() * 6 - 3),
                { steps: 15 + Math.floor(Math.random() * 10) }
            );
            await page.waitForTimeout(80 + Math.random() * 150);
            await page.mouse.click(
                box.x + box.width / 2 + (Math.random() * 4 - 2),
                box.y + box.height / 2 + (Math.random() * 4 - 2)
            );
        } else {
            await el.click();
        }
    }

    try {
        console.log(`Navigasi ke URL: ${url}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await checkTooManyAttempts(page);

        console.log("Mencari form input pendaftaran...");
        // More human-like: random wait before starting
        await page.waitForTimeout(2000 + Math.random() * 2000);

        // Optional: Dismiss cookie banners
        try {
            const cookieBannerButton = page.locator('button:has-text("Accept"), button:has-text("Setuju"), #consent-accept-button');
            if (await cookieBannerButton.isVisible()) {
                await cookieBannerButton.click();
                console.log("✓ Menutup banner cookie");
                await page.waitForTimeout(1000);
            }
        } catch (e) {}

        // --- STEP 1: Fill Email & Click Continue ---
        console.log("\n[Langkah 1] Mengisi email...");
        const emailSelectors = [
            'input[id^="susi_email"]',
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="Email"]'
        ];
        let emailFilled = false;
        for (const selector of emailSelectors) {
            try {
                if (await page.isVisible(selector)) {
                    await humanType(selector, email);
                    emailFilled = true;
                    console.log("✓ Mengisi Email (human-typed)");
                    break;
                }
            } catch (e) {}
        }

        if (!emailFilled) {
            throw new Error("Tidak dapat menemukan field Email untuk Langkah 1!");
        }

        await page.waitForTimeout(500 + Math.random() * 800);

        // Click "Continue" with humanized mouse movement
        console.log("Mengklik tombol 'Continue'...");
        const continueSelectors = [
            'button.email-submit-button',
            'button:has-text("Continue")',
            'button:has-text("Lanjutkan")',
            'button[type="submit"]'
        ];
        let clickedContinue = false;
        for (const selector of continueSelectors) {
            try {
                if (await page.isVisible(selector)) {
                    await humanClick(selector);
                    clickedContinue = true;
                    console.log("✓ Mengklik tombol Continue (human-click)");
                    break;
                }
            } catch (e) {}
        }

        if (!clickedContinue) {
            console.log("Peringatan: Tombol Continue tidak terdeteksi, mencoba menekan Enter...");
            await page.keyboard.press('Enter');
        }

        // Wait for Step 2 fields to load and be visible
        await page.waitForTimeout(2000);
        await checkTooManyAttempts(page);
        console.log("\n[Langkah 2] Menunggu form detail nama dan password muncul...");
        const firstNameSelector = 'input[id^="fname"], input[name="fname"]';
        try {
            await page.waitForSelector(firstNameSelector, { state: 'visible', timeout: 15000 });
            console.log("✓ Form Langkah 2 terdeteksi!");
        } catch (e) {
            console.log("Form Langkah 2 tidak muncul otomatis. Menunggu 5 detik tambahan...");
            await page.waitForTimeout(5000);
        }

        // Fill First Name
        const firstNameSelectors = [
            'input[id^="fname"]',
            'input[name="fname"]',
            'input[autocomplete="given-name"]',
            'input[placeholder*="First name"]',
            'input[placeholder*="Nama depan"]'
        ];
        let firstNameFilled = false;
        for (const selector of firstNameSelectors) {
            try {
                if (await page.isVisible(selector)) {
                    await humanType(selector, firstName);
                    firstNameFilled = true;
                    console.log("✓ Mengisi First Name (human-typed)");
                    break;
                }
            } catch (e) {}
        }

        await page.waitForTimeout(400 + Math.random() * 600);

        // Fill Last Name
        const lastNameSelectors = [
            'input[id^="lname"]',
            'input[name="lname"]',
            'input[autocomplete="family-name"]',
            'input[placeholder*="Last name"]',
            'input[placeholder*="Nama belakang"]'
        ];
        let lastNameFilled = false;
        for (const selector of lastNameSelectors) {
            try {
                if (await page.isVisible(selector)) {
                    await humanType(selector, lastName);
                    lastNameFilled = true;
                    console.log("✓ Mengisi Last Name (human-typed)");
                    break;
                }
            } catch (e) {}
        }

        await page.waitForTimeout(400 + Math.random() * 600);

        // Fill Password
        const passwordSelectors = [
            'input[id^="password"]',
            'input[name="password"]',
            'input[type="password"]',
            'input[placeholder*="Password"]',
            'input[placeholder*="Kata sandi"]'
        ];
        let passwordFilled = false;
        for (const selector of passwordSelectors) {
            try {
                if (await page.isVisible(selector)) {
                    await humanType(selector, password);
                    passwordFilled = true;
                    console.log("✓ Mengisi Password (human-typed)");
                    break;
                }
            } catch (e) {}
        }

        await page.waitForTimeout(600 + Math.random() * 800);

        // Click Agree to Terms Checkbox (if present)
        const checkboxSelectors = [
            'input[type="checkbox"][name="tos_agree"]',
            'input[type="checkbox"]',
            '.agree-checkbox'
        ];
        for (const selector of checkboxSelectors) {
            try {
                if (await page.isVisible(selector)) {
                    const isChecked = await page.isChecked(selector);
                    if (!isChecked) {
                        await humanClick(selector);
                        console.log("✓ Menyetujui syarat dan ketentuan (TOS)");
                        break;
                    }
                }
            } catch (e) {}
        }

        await page.waitForTimeout(1000);

        // Highlight/Focus Agree and Sign Up button
        const submitSelectors = [
            'button._register-button_1k6no_4',
            'button:has-text("Agree and sign up")',
            'button:has-text("Setuju dan daftar")',
            'button[type="submit"]',
            'button:has-text("Sign up")'
        ];
        
        console.log("\nProses pengisian field selesai. Mencoba menekan tombol 'Agree and sign up'...");

        let clickedSubmit = false;
        for (const selector of submitSelectors) {
            try {
                if (await page.isVisible(selector)) {
                    await page.click(selector);
                    clickedSubmit = true;
                    console.log("✓ Berhasil mengklik tombol Daftar.");
                    break;
                }
            } catch (e) {}
        }

        if (!clickedSubmit) {
            console.log("Mencoba mengirimkan form dengan menekan Enter...");
            await page.keyboard.press('Enter');
            clickedSubmit = true;
        }

        console.log("\nTombol Daftar telah diklik secara otomatis.");
        console.log("Catatan: Jika ada CAPTCHA yang muncul di layar browser, silakan selesaikan secara manual.");
        console.log("Menunggu pendaftaran selesai (mendeteksi perubahan URL/trial_first)...");

        // Loop to check if the user has successfully registered
        let isRegistered = false;
        for (let i = 0; i < 90; i++) { // Polling up to 180 seconds (2s * 90)
            await page.waitForTimeout(2000);
            await checkTooManyAttempts(page);
            const currentUrl = page.url();
            
            // Check for trial_first or general successful redirection strings
            if (currentUrl.includes('trial_first') || (!currentUrl.includes('/register') && !currentUrl.includes('/login') && (currentUrl.includes('/home') || currentUrl.includes('/personal') || currentUrl.includes('/dashboard') || currentUrl.includes('dropbox.com/h')))) {
                console.log(`\n✓ Pendaftaran berhasil terdeteksi! URL saat ini: ${currentUrl}`);
                isRegistered = true;
                break;
            }
        }

        if (isRegistered) {
            console.log("Melakukan navigasi otomatis ke halaman Logout...");
            await page.waitForTimeout(2000);
            await page.goto("https://www.dropbox.com/logout", { waitUntil: 'domcontentloaded', timeout: 30000 });
            console.log("✓ Berhasil logout untuk email ini.");
            await page.waitForTimeout(2000);
            return true;
        } else {
            console.log("\nInformasi: Waktu tunggu habis. Registrasi belum selesai atau dialihkan secara manual.");
            // Wait for user to tell the script when they're done or close the page manually if they want
            console.log("Menunggu halaman ditutup atau diselesaikan secara manual oleh pengguna...");
            await new Promise(resolve => {
                const interval = setInterval(async () => {
                    if (page.isClosed()) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 2000);
            });
            return false;
        }

    } catch (error) {
        console.error(`Terjadi error untuk email ${email}:`, error);
        throw error;
    } finally {
        // Always close the browser context to clear cookies, session data, and anti-fingerprinting details before the next iteration
        console.log(`Menutup browser context untuk ${email}...`);
        await context.close();
    }
}

async function run() {
    console.log("=== Dropbox Automated Signup Script (Bulk Email) ===");

    // Parse command line arguments
    // Mencari argumen seperti -proxy=true atau --proxy=true
    const useProxyArg = process.argv.find(arg => arg.startsWith('-proxy=') || arg.startsWith('--proxy='));
    const useProxy = useProxyArg ? useProxyArg.split('=')[1] === 'true' : false;

    if (useProxy) {
        console.log("Status Proxy: AKTIF (Menggunakan rotasi proxy SG dari Proxifly)");
    } else {
        console.log("Status Proxy: NON-AKTIF (Koneksi langsung tanpa proxy)");
    }

    // 1. Get Dropbox URL
    let url = await askQuestion("Masukkan URL Dropbox (misal: https://www.dropbox.com/register): ");
    if (!url) {
        url = "https://www.dropbox.com/register";
        console.log(`Menggunakan default URL: ${url}`);
    }

    // 2. Get Bulk Emails input delimited by ";"
    const bulkEmailsInput = await askQuestion("Masukkan daftar Email (pisahkan dengan tanda ';' misal: email1@gmail.com;email2@gmail.com): ");
    if (!bulkEmailsInput) {
        console.error("Error: Alamat email wajib diisi!");
        return;
    }

    // Parse and filter out empty email entries
    const emails = bulkEmailsInput.split(';')
                                  .map(e => e.trim())
                                  .filter(e => e.length > 0);

    if (emails.length === 0) {
        console.error("Error: Tidak ada email valid yang ditemukan!");
        return;
    }

    console.log(`\nDitemukan ${emails.length} email yang akan didaftarkan.`);
    console.log("Sedang membuka browser...");

    // Launch single browser instance in headed mode
    const browser = await chromium.launch({
        headless: false,
        channel: 'chrome', // Gunakan Google Chrome resmi yang terpasang di Windows
        args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
            '--disable-webrtc', // Menonaktifkan WebRTC agar tidak bocor IP asli
        ]
    });

    // Run registration for each email sequentially
    for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        console.log(`\n---------------------------------------------------------`);
        console.log(`Memproses email ke-${i+1} dari ${emails.length}`);
        console.log(`---------------------------------------------------------`);

        // Fetch a fresh proxy from Proxifly if proxy is enabled
        let proxy = null;
        if (useProxy) {
            console.log('Mengambil proxy baru dari Proxifly...');
            proxy = await getProxiflyProxy();
        }
        
        // Retry logic for proxy errors or "Too many attempts"
        let registrationSuccess = false;
        let attempts = 0;
        const maxAttempts = 3; // Selalu coba sampai 3 kali untuk rotasi user-agent jika terdeteksi 'Too many attempts'
        let currentProxy = proxy;

        while (!registrationSuccess && attempts < maxAttempts) {
            attempts++;
            if (attempts > 1) {
                if (useProxy) {
                    console.log(`\n[Mencoba Kembali] Mencoba mendaftarkan ulang ${email} dengan proxy baru & User-Agent acak (Percobaan ke-${attempts} dari ${maxAttempts})...`);
                    currentProxy = await getProxiflyProxy();
                } else {
                    console.log(`\n[Mencoba Kembali] Mencoba mendaftarkan ulang ${email} dengan rotasi User-Agent/Perangkat baru (Percobaan ke-${attempts} dari ${maxAttempts})...`);
                }
            }

            try {
                const result = await registerSingleEmail(url, email, browser, currentProxy);
                if (result) {
                    registrationSuccess = true;
                } else {
                    console.log(`Pendaftaran untuk ${email} selesai dengan status tidak berhasil (mungkin halaman ditutup/timeout). Tidak mencoba ulang.`);
                    break;
                }
            } catch (error) {
                console.log(`\n⚠️ Terjadi kesalahan saat registrasi: ${error.message}`);
                
                const errorMsg = (error.message || '').toLowerCase();
                const isConnectionError = [
                    'net::err',
                    'timeout',
                    'connection',
                    'proxy',
                    'tunnel'
                ].some(keyword => errorMsg.includes(keyword));

                const isTooManyAttempts = errorMsg.includes('too many attempts') || errorMsg.includes('please try later') || errorMsg.includes('terlalu banyak percobaan') || errorMsg.includes('coba lagi nanti');

                if (isTooManyAttempts && attempts < maxAttempts) {
                    console.log(`Terdeteksi pesan "Too many attempts". Merotasi User-Agent / Profil Browser dan mencoba kembali...`);
                } else if (useProxy && isConnectionError && attempts < maxAttempts) {
                    console.log(`Terdeteksi masalah koneksi/proxy. Mengambil proxy baru dan mencoba kembali...`);
                } else {
                    console.log(`Sudah mencapai batas maksimal percobaan atau kesalahan permanen. Melewati email ini.`);
                    break;
                }
            }
        }
        
        // Anti-tracking delay: Add a random delay between 5 to 15 seconds between registrations
        if (i < emails.length - 1) {
            const delay = Math.floor(Math.random() * 10000) + 5000;
            console.log(`Jeda anti-tracking: Menunggu selama ${(delay/1000).toFixed(1)} detik sebelum memproses email berikutnya...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    console.log("\nSemua email dalam daftar telah diproses.");
    await browser.close();
    console.log("Script selesai dijalankan.");
}

run();
