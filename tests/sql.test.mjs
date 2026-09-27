// Ujian fungsi RPC schema.sql dalam PostgreSQL sebenar (PGlite/WASM + pgcrypto).
// Jalankan: cd tests && npm install && npm run test:sql
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');
const db = new PGlite({ extensions: { pgcrypto } });
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
const rpc = async (fn, ...args) => { const ph = args.map((_, i) => `$${i + 1}`).join(','); const r = await one(`select public.${fn}(${ph}) as v`, args); return r.v; };
const rpcErr = async (fn, ...args) => { try { await rpc(fn, ...args); return null; } catch (e) { return e.message; } };

await db.exec(sql);
await db.exec(sql); // idempoten: boleh dijalankan semula
ok(true, 'schema.sql dijalankan (dua kali, idempoten)');

// ---------- AJK ----------
ok(await rpc('gij_admin_check', '1234') === true && await rpc('gij_admin_check', '0000') === false, 'PIN betul diterima, salah ditolak');
ok(/PIN tidak sah/.test(await rpcErr('gij_admin_snapshot', '0000')), 'snapshot tanpa PIN ditolak');
const W = (ops) => rpc('gij_admin_write', '1234', JSON.stringify(ops));
await W([{ t: 'templates', op: 'upsert', row: { id: 't1', name: 'Khutbah Jumaat', title: 'Khutbah Jumaat', weekday: 5, start_time: '13:30', end_time: '14:30', answer_minutes: 5, prizes: ['A', 'B', 'C'] } }]);
const mkSession = async (id, date, state = 'draft') => {
  await W([{ t: 'sessions', op: 'upsert', row: { id, template_id: 't1', title: 'Sesi ' + id, date, start_time: '13:30', end_time: '14:30', answer_minutes: 5, prizes: ['A', 'B', 'C'], state: 'done' } }]);
  for (let i = 0; i < 3; i++) await W([{ t: 'questions', op: 'upsert', row: { id: `${id}_q${i}`, session_id: id, text: `Soalan ${i}?`, options: ['a' + i, 'b' + i, 'c' + i, 'd' + i], correct_index: i % 4, status: 'lulus' } }]);
  return id;
};
await mkSession('s1', '2026-09-04');
ok((await one(`select state from sessions where id='s1'`)).state === 'draft', 'admin_write tidak boleh set state secara terus (tetap draf)');
await W([{ t: 'sessions', op: 'upsert', row: { id: 's1', title: 'Tajuk Baharu' } }]);
const s1 = await one(`select title, speaker, prizes from sessions where id='s1'`);
ok(s1.title === 'Tajuk Baharu' && s1.prizes.length === 3, 'upsert separa hanya ubah lajur yang dihantar');
ok(/hanya boleh dipadam|tidak dibenarkan/.test(await rpcErr('gij_admin_write', '1234', JSON.stringify([{ t: 'participants', op: 'upsert', row: { id: 'x', name: 'x', phone: '0123456789' } }]))), 'jadual peserta tidak boleh ditulis terus');

// Peralihan keadaan — v5: draft -> registration -> prepared -> questions -> closed -> drawing -> done
ok((await rpc('gij_set_state', '1234', 's1', 'questions')).ok === false, 'draf → soalan ditolak (mesti melalui pendaftaran & disediakan)');
ok((await rpc('gij_set_state', '1234', 's1', 'registration')).ok === true, 'draf → pendaftaran diterima');
ok(/dikunci/.test(await rpcErr('gij_admin_write', '1234', JSON.stringify([{ t: 'questions', op: 'upsert', row: { id: 's1_q0', text: 'x' } }]))) === false, 'soalan masih boleh disunting semasa pendaftaran');

