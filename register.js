const { firefox } = require('playwright');
const readline = require('readline');
const https = require('https');
const path = require('path');
const fs = require('fs');
const PROFILE_PATH = path.join(__dirname, 'firefox-profile');

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

// Helper to recursively delete directories
function deleteDirRecursive(dirPath) {
    if (fs.existsSync(dirPath)) {
        try {
            fs.readdirSync(dirPath).forEach((file) => {
                const curPath = path.join(dirPath, file);
                if (fs.lstatSync(curPath).isDirectory()) {
                    deleteDirRecursive(curPath);
                } else {
                    try {
                        fs.unlinkSync(curPath);
                    } catch (e) {}
                }
            });
            fs.rmdirSync(dirPath);
        } catch (e) {}
    }
}

// Function to clear browser cache, cookies, history, and site storage
// while preserving extensions and their settings
function clearProfileData(profilePath) {
    if (!fs.existsSync(profilePath)) return;

    console.log('Membersihkan cookies, cache, dan data penyimpanan situs...');

    // Files to delete (including locks)
    const filesToDelete = [
        'cookies.sqlite',
        'cookies.sqlite-wal',
        'cookies.sqlite-shm',
        'places.sqlite',
        'places.sqlite-wal',
        'places.sqlite-shm',
        'formhistory.sqlite',
        'sessionstore.jsonlz4',
        'permissions.sqlite',
        'content-prefs.sqlite',
        'webappsstore.sqlite',
        'favicons.sqlite',
        'parent.lock',
        'lock',
        '.parentlock'
    ];

    // Directories to delete entirely
    const dirsToDelete = [
        'cache2',
        'sessionstore-backups',
        'startupCache',
        'jumpListCache',
        'entries',
    ];

    // Delete files
    for (const file of filesToDelete) {
        const filePath = path.join(profilePath, file);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {}
    }

    // Delete directories entirely
    for (const dir of dirsToDelete) {
        const dirPath = path.join(profilePath, dir);
        try {
            if (fs.existsSync(dirPath)) {
                deleteDirRecursive(dirPath);
            }
        } catch (e) {}
    }

    // Clean storage default directory while preserving moz-extensions (extension settings)
    const storagePath = path.join(profilePath, 'storage', 'default');
    if (fs.existsSync(storagePath)) {
        try {
            const items = fs.readdirSync(storagePath);
            for (const item of items) {
                if (!item.startsWith('moz-extension+++')) {
                    const itemPath = path.join(storagePath, item);
                    if (fs.lstatSync(itemPath).isDirectory()) {
                        deleteDirRecursive(itemPath);
                    } else {
                        fs.unlinkSync(itemPath);
                    }
                }
            }
            console.log('✓ Data penyimpanan situs (Dropbox dll) berhasil dibersihkan.');
        } catch (e) {}
    }
}

