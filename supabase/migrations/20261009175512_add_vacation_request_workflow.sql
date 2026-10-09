create table if not exists academy_app.vacation_requests (
  request_id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null,
  operation text not null check (operation in ('CREATE','UPDATE','DELETE')),
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  target_period_id text references academy_app.vacation_periods(period_id),
  base_period_version integer,
  student_id text not null references academy_app.students(student_id),
  student_name_snapshot text not null,
  start_date date not null,
  end_date date not null,
  vacation_reason text check (vacation_reason is null or char_length(vacation_reason)<=300),
  period_type text not null default '일반휴가' check (period_type in ('일반휴가','퇴원공백')),
  request_reason text check (request_reason is null or char_length(request_reason)<=500),
  requester_auth_user_id uuid not null,
  requester_email text not null check (requester_email=lower(btrim(requester_email))),
  requester_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by_auth_user_id uuid,
  processed_by_email text,
  decision_memo text check (decision_memo is null or char_length(decision_memo)<=500),
  approved_period_id text references academy_app.vacation_periods(period_id),
  schema_version integer not null default 1,
  unique(requester_auth_user_id,idempotency_key),
  check (start_date<=end_date),
  check (
    (operation='CREATE' and target_period_id is null and base_period_version is null)
    or (operation in ('UPDATE','DELETE') and target_period_id is not null and base_period_version>=1)
  )
);

