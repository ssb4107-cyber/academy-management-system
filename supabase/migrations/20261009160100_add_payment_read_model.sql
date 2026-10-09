create table if not exists academy_app.payments (
  payment_id text primary key,
  created_at timestamptz not null,
  pay_date date not null,
  student_id text not null references academy_app.students(student_id),
  student_name_snapshot text not null,
  payment_month text not null check (payment_month ~ '^[0-9]{4}-[0-9]{2}$'),
  item_type text not null,
  amount numeric(14,2) not null,
  payment_method text,
  memo text,
  request_id text,
  record_status text not null,
  calculation_type text,
  calculation_start date,
  calculation_end date,
  active_days text,
  billing_days text,
  sibling_discount numeric(14,2) not null default 0,
  other_discount numeric(14,2) not null default 0,
  source_run_id uuid not null,
  synced_at timestamptz not null default now()
);

alter table academy_app.payments enable row level security;
alter table academy_app.payments force row level security;
revoke all on table academy_app.payments from public, anon, authenticated;

truncate table academy_app.payments;
insert into academy_app.payments (
  payment_id, created_at, pay_date, student_id, student_name_snapshot,
  payment_month, item_type, amount, payment_method, memo, request_id,
  record_status, calculation_type, calculation_start, calculation_end,
  active_days, billing_days, sibling_discount, other_discount,
  source_run_id, synced_at
)
select
  btrim(record_json->>'수납ID'),
  (btrim(record_json->>'등록일시'))::timestamptz,
  ((btrim(record_json->>'납부일'))::timestamptz at time zone 'Asia/Seoul')::date,
  btrim(record_json->>'학생ID'),
  btrim(record_json->>'학생명'),
  to_char((btrim(record_json->>'귀속월'))::timestamptz at time zone 'Asia/Seoul', 'YYYY-MM'),
  coalesce(nullif(btrim(record_json->>'수납항목'), ''), '수강료'),
  regexp_replace(record_json->>'납부금액', '[^0-9.-]', '', 'g')::numeric(14,2),
  nullif(btrim(record_json->>'납부방식'), ''),
  nullif(btrim(record_json->>'메모'), ''),
  nullif(btrim(record_json->>'요청ID'), ''),
  coalesce(nullif(btrim(record_json->>'레코드상태'), ''), 'ACTIVE'),
  nullif(btrim(record_json->>'계산유형'), ''),
  case when nullif(btrim(record_json->>'계산시작일'), '') is null then null
    else ((btrim(record_json->>'계산시작일'))::timestamptz at time zone 'Asia/Seoul')::date end,
  case when nullif(btrim(record_json->>'계산종료일'), '') is null then null
    else ((btrim(record_json->>'계산종료일'))::timestamptz at time zone 'Asia/Seoul')::date end,
  nullif(btrim(record_json->>'적용일수'), ''),
  nullif(btrim(record_json->>'기준일수'), ''),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'형제할인', ''), '[^0-9.-]', '', 'g'), '')::numeric(14,2), 0),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'기타할인', ''), '[^0-9.-]', '', 'g'), '')::numeric(14,2), 0),
  run_id,
  now()
from academy_mirror.latest_sheet_rows
where sheet_name = 'DB_수납'
  and source_row_number > 1
  and nullif(btrim(record_json->>'수납ID'), '') is not null;

create index if not exists academy_payments_student_month_idx
  on academy_app.payments (student_id, payment_month desc, pay_date desc);
create index if not exists academy_payments_month_date_idx
  on academy_app.payments (payment_month desc, pay_date desc);
create index if not exists academy_payments_method_idx
  on academy_app.payments (payment_month, payment_method);

drop policy if exists academy_payment_scope_read on academy_app.payments;
create policy academy_payment_scope_read
on academy_app.payments
for select
to authenticated
using (
  exists (
    select 1
    from academy_app.students s
    where s.student_id = payments.student_id
  )
);

grant select on table academy_app.payments to authenticated;

