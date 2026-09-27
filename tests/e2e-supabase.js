/* =====================================================================
   Ujian end-to-end MOD SUPABASE — projek Supabase SEBENAR
   Jalankan:  cd tests && MODE=supabase GIJ_PIN=1234 node e2e.js
              (BASE_URL=https://laman-anda.netlify.app untuk uji laman yang dihos)
   - Setiap peranti (AJK, jemaah A–F) = KONTEKS pelayar berasingan (storan tidak
     dikongsi) → semua isyarat melalui Supabase Realtime. v5: tiada lagi skrin besar —
     kod sertai QR statik (gij_join_code) & cabutan (gij_draw) dipanggil terus.
   - Semua data ujian ditanda "[UJIAN E2E]" / telefon 019900xxxx dan
     DIPADAM sebelum & selepas larian (sesi, templat, peserta).
   - Tetapan streak dipulihkan selepas ujian.
   ===================================================================== */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SB_URL = /SUPABASE_URL: '([^']*)'/.exec(html)[1];
const SB_KEY = /SUPABASE_ANON_KEY: '([^']*)'/.exec(html)[1];
if (!SB_URL || !SB_KEY) { console.error('CONFIG.SUPABASE_URL / SUPABASE_ANON_KEY kosong dalam index.html'); process.exit(2); }
const PIN = process.env.GIJ_PIN || '1234';
const TAG = '[UJIAN E2E]';
const PHONE = (n) => '019900' + String(n).padStart(4, '0');
const SKIP_PRIVACY = process.env.SKIP_PRIVACY === '1';
const PORT = 8788;
const BASE = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/?(index\.html)?$/, '/index.html') : `http://localhost:${PORT}/index.html`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
});

/* ---------- Pembantu REST/RPC (sebagai peranan anon, sama seperti pelayar) ---------- */
async function rest(pathq, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathq}`, { ...opts, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, ok: r.ok, body: j };
}
async function rpc(fn, args) { const r = await rest('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) }); if (!r.ok) { const e = new Error(`${fn}: ${r.body?.message || JSON.stringify(r.body)}`); e.res = r; throw e; } return r.body; }
const snap = () => rpc('gij_admin_snapshot', { p_pin: PIN });
const write = (ops) => rpc('gij_admin_write', { p_pin: PIN, p_ops: ops });
const setState = (sid, st) => rpc('gij_set_state', { p_pin: PIN, p_sid: sid, p_state: st });
// v5: kod sertai STATIK (gantikan gij_token dinamik 60s) — sah selagi sesi 'registration', tiada TTL.
const joinCode = (sid) => rpc('gij_join_code', { p_pin: PIN, p_sid: sid });
const serverNow = async () => (await rpc('gij_jemaah_view', { p_sid: '', p_pid: '', p_secret: '' })).now;

async function cleanup() {
  const d = await snap();
  const ops = [
    ...d.sessions.filter((s) => s.title.startsWith(TAG)).map((s) => ({ t: 'sessions', op: 'delete', id: s.id })),
    ...d.templates.filter((t) => t.name.startsWith(TAG)).map((t) => ({ t: 'templates', op: 'delete', id: t.id })),
  ];
  if (ops.length) await write(ops);
  const parts = d.participants.filter((p) => p.phone.startsWith('019900'));
  if (parts.length) {
    try { await write(parts.map((p) => ({ t: 'participants', op: 'delete', id: p.id }))); }
    catch (e) { console.log(`     (amaran: ${parts.length} peserta ujian tidak dapat dipadam — ${e.message.slice(0, 80)})`); }
  }
  return { sessions: ops.length, participants: parts.length };
}

const results = [], errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, msg) { if (!c) throw new Error(msg); }
let shotPage = null;
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(['PASS', name]); console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) {
    results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n    ', e.message.split('\n')[0]);
    try { if (shotPage) await shotPage.screenshot({ path: path.join(OUT, 'SB-FAIL-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + '.png'), fullPage: true }); } catch {}
  }
}
function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`[${label}] HTTP ${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => { errors.push(`[${label}] dialog: ${d.message()}`); d.dismiss(); });
}
const screenOf = (p) => p.evaluate(() => document.querySelector('.jwrap')?.dataset.screen || null);
async function waitScreen(p, name, timeout = 10000) {
  await p.waitForFunction((n) => document.querySelector('.jwrap')?.dataset.screen === n, name, { timeout }).catch(async () => { throw new Error(`skrin "${name}" tidak muncul (kini: ${await screenOf(p)})`); });
}
async function confirmModal(p) { await p.locator('.modal .btn-row .btn').last().click(); await sleep(300); }
const meOf = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('gij_me') || 'null'));

