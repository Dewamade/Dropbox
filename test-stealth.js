const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
    console.log("Launching stealth browser...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    const url = 'https://www.dropbox.com/referrals/AACKFx74yxqvF41QkxJUmmhsMzaX24rqhUA?src=global9';
    console.log("Navigating to", url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    console.log("Waiting for email field...");
    await page.waitForTimeout(3000);
    const emailSelectors = ['input[id^="susi_email"]', 'input[name="email"]', 'input[name="register-email"]'];
    let usedSel = emailSelectors[0];
    for (let s of emailSelectors) {
        if (await page.isVisible(s)) {
            usedSel = s;
            break;
        }
    }
    
    console.log("Filling email...");
    await page.fill(usedSel, 'test_stealth123@kywa.uk');
    
    console.log("Clicking continue...");
    try {
        await page.click('button.email-submit-button', { timeout: 5000 });
    } catch(e) {
        console.log("Could not click .email-submit-button");
    }
    
    console.log("Waiting 5 seconds to see what happens...");
    await page.waitForTimeout(5000);
    
    const path = require('path');
    const screenshotPath = path.join(__dirname, 'data', 'test_stealth.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log("Screenshot saved to", screenshotPath);
    
    await browser.close();
})();
