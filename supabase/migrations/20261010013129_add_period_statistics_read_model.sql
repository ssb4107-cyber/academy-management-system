-- Period statistics read model. It preserves the Google monthly snapshot facts
-- and combines them with live typed payments, vacations and salary ledgers.

create table if not exists academy_app.operational_settings (
  setting_key text primary key,
  category text,
  setting_label text,
  value_text text not null,
  value_type text,
  min_value text,
  max_value text,
  description text,
  source_run_id uuid not null,
  synced_at timestamptz not null default now()
);

create table if not exists academy_app.monthly_student_facts (
  snapshot_id text primary key,
  snapshot_month date not null check (snapshot_month=date_trunc('month',snapshot_month)::date),
  student_id text not null references academy_app.students(student_id),
  in_month boolean not null,
  first_date date,
  exit_date date,
  active_days integer not null check (active_days between 0 and 31),
  billing_days integer not null check (billing_days between 1 and 31),
  vacation_days integer not null check (vacation_days between 0 and 31),
  teacher_id text,
  teacher_name text,
  status text,
  course_mode text,
  base_fee numeric(14,2) not null default 0,
  sibling_discount numeric(14,2) not null default 0,
  billable_fee numeric(14,2) not null default 0,
  fact_json jsonb not null,
  source_version text,
  source_generated_at timestamptz,
  source_run_id uuid not null,
  synced_at timestamptz not null default now(),
  unique(snapshot_month,student_id)
);

create table if not exists academy_app.salary_settlements (
  settlement_id text primary key,
  settlement_month date not null check (settlement_month=date_trunc('month',settlement_month)::date),
  teacher_id text,
  teacher_name text not null,
  settlement_status text not null,
  base_amount numeric(14,2) not null default 0,
  adjustment_amount numeric(14,2) not null default 0,
  final_amount numeric(14,2) not null default 0,
  paid_amount numeric(14,2) not null default 0,
  balance_amount numeric(14,2) not null default 0,
  source_type text,
  memo text,
  created_at timestamptz,
  updated_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by text,
  source_run_id uuid not null,
  synced_at timestamptz not null default now()
);

create table if not exists academy_app.salary_entries (
  entry_id text primary key,
  settlement_id text not null references academy_app.salary_settlements(settlement_id),
  entry_type text not null,
  amount numeric(14,2) not null default 0,
  entry_date date,
  memo text,
  created_at timestamptz,
  created_by text,
  entry_status text not null,
  reference_id text,
  details_json jsonb,
  source_run_id uuid not null,
  synced_at timestamptz not null default now()
);

create index if not exists academy_monthly_student_facts_month_idx
  on academy_app.monthly_student_facts(snapshot_month,student_id);
create index if not exists academy_monthly_student_facts_student_idx
  on academy_app.monthly_student_facts(student_id,snapshot_month desc);
create index if not exists academy_salary_settlements_month_idx
  on academy_app.salary_settlements(settlement_month,settlement_status);
create index if not exists academy_salary_entries_settlement_date_idx
  on academy_app.salary_entries(settlement_id,entry_date);
create index if not exists academy_salary_entries_payment_date_idx
  on academy_app.salary_entries(entry_date,entry_type)
  where entry_status<>'취소' and entry_type in ('지급','지급차감보정');
create index if not exists academy_payments_pay_date_active_idx
  on academy_app.payments(pay_date,student_id)
  where record_status='ACTIVE';

truncate table academy_app.operational_settings;
insert into academy_app.operational_settings(
  setting_key,category,setting_label,value_text,value_type,min_value,max_value,
  description,source_run_id,synced_at
)
select btrim(record_json->>'설정키'),nullif(btrim(record_json->>'구분'),''),
  nullif(btrim(record_json->>'설정명'),''),coalesce(record_json->>'현재값',''),
  nullif(btrim(record_json->>'자료형'),''),nullif(btrim(record_json->>'최소값'),''),
  nullif(btrim(record_json->>'최대값'),''),nullif(btrim(record_json->>'설명'),''),run_id,now()
from academy_mirror.latest_sheet_rows
where sheet_name='DB_설정' and source_row_number>1
  and nullif(btrim(record_json->>'설정키'),'') is not null;