create table if not exists academy_app.vacation_request_events (
  event_id uuid primary key default gen_random_uuid(),
  request_id uuid not null references academy_app.vacation_requests(request_id),
  event_type text not null check (event_type in ('SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  from_status text,
  to_status text not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists academy_app.vacation_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  period_id text not null references academy_app.vacation_periods(period_id),
  request_id uuid not null unique references academy_app.vacation_requests(request_id),
  action text not null check (action in ('CREATE','UPDATE','DELETE')),
  previous_version integer,
  new_version integer not null,
  before_data jsonb,
  after_data jsonb not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  created_at timestamptz not null default now()
);

create index if not exists academy_vacation_requests_requester_idx
  on academy_app.vacation_requests(requester_auth_user_id,created_at desc);
create index if not exists academy_vacation_requests_pending_idx
  on academy_app.vacation_requests(created_at) where status='PENDING';
create index if not exists academy_vacation_requests_student_idx
  on academy_app.vacation_requests(student_id,created_at desc);
create index if not exists academy_vacation_requests_target_idx
  on academy_app.vacation_requests(target_period_id) where target_period_id is not null;
create index if not exists academy_vacation_requests_approved_idx
  on academy_app.vacation_requests(approved_period_id) where approved_period_id is not null;
create index if not exists academy_vacation_request_events_request_idx
  on academy_app.vacation_request_events(request_id,created_at);
create index if not exists academy_vacation_revisions_period_idx
  on academy_app.vacation_revisions(period_id,created_at desc);

alter table academy_app.vacation_requests enable row level security;
alter table academy_app.vacation_requests force row level security;
alter table academy_app.vacation_request_events enable row level security;
alter table academy_app.vacation_request_events force row level security;
alter table academy_app.vacation_revisions enable row level security;
alter table academy_app.vacation_revisions force row level security;
revoke all on table academy_app.vacation_requests from public,anon,authenticated;
revoke all on table academy_app.vacation_request_events from public,anon,authenticated;
revoke all on table academy_app.vacation_revisions from public,anon,authenticated;

create policy academy_vacation_request_read on academy_app.vacation_requests
for select to authenticated using (
  requester_auth_user_id=(select auth.uid()) or exists(
    select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN'
  )
);
create policy academy_vacation_request_insert on academy_app.vacation_requests
for insert to authenticated with check (
  requester_auth_user_id=(select auth.uid())
  and requester_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(
    select 1 from academy_app.user_access u
    where u.email=requester_email and u.active=true
      and (u.role='SUPER_ADMIN' or array_to_string(u.permissions,',') ~* '(^|,)[[:space:]]*STUDENT_VACATION[[:space:]]*(,|$)')
  )
  and exists(select 1 from academy_app.students s where s.student_id=vacation_requests.student_id)
);
create policy academy_vacation_request_update on academy_app.vacation_requests
for update to authenticated using (
  exists(select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN')
  or (requester_auth_user_id=(select auth.uid()) and status='PENDING')
) with check (
  exists(select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN')
  or (requester_auth_user_id=(select auth.uid()) and status='CANCELLED')
);
create policy academy_vacation_request_event_read on academy_app.vacation_request_events
for select to authenticated using (
  exists(select 1 from academy_app.vacation_requests r where r.request_id=vacation_request_events.request_id)
);
create policy academy_vacation_request_event_insert on academy_app.vacation_request_events
for insert to authenticated with check (
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.vacation_requests r where r.request_id=vacation_request_events.request_id)
);
create policy academy_vacation_revision_read on academy_app.vacation_revisions
for select to authenticated using (
  exists(select 1 from academy_app.vacation_periods v where v.period_id=vacation_revisions.period_id)
);
create policy academy_vacation_revision_admin_insert on academy_app.vacation_revisions
for insert to authenticated with check (
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.user_access u where u.email=actor_email and u.active=true and u.role='SUPER_ADMIN')
);
create policy academy_vacation_admin_insert on academy_app.vacation_periods
for insert to authenticated with check (exists(
  select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'
));
create policy academy_vacation_admin_update on academy_app.vacation_periods
for update to authenticated using (exists(
  select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'
)) with check (exists(
  select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'
));

grant select,insert,update on table academy_app.vacation_requests to authenticated;
grant select,insert on table academy_app.vacation_request_events to authenticated;
grant select,insert on table academy_app.vacation_revisions to authenticated;
grant select,insert,update on table academy_app.vacation_periods to authenticated;

create or replace function public.submit_vacation_request(
  p_operation text,
  p_student_id text,
  p_period_id text,
  p_start_date date,
  p_end_date date,
  p_vacation_reason text default null,
  p_request_reason text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql volatile security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();
  v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_operation text:=upper(btrim(coalesce(p_operation,'')));
  v_student_id text:=nullif(btrim(coalesce(p_student_id,'')),'');
  v_period_id text:=nullif(btrim(coalesce(p_period_id,'')),'');
  v_vacation_reason text:=nullif(btrim(coalesce(p_vacation_reason,'')),'');
  v_request_reason text:=nullif(btrim(coalesce(p_request_reason,'')),'');
  v_key uuid:=coalesce(p_idempotency_key,gen_random_uuid());
  v_user academy_app.user_access%rowtype;
  v_student academy_app.students%rowtype;
  v_period academy_app.vacation_periods%rowtype;
  v_request academy_app.vacation_requests%rowtype;
  v_state jsonb;
  v_inserted boolean:=false;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_user from academy_app.user_access where email=v_email and active=true;
  if not found then raise exception using errcode='42501',message='휴가 관리 권한이 없습니다.'; end if;
  if v_user.role<>'SUPER_ADMIN' and array_to_string(v_user.permissions,',') !~* '(^|,)[[:space:]]*STUDENT_VACATION[[:space:]]*(,|$)' then
    raise exception using errcode='42501',message='이 계정에는 학생 휴가 권한이 없습니다.';
  end if;
  if v_operation not in ('CREATE','UPDATE','DELETE') then
    raise exception using errcode='22023',message='휴가 요청 유형이 올바르지 않습니다.';
  end if;
  if char_length(coalesce(v_vacation_reason,''))>300 or char_length(coalesce(v_request_reason,''))>500 then
    raise exception using errcode='22023',message='휴가 사유 또는 요청 사유가 너무 깁니다.';
  end if;

  if v_operation='CREATE' then
    if v_student_id is null or v_period_id is not null then
      raise exception using errcode='22023',message='신규 휴가의 학생 정보를 확인해주세요.';
    end if;
    select * into v_student from academy_app.students where student_id=v_student_id;
    if not found then raise exception using errcode='42501',message='학생을 찾을 수 없거나 휴가 요청 권한이 없습니다.'; end if;
    v_state:=academy_app.resolve_student_state(v_student.student_id,current_date);
    if v_state->>'status'<>'재원' then raise exception using errcode='22023',message='현재 재원 중인 학생만 휴가를 등록할 수 있습니다.'; end if;
  else
    if v_period_id is null then raise exception using errcode='22023',message='수정·삭제할 휴가 기간을 선택해주세요.'; end if;
    select * into v_period from academy_app.vacation_periods
    where period_id=v_period_id and deleted_at is null;
    if not found then raise exception using errcode='42501',message='휴가 기간을 찾을 수 없거나 요청 권한이 없습니다.'; end if;
    if v_period.period_type='퇴원공백' then
      raise exception using errcode='22023',message='퇴원공백은 학생 복귀 기록에서 자동 관리됩니다.';
    end if;
    if v_student_id is not null and v_student_id<>v_period.student_id then
      raise exception using errcode='22023',message='휴가 기간의 학생 정보가 일치하지 않습니다.';
    end if;
    v_student_id:=v_period.student_id;
    select * into v_student from academy_app.students where student_id=v_student_id;
    if not found then raise exception using errcode='42501',message='학생을 찾을 수 없거나 휴가 요청 권한이 없습니다.'; end if;
    v_state:=academy_app.resolve_student_state(v_student.student_id,current_date);
    if v_operation='DELETE' then
      p_start_date:=v_period.start_date;
      p_end_date:=v_period.end_date;
      v_vacation_reason:=v_period.vacation_reason;
    end if;
  end if;

  if v_user.role='MANAGER' and v_user.student_scope='LINKED_TEACHER'
    and coalesce(v_state->>'teacherId','')<>coalesce(v_user.teacher_id,'') then
    raise exception using errcode='42501',message='연결된 담당 원장의 학생만 휴가 요청을 등록할 수 있습니다.';
  end if;
  if p_start_date is null or p_end_date is null or p_start_date>p_end_date then
    raise exception using errcode='22023',message='휴가 시작일과 종료일을 확인해주세요.';
  end if;
  if v_operation in ('CREATE','UPDATE') and exists(
    select 1 from academy_app.vacation_periods v
    where v.student_id=v_student_id and v.deleted_at is null
      and v.period_id is distinct from v_period_id
      and daterange(v.start_date,v.end_date,'[]') && daterange(p_start_date,p_end_date,'[]')
  ) then raise exception using errcode='23P01',message='기존 휴가·퇴원공백 기간과 겹칩니다.'; end if;

  insert into academy_app.vacation_requests(
    idempotency_key,operation,target_period_id,base_period_version,student_id,student_name_snapshot,
    start_date,end_date,vacation_reason,period_type,request_reason,
    requester_auth_user_id,requester_email,requester_name
  ) values(
    v_key,v_operation,v_period_id,case when v_operation<>'CREATE' then v_period.version end,
    v_student.student_id,v_student.student_name,p_start_date,p_end_date,v_vacation_reason,'일반휴가',v_request_reason,
    v_uid,v_email,v_user.display_name
  ) on conflict(requester_auth_user_id,idempotency_key) do nothing returning * into v_request;
  if found then
    v_inserted:=true;
    insert into academy_app.vacation_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
    values(v_request.request_id,'SUBMITTED',null,'PENDING',v_uid,v_email,jsonb_build_object('operation',v_operation));
  else
    select * into v_request from academy_app.vacation_requests
    where requester_auth_user_id=v_uid and idempotency_key=v_key;
    if not found or v_request.operation<>v_operation or v_request.target_period_id is distinct from v_period_id
      or v_request.student_id<>v_student_id or v_request.start_date<>p_start_date or v_request.end_date<>p_end_date
      or v_request.vacation_reason is distinct from v_vacation_reason or v_request.request_reason is distinct from v_request_reason then
      raise exception using errcode='23505',message='같은 요청 키로 다른 휴가 내용이 전송되었습니다.';
    end if;
  end if;
  return jsonb_build_object('requestId',v_request.request_id,'status',v_request.status,'duplicate',not v_inserted);
end;
$$;

create or replace function public.cancel_my_vacation_request(p_request_id uuid)
returns jsonb
language plpgsql volatile security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_request academy_app.vacation_requests%rowtype;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_request from academy_app.vacation_requests where request_id=p_request_id for update;
  if not found or v_request.requester_auth_user_id<>v_uid then
    raise exception using errcode='42501',message='본인이 등록한 휴가 요청만 취소할 수 있습니다.';
  end if;
  if v_request.status<>'PENDING' then raise exception using errcode='55000',message='승인 대기 상태인 요청만 취소할 수 있습니다.'; end if;
  update academy_app.vacation_requests set status='CANCELLED',updated_at=now() where request_id=v_request.request_id;
  insert into academy_app.vacation_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email)
  values(v_request.request_id,'CANCELLED','PENDING','CANCELLED',v_uid,v_email);
  return jsonb_build_object('requestId',v_request.request_id,'status','CANCELLED');
end;
$$;

create or replace function public.search_my_vacation_requests(
  p_status text default null,p_limit integer default 100,p_offset integer default 0
)
returns jsonb
language plpgsql stable security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_status text:=upper(btrim(coalesce(p_status,'')));
  v_limit integer:=least(greatest(coalesce(p_limit,100),1),200);
  v_offset integer:=greatest(coalesce(p_offset,0),0);
  v_user academy_app.user_access%rowtype;v_total bigint;v_pending bigint;v_rows jsonb;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_user from academy_app.user_access where email=v_email and active=true;
  if not found then raise exception using errcode='42501',message='휴가 요청 조회 권한이 없습니다.'; end if;
  if v_status<>'' and v_status not in ('PENDING','APPROVED','REJECTED','CANCELLED') then
    raise exception using errcode='22023',message='요청 상태가 올바르지 않습니다.';
  end if;
  select count(*),count(*) filter(where status='PENDING') into v_total,v_pending
  from academy_app.vacation_requests where v_status='' or status=v_status;
  select coalesce(jsonb_agg(item order by sort_created desc,sort_id desc),'[]'::jsonb) into v_rows from(
    select jsonb_build_object(
      'requestId',r.request_id,'operation',r.operation,'status',r.status,
      'targetPeriodId',r.target_period_id,'studentId',r.student_id,'studentName',r.student_name_snapshot,
      'startDate',to_char(r.start_date,'YYYY-MM-DD'),'endDate',to_char(r.end_date,'YYYY-MM-DD'),
      'vacationReason',r.vacation_reason,'periodType',r.period_type,'requestReason',r.request_reason,
      'requesterName',r.requester_name,'requesterEmail',r.requester_email,
      'createdAt',to_char(r.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'processedAt',case when r.processed_at is null then null else to_char(r.processed_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI') end,
      'decisionMemo',r.decision_memo,'approvedPeriodId',r.approved_period_id
    ) item,r.created_at sort_created,r.request_id sort_id
    from academy_app.vacation_requests r where v_status='' or r.status=v_status
    order by r.created_at desc,r.request_id desc limit v_limit offset v_offset
  )q;
  return jsonb_build_object('rows',v_rows,'total',v_total,'pending',v_pending,
    'canApprove',v_user.role='SUPER_ADMIN','limit',v_limit,'offset',v_offset);
end;
$$;

create or replace function public.decide_vacation_request(p_request_id uuid,p_decision text,p_memo text default null)
returns jsonb
language plpgsql volatile security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_decision text:=upper(btrim(coalesce(p_decision,'')));v_memo text:=nullif(btrim(coalesce(p_memo,'')),'');
  v_request academy_app.vacation_requests%rowtype;v_period academy_app.vacation_periods%rowtype;
  v_student academy_app.students%rowtype;v_state jsonb;v_before jsonb;v_after jsonb;v_period_id text;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  if not exists(select 1 from academy_app.user_access where email=v_email and active=true and role='SUPER_ADMIN') then
    raise exception using errcode='42501',message='최고 관리자만 휴가 요청을 처리할 수 있습니다.';
  end if;
  if v_decision not in ('APPROVE','REJECT') then raise exception using errcode='22023',message='승인 또는 반려를 선택해주세요.'; end if;
  if char_length(coalesce(v_memo,''))>500 then raise exception using errcode='22023',message='처리 메모는 500자 이내여야 합니다.'; end if;
  select * into v_request from academy_app.vacation_requests where request_id=p_request_id for update;
  if not found then raise exception using errcode='P0002',message='휴가 요청을 찾을 수 없습니다.'; end if;
  if v_request.status<>'PENDING' then raise exception using errcode='55000',message='승인 대기 상태인 요청만 처리할 수 있습니다.'; end if;
  if v_decision='REJECT' then
    update academy_app.vacation_requests set status='REJECTED',processed_at=now(),processed_by_auth_user_id=v_uid,
      processed_by_email=v_email,decision_memo=v_memo,updated_at=now() where request_id=v_request.request_id;
    insert into academy_app.vacation_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
    values(v_request.request_id,'REJECTED','PENDING','REJECTED',v_uid,v_email,jsonb_build_object('memo',v_memo));
    return jsonb_build_object('requestId',v_request.request_id,'status','REJECTED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_request.student_id,734927));
  select * into v_student from academy_app.students where student_id=v_request.student_id for update;
  if not found then raise exception using errcode='55000',message='대상 학생을 찾을 수 없습니다.'; end if;
  if v_request.operation='CREATE' then
    v_state:=academy_app.resolve_student_state(v_student.student_id,current_date);
    if v_state->>'status'<>'재원' then raise exception using errcode='55000',message='승인 시점에 재원 중인 학생만 휴가를 등록할 수 있습니다.'; end if;
  else
    select * into v_period from academy_app.vacation_periods
    where period_id=v_request.target_period_id for update;
    if not found or v_period.deleted_at is not null then raise exception using errcode='55000',message='대상 휴가 기간이 없거나 이미 삭제되었습니다.'; end if;
    if v_period.version<>v_request.base_period_version then
      raise exception using errcode='40001',message='요청 후 휴가 기간이 변경되었습니다. 새 요청을 등록해주세요.';
    end if;
    if v_period.period_type='퇴원공백' then raise exception using errcode='55000',message='퇴원공백은 직접 수정·삭제할 수 없습니다.'; end if;
  end if;
  perform 1 from academy_app.vacation_periods
  where student_id=v_request.student_id and deleted_at is null for update;
  if v_request.operation in ('CREATE','UPDATE') and exists(
    select 1 from academy_app.vacation_periods v
    where v.student_id=v_request.student_id and v.deleted_at is null
      and v.period_id is distinct from v_request.target_period_id
      and daterange(v.start_date,v.end_date,'[]') && daterange(v_request.start_date,v_request.end_date,'[]')
  ) then raise exception using errcode='23P01',message='승인 전에 겹치는 휴가·퇴원공백이 등록되었습니다.'; end if;

  if v_request.operation='CREATE' then
    v_period_id:='VAC-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
    insert into academy_app.vacation_periods(
      period_id,student_id,student_name_snapshot,start_date,end_date,vacation_reason,
      period_type,created_at,creation_method,source_system,version,updated_at,last_request_id
    ) values(
      v_period_id,v_request.student_id,v_request.student_name_snapshot,v_request.start_date,v_request.end_date,
      v_request.vacation_reason,'일반휴가',now(),'직접등록','SUPABASE',1,now(),v_request.request_id
    ) returning * into v_period;
    v_after:=to_jsonb(v_period);
    insert into academy_app.vacation_revisions(period_id,request_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
    values(v_period_id,v_request.request_id,'CREATE',null,1,null,v_after,v_uid,v_email);
  elsif v_request.operation='UPDATE' then
    v_period_id:=v_period.period_id;v_before:=to_jsonb(v_period);
    update academy_app.vacation_periods set start_date=v_request.start_date,end_date=v_request.end_date,
      vacation_reason=v_request.vacation_reason,version=version+1,updated_at=now(),last_request_id=v_request.request_id
    where period_id=v_period_id returning * into v_period;
    v_after:=to_jsonb(v_period);
    insert into academy_app.vacation_revisions(period_id,request_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
    values(v_period_id,v_request.request_id,'UPDATE',v_request.base_period_version,v_period.version,v_before,v_after,v_uid,v_email);
  else
    v_period_id:=v_period.period_id;v_before:=to_jsonb(v_period);
    update academy_app.vacation_periods set deleted_at=now(),deleted_by_email=v_email,
      delete_reason=coalesce(v_request.request_reason,'휴가 기간 삭제'),
      purge_after=(current_date+interval '2 months')::date,version=version+1,updated_at=now(),last_request_id=v_request.request_id
    where period_id=v_period_id returning * into v_period;
    v_after:=to_jsonb(v_period);
    insert into academy_app.vacation_revisions(period_id,request_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
    values(v_period_id,v_request.request_id,'DELETE',v_request.base_period_version,v_period.version,v_before,v_after,v_uid,v_email);
  end if;
  update academy_app.vacation_requests set status='APPROVED',processed_at=now(),processed_by_auth_user_id=v_uid,
    processed_by_email=v_email,decision_memo=v_memo,approved_period_id=v_period_id,updated_at=now()
  where request_id=v_request.request_id;
  insert into academy_app.vacation_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
  values(v_request.request_id,'APPROVED','PENDING','APPROVED',v_uid,v_email,
    jsonb_build_object('periodId',v_period_id,'operation',v_request.operation,'memo',v_memo));
  return jsonb_build_object('requestId',v_request.request_id,'status','APPROVED','periodId',v_period_id,'operation',v_request.operation);
end;
$$;

revoke all on function public.submit_vacation_request(text,text,text,date,date,text,text,uuid) from public,anon;
revoke all on function public.search_my_vacation_requests(text,integer,integer) from public,anon;
revoke all on function public.decide_vacation_request(uuid,text,text) from public,anon;
revoke all on function public.cancel_my_vacation_request(uuid) from public,anon;
grant execute on function public.submit_vacation_request(text,text,text,date,date,text,text,uuid) to authenticated;
grant execute on function public.search_my_vacation_requests(text,integer,integer) to authenticated;
grant execute on function public.decide_vacation_request(uuid,text,text) to authenticated;
grant execute on function public.cancel_my_vacation_request(uuid) to authenticated;

comment on table academy_app.vacation_requests is 'Audited vacation create, update, and recoverable-delete approval requests.';
comment on table academy_app.vacation_revisions is 'Immutable before/after snapshots for approved vacation changes.';
comment on function public.decide_vacation_request(uuid,text,text) is 'Atomically approves or rejects a pending vacation request with overlap and version checks.';