// ---------- Kod sertai statik (QR bercetak) — v5, gantikan token/checkin dinamik 60s ----------
ok(/PIN tidak sah/.test(await rpcErr('gij_join_code', '0000', 's1')), 'kod sertai tanpa PIN ditolak');
const code = await rpc('gij_join_code', '1234', 's1');
ok(/^[0-9a-f]{16}$/.test(code), 'kod sertai dijana (statik, tiada slot masa): ' + code);
ok(code === (await rpc('gij_join_code', '1234', 's1')), 'kod sertai TETAP bagi sesi yang sama (bukan berputar setiap 60s)');
ok(await rpc('gij__join_ok', 's1', code) === true, 'kod sertai sah untuk sesi sendiri');
ok(await rpc('gij__join_ok', 's1', 'deadbeefdeadbeef') === false, 'kod palsu ditolak');
ok(await rpc('gij__join_ok', 's_lain', code) === false, 'kod sesi ini tidak sah untuk sesi lain');
ok(/does not exist/i.test(await rpcErr('gij_token', '1234', 's1') || ''), 'gij_token dibuang (v5, gantikan skrin besar)');
ok(/does not exist/i.test(await rpcErr('gij_checkin', 's1', code) || ''), 'gij_checkin dibuang (v5)');

// ---------- Semakan bilangan soalan (3-5) kini juga berlaku semasa masuk "prepared" ----------
await W([{ t: 'sessions', op: 'upsert', row: { id: 's0', title: 'Sesi Kurang Soalan', date: '2026-09-05', prizes: ['A'] } },
         { t: 'questions', op: 'upsert', row: { id: 's0_q0', session_id: 's0', text: 'Q?', options: ['a', 'b', 'c', 'd'], correct_index: 0, status: 'lulus' } }]);
ok((await rpc('gij_set_state', '1234', 's0', 'registration')).ok === true, 's0: draf → pendaftaran diterima');
ok(/Perlu 3.5 soalan/.test((await rpc('gij_set_state', '1234', 's0', 'prepared')).reason), 's0: 1 soalan lulus — tidak boleh masuk "prepared" (semakan kini di sini juga, bukan hanya di "questions")');

// ---------- Pendaftaran ----------
ok((await rpc('gij_register', 's1', 'kod-palsu', 'Ali', '0127778888', null)).reason === 'expired', 'kod sertai palsu ditolak');
ok((await rpc('gij_register', 's1', code, 'Ali', '12345', null)).reason === 'phone', 'telefon salah format ditolak');
ok((await rpc('gij_register', 's1', code, '  ', '0127778888', null)).reason === 'name', 'nama kosong ditolak');
const r1 = await rpc('gij_register', 's1', code, 'Ali  bin Abu', '0127778888', null);
ok(r1.ok && r1.name === 'Ali bin Abu' && r1.regNo === 1, 'pendaftaran baharu');
const r1b = await rpc('gij_register', 's1', code, '', '0127778888', null, r1.secret);
ok(r1b.ok && r1b.participantId === r1.participantId && (await one(`select count(*)::int n from registrations where session_id='s1'`)).n === 1, 'daftar semula dengan rahsia peranti: dikenali, tiada rekod berganda');
// ---------- Privasi nombor telefon ----------
ok(await rpc('gij_lookup', '0127778888') === 'A***', 'lookup: nama pertama bertopeng sahaja (tiada bin/nama bapa): ' + await rpc('gij_lookup', '0127778888'));
ok((await one(`select public.gij__mask_name('Ahmad Hafiz bin Ali') v`)).v === 'Ahm***', 'format nama bertopeng: nama pertama sahaja');
const nm = await rpc('gij_register', 's1', code, 'Orang Lain', '0127778888', null, null);
ok(nm.ok === false && nm.reason === 'namemismatch' && nm.attemptsLeft === 4, 'peranti baharu + nama salah ditolak: ' + JSON.stringify(nm));
ok((await rpc('gij_register', 's1', code, '', '0127778888', null, 'rahsia-salah')).reason === 'namemismatch', 'rahsia salah + tiada nama ditolak');
const nOk = await rpc('gij_register', 's1', code, 'ALI  b. abu', '0127778888', null, null);
ok(nOk.ok && nOk.participantId === r1.participantId, 'nama penuh bertoleransi (huruf besar/kecil, "b.") diterima');
ok((await one(`select name_fails from participants where id=$1`, [r1.participantId])).name_fails === 0, 'kiraan cubaan ditetapkan semula selepas berjaya');
let lk; for (let i = 0; i < 5; i++) lk = await rpc('gij_register', 's1', code, 'Salah ' + i, '0127778888', null, null);
ok(lk.reason === 'locked', '5 cubaan salah → dikunci');
ok((await rpc('gij_register', 's1', code, 'Ali bin Abu', '0127778888', null, null)).reason === 'locked', 'nama betul pun ditolak semasa dikunci');
ok((await rpc('gij_register', 's1', code, '', '0127778888', null, r1.secret)).ok, 'peranti asal (rahsia) tidak terjejas oleh kunci');
await db.query(`update participants set locked_until = null where id = $1`, [r1.participantId]);
const r2 = await rpc('gij_register', 's1', code, 'Siti Aminah', '0139990000', null);

