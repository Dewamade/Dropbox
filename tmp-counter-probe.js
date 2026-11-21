// Probe: periksa penghitung UI (Sukses / Blocked / Error / VERIF) dan aturan
// resetnya lewat WS, terhadap server yang engine-nya distub (tmp-stub-loader.js).
// Tidak perlu browser/jaringan. Hasil PER PANGGILAN engine ditentukan STUB_SEQ
// (urutan token, item terakhir dipakai untuk panggilan berikutnya), jadi angka
// yang diharapkan tidak tergantung nama email yang dibangkitkan server:
//   STUB_SEQ="error,limit,verif,error,limit,success" STUB_DELAY_MS=1000 \
//     NODE_OPTIONS="--require $PWD/tmp-stub-loader.js" PORT=3007 node server.js
//   node tmp-counter-probe.js 3007
const WebSocket = require('ws');
const PORT = parseInt(process.argv[2] || '3007', 10);
const DOMAIN = 'surel.gudangpemaron.my.id';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (harusnya ${JSON.stringify(expected)})`}`);
}
const pick = (p) => ({ success: p.successCount, limit: p.limitCount, error: p.errorCount, verif: p.verifCount });

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', (e) => reject(e));
    });
}

// Baca state yang disimpan server = apa yang dilihat halaman yang di-refresh.
async function readSyncState() {
    const ws = await connect();
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('sync_state tidak datang')), 8000);
            ws.on('message', (buf) => {
                let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
                if (m.type === 'sync_state') {
                    clearTimeout(timer);
                    resolve({ status: m.state.progress.status, counts: pick(m.state.progress) });
                }
            });
        });
    } finally {
        ws.close();
    }
}

// Jalankan satu batch; kembalikan payload progress PERTAMA dan TERAKHIR, status
// akhir, dan apakah kelas "batas Dropbox" dinamai Blocked (di log DAN di status
// progress UI).
async function runBatch({ alias, emails, globalRetry, stopAfterMs = 0 }) {
    const ws = await connect();
    let first = null, last = null, sawBlockedLog = false, sawBlockedStatus = false;
    let lastStatusTimer = null;
    try {
        const events = new Promise((resolve) => {
            ws.on('message', (buf) => {
                let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
                if (m.type === 'progress') { if (!first) first = m; last = m; if (/Gagal Blocked:/.test(m.status || '')) sawBlockedStatus = true; }
                else if (m.type === 'log' && /Batas Dropbox terdeteksi/.test(m.message)) sawBlockedLog = true;
                else if (m.type === 'status' && ['stopped', 'success', 'error'].includes(m.status)) {
                    // 'Hentikan' mengirim status 'stopped' seketika, sedangkan status +
                    // ringkasan progress akhir batch dikirim SETELAH loop berhenti
                    // (percobaan yang sedang berjalan diselesaikan dulu). Ambil status
                    // TERAKHIR: baru selesai kalau tidak ada status baru lagi selama 1,2s.
                    clearTimeout(lastStatusTimer);
                    lastStatusTimer = setTimeout(() => resolve(m.status), 1200);
                }
            });
        });
        ws.send(JSON.stringify({
            action: 'start', alias,
            url: 'https://www.dropbox.com/referrals/test',
            emails: emails.join(';'), emailMode: 'manual',
            proxyMode: 'none', globalRetry, globalTimeout: 5, daemonTimeout: 5,
            useHeadless: true, passwordMode: 'fixed', fixedPassword: 'x',
            debugProxy: false, psiphonRegions: [],
        }));
        if (stopAfterMs) { await sleep(stopAfterMs); ws.send(JSON.stringify({ action: 'stop' })); }
        const race = await Promise.race([events, sleep(40000).then(() => 'TIMEOUT')]);
        if (race === 'TIMEOUT') throw new Error('batch tidak selesai dalam 40 detik');
        return {
            first: pick(first), last: pick(last), statusText: last.status,
            finalStatus: race, sawBlockedLog, sawBlockedStatus,
        };
    } finally {
        ws.close();
    }
}