truncate table academy_app.monthly_student_facts;
insert into academy_app.monthly_student_facts(
  snapshot_id,snapshot_month,student_id,in_month,first_date,exit_date,
  active_days,billing_days,vacation_days,teacher_id,teacher_name,status,course_mode,
  base_fee,sibling_discount,billable_fee,fact_json,source_version,
  source_generated_at,source_run_id,synced_at
)
select
  btrim(r.record_json->>'스냅샷ID'),
  date_trunc('month',(r.record_json->>'조회월')::timestamptz at time zone 'Asia/Seoul')::date,
  btrim(r.record_json->>'학생ID'),
  coalesce((f.fact->>'inMonth')::boolean,false),
  case when nullif(f.fact->>'firstDate','') is null or (f.fact->>'firstDate')::bigint<=0 then null
    else (to_timestamp((f.fact->>'firstDate')::double precision/1000) at time zone 'Asia/Seoul')::date end,
  case when nullif(f.fact->>'exitDate','') is null or (f.fact->>'exitDate')::bigint<=0 then null
    else (to_timestamp((f.fact->>'exitDate')::double precision/1000) at time zone 'Asia/Seoul')::date end,
  greatest(0,least(31,coalesce((f.fact->>'activeDays')::integer,0))),
  case when extract(month from ((r.record_json->>'조회월')::timestamptz at time zone 'Asia/Seoul'))=2
    then coalesce((select nullif(regexp_replace(value_text,'[^0-9]','','g'),'')::integer
                   from academy_app.operational_settings where setting_key='FEBRUARY_BILLING_DAYS'),30)
    else extract(day from (date_trunc('month',(r.record_json->>'조회월')::timestamptz at time zone 'Asia/Seoul')
      + interval '1 month - 1 day'))::integer end,
  greatest(0,least(31,coalesce((f.fact->>'vacationDays')::integer,0))),
  nullif(btrim(f.fact->'state'->>'teacherId'),''),nullif(btrim(f.fact->'state'->>'teacher'),''),
  nullif(btrim(f.fact->'state'->>'status'),''),nullif(btrim(f.fact->'state'->>'courseMode'),''),
  coalesce((f.fact->>'baseFee')::numeric,0),coalesce((f.fact->>'siblingDiscount')::numeric,0),
  coalesce((f.fact->>'billableFee')::numeric,0),f.fact,
  nullif(btrim(r.record_json->>'원본버전'),''),
  case when nullif(btrim(r.record_json->>'생성일시'),'') is null then null
    else (r.record_json->>'생성일시')::timestamptz end,
  r.run_id,now()
from academy_mirror.latest_sheet_rows r
cross join lateral (select (r.record_json->>'계산결과JSON')::jsonb fact) f
join academy_app.students s on s.student_id=btrim(r.record_json->>'학생ID')
where r.sheet_name='_CACHE_월별스냅샷' and r.source_row_number>1
  and nullif(btrim(r.record_json->>'스냅샷ID'),'') is not null;

truncate table academy_app.salary_entries,academy_app.salary_settlements;
insert into academy_app.salary_settlements(
  settlement_id,settlement_month,teacher_id,teacher_name,settlement_status,
  base_amount,adjustment_amount,final_amount,paid_amount,balance_amount,
  source_type,memo,created_at,updated_at,confirmed_at,confirmed_by,source_run_id,synced_at
)
select btrim(record_json->>'정산ID'),
  date_trunc('month',(record_json->>'정산월')::timestamptz at time zone 'Asia/Seoul')::date,
  nullif(btrim(record_json->>'원장ID'),''),coalesce(nullif(btrim(record_json->>'원장명'),''),'미지정'),
  coalesce(nullif(btrim(record_json->>'상태'),''),'미지정'),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'계산금액',''),'[^0-9.-]','','g'),'')::numeric,0),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'조정금액',''),'[^0-9.-]','','g'),'')::numeric,0),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'확정금액',''),'[^0-9.-]','','g'),'')::numeric,0),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'지급액',''),'[^0-9.-]','','g'),'')::numeric,0),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'잔액',''),'[^0-9.-]','','g'),'')::numeric,0),
  nullif(btrim(record_json->>'자료구분'),''),nullif(btrim(record_json->>'메모'),''),
  case when nullif(btrim(record_json->>'생성일시'),'') is null then null else (record_json->>'생성일시')::timestamptz end,
  case when nullif(btrim(record_json->>'수정일시'),'') is null then null else (record_json->>'수정일시')::timestamptz end,
  case when nullif(btrim(record_json->>'확정일시'),'') is null then null else (record_json->>'확정일시')::timestamptz end,
  nullif(btrim(record_json->>'확정자'),''),run_id,now()
