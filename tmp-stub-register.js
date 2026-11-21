// Preload stub: engine palsu supaya urutan percobaan (Direct -> jalur proxy
// tunggal) DAN penghitung UI (Sukses / Limit / Error) bisa diuji tanpa
// browser/jaringan. Dimuat lewat tmp-stub-loader.js.
//
// Hasil sebuah email ditentukan dari nama lokalnya: awalan token = kunci
// OUTCOMES di bawah, contoh `success1@…`, `verif2@…`, `error3@…`, `limit4@…`.
// Email tanpa token yang dikenal memakai rencana dari env STUB_PLAN
// (default: semua 'limit' — sama seperti stub semula, dipakai QA 2b).
//
// STUB_DELAY_MS = jeda per panggilan, supaya "Hentikan" di tengah batch bisa
// diuji. Contoh QA:
//   STUB_DELAY_MS=1000 NODE_OPTIONS="--require $PWD/tmp-stub-loader.js" PORT=3007 node server.js
//   node tmp-counter-probe.js 3007
const OUTCOMES = {
    // sukses penuh: akun jadi + verifikasi terkirim
    success: () => ({ success: true, status: 'success', password: 'pw-stub', ip: global.currentExitIp || '', ua: 'stub-ua' }),
    // akun jadi tapi verifikasi tidak terkonfirmasi -> tetap dihitung selesai
    verif: () => ({ success: true, status: 'VERIF', password: 'pw-stub', ip: global.currentExitIp || '', ua: 'stub-ua' }),
    // batas halaman Dropbox -> LIMIT
    limit: () => { throw new Error('BROWSER_KILL_REQUIRED: Too many attempts. Please try later.'); },
    // CAPTCHA di mode headless tidak ada yang menyelesaikannya -> LIMIT
    captcha: () => { throw new Error('BROWSER_KILL_REQUIRED: CAPTCHA_DETECTED: CAPTCHA terlihat di halaman — tidak ada yang menyelesaikannya (mode headless).'); },
    // kegagalan teknis (timeout daemon) -> ERROR, BUKAN LIMIT
    error: () => { throw new Error('[dropboxd] Timeout 5 detik - URL cli_link tidak muncul'); },
    // percobaan pertama error, sisanya limit: yang menentukan kelas email adalah
    // kegagalan percobaan TERAKHIR, jadi ini harus dihitung LIMIT.
    errthenlimit: (isRetry) => (isRetry
        ? OUTCOMES.limit()
        : OUTCOMES.error()),
};

const plan = String(process.env.STUB_PLAN || 'limit').split(',')
    .map((token) => token.trim()).filter(Boolean);
const unknown = plan.filter((token) => !OUTCOMES[token]);
if (unknown.length) {
    throw new Error(`STUB_PLAN token tidak dikenal: ${unknown.join(', ')} (pilihan: ${Object.keys(OUTCOMES).join(', ')})`);
}
// Urutan hasil per NOMOR PANGGILAN (1-based), mengalahkan token nama email:
// STUB_SEQ=limit,error,success,success menguji anggaran rentetan (dua gagal,
// lalu berhasil -> hitungan harus di-reset) tanpa bergantung pada nama email.
// Item terakhir dipakai untuk panggilan selanjutnya.
const seq = String(process.env.STUB_SEQ || '').split(',')
    .map((token) => token.trim()).filter(Boolean);
const unknownSeq = seq.filter((token) => !OUTCOMES[token]);
if (unknownSeq.length) {
    throw new Error(`STUB_SEQ token tidak dikenal: ${unknownSeq.join(', ')} (pilihan: ${Object.keys(OUTCOMES).join(', ')})`);
}
const delayMs = parseInt(process.env.STUB_DELAY_MS || '0', 10);

// Jembatan IP keluar yang sama dengan engine sungguhan (global.currentExitIp):
// server mencatatnya ke record riwayat, jadi satu percobaan yang gagal HARUS punya
// IP-nya sendiri di Riwayat. STUB_NO_IP=2,5 = panggilan yang MATI sebelum ada IP
// terukur (proxy mati / tab tidak terbuka) -> recordnya tidak boleh punya IP ('-').
const noIp = new Set(String(process.env.STUB_NO_IP || '').split(',')
    .map((s) => parseInt(s.trim(), 10)).filter((x) => Number.isFinite(x)));

// Token dari nama lokal email: 'success1' -> 'success', 'errthenlimit3' -> 'errthenlimit'.
function outcomeOf(email, isRetry) {
    const token = String(email).split('@')[0].match(/^([a-z]+)/);
    const hit = token && OUTCOMES[token[1]];
    if (hit) return hit(isRetry);
    const fallback = plan[0] && OUTCOMES[plan[0]] ? plan[0] : 'limit';
    return OUTCOMES[fallback](isRetry);
}

let n = 0;

module.exports = {
    getRandomName: () => ({ first: 'slot', last: 'satu' }),
    registerSingleEmail: async (url, email, proxyType, proxyHost, abortController, useHeadless,
        passwordMode, fixedPassword, globalTimeout, daemonTimeout, alias, maxAttempts, isRetry) => {
        n++;
        console.log(`[stub] panggilan #${n}: email=${email} jalur=${proxyType} isRetry=${isRetry} maxAttempts=${maxAttempts}`);
        // IP keluar percobaan ini (203.0.113.<n>) — kecuali yang ditandai STUB_NO_IP.
        global.currentExitIp = noIp.has(n) ? '' : `203.0.113.${n}`;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (seq.length) return OUTCOMES[seq[Math.min(n, seq.length) - 1]]();
        return outcomeOf(email, isRetry);
    },
};