// ---------- Arahan tuntutan hadiah (prizeInstructions) & tahap kesukaran soalan (difficulty) ----------
await W([{ t: 'sessions', op: 'upsert', row: { id: 's1', prize_instructions: 'Tunjukkan skrin kemenangan di kaunter AJK selepas solat.' } }]);
ok((await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret)).session.prizeInstructions === 'Tunjukkan skrin kemenangan di kaunter AJK selepas solat.', 'gij_jemaah_view memulangkan prizeInstructions');
await W([{ t: 'questions', op: 'upsert', row: { id: 's1_q0', difficulty: 'susah' } }]);
ok((await one(`select difficulty from questions where id='s1_q0'`)).difficulty === 'susah', 'difficulty soalan boleh dikemas kini (mudah/sederhana/susah)');
let diffErr = null;
try { await db.query(`insert into questions (id, session_id, text, options, difficulty) values ('bad_q','s1','x','["a","b","c","d"]','tidaksah')`); }
catch (e) { diffErr = e.message; }
ok(/questions_difficulty_check|violates check constraint/i.test(diffErr || ''), 'difficulty tidak sah (bukan mudah/sederhana/susah) ditolak: ' + diffErr);

// ---------- Paparan jemaah & jawapan ----------
let v = await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret);
ok(v.ok && v.registered && v.questions === null && v.tickets === null, 'paparan jemaah: menunggu soalan');
ok((await rpc('gij_jemaah_view', 's1', r1.participantId, 'salah')).knownDevice === false, 'rahsia salah = peranti tidak dikenali');
ok((await rpc('gij_submit', 's1', r1.participantId, r1.secret, '{}')).reason === 'closed', 'jawab sebelum soalan dibuka ditolak');
ok((await rpc('gij_set_state', '1234', 's1', 'prepared')).ok, 's1: pendaftaran → disediakan (3 soalan lulus, diterima)');
v = await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret);
ok(v.session.state === 'prepared' && v.questions === null, 'jemaah tunggu soalan disediakan (skrin "bersedia")');
ok(/dikunci/.test(await rpcErr('gij_admin_write', '1234', JSON.stringify([{ t: 'questions', op: 'upsert', row: { id: 's1_q0', text: 'y' } }]))), 'soalan dikunci semasa "prepared" (bukan lagi hanya semasa "questions")');
ok((await rpc('gij_register', 's1', code, 'Sesiapa', '0161112222', null)).reason === 'closed', 'pendaftaran baharu ditutup semasa "prepared" (dahulu masih dibenarkan semasa "questions")');
await rpc('gij_set_state', '1234', 's1', 'questions');
v = await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret);
ok(v.questions?.length === 3 && !JSON.stringify(v.questions).includes('correct'), 'soalan dihantar TANPA jawapan betul');
const v2 = await rpc('gij_jemaah_view', 's1', r2.participantId, r2.secret);
const ord1 = v.questions.map((q) => q.options.map((o) => o.i).join('')).join('|');
const ord2 = v2.questions.map((q) => q.options.map((o) => o.i).join('')).join('|');
ok(ord1 !== ord2, `susunan pilihan dirawak setiap peserta (${ord1} vs ${ord2})`);
ok(ord1 === (await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret)).questions.map((q) => q.options.map((o) => o.i).join('')).join('|'), 'susunan tetap untuk peserta sama');
ok((await rpc('gij_submit', 's1', r1.participantId, r1.secret, '{}')).reason === 'empty', 'hantar kosong ditolak');
const ans = { s1_q0: 0, s1_q1: 1, s1_q2: 0 }; // 2 betul
ok((await rpc('gij_submit', 's1', r1.participantId, r1.secret, JSON.stringify(ans))).ok, 'hantar jawapan');
ok((await rpc('gij_submit', 's1', r1.participantId, r1.secret, JSON.stringify(ans))).reason === 'duplicate', 'jawab dua kali ditolak');
ok((await rpc('gij_submit', 's1', r1.participantId, 'salah', JSON.stringify(ans))).reason === 'unverified', 'rahsia salah ditolak');
v = await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret);
ok(v.tickets === 2 && v.answered, 'tiket = jawapan betul (2)');
await rpc('gij_set_state', '1234', 's1', 'closed');
ok((await rpc('gij_submit', 's1', r2.participantId, r2.secret, JSON.stringify(ans))).reason === 'closed', 'jawab selepas tutup ditolak');
await db.query(`update sessions set questions_close_at = now() - interval '1 minute', state='questions' where id='s1'`);
ok((await rpc('gij_submit', 's1', r2.participantId, r2.secret, JSON.stringify(ans))).reason === 'closed', 'jawab selepas masa tamat ditolak');
await db.query(`update sessions set state='closed' where id='s1'`);

