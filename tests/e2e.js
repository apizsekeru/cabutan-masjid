/* =====================================================================
   Ujian end-to-end — Ganjaran Ilmu Jemaah Masjid (MOD DEMO, beberapa tab)
   Jalankan:  cd tests && npm install && npm run test:e2e          (mod demo)
              MODE=supabase GIJ_PIN=1234 node e2e.js                (projek Supabase sebenar)
   Pelayar : Microsoft Edge / Chrome yang sedia dipasang (BROWSER=chrome untuk Chrome)
   Setiap "telefon" jemaah = tab dengan ?dev=X (storan peranti berasingan,
   pangkalan data & BroadcastChannel dikongsi seperti pelayan).
   Tangkapan skrin & fail muat turun disimpan dalam tests/out/.
   ===================================================================== */
if (process.env.MODE === 'supabase') { require('./e2e-supabase.js'); return; } // MODE=supabase → projek Supabase sebenar
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8787;
const BASE = `http://localhost:${PORT}/index.html`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    // Mod demo: kosongkan CONFIG Supabase supaya ujian tidak menyentuh pangkalan data sebenar
    if (f.endsWith('index.html')) b = Buffer.from(b.toString('utf8').replace(/SUPABASE_URL: '[^']*'/, "SUPABASE_URL: ''").replace(/SUPABASE_ANON_KEY: '[^']*'/, "SUPABASE_ANON_KEY: ''"));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(b);
  });
});

