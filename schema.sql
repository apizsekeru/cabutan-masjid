-- =====================================================================
--  Ganjaran Ilmu Jemaah Masjid — skema Supabase (PostgreSQL)
--  Jalankan dalam Supabase → SQL Editor. Kemudian isi CONFIG.SUPABASE_URL
--  & CONFIG.SUPABASE_ANON_KEY dalam index.html.
--
--  Model keselamatan:
--   • RLS diaktifkan pada SEMUA jadual. Pengguna awam (anon) hanya boleh
--     SELECT jadual `sessions` (untuk langganan Realtime).
--   • Semua operasi lain melalui fungsi RPC (SECURITY DEFINER):
--       - Jemaah : gij_checkin, gij_lookup, gij_register, gij_submit, gij_jemaah_view
--       - AJK    : gij_admin_* , gij_set_state, gij_token, gij_draw (perlu PIN)
--   • Token QR, tiket check-in, semakan masa menjawab, pengiraan jawapan
--     betul, tiket bonus streak dan cabutan rawak dibuat DI PELAYAN.
--   • Setiap perubahan menaikkan sessions.rev → semua skrin menerima isyarat
--     Realtime (postgres_changes pada `sessions`) dan memuat semula data.
--   PIN lalai: 1234 (tukar dalam Panel AJK → Tetapan).
-- =====================================================================

create extension if not exists pgcrypto;

-- Peranan Supabase (untuk ujian di PostgreSQL biasa; sudah wujud dalam Supabase)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

-- ---------------------------------------------------------------------
-- JADUAL
-- ---------------------------------------------------------------------
create table if not exists public.gij_settings (
  id               int primary key default 1 check (id = 1),
  masjid_name      text not null default 'Masjid Al-Hidayah',
  pin_hash         text not null default crypt('1234', gen_salt('bf')),
  token_secret     text not null default encode(gen_random_bytes(32), 'hex'),
  streak_threshold int  not null default 3 check (streak_threshold >= 0),
  streak_bonus     int  not null default 2 check (streak_bonus >= 0),
  geo_enabled      boolean not null default false,
  geo_lat          double precision,
  geo_lng          double precision,
  geo_radius       int not null default 150
);
insert into public.gij_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.templates (
  id             text primary key,
  name           text not null,
  title          text not null,
  speaker        text not null default '',
  weekday        int check (weekday between 0 and 6),
  start_time     text,
  end_time       text,
  answer_minutes int  not null default 5 check (answer_minutes between 1 and 60),
  prizes         jsonb not null default '[]',
  created_at     timestamptz not null default now()
);

create table if not exists public.sessions (
  id                  text primary key,
  template_id         text,            -- tiada FK: sejarah streak kekal walaupun templat dipadam
  title               text not null,
  speaker             text not null default '',
  date                date not null,
  start_time          text,
  end_time            text,
  answer_minutes      int  not null default 5 check (answer_minutes between 1 and 60),
  transcript          text not null default '',
  summary             jsonb not null default '[]',
  prizes              jsonb not null default '[]',
  state               text not null default 'draft'
                      check (state in ('draft','registration','questions','closed','drawing','done')),
  state_at            timestamptz default now(),
  questions_opened_at timestamptz,
  questions_close_at  timestamptz,
  rev                 int not null default 0,
  created_at          timestamptz not null default now()
);

create table if not exists public.questions (
  id            text primary key,
  session_id    text not null references public.sessions(id) on delete cascade,
  text          text not null default '',
  options       jsonb not null default '["","","",""]',
  correct_index int  not null default 0 check (correct_index between 0 and 3),
  status        text not null default 'draf' check (status in ('draf','lulus')),
  source        text not null default 'manual',
  created_at    timestamptz not null default now()
);

create table if not exists public.participants (
  id         text primary key,
  name       text not null,
  phone      text not null unique check (phone ~ '^01[0-9]{8,9}$'),
  secret     text not null default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);