// ---------- Cabutan ----------
ok((await rpc('gij_draw', '1234', 's1')).reason === 'state', 'cabutan sebelum "drawing" ditolak');
await rpc('gij_set_state', '1234', 's1', 'drawing');
const d1 = await rpc('gij_draw', '1234', 's1');
ok(d1.ok && d1.winner.participantId === r1.participantId && d1.wheel.some((x) => x.id === r1.participantId), 'pemenang dipilih daripada tiket & ada pada roda');
ok((await rpc('gij_draw', '1234', 's1')).reason === 'spinning', 'tidak boleh cabut semasa roda berputar');
ok((await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret)).win === null, 'keputusan TIDAK didedahkan sebelum roda berhenti');
await db.query(`update winners set reveal_at = now() - interval '1 second' where session_id='s1'`);
ok((await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret)).win?.prize === 'A', 'keputusan didedahkan ke telefon pemenang selepas roda berhenti');
ok((await rpc('gij_draw', '1234', 's1')).reason === 'nopool', 'tiket kurang daripada hadiah: berhenti (nopool)');
ok((await rpc('gij_set_state', '1234', 's1', 'done')).ok, 'tamatkan sesi');
v = await rpc('gij_jemaah_view', 's1', r1.participantId, r1.secret);
ok(v.review?.items.length === 3 && v.review.items[0].answer === 'a0' && v.review.items[1].correct === true, 'jawapan betul dipapar selepas sesi tamat');

// ---------- Streak ----------
await rpc('gij_admin_write', '1234', JSON.stringify([{ t: 'settings', row: { streak: { threshold: 3, bonus: 2 } } }]));
const chainIds = ['c1', 'c2', 'c3', 'c4', 'c5'];
for (const [i, id] of chainIds.entries()) { await mkSession(id, `2026-10-0${i + 1}`); await db.query(`update sessions set state='done' where id=$1`, [id]); }
const pid = r1.participantId;
for (const id of ['c1', 'c2', 'c3', 'c5']) await db.query(`insert into registrations (id, session_id, participant_id, reg_no) values ($1,$2,$3,1)`, ['r' + id, id, pid]);
const streaks = []; const bonus = [];
for (const id of chainIds) { streaks.push((await one(`select public.gij__streak_at($1,$2) v`, [pid, id])).v); bonus.push((await one(`select public.gij__bonus($1,$2) v`, [pid, id])).v); }
ok(JSON.stringify(streaks) === '[2,3,4,0,1]', 'streak berturut & reset selepas terlepas: ' + JSON.stringify(streaks)); // s1 (4 Sep) turut dalam templat t1
ok(JSON.stringify(bonus) === '[0,2,0,0,0]', 'bonus pada gandaan ambang: ' + JSON.stringify(bonus));
ok((await one(`select count(*)::int n from public.gij__tickets('c2')`)).n === 2, 'tiket termasuk bonus streak');

