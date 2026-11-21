// BUKTI KONTRAK "Jalur Keluar" di panel Pengaturan: centang Direct + SATU proxy,
// baris "Rencana:", kunci otomatis saat tanpa proxy, dan round-trip ke server
// lewat tombol Terapkan (/api/settings). Probe ini menyimpan lalu memulihkan
// pengaturan proxy server, jadi aman dijalankan berulang.
//   NODE_OPTIONS="--require $PWD/tmp-stub-loader.js" PORT=3007 node server.js
//   node tmp-path-ui-probe.js 3007
const fs = require('fs');
const path = require('path');
const camofox = require('./camofox-manager');
const { CamofoxClient } = require('./camofox-client');

const DASH = 'http://localhost:' + (process.argv[2] || '3007');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, body) => {
    const res = await fetch(DASH + p, body ? {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    } : undefined);
    return res.json();
};

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (harusnya ${JSON.stringify(expected)})`}`);
}

const STATE = `(() => ({
    direct: document.getElementById('use-direct').checked,
    directDisabled: document.getElementById('use-direct').disabled,
    proxy: (document.querySelector('input[name="proxy-mode"]:checked') || {}).value || null,
    plan: document.getElementById('path-plan-now').textContent,
    planColor: getComputedStyle(document.getElementById('path-plan-now')).color,
}))()`;

async function openSettings(cf) {
    await cf.clickVisible(['#tab-pengaturan-btn']);
    await sleep(400);
    if (!await cf.findVisible(['#global-retry'])) {
        await cf.clickVisible(['#tab-pengaturan-btn']);
        await sleep(400);
    }
    if (!await cf.findVisible(['#global-retry'])) throw new Error('panel Pengaturan tetap tertutup');
}

(async () => {
    // Keadaan awal ditentukan probe sendiri; keadaan server dipulihkan di akhir.
    const before = await api('/api/settings');
    await api('/api/settings/apply', { proxyMode: 'warp', useDirect: false });
    const baseUrl = await camofox.ensureRunning({});
    const cf = new CamofoxClient({ baseUrl, userId: 'path-ui-probe-' + Date.now() });
    try {
        await cf.createTab(DASH);
        await cf.settle({ timeoutMs: 20000 });
        await openSettings(cf);

        // Server sudah diset (oleh bash) ke warp + Direct dilepas: halaman baru
        // HARUS menampilkan keadaan itu, bukan default-nya.
        let s = await cf.evaluate(STATE);
        check('pemuatan dari /api/settings (warp, Direct lepas)', { d: s.direct, dis: s.directDisabled, p: s.proxy }, { d: false, dis: false, p: 'warp' });
        check('baris rencana', s.plan, 'Rencana: SEMUA percobaan (1..5) lewat WARP — Direct tidak dipakai.');
        check('baris rencana disorot', s.planColor, 'rgb(251, 191, 36)');

        // Tanpa proxy -> Direct tidak boleh dilepas.
        await cf.clickVisible(['.check-option:has-text("Tanpa proxy")']);
        await sleep(300);
        s = await cf.evaluate(STATE);
        check('tanpa proxy: Direct dipaksa + dikunci', { d: s.direct, dis: s.directDisabled, p: s.proxy }, { d: true, dis: true, p: 'none' });
        check('baris rencana tanpa proxy', s.plan, 'Rencana: semua percobaan lewat Direct (tidak ada proxy dipilih).');

        // Proxy dipilih lagi, centang Direct dilepas lewat klik label.
        await cf.clickVisible(['.check-option:has-text("Psiphon")']);
        await sleep(300);
        await cf.clickVisible(['.check-option:has-text("Direct (IP asli")']);
        await sleep(300);
        s = await cf.evaluate(STATE);
        check('psiphon + Direct lepas', { d: s.direct, dis: s.directDisabled, p: s.proxy }, { d: false, dis: false, p: 'psiphon' });
        check('baris rencana psiphon', s.plan, 'Rencana: SEMUA percobaan (1..5) lewat PSIPHON — Direct tidak dipakai.');

        await cf.evaluate(`(() => { document.getElementById('connection-type-group').scrollIntoView({ block: 'center' }); return 1; })()`);
        await sleep(300);
        console.log('BOX ' + JSON.stringify(await cf.evaluate(`(() => { const r = document.getElementById('connection-type-group').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`)));
        const shot = await cf.screenshot();
        fs.writeFileSync(path.join(__dirname, 'data', 'debug_path_ui.png'), shot);

        // Round-trip: tombol Terapkan menulis ke /api/settings, jadi halaman yang
        // dimuat ulang HARUS menampilkan keadaan itu (bukan dari localStorage).
        await cf.clickVisible(['#apply-settings-btn']);
        await sleep(600);
        await cf.refresh();
        await cf.settle({ timeoutMs: 20000 });
        await openSettings(cf);
        s = await cf.evaluate(STATE);
        check('keadaan kembali dari /api/settings', { d: s.direct, p: s.proxy }, { d: false, p: 'psiphon' });
    } finally {
        await cf.destroy();
        camofox.cleanupProfile(cf.userId);
        await camofox.stop();
        await api('/api/settings/apply', { proxyMode: before.proxyMode, useDirect: before.useDirect });
    }
    console.log(failures === 0 ? 'SEMUA PEMERIKSAAN LOLOS' : `ada ${failures} pemeriksaan gagal`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE GAGAL:', e.message); process.exit(1); });
