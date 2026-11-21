// Probe: modal Riwayat Pendaftaran + label worker, di HALAMAN ASLI lewat mesin
// camofox proyek ini (engine distub, tanpa jaringan/browser asli).
//
// Yang dibuktikan:
//  1. Kolom Status Riwayat memakai kata yang SAMA dengan kartu dashboard
//     (Sukses / Blocked / Error), lengkap dengan warnanya.
//  2. Tiap baris gagal menyebut IP keluar percobaan itu: Blocked = IP yang
//     ditolak Dropbox; Error yang terjadi sebelum ada IP terukur = '-'.
//  3. Setelah Hentikan, pill kepala DAN badge progress membaca TERHENTI (bukan
//     FINISH), dan tetap TERHENTI setelah halaman di-refresh (sync_state).
//  4. Batch yang mencapai target TIDAK boleh terbaca TERHENTI (tetap FINISH).
//
// Urutan pemanggilan engine (nomor = STUB_SEQ, IP = 203.0.113.<nomor>):
//   #1 limit (IP .1)  ─┐  A: target 2, retry 2 -> rentetan habis -> TERHENTI
//   #2 error (TANPA IP┘     (STUB_NO_IP=2)
//   #3 success (IP .3)      B: target 1 tercapai -> FINISH
//   #4 success              C: Hentikan saat #5 berjalan -> TERHENTI
//
//   STUB_SEQ="limit,error,success,success,limit" STUB_NO_IP=2 STUB_DELAY_MS=1500 \
//     NODE_OPTIONS="--require $PWD/tmp-stub-loader.js" PORT=3007 node server.js
//   node tmp-riwayat-ui-probe.js 3007
// Bukti visual: data/debug_riwayat_labels.png (modal terbuka) +
// data/debug_terhenti.png (pill + badge TERHENTI).
const fs = require('fs');
const path = require('path');
const camofox = require('./camofox-manager');
const { CamofoxClient } = require('./camofox-client');

const DASH = 'http://localhost:' + (process.argv[2] || '3007');
const DOMAIN = 'surel.gudangpemaron.my.id';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (harusnya ${JSON.stringify(expected)})`}`);
}

// Label yang terlihat di dua widget status (pill kepala + badge progress).
const STATE = `(() => ({
    pill: document.getElementById('worker-status-label').innerText,
    badge: document.getElementById('status-text').innerText,
    badgeClass: document.getElementById('status-badge').className,
    detail: document.getElementById('progress-detail').innerText,
    cards: {
        sukses: Number(document.getElementById('stat-success-count').innerText),
        blocked: Number(document.getElementById('stat-limit-count').innerText),
        error: Number(document.getElementById('stat-error-count').innerText),
    },
    selesai: /akun tercapai|Batch dihentikan|Berhenti: \\d+ percobaan gagal/.test(document.getElementById('progress-detail').innerText),
}))()`;

// Baris tabel Detail Riwayat, dibaca dari DOM: IP | Waktu | Email | Password |
// Status(badge) | Alias | Koneksi.
const ROWS = `(() => {
    const tables = [...document.querySelectorAll('#history-content table.history-table')];
    const detail = tables[tables.length - 1];
    if (!detail) return null;
    return [...detail.querySelectorAll('tbody tr')].map((tr) => {
        const td = [...tr.querySelectorAll('td')].map((e) => e.textContent.trim());
        const badge = tr.querySelector('td:nth-child(5) span');
        return { ip: td[0], email: td[2], status: td[4], badge: badge ? badge.className : '', koneksi: td[6] };
    });
})()`;

async function readUntil(cf, expr, until, timeoutMs = 30000) {
    const stopAt = Date.now() + timeoutMs;
    let s = null;
    while (Date.now() < stopAt) {
        s = await cf.evaluate(expr);
        if (until(s)) return s;
        await sleep(500);
    }
    return s;
}

async function openSettings(cf) {
    await cf.clickVisible(['#tab-pengaturan-btn']);
    await sleep(400);
    if (!await cf.findVisible(['#global-retry'])) {
        await cf.clickVisible(['#tab-pengaturan-btn']);
        await sleep(400);
    }
    if (!await cf.findVisible(['#global-retry'])) throw new Error('panel Pengaturan tetap tertutup');
}

