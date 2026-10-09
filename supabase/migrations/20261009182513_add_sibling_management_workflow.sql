create table if not exists academy_app.sibling_requests (
  request_id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null,
  operation text not null check (operation in ('GROUP','UNGROUP','DISCOUNT')),
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  selected_student_ids text[] not null,
  snapshot_student_ids text[] not null,
  student_names_snapshot jsonb not null default '{}'::jsonb,
  snapshot_versions jsonb not null default '{}'::jsonb,
  group_name text check (group_name is null or char_length(group_name)<=40),
  discount_amount numeric(14,2) check (discount_amount is null or (discount_amount>=0 and discount_amount<=10000000)),
  effective_month date,
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
  approved_group_id text,
  schema_version integer not null default 1,
  unique(requester_auth_user_id,idempotency_key),
  check (cardinality(selected_student_ids)>=1),
  check (cardinality(snapshot_student_ids)>=1),
  check (
    (operation='GROUP' and cardinality(selected_student_ids)>=2 and group_name is not null
      and discount_amount is null and effective_month is null)
    or (operation='UNGROUP' and group_name is null and discount_amount is null and effective_month is null)
    or (operation='DISCOUNT' and cardinality(selected_student_ids)=1 and group_name is null
      and discount_amount is not null and effective_month is not null
      and effective_month=date_trunc('month',effective_month)::date)
  )
);

create table if not exists academy_app.sibling_request_events (
  event_id uuid primary key default gen_random_uuid(),
  request_id uuid not null references academy_app.sibling_requests(request_id),
  event_type text not null check (event_type in ('SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  from_status text,
  to_status text not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists academy_app.sibling_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  request_id uuid not null references academy_app.sibling_requests(request_id),
  student_id text not null references academy_app.students(student_id),
  action text not null check (action in ('GROUP','UNGROUP','DISCOUNT')),
  previous_version integer not null,
  new_version integer not null,
  before_data jsonb not null,
  after_data jsonb not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  unique(request_id,student_id)
);

alter table academy_app.students
  add column if not exists last_sibling_request_id uuid references academy_app.sibling_requests(request_id);

create index if not exists academy_sibling_requests_requester_idx
  on academy_app.sibling_requests(requester_auth_user_id,created_at desc);
create index if not exists academy_sibling_requests_pending_idx
  on academy_app.sibling_requests(created_at) where status='PENDING';
create index if not exists academy_sibling_request_events_request_idx
  on academy_app.sibling_request_events(request_id,created_at);
create index if not exists academy_sibling_revisions_student_idx
  on academy_app.sibling_revisions(student_id,created_at desc);
create index if not exists academy_students_sibling_group_idx
  on academy_app.students(sibling_group_id,student_id)
  where sibling_group_id is not null and btrim(sibling_group_id)<>'';

alter table academy_app.sibling_requests enable row level security;
alter table academy_app.sibling_requests force row level security;
alter table academy_app.sibling_request_events enable row level security;
alter table academy_app.sibling_request_events force row level security;
alter table academy_app.sibling_revisions enable row level security;
alter table academy_app.sibling_revisions force row level security;
revoke all on table academy_app.sibling_requests from public,anon,authenticated;
revoke all on table academy_app.sibling_request_events from public,anon,authenticated;
revoke all on table academy_app.sibling_revisions from public,anon,authenticated;

create policy academy_sibling_request_read on academy_app.sibling_requests
for select to authenticated using (
  requester_auth_user_id=(select auth.uid()) or exists(
    select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN'
  )
);
create policy academy_sibling_request_insert on academy_app.sibling_requests
for insert to authenticated with check (
  requester_auth_user_id=(select auth.uid())
  and requester_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(
    select 1 from academy_app.user_access u
    where u.email=requester_email and u.active=true
      and (u.role='SUPER_ADMIN' or array_to_string(u.permissions,',') ~* '(^|,)[[:space:]]*SIBLING_MANAGER[[:space:]]*(,|$)')
  )
  and not exists(
    select 1 from unnest(selected_student_ids) selected_id
    where not exists(select 1 from academy_app.students s where s.student_id=selected_id)
  )
);
create policy academy_sibling_request_update on academy_app.sibling_requests
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
create policy academy_sibling_request_event_read on academy_app.sibling_request_events
for select to authenticated using (
  exists(select 1 from academy_app.sibling_requests r where r.request_id=sibling_request_events.request_id)
);
create policy academy_sibling_request_event_insert on academy_app.sibling_request_events
for insert to authenticated with check (
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.sibling_requests r where r.request_id=sibling_request_events.request_id)
);
create policy academy_sibling_revision_read on academy_app.sibling_revisions
for select to authenticated using (
  exists(select 1 from academy_app.students s where s.student_id=sibling_revisions.student_id)
);
create policy academy_sibling_revision_admin_insert on academy_app.sibling_revisions
for insert to authenticated with check (
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.user_access u
    where u.email=actor_email and u.active=true and u.role='SUPER_ADMIN')
);