// Pemutus seri: dua sesi templat sama pada tarikh & masa sama → ikut created_at
await mkSession('t1a', '2026-12-04'); await db.query(`update sessions set state='done', created_at = now() - interval '1 hour' where id='t1a'`);
await mkSession('t1b', '2026-12-04'); await db.query(`update sessions set state='done' where id='t1b'`);
for (const id of ['t1a', 't1b']) await db.query(`insert into registrations (id, session_id, participant_id, reg_no) values ($1,$2,$3,1)`, ['rr' + id, id, pid]);
ok((await one(`select public.gij__streak_at($1,'t1a') a, public.gij__streak_at($1,'t1b') b`, [pid])).b === (await one(`select public.gij__streak_at($1,'t1a') a`, [pid])).a + 1, 'sesi sama tarikh/masa: streak ikut created_at');

// ---------- Padam peserta (PDPA) ----------
// s1 sudah lepas "registration" pada ketika ini — masuk terus melalui SQL (bukan gij_register) untuk ujian padam.
const tmpId = (await one(`select public.gij__uid('p_') as v`)).v;
await db.query(`insert into participants (id, name, phone) values ($1, 'Peserta Padam', '0161234567')`, [tmpId]);
await db.query(`insert into registrations (id, session_id, participant_id, reg_no) values ($1, 's1', $2, 99)`, ['r_padam', tmpId]);
await W([{ t: 'participants', op: 'delete', id: tmpId }]);
ok((await one(`select count(*)::int n from participants where id=$1`, [tmpId])).n === 0 && (await one(`select count(*)::int n from registrations where participant_id=$1`, [tmpId])).n === 0, 'padam peserta + rekod berkaitan');
ok(/hanya boleh dipadam/.test(await rpcErr('gij_admin_write', '1234', JSON.stringify([{ t: 'participants', op: 'upsert', row: { id: 'x' } }]))), 'peserta tidak boleh diubah terus');

// ---------- Sesi tanpa peserta ----------
await mkSession('e1', '2026-11-01');
await rpc('gij_set_state', '1234', 'e1', 'registration'); await rpc('gij_set_state', '1234', 'e1', 'prepared'); await rpc('gij_set_state', '1234', 'e1', 'questions');
await rpc('gij_set_state', '1234', 'e1', 'closed'); await rpc('gij_set_state', '1234', 'e1', 'drawing');
ok((await rpc('gij_draw', '1234', 'e1')).reason === 'nopool', 'sesi tanpa peserta: tiada cabutan');

// ---------- Tetapan & PIN ----------
ok(/PIN semasa salah/.test(await rpcErr('gij_admin_write', '1234', JSON.stringify([{ t: 'pin', old: '9999', pin: '4321' }]))), 'tukar PIN dengan PIN lama salah ditolak');
await W([{ t: 'pin', old: '1234', pin: '4321' }]);
ok(await rpc('gij_admin_check', '4321') && !(await rpc('gij_admin_check', '1234')), 'PIN ditukar');
const snap = await rpc('gij_admin_snapshot', '4321');
ok(snap.participants.length === 2 && !('secret' in snap.participants[0]) && snap.settings.streak.threshold === 3, 'snapshot AJK tanpa rahsia peserta');

console.log(`\n=== SQL: ${pass}/${pass + fail} lulus ===`);
process.exit(fail ? 1 : 0);