async function runBatch(cf, { emails, retry }) {
    await openSettings(cf);
    const clickedMode = await cf.clickVisible(['#em-manual']);
    if (!clickedMode) throw new Error('kontrol #em-manual tidak ketemu/terpakai');
    await sleep(300);
    for (const [sel, value] of [['#emails-list', emails.join(';')], ['#global-retry', String(retry)]]) {
        await cf.evaluate(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    }
    const form = await cf.evaluate(`(() => ({
        mode: document.querySelector('input[name="email-mode"]:checked').value,
        jumlah: document.getElementById('emails-list').value.split(';').length,
        retry: document.getElementById('global-retry').value,
    }))()`);
    if (form.mode !== 'manual' || form.jumlah !== emails.length || form.retry !== String(retry)) {
        throw new Error(`form tidak terpakai: ${JSON.stringify(form)}`);
    }
    const back = await cf.clickVisible(['#tab-progress-btn']);
    if (!back) throw new Error('tab Progress tidak ketemu');
    await sleep(300);
    const start = await cf.clickVisible(['#start-btn']);
    if (!start) throw new Error('tombol Mulai tidak ketemu');
}

(async () => {
    const baseUrl = await camofox.ensureRunning({});
    const cf = new CamofoxClient({ baseUrl, userId: 'riwayat-probe-' + Date.now() });
    try {
        await cf.createTab(DASH);
        await cf.settle({ timeoutMs: 20000 });

        // ── A: dua kegagalan berurutan (Blocked dengan IP, Error tanpa IP) ─────
        await runBatch(cf, { retry: 2, emails: [`rwiya.blk1@${DOMAIN}`, `rwiya.err2@${DOMAIN}`] });
        const sA = await readUntil(cf, STATE, (s) => s.selesai, 40000);
        check('A penghitung naik per kelas', sA.cards, { sukses: 0, blocked: 1, error: 1 });
        // Rentetan habis = batch berhenti: label harus TERHENTI, bukan FINISH hijau.
        const sA2 = await readUntil(cf, STATE, (s) => s.pill === 'TERHENTI', 20000);
        check('A pill = TERHENTI setelah rentetan habis', sA2.pill, 'TERHENTI');
        check('A badge = TERHENTI (abu-abu, bukan hijau)', { badge: sA2.badge, idle: /status-idle/.test(sA2.badgeClass) },
            { badge: 'TERHENTI', idle: true });

        // ── B: target tercapai -> TIDAK boleh terbaca TERHENTI ─────────────────
        await runBatch(cf, { retry: 1, emails: [`rwiya.suc3@${DOMAIN}`] });
        const sB = await readUntil(cf, STATE, (s) => s.pill === 'FINISH', 30000);
        check('B batch target tercapai tetap FINISH', sB.pill, 'FINISH');

        // ── Riwayat: kata status + IP per percobaan ────────────────────────────
        const opened = await cf.clickVisible(['#history-btn']);
        if (!opened) throw new Error('tombol Riwayat tidak ketemu');
        await sleep(800);
        const rows = await readUntil(cf, ROWS, (r) => Array.isArray(r) && r.length > 0, 20000);
        const byEmail = (prefix) => (rows || []).find((r) => String(r.email).startsWith(prefix)) || {};
        // IP keluar percobaan itu, bukan IP terakhir yang pernah diukur.
        check('Riwayat baris Blocked: status + IP keluar + jalur', {
            status: byEmail('rwiya.blk1').status, badge: byEmail('rwiya.blk1').badge,
            ip: byEmail('rwiya.blk1').ip, koneksi: byEmail('rwiya.blk1').koneksi,
        }, { status: 'Blocked', badge: 'badge-limit', ip: '203.0.113.1', koneksi: 'Direct' });
        // Error tanpa IP terukur (stub #2 = STUB_NO_IP) harus tampil '-'.
        check('Riwayat baris Error tanpa IP: status + "-"', {
            status: byEmail('rwiya.err2').status, badge: byEmail('rwiya.err2').badge, ip: byEmail('rwiya.err2').ip,
        }, { status: 'Error', badge: 'badge-error', ip: '-' });
        check('Riwayat baris Sukses: status + IP-nya', {
            status: byEmail('rwiya.suc3').status, badge: byEmail('rwiya.suc3').badge, ip: byEmail('rwiya.suc3').ip,
        }, { status: 'Sukses', badge: 'badge-sukses', ip: '203.0.113.3' });
        // Tidak boleh ada lagi kata teknis mentah (success/failed/VERIF) di kolom status.
        check('Riwayat tanpa kosakata teknis mentah', (rows || []).filter((r) => /^(success|failed|VERIF)$/i.test(r.status)).length, 0);
        await cf.evaluate(`(() => {
            const tables = [...document.querySelectorAll('#history-content table.history-table')];
            const first = tables[tables.length - 1] && tables[tables.length - 1].querySelector('tbody tr');
            if (first) first.scrollIntoView({ block: 'start' });
        })()`);
        await sleep(300);
        fs.writeFileSync(path.join(__dirname, 'data', 'debug_riwayat_labels.png'), await cf.screenshot());
        await cf.clickVisible(['#modal-close-btn']);
        await sleep(300);

        // ── C: Hentikan di tengah batch -> TERHENTI, juga setelah refresh ───────
        await runBatch(cf, { retry: 1, emails: [`rwiya.suc4@${DOMAIN}`, `rwiya.stp5@${DOMAIN}`] });
        await readUntil(cf, STATE, (s) => s.cards.sukses >= 1, 30000);
        const stopHit = await cf.clickVisible(['#stop-btn']);
        if (!stopHit) throw new Error('tombol Hentikan tidak ketemu');
        const sC = await readUntil(cf, STATE, (s) => s.pill === 'TERHENTI', 20000);
        check('C pill = TERHENTI setelah Hentikan', sC.pill, 'TERHENTI');
        check('C badge = TERHENTI', sC.badge, 'TERHENTI');
        fs.writeFileSync(path.join(__dirname, 'data', 'debug_terhenti.png'), await cf.screenshot());

        await cf.refresh();
        await cf.settle({ timeoutMs: 20000 });
        const sR = await readUntil(cf, STATE, (s) => s.pill === 'TERHENTI' || s.pill === 'FINISH', 20000);
        check('C label tetap TERHENTI di halaman yang di-refresh', sR.pill, 'TERHENTI');

        console.log(failures === 0 ? '\nSEMUA PEMERIKSAAN LOLOS' : `\n${failures} PEMERIKSAAN GAGAL`);
    } finally {
        await cf.destroy().catch(() => { });
        camofox.cleanupProfile(cf.userId);
        await camofox.stop();
    }
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => { console.error('PROBE ERR:', e.message); await camofox.stop(); process.exit(2); });
