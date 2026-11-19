/**
 * camofox-client.js — REST client for a camofox-browser session (one browser,
 * many user sessions). Only the subset of the API used by register.js.
 *
 * API contract (camofox-browser v1.17, verified against server.js):
 *   POST   /tabs                       {userId,sessionKey,url?} -> {tabId,...}
 *                                     (sessionKey is a tab-group label; v1.17
 *                                      rejects the request without it)
 *   POST   /tabs/:tabId/navigate       {userId,url}            -> {ok,url}
 *   POST   /tabs/:tabId/wait           {userId,timeout,...}    -> page load/network idle
 *   POST   /tabs/:tabId/click          {userId,selector}       -> Playwright locator click
 *   POST   /tabs/:tabId/type           {userId,selector,text,mode,submit}
 *   POST   /tabs/:tabId/press          {userId,key}
 *   POST   /tabs/:tabId/scroll         {userId,direction,amount}
 *   POST   /tabs/:tabId/refresh        {userId}
 *   POST   /tabs/:tabId/evaluate       {userId,expression}     -> {ok,result}
 *   GET    /tabs/:tabId/screenshot     userId,fullPage         -> image/png bytes
 *   DELETE /sessions/:userId                                   -> session + tabs destroyed
 *
 * Selector catalogue entries are Playwright selectors (CSS, `:has-text("x")`,
 * `xpath=`), which /click and /type accept directly. For *visibility* checks the
 * server has no selector endpoint, so findVisible() evaluates one in-page script
 * that walks the whole list and reports the first visible match.
 */

const http = require('http');

const MARK_ATTR = 'data-cfx';

// In-page matcher: try selectors in order (catalogue order is the recovery
// strategy: most specific first), keep only visible elements, and prefer the
// smallest so a broad selector never grabs an enclosing container.
function findVisibleExpression(selectors, mark) {
    return `(() => {
        const sels = ${JSON.stringify(selectors)};
        const mark = ${JSON.stringify(!!mark)};
        const clean = () => { document.querySelectorAll('[' + '${MARK_ATTR}' + ']').forEach(e => e.removeAttribute('${MARK_ATTR}')); };
        clean();
        const norm = (s) => (s.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const visible = (el) => {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) return false;
            return true;
        };
        const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
        for (const raw of sels) {
            try {
                let els = [];
                const hasText = /^(.*?):has-text\\("([^"]*)"\\)$/.exec(raw);
                if (raw.startsWith('xpath=')) {
                    const it = document.evaluate(raw.slice(6), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                    for (let i = 0; i < it.snapshotLength; i++) els.push(it.snapshotItem(i));
                } else if (hasText) {
                    const needle = hasText[2].toLowerCase();
                    els = Array.from(document.querySelectorAll(hasText[1] || '*')).filter(e => norm(e).includes(needle));
                } else {
                    els = Array.from(document.querySelectorAll(raw));
                }
                const ok = els.filter(visible);
                if (ok.length > 0) {
                    ok.sort((a, b) => area(a) - area(b));
                    if (mark) ok[0].setAttribute('${MARK_ATTR}', '1');
                    return { selector: raw, count: ok.length, marked: !!mark };
                }
            } catch (e) { }
        }
        return null;
    })()`;
}

class CamofoxClient {
    constructor({ baseUrl, userId }) {
        this.baseUrl = String(baseUrl).replace(/\/$/, '');
        this.userId = String(userId);
    }