// Single registration process for one email
async function registerSingleEmail(url, email, proxyServer, isInit, abortController, headless, passwordMode, fixedPassword) {
    console.log(`\n==========================================`);
    console.log(`Memulai pendaftaran untuk email: ${email}`);
    if (proxyServer) {
        console.log(`Menggunakan Proxy   : ${proxyServer}`);
    } else {
        console.log(`Menggunakan Proxy   : TIDAK ADA (koneksi langsung)`);
    }
    console.log(`==========================================`);

    const { first: firstName, last: lastName } = getRandomName();
    // Use fixed or random password based on mode
    const password = (passwordMode === 'fixed' && fixedPassword) ? fixedPassword : generatePassword();

    console.log(`- First Name: ${firstName}`);
    console.log(`- Last Name : ${lastName}`);
    console.log(`- Password  : ${password}`);

    const contextOptions = {
        headless: headless !== undefined ? !!headless : false,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        args: [
            '--start-maximized',
        ]
    };

    // Inject proxy into this context if one is available
    if (proxyServer) {
        contextOptions.proxy = { server: proxyServer };
    }

    if (abortController && abortController.shouldStop) {
        throw new Error("Pendaftaran dihentikan oleh pengguna.");
    }

    if (!isInit) {
        // Full clean for normal registration run
        clearProfileData(PROFILE_PATH);
    } else {
        // In initialization mode, only clean lock files to allow configuration retention
        const lockFiles = ['parent.lock', 'lock', '.parentlock'];
        for (const file of lockFiles) {
            const filePath = path.join(PROFILE_PATH, file);
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`✓ Membersihkan file lock profil: ${file}`);
                }
            } catch (e) {}
        }
    }

    console.log(`Membuka Firefox dengan profil persistent: ${PROFILE_PATH}`);
    const context = await firefox.launchPersistentContext(PROFILE_PATH, contextOptions);
    // Grab UA from the Playwright browser instance
    const uaPage = context.pages()[0] || await context.newPage();
    const playwrightUA = await uaPage.evaluate(() => navigator.userAgent);
    console.log(`[Playwright] User Agent: ${playwrightUA}`);
    // Fetch server's public IP (the machine running Playwright)
    const getServerPublicIp = () => {
        return new Promise((resolve) => {
            https.get('https://api.ipify.org?format=json', (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        const ip = JSON.parse(data).ip;
                        resolve(ip);
                    } catch (_) {
                        resolve(null);
                    }
                });
            }).on('error', () => resolve(null));
        });
    };
    const serverIp = await getServerPublicIp();
    if (serverIp) {
        console.log(`[Server] Public IP: ${serverIp}`);
    }

    if (abortController) {
        abortController.abort = async () => {
            try {
                console.log("[Abort] Menutup browser context secara paksa karena perintah berhenti...");
                await context.close();
            } catch (e) {}
        };
        // If stopped while launching, abort immediately
        if (abortController.shouldStop) {
            await abortController.abort();
            throw new Error("Pendaftaran dihentikan oleh pengguna.");
        }
    }
    
    if (isInit) {
        console.log("\n========================================================");
        console.log("MODE INISIALISASI AKTIF (-init=true)");
        console.log("Silakan pasang ekstensi dan lakukan konfigurasi secara manual.");
        console.log("Tutup jendela browser Firefox setelah Anda selesai untuk melanjutkan.");
        console.log("========================================================\n");
        
        await new Promise(resolve => {
            context.on('close', resolve);
        });
        return true;
    }

    // Clear cookies for this session to ensure a clean registration session
    await context.clearCookies();

    // Advanced evasions to make browser tracking significantly harder
    await context.addInitScript(() => {
        // 1. Evade navigator.webdriver
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}

        // 2. Mock Plugins list (biasanya 0 pada headless/bot)
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

        // 3. Override permissions API
        try {
            const originalQuery = navigator.permissions.query;
            navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters);
        } catch (e) {}
    });

    // launchPersistentContext secara bawaan sudah membuka 1 halaman kosong.
    // Kita gunakan halaman pertama yang sudah terbuka agar tidak meluncurkan 2 jendela browser.
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Helper to fill input directly
    async function humanType(selector, text) {
        await page.fill(selector, text);
    }

    // Helper to click directly
    async function humanClick(selector) {
        await page.click(selector);
    }

    try {
        console.log(`Navigasi ke URL: ${url}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await checkTooManyAttempts(page);

        // Clear local/session storage to avoid cross-session tracking
        try {
            await page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
            });
            console.log("✓ Menghapus sisa local/session storage");
        } catch (e) {}

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
        console.log("\n[Langkah 1] Menunggu field email muncul (timeout 60 detik)...");
        const emailSelectors = [
            'input[id^="susi_email"]',
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="Email"]'
        ];
        
        let activeEmailSelector = null;
        const startTime = Date.now();
        while (Date.now() - startTime < 60000) {
            for (const selector of emailSelectors) {
                try {
                    const isVisible = await page.locator(selector).first().isVisible();
                    if (isVisible) {
                        activeEmailSelector = selector;
                        break;
                    }
                } catch (e) {}
            }
            if (activeEmailSelector) break;
            await page.waitForTimeout(1000); // Check every 1 second
        }

        if (!activeEmailSelector) {
            throw new Error("Tidak dapat menemukan field Email untuk Langkah 1 dalam 60 detik!");
        }

        await humanType(activeEmailSelector, email);
        console.log("✓ Mengisi Email");

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
            let enterPressed = false;
            for (const selector of emailSelectors) {
                try {
                    if (await page.isVisible(selector)) {
                        await page.locator(selector).press('Enter');
                        enterPressed = true;
                        break;
                    }
                } catch (e) {}
            }
            if (!enterPressed) {
                await page.keyboard.press('Enter');
            }
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
            let enterPressed = false;
            for (const selector of passwordSelectors) {
                try {
                    if (await page.isVisible(selector)) {
                        await page.locator(selector).press('Enter');
                        enterPressed = true;
                        break;
                    }
                } catch (e) {}
            }
            if (!enterPressed) {
                await page.keyboard.press('Enter');
            }
            clickedSubmit = true;
        }

        console.log("\nTombol Daftar telah diklik secara otomatis.");
        console.log("Catatan: Jika ada CAPTCHA yang muncul di layar browser, silakan selesaikan secara manual.");
        console.log("Menunggu pendaftaran selesai (mendeteksi perubahan URL/trial_first)...");

        // Loop to check if the user has successfully registered (max 60 seconds)
        let isRegistered = false;
        for (let i = 0; i < 30; i++) { // Polling up to 60 seconds (2s * 30)
            await page.waitForTimeout(2000);
            await checkTooManyAttempts(page);
            const currentUrl = page.url();
            
            // Check for trial_first, verify_email, or general successful redirection strings
            if (currentUrl.includes('trial_first') || currentUrl.includes('verify_email') || (!currentUrl.includes('/register') && !currentUrl.includes('/login') && (currentUrl.includes('/home') || currentUrl.includes('/personal') || currentUrl.includes('/dashboard') || currentUrl.includes('dropbox.com/h')))) {
                console.log(`\n✓ Pendaftaran/Verifikasi terdeteksi! URL saat ini: ${currentUrl}`);
                isRegistered = true;
                break;
            }
        }

        if (isRegistered) {
            console.log('✅ Pendaftaran berhasil! Browser tetap terbuka — memulai Dropbox daemon...');
            await page.waitForTimeout(1500);

            // ── Spawn dropboxd via bash (avoids ELF header warning) ──────────────
            const { spawn, execSync } = require('child_process');
            const homeDir = process.env.HOME || '/root';
            let dropboxProc = null;
            let cliLinkUrl  = null;

            const killDropbox = () => {
                if (dropboxProc) {
                    try { dropboxProc.kill('SIGTERM'); } catch (_) {}
                }
                try {
                    execSync('pkill -9 -f dropbox-lnx.x86_64', { stdio: 'ignore' });
                    console.log('[dropboxd] ✓ Proses dropbox lama berhasil dihentikan (pkill).');
                } catch (_) {}
            };

            try {
                console.log(`[dropboxd] Menjalankan via bash: box64 ./.dropbox-dist/dropboxd (HOME=${homeDir})`);
                dropboxProc = spawn('bash', ['-c', 'box64 ./.dropbox-dist/dropboxd'], {
                    cwd: homeDir,
                    env: { ...process.env, HOME: homeDir },
                });

                // Wait up to 120 s for a CLI link URL in the daemon output
                await new Promise((resolve, reject) => {
                    const deadline = setTimeout(() => {
                        reject(new Error('[dropboxd] Timeout 120 detik — URL cli_link tidak muncul'));
                    }, 120000);

                    const scanForLink = (chunk) => {
                        const text = chunk.toString();
                        text.split('\n').forEach(line => {
                            if (line.trim()) console.log(`[dropboxd] ${line.trim()}`);
                        });
                        const match = text.match(/https:\/\/www\.dropbox\.com\/cli_link[^\s"'<]*/i);
                        if (match && !cliLinkUrl) {
                            cliLinkUrl = match[0];
                            clearTimeout(deadline);
                            resolve();
                        }
                    };

                    dropboxProc.stdout.on('data', scanForLink);
                    dropboxProc.stderr.on('data', scanForLink);
                    dropboxProc.on('error', (err) => { clearTimeout(deadline); reject(err); });
                    dropboxProc.on('close', (code) => {
                        if (!cliLinkUrl) {
                            clearTimeout(deadline);
                            reject(new Error(`[dropboxd] Proses berhenti (kode ${code}) sebelum URL ditemukan`));
                        }
                    });
                });

                console.log(`[dropboxd] ✓ URL CLI Link ditemukan: ${cliLinkUrl}`);

                // ── Navigate browser to CLI link ──────────────────────────────────
                console.log('[Browser] Navigasi ke URL CLI Link...');
                await page.goto(cliLinkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(2000);

                // ── Wait for Connect button and click it ──────────────────────────
                console.log('[Browser] Menunggu tombol Connect...');
                const connectSelectors = [
                    'button:has-text("Connect")',
                    'button[aria-label="Connect"]',
                    'button:has-text("Hubungkan")',
                    'input[type="submit"][value*="Connect"]',
                    'a:has-text("Connect")',
                ];

                let connected = false;
                const connectDeadline = Date.now() + 60000;
                while (Date.now() < connectDeadline && !connected) {
                    for (const sel of connectSelectors) {
                        try {
                            if (await page.isVisible(sel)) {
                                await page.click(sel);
                                console.log(`[Browser] ✓ Tombol Connect berhasil ditekan!`);
                                connected = true;
                                break;
                            }
                        } catch (e) {}
                    }
                    if (!connected) await page.waitForTimeout(1500);
                }

                if (!connected) {
                    throw new Error('[Browser] Timeout 60 detik — tombol Connect tidak ditemukan');
                }

                // ── Wait for "successfully" confirmation ──────────────────────────
                console.log('[Browser] Menunggu konfirmasi berhasil dihubungkan...');
                const successKeywords = ['successfully', 'berhasil', 'linked', 'connected', 'you can now close'];
                let confirmedSuccess = false;
                const successDeadline = Date.now() + 60000;
                while (Date.now() < successDeadline && !confirmedSuccess) {
                    try {
                        const bodyText = (await page.innerText('body')).toLowerCase();
                        confirmedSuccess = successKeywords.some(kw => bodyText.includes(kw));
                        if (confirmedSuccess) break;
                    } catch (e) {}
                    await page.waitForTimeout(1500);
                }

                if (confirmedSuccess) {
                    console.log(`✅ [dropboxd] Akun ${email} berhasil dihubungkan ke Dropbox daemon!`);
                } else {
                    console.log(`⚠️ [dropboxd] Konfirmasi tidak terdeteksi dalam 60 detik, melanjutkan...`);
                }

                // ── Verify email flow ──────
                console.log('[Browser] Membuka halaman Settings untuk verifikasi email...');
                
                // Direct navigation to settings bypasses the need to click the account menu
                await page.goto('https://www.dropbox.com/account', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(4000);
                
                let settingsOpened = true; // Assume true since we navigated directly

                if (settingsOpened) {
                        await page.waitForTimeout(3000);

                        // Click Verify email button (aria-label="Verify email" or class contains account-key-value-block__link)
                        const verifySelectors = [
                            'button[aria-label="Verify email"]',
                            'button.account-key-value-block__link:has-text("Verify email")',
                            'button:has-text("Verify email")',
                            'button:has-text("Verifikasi email")',
                        ];
                        let verifyClicked = false;
                        for (const sel of verifySelectors) {
                            try {
                                if (await page.isVisible(sel)) {
                                    await page.click(sel);
                                    console.log('[Browser] ✓ Tombol Verify email diklik, menunggu modal...');
                                    verifyClicked = true;
                                    break;
                                }
                            } catch (e) {}
                        }

                        if (verifyClicked) {
                            await page.waitForTimeout(2000);

                            // Click Send email button inside the modal (class contains js-email-modal-button)
                            const sendEmailSelectors = [
                                'button.js-email-modal-button',
                                'button:has-text("Send email")',
                                'button:has-text("Kirim email")',
                            ];
                            let emailSent = false;
                            for (const sel of sendEmailSelectors) {
                                try {
                                    if (await page.isVisible(sel)) {
                                        await page.click(sel);
                                        console.log(`✅ [Browser] Email verifikasi berhasil dikirim untuk ${email}!`);
                                        emailSent = true;
                                        break;
                                    }
                                } catch (e) {}
                            }
                            if (!emailSent) {
                                console.log('[Browser] ⚠️ Tombol Send email tidak ditemukan di modal.');
                            }
                        } else {
                            console.log('[Browser] ⚠️ Tombol Verify email tidak ditemukan di halaman Settings.');
                        }
                    }
                }

                await page.waitForTimeout(1500);

            } finally {
                // Kill daemon + any lingering dropbox processes
                killDropbox();
            }

            return { success: true, password };


        } else {
            console.log('\n⚠️ URL tidak berubah dalam 60 detik setelah menekan tombol daftar.');
            throw new Error('Timeout: URL tidak berubah setelah 60 detik.');
        }

    } catch (error) {
        console.error(`Terjadi error untuk email ${email}:`, error);
        throw error;
    } finally {
        if (abortController) {
            abortController.abort = null;
        }
        // Always close the browser context to clear cookies, session data, and anti-fingerprinting details before the next iteration
        console.log(`Menutup browser context untuk ${email}...`);
        try {
            await context.close();
        } catch (e) {}
    }
}

async function run() {
    console.log("=== Dropbox Automated Signup Script (Bulk Email) ===");

    // Parse command line arguments
    // Mencari argumen seperti -proxy=true atau --proxy=true
    const useProxyArg = process.argv.find(arg => arg.startsWith('-proxy=') || arg.startsWith('--proxy='));
    const useProxy = useProxyArg ? useProxyArg.split('=')[1] === 'true' : false;

    const useInitArg = process.argv.find(arg => arg.startsWith('-init=') || arg.startsWith('--init='));
    const useInit = useInitArg ? useInitArg.split('=')[1] === 'true' : false;

    if (useInit) {
        console.log("Status Inisialisasi: AKTIF");
        await registerSingleEmail("https://www.dropbox.com/register", "init@init.com", null, true);
        console.log("Inisialisasi selesai. Silakan jalankan script kembali tanpa parameter -init.");
        return;
    }

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
    console.log("Memulai proses pendaftaran...");

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
        const maxAttempts = 3; 
        let currentProxy = proxy;

        while (!registrationSuccess && attempts < maxAttempts) {
            attempts++;
            if (attempts > 1) {
                if (useProxy) {
                    console.log(`\n[Mencoba Kembali] Mencoba mendaftarkan ulang ${email} dengan proxy baru (Percobaan ke-${attempts} dari ${maxAttempts})...`);
                    currentProxy = await getProxiflyProxy();
                } else {
                    console.log(`\n[Mencoba Kembali] Mencoba mendaftarkan ulang ${email} (Percobaan ke-${attempts} dari ${maxAttempts})...`);
                }
            }

            try {
                const result = await registerSingleEmail(url, email, currentProxy, false);
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
                    console.log(`Terdeteksi pesan "Too many attempts". Mencoba kembali...`);
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
    console.log("Script selesai dijalankan.");
}

if (require.main === module) {
    run();
} else {
    module.exports = {
        registerSingleEmail,
        getProxiflyProxy,
        PROFILE_PATH
    };
}
