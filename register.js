const { chromium } = require('playwright');
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
        devices: 'desktop'
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2).replace(/-([a-z])/g, (g) => g[1].toUpperCase());
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                params[key] = args[i + 1];
                i++;
            } else {
                params[key] = true;
            }
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
    const { url, passwordMode, fixedPassword, timeout, alias } = params;
    const globalTimeout = parseInt(timeout, 10);
    const gtMs = globalTimeout * 1000;
    
    let browser, context, page;
    let isRegistered = false;
    let finalStatus = 'failed';
    let emailTimeouts = 0;
    let emailErrors = 0;
    
    const password = passwordMode === 'fixed' ? fixedPassword : generatePassword();

    try {
        console.log(`\n[Browser] Meluncurkan Chromium untuk ${email} dengan UA: ${selectedUaString}`);
        
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        context = await browser.newContext({
            userAgent: selectedUaString,
            viewport: { width: 1280, height: 720 },
            ignoreHTTPSErrors: true
        });

        page = await context.newPage();

        console.log(`[Browser] Navigasi ke URL pendaftaran: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gtMs });
        await page.waitForTimeout(2000);

        // -- Check CAPTCHA early --
        if (await hasCaptcha(page)) throw new Error("CAPTCHA_DETECTED");

        // -- Fill Registration Form --
        console.log(`[Browser] Mengisi form registrasi...`);
        const firstNames = ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Charles", "Joseph", "Thomas"];
        const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
        
        const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
        const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

        await page.fill('input[name="fname"], input[name="register-first-name"]', firstName, { timeout: 10000 }).catch(()=>{});
        await page.fill('input[name="lname"], input[name="register-last-name"]', lastName, { timeout: 5000 }).catch(()=>{});
        await page.fill('input[name="email"], input[name="register-email"]', email, { timeout: 5000 }).catch(()=>{});
        await page.fill('input[name="password"], input[name="register-password"]', password, { timeout: 5000 }).catch(()=>{});

        // -- Checkboxes --
        try { await page.evaluate(() => { const cb = document.querySelector('input[type="checkbox"][name="agree"]'); if (cb && !cb.checked) cb.click(); }); } catch (_) {}
        try { await page.evaluate(() => { const cb = document.querySelector('input[type="checkbox"][id*="tos"]'); if (cb && !cb.checked) cb.click(); }); } catch (_) {}

        // -- Submit Form --
        console.log(`[Browser] Menekan tombol daftar...`);
        const submitSelectors = [
            'button[type="submit"]',
            'button:has-text("Create an account")',
            'button:has-text("Sign up")',
            'button:has-text("Daftar")',
            'input[type="submit"]'
        ];

        let submitted = false;
        for (const sel of submitSelectors) {
            try {
                if (await page.isVisible(sel)) {
                    await page.click(sel);
                    submitted = true;
                    break;
                }
            } catch (e) {}
        }

        if (!submitted) throw new Error("Gagal menemukan/menekan tombol Daftar.");

        // -- Wait for redirection --
        const regDeadline = Date.now() + gtMs;
        while (Date.now() < regDeadline) {
            await page.waitForTimeout(2000);
            
            // Re-check captcha
            if (await hasCaptcha(page)) throw new Error("CAPTCHA_DETECTED_POST_SUBMIT");
            
            // Check Too Many Attempts
            try {
                const bodyText = await page.textContent('body');
                if (bodyText && bodyText.toLowerCase().includes('too many attempts')) {
                    throw new Error("TOO_MANY_ATTEMPTS");
                }
            } catch (e) {}

            const currentUrl = page.url();
            if (currentUrl.includes('trial_first') || currentUrl.includes('verify_email') || 
                (!currentUrl.includes('/register') && !currentUrl.includes('/login') && (currentUrl.includes('/home') || currentUrl.includes('/personal') || currentUrl.includes('/dashboard')))) {
                console.log(`[Browser] ✓ Pendaftaran/Verifikasi terdeteksi! URL saat ini: ${currentUrl}`);
                isRegistered = true;
                break;
            }
        }

        if (!isRegistered) throw new Error("NO_URL_CHANGE");

        // -- Registration Successful, run dropboxd --
        console.log('✅ Pendaftaran berhasil! Browser tetap terbuka — memulai verifikasi email via dropboxd...');
        await page.waitForTimeout(1500);

        let dropboxProc = null;
        let cliLinkUrl  = null;
        const killDropbox = () => {
            if (dropboxProc) try { dropboxProc.kill('SIGTERM'); } catch (_) {}
            try { execSync('pkill -9 -f dropbox-lnx.x86_64', { stdio: 'ignore' }); } catch (_) {}
            try { execSync('pkill -9 -f dropboxd', { stdio: 'ignore' }); } catch (_) {}
        };

        try {
            // Find dropboxd executable
            let dropboxCmd = '';
            if (fs.existsSync(path.join(__dirname, 'app', '.dropbox-dist', 'dropboxd'))) {
                dropboxCmd = './app/.dropbox-dist/dropboxd';
            } else if (fs.existsSync(path.join(__dirname, 'app', 'dropboxd'))) {
                dropboxCmd = './app/dropboxd';
            } else if (fs.existsSync(path.join(__dirname, '.dropbox-dist', 'dropboxd'))) {
                dropboxCmd = './.dropbox-dist/dropboxd';
            } else {
                // assume available in PATH or inside app/.dropbox-dist
                dropboxCmd = './app/.dropbox-dist/dropboxd'; 
            }

            console.log(`[dropboxd] Menjalankan: ${dropboxCmd}`);
            dropboxProc = spawn('bash', ['-c', dropboxCmd], {
                cwd: __dirname,
                env: { ...process.env, HOME: __dirname },
            });

            const daemonTimeout = 120;
            const dtMs = daemonTimeout * 1000;
            
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
                        killDropbox();
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

            // Navigate to CLI URL
            let connected = false;
            let cliAttempt = 0;
            const maxCliAttempts = 3;

            while (!connected && cliAttempt < maxCliAttempts) {
                cliAttempt++;
                try {
                    console.log(`[Browser] Navigasi ke URL CLI Link...`);
                    await page.goto(cliLinkUrl, { waitUntil: 'domcontentloaded', timeout: gtMs });
                    await page.waitForTimeout(2000);

                    const connectSelectors = [
                        'button:has-text("Connect")',
                        'button[aria-label="Connect"]',
                        'button:has-text("Hubungkan")',
                        'input[type="submit"][value*="Connect"]'
                    ];

                    let connectBtnFound = false;
                    for (const sel of connectSelectors) {
                        try {
                            await page.waitForSelector(sel, { state: 'visible', timeout: gtMs / 2 });
                            connectBtnFound = true;
                            break;
                        } catch (_) {}
                    }

                    if (!connectBtnFound) throw new Error("Tombol Connect tidak ditemukan di halaman verifikasi.");

                    for (const sel of connectSelectors) {
                        try {
                            if (await page.isVisible(sel)) {
                                await page.click(sel);
                                connected = true;
                                break;
                            }
                        } catch (e) {}
                    }

                } catch (err) {
                    console.log(`[Browser] Error CLI Link (Attempt ${cliAttempt}): ${err.message}`);
                    if (cliAttempt >= maxCliAttempts) throw new Error("Gagal verifikasi CLI Link.");
                    await page.waitForTimeout(3000);
                }
            }

            finalStatus = connected ? 'VERIF' : 'failed';
            if (connected) {
                console.log(`✅ Verifikasi email BERHASIL untuk ${email}`);
            }

        } catch (dropboxErr) {
            console.log(`[dropboxd] Error: ${dropboxErr.message}`);
            killDropbox();
            finalStatus = 'success'; // Registered but failed verification
        }

        saveRegistration(email, password, finalStatus, alias, "N/A", selectedUaString, emailTimeouts, emailErrors);
        return { success: true, status: finalStatus, password };

    } catch (error) {
        let msg = (error.message || '').split('\n')[0];
        console.log(`❌ Pendaftaran gagal untuk ${email}: ${msg}`);
        if (msg.toLowerCase().includes('timeout')) emailTimeouts++;
        else emailErrors++;
        
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
    const params = parseArgs();
    console.log("=== Dropbox Registration CLI ===");
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
            
            const result = await registerSingleEmail(email, params, ua);
            if (result.success) {
                success = true;
                if (result.status === 'VERIF') totalVerif++;
                else totalSuccess++;
                break;
            } else if (result.error.includes("TOO_MANY_ATTEMPTS")) {
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

if (require.main === module) {
    runCLI().catch(err => {
        console.error("Fatal Error:", err);
        process.exit(1);
    });
}