    // One HTTP round trip. Returns parsed JSON, or a Buffer when the response is
    // an image. Throws on transport failure, non-2xx, or camofox {ok:false}.
    _request(method, apiPath, { body, timeoutMs = 30000, raw = false } = {}) {
        return new Promise((resolve, reject) => {
            const target = new URL(this.baseUrl + apiPath);
            const payload = body === undefined ? null : JSON.stringify(body);
            const req = http.request({
                method,
                hostname: target.hostname,
                port: target.port,
                path: target.pathname + target.search,
                headers: payload
                    ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                    : {},
                timeout: timeoutMs,
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const type = String(res.headers['content-type'] || '');
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        if (raw || type.startsWith('image/')) return resolve(buf);
                        try { resolve(JSON.parse(buf.toString('utf8') || '{}')); }
                        catch (e) { reject(new Error(`camofox ${method} ${apiPath}: respons non-JSON (${res.statusCode})`)); }
                        return;
                    }
                    let detail = buf.toString('utf8').slice(0, 300);
                    try { const j = JSON.parse(detail); detail = j.error || j.message || detail; } catch (_) { }
                    reject(new Error(`camofox ${method} ${apiPath} → HTTP ${res.statusCode}: ${detail}`));
                });
            });
            req.on('timeout', () => { req.destroy(new Error(`camofox ${method} ${apiPath} timeout ${timeoutMs}ms`)); });
            req.on('error', (err) => reject(err));
            if (payload) req.write(payload);
            req.end();
        });
    }

    async health() {
        return this._request('GET', '/health', { timeoutMs: 5000 });
    }

    async listTabs() {
        const r = await this._request('GET', `/tabs?userId=${encodeURIComponent(this.userId)}`);
        return r.tabs || [];
    }

    async createTab(url) {
        // sessionKey only labels a tab group inside this user's session (findTab
        // scans every group), but v1.17 rejects POST /tabs without it.
        const body = { userId: this.userId, sessionKey: this.userId };
        if (url) body.url = url;
        const r = await this._request('POST', '/tabs', { body, timeoutMs: 90000 });
        if (!r.tabId) throw new Error('camofox: tabId tidak dikembalikan server');
        this.tabId = r.tabId;
        return this.tabId;
    }

    // Re-attach to an existing tab of this session (cross-process continuation).
    async attach() {
        const tabs = await this.listTabs();
        if (!tabs.length) return null;
        this.tabId = tabs[0].tabId;
        return this.tabId;
    }

    async navigate(url, { timeoutMs = 60000 } = {}) {
        const r = await this._request('POST', `/tabs/${this.tabId}/navigate`, {
            body: { userId: this.userId, url },
            timeoutMs: Math.min(timeoutMs, 90000),
        });
        return r.url || url;
    }

    async refresh({ timeoutMs = 60000 } = {}) {
        return this._request('POST', `/tabs/${this.tabId}/refresh`, {
            body: { userId: this.userId },
            timeoutMs: Math.min(timeoutMs, 90000),
        });
    }

    // Wait for the page to settle (load + network idle). Safe to fail.
    async settle({ timeoutMs = 10000 } = {}) {
        try {
            await this._request('POST', `/tabs/${this.tabId}/wait`, {
                body: { userId: this.userId, timeout: Math.min(timeoutMs, 25000), waitForNetwork: true },
                timeoutMs: timeoutMs + 5000,
            });
        } catch (_) { }
    }

    async evaluate(expression, { timeoutMs = 30000 } = {}) {
        const r = await this._request('POST', `/tabs/${this.tabId}/evaluate`, {
            body: { userId: this.userId, expression },
            timeoutMs,
        });
        return r.result;
    }

    async currentUrl() {
        try { return await this.evaluate('location.href', { timeoutMs: 8000 }) || ''; }
        catch (_) { return ''; }
    }

    async bodyText() {
        try { return await this.evaluate('document.body ? document.body.innerText : ""', { timeoutMs: 15000 }) || ''; }
        catch (_) { return ''; }
    }

    async title() {
        try { return await this.evaluate('document.title || ""', { timeoutMs: 8000 }) || ''; }
        catch (_) { return ''; }
    }

    // Returns the first selector from the list that has a visible element, else null.
    async findVisible(selectors, { timeoutMs = 8000, mark = false } = {}) {
        if (!Array.isArray(selectors) || selectors.length === 0) return null;
        const r = await this.evaluate(findVisibleExpression(selectors, mark), { timeoutMs });
        return r && r.selector ? r : null;
    }

    // Click the first visible element of the selector list. Returns the selector
    // used, or false when nothing matched. camofox /click speaks Playwright
    // selectors, but only one at a time, so the winner is marked in-page and the
    // click then targets that unique node (real mouse sequence fallbacks inside
    // camofox still apply).
    async clickVisible(selectors) {
        const hit = await this.findVisible(selectors, { mark: true });
        if (!hit) return false;
        await this._request('POST', `/tabs/${this.tabId}/click`, {
            body: { userId: this.userId, selector: `[${MARK_ATTR}="1"]` },
            timeoutMs: 30000,
        });
        return hit.selector;
    }

    async typeVisible(selectors, text, { submit = false, mode = 'fill' } = {}) {
        const hit = await this.findVisible(selectors, { mark: true });
        if (!hit) return false;
        await this._request('POST', `/tabs/${this.tabId}/type`, {
            body: { userId: this.userId, selector: `[${MARK_ATTR}="1"]`, text, mode, submit },
            timeoutMs: 30000,
        });
        return hit.selector;
    }

    async isChecked(selectors) {
        const hit = await this.findVisible(selectors);
        if (!hit) return null;
        const val = await this.evaluate(`(() => { const e = document.querySelector('[${MARK_ATTR}=\\"1\\"]'); return e ? !!e.checked : null; })()`);
        return val === true;
    }

    // Poll findVisible until the deadline. Returns the matched selector or null.
    async waitForVisible(selectors, timeoutMs = 30000, { pollMs = 1000, abortController = null, onPoll = null } = {}) {
        const deadline = Date.now() + timeoutMs;
        let first = true;
        while (Date.now() < deadline) {
            if (abortController && abortController.shouldStop) throw new Error('Pendaftaran dihentikan oleh pengguna.');
            const hit = await this.findVisible(selectors).catch(() => null);
            if (hit) return hit.selector;
            if (onPoll) onPoll({ remainingMs: deadline - Date.now(), first });
            first = false;
            await new Promise((r) => setTimeout(r, pollMs));
        }
        return null;
    }

    async press(key) {
        await this._request('POST', `/tabs/${this.tabId}/press`, { body: { userId: this.userId, key } });
    }

    async scroll(direction = 'down', amount = 300) {
        try {
            await this._request('POST', `/tabs/${this.tabId}/scroll`, {
                body: { userId: this.userId, direction, amount },
            });
        } catch (_) { }
    }

    async screenshot({ fullPage = false, timeoutMs = 20000 } = {}) {
        return this._request('GET', `/tabs/${this.tabId}/screenshot?userId=${encodeURIComponent(this.userId)}&fullPage=${fullPage}`, { raw: true, timeoutMs });
    }

    // Fresh session per email: drop every tab + the persisted profile directory.
    async destroy() {
        if (!this.tabId) return;
        try { await this._request('DELETE', `/sessions/${encodeURIComponent(this.userId)}`, { timeoutMs: 15000 }); } catch (_) { }
        this.tabId = null;
    }
}

module.exports = { CamofoxClient, findVisibleExpression, MARK_ATTR };