from academy_mirror.latest_sheet_rows
where sheet_name='DB_급여정산' and source_row_number>1
  and nullif(btrim(record_json->>'정산ID'),'') is not null;

insert into academy_app.salary_entries(
  entry_id,settlement_id,entry_type,amount,entry_date,memo,created_at,created_by,
  entry_status,reference_id,details_json,source_run_id,synced_at
)
select btrim(record_json->>'내역ID'),btrim(record_json->>'정산ID'),
  coalesce(nullif(btrim(record_json->>'내역유형'),''),'미지정'),
  coalesce(nullif(regexp_replace(coalesce(record_json->>'금액',''),'[^0-9.-]','','g'),'')::numeric,0),
  case when nullif(btrim(record_json->>'처리일'),'') is null then null
    else ((record_json->>'처리일')::timestamptz at time zone 'Asia/Seoul')::date end,
  nullif(btrim(record_json->>'메모'),''),
  case when nullif(btrim(record_json->>'생성일시'),'') is null then null else (record_json->>'생성일시')::timestamptz end,
  nullif(btrim(record_json->>'처리자'),''),coalesce(nullif(btrim(record_json->>'상태'),''),'미지정'),
  nullif(btrim(record_json->>'참조ID'),''),
  case when nullif(btrim(record_json->>'상세JSON'),'') is null then null
       else jsonb_build_object('raw',record_json->>'상세JSON') end,
  run_id,now()
from academy_mirror.latest_sheet_rows
where sheet_name='DB_급여내역' and source_row_number>1
  and nullif(btrim(record_json->>'내역ID'),'') is not null
  and exists(select 1 from academy_app.salary_settlements s
             where s.settlement_id=btrim(record_json->>'정산ID'));

alter table academy_app.operational_settings enable row level security;
alter table academy_app.operational_settings force row level security;
alter table academy_app.monthly_student_facts enable row level security;
alter table academy_app.monthly_student_facts force row level security;
alter table academy_app.salary_settlements enable row level security;
alter table academy_app.salary_settlements force row level security;
alter table academy_app.salary_entries enable row level security;
alter table academy_app.salary_entries force row level security;
revoke all on table academy_app.operational_settings from public,anon,authenticated;
revoke all on table academy_app.monthly_student_facts from public,anon,authenticated;
revoke all on table academy_app.salary_settlements from public,anon,authenticated;
revoke all on table academy_app.salary_entries from public,anon,authenticated;

create policy academy_operational_settings_admin_read on academy_app.operational_settings
for select to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
create policy academy_monthly_student_facts_admin_read on academy_app.monthly_student_facts
for select to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
create policy academy_salary_settlements_admin_read on academy_app.salary_settlements
for select to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
create policy academy_salary_entries_admin_read on academy_app.salary_entries
for select to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));

grant select on table academy_app.operational_settings to authenticated;
grant select on table academy_app.monthly_student_facts to authenticated;
grant select on table academy_app.salary_settlements to authenticated;
grant select on table academy_app.salary_entries to authenticated;