-- v4: kawalan cubaan pengesahan nama (peranti baharu dengan no. telefon lama)
alter table public.participants add column if not exists name_fails int not null default 0;
alter table public.participants add column if not exists locked_until timestamptz;

create table if not exists public.registrations (      -- juga sumber pengiraan streak
  id             text primary key,
  session_id     text not null references public.sessions(id) on delete cascade,
  participant_id text not null references public.participants(id) on delete cascade,
  reg_no         int  not null,
  checkin_at     timestamptz not null default now(),
  dist           int,
  created_at     timestamptz not null default now(),
  unique (session_id, participant_id)
);

create table if not exists public.answers (
  id             text primary key,
  session_id     text not null references public.sessions(id) on delete cascade,
  participant_id text not null references public.participants(id) on delete cascade,
  question_id    text not null references public.questions(id) on delete cascade,
  choice_index   int  not null check (choice_index between 0 and 3),
  is_correct     boolean not null,
  created_at     timestamptz not null default now(),
  unique (participant_id, question_id)
);

create table if not exists public.winners (
  id             text primary key,
  session_id     text not null references public.sessions(id) on delete cascade,
  participant_id text not null references public.participants(id) on delete cascade,
  prize          text not null,
  "order"        int  not null,
  spin_ms        int  not null default 0,
  reveal_at      timestamptz not null default now(),
  wheel          jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  unique (session_id, participant_id)                -- seorang menang sekali setiap sesi
);

create index if not exists questions_session_idx     on public.questions(session_id);
create index if not exists registrations_session_idx on public.registrations(session_id);
create index if not exists registrations_part_idx    on public.registrations(participant_id);
create index if not exists answers_session_idx       on public.answers(session_id);
create index if not exists winners_session_idx       on public.winners(session_id);
create index if not exists sessions_template_idx     on public.sessions(template_id, date);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.gij_settings  enable row level security;
alter table public.templates     enable row level security;
alter table public.sessions      enable row level security;
alter table public.questions     enable row level security;
alter table public.participants  enable row level security;
alter table public.registrations enable row level security;
alter table public.answers       enable row level security;
alter table public.winners       enable row level security;

drop policy if exists sessions_public_read on public.sessions;
create policy sessions_public_read on public.sessions for select to anon, authenticated using (true);

revoke all on all tables in schema public from anon, authenticated;
grant select on public.sessions to anon, authenticated;

-- Realtime: siarkan perubahan jadual sessions
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.sessions;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- FUNGSI DALAMAN
-- ---------------------------------------------------------------------
create or replace function public.gij__now_ms() returns bigint language sql volatile as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;

create or replace function public.gij__uid(p_prefix text) returns text language sql volatile as $$
  select p_prefix || replace(gen_random_uuid()::text, '-', '')
$$;

create or replace function public.gij__pin_ok(p_pin text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from gij_settings where id = 1 and pin_hash = crypt(coalesce(p_pin, ''), pin_hash))
$$;

create or replace function public.gij__need_pin(p_pin text) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not gij__pin_ok(p_pin) then raise exception 'PIN tidak sah' using errcode = '28000'; end if;
end $$;