(async () => {
    // ── A: anggaran = RENTETAN tanpa keberhasilan, dan tiap kegagalan LANGSUNG
    //    dihitung + diberi label kelasnya. STUB_SEQ error,limit,verif untuk SATU
    //    email target: percobaan 1 ERROR, percobaan 2 Blocked, percobaan 3 VERIF
    //    -> akun jadi, jadi batch selesai sendiri (bukan 'stopped').
    const a = await runBatch({
        alias: 'probeA', globalRetry: 3,
        emails: [`a1@${DOMAIN}`],
    });
    check('A batch selesai karena target tercapai', a.finalStatus, 'success');
    check('A penghitung akhir (sukses/blocked/error/verif)', a.last, { success: 0, limit: 1, error: 1, verif: 1 });
    check('A log menyebut kelas batas Dropbox sebagai Blocked', a.sawBlockedLog, true);
    check('A status UI menyebut Gagal Blocked', a.sawBlockedStatus, true);

    // ── B: state yang dibaca halaman baru = hasil batch tadi, BUKAN nol.
    const b = await readSyncState();
    check('B sync_state mempertahankan penghitung', b.counts, { success: 0, limit: 1, error: 1, verif: 1 });

    // ── C: Hentikan SAAT percobaan sedang berjalan = tidak ada yang dihitung.
    //    STUB_DELAY_MS=1000, Hentikan pada 0,5 dtk: panggilan #4 masih berjalan,
    //    jadi kegagalannya tidak dihitung (tidak ada record), dan batch langsung
    //    ditutup dengan ringkasan 'Batch dihentikan.'.
    await sleep(500);
    const c = await runBatch({
        alias: 'probeC', globalRetry: 3, stopAfterMs: 500,
        emails: [`c1@${DOMAIN}`],
    });
    check('C status batch', c.finalStatus, 'stopped');
    check('C teks ringkasan', c.statusText, 'Batch dihentikan.');
    check('C percobaan yang dipotong Hentikan tidak dihitung',
        c.last, { success: 0, limit: 0, error: 0, verif: 0 });
    const cState = await readSyncState();
    check('C sync_state setelah Hentikan', cState.status, 'Dihentikan');
    check('C penghitung di state setelah Hentikan', cState.counts, { success: 0, limit: 0, error: 0, verif: 0 });

    // ── C2: Hentikan di antara dua percobaan: kegagalan yang SUDAH tercatat tetap
    //    dihitung, dan percobaan BERIKUTNYA tidak pernah dijalankan. Panggilan #5
    //    ('limit') gagal di ~1 dtk dan dihitung sebagai Blocked; Hentikan pada
    //    1,5 dtk mendarat di jeda antar percobaan (2 dtk) sehingga panggilan #6
    //    ('success') tidak pernah terjadi — success=0 membuktikannya.
    await sleep(500);
    const c2 = await runBatch({
        alias: 'probeC2', globalRetry: 3, stopAfterMs: 1500,
        emails: [`c2@${DOMAIN}`],
    });
    check('C2 kegagalan sebelum Hentikan tetap tercatat', c2.finalStatus, 'stopped');
    await sleep(3000);   // tunggu loop batch benar-benar selesai
    const c2State = await readSyncState();
    check('C2 tidak ada percobaan baru setelah Hentikan (blocked=1, success=0)',
        c2State.counts, { success: 0, limit: 1, error: 0, verif: 0 });

    // ── D: mulai batch baru = SATU-satunya yang mereset.
    await sleep(500);
    const d = await runBatch({ alias: 'probeD', globalRetry: 1, stopAfterMs: 1500, emails: [`success6@${DOMAIN}`] });
    check('D payload pertama batch baru sudah nol', d.first, { success: 0, limit: 0, error: 0, verif: 0 });

    console.log(failures === 0 ? '\nSEMUA PEMERIKSAAN LOLOS' : `\n${failures} PEMERIKSAAN GAGAL`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE ERR:', e.message); process.exit(2); });