(async () => {
  if (!process.env.BASE_URL) server.listen(PORT);
  const browser = await chromium.launch({ channel: process.env.BROWSER === 'chrome' ? 'chrome' : 'msedge', headless: true });
  const device = async (label, url, vp = { width: 390, height: 844 }) => {
    const ctx = await browser.newContext({ viewport: vp, acceptDownloads: true });
    const p = await ctx.newPage(); watch(p, label); if (url) { await p.goto(url); await sleep(800); } return p;
  };
  console.log(`Supabase: ${SB_URL}\nLaman   : ${BASE}\n`);
  const before = await cleanup();
  if (before.sessions || before.participants) console.log(`     (dibersihkan sisa larian lepas: ${JSON.stringify(before)})`);
  const settings0 = (await snap()).settings;
  const TEXT = /DEMO_TEXTS = \[\s*`([^`]+)`/.exec(html)[1];
  let sid;

  /* ---------- N. Laman boleh dibuka awam (tanpa kata laluan / log masuk Netlify) ---------- */
  await step('N. Laman dibuka dalam konteks pelayar baharu tanpa kata laluan', async () => {
    const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'awam');
    const res = await p.goto(BASE + '#j');
    assert(res.status() === 200, 'status HTTP ' + res.status());
    await p.waitForSelector('.jwrap[data-screen="scan"]', { timeout: 10000 });
    assert(!/netlify\.com\/(login|authorize)|Password protected|Team login/i.test(p.url() + (await p.content()).slice(0, 5000)), 'halaman log masuk / kata laluan Netlify muncul');
    for (const f of ['manifest.webmanifest', 'sw.js', 'icon-192.png']) { const r = await p.request.get(BASE.replace('index.html', f)); assert(r.ok(), f + ' ' + r.status()); }
    if (process.env.BASE_URL) for (const f of ['tests/e2e.js', 'schema.sql', 'tests/package.json']) { const r = await p.request.get(BASE.replace('index.html', f)); assert(r.status() === 404, `${f} terdedah (${r.status()})`); }
    await ctx.close();
  });

  /* ---------- R. RLS peranan anon & RPC asas ---------- */
  await step('R1. RLS: anon hanya boleh SELECT sessions; jadual lain ditolak', async () => {
    const s = await rest('sessions?select=id&limit=1');
    assert(s.ok, 'anon tidak boleh baca sessions (Realtime akan gagal)');
    for (const t of ['participants', 'registrations', 'answers', 'winners', 'questions', 'templates', 'gij_settings']) {
      const r = await rest(`${t}?select=*&limit=1`);
      assert(!r.ok && (r.status === 401 || r.status === 403 || r.body?.code === '42501'), `anon BOLEH baca ${t} (status ${r.status})`);
    }
  });
  await step('R2. RLS: anon tidak boleh INSERT/UPDATE/DELETE sessions terus', async () => {
    const ins = await rest('sessions', { method: 'POST', body: JSON.stringify({ id: 's_hack', title: TAG + 'hack', date: '2026-01-01' }) });
    assert(!ins.ok, 'anon boleh INSERT sessions');
    const up = await rest('sessions?id=neq.x', { method: 'PATCH', body: JSON.stringify({ state: 'done' }), headers: { Prefer: 'return=representation' } });
    assert(!up.ok || (Array.isArray(up.body) && up.body.length === 0), 'anon boleh UPDATE sessions');
    const del = await rest('sessions?id=neq.x', { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    assert(!del.ok || (Array.isArray(del.body) && del.body.length === 0), 'anon boleh DELETE sessions');
  });
  await step('R3. Fungsi dalaman (gij__*) tidak boleh dipanggil; RPC AJK perlu PIN', async () => {
    for (const fn of ['gij__sign', 'gij__tickets', 'gij__pin_ok', 'gij__join_ok']) {
      const r = await rest('rpc/' + fn, { method: 'POST', body: JSON.stringify(fn === 'gij__sign' ? { p_msg: 'x' } : fn === 'gij__tickets' ? { p_sid: 'x' } : fn === 'gij__join_ok' ? { p_sid: 'x', p_code: 'x' } : { p_pin: '1' }) });
      assert(!r.ok, `${fn} boleh dipanggil oleh anon`);
    }
    for (const fn of ['gij_token', 'gij_checkin']) { // v5: dibuang (gantikan skrin besar/token dinamik)
      const r = await rest('rpc/' + fn, { method: 'POST', body: JSON.stringify({}) });
      assert(!r.ok, `${fn} masih wujud di Supabase — schema.sql terkini belum diguna pakai (drop function)`);
    }
    for (const [fn, args] of [['gij_admin_snapshot', { p_pin: '0000' }], ['gij_join_code', { p_pin: '0000', p_sid: 'x' }], ['gij_admin_write', { p_pin: '0000', p_ops: [] }], ['gij_draw', { p_pin: '0000', p_sid: 'x' }]]) {
      const r = await rest('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });
      assert(!r.ok, `${fn} diterima dengan PIN salah`);
    }
    assert(await rpc('gij_admin_check', { p_pin: PIN }) === true, `PIN ${PIN} tidak diterima`);
  });

  /* ---------- 1. AJK (konteks sendiri) ---------- */
  const admin = await device('ajk', BASE + '#admin', { width: 1280, height: 900 });
  shotPage = admin;
  await step('1a. AJK login (Supabase) & tiada lencana MOD DEMO', async () => {
    await admin.fill('#pin', '0000'); await admin.click('#pinForm button'); await sleep(800);
    assert(await admin.locator('#pin').count() === 1, 'PIN salah diterima');
    await admin.fill('#pin', PIN); await admin.click('#pinForm button');
    await admin.waitForSelector('.atabs', { timeout: 8000 });
    assert(await admin.locator('.demo-pill').count() === 0, 'lencana MOD DEMO muncul dalam mod Supabase');
  });
  await step('1b. Templat dicipta melalui UI', async () => {
    await admin.click('.atab[href="#admin?tab=templat"]'); await admin.waitForSelector('#btnNewTpl');
    await admin.click('#btnNewTpl');
    await admin.fill('#tName', TAG + ' Jumaat'); await admin.fill('#tTitle', TAG + ' Khutbah Jumaat'); await admin.fill('#tSpeaker', 'Imam Ujian');
    await admin.selectOption('#tDay', '5'); await admin.fill('#tStart', '13:30'); await admin.fill('#tEnd', '14:30'); await admin.fill('#tMin', '5');
    await admin.fill('#tPrizes', 'Sejadah\nAl-Quran\nBaucar RM30\nKopiah');
    await confirmModal(admin); await sleep(1500);
    const t = (await snap()).templates.filter((x) => x.name.startsWith(TAG));
    assert(t.length === 1 && t[0].prizes.length === 4 && t[0].weekday === 5, 'templat tidak disimpan di Supabase: ' + JSON.stringify(t));
  });
  await step('1c. Sesi 1 klik daripada templat', async () => {
    await admin.waitForSelector('[data-tact="use"]'); await admin.click('[data-tact="use"]');
    await admin.waitForSelector('#btn1Click', { timeout: 8000 });
    const s = (await snap()).sessions.filter((x) => x.title.startsWith(TAG));
    assert(s.length === 1 && s[0].state === 'draft' && s[0].template_id && s[0].prizes.length === 4, 'sesi salah: ' + JSON.stringify(s));
    sid = s[0].id;
  });
  await step('1d. Mod 1 klik: 4 soalan + ringkasan disimpan di Supabase', async () => {
    await admin.fill('#transcript', TEXT); await admin.selectOption('#qN', '4');
    await admin.click('#btn1Click'); await sleep(2500);
    const d = await snap();
    const qs = d.questions.filter((q) => q.session_id === sid);
    assert(qs.length === 4 && qs.every((q) => q.status === 'lulus'), 'soalan: ' + qs.length);
    const s = d.sessions.find((x) => x.id === sid);
    assert(s.summary.length >= 3 && s.transcript.length > 100, 'ringkasan/transkrip tidak disimpan');
  });
  await step('1e. Suntingan soalan (upsert separa) disimpan', async () => {
    await admin.locator('.q-card textarea').first().fill('Soalan disunting AJK (Supabase)?'); await sleep(1800);
    assert((await snap()).questions.some((q) => q.text === 'Soalan disunting AJK (Supabase)?'), 'suntingan tidak sampai ke Supabase');
  });
  await step('1f. Buka Pendaftaran (RPC gij_set_state)', async () => {
    await admin.click('.atab[href="#admin?tab=langsung"]'); await admin.waitForSelector('#liveSel');
    await admin.selectOption('#liveSel', sid); await sleep(500);
    assert(await admin.locator('[data-to="questions"]').isDisabled(), 'Buka Soalan tidak disekat');
    await admin.click('[data-to="registration"]'); await sleep(1500);
    assert((await snap()).sessions.find((x) => x.id === sid).state === 'registration', 'pendaftaran tidak dibuka');
  });

  /* ---------- 2. Kod sertai statik (QR bercetak) & jemaah (konteks berasingan) ---------- */
  let joinUrl;
  await step('2a. Kod sertai statik daripada gij_join_code (bukan lagi skrin besar/token 60s)', async () => {
    const code = await joinCode(sid);
    assert(/^[0-9a-f]{16}$/.test(code), 'kod sertai: ' + code);
    joinUrl = `${BASE}#j?s=${sid}&t=${code}`;
  });
  const J = {};
  await step('2b. Kod tidak sah ditolak oleh pelayan; tanpa kod → imbas', async () => {
    const E = await device('jemaah-E', joinUrl.replace(/t=.*$/, 't=deadbeefdead'));
    await waitScreen(E, 'kodtidaksah'); assert(await E.locator('text=Kod QR tidak sah').count() === 1, 'mesej tidak sah tiada');
    await E.goto(joinUrl.replace(/&t=.*$/, '')); await sleep(1500); await waitScreen(E, 'scan');
    await E.context().close();
  });
  const registerDevice = async (label, phone, name) => {
    const P = J[label] = await device('jemaah-' + label, joinUrl);
    await waitScreen(P, 'daftar');
    await P.fill('#phone', phone); await P.click('#regForm button[type=submit]');
    await P.waitForSelector('#name', { timeout: 8000 });
    await P.fill('#name', name); await P.click('#regForm button[type=submit]'); await sleep(500);
    await P.waitForSelector('#btnTeruskan', { timeout: 8000 }); // skrin poster pendaftaran (sekali sahaja)
    await P.click('#btnTeruskan');
    await waitScreen(P, 'tunggu_soalan');
    return P;
  };
  await step('2c. Jemaah A (telefon 1): validasi & daftar baharu; skrin poster pendaftaran', async () => {
    const A = J.A = await device('jemaah-A', joinUrl);
    await waitScreen(A, 'daftar');
    await A.click('#regForm button[type=submit]'); await sleep(200);
    assert(await A.locator('#fPhone .error:not(.hidden)').count() === 1, 'telefon kosong diterima');
    await A.fill('#phone', '12345'); await A.click('#regForm button[type=submit]'); await sleep(200);
    assert(await A.locator('#fPhone .error:not(.hidden)').count() === 1, 'telefon salah diterima');
    await A.fill('#phone', PHONE(1)); await A.click('#regForm button[type=submit]');
    await A.waitForSelector('#name', { timeout: 8000 });
    await A.click('#regForm button[type=submit]'); await sleep(200);
    assert(await A.locator('#fName .error:not(.hidden)').count() === 1, 'nama kosong diterima');
    await A.fill('#name', 'Ahmad Hafiz bin Ujian'); await A.click('#regForm button[type=submit]'); await sleep(500);
    await A.waitForSelector('#btnTeruskan', { timeout: 8000 });
    assert(await A.locator('#regPoster').count() === 1, 'poster pendaftaran tidak dipapar');
    await A.click('#btnTeruskan');
    await waitScreen(A, 'tunggu_soalan');
  });
  await step('2d. Jemaah B, C & D daftar; kiraan AJK dikemas kini melalui Realtime', async () => {
    await registerDevice('B', PHONE(2), 'Siti Ujian binti Test');
    await registerDevice('C', PHONE(3), 'Haji Osman Ujian');
    await registerDevice('D', PHONE(4), 'Luqman Lewat'); // v5: mesti daftar semasa "registration" (bukan lagi lewat semasa "questions")
    await admin.waitForFunction(() => document.querySelector('#lvHadir')?.textContent === '4', null, { timeout: 10000 });
  });
  await step('2e. Refresh jemaah → skrin sama (data dari pelayan)', async () => {
    await J.A.reload(); await waitScreen(J.A, 'tunggu_soalan');
  });
  await step('2f. AJK "Sediakan Soalan" → jemaah papar "bersedia"; pendaftaran baharu ditutup', async () => {
    await admin.click('[data-to="prepared"]'); await sleep(1000);
    assert((await snap()).sessions.find((x) => x.id === sid).state === 'prepared', 'tidak masuk "prepared"');
    for (const k of ['A', 'B', 'C', 'D']) await waitScreen(J[k], 'bersedia', 10000);
    const code = await joinCode(sid);
    const rReg = await rpc('gij_register', { p_sid: sid, p_ticket: code, p_name: 'Sesiapa', p_phone: PHONE(5), p_dist: null, p_secret: null });
    assert(rReg.reason === 'closed', 'pendaftaran baharu masih dibenarkan semasa "prepared"');
  });

  /* ---------- 3. Soalan ---------- */
  await step('3a. AJK Lancarkan Soalan → A, B, C, D bertukar melalui Realtime', async () => {
    await admin.click('[data-to="questions"]'); await sleep(300); await confirmModal(admin);
    const t0 = Date.now();
    await Promise.all(['A', 'B', 'C', 'D'].map((k) => waitScreen(J[k], 'soalan', 10000)));
    const ms = Date.now() - t0;
    console.log(`     Realtime: semua tab jemaah bertukar dalam ${ms} ms`);
    assert(ms < 6000, 'Realtime terlalu perlahan: ' + ms + ' ms');
  });
  await step('3a2. Jam pelayan: pemasa AJK tidak dipotong walaupun jam komputer tidak tepat', async () => {
    const skew = Date.now() - (await serverNow());
    const off = await admin.evaluate(() => Clock.offset);
    console.log(`     beza jam komputer ujian vs pelayan: ${Math.round(skew / 1000)}s · offset aplikasi: ${Math.round(off / 1000)}s`);
    assert(Math.abs(off + skew) < 3000, `Clock.offset (${off}) tidak mengimbangi beza jam (${skew})`);
    await sleep(1200);
    const [m, sec] = (await admin.textContent('#lvTimer')).trim().split(':').map(Number);
    assert(m * 60 + sec > 270, 'pemasa AJK salah (jam tempatan digunakan?): ' + m + ':' + sec);
    assert((await snap()).sessions.find((x) => x.id === sid).state === 'questions', 'soalan ditutup awal');
  });
  const correct = async () => Object.fromEntries((await snap()).questions.filter((q) => q.session_id === sid && q.status === 'lulus').map((q) => [q.id, q.correct_index]));
  async function answer(p, plan) {
    const c = await correct();
    for (const good of plan) {
      const qid = await p.evaluate(() => J.view.questions[document.querySelector('.timer-bar b').textContent - 1].id);
      await p.click(`.opt[data-i="${good ? c[qid] : (c[qid] + 1) % 4}"]`); await sleep(100);
      await p.click('#nextQ'); await sleep(200);
    }
  }
  await step('3b. Jawapan betul TIDAK dihantar ke telefon; pilihan dirawak (pelayan)', async () => {
    const v = await J.A.evaluate(() => JSON.stringify(J.view));
    assert(!/correct/i.test(v.replace(/"correct":null/g, '')), 'jawapan betul bocor');
    const oA = await J.A.evaluate(() => J.view.questions.map((q) => q.options.map((o) => o.i).join('')).join('|'));
    const oB = await J.B.evaluate(() => J.view.questions.map((q) => q.options.map((o) => o.i).join('')).join('|'));
    assert(oA !== oB, 'susunan sama untuk A & B');
  });
  await step('3c. A 4/4 betul → 4 tiket (dikira pelayan)', async () => {
    await answer(J.A, [true, true, true, true]); await waitScreen(J.A, 'tunggu_cabutan');
    assert((await J.A.textContent('.ticket-count')).trim() === '4', 'tiket A: ' + await J.A.textContent('.ticket-count'));
  });
  await step('3d. B refresh di tengah soalan → sambung soalan 2; 1 tiket', async () => {
    await answer(J.B, [true]); await J.B.reload(); await waitScreen(J.B, 'soalan');
    assert((await J.B.textContent('.timer-bar b')).trim() === '2', 'tidak sambung ke soalan 2');
    await answer(J.B, [false, false, false]); await waitScreen(J.B, 'tunggu_cabutan');
    assert((await J.B.textContent('.ticket-count')).trim() === '1', 'tiket B salah');
  });
  await step('3e. C 2 betul; D 0 betul (0 tiket)', async () => {
    await answer(J.C, [true, false, true, false]); await waitScreen(J.C, 'tunggu_cabutan');
    assert((await J.C.textContent('.ticket-count')).trim() === '2', 'tiket C salah');
    await answer(J.D, [false, false, false, false]); await waitScreen(J.D, 'tunggu_cabutan');
    assert((await J.D.textContent('.ticket-count')).trim() === '0', 'tiket D sepatutnya 0');
  });
  await step('3f. Jawab dua kali & rahsia salah ditolak oleh pelayan', async () => {
    const me = await meOf(J.A);
    assert((await rpc('gij_submit', { p_sid: sid, p_pid: me.participantId, p_secret: me.secret, p_answers: {} })).reason === 'duplicate', 'jawapan kedua diterima');
    assert((await rpc('gij_submit', { p_sid: sid, p_pid: me.participantId, p_secret: 'salah', p_answers: {} })).reason === 'unverified', 'rahsia salah diterima');
  });
  await step('3g. Tutup Soalan → semua tab kekal di Menunggu cabutan; jawab selepas tutup ditolak', async () => {
    await admin.click('[data-to="closed"]'); await sleep(1000);
    for (const k of ['A', 'B', 'C', 'D']) await waitScreen(J[k], 'tunggu_cabutan', 10000);
    const me = await meOf(J.D), c = await correct(), q = Object.keys(c)[0];
    assert((await rpc('gij_submit', { p_sid: sid, p_pid: me.participantId, p_secret: me.secret, p_answers: { [q]: c[q] } })).reason === 'closed', 'jawapan selepas tutup diterima');
  });

  /* ---------- 4. Cabutan — pemenang ditentukan DI PELAYAN (gij_draw); setiap telefon papar animasi
     ringkas sendiri (BUKAN roda besar disegerakkan, yang telah dibuang bersama #skrin). ---------- */
  const tabOf = async (pid) => { for (const k of Object.keys(J)) if ((await meOf(J[k]))?.participantId === pid) return k; return null; };
  const wins = [];
  await step('4a. Mulakan Cabutan; kurangkan hadiah kepada 2 (drpd 3 tiket-pemegang) supaya ada "belum rezeki"', async () => {
    await write([{ t: 'sessions', op: 'upsert', row: { id: sid, prizes: ['Sejadah', 'Al-Quran'] } }]);
    assert((await setState(sid, 'drawing')).ok, 'tidak masuk "drawing"');
  });
  await step('4b. Cabutan pertama (gij_draw): keputusan TIDAK terus ke telefon pemenang', async () => {
    const r = await rpc('gij_draw', { p_pin: PIN, p_sid: sid });
    assert(r.ok, 'cabutan pertama gagal: ' + JSON.stringify(r));
    const k = await tabOf(r.winner.participantId);
    assert(await screenOf(J[k]) !== 'tahniah', 'keputusan bocor sebelum animasi tamat');
    await waitScreen(J[k], 'tahniah', 12000);
    wins.push({ k, w: r.winner });
  });
  await step('4c. Cabutan kedua: pemenang berbeza, tiada berganda', async () => {
    const r = await rpc('gij_draw', { p_pin: PIN, p_sid: sid });
    assert(r.ok, 'cabutan kedua gagal: ' + JSON.stringify(r));
    assert(r.winner.participantId !== wins[0].w.participantId, 'pemenang sama dicabut dua kali');
    const k = await tabOf(r.winner.participantId);
    await waitScreen(J[k], 'tahniah', 12000);
    wins.push({ k, w: r.winner });
  });
  await step('4d. Hadiah dihabiskan → cabutan seterusnya "noprize"', async () => {
    assert((await rpc('gij_draw', { p_pin: PIN, p_sid: sid })).reason === 'noprize', 'cabutan tambahan selepas hadiah habis dibenarkan');
  });
  await step('4e. Tamatkan → D "Terima kasih kerana hadir" (0 tiket); baki pemegang tiket "Belum rezeki"; pemenang: poster + ringkasan', async () => {
    assert((await setState(sid, 'done')).ok, 'tidak masuk "done"');
    await waitScreen(J.D, 'belum_tiada', 10000);
    for (const { k, w } of wins) { await waitScreen(J[k], 'tahniah'); await J[k].waitForSelector('#winPoster', { timeout: 8000 }); assert(await J[k].locator(`text=${w.prize}`).count() > 0, 'hadiah tidak dipapar'); }
    const loserKeys = ['A', 'B', 'C'].filter((k) => !wins.some((x) => x.k === k));
    for (const k of loserKeys) await waitScreen(J[k], 'belum_ada', 10000);
    await J.D.reload(); await waitScreen(J.D, 'belum_tiada');
  });
  await step('4f. Muat Turun E-book (PDF): butang wujud & boleh diklik tanpa ralat', async () => {
    for (const p of [J[wins[0].k], J.D]) {
      const btn = p.locator('button:has-text("Muat Turun E-book")');
      assert(await btn.count() === 1, 'butang e-book tiada');
      await btn.click(); await sleep(500);
    }
  });

  /* ---------- 5. Sesi 2: dikenali + privasi ---------- */
  let sid2;
  await step('5a. Sesi 2; peranti C dikenali dengan 1 ketik (rahsia peranti)', async () => {
    // Cipta melalui UI templat (1 klik) — tarikh mesti SELEPAS sesi pertama
    await admin.goto(BASE + '#admin?tab=templat'); await admin.waitForSelector('[data-tact="use"]', { timeout: 10000 });
    await admin.click('[data-tact="use"]'); await admin.waitForSelector('#btn1Click', { timeout: 10000 });
    const ss = (await snap()).sessions.filter((s) => s.title.startsWith(TAG) && s.template_id);
    const s1 = ss.find((s) => s.id === sid), s2 = ss.find((s) => s.id !== sid && s.state === 'draft');
    assert(s2 && s2.date > s1.date, `tarikh sesi 2 (${s2?.date}) tidak selepas sesi 1 (${s1.date})`);
    sid2 = s2.id;
    await write([0, 1, 2].map((i) => ({ t: 'questions', op: 'upsert', row: { id: `${sid2}_q${i}`, session_id: sid2, text: `Soalan ${i}?`, options: ['a', 'b', 'c', 'd'], correct_index: 0, status: 'lulus' } })));
    assert((await setState(sid2, 'registration')).ok, 'buka pendaftaran sesi 2');
    const code2 = await joinCode(sid2);
    const url = `${BASE}#j?s=${sid2}&t=${code2}`;
    await J.C.goto(url); await waitScreen(J.C, 'daftar');
    assert(await J.C.locator('#phone').count() === 0 && await J.C.locator('text=Selamat kembali').count() === 1, 'peranti C tidak dikenali');
    await J.C.click('#btnHadir'); await sleep(500);
    await J.C.waitForSelector('#btnTeruskan', { timeout: 8000 }); await J.C.click('#btnTeruskan');
    await waitScreen(J.C, 'tunggu_soalan');
    assert(await J.C.locator('text=2 sesi berturut-turut').count() === 1, 'streak C tidak dipapar');
  });
  if (!SKIP_PRIVACY) {
    await step('5b. PRIVASI: peranti baharu + no. lama → nama bertopeng sahaja; nama salah ditolak; nama betul diterima', async () => {
      const F = J.F = await device('jemaah-F', `${BASE}#j?s=${sid2}&t=${await joinCode(sid2)}`);
      await waitScreen(F, 'daftar');
      await F.fill('#phone', PHONE(1)); await F.click('#regForm button[type=submit]');
      await F.waitForSelector('#confName', { timeout: 8000 });
      const page = await F.textContent('.jwrap');
      assert(!/Ahmad|Hafiz|Ha\*\*\*|Uj\*\*\*/.test(page) && (await F.textContent('#maskedName')).trim() === 'Ahm***', 'skrin mendedahkan lebih daripada nama pertama bertopeng: ' + page.slice(0, 160));
      await F.fill('#confName', 'Orang Lain'); await F.click('#regForm button[type=submit]'); await sleep(1500);
      assert(await F.locator('#fConf .error:not(.hidden)').count() === 1 && await screenOf(F) === 'daftar', 'nama salah diterima');
      await F.fill('#confName', 'ahmad  hafiz BIN ujian'); await F.click('#regForm button[type=submit]'); await sleep(500);
      await F.waitForSelector('#btnTeruskan', { timeout: 8000 }); await F.click('#btnTeruskan');
      await waitScreen(F, 'tunggu_soalan');
      const d = await snap(), p = d.participants.filter((x) => x.phone === PHONE(1));
      assert(p.length === 1 && d.registrations.filter((r) => r.session_id === sid2 && r.participant_id === p[0].id).length === 1, 'rekod berganda');
    });
    await step('5b2. PRIVASI (pelayan): gij_lookup memulangkan nama pertama bertopeng sahaja', async () => {
      const lk = await rpc('gij_lookup', { p_phone: PHONE(1) });
      assert(lk === 'Ahm***', 'gij_lookup (pelayan) mesti "Ahm***" sahaja, dapat: ' + JSON.stringify(lk) + ' — jalankan schema.sql terkini');
    });
    await step('5c. PRIVASI: 5 percubaan nama salah → dikunci sementara', async () => {
      const code2 = await joinCode(sid2);
      let last;
      for (let i = 0; i < 6; i++) last = await rpc('gij_register', { p_sid: sid2, p_ticket: code2, p_name: 'Salah ' + i, p_phone: PHONE(2), p_dist: null, p_secret: null });
      assert(last.reason === 'locked', 'tidak dikunci selepas 5 percubaan: ' + JSON.stringify(last));
      const ok = await rpc('gij_register', { p_sid: sid2, p_ticket: code2, p_name: 'Siti Ujian binti Test', p_phone: PHONE(2), p_dist: null, p_secret: null });
      assert(ok.reason === 'locked', 'nama betul diterima semasa dikunci');
      const meB = await meOf(J.B);
      const viaSecret = await rpc('gij_register', { p_sid: sid2, p_ticket: code2, p_name: '', p_phone: PHONE(2), p_dist: null, p_secret: meB.secret });
      assert(viaSecret.ok, 'peranti asal (rahsia) disekat oleh kunci');
    });
  }

  /* ---------- 6. Streak (rantaian 5 sesi melalui RPC) ---------- */
  await step('6. Streak di pelayan: 3 berturut → bonus; terlepas → reset', async () => {
    const tid = (await snap()).templates.find((t) => t.name.startsWith(TAG)).id;
    await write([{ t: 'settings', row: { streak: { threshold: 3, bonus: 2 } } }]);
    const tpl2 = 't_uji_st_' + Date.now().toString(36);
    await write([{ t: 'templates', op: 'upsert', row: { id: tpl2, name: TAG + ' Streak', title: 'Streak', prizes: ['A'] } }]);
    const res = [];
    for (let i = 0; i < 5; i++) {
      const id = `s_uji_st${i}_${Date.now().toString(36)}`;
      await write([{ t: 'sessions', op: 'upsert', row: { id, template_id: tpl2, title: `${TAG} Streak ${i}`, date: `2026-0${i + 1}-15`, start_time: '10:00', end_time: '11:00', answer_minutes: 5, prizes: ['A'], summary: [], transcript: '' } },
        ...[0, 1, 2].map((k) => ({ t: 'questions', op: 'upsert', row: { id: `${id}_q${k}`, session_id: id, text: 'Q' + k, options: ['a', 'b', 'c', 'd'], correct_index: 0, status: 'lulus' } }))]);
      await setState(id, 'registration');
      if (i !== 3) {
        const code = await joinCode(id);
        const r = await rpc('gij_register', { p_sid: id, p_ticket: code, p_name: 'Pak Streak Ujian', p_phone: PHONE(9), p_dist: null, ...(SKIP_PRIVACY ? {} : { p_secret: res.secret || null }) });
        assert(r.ok, 'daftar streak gagal: ' + JSON.stringify(r)); res.pid = r.participantId; res.secret = r.secret;
        const v = await rpc('gij_jemaah_view', { p_sid: id, p_pid: r.participantId, p_secret: r.secret });
        res.push([v.streak, v.bonus]);
      } else res.push([0, 0]);
      await setState(id, 'prepared'); await setState(id, 'questions'); await setState(id, 'closed'); await setState(id, 'done');
    }
    void tid;
    assert(JSON.stringify(res.map((x) => x[0])) === '[1,2,3,0,1]', 'streak: ' + JSON.stringify(res));
    assert(JSON.stringify(res.map((x) => x[1])) === '[0,0,2,0,0]', 'bonus: ' + JSON.stringify(res));
  });
  await step('7. Sesi tanpa peserta: tiada tiket, tiada cabutan (pelayan)', async () => {
    const id = 's_uji_kosong_' + Date.now().toString(36);
    await write([{ t: 'sessions', op: 'upsert', row: { id, title: TAG + ' Kosong', date: '2026-12-01', start_time: '10:00', end_time: '11:00', answer_minutes: 5, prizes: ['A'], summary: [], transcript: '' } },
      ...[0, 1, 2].map((k) => ({ t: 'questions', op: 'upsert', row: { id: `${id}_q${k}`, session_id: id, text: 'Q', options: ['a', 'b', 'c', 'd'], correct_index: 0, status: 'lulus' } }))]);
    for (const st of ['registration', 'prepared', 'questions', 'closed', 'drawing']) assert((await setState(id, st)).ok, 'peralihan ' + st);
    assert((await rpc('gij_draw', { p_pin: PIN, p_sid: id })).reason === 'nopool', 'cabutan dibenarkan walaupun tiada peserta');
  });
  await step('8. Ranking, laporan & CSV dalam mod Supabase', async () => {
    await admin.goto(BASE + '#admin?tab=ranking'); await admin.waitForSelector('#rBody', { timeout: 10000 });
    const body = await admin.textContent('#rBody');
    assert(!/019-900\d \d{4}/.test(body) && /019-\*\*\*/.test(body), 'telefon tidak disembunyikan');
    const [dl] = await Promise.all([admin.waitForEvent('download'), admin.click('#btnCsv')]); await dl.saveAs(path.join(OUT, 'SB-' + dl.suggestedFilename()));
    await admin.goto(BASE + '#admin?tab=laporan'); await admin.waitForSelector('#chartMonth', { timeout: 10000 });
    assert(await admin.locator('#tblSess tbody tr').count() >= 1, 'laporan kosong');
  });
  await step('9. Tiada ralat console / HTTP / dialog', async () => { assert(!errors.length, errors.slice(0, 10).join('\n')); });

  /* ---------- Pembersihan ---------- */
  await write([{ t: 'settings', row: { streak: settings0.streak } }]).catch(() => {});
  const after = await cleanup().catch((e) => ({ error: e.message }));
  const left = await snap();
  console.log(`\n     Pembersihan: ${JSON.stringify(after)} · baki sesi ujian: ${left.sessions.filter((s) => s.title.startsWith(TAG)).length} · baki peserta ujian: ${left.participants.filter((p) => p.phone.startsWith('019900')).length}`);
  await browser.close(); server.close();
  const fails = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n=== E2E SUPABASE: ${results.length - fails.length}/${results.length} lulus ===`);
  fails.forEach((f) => console.log('FAIL:', f[1], '\n    ', f[2]));
  process.exit(fails.length ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await cleanup(); } catch {} process.exit(2); });
