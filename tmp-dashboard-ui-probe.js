// Probe: periksa kartu penghitung dashboard (Sukses / Blocked / Error), teks
// labelnya, dan cincin progress di halaman ASLI, lewat mesin camofox proyek ini,
// dengan engine pendaftaran distub (tmp-stub-loader.js) sehingga tidak perlu
// jaringan/browser asli. Hasil tiap percobaan diambil stub dari NAMA email
// (success…/verif…/error…/limit…; nama lain -> STUB_PLAN, default 'limit'),
// jadi urutan di bawah deterministik tanpa STUB_SEQ. Pakai:
//   STUB_DELAY_MS=1000 NODE_OPTIONS="--require $PWD/tmp-stub-loader.js" PORT=3007 node server.js
//   node tmp-dashboard-ui-probe.js 3007
// Bukti visual ditulis ke data/debug_ui_counters.png.
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

const STATE = `(() => ({
    labels: [...document.querySelectorAll('.stat-label')].map((e) => e.innerText),
    cards: {
        sukses: Number(document.getElementById('stat-success-count').innerText),
        blocked: Number(document.getElementById('stat-limit-count').innerText),
        error: Number(document.getElementById('stat-error-count').innerText),
    },
    pct: document.getElementById('progress-percentage').innerText,
    detail: document.getElementById('progress-detail').innerText,
    badge: document.getElementById('status-text').innerText,
    // Akhir batch: target tercapai, dihentikan user, atau rentetan kegagalan habis.
    idle: /akun tercapai|Batch dihentikan|Berhenti: \\d+ percobaan gagal/.test(document.getElementById('progress-detail').innerText),
}))()`;

// Baca state halaman; `until` = kondisi berhenti, maksimum `timeoutMs`.
async function readUntil(cf, until, timeoutMs = 30000) {
    const stopAt = Date.now() + timeoutMs;
    let s = null;
    while (Date.now() < stopAt) {
        s = await cf.evaluate(STATE);
        if (until(s)) return s;
        await sleep(500);
    }
    return s;
}

async function openSettings(cf) {
    await cf.clickVisible(['#tab-pengaturan-btn']);
    await sleep(400);
    // Panel terbuka = formnya terlihat; klik dua kali bila tab-nya sudah
    // ditandai aktif padahal panelnya masih tersembunyi.
    if (!await cf.findVisible(['#global-retry'])) {
        await cf.clickVisible(['#tab-pengaturan-btn']);
        await sleep(400);
    }
    if (!await cf.findVisible(['#global-retry'])) throw new Error('panel Pengaturan tetap tertutup');
}

