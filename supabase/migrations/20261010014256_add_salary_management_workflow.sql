-- Transactional salary settlement management. Existing Google records remain
-- intact and all new Supabase mutations are versioned and audited.

alter table academy_app.salary_settlements
  alter column source_run_id drop not null,
  add column if not exists source_system text not null default 'GOOGLE_SNAPSHOT',
  add column if not exists version integer not null default 1,
  add column if not exists last_request_id uuid;

alter table academy_app.salary_entries
  alter column source_run_id drop not null,
  add column if not exists source_system text not null default 'GOOGLE_SNAPSHOT';

alter table academy_app.salary_settlements
  drop constraint if exists salary_settlements_source_system_check,
  add constraint salary_settlements_source_system_check
    check (source_system in ('GOOGLE_SNAPSHOT','SUPABASE')),
  drop constraint if exists salary_settlements_version_check,
  add constraint salary_settlements_version_check check (version>0);

alter table academy_app.salary_entries
  drop constraint if exists salary_entries_source_system_check,
  add constraint salary_entries_source_system_check
    check (source_system in ('GOOGLE_SNAPSHOT','SUPABASE'));

create unique index if not exists academy_salary_settlements_active_teacher_month_uidx
  on academy_app.salary_settlements(settlement_month,teacher_id)
  where settlement_status<>'취소' and teacher_id is not null;

create table if not exists academy_app.salary_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  settlement_id text not null references academy_app.salary_settlements(settlement_id),
  action text not null check (action in (
    'PAYMENT_ADD','PAYMENT_SUB','FINAL_ADD','FINAL_SUB',
    'MONTH_PAYMENT','HISTORICAL_CREATE','CANCEL'
  )),
  before_data jsonb,
  after_data jsonb,
  memo text,
  actor_email text not null,
  request_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists academy_app.salary_operation_requests (
  request_id uuid primary key,
  operation text not null,
  request_hash text not null,
  result_json jsonb not null,
  actor_email text not null,
  created_at timestamptz not null default now()
);

create index if not exists academy_salary_revisions_settlement_created_idx
  on academy_app.salary_revisions(settlement_id,created_at desc);
create index if not exists academy_salary_revisions_created_idx
  on academy_app.salary_revisions(created_at desc);

alter table academy_app.salary_revisions enable row level security;
alter table academy_app.salary_revisions force row level security;
alter table academy_app.salary_operation_requests enable row level security;
alter table academy_app.salary_operation_requests force row level security;

drop policy if exists academy_salary_settlements_admin_insert on academy_app.salary_settlements;
create policy academy_salary_settlements_admin_insert on academy_app.salary_settlements
for insert to authenticated with check (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
drop policy if exists academy_salary_settlements_admin_update on academy_app.salary_settlements;
create policy academy_salary_settlements_admin_update on academy_app.salary_settlements
for update to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'))
with check (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));

drop policy if exists academy_salary_entries_admin_insert on academy_app.salary_entries;
create policy academy_salary_entries_admin_insert on academy_app.salary_entries
for insert to authenticated with check (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
drop policy if exists academy_salary_entries_admin_update on academy_app.salary_entries;
create policy academy_salary_entries_admin_update on academy_app.salary_entries
for update to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'))
with check (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));