create or replace function public.get_my_payment_overview()
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_months jsonb;
  v_latest text;
  v_count bigint;
  v_amount numeric;
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

  select coalesce(jsonb_agg(payment_month order by payment_month desc), '[]'::jsonb), max(payment_month)
  into v_months, v_latest
  from (
    select distinct payment_month
    from academy_app.payments
    where record_status = 'ACTIVE'
  ) months;

  select count(*), coalesce(sum(amount), 0)
  into v_count, v_amount
  from academy_app.payments
  where record_status = 'ACTIVE' and payment_month = v_latest;

  return jsonb_build_object(
    'months', v_months,
    'latestMonth', v_latest,
    'latestCount', v_count,
    'latestAmount', v_amount
  );
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
    from academy_app.payments
    where record_status = 'ACTIVE';
  end if;
  if v_month is null or v_month !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception using errcode = '22023', message = '조회 월 형식이 올바르지 않습니다.';
  end if;

  select count(*), coalesce(sum(p.amount), 0)
  into v_total, v_amount
  from academy_app.payments p
  join academy_app.students s on s.student_id = p.student_id
  where p.record_status = 'ACTIVE'
    and p.payment_month = v_month
    and (v_method = '' or p.payment_method = v_method)
    and (
      v_query = ''
      or s.student_name ilike '%' || v_query || '%'
      or coalesce(s.grade_label, '') ilike '%' || v_query || '%'
    );

  select coalesce(jsonb_agg(item order by sort_date desc, sort_id desc), '[]'::jsonb)
  into v_rows
  from (
    select
      jsonb_build_object(
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
        'calculationType', p.calculation_type
      ) as item,
      p.pay_date as sort_date,
      p.payment_id as sort_id
    from academy_app.payments p
    join academy_app.students s on s.student_id = p.student_id
    where p.record_status = 'ACTIVE'
      and p.payment_month = v_month
      and (v_method = '' or p.payment_method = v_method)
      and (
        v_query = ''
        or s.student_name ilike '%' || v_query || '%'
        or coalesce(s.grade_label, '') ilike '%' || v_query || '%'
      )
    order by p.pay_date desc, p.payment_id desc
    limit v_limit offset v_offset
  ) q;

  return jsonb_build_object(
    'month', v_month,
    'rows', v_rows,
    'total', v_total,
    'totalAmount', v_amount,
    'limit', v_limit,
    'offset', v_offset
  );
end;
$$;

create or replace function public.get_my_student_payments(
  p_student_id text,
  p_limit integer default 100,
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
  v_student_id text := btrim(coalesce(p_student_id, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_amount numeric;
  v_rows jsonb;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;
  if not exists (
    select 1 from academy_app.students where student_id = v_student_id
  ) then
    raise exception using errcode = '42501', message = '학생을 찾을 수 없거나 수납 조회 권한이 없습니다.';
  end if;

  select count(*), coalesce(sum(amount), 0)
  into v_total, v_amount
  from academy_app.payments
  where student_id = v_student_id and record_status = 'ACTIVE';

  select coalesce(jsonb_agg(item order by sort_month desc, sort_date desc, sort_id desc), '[]'::jsonb)
  into v_rows
  from (
    select
      jsonb_build_object(
        'paymentId', payment_id,
        'payDate', to_char(pay_date, 'YYYY-MM-DD'),
        'paymentMonth', payment_month,
        'itemType', item_type,
        'amount', amount,
        'paymentMethod', payment_method,
        'memo', memo,
        'calculationType', calculation_type,
        'calculationStart', case when calculation_start is null then null else to_char(calculation_start, 'YYYY-MM-DD') end,
        'calculationEnd', case when calculation_end is null then null else to_char(calculation_end, 'YYYY-MM-DD') end,
        'activeDays', active_days,
        'billingDays', billing_days,
        'siblingDiscount', sibling_discount,
        'otherDiscount', other_discount
      ) as item,
      payment_month as sort_month,
      pay_date as sort_date,
      payment_id as sort_id
    from academy_app.payments
    where student_id = v_student_id and record_status = 'ACTIVE'
    order by payment_month desc, pay_date desc, payment_id desc
    limit v_limit offset v_offset
  ) q;

  return jsonb_build_object(
    'studentId', v_student_id,
    'rows', v_rows,
    'total', v_total,
    'totalAmount', v_amount,
    'limit', v_limit,
    'offset', v_offset
  );
end;
$$;

revoke all on function public.get_my_payment_overview() from public, anon;
revoke all on function public.search_my_payments(text, text, text, integer, integer) from public, anon;
revoke all on function public.get_my_student_payments(text, integer, integer) from public, anon;
grant execute on function public.get_my_payment_overview() to authenticated;
grant execute on function public.search_my_payments(text, text, text, integer, integer) to authenticated;
grant execute on function public.get_my_student_payments(text, integer, integer) to authenticated;