create or replace function public.gij__sign(p_msg text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select substr(encode(hmac(p_msg, (select token_secret from gij_settings where id = 1), 'sha256'), 'hex'), 1, 16)
$$;

create or replace function public.gij__touch(p_sid text) returns void
language sql volatile security definer set search_path = public as $$
  update sessions set rev = rev + 1 where id = p_sid
$$;

create or replace function public.gij__ticket_ok(p_sid text, p_ticket text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_at bigint; v_sig text; v_now bigint := gij__now_ms();
begin
  if coalesce(p_ticket, '') !~ '^\d{10,16}\.[0-9a-f]{16}$' then return false; end if;
  v_at := split_part(p_ticket, '.', 1)::bigint;
  v_sig := split_part(p_ticket, '.', 2);
  return v_sig = gij__sign('ck|' || p_sid || '|' || v_at)
     and v_now - v_at <= 30 * 60 * 1000       -- tiket check-in sah 30 minit
     and v_at <= v_now + 5000;
end $$;

-- Streak pada sesi: bilangan sesi berturut-turut (templat sama, bukan draf) berakhir di sesi ini
create or replace function public.gij__streak_at(p_pid text, p_sid text) returns int
language plpgsql stable security definer set search_path = public as $$
declare s sessions; r record; n int := 0;
begin
  select * into s from sessions where id = p_sid;
  if not found or s.template_id is null or s.state = 'draft' then return 0; end if;
  if not exists (select 1 from registrations where session_id = p_sid and participant_id = p_pid) then return 0; end if;
  for r in
    select exists (select 1 from registrations g where g.session_id = x.id and g.participant_id = p_pid) as att
    from sessions x
    where x.template_id = s.template_id and x.state <> 'draft'
      and (x.date::text || 'T' || coalesce(x.start_time, '00:00'), x.created_at) <= (s.date::text || 'T' || coalesce(s.start_time, '00:00'), s.created_at)
    order by x.date::text || 'T' || coalesce(x.start_time, '00:00') desc, x.created_at desc   -- created_at = pemutus seri
  loop
    exit when not r.att;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.gij__bonus(p_pid text, p_sid text) returns int
language plpgsql stable security definer set search_path = public as $$
declare st gij_settings; k int;
begin
  select * into st from gij_settings where id = 1;
  if st.streak_threshold <= 0 or st.streak_bonus <= 0 then return 0; end if;
  k := gij__streak_at(p_pid, p_sid);
  return case when k > 0 and k % st.streak_threshold = 0 then st.streak_bonus else 0 end;
end $$;

-- Tiket: 1 baris per jawapan betul + baris bonus streak
create or replace function public.gij__tickets(p_sid text) returns setof text
language sql stable security definer set search_path = public as $$
  select participant_id from answers where session_id = p_sid and is_correct
  union all
  select r.participant_id from registrations r
    cross join lateral generate_series(1, gij__bonus(r.participant_id, p_sid)) g
   where r.session_id = p_sid
$$;

-- Privasi: nama pertama sahaja, "Ahmad Hafiz bin Ali" → "Ahm***" (setara maskName() dalam index.html)
create or replace function public.gij__mask_name(p text) returns text language sql immutable as $$
  -- Nama pertama sahaja (tiada bin/binti atau nama bapa): "Ahmad Hafiz bin Ali" → "Ahm***"
  select case when w = '' then '' else left(w, least(3, greatest(1, length(w) - 2))) || '***' end
  from (select split_part(btrim(coalesce(p, '')), ' ', 1) as w) x
$$;

-- Bandingan nama bertoleransi (setara normName() dalam index.html)
create or replace function public.gij__norm_name(p text) returns text language sql immutable as $$
  select coalesce(string_agg(w, '' order by o), '')
  from regexp_split_to_table(regexp_replace(lower(coalesce(p, '')), '[^a-z]+', ' ', 'g'), ' ') with ordinality t(w, o)
  where w <> '' and w not in ('bin', 'binti', 'bt', 'bte', 'b', 'a', 'l', 'p', 'hj', 'haji', 'hajah', 'hajjah', 'hjh')
$$;

create or replace function public.gij__label(p_state text) returns text language sql immutable as $$
  select case p_state when 'draft' then 'Draf' when 'registration' then 'Pendaftaran' when 'questions' then 'Soalan dibuka'
    when 'closed' then 'Soalan ditutup' when 'drawing' then 'Cabutan' when 'done' then 'Selesai' else p_state end
$$;

create or replace function public.gij__transition_error(s public.sessions, p_to text) returns text
language plpgsql stable security definer set search_path = public as $$
declare allowed text[]; n int;
begin
  allowed := case p_to when 'registration' then array['draft'] when 'questions' then array['registration']
    when 'closed' then array['questions'] when 'drawing' then array['closed'] when 'done' then array['closed', 'drawing'] else null end;
  if allowed is null then return 'Keadaan tidak sah'; end if;
  if not (s.state = any (allowed)) then return format('Tidak boleh tukar dari "%s" ke "%s"', gij__label(s.state), gij__label(p_to)); end if;
  select count(*) into n from questions where session_id = s.id and status = 'lulus';
  if p_to in ('registration', 'questions') and (n < 3 or n > 5) then return format('Perlu 3–5 soalan diluluskan (kini %s)', n); end if;
  if p_to = 'drawing' and jsonb_array_length(s.prizes) = 0 then return 'Tetapkan sekurang-kurangnya satu hadiah dahulu'; end if;
  return '';
end $$;

-- ---------------------------------------------------------------------
-- RPC AJK (perlu PIN)
-- ---------------------------------------------------------------------
create or replace function public.gij_admin_check(p_pin text) returns boolean
language sql stable security definer set search_path = public, extensions as $$ select gij__pin_ok(p_pin) $$;

create or replace function public.gij_admin_snapshot(p_pin text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform gij__need_pin(p_pin);
  return jsonb_build_object(
    'settings', (select jsonb_build_object('masjidName', masjid_name,
                   'streak', jsonb_build_object('threshold', streak_threshold, 'bonus', streak_bonus),
                   'geo', jsonb_build_object('enabled', geo_enabled, 'lat', geo_lat, 'lng', geo_lng, 'radius', geo_radius))
                 from gij_settings where id = 1),
    'templates',     coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at) from templates t), '[]'),
    'sessions',      coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from sessions s), '[]'),
    'questions',     coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at) from questions q), '[]'),
    'participants',  coalesce((select jsonb_agg(to_jsonb(p) - 'secret' order by p.created_at) from participants p), '[]'),
    'registrations', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from registrations r), '[]'),
    'answers',       coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from answers a), '[]'),
    'winners',       coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at) from winners w), '[]'));