create policy academy_salary_revisions_admin_read on academy_app.salary_revisions
for select to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
create policy academy_salary_revisions_admin_insert on academy_app.salary_revisions
for insert to authenticated with check (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
create policy academy_salary_operation_requests_admin_read on academy_app.salary_operation_requests
for select to authenticated using (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));
create policy academy_salary_operation_requests_admin_insert on academy_app.salary_operation_requests
for insert to authenticated with check (exists(select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'));

revoke all on table academy_app.salary_revisions from public,anon,authenticated;
revoke all on table academy_app.salary_operation_requests from public,anon,authenticated;
grant select,insert,update on academy_app.salary_settlements to authenticated;
grant select,insert,update on academy_app.salary_entries to authenticated;
grant select,insert on academy_app.salary_revisions to authenticated;
grant select,insert on academy_app.salary_operation_requests to authenticated;

create or replace function academy_app.salary_status(p_final numeric,p_paid numeric)
returns text language sql immutable security invoker set search_path=pg_catalog as $$
  select case when p_paid=p_final then '지급완료'
    when p_paid=0 then '미지급'
    when p_paid<p_final then '일부지급' else '초과지급' end
$$;

create or replace function academy_app.salary_admin_email()
returns text language plpgsql stable security invoker
set search_path=pg_catalog as $$
declare v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
begin
  if auth.uid() is null or v_email='' then
    raise exception using errcode='42501',message='로그인이 필요합니다.';
  end if;
  if not exists(select 1 from academy_app.user_access u
    where u.email=v_email and u.active=true and u.role='SUPER_ADMIN') then
    raise exception using errcode='42501',message='최고 관리자만 급여 관리를 사용할 수 있습니다.';
  end if;
  return v_email;
end;
$$;

create or replace function public.get_salary_management_workspace(
  p_month text default null,p_status text default null
)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_email text:=academy_app.salary_admin_email();v_month date;v_result jsonb;
begin
  if nullif(btrim(coalesce(p_month,'')),'') is not null then
    if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception using errcode='22023',message='정산 월 형식이 올바르지 않습니다.';
    end if;
    v_month:=to_date(p_month||'-01','YYYY-MM-DD');
  end if;
  if nullif(btrim(coalesce(p_status,'')),'') is not null
     and p_status not in ('지급완료','미지급','일부지급','초과지급','취소') then
    raise exception using errcode='22023',message='급여 상태 필터가 올바르지 않습니다.';
  end if;
  with filtered as materialized (
    select * from academy_app.salary_settlements s
    where (v_month is null or s.settlement_month=v_month)
      and (nullif(btrim(coalesce(p_status,'')),'') is null or s.settlement_status=p_status)
  ), diagnostics as (
    select count(*) filter(where base_amount+adjustment_amount<>final_amount) amount_mismatch,
      count(*) filter(where final_amount-paid_amount<>balance_amount) balance_mismatch,
      count(*) filter(where version<1) version_error from academy_app.salary_settlements
  )
  select jsonb_build_object(
    'records',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',settlement_id,'month',to_char(settlement_month,'YYYY-MM'),'teacherId',teacher_id,
      'teacherName',teacher_name,'status',settlement_status,'baseAmount',base_amount,
      'adjustmentAmount',adjustment_amount,'finalAmount',final_amount,'paidAmount',paid_amount,
      'balanceAmount',balance_amount,'sourceType',source_type,'memo',memo,
      'confirmedAt',to_char(confirmed_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'confirmedBy',confirmed_by,'sourceSystem',source_system,'version',version,
      'canCancel',(settlement_status<>'취소' and paid_amount=0)
    ) order by settlement_month desc,teacher_name),'[]'::jsonb) from filtered),
    'summary',(select jsonb_build_object('count',count(*),'paidCount',count(*) filter(where settlement_status='지급완료'),
      'activeCount',count(*) filter(where settlement_status<>'취소'),
      'finalTotal',coalesce(sum(final_amount) filter(where settlement_status<>'취소'),0),
      'paidTotal',coalesce(sum(paid_amount) filter(where settlement_status<>'취소'),0),
      'balanceTotal',coalesce(sum(balance_amount) filter(where settlement_status<>'취소'),0)) from filtered),
    'teachers',(select coalesce(jsonb_agg(jsonb_build_object('id',teacher_id,'name',teacher_name,
      'active',active,'salaryTarget',salary_target,'defaultRate',default_distribution_rate)
      order by active desc,teacher_name),'[]'::jsonb) from academy_app.teachers where salary_target=true),
    'months',(select coalesce(jsonb_agg(month_label order by month_label desc),'[]'::jsonb) from(
      select distinct to_char(settlement_month,'YYYY-MM') month_label from academy_app.salary_settlements)q),
    'recentRevisions',(select coalesce(jsonb_agg(jsonb_build_object('settlementId',r.settlement_id,
      'teacherName',s.teacher_name,'action',r.action,'memo',r.memo,'actorEmail',r.actor_email,
      'createdAt',to_char(r.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'))
      order by r.created_at desc),'[]'::jsonb) from(
        select * from academy_app.salary_revisions order by created_at desc limit 30
      )r join academy_app.salary_settlements s using(settlement_id)),
    'diagnostics',(select jsonb_build_object('healthy',(amount_mismatch+balance_mismatch+version_error)=0,
      'amountMismatch',amount_mismatch,'balanceMismatch',balance_mismatch,'versionError',version_error) from diagnostics)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.get_salary_settlement_ledger(p_settlement_id text)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_email text:=academy_app.salary_admin_email();v_result jsonb;
begin
  if nullif(btrim(coalesce(p_settlement_id,'')),'') is null then
    raise exception using errcode='22023',message='정산 기록을 선택해주세요.';
  end if;
  select jsonb_build_object('id',s.settlement_id,'month',to_char(s.settlement_month,'YYYY-MM'),
    'teacherName',s.teacher_name,'status',s.settlement_status,'baseAmount',s.base_amount,
    'adjustmentAmount',s.adjustment_amount,'finalAmount',s.final_amount,'paidAmount',s.paid_amount,
    'balanceAmount',s.balance_amount,'memo',s.memo,'version',s.version,
    'calculationCount',(select count(*) from academy_app.salary_entries e
      where e.settlement_id=s.settlement_id and e.entry_type='계산근거'),
    'transactions',(select coalesce(jsonb_agg(jsonb_build_object('id',e.entry_id,'type',e.entry_type,
      'amount',e.amount,'entryDate',to_char(e.entry_date,'YYYY-MM-DD'),'memo',e.memo,
      'status',e.entry_status,'createdBy',e.created_by,'sourceSystem',e.source_system)
      order by e.entry_date,e.created_at,e.entry_id),'[]'::jsonb)
      from academy_app.salary_entries e where e.settlement_id=s.settlement_id
        and e.entry_type not in ('계산근거','정산요약')),
    'revisions',(select coalesce(jsonb_agg(jsonb_build_object('action',r.action,'before',r.before_data,
      'after',r.after_data,'memo',r.memo,'actorEmail',r.actor_email,
      'createdAt',to_char(r.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'))
      order by r.created_at),'[]'::jsonb) from academy_app.salary_revisions r
      where r.settlement_id=s.settlement_id)
  ) into v_result from academy_app.salary_settlements s where s.settlement_id=p_settlement_id;
  if v_result is null then raise exception using errcode='P0002',message='정산 기록을 찾을 수 없습니다.'; end if;
  return v_result;
end;
$$;

create or replace function public.update_salary_settlement(
  p_settlement_id text,p_action text,p_amount numeric,p_entry_date date,p_memo text,
  p_expected_version integer,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_email text:=academy_app.salary_admin_email();v_row academy_app.salary_settlements%rowtype;
  v_existing academy_app.salary_operation_requests%rowtype;v_hash text;v_signed numeric;v_type text;
  v_final numeric;v_paid numeric;v_result jsonb;v_before jsonb;v_after jsonb;
begin
  if p_request_id is null then raise exception using errcode='22023',message='중복 방지 요청 ID가 필요합니다.'; end if;
  v_hash:=md5(concat_ws('|',p_settlement_id,p_action,p_amount,p_entry_date,coalesce(p_memo,''),p_expected_version));
  select * into v_existing from academy_app.salary_operation_requests where request_id=p_request_id;
  if found then
    if v_existing.request_hash<>v_hash then raise exception using errcode='22023',message='같은 요청 ID에 다른 입력값을 사용할 수 없습니다.'; end if;
    return v_existing.result_json;
  end if;
  if p_action not in ('PAYMENT_ADD','PAYMENT_SUB','FINAL_ADD','FINAL_SUB') then
    raise exception using errcode='22023',message='허용되지 않은 급여 처리 유형입니다.';
  end if;
  if p_amount is null or p_amount<=0 or p_amount>100000000 then
    raise exception using errcode='22023',message='처리 금액은 1원 이상 1억원 이하로 입력해주세요.';
  end if;
  if p_entry_date is null then raise exception using errcode='22023',message='처리일을 입력해주세요.'; end if;
  if length(coalesce(p_memo,''))>500 then raise exception using errcode='22023',message='메모는 500자 이하로 입력해주세요.'; end if;
  if p_action<>'PAYMENT_ADD' and nullif(btrim(coalesce(p_memo,'')),'') is null then
    raise exception using errcode='22023',message='보정 사유를 입력해주세요.';
  end if;
  select * into v_row from academy_app.salary_settlements where settlement_id=p_settlement_id for update;
  if not found then raise exception using errcode='P0002',message='정산 기록을 찾을 수 없습니다.'; end if;
  if v_row.settlement_status='취소' then raise exception using errcode='22023',message='취소된 정산은 변경할 수 없습니다.'; end if;
  if v_row.version<>p_expected_version then raise exception using errcode='40001',message='다른 화면에서 급여 기록이 변경되었습니다. 새로고침 후 다시 시도해주세요.'; end if;
  v_final:=v_row.final_amount;v_paid:=v_row.paid_amount;v_signed:=p_amount;
  if p_action='PAYMENT_ADD' then v_paid:=v_paid+p_amount;v_type:='지급'; end if;
  if p_action='PAYMENT_SUB' then
    if p_amount>v_paid then raise exception using errcode='22023',message='차감액이 현재 지급액보다 큽니다.'; end if;
    v_paid:=v_paid-p_amount;v_signed:=-p_amount;v_type:='지급차감보정';
  end if;
  if p_action='FINAL_ADD' then v_final:=v_final+p_amount;v_type:='확정액추가보정'; end if;
  if p_action='FINAL_SUB' then
    if p_amount>v_final then raise exception using errcode='22023',message='공제액이 현재 확정액보다 큽니다.'; end if;
    v_final:=v_final-p_amount;v_signed:=-p_amount;v_type:='확정액공제보정';
  end if;
  v_before:=jsonb_build_object('status',v_row.settlement_status,'finalAmount',v_row.final_amount,
    'paidAmount',v_row.paid_amount,'balanceAmount',v_row.balance_amount,'version',v_row.version);
  update academy_app.salary_settlements set final_amount=v_final,
    adjustment_amount=v_final-base_amount,paid_amount=v_paid,balance_amount=v_final-v_paid,
    settlement_status=academy_app.salary_status(v_final,v_paid),updated_at=now(),
    source_system='SUPABASE',version=version+1,last_request_id=p_request_id
  where settlement_id=p_settlement_id returning * into v_row;
  v_after:=jsonb_build_object('status',v_row.settlement_status,'finalAmount',v_row.final_amount,
    'paidAmount',v_row.paid_amount,'balanceAmount',v_row.balance_amount,'version',v_row.version);
  insert into academy_app.salary_entries(entry_id,settlement_id,entry_type,amount,entry_date,memo,
    created_at,created_by,entry_status,reference_id,details_json,source_system)
  values('SLE-'||gen_random_uuid()::text,p_settlement_id,v_type,v_signed,p_entry_date,
    coalesce(nullif(btrim(p_memo),''),'급여 지급'),now(),v_email,'완료','',
    jsonb_build_object('action',p_action,'before',v_before,'after',v_after,'requestId',p_request_id),'SUPABASE');
  insert into academy_app.salary_revisions(settlement_id,action,before_data,after_data,memo,actor_email,request_id)
  values(p_settlement_id,p_action,v_before,v_after,nullif(btrim(p_memo),''),v_email,p_request_id);
  v_result:=jsonb_build_object('settlementId',p_settlement_id,'status',v_row.settlement_status,
    'finalAmount',v_row.final_amount,'paidAmount',v_row.paid_amount,
    'balanceAmount',v_row.balance_amount,'version',v_row.version,'replayed',false);
  insert into academy_app.salary_operation_requests values(p_request_id,'UPDATE',v_hash,v_result,v_email,now());
  return v_result;
end;
$$;

create or replace function public.pay_salary_month(
  p_month text,p_entry_date date,p_memo text,p_expected_count integer,
  p_expected_total numeric,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_email text:=academy_app.salary_admin_email();v_month date;v_count integer;v_total numeric;
  v_row academy_app.salary_settlements%rowtype;v_before jsonb;v_after jsonb;v_items jsonb:='[]'::jsonb;
  v_result jsonb;v_hash text;v_existing academy_app.salary_operation_requests%rowtype;v_memo text;
begin
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception using errcode='22023',message='지급 대상 월을 선택해주세요.'; end if;
  if p_entry_date is null then raise exception using errcode='22023',message='지급일을 선택해주세요.'; end if;
  if p_request_id is null then raise exception using errcode='22023',message='중복 방지 요청 ID가 필요합니다.'; end if;
  if length(coalesce(p_memo,''))>500 then raise exception using errcode='22023',message='메모는 500자 이하로 입력해주세요.'; end if;
  v_hash:=md5(concat_ws('|',p_month,p_entry_date,coalesce(p_memo,''),p_expected_count,p_expected_total));
  select * into v_existing from academy_app.salary_operation_requests where request_id=p_request_id;
  if found then
    if v_existing.request_hash<>v_hash then raise exception using errcode='22023',message='같은 요청 ID에 다른 입력값을 사용할 수 없습니다.'; end if;
    return v_existing.result_json;
  end if;
  v_month:=to_date(p_month||'-01','YYYY-MM-DD');v_memo:=coalesce(nullif(btrim(p_memo),''),p_month||' 급여 일괄 지급');
  perform 1 from academy_app.salary_settlements where settlement_month=v_month
    and settlement_status<>'취소' and balance_amount>0 for update;
  select count(*),coalesce(sum(balance_amount),0) into v_count,v_total
  from academy_app.salary_settlements where settlement_month=v_month
    and settlement_status<>'취소' and balance_amount>0;
  if v_count=0 then raise exception using errcode='22023',message='해당 월에 지급할 미지급 잔액이 없습니다.'; end if;
  if v_count>30 or v_count<>p_expected_count or v_total<>p_expected_total then
    raise exception using errcode='40001',message='확인 후 지급 대상 또는 금액이 변경되었습니다. 새로고침 후 다시 시도해주세요.';
  end if;
  for v_row in select * from academy_app.salary_settlements where settlement_month=v_month
    and settlement_status<>'취소' and balance_amount>0 order by teacher_name for update
  loop
    v_before:=jsonb_build_object('status',v_row.settlement_status,'finalAmount',v_row.final_amount,
      'paidAmount',v_row.paid_amount,'balanceAmount',v_row.balance_amount,'version',v_row.version);
    update academy_app.salary_settlements set paid_amount=final_amount,balance_amount=0,
      settlement_status='지급완료',updated_at=now(),source_system='SUPABASE',
      version=version+1,last_request_id=p_request_id where settlement_id=v_row.settlement_id returning * into v_row;
    v_after:=jsonb_build_object('status',v_row.settlement_status,'finalAmount',v_row.final_amount,
      'paidAmount',v_row.paid_amount,'balanceAmount',v_row.balance_amount,'version',v_row.version);
    insert into academy_app.salary_entries(entry_id,settlement_id,entry_type,amount,entry_date,memo,
      created_at,created_by,entry_status,reference_id,details_json,source_system)
    values('SLE-'||gen_random_uuid()::text,v_row.settlement_id,'지급',(v_before->>'balanceAmount')::numeric,
      p_entry_date,v_memo,now(),v_email,'완료',coalesce(v_row.teacher_id,''),
      jsonb_build_object('action','MONTH_PAYMENT','before',v_before,'after',v_after,'requestId',p_request_id),'SUPABASE');
    insert into academy_app.salary_revisions(settlement_id,action,before_data,after_data,memo,actor_email,request_id)
    values(v_row.settlement_id,'MONTH_PAYMENT',v_before,v_after,v_memo,v_email,p_request_id);
    v_items:=v_items||jsonb_build_array(jsonb_build_object('settlementId',v_row.settlement_id,
      'teacherName',v_row.teacher_name,'amount',(v_before->>'balanceAmount')::numeric,'version',v_row.version));
  end loop;
  v_result:=jsonb_build_object('month',p_month,'entryDate',to_char(p_entry_date,'YYYY-MM-DD'),
    'count',v_count,'totalPaid',v_total,'settlements',v_items,'replayed',false);
  insert into academy_app.salary_operation_requests values(p_request_id,'MONTH_PAYMENT',v_hash,v_result,v_email,now());
  return v_result;
end;
$$;

create or replace function public.create_historical_salary_record(
  p_month text,p_teacher_id text,p_final_amount numeric,p_paid_amount numeric,
  p_paid_date date,p_memo text,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_email text:=academy_app.salary_admin_email();v_month date;v_teacher academy_app.teachers%rowtype;
  v_id text;v_status text;v_result jsonb;v_hash text;v_existing academy_app.salary_operation_requests%rowtype;
begin
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception using errcode='22023',message='정산 월을 선택해주세요.'; end if;
  if p_request_id is null then raise exception using errcode='22023',message='중복 방지 요청 ID가 필요합니다.'; end if;
  if p_final_amount is null or p_final_amount<0 or p_final_amount>100000000
    or p_paid_amount is null or p_paid_amount<0 or p_paid_amount>100000000 then
    raise exception using errcode='22023',message='급여 금액 범위를 확인해주세요.';
  end if;
  if p_paid_amount>0 and p_paid_date is null then raise exception using errcode='22023',message='지급액이 있으면 지급일을 입력해주세요.'; end if;
  if length(coalesce(p_memo,''))>500 then raise exception using errcode='22023',message='메모는 500자 이하로 입력해주세요.'; end if;
  v_hash:=md5(concat_ws('|',p_month,p_teacher_id,p_final_amount,p_paid_amount,p_paid_date,coalesce(p_memo,'')));
  select * into v_existing from academy_app.salary_operation_requests where request_id=p_request_id;
  if found then
    if v_existing.request_hash<>v_hash then raise exception using errcode='22023',message='같은 요청 ID에 다른 입력값을 사용할 수 없습니다.'; end if;
    return v_existing.result_json;
  end if;
  select * into v_teacher from academy_app.teachers where teacher_id=p_teacher_id;
  if not found then raise exception using errcode='22023',message='등록된 원장을 선택해주세요.'; end if;
  v_month:=to_date(p_month||'-01','YYYY-MM-DD');
  if exists(select 1 from academy_app.salary_settlements where settlement_month=v_month
    and teacher_id=p_teacher_id and settlement_status<>'취소') then
    raise exception using errcode='23505',message='해당 월·원장의 정산 기록이 이미 있습니다.';
  end if;
  v_id:='SAL-'||gen_random_uuid()::text;v_status:=academy_app.salary_status(p_final_amount,p_paid_amount);
  insert into academy_app.salary_settlements(settlement_id,settlement_month,teacher_id,teacher_name,
    settlement_status,base_amount,adjustment_amount,final_amount,paid_amount,balance_amount,
    source_type,memo,created_at,updated_at,confirmed_at,confirmed_by,source_system,version,last_request_id)
  values(v_id,v_month,v_teacher.teacher_id,v_teacher.teacher_name,v_status,p_final_amount,0,p_final_amount,
    p_paid_amount,p_final_amount-p_paid_amount,'과거수동',nullif(btrim(p_memo),''),now(),now(),now(),v_email,
    'SUPABASE',1,p_request_id);
  if p_paid_amount>0 then
    insert into academy_app.salary_entries(entry_id,settlement_id,entry_type,amount,entry_date,memo,
      created_at,created_by,entry_status,reference_id,details_json,source_system)
    values('SLE-'||gen_random_uuid()::text,v_id,'지급',p_paid_amount,p_paid_date,nullif(btrim(p_memo),''),
      now(),v_email,'완료','',jsonb_build_object('action','HISTORICAL_CREATE','requestId',p_request_id),'SUPABASE');
  end if;
  v_result:=jsonb_build_object('settlementId',v_id,'status',v_status,'finalAmount',p_final_amount,
    'paidAmount',p_paid_amount,'balanceAmount',p_final_amount-p_paid_amount,'version',1,'replayed',false);
  insert into academy_app.salary_revisions(settlement_id,action,before_data,after_data,memo,actor_email,request_id)
  values(v_id,'HISTORICAL_CREATE',null,v_result,nullif(btrim(p_memo),''),v_email,p_request_id);
  insert into academy_app.salary_operation_requests values(p_request_id,'HISTORICAL_CREATE',v_hash,v_result,v_email,now());
  return v_result;
end;
$$;

create or replace function public.cancel_salary_settlement(
  p_settlement_id text,p_reason text,p_expected_version integer,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_email text:=academy_app.salary_admin_email();v_row academy_app.salary_settlements%rowtype;
  v_result jsonb;v_hash text;v_existing academy_app.salary_operation_requests%rowtype;v_before jsonb;v_after jsonb;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null or length(p_reason)>500 then
    raise exception using errcode='22023',message='500자 이하의 취소 사유를 입력해주세요.';
  end if;
  if p_request_id is null then raise exception using errcode='22023',message='중복 방지 요청 ID가 필요합니다.'; end if;
  v_hash:=md5(concat_ws('|',p_settlement_id,p_reason,p_expected_version));
  select * into v_existing from academy_app.salary_operation_requests where request_id=p_request_id;
  if found then
    if v_existing.request_hash<>v_hash then raise exception using errcode='22023',message='같은 요청 ID에 다른 입력값을 사용할 수 없습니다.'; end if;
    return v_existing.result_json;
  end if;
  select * into v_row from academy_app.salary_settlements where settlement_id=p_settlement_id for update;
  if not found then raise exception using errcode='P0002',message='정산 기록을 찾을 수 없습니다.'; end if;
  if v_row.version<>p_expected_version then raise exception using errcode='40001',message='다른 화면에서 급여 기록이 변경되었습니다. 새로고침 후 다시 시도해주세요.'; end if;
  if v_row.settlement_status='취소' then raise exception using errcode='22023',message='이미 취소된 정산입니다.'; end if;
  if v_row.paid_amount<>0 then raise exception using errcode='22023',message='지급 기록이 있는 정산은 지급액 차감 후 취소해주세요.'; end if;
  v_before:=jsonb_build_object('status',v_row.settlement_status,'finalAmount',v_row.final_amount,
    'paidAmount',v_row.paid_amount,'balanceAmount',v_row.balance_amount,'version',v_row.version);
  update academy_app.salary_settlements set settlement_status='취소',
    memo=concat_ws(' / ',nullif(memo,''),'[취소] '||btrim(p_reason)),updated_at=now(),
    source_system='SUPABASE',version=version+1,last_request_id=p_request_id
  where settlement_id=p_settlement_id returning * into v_row;
  update academy_app.salary_entries set entry_status='취소',source_system='SUPABASE'
  where settlement_id=p_settlement_id;
  v_after:=jsonb_build_object('status','취소','finalAmount',v_row.final_amount,
    'paidAmount',v_row.paid_amount,'balanceAmount',v_row.balance_amount,'version',v_row.version);
  insert into academy_app.salary_revisions(settlement_id,action,before_data,after_data,memo,actor_email,request_id)
  values(p_settlement_id,'CANCEL',v_before,v_after,btrim(p_reason),v_email,p_request_id);
  v_result:=jsonb_build_object('settlementId',p_settlement_id,'cancelled',true,'version',v_row.version,'replayed',false);
  insert into academy_app.salary_operation_requests values(p_request_id,'CANCEL',v_hash,v_result,v_email,now());
  return v_result;
end;
$$;

revoke all on function academy_app.salary_status(numeric,numeric) from public,anon;
revoke all on function academy_app.salary_admin_email() from public,anon;
revoke all on function public.get_salary_management_workspace(text,text) from public,anon;
revoke all on function public.get_salary_settlement_ledger(text) from public,anon;
revoke all on function public.update_salary_settlement(text,text,numeric,date,text,integer,uuid) from public,anon;
revoke all on function public.pay_salary_month(text,date,text,integer,numeric,uuid) from public,anon;
revoke all on function public.create_historical_salary_record(text,text,numeric,numeric,date,text,uuid) from public,anon;
revoke all on function public.cancel_salary_settlement(text,text,integer,uuid) from public,anon;
grant execute on function academy_app.salary_status(numeric,numeric) to authenticated;
grant execute on function academy_app.salary_admin_email() to authenticated;
grant execute on function public.get_salary_management_workspace(text,text) to authenticated;
grant execute on function public.get_salary_settlement_ledger(text) to authenticated;
grant execute on function public.update_salary_settlement(text,text,numeric,date,text,integer,uuid) to authenticated;
grant execute on function public.pay_salary_month(text,date,text,integer,numeric,uuid) to authenticated;
grant execute on function public.create_historical_salary_record(text,text,numeric,numeric,date,text,uuid) to authenticated;
grant execute on function public.cancel_salary_settlement(text,text,integer,uuid) to authenticated;

comment on table academy_app.salary_revisions is 'Append-only audit trail for every Supabase salary mutation.';
comment on function public.update_salary_settlement(text,text,numeric,date,text,integer,uuid) is 'Version-checked salary payment or final amount adjustment.';