create or replace function academy_app.statistics_student_values(
  p_start_month date,p_end_month date
)
returns table(
  snapshot_month date,student_id text,student_name text,grade_label text,
  teacher_name text,in_month boolean,first_date date,exit_date date,
  vacation_days integer,expected numeric,received numeric,payment_status text,
  outstanding numeric,overpaid numeric
)
language sql stable security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
with tolerance as (
  select coalesce((select nullif(regexp_replace(value_text,'[^0-9.-]','','g'),'')::numeric
    from academy_app.operational_settings where setting_key='PAYMENT_TOLERANCE_WON'),1000) amount
), base as (
  select f.*,s.student_name,s.grade_label,
    structured.active_days structured_active_days,structured.billing_days structured_billing_days,
    legacy.active_days legacy_active_days,legacy.billing_days legacy_billing_days
  from academy_app.monthly_student_facts f
  join academy_app.students s on s.student_id=f.student_id
  left join lateral (
    select nullif(regexp_replace(p.active_days,'[^0-9]','','g'),'')::integer active_days,
           nullif(regexp_replace(p.billing_days,'[^0-9]','','g'),'')::integer billing_days
    from academy_app.payments p
    where p.student_id=f.student_id and p.payment_month=to_char(f.snapshot_month,'YYYY-MM')
      and p.record_status='ACTIVE' and p.item_type='수강료' and p.amount>0
      and p.calculation_type='PRORATED'
      and nullif(regexp_replace(coalesce(p.active_days,''),'[^0-9]','','g'),'') is not null
      and nullif(regexp_replace(coalesce(p.billing_days,''),'[^0-9]','','g'),'') is not null
    order by p.created_at desc,p.payment_id desc limit 1
  ) structured on true
  left join lateral (
    select (m.parts)[1]::integer active_days,(m.parts)[2]::integer billing_days
    from academy_app.payments p
    cross join lateral (select regexp_match(coalesce(p.memo,''),E'\\(([0-9]+)일/([0-9]+)일') parts) m
    where p.student_id=f.student_id and p.payment_month=to_char(f.snapshot_month,'YYYY-MM')
      and p.record_status='ACTIVE' and p.item_type='수강료' and p.amount>0 and m.parts is not null
    order by p.created_at desc,p.payment_id desc limit 1
  ) legacy on structured.active_days is null
  where f.snapshot_month between p_start_month and p_end_month
), calculated as (
  select b.*,
    case when not b.in_month or b.active_days<=0 then 0::numeric
      when b.structured_active_days is not null and b.structured_billing_days>0
        then round(b.billable_fee*b.structured_active_days/b.structured_billing_days)
      when b.legacy_active_days is not null and b.legacy_billing_days>0
        then round(b.billable_fee*b.legacy_active_days/b.legacy_billing_days)
      when b.active_days<b.billing_days then round(b.billable_fee*b.active_days/b.billing_days)
      else b.billable_fee end expected_amount
  from base b
), received as (
  select p.student_id,to_date(p.payment_month||'-01','YYYY-MM-DD') snapshot_month,
    coalesce(sum(p.amount),0) received_amount
  from academy_app.payments p
  where p.record_status='ACTIVE' and p.item_type='수강료' and p.amount>0
    and to_date(p.payment_month||'-01','YYYY-MM-DD') between p_start_month and p_end_month
  group by p.student_id,p.payment_month
)
select c.snapshot_month,c.student_id,c.student_name,c.grade_label,
  coalesce(nullif(c.teacher_name,''),'미지정'),c.in_month,c.first_date,c.exit_date,c.vacation_days,
  c.expected_amount,coalesce(r.received_amount,0),
  case when not c.in_month then '제외'
       when c.expected_amount<=0 then '면제'
       when coalesce(r.received_amount,0)>=c.expected_amount-(select amount from tolerance) then '완납'
       when coalesce(r.received_amount,0)>0 then '부분납' else '미납' end,
  case when c.in_month and c.expected_amount>0
         and coalesce(r.received_amount,0)<c.expected_amount-(select amount from tolerance)
       then greatest(0,c.expected_amount-coalesce(r.received_amount,0)) else 0 end,
  greatest(0,coalesce(r.received_amount,0)-c.expected_amount)
from calculated c left join received r using(student_id,snapshot_month)
$$;

grant execute on function academy_app.statistics_student_values(date,date) to authenticated;