async function runBatch(cf, { emails, retry }) {
    // Formnya ada di tab Pengaturan; tanpa ini semua interaksi diam-diam tidak
    // terjadi (panelnya display:none) dan server memakai email otomatis.
    await openSettings(cf);
    const clickedMode = await cf.clickVisible(['#em-manual']);
    if (!clickedMode) throw new Error('kontrol #em-manual tidak ketemu/terpakai');
    await sleep(300);
    // Mengisi kolom dilakukan lewat halaman (camofox /type mode=fill MENAMBAH,
    // bukan mengganti); yang diuji di sini angka penghitungnya, bukan widget
    // inputnya. Nilai angka dibaca halaman saat Mulai diklik, jadi sama saja.
    for (const [sel, value] of [['#emails-list', emails.join(';')], ['#global-retry', String(retry)]]) {
        await cf.evaluate(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    }
    // Pastikan halaman benar-benar memakai daftar email ini (kalau tidak, server
    // diam-diam membuat email otomatis dan yang diuji bukan skenario ini).
    const form = await cf.evaluate(`(() => ({
        mode: document.querySelector('input[name="email-mode"]:checked').value,
        jumlah: document.getElementById('emails-list').value.split(';').length,
        retry: document.getElementById('global-retry').value,
    }))()`);
    if (form.mode !== 'manual' || form.jumlah !== emails.length || form.retry !== String(retry)) {
        throw new Error(`form tidak terpakai: ${JSON.stringify(form)}`);
    }
    // Mulai Pendaftaran ada di tab Progress.
    const back = await cf.clickVisible(['#tab-progress-btn']);
    if (!back) throw new Error('tab Progress tidak ketemu');
    await sleep(300);
    const start = await cf.clickVisible(['#start-btn']);
    if (!start) throw new Error('tombol Mulai tidak ketemu');
}

(async () => {
    const baseUrl = await camofox.ensureRunning({});
    const cf = new CamofoxClient({ baseUrl, userId: 'ui-probe-' + Date.now() });
    try {
        await cf.createTab(DASH);
        await cf.settle({ timeoutMs: 20000 });

        // ── 1: satu batch (target 3 akun) yang melewati SEMUA kelas hasil:
        //    sukses, VERIF, lalu dua kegagalan berturut-turut (ERROR lalu BLOCKED)
        //    sehingga anggaran rentetan (globalRetry=2) habis dan batch berhenti.
        await runBatch(cf, {
            retry: 2,
            emails: [`success1@${DOMAIN}`, `verif2@${DOMAIN}`, `error3@${DOMAIN}`],
        });
        const s1 = await readUntil(cf, (s) => s.cards.error === 1 && s.cards.blocked === 1, 40000);
        // CSS mengubah label jadi huruf besar; bandingkan case-insensitive.
        check('label kartu', s1.labels.map((l) => l.toLowerCase()), ['sukses', 'blocked', 'error']);
        check('kartu batch 1 (sukses/blocked/error)', s1.cards, { sukses: 1, blocked: 1, error: 1 });
        // Cincin = (sukses + VERIF) / total = 2/3; kegagalan tidak menggesernya.
        check('cincin batch 1', s1.pct, '67%');
        // Tunggu batch benar-benar usai sebelum fase 2 mulai.
        await readUntil(cf, (s) => s.idle, 30000);
        const shot = await cf.screenshot();
        fs.writeFileSync(path.join(__dirname, 'data', 'debug_ui_counters.png'), shot);

        // Kelas kegagalan juga harus TERLIHAT di konsol: server menuliskannya di
        // awalan baris ([FAIL] Blocked vs [FAIL] Error) dan UI mewarnainya sesuai
        // kartu yang bergerak (amber = yang dipulihkan dengan IP+profil baru /
        // manusia di noVNC, merah = masalah teknis). Diperiksa di sini: Mulai
        // batch berikutnya mengosongkan panel konsol (logPanel.innerHTML = '').
        const logClasses = await cf.evaluate(`(() => {
            const kelas = (lencana) => {
                const els = [...document.querySelectorAll('#log-panel .log-line')].filter((e) => e.textContent.includes(lencana));
                const last = els[els.length - 1];
                return last ? last.className.replace('log-line ', '') : 'TIDAK ADA BARIS';
            };
            return { blocked: kelas('[FAIL] Blocked'), error: kelas('[FAIL] Error'), teknis: kelas('Kegagalan teknis') };
        })()`);
        check('baris konsol diwarnai per kelas', {
            blocked: logClasses.blocked, error: logClasses.error, teknis: logClasses.teknis,
        }, { blocked: 'log-warn', error: 'log-err', teknis: 'log-err' });

        // ── 2: Hentikan di tengah batch -> angka TIDAK di-nol-kan, dan halaman
        //    yang di-refresh (sync_state) menampilkan angka yang sama.
        //    Urutan: #4 sukses, #5 VERIF, #6 limit. Klik Hentikan dilakukan
        //    SAAT kartu Sukses sudah 1 dan sebelum Hentikan sampai, jadi yang
        //    mendarat hanyalah percobaan #5 (VERIF, tidak punya kartu) atau #6
        //    (gagal, dan kegagalan yang dipotong Hentikan memang TIDAK dihitung):
        //    angka akhirnya sama di semua cabang waktu.
        await sleep(700);
        await runBatch(cf, {
            retry: 1,
            emails: [`success4@${DOMAIN}`, `verif5@${DOMAIN}`, `limit6@${DOMAIN}`, `limit7@${DOMAIN}`],
        });
        await readUntil(cf, (s) => s.cards.sukses === 1, 20000);
        const pre = (await cf.evaluate(STATE)).cards;
        const stopHit = await cf.clickVisible(['#stop-btn']);
        if (!stopHit) throw new Error('tombol Hentikan tidak ketemu');
        const s2 = await readUntil(cf, (s) => s.detail.includes('Batch dihentikan'), 20000);
        // Tidak ada kartu yang turun atau di-nol-kan; VERIF menaikkan cincin tapi
        // tidak punya kartu, jadi kartu tidak berubah sama sekali.
        check('kartu tidak di-nol-kan oleh Hentikan', {
            sukses_tetap: s2.cards.sukses === pre.sukses,
            tidak_ada_kartu_yang_turun: s2.cards.blocked >= pre.blocked && s2.cards.error >= pre.error,
        }, { sukses_tetap: true, tidak_ada_kartu_yang_turun: true });
        // Email #4 (sukses) dan #5 (VERIF) selesai -> cincin = (sukses + VERIF)/4.
        check('cincin setelah Hentikan (sukses+VERIF)/4', s2.pct, '50%');

        await cf.refresh();
        await cf.settle({ timeoutMs: 20000 });
        const s3 = await readUntil(cf, (s) => s.cards.sukses === s2.cards.sukses, 20000);
        check('kartu di halaman yang di-refresh', s3.cards, s2.cards);
        // Badge di halaman baru dipakai panel status worker (BOOT/PROCESSING/
        // FINISH); teks progress ada di #progress-detail.
        check('teks progress di halaman yang di-refresh', s3.detail, 'Dihentikan');

        console.log(failures === 0 ? '\nSEMUA PEMERIKSAAN LOLOS' : `\n${failures} PEMERIKSAAN GAGAL`);
    } finally {
        await cf.destroy().catch(() => { });
        // DELETE /sessions hanya menutup tab; direktori profil di
        // camofox-data/profiles dihapus register.js lewat cleanupProfile, yang
        // tidak dilewati probe ini.
        camofox.cleanupProfile(cf.userId);
        // stop() async: pembersih Xvfb/x11vnc berjalan SETELAH server benar-benar
        // keluar, jadi tanpa await proses ini mati duluan dan meninggalkan Xvfb.
        await camofox.stop();
    }
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => { console.error('PROBE ERR:', e.message); await camofox.stop(); process.exit(2); });
