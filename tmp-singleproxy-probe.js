// Probe: kirim satu batch ke server (argv[4]) dengan register.js yang distub,
// lalu cetak urutan log + event supaya urutan jalur bisa diperiksa.
// pakai: node tmp-singleproxy-probe.js <proxyMode> <globalRetry> <port> [useDirect]
//   useDirect=false = Direct dilepas: SEMUA percobaan harus lewat proxy itu.
const WebSocket = require('ws');
const proxyMode = process.argv[2] || 'warp';
const globalRetry = parseInt(process.argv[3] || '3', 10);
const PORT = parseInt(process.argv[4] || '3000', 10);
const useDirect = process.argv[5] !== 'false';

const ws = new WebSocket('ws://localhost:' + PORT);
let done = false;
let seenActivity = false;
ws.on('open', () => {
    ws.send(JSON.stringify({
        action: 'start',
        alias: 'probe',
        url: 'https://www.dropbox.com/referrals/test',
        emails: 'slot.satu@surel.gudangpemaron.my.id;slot.dua@surel.gudangpemaron.my.id',
        emailMode: 'manual',
        proxyMode,
        useDirect,
        globalRetry,
        globalTimeout: 5,
        daemonTimeout: 5,
        useHeadless: true,
        passwordMode: 'fixed',
        fixedPassword: 'x',
        debugProxy: false,
        psiphonRegions: [],
    }));
});
ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (m.type === 'log') { seenActivity = true; console.log(m.message); }
    else if (m.type === 'progress') console.log(`>> progress ${m.current}/${m.total} "${m.status}" sukses=${m.successCount} limit=${m.limitCount} error=${m.errorCount} verif=${m.verifCount}`);
    else if (m.type === 'status') {
        console.log(`>> status=${m.status}`);
        if (m.status === 'stopped' || m.status === 'error' || m.status === 'success' || (m.status === 'idle' && seenActivity)) { done = true; ws.close(); process.exit(0); }
    }
});
setTimeout(() => { console.log('>> probe timeout'); process.exit(done ? 0 : 1); }, 40000);