grant select,insert,update on table academy_app.sibling_requests to authenticated;
grant select,insert on table academy_app.sibling_request_events to authenticated;
grant select,insert on table academy_app.sibling_revisions to authenticated;

create or replace function public.get_my_sibling_workspace()
returns jsonb
language plpgsql stable security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();
  v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_user academy_app.user_access%rowtype;
  v_students jsonb;
  v_groups jsonb;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_user from academy_app.user_access where email=v_email and active=true;
  if not found then raise exception using errcode='42501',message='형제 관리 권한이 없습니다.'; end if;
  if v_user.role<>'SUPER_ADMIN' and array_to_string(v_user.permissions,',') !~* '(^|,)[[:space:]]*SIBLING_MANAGER[[:space:]]*(,|$)' then
    raise exception using errcode='42501',message='이 계정에는 형제·자매 관리 권한이 없습니다.';
  end if;

  with resolved as materialized (
    select s.student_id,s.student_name,s.grade_label,s.sibling_group_id,s.sibling_group_name,s.version,
      st->>'status' status,st->>'teacherName' teacher_name,st->'siblingDiscount' sibling_discount
    from academy_app.students s
    cross join lateral academy_app.resolve_student_state(s.student_id,current_date) st
  ), student_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'studentId',student_id,'studentName',student_name,'gradeLabel',grade_label,
      'status',status,'teacherName',teacher_name,'groupId',sibling_group_id,'groupName',sibling_group_name,
      'siblingDiscount',sibling_discount,'version',version
    ) order by student_name,student_id),'[]'::jsonb) students
    from resolved
  )
  select student_payload.students,coalesce((
    select jsonb_agg(group_item order by group_item->>'groupName',group_item->>'groupId')
    from (
      select jsonb_build_object(
        'groupId',sibling_group_id,'groupName',min(sibling_group_name),
        'members',jsonb_agg(jsonb_build_object(
          'studentId',student_id,'studentName',student_name,'gradeLabel',grade_label,
          'status',status,'teacherName',teacher_name,
          'siblingDiscount',sibling_discount,'version',version
        ) order by student_name,student_id)
      ) group_item
      from resolved
      where nullif(btrim(sibling_group_id),'') is not null
      group by sibling_group_id
    ) grouped
  ),'[]'::jsonb)
  into v_students,v_groups
  from student_payload;

  return jsonb_build_object(
    'students',v_students,'groups',v_groups,
    'studentCount',jsonb_array_length(v_students),'groupCount',jsonb_array_length(v_groups),
    'canApprove',v_user.role='SUPER_ADMIN'
  );
end;
$$;

