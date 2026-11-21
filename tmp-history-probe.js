// Probe: satu PERCOBAAN = satu record riwayat, dan record gagal harus menyebut
// IP keluar percobaan itu (Blocked = IP yang ditolak Dropbox; Error yang terjadi
// sebelum ada IP terukur = kosong, yang di tabel jadi '-'). plus: flag
// `lastBatchStopped` yang dipakai label TERHENTI di UI.
//
// Tidak perlu browser/jaringan — engine distub (tmp-stub-loader.js) dan IP keluar
// dibuat per panggilan (203.0.113.<nomor panggilan>), jadi nilainya diharapkan
// persis. Jalankan dengan urutan yang sama seperti di bawah (nomor panggilan
// dihitung per proses server):
//
//   STUB_SEQ="limit,error,success,success" STUB_NO_IP=2 STUB_DELAY_MS=300 \
//     NODE_OPTIONS="--require $PWD/tmp-stub-loader.js" PORT=3007 node server.js
//   node tmp-history-probe.js 3007
//
// Skenario:
//  A  target 1 akun, globalRetry 2 -> panggilan #1 limit (IP .1), #2 error TANPA
//     IP (STUB_NO_IP=2) -> rentetan habis, batch berhenti: kedua record gagal
//     tercatat dengan IP-nya masing-masing dan lastBatchStopped=true.
//  B  target 1 akun, globalRetry 3 -> panggilan #3 success (IP .3) -> target
//     tercapai: record sukses membawa IP-nya dan lastBatchStopped=false.
const WebSocket = require('ws');
const PORT = parseInt(process.argv[2] || '3007', 10);
const DOMAIN = 'surel.gudangpemaron.my.id';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALIAS = `probe-hist-${Date.now()}`;

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} = ${JSON.stringify(actual)}${ok ? '' : `  (harusnya ${JSON.stringify(expected)})`}`);
}

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', (e) => reject(e));
    });
}

// state yang dilihat halaman yang di-refresh: label worker + flag TERHENTI.
async function readSyncState() {
    const ws = await connect();
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('sync_state tidak datang')), 8000);
            ws.on('message', (buf) => {
                let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
                if (m.type === 'sync_state') {
                    clearTimeout(timer);
                    resolve({ workerStatus: m.workerStatus, lastBatchStopped: !!m.state.lastBatchStopped });
                }
            });
        });
    } finally {
        ws.close();
    }
}

async function runBatch({ emails, globalRetry }) {
    const ws = await connect();
    try {
        const done = new Promise((resolve) => {
            let timer = null;
            ws.on('message', (buf) => {
                let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
                if (m.type === 'status' && ['stopped', 'success', 'error'].includes(m.status)) {
                    clearTimeout(timer);
                    timer = setTimeout(() => resolve(m.status), 1200);
                }
            });
        });
        ws.send(JSON.stringify({
            action: 'start', alias: ALIAS,
            url: 'https://www.dropbox.com/referrals/test',
            emails: emails.join(';'), emailMode: 'manual',
            proxyMode: 'none', useDirect: true, globalRetry, globalTimeout: 5, daemonTimeout: 5,
            useHeadless: true, passwordMode: 'fixed', fixedPassword: 'x',
            debugProxy: false, psiphonRegions: [],
        }));
        const race = await Promise.race([done, sleep(40000).then(() => 'TIMEOUT')]);
        if (race === 'TIMEOUT') throw new Error('batch tidak selesai dalam 40 detik');
        return race;
    } finally {
        ws.close();
    }
}

const historyForAlias = async () => {
    const res = await fetch(`http://localhost:${PORT}/api/history`);
    const all = await res.json();
    return all.filter((r) => r.alias === ALIAS);
};

(async () => {
    // ── A: dua kegagalan berurutan (limit dengan IP, error tanpa IP) ──────────
    const a = await runBatch({ emails: [`slot.satu@${DOMAIN}`], globalRetry: 2 });
    check('A batch berhenti karena rentetan habis', a, 'stopped');
    const recA = await historyForAlias();
    check('A dua record tercatat', recA.length, 2);
    const blocked = recA.find((r) => r.failClass === 'limit') || {};
    const errRec = recA.find((r) => r.failClass === 'error') || {};
    check('A record Blocked status + kelas', { status: blocked.status, failClass: blocked.failClass },
        { status: 'failed', failClass: 'limit' });
    // Ini inti perubahan: Blocked menunjuk IP keluar yang benar-benar dicoba.
    check('A Blocked menyebut IP keluar percobaan itu', blocked.ip, '203.0.113.1');
    check('A Blocked menyebut jalurnya', blocked.connection, 'direct');
    check('A Error tanpa IP terukur = kosong (tabel tampil "-")', errRec.ip, '');
    check('A Error tetap menyebut jalurnya', errRec.connection, 'direct');
    const sA = await readSyncState();
    check('A label worker FINISH + flag stopped (TERHENTI)', sA, { workerStatus: 'FINISH', lastBatchStopped: true });

    // ── B: target tercapai -> tidak boleh berhenti ────────────────────────────
    const b = await runBatch({ emails: [`slot.dua@${DOMAIN}`], globalRetry: 3 });
    check('B target tercapai', b, 'success');
    const recB = await historyForAlias();
    const okRec = recB.find((r) => r.status === 'success') || {};
    check('B record sukses membawa IP-nya', { ip: okRec.ip, connection: okRec.connection },
        { ip: '203.0.113.3', connection: 'direct' });
    const sB = await readSyncState();
    check('B flag stopped direset oleh batch baru', sB, { workerStatus: 'FINISH', lastBatchStopped: false });

    await sleep(300);
    console.log(failures === 0 ? '\nSEMUA PEMERIKSAAN LOLOS' : `\n${failures} PEMERIKSAAN GAGAL`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE ERR:', e.message); process.exit(2); });