end $$;

/* p_ops: [{t:'templates'|'sessions'|'questions', op:'upsert', row:{...snake_case...}}
          | {t, op:'delete', id} | {t:'settings', row:{masjidName, streak, geo}} | {t:'pin', old, pin}]
   Upsert adalah SEPARA: hanya lajur yang ada dalam `row` dikemas kini. */
create or replace function public.gij_admin_write(p_pin text, p_ops jsonb) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare o jsonb; t text; r jsonb; v_sets text; v_cols text; v_exists boolean; v_sid text; v_state text;
begin
  perform gij__need_pin(p_pin);
  for o in select * from jsonb_array_elements(p_ops) loop
    t := o->>'t';
    if t = 'settings' then
      r := o->'row';
      update gij_settings set
        masjid_name      = coalesce(nullif(btrim(r->>'masjidName'), ''), masjid_name),
        streak_threshold = coalesce((r->'streak'->>'threshold')::int, streak_threshold),
        streak_bonus     = coalesce((r->'streak'->>'bonus')::int, streak_bonus),
        geo_enabled      = coalesce((r->'geo'->>'enabled')::boolean, geo_enabled),
        geo_lat          = case when r ? 'geo' then (r->'geo'->>'lat')::double precision else geo_lat end,
        geo_lng          = case when r ? 'geo' then (r->'geo'->>'lng')::double precision else geo_lng end,
        geo_radius       = coalesce((r->'geo'->>'radius')::int, geo_radius)
      where id = 1;
      continue;
    end if;
    if t = 'pin' then
      if not gij__pin_ok(o->>'old') then raise exception 'PIN semasa salah'; end if;
      if coalesce(o->>'pin', '') !~ '^\d{4,8}$' then raise exception 'PIN baharu mesti 4–8 digit'; end if;
      update gij_settings set pin_hash = crypt(o->>'pin', gen_salt('bf')) where id = 1;
      continue;
    end if;
    -- Padam peserta (cth. permintaan PDPA): rekod kehadiran/jawapan/kemenangan turut dipadam (cascade)
    if t = 'participants' then
      if o->>'op' <> 'delete' then raise exception 'Peserta hanya boleh dipadam'; end if;
      delete from participants where id = o->>'id';
      continue;
    end if;
    if t not in ('templates', 'sessions', 'questions') then raise exception 'Jadual tidak dibenarkan: %', t; end if;

    -- Soalan dikunci selepas soalan dibuka
    if t = 'questions' then
      v_sid := coalesce(o->'row'->>'session_id', (select session_id from questions where id = coalesce(o->'row'->>'id', o->>'id')));
      select state into v_state from sessions where id = v_sid;
      if v_state not in ('draft', 'registration') then raise exception 'Soalan dikunci (sesi: %)', gij__label(v_state); end if;
    end if;

    if o->>'op' = 'delete' then
      execute format('delete from public.%I where id = $1', t) using o->>'id';
      if t = 'questions' then perform gij__touch(v_sid); end if;
      continue;
    end if;

    r := o->'row';
    execute format('select exists (select 1 from public.%I where id = $1)', t) into v_exists using r->>'id';
    if v_exists then
      select string_agg(format('%I = x.%I', k, k), ', ') into v_sets
        from jsonb_object_keys(r) k
       where k <> 'id'
         and k not in ('state', 'state_at', 'questions_opened_at', 'questions_close_at', 'rev', 'created_at') -- keadaan hanya melalui gij_set_state
         and k in (select column_name from information_schema.columns where table_schema = 'public' and table_name = t);
      if v_sets is not null then
        execute format('update public.%1$I set %2$s from jsonb_populate_record(null::public.%1$I, $1) x where public.%1$I.id = $1->>''id''', t, v_sets) using r;
      end if;
    else
      select string_agg(format('%I', k), ', ') into v_cols
        from jsonb_object_keys(r) k
       where k in (select column_name from information_schema.columns where table_schema = 'public' and table_name = t)
         and not (t = 'sessions' and k in ('state', 'questions_opened_at', 'questions_close_at', 'rev'));
      execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $1)', t, v_cols) using r;
    end if;
    v_sid := case when t = 'sessions' then r->>'id' when t = 'questions' then v_sid else null end;
    if v_sid is not null then perform gij__touch(v_sid); end if;
  end loop;
