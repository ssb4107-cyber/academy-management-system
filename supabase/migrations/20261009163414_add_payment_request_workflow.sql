-- Typed payment request, approval, and immutable audit workflow.
-- Google Sheets remain preserved as the legacy fallback; new approved writes are
-- marked as SUPABASE so a later mirror refresh cannot silently replace them.

alter table academy_app.payments
  alter column source_run_id drop not null;

alter table academy_app.payments
  add column if not exists source_system text not null default 'GOOGLE_SNAPSHOT',
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_request_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'academy_payments_source_system_check'
      and conrelid = 'academy_app.payments'::regclass
  ) then
    alter table academy_app.payments
      add constraint academy_payments_source_system_check
      check (source_system in ('GOOGLE_SNAPSHOT', 'SUPABASE'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'academy_payments_version_check'
      and conrelid = 'academy_app.payments'::regclass
  ) then
    alter table academy_app.payments
      add constraint academy_payments_version_check check (version >= 1);
  end if;
end
$$;

create table if not exists academy_app.payment_requests (
  request_id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null,
  operation text not null check (operation in ('CREATE', 'UPDATE')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  target_payment_id text references academy_app.payments(payment_id),
  base_payment_version integer,
  student_id text not null references academy_app.students(student_id),
  student_name_snapshot text not null,
  pay_date date not null,
  payment_month text not null
    check (payment_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  item_type text not null check (char_length(btrim(item_type)) between 1 and 30),
  amount numeric(14,2) not null
    check (amount between 0 and 100000000 and amount = trunc(amount)),
  payment_method text not null
    check (payment_method in ('모락', '카드', '동백전QR', '현금영수증', '계좌이체', '동백전', '토스')),
  memo text check (memo is null or char_length(memo) <= 1000),
  reason text check (reason is null or char_length(reason) <= 500),
  requester_auth_user_id uuid not null,
  requester_email text not null,
  requester_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by_auth_user_id uuid,
  processed_by_email text,
  decision_memo text check (decision_memo is null or char_length(decision_memo) <= 500),
  approved_payment_id text references academy_app.payments(payment_id),
  schema_version integer not null default 1,
  unique (requester_auth_user_id, idempotency_key),
  check (
    (operation = 'CREATE' and target_payment_id is null and base_payment_version is null)
    or
    (operation = 'UPDATE' and target_payment_id is not null and base_payment_version >= 1)
  ),
  check (requester_email = lower(btrim(requester_email)))
);

create table if not exists academy_app.payment_request_events (
  event_id uuid primary key default gen_random_uuid(),
  request_id uuid not null references academy_app.payment_requests(request_id),
  event_type text not null
    check (event_type in ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  from_status text,
  to_status text not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists academy_app.payment_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  payment_id text not null references academy_app.payments(payment_id),
  request_id uuid not null references academy_app.payment_requests(request_id),
  action text not null check (action in ('CREATE', 'UPDATE')),
  previous_version integer,
  new_version integer not null,
  before_data jsonb,
  after_data jsonb not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  unique (request_id)
);

create index if not exists academy_payment_requests_requester_idx
  on academy_app.payment_requests (requester_auth_user_id, created_at desc);
create index if not exists academy_payment_requests_pending_idx
  on academy_app.payment_requests (created_at)
  where status = 'PENDING';
create index if not exists academy_payment_requests_student_idx
  on academy_app.payment_requests (student_id, created_at desc);
create index if not exists academy_payment_requests_target_idx
  on academy_app.payment_requests (target_payment_id)
  where target_payment_id is not null;
create index if not exists academy_payment_request_events_request_idx
  on academy_app.payment_request_events (request_id, created_at);
create index if not exists academy_payment_revisions_payment_idx
  on academy_app.payment_revisions (payment_id, created_at desc);

alter table academy_app.payment_requests enable row level security;
alter table academy_app.payment_requests force row level security;
alter table academy_app.payment_request_events enable row level security;
alter table academy_app.payment_request_events force row level security;
alter table academy_app.payment_revisions enable row level security;
alter table academy_app.payment_revisions force row level security;

revoke all on table academy_app.payment_requests from public, anon, authenticated;
revoke all on table academy_app.payment_request_events from public, anon, authenticated;
revoke all on table academy_app.payment_revisions from public, anon, authenticated;

drop policy if exists academy_payment_request_read on academy_app.payment_requests;
create policy academy_payment_request_read
on academy_app.payment_requests
for select
to authenticated
using (
  requester_auth_user_id = (select auth.uid())
  or exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
);

drop policy if exists academy_payment_request_insert on academy_app.payment_requests;
create policy academy_payment_request_insert
on academy_app.payment_requests
for insert
to authenticated
with check (
  requester_auth_user_id = (select auth.uid())
  and requester_email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
  and exists (
    select 1 from academy_app.user_access u
    where u.email = requester_email
      and u.active = true
      and (
        u.role = 'SUPER_ADMIN'
        or array_to_string(u.permissions, ',') ~* '(^|,)[[:space:]]*PAYMENT_DASHBOARD[[:space:]]*(,|$)'
      )
  )
  and exists (
    select 1 from academy_app.students s
    where s.student_id = payment_requests.student_id
  )
);

drop policy if exists academy_payment_request_admin_update on academy_app.payment_requests;
create policy academy_payment_request_admin_update
on academy_app.payment_requests
for update
to authenticated
using (
  exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
)
with check (
  exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
);

drop policy if exists academy_payment_request_owner_cancel on academy_app.payment_requests;
create policy academy_payment_request_owner_cancel
on academy_app.payment_requests
for update
to authenticated
using (
  requester_auth_user_id = (select auth.uid())
  and status = 'PENDING'
)
with check (
  requester_auth_user_id = (select auth.uid())
  and status = 'CANCELLED'
);

drop policy if exists academy_payment_event_read on academy_app.payment_request_events;
create policy academy_payment_event_read
on academy_app.payment_request_events
for select
to authenticated
using (
  exists (
    select 1 from academy_app.payment_requests r
    where r.request_id = payment_request_events.request_id
  )
);

drop policy if exists academy_payment_event_insert on academy_app.payment_request_events;
create policy academy_payment_event_insert
on academy_app.payment_request_events
for insert
to authenticated
with check (
  actor_auth_user_id = (select auth.uid())
  and actor_email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
  and exists (
    select 1 from academy_app.payment_requests r
    where r.request_id = payment_request_events.request_id
  )
);

drop policy if exists academy_payment_revision_read on academy_app.payment_revisions;
create policy academy_payment_revision_read
on academy_app.payment_revisions
for select
to authenticated
using (
  exists (
    select 1 from academy_app.payments p
    where p.payment_id = payment_revisions.payment_id
  )
);

drop policy if exists academy_payment_revision_admin_insert on academy_app.payment_revisions;
create policy academy_payment_revision_admin_insert
on academy_app.payment_revisions
for insert
to authenticated
with check (
  actor_auth_user_id = (select auth.uid())
  and actor_email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
  and exists (
    select 1 from academy_app.user_access u
    where u.email = actor_email and u.active = true and u.role = 'SUPER_ADMIN'
  )
);

drop policy if exists academy_payment_admin_insert on academy_app.payments;
create policy academy_payment_admin_insert
on academy_app.payments
for insert
to authenticated
with check (
  exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true and u.role = 'SUPER_ADMIN'
  )
);

drop policy if exists academy_payment_admin_update on academy_app.payments;
create policy academy_payment_admin_update
on academy_app.payments
for update
to authenticated
using (
  exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true and u.role = 'SUPER_ADMIN'
  )
)
with check (
  exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true and u.role = 'SUPER_ADMIN'
  )
);

grant select, insert, update on table academy_app.payment_requests to authenticated;
grant select, insert on table academy_app.payment_request_events to authenticated;
grant select, insert on table academy_app.payment_revisions to authenticated;
grant select, insert, update on table academy_app.payments to authenticated;

create or replace function public.submit_payment_request(
  p_operation text,
  p_student_id text,
  p_pay_date date,
  p_payment_month text,
  p_item_type text,
  p_amount numeric,
  p_payment_method text,
  p_memo text default null,
  p_reason text default null,
  p_target_payment_id text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_operation text := upper(btrim(coalesce(p_operation, '')));
  v_student_id text := btrim(coalesce(p_student_id, ''));
  v_item_type text := btrim(coalesce(p_item_type, ''));
  v_method text := btrim(coalesce(p_payment_method, ''));
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_target text := nullif(btrim(coalesce(p_target_payment_id, '')), '');
  v_key uuid := coalesce(p_idempotency_key, gen_random_uuid());
  v_user academy_app.user_access%rowtype;
  v_student academy_app.students%rowtype;
  v_payment academy_app.payments%rowtype;
  v_request academy_app.payment_requests%rowtype;
  v_inserted boolean := false;
  v_duplicate_count bigint := 0;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;

  select * into v_user
  from academy_app.user_access
  where email = v_email and active = true;

  if not found or (
    v_user.role <> 'SUPER_ADMIN'
    and array_to_string(v_user.permissions, ',') !~* '(^|,)[[:space:]]*PAYMENT_DASHBOARD[[:space:]]*(,|$)'
  ) then
    raise exception using errcode = '42501', message = '수납 요청 권한이 없습니다.';
  end if;

  if v_operation not in ('CREATE', 'UPDATE') then
    raise exception using errcode = '22023', message = '수납 요청 유형이 올바르지 않습니다.';
  end if;
  if p_pay_date is null then
    raise exception using errcode = '22023', message = '납부일을 입력해주세요.';
  end if;
  if coalesce(p_payment_month, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = '22023', message = '귀속월 형식이 올바르지 않습니다.';
  end if;
  if char_length(v_item_type) not between 1 and 30 then
    raise exception using errcode = '22023', message = '수납 항목을 확인해주세요.';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 100000000 or p_amount <> trunc(p_amount) then
    raise exception using errcode = '22023', message = '수납 금액은 0원 이상 원 단위 정수로 입력해주세요.';
  end if;
  if v_method not in ('모락', '카드', '동백전QR', '현금영수증', '계좌이체', '동백전', '토스') then
    raise exception using errcode = '22023', message = '허용되지 않은 납부 방식입니다.';
  end if;
  if char_length(coalesce(v_memo, '')) > 1000 or char_length(coalesce(v_reason, '')) > 500 then
    raise exception using errcode = '22023', message = '메모 또는 요청 사유가 너무 깁니다.';
  end if;

  select * into v_student
  from academy_app.students
  where student_id = v_student_id;
  if not found then
    raise exception using errcode = '42501', message = '학생을 찾을 수 없거나 요청 권한이 없습니다.';
  end if;

  if v_operation = 'CREATE' then
    if v_target is not null then
      raise exception using errcode = '22023', message = '신규 수납 요청에는 기존 수납 ID를 지정할 수 없습니다.';
    end if;
  else
    if v_target is null then
      raise exception using errcode = '22023', message = '수정할 수납 기록을 선택해주세요.';
    end if;
    select * into v_payment
    from academy_app.payments
    where payment_id = v_target and record_status = 'ACTIVE';
    if not found or v_payment.student_id <> v_student_id then
      raise exception using errcode = '42501', message = '수정할 수납 기록을 찾을 수 없거나 요청 권한이 없습니다.';
    end if;
  end if;

  insert into academy_app.payment_requests (
    idempotency_key, operation, target_payment_id, base_payment_version,
    student_id, student_name_snapshot, pay_date, payment_month,
    item_type, amount, payment_method, memo, reason,
    requester_auth_user_id, requester_email, requester_name
  ) values (
    v_key, v_operation, v_target,
    case when v_operation = 'UPDATE' then v_payment.version else null end,
    v_student.student_id, v_student.student_name, p_pay_date, p_payment_month,
    v_item_type, p_amount, v_method, v_memo, v_reason,
    v_uid, v_email, v_user.display_name
  )
  on conflict (requester_auth_user_id, idempotency_key) do nothing
  returning * into v_request;

  if found then
    v_inserted := true;
    insert into academy_app.payment_request_events (
      request_id, event_type, from_status, to_status,
      actor_auth_user_id, actor_email, details
    ) values (
      v_request.request_id, 'SUBMITTED', null, 'PENDING',
      v_uid, v_email,
      jsonb_build_object('operation', v_operation, 'targetPaymentId', v_target)
    );
  else
    select * into v_request
    from academy_app.payment_requests
    where requester_auth_user_id = v_uid and idempotency_key = v_key;
    if not found
      or v_request.operation <> v_operation
      or v_request.student_id <> v_student_id
      or v_request.pay_date <> p_pay_date
      or v_request.payment_month <> p_payment_month
      or v_request.item_type <> v_item_type
      or v_request.amount <> p_amount
      or v_request.payment_method <> v_method
      or v_request.memo is distinct from v_memo
      or v_request.reason is distinct from v_reason
      or v_request.target_payment_id is distinct from v_target then
      raise exception using errcode = '23505', message = '같은 요청 키로 다른 수납 내용이 전송되었습니다. 새 요청으로 다시 등록해주세요.';
    end if;
  end if;

  select count(*) into v_duplicate_count
  from academy_app.payments p
  where p.record_status = 'ACTIVE'
    and p.student_id = v_request.student_id
    and p.payment_month = v_request.payment_month
    and p.item_type = v_request.item_type
    and p.amount = v_request.amount
    and p.pay_date = v_request.pay_date
    and (v_request.target_payment_id is null or p.payment_id <> v_request.target_payment_id);

  return jsonb_build_object(
    'requestId', v_request.request_id,
    'idempotencyKey', v_request.idempotency_key,
    'status', v_request.status,
    'duplicate', not v_inserted,
    'duplicatePaymentCount', v_duplicate_count
  );
end;
$$;

create or replace function public.search_my_payment_requests(
  p_status text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_user academy_app.user_access%rowtype;
  v_total bigint;
  v_pending bigint;
  v_rows jsonb;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;
  select * into v_user from academy_app.user_access
  where email = v_email and active = true;
  if not found then
    raise exception using errcode = '42501', message = '수납 요청 조회 권한이 없습니다.';
  end if;
  if v_status <> '' and v_status not in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') then
    raise exception using errcode = '22023', message = '요청 상태가 올바르지 않습니다.';
  end if;

  select count(*), count(*) filter (where r.status = 'PENDING')
  into v_total, v_pending
  from academy_app.payment_requests r
  where v_status = '' or r.status = v_status;

  select coalesce(jsonb_agg(item order by sort_created desc, sort_id desc), '[]'::jsonb)
  into v_rows
  from (
    select jsonb_build_object(
      'requestId', r.request_id,
      'operation', r.operation,
      'status', r.status,
      'targetPaymentId', r.target_payment_id,
      'basePaymentVersion', r.base_payment_version,
      'studentId', r.student_id,
      'studentName', r.student_name_snapshot,
      'payDate', to_char(r.pay_date, 'YYYY-MM-DD'),
      'paymentMonth', r.payment_month,
      'itemType', r.item_type,
      'amount', r.amount,
      'paymentMethod', r.payment_method,
      'memo', r.memo,
      'reason', r.reason,
      'requesterName', r.requester_name,
      'requesterEmail', r.requester_email,
      'createdAt', to_char(r.created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'),
      'processedAt', case when r.processed_at is null then null else to_char(r.processed_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') end,
      'processedByEmail', r.processed_by_email,
      'decisionMemo', r.decision_memo,
      'approvedPaymentId', r.approved_payment_id,
      'duplicatePaymentCount', (
        select count(*) from academy_app.payments p
        where p.record_status = 'ACTIVE'
          and p.student_id = r.student_id
          and p.payment_month = r.payment_month
          and p.item_type = r.item_type
          and p.amount = r.amount
          and p.pay_date = r.pay_date
          and (r.target_payment_id is null or p.payment_id <> r.target_payment_id)
      )
    ) item,
    r.created_at sort_created,
    r.request_id sort_id
    from academy_app.payment_requests r
    where v_status = '' or r.status = v_status
    order by r.created_at desc, r.request_id desc
    limit v_limit offset v_offset
  ) q;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'pending', v_pending,
    'canApprove', v_user.role = 'SUPER_ADMIN',
    'limit', v_limit,
    'offset', v_offset
  );
end;
$$;

create or replace function public.decide_payment_request(
  p_request_id uuid,
  p_decision text,
  p_memo text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_decision text := upper(btrim(coalesce(p_decision, '')));
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_user academy_app.user_access%rowtype;
  v_request academy_app.payment_requests%rowtype;
  v_payment academy_app.payments%rowtype;
  v_before jsonb;
  v_payment_id text;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;
  select * into v_user from academy_app.user_access
  where email = v_email and active = true and role = 'SUPER_ADMIN';
  if not found then
    raise exception using errcode = '42501', message = '최고 관리자만 수납 요청을 처리할 수 있습니다.';
  end if;
  if v_decision not in ('APPROVE', 'REJECT') then
    raise exception using errcode = '22023', message = '승인 또는 반려를 선택해주세요.';
  end if;
  if char_length(coalesce(v_memo, '')) > 500 then
    raise exception using errcode = '22023', message = '처리 메모는 500자 이내로 입력해주세요.';
  end if;

  select * into v_request
  from academy_app.payment_requests
  where request_id = p_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '수납 요청을 찾을 수 없습니다.';
  end if;
  if v_request.status <> 'PENDING' then
    raise exception using errcode = '55000', message = '승인 대기 상태인 요청만 처리할 수 있습니다.';
  end if;

  if v_decision = 'REJECT' then
    update academy_app.payment_requests
    set status = 'REJECTED', processed_at = now(), processed_by_auth_user_id = v_uid,
        processed_by_email = v_email, decision_memo = v_memo, updated_at = now()
    where request_id = v_request.request_id;
    insert into academy_app.payment_request_events (
      request_id, event_type, from_status, to_status,
      actor_auth_user_id, actor_email, details
    ) values (
      v_request.request_id, 'REJECTED', 'PENDING', 'REJECTED',
      v_uid, v_email, jsonb_build_object('memo', v_memo)
    );
    return jsonb_build_object('requestId', v_request.request_id, 'status', 'REJECTED');
  end if;

  if v_request.operation = 'CREATE' then
    v_payment_id := 'PAY-SB-' || upper(replace(gen_random_uuid()::text, '-', ''));
    insert into academy_app.payments (
      payment_id, created_at, pay_date, student_id, student_name_snapshot,
      payment_month, item_type, amount, payment_method, memo, request_id,
      record_status, source_run_id, source_system, version, updated_at,
      last_request_id
    ) values (
      v_payment_id, now(), v_request.pay_date, v_request.student_id, v_request.student_name_snapshot,
      v_request.payment_month, v_request.item_type, v_request.amount, v_request.payment_method,
      v_request.memo, v_request.request_id::text, 'ACTIVE', null, 'SUPABASE', 1, now(),
      v_request.request_id
    ) returning * into v_payment;

    insert into academy_app.payment_revisions (
      payment_id, request_id, action, previous_version, new_version,
      before_data, after_data, actor_auth_user_id, actor_email
    ) values (
      v_payment.payment_id, v_request.request_id, 'CREATE', null, 1,
      null, to_jsonb(v_payment), v_uid, v_email
    );
  else
    select * into v_payment
    from academy_app.payments
    where payment_id = v_request.target_payment_id
    for update;
    if not found or v_payment.record_status <> 'ACTIVE' then
      raise exception using errcode = '55000', message = '수정 대상 수납 기록이 없거나 더 이상 활성 상태가 아닙니다.';
    end if;
    if v_payment.version <> v_request.base_payment_version then
      raise exception using errcode = '40001', message = '요청 후 수납 원본이 변경되었습니다. 새 수정 요청을 등록해주세요.';
    end if;
    if v_payment.student_id <> v_request.student_id then
      raise exception using errcode = '55000', message = '수정 대상 학생 정보가 요청과 일치하지 않습니다.';
    end if;
    v_before := to_jsonb(v_payment);
    v_payment_id := v_payment.payment_id;
    update academy_app.payments
    set pay_date = v_request.pay_date,
        student_name_snapshot = v_request.student_name_snapshot,
        payment_month = v_request.payment_month,
        item_type = v_request.item_type,
        amount = v_request.amount,
        payment_method = v_request.payment_method,
        memo = v_request.memo,
        version = version + 1,
        updated_at = now(),
        last_request_id = v_request.request_id
    where payment_id = v_payment.payment_id
    returning * into v_payment;

    insert into academy_app.payment_revisions (
      payment_id, request_id, action, previous_version, new_version,
      before_data, after_data, actor_auth_user_id, actor_email
    ) values (
      v_payment.payment_id, v_request.request_id, 'UPDATE', v_request.base_payment_version,
      v_payment.version, v_before, to_jsonb(v_payment), v_uid, v_email
    );
  end if;

  update academy_app.payment_requests
  set status = 'APPROVED', processed_at = now(), processed_by_auth_user_id = v_uid,
      processed_by_email = v_email, decision_memo = v_memo,
      approved_payment_id = v_payment_id, updated_at = now()
  where request_id = v_request.request_id;

  insert into academy_app.payment_request_events (
    request_id, event_type, from_status, to_status,
    actor_auth_user_id, actor_email, details
  ) values (
    v_request.request_id, 'APPROVED', 'PENDING', 'APPROVED',
    v_uid, v_email,
    jsonb_build_object('paymentId', v_payment_id, 'operation', v_request.operation, 'memo', v_memo)
  );

  return jsonb_build_object(
    'requestId', v_request.request_id,
    'status', 'APPROVED',
    'paymentId', v_payment_id,
    'operation', v_request.operation
  );
end;
$$;

create or replace function public.cancel_my_payment_request(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_request academy_app.payment_requests%rowtype;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;
  select * into v_request
  from academy_app.payment_requests
  where request_id = p_request_id
  for update;
  if not found or v_request.requester_auth_user_id <> v_uid then
    raise exception using errcode = '42501', message = '본인이 등록한 수납 요청만 취소할 수 있습니다.';
  end if;
  if v_request.status <> 'PENDING' then
    raise exception using errcode = '55000', message = '승인 대기 상태인 요청만 취소할 수 있습니다.';
  end if;

  update academy_app.payment_requests
  set status = 'CANCELLED', updated_at = now()
  where request_id = v_request.request_id;
  insert into academy_app.payment_request_events (
    request_id, event_type, from_status, to_status,
    actor_auth_user_id, actor_email, details
  ) values (
    v_request.request_id, 'CANCELLED', 'PENDING', 'CANCELLED',
    v_uid, v_email, '{}'::jsonb
  );
  return jsonb_build_object('requestId', v_request.request_id, 'status', 'CANCELLED');
end;
$$;

create or replace function public.search_my_payments(
  p_month text default null,
  p_query text default null,
  p_method text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_month text := btrim(coalesce(p_month, ''));
  v_query text := btrim(coalesce(p_query, ''));
  v_method text := btrim(coalesce(p_method, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 300);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_amount numeric;
  v_rows jsonb;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;
  if not exists (
    select 1 from academy_app.user_access
    where email = v_email and active = true and role in ('SUPER_ADMIN', 'MANAGER')
  ) then
    raise exception using errcode = '42501', message = '수납 조회 권한이 없습니다.';
  end if;
  if v_month = '' then
    select max(payment_month) into v_month
    from academy_app.payments where record_status = 'ACTIVE';
  end if;
  if v_month is null or v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = '22023', message = '조회 월 형식이 올바르지 않습니다.';
  end if;

  select count(*), coalesce(sum(p.amount), 0)
  into v_total, v_amount
  from academy_app.payments p
  join academy_app.students s on s.student_id = p.student_id
  where p.record_status = 'ACTIVE' and p.payment_month = v_month
    and (v_method = '' or p.payment_method = v_method)
    and (v_query = '' or s.student_name ilike '%' || v_query || '%'
      or coalesce(s.grade_label, '') ilike '%' || v_query || '%');

  select coalesce(jsonb_agg(item order by sort_date desc, sort_id desc), '[]'::jsonb)
  into v_rows
  from (
    select jsonb_build_object(
      'paymentId', p.payment_id,
      'payDate', to_char(p.pay_date, 'YYYY-MM-DD'),
      'studentId', p.student_id,
      'studentName', s.student_name,
      'gradeLabel', s.grade_label,
      'paymentMonth', p.payment_month,
      'itemType', p.item_type,
      'amount', p.amount,
      'paymentMethod', p.payment_method,
      'memo', p.memo,
      'calculationType', p.calculation_type,
      'version', p.version,
      'sourceSystem', p.source_system
    ) item,
    p.pay_date sort_date,
    p.payment_id sort_id
    from academy_app.payments p
    join academy_app.students s on s.student_id = p.student_id
    where p.record_status = 'ACTIVE' and p.payment_month = v_month
      and (v_method = '' or p.payment_method = v_method)
      and (v_query = '' or s.student_name ilike '%' || v_query || '%'
        or coalesce(s.grade_label, '') ilike '%' || v_query || '%')
    order by p.pay_date desc, p.payment_id desc
    limit v_limit offset v_offset
  ) q;

  return jsonb_build_object(
    'month', v_month, 'rows', v_rows, 'total', v_total,
    'totalAmount', v_amount, 'limit', v_limit, 'offset', v_offset
  );
end;
$$;

revoke all on function public.submit_payment_request(text, text, date, text, text, numeric, text, text, text, text, uuid) from public, anon;
revoke all on function public.search_my_payment_requests(text, integer, integer) from public, anon;
revoke all on function public.decide_payment_request(uuid, text, text) from public, anon;
revoke all on function public.cancel_my_payment_request(uuid) from public, anon;
grant execute on function public.submit_payment_request(text, text, date, text, text, numeric, text, text, text, text, uuid) to authenticated;
grant execute on function public.search_my_payment_requests(text, integer, integer) to authenticated;
grant execute on function public.decide_payment_request(uuid, text, text) to authenticated;
grant execute on function public.cancel_my_payment_request(uuid) to authenticated;

comment on table academy_app.payment_requests is 'Typed Supabase payment create/update requests preserving the legacy DB_요청 approval semantics.';
comment on table academy_app.payment_request_events is 'Immutable payment request status audit trail.';
comment on table academy_app.payment_revisions is 'Immutable before/after snapshots for approved payment writes.';
comment on function public.submit_payment_request(text, text, date, text, text, numeric, text, text, text, text, uuid) is 'Creates an idempotent payment create or update request for an authorized student.';
comment on function public.decide_payment_request(uuid, text, text) is 'Atomically approves or rejects a pending payment request; approval writes the ledger and revision audit.';