create or replace function public.get_period_statistics(
  p_start_month text,p_end_month text,p_revenue_basis text default 'PAY_DATE'
)
returns jsonb
language plpgsql stable security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();
  v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_basis text:=upper(btrim(coalesce(p_revenue_basis,'PAY_DATE')));
  v_start date;v_end date;v_available_start date;v_available_end date;
  v_result jsonb;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  if not exists(select 1 from academy_app.user_access u where u.email=v_email and u.active=true and u.role='SUPER_ADMIN') then
    raise exception using errcode='42501',message='최고 관리자만 기간별 통계를 조회할 수 있습니다.';
  end if;
  if coalesce(p_start_month,'') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or coalesce(p_end_month,'') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode='22023',message='조회 월 형식이 올바르지 않습니다.';
  end if;
  if v_basis not in ('PAY_DATE','ATTRIBUTION') then
    raise exception using errcode='22023',message='통계 집계 기준이 올바르지 않습니다.';
  end if;
  v_start:=to_date(p_start_month||'-01','YYYY-MM-DD');v_end:=to_date(p_end_month||'-01','YYYY-MM-DD');
  if v_start>v_end then raise exception using errcode='22023',message='시작 월은 종료 월보다 늦을 수 없습니다.'; end if;
  if ((extract(year from v_end)::integer-extract(year from v_start)::integer)*12
      +extract(month from v_end)::integer-extract(month from v_start)::integer+1)>36 then
    raise exception using errcode='22023',message='한 번에 조회할 수 있는 기간은 최대 36개월입니다.';
  end if;
  select min(snapshot_month),max(snapshot_month) into v_available_start,v_available_end
  from academy_app.monthly_student_facts;
  if v_start<v_available_start or v_end>v_available_end then
    raise exception using errcode='22023',message='저장된 월별 자료 범위 안에서 조회해주세요.';
  end if;

  with student_values as materialized (
    select * from academy_app.statistics_student_values(v_start,v_end)
  ), basis_payments as materialized (
    select case when v_basis='PAY_DATE' then date_trunc('month',p.pay_date)::date
                else to_date(p.payment_month||'-01','YYYY-MM-DD') end report_month,
      p.*
    from academy_app.payments p
    where p.record_status='ACTIVE' and p.amount>0
      and (case when v_basis='PAY_DATE' then date_trunc('month',p.pay_date)::date
                else to_date(p.payment_month||'-01','YYYY-MM-DD') end) between v_start and v_end
  ), month_students as (
    select snapshot_month,
      count(*) filter(where in_month) active_students,
      count(*) filter(where first_date between snapshot_month and (snapshot_month+interval '1 month - 1 day')::date) new_students,
      count(*) filter(where exit_date between snapshot_month and (snapshot_month+interval '1 month - 1 day')::date) exited_students,
      count(*) filter(where in_month and vacation_days>0) vacation_students,
      coalesce(sum(vacation_days) filter(where in_month),0) vacation_days,
      coalesce(sum(expected) filter(where in_month),0) expected_tuition,
      coalesce(sum(received) filter(where in_month),0) attributed_tuition_received,
      count(*) filter(where in_month and payment_status='완납') full_paid,
      count(*) filter(where in_month and payment_status='부분납') partial_paid,
      count(*) filter(where in_month and payment_status='미납') unpaid,
      count(*) filter(where in_month and payment_status='면제') exempt,
      coalesce(sum(outstanding) filter(where in_month),0) outstanding,
      coalesce(sum(overpaid) filter(where in_month),0) overpaid
    from student_values group by snapshot_month
  ), month_payments as (
    select report_month,
      coalesce(sum(amount) filter(where item_type='수강료'),0) tuition_received,
      coalesce(sum(amount) filter(where item_type<>'수강료'),0) other_revenue,
      coalesce(sum(amount),0) total_received,count(*) payment_count
    from basis_payments group by report_month
  ), salary_final as (
    select settlement_month report_month,coalesce(sum(final_amount),0) final_amount,
      coalesce(sum(balance_amount),0) balance_amount
    from academy_app.salary_settlements
    where settlement_status<>'취소' and settlement_month between v_start and v_end
    group by settlement_month
  ), salary_paid_entries as (
    select date_trunc('month',e.entry_date)::date report_month,coalesce(sum(e.amount),0) paid_amount
    from academy_app.salary_entries e
    where e.entry_status<>'취소' and e.entry_type in ('지급','지급차감보정')
      and date_trunc('month',e.entry_date)::date between v_start and v_end group by 1
  ), salary_fallback as (
    select s.settlement_month report_month,coalesce(sum(s.paid_amount),0) paid_amount
    from academy_app.salary_settlements s
    where s.settlement_status<>'취소' and s.paid_amount<>0 and s.settlement_month between v_start and v_end
      and not exists(select 1 from academy_app.salary_entries e where e.settlement_id=s.settlement_id
        and e.entry_status<>'취소' and e.entry_type in ('지급','지급차감보정'))
    group by s.settlement_month
  ), months as materialized (
    select g::date report_month,coalesce(ms.active_students,0) active_students,
      coalesce(ms.new_students,0) new_students,coalesce(ms.exited_students,0) exited_students,
      coalesce(ms.vacation_students,0) vacation_students,coalesce(ms.vacation_days,0) vacation_days,
      coalesce(ms.expected_tuition,0) expected_tuition,coalesce(mp.tuition_received,0) tuition_received,
      coalesce(ms.attributed_tuition_received,0) attributed_tuition_received,
      coalesce(mp.other_revenue,0) other_revenue,coalesce(mp.total_received,0) total_received,
      coalesce(mp.payment_count,0) payment_count,coalesce(ms.full_paid,0) full_paid,
      coalesce(ms.partial_paid,0) partial_paid,coalesce(ms.unpaid,0) unpaid,coalesce(ms.exempt,0) exempt,
      coalesce(ms.outstanding,0) outstanding,coalesce(ms.overpaid,0) overpaid,
      coalesce(sf.final_amount,0) salary_final_amount,
      coalesce(spe.paid_amount,0)+coalesce(sfb.paid_amount,0) salary_paid_amount,
      coalesce(sf.balance_amount,0) salary_balance_amount
    from generate_series(v_start,v_end,interval '1 month') g
    left join month_students ms on ms.snapshot_month=g::date
    left join month_payments mp on mp.report_month=g::date
    left join salary_final sf on sf.report_month=g::date
    left join salary_paid_entries spe on spe.report_month=g::date
    left join salary_fallback sfb on sfb.report_month=g::date
  ), active_aggregates as (
    select 'TEACHER' kind,teacher_name name,count(*) active_students,sum(expected) expected_tuition
    from student_values where in_month group by teacher_name
    union all
    select 'GRADE',coalesce(nullif(grade_label,''),'미지정'),count(*),sum(expected)
    from student_values where in_month group by coalesce(nullif(grade_label,''),'미지정')
  ), payment_aggregates as (
    select 'TEACHER' kind,coalesce(nullif(v.teacher_name,''),'미지정') name,
      sum(case when p.item_type='수강료' then p.amount else 0 end) tuition_received,
      sum(case when p.item_type<>'수강료' then p.amount else 0 end) other_revenue,
      sum(p.amount) total_received,count(*) payment_count
    from basis_payments p left join student_values v on v.student_id=p.student_id and v.snapshot_month=p.report_month
    group by coalesce(nullif(v.teacher_name,''),'미지정')
    union all
    select 'GRADE',coalesce(nullif(v.grade_label,''),'미지정'),
      sum(case when p.item_type='수강료' then p.amount else 0 end),
      sum(case when p.item_type<>'수강료' then p.amount else 0 end),sum(p.amount),count(*)
    from basis_payments p left join student_values v on v.student_id=p.student_id and v.snapshot_month=p.report_month
    group by coalesce(nullif(v.grade_label,''),'미지정')
  ), dimension_aggregates as (
    select coalesce(a.kind,p.kind) kind,coalesce(a.name,p.name) name,
      coalesce(a.active_students,0) active_students,coalesce(a.expected_tuition,0) expected_tuition,
      coalesce(p.tuition_received,0) tuition_received,coalesce(p.other_revenue,0) other_revenue,
      coalesce(p.total_received,0) total_received,coalesce(p.payment_count,0) payment_count
    from active_aggregates a full join payment_aggregates p on p.kind=a.kind and p.name=a.name
  ), salary_teacher_final as (
    select teacher_name name,sum(final_amount) final_amount,sum(balance_amount) balance_amount
    from academy_app.salary_settlements where settlement_status<>'취소' and settlement_month between v_start and v_end
    group by teacher_name
  ), salary_teacher_paid as (
    select s.teacher_name name,sum(e.amount) paid_amount
    from academy_app.salary_entries e join academy_app.salary_settlements s using(settlement_id)
    where e.entry_status<>'취소' and e.entry_type in ('지급','지급차감보정')
      and date_trunc('month',e.entry_date)::date between v_start and v_end group by s.teacher_name
  ), salary_teacher_fallback as (
    select s.teacher_name name,sum(s.paid_amount) paid_amount
    from academy_app.salary_settlements s
    where s.settlement_status<>'취소' and s.settlement_month between v_start and v_end and s.paid_amount<>0
      and not exists(select 1 from academy_app.salary_entries e where e.settlement_id=s.settlement_id
        and e.entry_status<>'취소' and e.entry_type in ('지급','지급차감보정'))
    group by s.teacher_name
  ), salary_teachers as (
    select coalesce(f.name,p.name,b.name) name,coalesce(f.final_amount,0) final_amount,
      coalesce(p.paid_amount,0)+coalesce(b.paid_amount,0) paid_amount,coalesce(f.balance_amount,0) balance_amount
    from salary_teacher_final f full join salary_teacher_paid p using(name) full join salary_teacher_fallback b using(name)
  ), totals as (
    select count(*) month_count,sum(active_students) active_student_months,
      sum(new_students) new_students,sum(exited_students) exited_students,
      sum(vacation_students) vacation_students,sum(vacation_days) vacation_days,
      sum(expected_tuition) expected_tuition,sum(tuition_received) tuition_received,
      sum(attributed_tuition_received) attributed_tuition_received,sum(other_revenue) other_revenue,
      sum(total_received) total_received,sum(payment_count) payment_count,sum(full_paid) full_paid,
      sum(partial_paid) partial_paid,sum(unpaid) unpaid,sum(exempt) exempt,
      sum(outstanding) outstanding,sum(overpaid) overpaid,sum(salary_final_amount) salary_final_amount,
      sum(salary_paid_amount) salary_paid_amount,sum(salary_balance_amount) salary_balance_amount
    from months
  )
  select jsonb_build_object(
    'period',jsonb_build_object('start',to_char(v_start,'YYYY-MM'),'end',to_char(v_end,'YYYY-MM'),
      'monthCount',(select month_count from totals)),
    'availableRange',jsonb_build_object('start',to_char(v_available_start,'YYYY-MM'),'end',to_char(v_available_end,'YYYY-MM')),
    'basis',jsonb_build_object('revenue',v_basis,'paymentStatus','ATTRIBUTION','source','SUPABASE_STORED_SNAPSHOT'),
    'totals',(select jsonb_build_object(
      'activeStudentMonths',active_student_months,'averageActiveStudents',round(active_student_months::numeric/month_count,1),
      'newStudents',new_students,'exitedStudents',exited_students,'netStudentChange',new_students-exited_students,
      'vacationStudents',vacation_students,'vacationDays',vacation_days,'expectedTuition',expected_tuition,
      'tuitionReceived',tuition_received,'attributedTuitionReceived',attributed_tuition_received,
      'otherRevenue',other_revenue,'totalReceived',total_received,'paymentCount',payment_count,
      'averagePayment',case when payment_count>0 then round(total_received/payment_count) else 0 end,
      'collectionRate',case when expected_tuition>0 then round(tuition_received*1000/expected_tuition)/10 else 0 end,
      'statusCollectionRate',case when expected_tuition>0 then round(attributed_tuition_received*1000/expected_tuition)/10 else 0 end,
      'fullPaid',full_paid,'partialPaid',partial_paid,'unpaid',unpaid,'exempt',exempt,
      'outstanding',outstanding,'overpaid',overpaid,'salaryFinalAmount',salary_final_amount,
      'salaryPaidAmount',salary_paid_amount,'salaryBalanceAmount',salary_balance_amount,
      'afterSalaryAmount',total_received-salary_paid_amount,
      'salaryPaidRate',case when total_received>0 then round(salary_paid_amount*1000/total_received)/10 else 0 end
    ) from totals),
    'months',(select coalesce(jsonb_agg(jsonb_build_object(
      'month',to_char(report_month,'YYYY-MM'),'activeStudents',active_students,'newStudents',new_students,
      'exitedStudents',exited_students,'netStudentChange',new_students-exited_students,
      'vacationStudents',vacation_students,'vacationDays',vacation_days,'expectedTuition',expected_tuition,
      'tuitionReceived',tuition_received,'attributedTuitionReceived',attributed_tuition_received,
      'otherRevenue',other_revenue,'totalReceived',total_received,'paymentCount',payment_count,
      'averagePayment',case when payment_count>0 then round(total_received/payment_count) else 0 end,
      'collectionRate',case when expected_tuition>0 then round(tuition_received*1000/expected_tuition)/10 else 0 end,
      'statusCollectionRate',case when expected_tuition>0 then round(attributed_tuition_received*1000/expected_tuition)/10 else 0 end,
      'fullPaid',full_paid,'partialPaid',partial_paid,'unpaid',unpaid,'exempt',exempt,
      'outstanding',outstanding,'overpaid',overpaid,'salaryFinalAmount',salary_final_amount,
      'salaryPaidAmount',salary_paid_amount,'salaryBalanceAmount',salary_balance_amount,
      'afterSalaryAmount',total_received-salary_paid_amount
    ) order by report_month),'[]'::jsonb) from months),
    'teachers',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'activeStudents',active_students,
      'expectedTuition',expected_tuition,'tuitionReceived',tuition_received,'otherRevenue',other_revenue,
      'totalReceived',total_received,'paymentCount',payment_count) order by total_received desc,name),'[]'::jsonb)
      from dimension_aggregates where kind='TEACHER'),
    'grades',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'activeStudents',active_students,
      'expectedTuition',expected_tuition,'tuitionReceived',tuition_received,'otherRevenue',other_revenue,
      'totalReceived',total_received,'paymentCount',payment_count) order by total_received desc,name),'[]'::jsonb)
      from dimension_aggregates where kind='GRADE'),
    'methods',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'paymentCount',payment_count,
      'totalReceived',total_received) order by total_received desc,name),'[]'::jsonb) from(
        select coalesce(nullif(payment_method,''),'미지정') name,count(*) payment_count,sum(amount) total_received
        from basis_payments group by coalesce(nullif(payment_method,''),'미지정'))q),
    'types',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'paymentCount',payment_count,
      'totalReceived',total_received) order by total_received desc,name),'[]'::jsonb) from(
        select coalesce(nullif(item_type,''),'수강료') name,count(*) payment_count,sum(amount) total_received
        from basis_payments group by coalesce(nullif(item_type,''),'수강료'))q),
    'salaries',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'finalAmount',final_amount,
      'paidAmount',paid_amount,'balanceAmount',balance_amount) order by paid_amount desc,final_amount desc,name),'[]'::jsonb)
      from salary_teachers),
    'receivables',(select coalesce(jsonb_agg(jsonb_build_object('month',to_char(snapshot_month,'YYYY-MM'),
      'studentId',student_id,'name',student_name,'grade',grade_label,'teacher',teacher_name,
      'status',payment_status,'expected',expected,'received',received,'outstanding',outstanding)
      order by snapshot_month desc,outstanding desc,student_name),'[]'::jsonb)
      from student_values where in_month and payment_status in ('미납','부분납')),
    'receivableSummary',(select jsonb_build_object('studentMonths',count(*),'uniqueStudents',count(distinct student_id),
      'uniqueUnpaidStudents',count(distinct student_id) filter(where payment_status='미납'))
      from student_values where in_month and payment_status in ('미납','부분납'))
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.get_statistics_overview()
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s'
as $$
declare v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_start date;v_end date;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  if not exists(select 1 from academy_app.user_access u where u.email=v_email and u.active=true and u.role='SUPER_ADMIN') then
    raise exception using errcode='42501',message='최고 관리자만 기간별 통계를 조회할 수 있습니다.';
  end if;
  select min(snapshot_month),max(snapshot_month) into v_start,v_end from academy_app.monthly_student_facts;
  return jsonb_build_object('availableStart',to_char(v_start,'YYYY-MM'),'availableEnd',to_char(v_end,'YYYY-MM'),
    'defaultStart',to_char(greatest(v_start,(v_end-interval '11 months')::date),'YYYY-MM'),
    'defaultEnd',to_char(v_end,'YYYY-MM'),'studentFacts',(select count(*) from academy_app.monthly_student_facts),
    'salarySettlements',(select count(*) from academy_app.salary_settlements),
    'salaryEntries',(select count(*) from academy_app.salary_entries));
end;
$$;

revoke all on function academy_app.statistics_student_values(date,date) from public,anon;
revoke all on function public.get_period_statistics(text,text,text) from public,anon;
revoke all on function public.get_statistics_overview() from public,anon;
grant execute on function public.get_period_statistics(text,text,text) to authenticated;
grant execute on function public.get_statistics_overview() to authenticated;

comment on table academy_app.monthly_student_facts is 'Typed copy of Google monthly snapshot facts used to preserve historical billing calculations.';
comment on function public.get_period_statistics(text,text,text) is 'Super-admin period statistics using stored student-month facts and live typed ledgers.';
