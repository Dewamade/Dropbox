// Jaminan "profil dibuang setelah selesai + start berikutnya benar-benar kosong":
//   A. sesi nyata diisi cookies + localStorage, TIDAK ditutup → state tertinggal di disk
//   B. ensureRunning() berikutnya → semua state dibuang (marker di 4 dir ikut hilang)
//   C. sesi dibuka lagi dengan userId SAMA → tanpa cookie, tanpa localStorage
//   D. jalur normal (cf.destroy + cleanupProfile) → tidak ada direktori tersisa
const fs = require('fs');
const path = require('path');
const camofox = require('./camofox-manager');
const { CamofoxClient } = require('./camofox-client');

const DATA = path.join(__dirname, 'camofox-data');
const count = (d) => { try { return fs.readdirSync(path.join(DATA, d)).length; } catch (_) { return -1; } };
const ID = 'probe-fresh-' + Date.now();
let failures = 0;
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} = ${JSON.stringify(got)}${ok ? '' : `  (harusnya ${JSON.stringify(want)})`}`);
    if (!ok) failures++;
};
const readState = async (cf) => ({ cookie: await cf.evaluate('document.cookie'), ls: await cf.evaluate('Object.keys(localStorage).join(",")') });

(async () => {
    let cf = null;
    try {
        // (start bersih: ensureRunning membuang state run-run sebelumnya)
        let base = await camofox.ensureRunning({});
        check('start awal: state kosong', ['profiles', 'cookies', 'uploads', 'traces'].map(count), [0, 0, 0, 0]);

        // A. sesi nyata, identitas diisi, TIDAK ditutup → server shutdown
        cf = new CamofoxClient({ baseUrl: base, userId: ID });
        await cf.createTab('https://example.com');
        await cf.settle({ timeoutMs: 15000 });
        await cf.evaluate('document.cookie = "farm=1"');
        await cf.evaluate('localStorage.setItem("farmKey", "1")');
        check('identitas benar-benar terisi', await readState(cf), { cookie: 'farm=1', ls: 'farmKey' });
        await camofox.stop();
        const dirA = camofox.profileDirFor(ID);
        const saved = fs.existsSync(path.join(dirA, 'storage-state.json'));
        console.log(`   state di disk setelah sesi tidak ditutup: profiles=${count('profiles')} storage-state.json=${saved}`);
        if (!saved) console.log('   (catatan: server shutdown tidak checkpointing — uji B tetap jalan lewat marker)');

        // B. marker di semua dir state + state sesi lama → ensureRunning berikutnya
        for (const p of ['profiles/marker/x', 'cookies/marker.txt', 'uploads/marker.txt', 'traces/marker/x']) {
            const full = path.join(DATA, p);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, 'sampah');
        }
        base = await camofox.ensureRunning({});
        check('start berikutnya: semua state dibuang', ['profiles', 'cookies', 'uploads', 'traces'].map(count), [0, 0, 0, 0]);

        // C. userId SAMA, masih ada sisa? (harus tidak)
        cf = new CamofoxClient({ baseUrl: base, userId: ID });
        await cf.createTab('https://example.com');
        await cf.settle({ timeoutMs: 15000 });
        check('sesi baru dengan userId sama: tanpa cookie/localStorage', await readState(cf), { cookie: '', ls: '' });

        // D. jalur completion: destroy saja menyisakan direktori, cleanupProfile menghapusnya
        await cf.destroy(); cf = null;
        const afterDestroy = fs.existsSync(dirA);
        camofox.cleanupProfile(ID);
        check('completion: destroy menyisakan direktori, cleanupProfile menghapusnya', { afterDestroy, afterCleanup: fs.existsSync(dirA), profiles: count('profiles') }, { afterDestroy: true, afterCleanup: false, profiles: 0 });

        await camofox.stop();
    } finally {
        if (cf) await cf.destroy().catch(() => { });
        camofox.cleanupProfile(ID);
        await camofox.stop();
    }
    console.log(failures === 0 ? '\nSEMUA PEMERIKSAAN LOLOS' : `\n${failures} PEMERIKSAAN GAGAL`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => { console.error('PROBE ERR:', e.message); await camofox.stop(); process.exit(2); });