end $$;

create or replace function public.gij_set_state(p_pin text, p_sid text, p_state text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare s sessions; v_err text;
begin
  perform gij__need_pin(p_pin);
  select * into s from sessions where id = p_sid for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'Sesi tidak ditemui'); end if;
  v_err := gij__transition_error(s, p_state);
  if v_err <> '' then return jsonb_build_object('ok', false, 'reason', v_err); end if;
  update sessions set
    state = p_state, state_at = now(), rev = rev + 1,
    questions_opened_at = case when p_state = 'questions' then now() else questions_opened_at end,
    questions_close_at  = case when p_state = 'questions' then now() + make_interval(mins => answer_minutes)
                               when p_state = 'closed' and questions_close_at > now() then now()
                               else questions_close_at end
  where id = p_sid;
  return jsonb_build_object('ok', true);
end $$;

-- Token QR dinamik: <slot>-<hmac>, slot = minit semasa (60 saat)
create or replace function public.gij_token(p_pin text, p_sid text) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_slot bigint := gij__now_ms() / 60000;
begin
  perform gij__need_pin(p_pin);
  return v_slot || '-' || gij__sign(p_sid || '|' || v_slot);
end $$;

-- Cabutan: pemenang dipilih DI PELAYAN (rawak kriptografi, berpemberat tiket)
create or replace function public.gij_draw(p_pin text, p_sid text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare s sessions; v_n int; v_prize text; v_pool text[]; v_winner text; v_others text[]; v_wheel text[]; v_spin int; w winners; v_now timestamptz := clock_timestamp();
begin
  perform gij__need_pin(p_pin);
  select * into s from sessions where id = p_sid for update;
  if not found or s.state <> 'drawing' then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
  select count(*) into v_n from winners where session_id = p_sid;
  v_prize := s.prizes->>v_n;
  if v_prize is null then return jsonb_build_object('ok', false, 'reason', 'noprize'); end if;
  if exists (select 1 from winners where session_id = p_sid and reveal_at > v_now) then return jsonb_build_object('ok', false, 'reason', 'spinning'); end if;
  select array_agg(t) into v_pool from gij__tickets(p_sid) t
   where t not in (select participant_id from winners where session_id = p_sid);
  if v_pool is null then return jsonb_build_object('ok', false, 'reason', 'nopool'); end if;
  v_winner := v_pool[1 + (('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % array_length(v_pool, 1))::int];
  select array_agg(x) into v_others from (
    select x from (select distinct x from unnest(v_pool) x where x <> v_winner) d order by random() limit 39) z;
  v_wheel := array(select y from unnest(array_append(coalesce(v_others, '{}'), v_winner)) y order by random());
  v_spin := 6000 + floor(random() * 2001)::int;
  insert into winners (id, session_id, participant_id, prize, "order", spin_ms, reveal_at, wheel)
  values (gij__uid('w_'), p_sid, v_winner, v_prize, v_n + 1, v_spin, v_now + make_interval(secs => (v_spin + 400) / 1000.0), to_jsonb(v_wheel))
  returning * into w;
  update sessions set rev = rev + 1 where id = p_sid;
  return jsonb_build_object('ok', true,
    'winner', jsonb_build_object('id', w.id, 'participantId', v_winner, 'name', (select name from participants where id = v_winner),
                                 'prize', v_prize, 'order', w."order", 'spinMs', v_spin, 'revealAt', w.reveal_at),
    'wheel', (select jsonb_agg(jsonb_build_object('id', y, 'name', (select name from participants where id = y)) order by o)
                from unnest(v_wheel) with ordinality u(y, o)));
end $$;

-- ---------------------------------------------------------------------
-- RPC JEMAAH (awam)
-- ---------------------------------------------------------------------
create or replace function public.gij_checkin(p_sid text, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare m text[]; v_slot bigint; v_now bigint := gij__now_ms();
begin
  if not exists (select 1 from sessions where id = p_sid) then return jsonb_build_object('ok', false, 'reason', 'notfound'); end if;
  m := regexp_match(coalesce(p_token, ''), '^(\d{1,12})-([0-9a-f]{16})$');
  if m is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  v_slot := m[1]::bigint;
  if gij__sign(p_sid || '|' || v_slot) <> m[2] or v_slot > v_now / 60000 then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_now > (v_slot + 1) * 60000 + 15000 then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  return jsonb_build_object('ok', true, 'ticket', v_now || '.' || gij__sign('ck|' || p_sid || '|' || v_now));
end $$;

-- Privasi: carian no. telefon HANYA memulangkan nama bertopeng
create or replace function public.gij_lookup(p_phone text) returns text
language sql stable security definer set search_path = public as $$
  select gij__mask_name(name) from participants where phone = p_phone
$$;

/* Peserta sedia ada disahkan dengan SAMA ADA p_secret (peranti yang diingati) ATAU nama penuh
   yang sepadan (gij__norm_name). 5 cubaan nama salah → dikunci 15 minit. */
drop function if exists public.gij_register(text, text, text, text, int);
create or replace function public.gij_register(p_sid text, p_ticket text, p_name text, p_phone text, p_dist int default null, p_secret text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare s sessions; p participants; r registrations; v_name text; v_fails int;
begin
  select * into s from sessions where id = p_sid;
  if not found then return jsonb_build_object('ok', false, 'reason', 'notfound'); end if;
  if s.state not in ('registration', 'questions') then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if not gij__ticket_ok(p_sid, p_ticket) then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if coalesce(p_phone, '') !~ '^01[0-9]{8,9}$' or (p_phone like '011%' and length(p_phone) <> 11) then
    return jsonb_build_object('ok', false, 'reason', 'phone');
  end if;
  select * into p from participants where phone = p_phone;
  if not found then
    v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
    if length(v_name) < 3 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
    insert into participants (id, name, phone) values (gij__uid('p_'), v_name, p_phone) on conflict (phone) do nothing;
    select * into p from participants where phone = p_phone;
  elsif p_secret is null or p_secret <> p.secret then
    select * into p from participants where id = p.id for update;
    if p.locked_until is not null and p.locked_until > now() then
      return jsonb_build_object('ok', false, 'reason', 'locked');
    end if;
    if gij__norm_name(p_name) = '' or gij__norm_name(p_name) <> gij__norm_name(p.name) then
      v_fails := p.name_fails + 1;
      if v_fails >= 5 then
        update participants set name_fails = 0, locked_until = now() + interval '15 minutes' where id = p.id;
        return jsonb_build_object('ok', false, 'reason', 'locked');
      end if;
      update participants set name_fails = v_fails where id = p.id;
      return jsonb_build_object('ok', false, 'reason', 'namemismatch', 'attemptsLeft', 5 - v_fails);
    end if;
    update participants set name_fails = 0, locked_until = null where id = p.id;
  end if;
  insert into registrations (id, session_id, participant_id, reg_no, dist)
  values (gij__uid('r_'), p_sid, p.id, coalesce((select max(reg_no) from registrations where session_id = p_sid), 0) + 1, p_dist)
  on conflict (session_id, participant_id) do nothing;
  select * into r from registrations where session_id = p_sid and participant_id = p.id;
  perform gij__touch(p_sid);
  return jsonb_build_object('ok', true, 'participantId', p.id, 'secret', p.secret, 'name', p.name, 'phone', p.phone, 'regNo', r.reg_no);
end $$;

create or replace function public.gij_submit(p_sid text, p_pid text, p_secret text, p_answers jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare s sessions; q record; v_ci int; v_n int := 0;
begin
  if not exists (select 1 from participants where id = p_pid and secret = p_secret)
     or not exists (select 1 from registrations where session_id = p_sid and participant_id = p_pid) then
    return jsonb_build_object('ok', false, 'reason', 'unverified');
  end if;
  select * into s from sessions where id = p_sid for update;
  if exists (select 1 from answers where session_id = p_sid and participant_id = p_pid) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  if s.state <> 'questions' or s.questions_close_at is null or clock_timestamp() > s.questions_close_at + interval '5 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  for q in select * from questions where session_id = p_sid and status = 'lulus' loop
    if coalesce(p_answers->>q.id, '') ~ '^[0-3]$' then
      v_ci := (p_answers->>q.id)::int;
      insert into answers (id, session_id, participant_id, question_id, choice_index, is_correct)
      values (gij__uid('a_'), p_sid, p_pid, q.id, v_ci, v_ci = q.correct_index);
      v_n := v_n + 1;
    end if;
  end loop;
  if v_n = 0 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  perform gij__touch(p_sid);
  return jsonb_build_object('ok', true, 'count', v_n);
end $$;

-- Paparan jemaah: HANYA maklumat yang jemaah boleh lihat (tiada jawapan betul sebelum sesi selesai)
create or replace function public.gij_jemaah_view(p_sid text, p_pid text, p_secret text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare st gij_settings; s sessions; p participants; reg registrations; myw winners;
        v_base jsonb; v_now timestamptz := clock_timestamp(); v_answering boolean; v_mine int := 0;
        v_correct int := 0; v_bonus int := 0; v_pending timestamptz;
begin
  select * into st from gij_settings where id = 1;
  v_base := jsonb_build_object('now', gij__now_ms(), 'masjidName', st.masjid_name,
    'geo', jsonb_build_object('enabled', st.geo_enabled, 'lat', st.geo_lat, 'lng', st.geo_lng, 'radius', st.geo_radius));
  select * into s from sessions where id = p_sid;
  if not found then return v_base || jsonb_build_object('ok', false, 'reason', 'notfound'); end if;
  select * into p from participants where id = p_pid and secret = p_secret;
  if p.id is not null then
    select * into reg from registrations where session_id = p_sid and participant_id = p.id;
    select count(*) into v_mine from answers where session_id = p_sid and participant_id = p.id;
    select * into myw from winners where session_id = p_sid and participant_id = p.id and reveal_at <= v_now;
  end if;
  if reg.id is not null then
    select count(*) into v_correct from answers where session_id = p_sid and participant_id = p.id and is_correct;
    v_bonus := gij__bonus(p.id, p_sid);
  end if;
  v_answering := s.state = 'questions' and s.questions_close_at is not null and v_now <= s.questions_close_at;
  select min(reveal_at) into v_pending from winners where session_id = p_sid and reveal_at > v_now;
  return v_base || jsonb_build_object(
    'ok', true, 'knownDevice', p.id is not null,
    'session', jsonb_build_object('id', s.id, 'title', s.title, 'speaker', s.speaker, 'date', s.date, 'startTime', s.start_time,
      'endTime', s.end_time, 'state', s.state, 'questionsCloseAt', s.questions_close_at,
      'qCount', (select count(*) from questions where session_id = s.id and status = 'lulus')),
    'registered', reg.id is not null, 'regNo', reg.reg_no, 'name', p.name,
    'streak', case when reg.id is not null then gij__streak_at(p.id, p_sid) else 0 end,
    'bonus', v_bonus,
    'answered', v_mine > 0,
    'tickets', case when reg.id is not null and (v_mine > 0 or (s.state not in ('draft', 'registration') and not v_answering))
                    then v_correct + v_bonus else null end,
    'questions', case when v_answering and reg.id is not null and v_mine = 0 then (
        select jsonb_agg(jsonb_build_object('id', q.id, 'text', q.text,
                 'options', (select jsonb_agg(jsonb_build_object('i', o.i - 1, 'text', o.v) order by md5(p.id || q.id || o.i::text))
                               from jsonb_array_elements_text(q.options) with ordinality o(v, i)))   -- susunan dirawak setiap peserta
               order by q.created_at)
        from questions q where q.session_id = p_sid and q.status = 'lulus') else null end,
    'win', case when myw.id is not null then jsonb_build_object('prize', myw.prize, 'order', myw."order") else null end,
    'pendingRevealAt', case when v_pending is null then null else (extract(epoch from v_pending) * 1000)::bigint end,
    'review', case when s.state = 'done' then jsonb_build_object('summary', s.summary, 'items', (
        select coalesce(jsonb_agg(jsonb_build_object('text', q.text, 'answer', q.options->>q.correct_index,
                 'mine', case when a.id is null then null else q.options->>a.choice_index end, 'correct', a.is_correct) order by q.created_at), '[]')
        from questions q left join answers a on a.question_id = q.id and a.participant_id = p.id
        where q.session_id = p_sid and q.status = 'lulus')) else null end);
end $$;

-- ---------------------------------------------------------------------
-- KEBENARAN FUNGSI
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.gij_admin_check(text), public.gij_admin_snapshot(text), public.gij_admin_write(text, jsonb),
  public.gij_set_state(text, text, text), public.gij_token(text, text), public.gij_draw(text, text),
  public.gij_checkin(text, text), public.gij_lookup(text), public.gij_register(text, text, text, text, int, text),
  public.gij_submit(text, text, text, jsonb), public.gij_jemaah_view(text, text, text)
to anon, authenticated;