const results = [], errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, msg) { if (!c) throw new Error(msg); }
let shotPage = null;
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(['PASS', name]); console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) {
    results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n    ', e.message.split('\n')[0]);
    try { if (shotPage) await shotPage.screenshot({ path: path.join(OUT, 'FAIL-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + '.png'), fullPage: true }); } catch {}
  }
}
function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`[${label}] HTTP ${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => { errors.push(`[${label}] dialog pelayar tidak dijangka: ${d.message()}`); d.dismiss(); });
}
const screenOf = (p) => p.evaluate(() => document.querySelector('.jwrap')?.dataset.screen || null);
async function waitScreen(p, name, timeout = 4000) {
  await p.waitForFunction((n) => document.querySelector('.jwrap')?.dataset.screen === n, name, { timeout }).catch(async () => { throw new Error(`skrin "${name}" tidak muncul (kini: ${await screenOf(p)})`); });
}
async function confirmModal(p) { await p.locator('.modal .btn-row .btn').last().click(); await sleep(200); }
const db = (p) => p.evaluate(() => LocalAPI.read());

(async () => {
  server.listen(PORT);
  const launchOpts = process.env.EXECUTABLE_PATH
    ? { executablePath: process.env.EXECUTABLE_PATH, headless: true }
    : { channel: process.env.BROWSER === 'chrome' ? 'chrome' : 'msedge', headless: true };
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const newPage = async (label, url) => { const p = await ctx.newPage(); watch(p, label); if (url) { await p.goto(url); await sleep(300); } return p; };
  const admin = await newPage('ajk', BASE + '#admin');
  shotPage = admin;

  /* ---------- 0. Migrasi data lama (v2 → v3) ---------- */
  await step('0. Migrasi: data localStorage v2 dinaik taraf, rahsia peserta stabil', async () => {
    await admin.evaluate(() => {
      const v2 = { schemaVersion: 2, settings: { masjidName: 'Masjid Lama', pinHash: hashPin('1234'), tokenSecret: 'abc', streak: { threshold: 3, bonus: 2 }, geo: { enabled: false, lat: null, lng: null, radius: 150 } },
        templates: [{ id: 't_old', name: 'Jumaat', title: 'Jumaat', speaker: '', weekday: 5, startTime: '13:30', endTime: '14:30', prizes: ['X'] }],
        sessions: [{ id: 's_lama', templateId: 't_old', title: 'Sesi Lama', speaker: '', date: '2026-01-02', startTime: '13:30', endTime: '14:30', transcript: '', summary: [], prizes: ['X'], published: true },
          { id: 's_hari', templateId: 't_old', title: 'Sesi Hari Ini', speaker: '', date: ymd(new Date()), startTime: '00:00', endTime: '23:59', transcript: '', summary: [], prizes: ['X'], published: true },
          { id: 's_draf', templateId: null, title: 'Draf', speaker: '', date: '2026-12-01', startTime: '10:00', endTime: '10:30', transcript: '', summary: [], prizes: [], published: false }],
        questions: [], participants: [{ id: 'p_old', name: 'Pak Lama', phone: '0123456789', createdAt: '2026-01-02T05:00:00Z' }],
        registrations: [{ id: 'r_old', sessionId: 's_lama', participantId: 'p_old', regNo: 1, checkinAt: '2026-01-02T05:00:00Z', tokenSlot: 5, geoDist: 12, createdAt: '2026-01-02T05:00:00Z' }],
        answers: [], winners: [{ id: 'w_old', sessionId: 's_lama', participantId: 'p_old', prize: 'X', order: 1, createdAt: '2026-01-02T06:00:00Z' }] };
      localStorage.clear(); sessionStorage.clear(); localStorage.setItem('cbj_db_v1', JSON.stringify(v2));
    });
    await admin.reload(); await sleep(300);
    const a = await db(admin), b = await db(admin);
    const st = Object.fromEntries(a.sessions.map((s) => [s.id, s.state]));
    assert(a.schemaVersion === 3, 'versi skema bukan 3');
    assert(st.s_lama === 'done' && st.s_hari === 'registration' && st.s_draf === 'draft', 'pemetaan keadaan salah: ' + JSON.stringify(st));
    assert(a.participants[0].secret && a.participants[0].secret === b.participants[0].secret, 'rahsia peserta tidak stabil antara bacaan');
    assert(a.registrations[0].dist === 12 && !('tokenSlot' in a.registrations[0]), 'pendaftaran tidak dimigrasi');
    assert(a.winners[0].revealAt && a.sessions.every((s) => !('published' in s) && s.answerMinutes >= 1), 'medan baharu tiada');
    assert(a.settings.masjidName === 'Masjid Lama', 'tetapan hilang');
  });

  /* ---------- Mula bersih ---------- */
  await admin.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await admin.goto(BASE + '#admin'); await admin.reload(); await sleep(300);
  const TEXT = await admin.evaluate(() => DEMO_TEXTS[0]);
  let sid;

  /* ---------- 1. AJK: login → templat → sesi → jana & lulus → buka pendaftaran ---------- */
  await step('1a. AJK: PIN salah ditolak, betul diterima', async () => {
    await admin.fill('#pin', '0000'); await admin.click('#pinForm button'); await sleep(250);
    assert(await admin.locator('#pin').count() === 1, 'PIN salah diterima');
    await admin.fill('#pin', '1234'); await admin.click('#pinForm button'); await sleep(400);
    assert(await admin.locator('.atabs').count() === 1, 'panel tidak dibuka');
  });
  await step('1b. Templat: simpan kosong ditolak, templat dicipta', async () => {
    await admin.click('.atab[href="#admin?tab=templat"]'); await sleep(300);
    await admin.click('#btnNewTpl'); await sleep(150);
    await confirmModal(admin);
    assert(await admin.locator('#tplForm').count() === 1, 'modal ditutup walaupun kosong');
    await admin.fill('#tName', 'Khutbah Jumaat'); await admin.fill('#tTitle', 'Khutbah Jumaat'); await admin.fill('#tSpeaker', 'Imam Muda');
    await admin.selectOption('#tDay', '5'); await admin.fill('#tStart', '13:30'); await admin.fill('#tEnd', '14:30'); await admin.fill('#tMin', '5');
    await admin.fill('#tPrizes', 'Sejadah\nAl-Quran\nBaucar RM30\nKopiah');
    await confirmModal(admin); await sleep(300);
    const t = (await db(admin)).templates;
    assert(t.length === 1 && t[0].prizes.length === 4 && t[0].weekday === 5, 'templat salah');
  });
  await step('1c. Sesi dicipta daripada templat dengan 1 klik', async () => {
    await admin.click('[data-tact="use"]'); await sleep(500);
    const s = (await db(admin)).sessions[0];
    assert(s && s.templateId && s.prizes.length === 4 && s.state === 'draft' && new Date(s.date + 'T00:00').getDay() === 5, 'sesi tidak ikut templat');
    sid = s.id;
    assert(await admin.locator('#btn1Click').count() === 1, 'tidak terus ke tab soalan');
  });
  await step('1d. Mod 1 klik: teks pendek ditolak; jana 4 soalan + lulus + ringkasan', async () => {
    await admin.fill('#transcript', 'teks pendek'); await admin.click('#btn1Click'); await sleep(300);
    assert((await db(admin)).questions.length === 0, 'soalan dijana daripada teks pendek');
    await admin.fill('#transcript', TEXT); await admin.selectOption('#qN', '4');
    await admin.click('#btn1Click'); await sleep(1200);
    const d = await db(admin), qs = d.questions.filter((q) => q.sessionId === sid);
    assert(qs.length === 4 && qs.every((q) => q.status === 'lulus'), 'soalan tidak dijana/diluluskan: ' + qs.length);
    assert(d.sessions[0].summary.length >= 3 && d.sessions[0].transcript.length > 100, 'ringkasan/transkrip tidak disimpan');
  });
  await step('1e. Sunting soalan disimpan; had 5 soalan; soalan kosong tidak boleh lulus', async () => {
    const first = admin.locator('.q-card textarea').first();
    await first.fill('Soalan disunting oleh AJK?'); await sleep(700);
    assert((await db(admin)).questions.some((q) => q.text === 'Soalan disunting oleh AJK?'), 'suntingan tidak disimpan');
    await admin.click('#btnAddQ'); await sleep(400);
    assert(await admin.locator('#btnAddQ').isDisabled(), 'butang tambah tidak dimatikan pada 5');
    await admin.locator('.q-card.is-draft [data-act="approve"]').click(); await sleep(250);
    assert((await db(admin)).questions.filter((q) => q.status === 'lulus').length === 4, 'soalan kosong diluluskan');
    await admin.locator('.q-card.is-draft [data-act="delete"]').click(); await sleep(150); await confirmModal(admin); await sleep(300);
    assert((await db(admin)).questions.length === 4, 'padam soalan gagal');
  });
  await step('1f. Langsung: Buka Soalan disekat semasa draf; Buka Pendaftaran berjaya', async () => {
    await admin.click('.atab[href="#admin?tab=langsung"]'); await sleep(400);
    assert(await admin.locator('[data-to="questions"]').isDisabled(), 'Buka Soalan tidak disekat');
    await admin.click('[data-to="registration"]'); await sleep(400);
    assert((await db(admin)).sessions[0].state === 'registration', 'pendaftaran tidak dibuka');
    assert(await admin.locator('.step.now').textContent() === 'Pendaftaran', 'stepper salah');
  });

  /* ---------- 2. Skrin besar + 3 tab jemaah ---------- */
  const skrin = await newPage('skrin', `${BASE}#skrin?s=${sid}`);
  let qrUrl;
  const devUrl = (dev, url) => url.replace('index.html#', `index.html?dev=${dev}#`);
  await step('2a. Skrin besar: login PIN, QR dinamik dipapar', async () => {
    await skrin.fill('#pin', '1234'); await skrin.click('#pinForm button'); await sleep(800);
    await skrin.waitForFunction(() => document.querySelector('#qrBig')?.dataset.url && document.querySelector('#qrBig img, #qrBig canvas'), null, { timeout: 4000 });
    qrUrl = await skrin.evaluate(() => document.querySelector('#qrBig').dataset.url);
    assert(/#j\?s=.+&t=\d+-[0-9a-f]+$/.test(qrUrl), 'URL QR salah: ' + qrUrl);
    assert(await skrin.locator('text=Penyertaan PERCUMA').count() > 0, 'nota percuma tiada');
  });
  const J = {};
  await step('2b. Token tamat / palsu / tiada ditolak', async () => {
    const sec = await admin.evaluate(() => LocalAPI.read().settings.tokenSecret);
    const oldTok = await admin.evaluate(([s, id]) => Token.make(s, id, Token.slot() - 3), [sec, sid]);
    const E = await newPage('jemaah-E', devUrl('E', qrUrl.replace(/t=.*$/, 't=' + oldTok)));
    await waitScreen(E, 'tokenbad'); assert(await E.locator('text=tamat tempoh').count() === 1, 'mesej tamat tempoh tiada');
    await E.goto(devUrl('E', qrUrl.replace(/-[0-9a-f]+$/, '-deadbeef1234'))); await sleep(400);
    await waitScreen(E, 'tokenbad'); assert(await E.locator('text=Kod QR tidak sah').count() === 1, 'token palsu tidak ditolak');
    const G = await newPage('jemaah-G', `${BASE}?dev=G#j`);
    await waitScreen(G, 'scan');
    await G.goto(devUrl('G', qrUrl.replace(/&t=.*$/, ''))); await sleep(400);
    await waitScreen(G, 'scan'); // tanpa token → minta imbas
    await E.close(); await G.close();
  });
  await step('2c. Jemaah A: input kosong & telefon salah ditolak, daftar baharu', async () => {
    const A = J.A = await newPage('jemaah-A', devUrl('A', qrUrl));
    await waitScreen(A, 'daftar');
    await A.click('#regForm button[type=submit]'); await sleep(150);
    assert(await A.locator('#fPhone .error:not(.hidden)').count() === 1, 'telefon kosong diterima');
    for (const bad of ['12345', '0312345678', '011-1234567', 'abc']) {
      await A.fill('#phone', bad); await A.click('#regForm button[type=submit]'); await sleep(120);
      assert(await A.locator('#fPhone .error:not(.hidden)').count() === 1, 'telefon salah diterima: ' + bad);
    }
    await A.fill('#phone', '+60 12-777 8888'); await A.click('#regForm button[type=submit]'); await sleep(300);
    await A.click('#regForm button[type=submit]'); await sleep(150);
    assert(await A.locator('#fName .error:not(.hidden)').count() === 1, 'nama kosong diterima');
    await A.fill('#name', '  Ali   bin Abu '); await A.click('#regForm button[type=submit]');
    await waitScreen(A, 'tunggu_soalan');
    const d = await db(A); assert(d.participants[0].name === 'Ali bin Abu' && d.participants[0].phone === '0127778888', 'data peserta salah');
  });
  await step('2d. Jemaah B & C daftar; kiraan hadir AJK & skrin dikemas kini serta-merta', async () => {
    for (const [k, phone, name] of [['B', '0139990000', 'Siti Aminah'], ['C', '0145556666', 'Haji Osman']]) {
      const P = J[k] = await newPage('jemaah-' + k, devUrl(k, qrUrl));
      await waitScreen(P, 'daftar');
      await P.fill('#phone', phone); await P.click('#regForm button[type=submit]'); await sleep(250);
      await P.fill('#name', name); await P.click('#regForm button[type=submit]');
      await waitScreen(P, 'tunggu_soalan');
    }
    await admin.waitForFunction(() => document.querySelector('#lvHadir')?.textContent === '3', null, { timeout: 3000 });
    await skrin.waitForFunction(() => /3 jemaah hadir/.test(document.querySelector('#skCount')?.textContent || ''), null, { timeout: 3000 });
  });
  await step('2e. Refresh jemaah semasa menunggu → skrin sama', async () => {
    await J.A.reload(); await waitScreen(J.A, 'tunggu_soalan');
    assert(await J.A.locator('text=Ali bin Abu').count() > 0, 'nama tidak dipapar');
  });

  /* ---------- 3. Buka soalan: semua tab terima serentak ---------- */
  await step('3a. AJK Buka Soalan → 3 tab jemaah & skrin bertukar serentak (<2.5s)', async () => {
    await admin.click('[data-to="questions"]'); await sleep(150); await confirmModal(admin);
    const t0 = Date.now();
    await Promise.all(['A', 'B', 'C'].map((k) => waitScreen(J[k], 'soalan', 2500)));
    await skrin.waitForSelector('.sq-card', { timeout: 2500 });
    console.log(`     serentak dalam ${Date.now() - t0} ms`);
  });
  const correctOf = async (p) => p.evaluate((s) => Object.fromEntries(LocalAPI.read().questions.filter((q) => q.sessionId === s && q.status === 'lulus').map((q) => [q.id, q.correctIndex])), sid);
  async function answer(p, plan) { // plan: array of true/false (betul/salah) atau null (langkau tidak dibenarkan)
    const correct = await correctOf(p);
    for (let i = 0; i < plan.length; i++) {
      const qid = await p.evaluate(() => { const b = document.querySelector('.opt'); return b ? J.view.questions[document.querySelector('.timer-bar b').textContent - 1].id : null; });
      const want = plan[i] ? correct[qid] : (correct[qid] + 1) % 4;
      await p.click(`.opt[data-i="${want}"]`); await sleep(80);
      await p.click('#nextQ'); await sleep(150);
    }
  }
  await step('3b. Satu soalan satu skrin; pilihan dirawak setiap peserta', async () => {
    assert(await J.A.locator('.opt').count() === 4 && await J.A.locator('.q-text').count() === 1, 'bukan satu soalan satu skrin');
    const oA = await J.A.evaluate(() => J.view.questions.map((q) => q.options.map((o) => o.i).join('')).join('|'));
    const oB = await J.B.evaluate(() => J.view.questions.map((q) => q.options.map((o) => o.i).join('')).join('|'));
    assert(oA !== oB, 'susunan pilihan sama untuk A & B');
    assert(!(await J.A.evaluate(() => JSON.stringify(J.view))).includes('correctIndex'), 'jawapan betul bocor ke telefon');
  });
  await step('3c. A jawab 4/4 betul → Menunggu cabutan, 4 tiket', async () => {
    await answer(J.A, [true, true, true, true]);
    await waitScreen(J.A, 'tunggu_cabutan');
    assert((await J.A.textContent('.ticket-count')).trim() === '4', 'tiket A salah: ' + await J.A.textContent('.ticket-count'));
  });
  await step('3d. B refresh di tengah soalan → kembali ke soalan 2 dengan jawapan disimpan; 1 tiket', async () => {
    await answer(J.B, [true]);
    await J.B.reload(); await waitScreen(J.B, 'soalan');
    assert((await J.B.textContent('.timer-bar b')).trim() === '2', 'tidak kembali ke soalan 2');
    await answer(J.B, [false, false, false]);
    await waitScreen(J.B, 'tunggu_cabutan');
    assert((await J.B.textContent('.ticket-count')).trim() === '1', 'tiket B salah');
  });
  await step('3e. C 2 betul; lewat D daftar semasa soalan & terus nampak soalan', async () => {
    await answer(J.C, [true, false, true, false]);
    await waitScreen(J.C, 'tunggu_cabutan');
    assert((await J.C.textContent('.ticket-count')).trim() === '2', 'tiket C salah');
    const url = await skrin.evaluate(() => document.querySelector('#qrSmall').dataset.url);
    const D = J.D = await newPage('jemaah-D', devUrl('D', url));
    await waitScreen(D, 'daftar');
    await D.fill('#phone', '0171112222'); await D.click('#regForm button[type=submit]'); await sleep(250);
    await D.fill('#name', 'Luqman Lewat'); await D.click('#regForm button[type=submit]');
    await waitScreen(D, 'soalan');
  });
  await step('3f. Jawab dua kali ditolak; refresh selepas jawab → skrin sama', async () => {
    const r = await J.A.evaluate((s) => { const me = LS.get(K.me); return LocalAPI.submit({ sid: s, pid: me.participantId, secret: me.secret, answers: {} }); }, sid);
    assert(r.reason === 'duplicate', 'jawapan kedua diterima: ' + JSON.stringify(r));
    await J.C.reload(); await waitScreen(J.C, 'tunggu_cabutan');
  });
  await step('3g. AJK Tutup Soalan → D terus ke Menunggu cabutan (0 tiket); jawab selepas tutup ditolak', async () => {
    await admin.click('[data-to="closed"]');
    await waitScreen(J.D, 'tunggu_cabutan', 2500);
    assert((await J.D.textContent('.ticket-count')).trim() === '0', 'D sepatutnya 0 tiket');
    const r = await J.D.evaluate((s) => { const me = LS.get(K.me); const q = LocalAPI.read().questions.find((x) => x.sessionId === s); return LocalAPI.submit({ sid: s, pid: me.participantId, secret: me.secret, answers: { [q.id]: q.correctIndex } }); }, sid);
    assert(r.reason === 'closed', 'jawapan selepas tutup diterima');
    await skrin.waitForFunction(() => /Soalan telah ditutup/.test(document.body.textContent), null, { timeout: 2500 });
  });

  /* ---------- 4. Roda cabutan ---------- */
  const tabOf = async (pid) => { for (const k of Object.keys(J)) { const me = await J[k].evaluate(() => LS.get(K.me)); if (me?.participantId === pid) return k; } return null; };
  const winnersDB = async () => (await db(admin)).winners.filter((w) => w.sessionId === sid).sort((a, b) => a.order - b.order);
  async function spinOnce(how) {
    await skrin.waitForFunction(() => { const b = document.querySelector('#btnSpin'); return b && !b.disabled; }, null, { timeout: 12000 });
    if (how === 'space') { await skrin.evaluate(() => document.activeElement?.blur()); await skrin.keyboard.press('Space'); }
    else await skrin.click('#btnSpin');
    await sleep(900);
    const ws = await winnersDB(), w = ws[ws.length - 1];
    const k = await tabOf(w.participantId);
    assert(await screenOf(J[k]) !== 'tahniah', 'keputusan bocor ke telefon sebelum roda berhenti');
    await skrin.waitForFunction(() => document.querySelector('.win-overlay'), null, { timeout: 10000 });
    const landed = await skrin.evaluate(() => document.querySelector('#wheel').dataset.landed);
    const shown = await skrin.textContent('#winName');
    assert(landed === w.participantId, `roda berhenti pada ${landed} tetapi DB pemenang ${w.participantId}`);
    const name = (await db(admin)).participants.find((p) => p.id === w.participantId).name;
    assert(shown.trim() === name, `nama di tengah roda (${shown}) ≠ pemenang (${name})`);
    await waitScreen(J[k], 'tahniah', 3000);
    return { w, k };
  }
  await step('4a. Mulakan Cabutan → skrin papar roda dengan nama peserta layak', async () => {
    await admin.click('[data-to="drawing"]');
    await skrin.waitForSelector('#wheel', { timeout: 3000 });
    const segs = await skrin.evaluate(() => Skrin.segs.map((x) => x.name).sort().join(','));
    assert(segs === ['Ali bin Abu', 'Haji Osman', 'Siti Aminah'].sort().join(','), 'segmen roda salah: ' + segs);
    await skrin.screenshot({ path: path.join(OUT, 'roda-sebelum.png') });
  });
  const wins = [];
  await step('4b. Putaran 1 (butang): roda = DB, keputusan terus ke telefon pemenang', async () => { wins.push(await spinOnce('click')); });
  await step('4c. Putaran 2 (Space): pemenang dikeluarkan dari roda, tiada berganda', async () => {
    const segs = await skrin.evaluate(() => Skrin.segs.map((x) => x.id));
    assert(!segs.includes(wins[0].w.participantId), 'pemenang 1 masih di roda');
    wins.push(await spinOnce('space'));
  });
  await step('4d. Putaran 3; tiket kurang dari hadiah → mesej & butang dimatikan', async () => {
    wins.push(await spinOnce('click'));
    await skrin.screenshot({ path: path.join(OUT, 'roda-pemenang.png') });
    const ids = wins.map((x) => x.w.participantId);
    assert(new Set(ids).size === 3, 'pemenang berganda');
    await skrin.waitForFunction(() => /Tiada lagi peserta layak — 1 hadiah/.test(document.querySelector('#drawMsg')?.textContent || ''), null, { timeout: 3000 });
    assert(await skrin.locator('#btnSpin').isDisabled(), 'butang putar masih aktif');
    const r = await admin.evaluate((s) => LocalAPI.draw(s), sid);
    assert(r.reason === 'nopool', 'cabutan tambahan dibenarkan');
  });
  await step('4e. Tamatkan sesi → D "Belum rezeki"; pemenang papar poster + ringkasan', async () => {
    await skrin.click('#btnFinish');
    await waitScreen(J.D, 'belum', 3000);
    assert(await J.D.locator('text=Belum rezeki').count() === 1 && await J.D.locator('.points li').count() >= 3, 'belum rezeki / ringkasan tiada');
    for (const { k, w } of wins) {
      await waitScreen(J[k], 'tahniah');
      await J[k].waitForSelector('#winPoster', { timeout: 4000 });
      assert(await J[k].locator(`text=${w.prize}`).count() > 0, 'hadiah tidak dipapar');
      await J[k].waitForFunction(() => document.querySelectorAll('.points li').length >= 3, null, { timeout: 3000 });
    }
    const href = await J.D.locator('a.btn-wa').getAttribute('href');
    const txt = decodeURIComponent(href.split('text=')[1]);
    assert(href.startsWith('https://wa.me/?text=') && txt.includes('Ringkasan Ilmu') && txt.includes('Jawapan betul'), 'pautan WA ringkasan salah');
    await sleep(700); await J[wins[0].k].screenshot({ path: path.join(OUT, 'jemaah-tahniah.png'), fullPage: true });
    await J.D.screenshot({ path: path.join(OUT, 'jemaah-belum-rezeki.png'), fullPage: true });
  });
  await step('4f. Refresh pemenang & bukan pemenang selepas selesai → skrin betul', async () => {
    await J[wins[0].k].reload(); await waitScreen(J[wins[0].k], 'tahniah');
    await J.D.reload(); await waitScreen(J.D, 'belum');
  });
  await step('4g. Roda maksimum 40 nama & termasuk pemenang', async () => {
    const r = await admin.evaluate(() => {
      const d = LocalAPI.read();
      const s = { id: 's_besar', templateId: null, title: 'Besar', speaker: '', date: ymd(new Date()), startTime: '00:00', endTime: '23:59', answerMinutes: 5, prizes: ['A'], transcript: '', summary: [], state: 'drawing', rev: 0 };
      const q = { id: 'q_besar', sessionId: 's_besar', text: 'Q', options: ['a', 'b', 'c', 'd'], correctIndex: 0, status: 'lulus' };
      d.sessions.push(s); d.questions.push(q);
      for (let i = 0; i < 55; i++) { const p = { id: 'pb' + i, name: 'Peserta ' + i, phone: '019' + String(1000000 + i), secret: 'x' }; d.participants.push(p); d.registrations.push({ id: 'rb' + i, sessionId: 's_besar', participantId: p.id, regNo: i + 1 }); d.answers.push({ id: 'ab' + i, sessionId: 's_besar', participantId: p.id, questionId: 'q_besar', choiceIndex: 0, isCorrect: true }); }
      LocalAPI.persist(d);
      return LocalAPI.draw('s_besar');
    });
    const r2 = await r;
    assert(r2.ok && r2.wheel.length === 40 && r2.wheel.some((x) => x.id === r2.winner.participantId), 'roda besar salah: ' + r2.wheel?.length);
    await admin.evaluate(() => LocalAPI.write([{ t: 'sessions', op: 'delete', id: 's_besar' }]));
  });

  /* ---------- 5. Sesi seterusnya: dikenali tanpa daftar semula + streak ---------- */
  let sid2;
  await step('5a. Sesi ke-2 dari templat; peranti C dikenali (1 ketik); peranti baharu dikenali melalui no. telefon', async () => {
    await admin.goto(BASE + '#admin?tab=templat'); await sleep(400);
    await admin.click('[data-tact="use"]'); await sleep(500);
    sid2 = (await db(admin)).sessions.find((s) => s.id !== sid && s.state === 'draft').id;
    await admin.fill('#transcript', TEXT); await admin.selectOption('#qN', '3'); await admin.click('#btn1Click'); await sleep(1200);
    await admin.goto(BASE + '#admin?tab=langsung'); await sleep(300);
    await admin.selectOption('#liveSel', sid2); await sleep(200);
    await admin.click('[data-to="registration"]'); await sleep(400);
    const tok = await admin.evaluate((s) => LocalAPI.token(s), sid2);
    const url = `${BASE}#j?s=${sid2}&t=${tok}`;
    await J.C.goto(devUrl('C', url)); await sleep(300);
    await waitScreen(J.C, 'daftar');
    assert(await J.C.locator('text=Selamat kembali').count() === 1 && await J.C.locator('#phone').count() === 0, 'peranti C tidak dikenali');
    await J.C.click('#btnHadir'); await waitScreen(J.C, 'tunggu_soalan');
    assert(await J.C.locator('text=2 sesi berturut-turut').count() === 1, 'streak C tidak dipapar');
    const F = J.F = await newPage('jemaah-F', devUrl('F', url));
    await waitScreen(F, 'daftar');
    await F.fill('#phone', '0127778888'); await F.click('#regForm button[type=submit]'); await sleep(300);
    // Privasi: peranti baharu hanya nampak nama BERTOPENG & mesti sahkan nama penuh
    const txt = await F.textContent('.jwrap');
    assert(await F.locator('#confName').count() === 1 && !/Ali|bin|Abu/.test(txt.replace(/Taip nama|bin\/binti/g, '')) && txt.includes('A***'), 'nama penuh terdedah / tiada pengesahan: ' + txt.slice(0, 120));
    await F.fill('#confName', 'Orang Lain'); await F.click('#regForm button[type=submit]'); await sleep(400);
    assert(await F.locator('#fConf .error:not(.hidden)').count() === 1 && await screenOf(F) === 'daftar', 'nama salah diterima');
    await F.fill('#confName', 'ali  BIN abu'); await F.click('#regForm button[type=submit]');
    await waitScreen(F, 'tunggu_soalan');
    assert(new Date((await db(admin)).sessions.find((s) => s.id === sid2).date) > new Date((await db(admin)).sessions.find((s) => s.id === sid).date), 'sesi ke-2 templat tidak dijadualkan selepas sesi pertama');
    const d = await db(admin), ali = d.participants.find((p) => p.phone === '0127778888');
    assert(d.participants.filter((p) => p.phone === '0127778888').length === 1 && d.registrations.filter((r) => r.sessionId === sid2 && r.participantId === ali.id).length === 1, 'rekod berganda');
  });
  await step('5b. Streak: 3 berturut → bonus; terlepas → reset', async () => {
    const r = await admin.evaluate(() => {
      const d = LocalAPI.read();
      d.settings.streak = { threshold: 3, bonus: 2 };
      const t = { id: 't_uji', name: 'Uji', title: 'Uji', weekday: null, startTime: '10:00', endTime: '11:00', answerMinutes: 5, prizes: ['A'] }; d.templates.push(t);
      const S = [35, 28, 21, 14, 7].map((n) => { const x = new Date(); x.setDate(x.getDate() - n); const s = { id: 'su' + n, templateId: 't_uji', title: 'U' + n, speaker: '', date: ymd(x), startTime: '10:00', endTime: '11:00', answerMinutes: 5, prizes: ['A'], transcript: '', summary: [], state: 'done', rev: 0 }; d.sessions.push(s); d.questions.push({ id: 'qu' + n, sessionId: s.id, text: 'Q', options: ['a', 'b', 'c', 'd'], correctIndex: 0, status: 'lulus' }); return s; });
      const p = { id: 'p_streak', name: 'Pak Streak', phone: '0181234567', secret: 's' }; d.participants.push(p);
      [0, 1, 2, 4].forEach((i) => { d.registrations.push({ id: 'ru' + i, sessionId: S[i].id, participantId: p.id, regNo: 1 }); d.answers.push({ id: 'au' + i, sessionId: S[i].id, participantId: p.id, questionId: 'qu' + [35, 28, 21, 14, 7][i], choiceIndex: 0, isCorrect: true }); });
      LocalAPI.persist(d);
      return { st: S.map((s) => Logic.streakAt(d, p.id, s.id)), bo: S.map((s) => Logic.bonusFor(d, p.id, s.id)), t3: Logic.tickets(d, S[2].id).length, t5: Logic.tickets(d, S[4].id).length, stats: Logic.streakStats(d, p.id), keys: Object.keys(d) };
    });
    assert(JSON.stringify(r.st) === '[1,2,3,0,1]', 'streak: ' + r.st);
    assert(JSON.stringify(r.bo) === '[0,0,2,0,0]', 'bonus: ' + r.bo);
    assert(r.t3 === 3 && r.t5 === 1, `tiket ${r.t3}/${r.t5}`);
    assert(r.stats.current === 1 && r.stats.best === 3, 'stats ' + JSON.stringify(r.stats));
    assert(!r.keys.some((k) => /streak/i.test(k)), 'jadual streak berasingan wujud');
  });
  await step('5c. Sesi tanpa peserta: roda kosong, tiada cabutan', async () => {
    await admin.evaluate(() => { const d = LocalAPI.read(); d.sessions.push({ id: 's_kosong', templateId: null, title: 'Sesi Kosong', speaker: '', date: ymd(new Date()), startTime: '08:00', endTime: '09:00', answerMinutes: 5, prizes: ['A'], transcript: '', summary: [], state: 'drawing', rev: 0 }); LocalAPI.persist(d); Bus.notify(); });
    await skrin.goto(`${BASE}#skrin?s=s_kosong`); await sleep(600);
    assert(await skrin.locator('#btnSpin').isDisabled(), 'butang aktif walaupun tiada peserta');
    assert(/Tiada peserta layak/.test(await skrin.textContent('#drawMsg')), 'mesej tiada peserta tiada');
    assert((await admin.evaluate(() => LocalAPI.draw('s_kosong'))).reason === 'nopool', 'cabutan dibenarkan');
  });

  /* ---------- 6. Ranking, laporan, CSV, WhatsApp, tetapan, PWA ---------- */
  await step('6a. Ranking AJK: telefon disembunyikan, lencana streak, CSV', async () => {
    await admin.goto(BASE + '#admin?tab=ranking'); await sleep(400);
    const body = await admin.textContent('#rBody');
    assert(!/01\d-\d{3,4} \d{4}/.test(body) && /01\d-\*\*\*\d{4}/.test(body), 'telefon tidak disembunyikan');
    assert(await admin.locator('#rBody .streak').count() > 0, 'lencana streak tiada');
    const [dl] = await Promise.all([admin.waitForEvent('download'), admin.click('#btnCsv')]);
    const f = path.join(OUT, dl.suggestedFilename()); await dl.saveAs(f);
    const csv = fs.readFileSync(f, 'utf8'); assert(csv.charCodeAt(0) === 0xfeff && csv.includes('Streak Semasa') && csv.includes('0127778888'), 'CSV ranking salah');
  });
  await step('6b. Laporan: carta, kadar betul setiap soalan, 2 CSV', async () => {
    await admin.goto(BASE + '#admin?tab=laporan'); await sleep(500);
    const px = await admin.evaluate(() => { const c = document.querySelector('#chartMonth'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
    assert(px > 1500, 'carta kosong');
    assert(await admin.locator('.bar-row .bar i').count() >= 3, 'bar kadar soalan tiada');
    assert(await admin.locator('#tblSess tbody tr').count() >= 2, 'jadual kehadiran tiada');
    for (const id of ['#csvSess', '#csvQ']) { const [dl] = await Promise.all([admin.waitForEvent('download'), admin.click(id)]); await dl.saveAs(path.join(OUT, dl.suggestedFilename())); }
  });
  await step('6c. Keputusan & ringkasan → WhatsApp (pemenang & kongsi)', async () => {
    await admin.goto(BASE + '#admin?tab=langsung'); await sleep(300);
    await admin.selectOption('#liveSel', sid); await sleep(300);
    const winHref = await admin.locator('.winner-row a.btn-wa').first().getAttribute('href');
    assert(/^https:\/\/wa\.me\/601\d{8,9}\?text=/.test(winHref) && decodeURIComponent(winHref).includes('Tahniah'), 'WA pemenang salah');
    const res = decodeURIComponent((await admin.getAttribute('#waResult', 'href')).split('text=')[1]);
    assert(res.includes('Ringkasan Ilmu') && res.includes('Pemenang cabutan') && res.includes('Jawapan betul'), 'WA keputusan salah');
    await admin.locator('[data-poster]').first().click(); await sleep(1200);
    assert(await admin.evaluate(() => document.querySelector('#adminPoster')?.width) === 1080, 'poster tahniah AJK tidak terjana');
    await admin.locator('.modal .btn-row .btn').first().click();
  });
  await step('6d. Tetapan: sandaran/pulih JSON, data contoh, PIN', async () => {
    await admin.goto(BASE + '#admin?tab=tetapan'); await sleep(300);
    const [dl] = await Promise.all([admin.waitForEvent('download'), admin.click('#btnExportJson')]);
    const f = path.join(OUT, 'sandaran.json'); await dl.saveAs(f);
    const n = (await db(admin)).participants.length;
    await admin.evaluate(() => { const d = LocalAPI.read(); d.participants = []; LocalAPI.persist(d); });
    await admin.setInputFiles('#fileImport', f); await sleep(300); await confirmModal(admin); await sleep(400);
    assert((await db(admin)).participants.length === n, 'pulih JSON gagal');
    const bad = path.join(OUT, 'rosak.json'); fs.writeFileSync(bad, '{"x":1}');
    await admin.goto(BASE + '#admin?tab=tetapan'); await sleep(300);
    await admin.setInputFiles('#fileImport', bad); await sleep(300);
    assert((await db(admin)).participants.length === n, 'JSON rosak diterima');
    await admin.click('#btnDemo'); await sleep(150); await confirmModal(admin); await sleep(600);
    const d = await db(admin);
    assert(d.templates.length >= 3 && d.sessions.length >= 15, 'data contoh tidak dimuat');
    await admin.fill('#pOld', '9999'); await admin.fill('#pNew', '4321'); await admin.click('#fPin button'); await sleep(300);
    assert(await admin.evaluate(() => LocalAPI.adminCheck('1234')), 'PIN berubah walaupun PIN lama salah');
  });
  await step('6e. PWA: manifest, ikon & service worker', async () => {
    const m = await admin.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); return r.json(); });
    assert(m.name === 'Ganjaran Ilmu Jemaah Masjid' && m.display === 'standalone' && m.icons.length >= 2, 'manifest salah');
    for (const ic of m.icons) { const r = await admin.request.get(`http://localhost:${PORT}/${ic.src}`); assert(r.ok(), 'ikon tiada: ' + ic.src); }
    const sw = await admin.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; });
    assert(sw, 'service worker tidak didaftarkan');
  });

  /* ---------- 7. Responsif, tema, aksesibiliti ---------- */
  const views = [];
  await admin.evaluate(() => { localStorage.clear(); });
  await admin.goto(BASE + '#admin'); await admin.reload(); await sleep(300);
  await admin.evaluate(() => { seedDemo(); });
  const live = await admin.evaluate(() => LocalAPI.read().sessions.find((s) => s.state === 'registration').id);
  const V = await newPage('visual', BASE + '#admin');
  shotPage = V;
  for (const [vw, label] of [[375, 'mobile'], [1280, 'desktop']]) for (const theme of ['light', 'dark']) {
    await step(`7. ${label} ${vw}px ${theme}: tiada skrol mendatar, butang ≥56px, fon ≥18px, kontras`, async () => {
      await V.setViewportSize({ width: vw, height: vw === 375 ? 812 : 900 });
      await V.evaluate((t) => { localStorage.setItem('cbj_theme', JSON.stringify(t)); sessionStorage.setItem('cbj_admin_ok', '1'); sessionStorage.setItem('gij_pin', '1234'); }, theme);
      const issues = [];
      const check = async (label2, url, prep) => {
        await V.goto(url); await V.reload(); await sleep(500);
        if (prep) await prep(); await sleep(250);
        const m = await V.evaluate(() => {
          const over = document.documentElement.scrollWidth - innerWidth;
          const small = [...document.querySelectorAll('.btn, .tab, .atab, .icon-btn, .opt, .s-item, .link-btn')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 55.5).map((b) => b.className + ':' + Math.round(b.getBoundingClientRect().height));
          const fs = parseFloat(getComputedStyle(document.body).fontSize);
          const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
          const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
          const pr = document.createElement('div'); document.body.appendChild(pr);
          const col = (v) => { pr.style.color = `var(${v})`; return getComputedStyle(pr).color; };
          const res = { text: ratio(col('--text'), col('--surface')), muted: ratio(col('--muted'), col('--surface')), mutedBg: ratio(col('--muted'), col('--bg')), primary: ratio(col('--primary'), col('--surface')) };
          pr.remove();
          return { over, small, fs, res };
        });
        if (m.over > 1) issues.push(`${label2}: skrol mendatar ${m.over}px`);
        if (m.small.length) issues.push(`${label2}: butang <56px ${m.small.slice(0, 3).join(' | ')}`);
        if (m.fs < 18) issues.push(`${label2}: fon ${m.fs}`);
        if (m.res.text < 7 || m.res.muted < 4.5 || m.res.mutedBg < 4.5 || m.res.primary < 4.5) issues.push(`${label2}: kontras ${JSON.stringify(m.res)}`);
        await sleep(500); await V.screenshot({ path: path.join(OUT, `${label}-${theme}-${label2}.png`), fullPage: !label2.startsWith('skrin') });
      };
      const tok = await V.evaluate((s) => LocalAPI.token(s), live);
      await check('j-scan', `${BASE}?dev=V1${label}${theme}#j`);
      await check('j-daftar', `${BASE}?dev=V2${label}${theme}#j?s=${live}&t=${tok}`, async () => { await V.fill('#phone', '0199998888'); await V.click('#regForm button[type=submit]'); await sleep(300); });
      await check('j-menunggu', `${BASE}?dev=V3${label}${theme}#j?s=${live}&t=${tok}`, async () => { await V.fill('#phone', '01999' + String(vw).padStart(4, '0') + (theme === 'dark' ? '1' : '2')); await V.click('#regForm button[type=submit]'); await sleep(250); await V.fill('#name', 'Ujian Visual'); await V.click('#regForm button[type=submit]'); await sleep(500); });
      for (const t of ['langsung', 'sesi', 'templat', 'ranking', 'laporan', 'tetapan']) await check('admin-' + t, `${BASE}#admin?tab=${t}`);
      await check('skrin-qr', `${BASE}#skrin?s=${live}`);
      const past = await V.evaluate(() => LocalAPI.read().sessions.find((s) => s.state === 'done').id);
      await check('skrin-selesai', `${BASE}#skrin?s=${past}`);
      assert(!issues.length, issues.join('\n'));
    });
  }
  await step('7b. Skrin jemaah (soalan / menunggu cabutan / tahniah / belum rezeki) pada 375px', async () => {
    await V.setViewportSize({ width: 375, height: 812 });
    const shots = [['j-soalan', 'soalan'], ['j-tunggu-cabutan', 'tunggu_cabutan']];
    await V.evaluate((s) => LocalAPI.setState(s, 'questions'), live);
    await V.goto(`${BASE}?dev=V3mobilelight#j`); await V.reload(); await waitScreen(V, 'soalan');
    await sleep(700); await V.screenshot({ path: path.join(OUT, 'mobile-j-soalan.png'), fullPage: true });
    let over = await V.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert(over <= 1, 'skrol mendatar pada soalan');
    for (let i = 0; i < 5; i++) { if (await screenOf(V) !== 'soalan') break; await V.locator('.opt').first().click(); await V.click('#nextQ'); await sleep(250); }
    await waitScreen(V, 'tunggu_cabutan');
    await V.screenshot({ path: path.join(OUT, 'mobile-j-tunggu-cabutan.png'), fullPage: true });
    void shots;
  });

  await step('Tiada ralat console / pageerror / dialog pelayar', async () => { assert(!errors.length, errors.slice(0, 10).join('\n')); });

  await browser.close(); server.close();
  const fails = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n=== E2E: ${results.length - fails.length}/${results.length} lulus ===`);
  fails.forEach((f) => console.log('FAIL:', f[1], '\n    ', f[2]));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