create or replace function public.submit_sibling_request(
  p_operation text,
  p_student_ids text[],
  p_group_name text default null,
  p_discount_amount numeric default null,
  p_effective_month date default null,
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
  v_group_name text:=nullif(btrim(coalesce(p_group_name,'')),'');
  v_reason text:=nullif(btrim(coalesce(p_request_reason,'')),'');
  v_key uuid:=coalesce(p_idempotency_key,gen_random_uuid());
  v_ids text[];
  v_snapshot_ids text[];
  v_user academy_app.user_access%rowtype;
  v_names jsonb;
  v_versions jsonb;
  v_request academy_app.sibling_requests%rowtype;
  v_inserted boolean:=false;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_user from academy_app.user_access where email=v_email and active=true;
  if not found then raise exception using errcode='42501',message='형제 관리 권한이 없습니다.'; end if;
  if v_user.role<>'SUPER_ADMIN' and array_to_string(v_user.permissions,',') !~* '(^|,)[[:space:]]*SIBLING_MANAGER[[:space:]]*(,|$)' then
    raise exception using errcode='42501',message='이 계정에는 형제·자매 관리 권한이 없습니다.';
  end if;
  if v_operation not in ('GROUP','UNGROUP','DISCOUNT') then
    raise exception using errcode='22023',message='형제 관리 요청 유형이 올바르지 않습니다.';
  end if;
  if char_length(coalesce(v_reason,''))>500 then raise exception using errcode='22023',message='요청 사유는 500자 이내여야 합니다.'; end if;

  select coalesce(array_agg(clean_id order by clean_id),'{}'::text[]) into v_ids
  from (
    select distinct btrim(raw_id) clean_id
    from unnest(coalesce(p_student_ids,'{}'::text[])) raw_id
    where nullif(btrim(raw_id),'') is not null
  ) cleaned;
  if cardinality(v_ids)=0 then raise exception using errcode='22023',message='학생을 한 명 이상 선택해주세요.'; end if;
  if exists(select 1 from unnest(v_ids) selected_id
    where not exists(select 1 from academy_app.students s where s.student_id=selected_id)) then
    raise exception using errcode='42501',message='학생을 찾을 수 없거나 형제 관리 권한이 없습니다.';
  end if;

  if v_operation='GROUP' then
    if cardinality(v_ids)<2 then raise exception using errcode='22023',message='형제로 묶으려면 서로 다른 학생 2명 이상이 필요합니다.'; end if;
    if v_group_name is null or char_length(v_group_name)>40 then raise exception using errcode='22023',message='가족 그룹명은 40자 이내로 입력해주세요.'; end if;
    if exists(
      select 1 from academy_app.students selected_student
      join academy_app.students family_member on family_member.sibling_group_id=selected_student.sibling_group_id
      where selected_student.student_id=any(v_ids)
        and nullif(btrim(selected_student.sibling_group_id),'') is not null
        and not (family_member.student_id=any(v_ids))
    ) then raise exception using errcode='22023',message='기존 가족을 변경하려면 해당 가족 구성원을 모두 선택해주세요.'; end if;
    p_discount_amount:=null;p_effective_month:=null;
  elsif v_operation='UNGROUP' then
    if exists(select 1 from academy_app.students s where s.student_id=any(v_ids)
      and nullif(btrim(s.sibling_group_id),'') is null) then
      raise exception using errcode='22023',message='형제 그룹에 속하지 않은 학생이 포함되어 있습니다.';
    end if;
    v_group_name:=null;p_discount_amount:=null;p_effective_month:=null;
  else
    if cardinality(v_ids)<>1 then raise exception using errcode='22023',message='할인을 변경할 학생 한 명을 선택해주세요.'; end if;
    if not exists(select 1 from academy_app.students s where s.student_id=v_ids[1]
      and nullif(btrim(s.sibling_group_id),'') is not null) then
      raise exception using errcode='22023',message='형제 그룹에 속한 학생만 할인액을 설정할 수 있습니다.';
    end if;
    if p_discount_amount is null or p_discount_amount<0 or p_discount_amount>10000000 then
      raise exception using errcode='22023',message='형제 할인액은 0원 이상 1천만원 이하로 입력해주세요.';
    end if;
    if p_effective_month is null or p_effective_month<>date_trunc('month',p_effective_month)::date then
      raise exception using errcode='22023',message='할인 적용 월을 확인해주세요.';
    end if;
    v_group_name:=null;
  end if;

  if v_operation in ('GROUP','UNGROUP') then
    select coalesce(array_agg(distinct snapshot_id order by snapshot_id),v_ids) into v_snapshot_ids
    from (
      select unnest(v_ids) snapshot_id
      union
      select family_member.student_id
      from academy_app.students selected_student
      join academy_app.students family_member on family_member.sibling_group_id=selected_student.sibling_group_id
      where selected_student.student_id=any(v_ids)
        and nullif(btrim(selected_student.sibling_group_id),'') is not null
    ) snapshots;
  else
    v_snapshot_ids:=v_ids;
  end if;

  select coalesce(jsonb_object_agg(s.student_id,s.student_name),'{}'::jsonb),
         coalesce(jsonb_object_agg(s.student_id,s.version),'{}'::jsonb)
  into v_names,v_versions
  from academy_app.students s where s.student_id=any(v_snapshot_ids);
  if (select count(*) from jsonb_object_keys(v_versions))<>cardinality(v_snapshot_ids) then
    raise exception using errcode='42501',message='가족 구성원 전체에 대한 관리 권한이 필요합니다.';
  end if;

  insert into academy_app.sibling_requests(
    idempotency_key,operation,selected_student_ids,snapshot_student_ids,
    student_names_snapshot,snapshot_versions,group_name,discount_amount,effective_month,
    request_reason,requester_auth_user_id,requester_email,requester_name
  ) values(
    v_key,v_operation,v_ids,v_snapshot_ids,v_names,v_versions,v_group_name,
    case when v_operation='DISCOUNT' then p_discount_amount end,
    case when v_operation='DISCOUNT' then p_effective_month end,
    v_reason,v_uid,v_email,v_user.display_name
  ) on conflict(requester_auth_user_id,idempotency_key) do nothing returning * into v_request;
  if found then
    v_inserted:=true;
    insert into academy_app.sibling_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
    values(v_request.request_id,'SUBMITTED',null,'PENDING',v_uid,v_email,jsonb_build_object('operation',v_operation));
  else
    select * into v_request from academy_app.sibling_requests
    where requester_auth_user_id=v_uid and idempotency_key=v_key;
    if not found or v_request.operation<>v_operation or v_request.selected_student_ids<>v_ids
      or v_request.group_name is distinct from v_group_name
      or v_request.discount_amount is distinct from (case when v_operation='DISCOUNT' then p_discount_amount else null end)
      or v_request.effective_month is distinct from (case when v_operation='DISCOUNT' then p_effective_month else null end)
      or v_request.request_reason is distinct from v_reason then
      raise exception using errcode='23505',message='같은 요청 키로 다른 형제 관리 내용이 전송되었습니다.';
    end if;
  end if;
  return jsonb_build_object('requestId',v_request.request_id,'status',v_request.status,'duplicate',not v_inserted);
end;
$$;

create or replace function public.search_my_sibling_requests(
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
  if not found then raise exception using errcode='42501',message='형제 관리 요청 조회 권한이 없습니다.'; end if;
  if v_status<>'' and v_status not in ('PENDING','APPROVED','REJECTED','CANCELLED') then
    raise exception using errcode='22023',message='요청 상태가 올바르지 않습니다.';
  end if;
  select count(*),count(*) filter(where status='PENDING') into v_total,v_pending
  from academy_app.sibling_requests where v_status='' or status=v_status;
  select coalesce(jsonb_agg(item order by sort_created desc,sort_id desc),'[]'::jsonb) into v_rows from(
    select jsonb_build_object(
      'requestId',r.request_id,'operation',r.operation,'status',r.status,
      'studentIds',to_jsonb(r.selected_student_ids),'studentNames',r.student_names_snapshot,
      'groupName',r.group_name,'discountAmount',r.discount_amount,
      'effectiveMonth',case when r.effective_month is null then null else to_char(r.effective_month,'YYYY-MM') end,
      'requestReason',r.request_reason,'requesterName',r.requester_name,'requesterEmail',r.requester_email,
      'createdAt',to_char(r.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'processedAt',case when r.processed_at is null then null else to_char(r.processed_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI') end,
      'decisionMemo',r.decision_memo,'approvedGroupId',r.approved_group_id
    ) item,r.created_at sort_created,r.request_id sort_id
    from academy_app.sibling_requests r where v_status='' or r.status=v_status
    order by r.created_at desc,r.request_id desc limit v_limit offset v_offset
  ) q;
  return jsonb_build_object('rows',v_rows,'total',v_total,'pending',v_pending,
    'canApprove',v_user.role='SUPER_ADMIN','limit',v_limit,'offset',v_offset);
end;
$$;

create or replace function public.cancel_my_sibling_request(p_request_id uuid)
returns jsonb
language plpgsql volatile security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_request academy_app.sibling_requests%rowtype;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_request from academy_app.sibling_requests where request_id=p_request_id for update;
  if not found or v_request.requester_auth_user_id<>v_uid then
    raise exception using errcode='42501',message='본인이 등록한 형제 관리 요청만 취소할 수 있습니다.';
  end if;
  if v_request.status<>'PENDING' then raise exception using errcode='55000',message='승인 대기 상태인 요청만 취소할 수 있습니다.'; end if;
  update academy_app.sibling_requests set status='CANCELLED',updated_at=now() where request_id=v_request.request_id;
  insert into academy_app.sibling_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email)
  values(v_request.request_id,'CANCELLED','PENDING','CANCELLED',v_uid,v_email);
  return jsonb_build_object('requestId',v_request.request_id,'status','CANCELLED');
end;
$$;

create or replace function public.decide_sibling_request(
  p_request_id uuid,p_decision text,p_memo text default null
)
returns jsonb
language plpgsql volatile security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_decision text:=upper(btrim(coalesce(p_decision,'')));v_memo text:=nullif(btrim(coalesce(p_memo,'')),'');
  v_request academy_app.sibling_requests%rowtype;
  v_student academy_app.students%rowtype;
  v_before jsonb;v_after jsonb;v_before_state jsonb;v_future record;
  v_id text;v_group_id text;v_affected_ids text[];v_snapshot_id text;
  v_event_id text;v_planned_discount numeric(14,2);
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  if not exists(select 1 from academy_app.user_access where email=v_email and active=true and role='SUPER_ADMIN') then
    raise exception using errcode='42501',message='최고 관리자만 형제 관리 요청을 처리할 수 있습니다.';
  end if;
  if v_decision not in ('APPROVE','REJECT') then raise exception using errcode='22023',message='승인 또는 반려를 선택해주세요.'; end if;
  if char_length(coalesce(v_memo,''))>500 then raise exception using errcode='22023',message='처리 메모는 500자 이내여야 합니다.'; end if;
  select * into v_request from academy_app.sibling_requests where request_id=p_request_id for update;
  if not found then raise exception using errcode='P0002',message='형제 관리 요청을 찾을 수 없습니다.'; end if;
  if v_request.status<>'PENDING' then raise exception using errcode='55000',message='승인 대기 상태인 요청만 처리할 수 있습니다.'; end if;
  if v_decision='REJECT' then
    update academy_app.sibling_requests set status='REJECTED',processed_at=now(),processed_by_auth_user_id=v_uid,
      processed_by_email=v_email,decision_memo=v_memo,updated_at=now() where request_id=v_request.request_id;
    insert into academy_app.sibling_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
    values(v_request.request_id,'REJECTED','PENDING','REJECTED',v_uid,v_email,jsonb_build_object('memo',v_memo));
    return jsonb_build_object('requestId',v_request.request_id,'status','REJECTED');
  end if;

  foreach v_snapshot_id in array v_request.snapshot_student_ids loop
    perform pg_advisory_xact_lock(hashtextextended(v_snapshot_id,492817));
  end loop;
  perform 1 from academy_app.students s
  where s.student_id=any(v_request.snapshot_student_ids)
  order by s.student_id for update;
  if (select count(*) from academy_app.students s where s.student_id=any(v_request.snapshot_student_ids))
      <>cardinality(v_request.snapshot_student_ids) then
    raise exception using errcode='55000',message='요청에 포함된 학생을 찾을 수 없습니다.';
  end if;
  if exists(
    select 1 from academy_app.students s
    where s.student_id=any(v_request.snapshot_student_ids)
      and s.version<>coalesce((v_request.snapshot_versions->>s.student_id)::integer,-1)
  ) then raise exception using errcode='40001',message='요청 후 학생 또는 가족 정보가 변경되었습니다. 새 요청을 등록해주세요.'; end if;

  if v_request.operation='GROUP' then
    if exists(
      select 1 from academy_app.students selected_student
      join academy_app.students family_member on family_member.sibling_group_id=selected_student.sibling_group_id
      where selected_student.student_id=any(v_request.selected_student_ids)
        and nullif(btrim(selected_student.sibling_group_id),'') is not null
        and not (family_member.student_id=any(v_request.selected_student_ids))
    ) then raise exception using errcode='55000',message='승인 전에 가족 구성이 변경되었습니다. 가족 구성원 전체로 새 요청을 등록해주세요.'; end if;
    v_group_id:='FAM-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
    foreach v_id in array v_request.selected_student_ids loop
      select * into v_student from academy_app.students where student_id=v_id for update;
      v_before:=to_jsonb(v_student);
      update academy_app.students set sibling_group_id=v_group_id,sibling_group_name=v_request.group_name,
        version=version+1,updated_at=now(),last_sibling_request_id=v_request.request_id
      where student_id=v_id returning * into v_student;
      v_after:=to_jsonb(v_student);
      insert into academy_app.sibling_revisions(request_id,student_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
      values(v_request.request_id,v_id,'GROUP',(v_before->>'version')::integer,v_student.version,v_before,v_after,v_uid,v_email);
    end loop;
  elsif v_request.operation='UNGROUP' then
    if exists(select 1 from academy_app.students s where s.student_id=any(v_request.selected_student_ids)
      and nullif(btrim(s.sibling_group_id),'') is null) then
      raise exception using errcode='55000',message='승인 전에 형제 관계가 이미 해제되었습니다.';
    end if;
    if exists(
      select 1 from academy_app.students selected_student
      join academy_app.students family_member on family_member.sibling_group_id=selected_student.sibling_group_id
      where selected_student.student_id=any(v_request.selected_student_ids)
        and not (family_member.student_id=any(v_request.snapshot_student_ids))
    ) then raise exception using errcode='55000',message='가족 구성원 전체에 대한 새 요청이 필요합니다.'; end if;

    select coalesce(array_agg(distinct affected_id order by affected_id),v_request.selected_student_ids)
    into v_affected_ids
    from (
      select unnest(v_request.selected_student_ids) affected_id
      union
      select remaining.student_id
      from (
        select family_member.sibling_group_id,min(family_member.student_id) student_id,count(*) remaining_count
        from academy_app.students selected_student
        join academy_app.students family_member on family_member.sibling_group_id=selected_student.sibling_group_id
        where selected_student.student_id=any(v_request.selected_student_ids)
          and not (family_member.student_id=any(v_request.selected_student_ids))
        group by family_member.sibling_group_id
        having count(*)=1
      ) remaining
    ) affected;

    foreach v_id in array v_affected_ids loop
      select * into v_student from academy_app.students where student_id=v_id for update;
      v_before:=to_jsonb(v_student);
      v_before_state:=academy_app.resolve_student_state(v_id,current_date);
      if coalesce((v_before_state->>'siblingDiscount')::numeric,0)<>0 then
        v_event_id:='EVT-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
        insert into academy_app.student_timeline_events(
          event_id,student_id,field_key,field_label,before_value,after_value,effective_date,
          created_at,request_id,actor_email,event_status,source_system
        ) values(
          v_event_id,v_id,'SIBLING_DISCOUNT','형제할인종료',v_before_state->>'siblingDiscount','0',current_date,
          now(),v_request.request_id::text,v_email,'완료','SUPABASE'
        );
      end if;
      for v_future in
        select effective_date,after_value from academy_app.student_timeline_events
        where student_id=v_id and field_key='SIBLING_DISCOUNT' and event_status='완료' and effective_date>current_date
        order by effective_date,created_at
      loop
        v_event_id:='EVT-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
        insert into academy_app.student_timeline_events(
          event_id,student_id,field_key,field_label,before_value,after_value,effective_date,
          created_at,request_id,actor_email,event_status,source_system
        ) values(
          v_event_id,v_id,'SIBLING_DISCOUNT','형제할인예약취소',v_future.after_value,'0',v_future.effective_date,
          clock_timestamp(),v_request.request_id::text,v_email,'완료','SUPABASE'
        );
      end loop;
      update academy_app.students set sibling_group_id=null,sibling_group_name=null,
        sibling_discount_text='0',sibling_discount_amount=0,version=version+1,
        updated_at=now(),last_sibling_request_id=v_request.request_id
      where student_id=v_id returning * into v_student;
      v_after:=to_jsonb(v_student);
      insert into academy_app.sibling_revisions(request_id,student_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
      values(v_request.request_id,v_id,'UNGROUP',(v_before->>'version')::integer,v_student.version,v_before,v_after,v_uid,v_email);
    end loop;
  else
    v_id:=v_request.selected_student_ids[1];
    select * into v_student from academy_app.students where student_id=v_id for update;
    if nullif(btrim(v_student.sibling_group_id),'') is null then
      raise exception using errcode='55000',message='승인 전에 형제 관계가 해제되었습니다.';
    end if;
    v_before:=to_jsonb(v_student);
    v_before_state:=academy_app.resolve_student_state(v_id,v_request.effective_month-1);
    v_event_id:='EVT-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
    insert into academy_app.student_timeline_events(
      event_id,student_id,field_key,field_label,before_value,after_value,effective_date,
      created_at,request_id,actor_email,event_status,source_system
    ) values(
      v_event_id,v_id,'SIBLING_DISCOUNT','형제할인액',v_before_state->>'siblingDiscount',
      v_request.discount_amount::text,v_request.effective_month,now(),v_request.request_id::text,v_email,'완료','SUPABASE'
    );
    v_planned_discount:=coalesce((academy_app.resolve_student_state(v_id,'9999-12-31'::date)->>'siblingDiscount')::numeric,0);
    update academy_app.students set sibling_discount_text=v_planned_discount::text,
      sibling_discount_amount=v_planned_discount,version=version+1,updated_at=now(),
      last_sibling_request_id=v_request.request_id
    where student_id=v_id returning * into v_student;
    v_after:=to_jsonb(v_student);
    insert into academy_app.sibling_revisions(request_id,student_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
    values(v_request.request_id,v_id,'DISCOUNT',(v_before->>'version')::integer,v_student.version,v_before,v_after,v_uid,v_email);
    v_group_id:=v_student.sibling_group_id;
  end if;

  update academy_app.sibling_requests set status='APPROVED',processed_at=now(),processed_by_auth_user_id=v_uid,
    processed_by_email=v_email,decision_memo=v_memo,approved_group_id=v_group_id,updated_at=now()
  where request_id=v_request.request_id;
  insert into academy_app.sibling_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
  values(v_request.request_id,'APPROVED','PENDING','APPROVED',v_uid,v_email,
    jsonb_build_object('operation',v_request.operation,'groupId',v_group_id,'memo',v_memo));
  return jsonb_build_object('requestId',v_request.request_id,'status','APPROVED',
    'operation',v_request.operation,'groupId',v_group_id);
end;
$$;

revoke all on function public.get_my_sibling_workspace() from public,anon;
revoke all on function public.submit_sibling_request(text,text[],text,numeric,date,text,uuid) from public,anon;
revoke all on function public.search_my_sibling_requests(text,integer,integer) from public,anon;
revoke all on function public.decide_sibling_request(uuid,text,text) from public,anon;
revoke all on function public.cancel_my_sibling_request(uuid) from public,anon;
grant execute on function public.get_my_sibling_workspace() to authenticated;
grant execute on function public.submit_sibling_request(text,text[],text,numeric,date,text,uuid) to authenticated;
grant execute on function public.search_my_sibling_requests(text,integer,integer) to authenticated;
grant execute on function public.decide_sibling_request(uuid,text,text) to authenticated;
grant execute on function public.cancel_my_sibling_request(uuid) to authenticated;

comment on table academy_app.sibling_requests is 'Audited sibling grouping, ungrouping, and effective-month discount approval requests.';
comment on table academy_app.sibling_revisions is 'Immutable per-student before/after snapshots for approved sibling changes.';
comment on function public.decide_sibling_request(uuid,text,text) is 'Atomically approves or rejects a sibling request with family-wide version checks.';
