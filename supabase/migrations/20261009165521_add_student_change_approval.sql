create table if not exists academy_app.student_requests (
  request_id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null,
  operation text not null check (operation in ('CREATE','UPDATE')),
  status text not null default 'PENDING'
    check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  target_student_id text references academy_app.students(student_id),
  base_student_version integer,
  student_name text not null check (char_length(btrim(student_name)) between 1 and 40),
  grade_label text not null check (char_length(btrim(grade_label)) between 1 and 30),
  requested_status text not null check (requested_status in ('재원','퇴원')),
  teacher_id text not null references academy_app.teachers(teacher_id),
  teacher_name_snapshot text not null,
  first_lesson_date date not null,
  original_enrollment_date date,
  tuition_reference_day integer not null check (tuition_reference_day between 1 and 31),
  tuition_amount numeric(14,2) not null
    check (tuition_amount between 0 and 10000000 and tuition_amount=trunc(tuition_amount)),
  parent_phone text check (parent_phone is null or char_length(parent_phone)<=30),
  course_type text not null check (course_type in ('정규','특강전용')),
  fee_effective_date date,
  status_effective_date date,
  teacher_effective_date date,
  reason text check (reason is null or char_length(reason)<=500),
  requester_auth_user_id uuid not null,
  requester_email text not null,
  requester_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by_auth_user_id uuid,
  processed_by_email text,
  decision_memo text check (decision_memo is null or char_length(decision_memo)<=500),
  approved_student_id text references academy_app.students(student_id),
  schema_version integer not null default 1,
  unique (requester_auth_user_id,idempotency_key),
  check (
    (operation='CREATE' and target_student_id is null and base_student_version is null)
    or (operation='UPDATE' and target_student_id is not null and base_student_version>=1)
  ),
  check (requester_email=lower(btrim(requester_email)))
);

create table if not exists academy_app.student_request_events (
  event_id uuid primary key default gen_random_uuid(),
  request_id uuid not null references academy_app.student_requests(request_id),
  event_type text not null check (event_type in ('SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  from_status text,
  to_status text not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists academy_app.student_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  student_id text not null references academy_app.students(student_id),
  request_id uuid not null references academy_app.student_requests(request_id),
  action text not null check (action in ('CREATE','UPDATE')),
  previous_version integer,
  new_version integer not null,
  before_data jsonb,
  after_data jsonb not null,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  unique (request_id)
);

create index if not exists academy_student_requests_requester_idx
  on academy_app.student_requests (requester_auth_user_id,created_at desc);
create index if not exists academy_student_requests_pending_idx
  on academy_app.student_requests (created_at) where status='PENDING';
create index if not exists academy_student_requests_target_idx
  on academy_app.student_requests (target_student_id) where target_student_id is not null;
create index if not exists academy_student_requests_teacher_idx
  on academy_app.student_requests (teacher_id);
create index if not exists academy_student_requests_approved_idx
  on academy_app.student_requests (approved_student_id) where approved_student_id is not null;
create index if not exists academy_student_request_events_request_idx
  on academy_app.student_request_events (request_id,created_at);
create index if not exists academy_student_revisions_student_idx
  on academy_app.student_revisions (student_id,created_at desc);

alter table academy_app.student_requests enable row level security;
alter table academy_app.student_requests force row level security;
alter table academy_app.student_request_events enable row level security;
alter table academy_app.student_request_events force row level security;
alter table academy_app.student_revisions enable row level security;
alter table academy_app.student_revisions force row level security;
revoke all on table academy_app.student_requests from public,anon,authenticated;
revoke all on table academy_app.student_request_events from public,anon,authenticated;
revoke all on table academy_app.student_revisions from public,anon,authenticated;

create policy academy_student_request_read on academy_app.student_requests
for select to authenticated
using (
  requester_auth_user_id=(select auth.uid())
  or exists (
    select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN'
  )
);

create policy academy_student_request_insert on academy_app.student_requests
for insert to authenticated
with check (
  requester_auth_user_id=(select auth.uid())
  and requester_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists (
    select 1 from academy_app.user_access u
    where u.email=requester_email and u.active=true
      and (
        u.role='SUPER_ADMIN'
        or (operation='CREATE' and array_to_string(u.permissions,',') ~* '(^|,)[[:space:]]*STUDENT_ADD[[:space:]]*(,|$)')
        or (operation='UPDATE' and array_to_string(u.permissions,',') ~* '(^|,)[[:space:]]*STUDENT_EDIT[[:space:]]*(,|$)')
      )
      and (u.student_scope='ALL_STUDENTS' or u.teacher_id=student_requests.teacher_id)
  )
);

create policy academy_student_request_update on academy_app.student_requests
for update to authenticated
using (
  exists (
    select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN'
  )
  or (requester_auth_user_id=(select auth.uid()) and status='PENDING')
)
with check (
  exists (
    select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN'
  )
  or (requester_auth_user_id=(select auth.uid()) and status='CANCELLED')
);

create policy academy_student_request_event_read on academy_app.student_request_events
for select to authenticated
using (exists(select 1 from academy_app.student_requests r where r.request_id=student_request_events.request_id));
create policy academy_student_request_event_insert on academy_app.student_request_events
for insert to authenticated
with check (
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.student_requests r where r.request_id=student_request_events.request_id)
);

create policy academy_student_revision_read on academy_app.student_revisions
for select to authenticated
using (exists(select 1 from academy_app.students s where s.student_id=student_revisions.student_id));
create policy academy_student_revision_admin_insert on academy_app.student_revisions
for insert to authenticated
with check (
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.user_access u where u.email=actor_email and u.active=true and u.role='SUPER_ADMIN')
);

create policy academy_student_admin_insert on academy_app.students
for insert to authenticated
with check (exists(
  select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'
));
create policy academy_student_admin_update on academy_app.students
for update to authenticated
using (exists(
  select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'
))
with check (exists(
  select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'
));
create policy academy_student_timeline_admin_insert on academy_app.student_timeline_events
for insert to authenticated
with check (source_system='SUPABASE' and exists(
  select 1 from academy_app.user_access u
  where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
    and u.active=true and u.role='SUPER_ADMIN'
));

grant select,insert,update on table academy_app.student_requests to authenticated;
grant select,insert on table academy_app.student_request_events to authenticated;
grant select,insert on table academy_app.student_revisions to authenticated;
grant select,insert,update on table academy_app.students to authenticated;
grant select,insert on table academy_app.student_timeline_events to authenticated;

create or replace function public.submit_student_request(
  p_operation text,
  p_student_id text,
  p_name text,
  p_grade text,
  p_status text,
  p_teacher_id text,
  p_first_lesson_date date,
  p_original_enrollment_date date,
  p_base_day integer,
  p_tuition numeric,
  p_parent_phone text,
  p_course_type text,
  p_fee_effective_date date default null,
  p_status_effective_date date default null,
  p_teacher_effective_date date default null,
  p_reason text default null,
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
  v_name text:=btrim(coalesce(p_name,''));
  v_grade text:=btrim(coalesce(p_grade,''));
  v_status text:=btrim(coalesce(p_status,''));
  v_teacher_id text:=btrim(coalesce(p_teacher_id,''));
  v_phone text:=nullif(btrim(coalesce(p_parent_phone,'')),'');
  v_course text:=case when btrim(coalesce(p_course_type,''))='특강전용' then '특강전용' else '정규' end;
  v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
  v_key uuid:=coalesce(p_idempotency_key,gen_random_uuid());
  v_user academy_app.user_access%rowtype;
  v_teacher academy_app.teachers%rowtype;
  v_student academy_app.students%rowtype;
  v_request academy_app.student_requests%rowtype;
  v_fee_date date;
  v_inserted boolean:=false;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_user from academy_app.user_access where email=v_email and active=true;
  if not found then raise exception using errcode='42501',message='학생 관리 권한이 없습니다.'; end if;
  if v_operation not in ('CREATE','UPDATE') then raise exception using errcode='22023',message='학생 요청 유형이 올바르지 않습니다.'; end if;
  if v_user.role<>'SUPER_ADMIN' and (
    (v_operation='CREATE' and array_to_string(v_user.permissions,',') !~* '(^|,)[[:space:]]*STUDENT_ADD[[:space:]]*(,|$)')
    or (v_operation='UPDATE' and array_to_string(v_user.permissions,',') !~* '(^|,)[[:space:]]*STUDENT_EDIT[[:space:]]*(,|$)')
  ) then raise exception using errcode='42501',message='이 학생 작업 권한이 없습니다.'; end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_grade) not between 1 and 30 then
    raise exception using errcode='22023',message='학생 이름 또는 학년을 확인해주세요.';
  end if;
  if v_status not in ('재원','퇴원') then raise exception using errcode='22023',message='학생 상태가 올바르지 않습니다.'; end if;
  if p_first_lesson_date is null or p_base_day not between 1 and 31 then
    raise exception using errcode='22023',message='첫 수업일과 수납 기준일을 확인해주세요.';
  end if;
  if p_tuition is null or p_tuition<0 or p_tuition>10000000 or p_tuition<>trunc(p_tuition) then
    raise exception using errcode='22023',message='수강료는 0~1천만원 범위의 원 단위 정수여야 합니다.';
  end if;
  if char_length(coalesce(v_phone,''))>30 or char_length(coalesce(v_reason,''))>500 then
    raise exception using errcode='22023',message='연락처 또는 요청 사유가 너무 깁니다.';
  end if;
  if v_course='특강전용' then p_tuition:=0; end if;
  select * into v_teacher from academy_app.teachers where teacher_id=v_teacher_id;
  if not found then raise exception using errcode='22023',message='등록된 담당 원장을 선택해주세요.'; end if;
  if v_user.role='MANAGER' and v_user.student_scope='LINKED_TEACHER' and v_user.teacher_id<>v_teacher_id then
    raise exception using errcode='42501',message='연결된 담당 원장으로만 학생 요청을 등록할 수 있습니다.';
  end if;

  if v_operation='CREATE' then
    if v_student_id is not null then raise exception using errcode='22023',message='신규 등록에는 학생 ID를 지정할 수 없습니다.'; end if;
    if not v_teacher.active then raise exception using errcode='22023',message='활성 상태인 담당 원장을 선택해주세요.'; end if;
    if v_status<>'재원' then raise exception using errcode='22023',message='신규 학생은 재원 상태로 등록됩니다.'; end if;
    if exists(
      select 1 from academy_app.students s
      where lower(regexp_replace(s.student_name,'[[:space:]]','','g'))=lower(regexp_replace(v_name,'[[:space:]]','','g'))
        and regexp_replace(coalesce(s.parent_phone,''),'[^0-9]','','g')<>''
        and regexp_replace(coalesce(s.parent_phone,''),'[^0-9]','','g')=regexp_replace(coalesce(v_phone,''),'[^0-9]','','g')
    ) then raise exception using errcode='23505',message='같은 이름과 보호자 전화번호로 등록된 학생이 이미 있습니다.'; end if;
  else
    if v_student_id is null then raise exception using errcode='22023',message='수정할 학생을 선택해주세요.'; end if;
    select * into v_student from academy_app.students where student_id=v_student_id;
    if not found then raise exception using errcode='42501',message='학생을 찾을 수 없거나 수정 요청 권한이 없습니다.'; end if;
    if not v_teacher.active and v_teacher_id is distinct from v_student.teacher_id then
      raise exception using errcode='22023',message='비활성 원장은 새 담당자로 지정할 수 없습니다.';
    end if;
  end if;
  v_fee_date:=coalesce(p_fee_effective_date,current_date);
  v_fee_date:=make_date(extract(year from v_fee_date)::integer,extract(month from v_fee_date)::integer,
    least(p_base_day,extract(day from (date_trunc('month',v_fee_date)+interval '1 month - 1 day'))::integer));

  insert into academy_app.student_requests(
    idempotency_key,operation,target_student_id,base_student_version,student_name,grade_label,
    requested_status,teacher_id,teacher_name_snapshot,first_lesson_date,original_enrollment_date,
    tuition_reference_day,tuition_amount,parent_phone,course_type,fee_effective_date,
    status_effective_date,teacher_effective_date,reason,requester_auth_user_id,requester_email,requester_name
  ) values(
    v_key,v_operation,v_student_id,case when v_operation='UPDATE' then v_student.version end,v_name,v_grade,
    v_status,v_teacher.teacher_id,v_teacher.teacher_name,p_first_lesson_date,p_original_enrollment_date,
    p_base_day,p_tuition,v_phone,v_course,case when v_operation='UPDATE' then v_fee_date end,
    case when v_operation='UPDATE' then coalesce(p_status_effective_date,current_date) end,
    case when v_operation='UPDATE' then coalesce(p_teacher_effective_date,current_date) end,
    v_reason,v_uid,v_email,v_user.display_name
  ) on conflict(requester_auth_user_id,idempotency_key) do nothing returning * into v_request;
  if found then
    v_inserted:=true;
    insert into academy_app.student_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
    values(v_request.request_id,'SUBMITTED',null,'PENDING',v_uid,v_email,jsonb_build_object('operation',v_operation));
  else
    select * into v_request from academy_app.student_requests
    where requester_auth_user_id=v_uid and idempotency_key=v_key;
    if not found or v_request.operation<>v_operation or v_request.target_student_id is distinct from v_student_id
      or v_request.student_name<>v_name or v_request.grade_label<>v_grade or v_request.requested_status<>v_status
      or v_request.teacher_id<>v_teacher_id or v_request.first_lesson_date<>p_first_lesson_date
      or v_request.tuition_reference_day<>p_base_day or v_request.tuition_amount<>p_tuition
      or v_request.parent_phone is distinct from v_phone or v_request.course_type<>v_course then
      raise exception using errcode='23505',message='같은 요청 키로 다른 학생 내용이 전송되었습니다.';
    end if;
  end if;
  return jsonb_build_object('requestId',v_request.request_id,'status',v_request.status,'duplicate',not v_inserted);
end;
$$;

create or replace function public.search_my_student_requests(
  p_status text default null,p_limit integer default 100,p_offset integer default 0
)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_status text:=upper(btrim(coalesce(p_status,'')));v_limit integer:=least(greatest(coalesce(p_limit,100),1),200);
  v_offset integer:=greatest(coalesce(p_offset,0),0);v_user academy_app.user_access%rowtype;
  v_total bigint;v_pending bigint;v_rows jsonb;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_user from academy_app.user_access where email=v_email and active=true;
  if not found then raise exception using errcode='42501',message='학생 요청 조회 권한이 없습니다.'; end if;
  if v_status<>'' and v_status not in ('PENDING','APPROVED','REJECTED','CANCELLED') then raise exception using errcode='22023',message='요청 상태가 올바르지 않습니다.'; end if;
  select count(*),count(*) filter(where status='PENDING') into v_total,v_pending
  from academy_app.student_requests where v_status='' or status=v_status;
  select coalesce(jsonb_agg(item order by sort_created desc,sort_id desc),'[]'::jsonb) into v_rows from(
    select jsonb_build_object(
      'requestId',r.request_id,'operation',r.operation,'status',r.status,'targetStudentId',r.target_student_id,
      'studentName',r.student_name,'gradeLabel',r.grade_label,'requestedStatus',r.requested_status,
      'teacherId',r.teacher_id,'teacherName',r.teacher_name_snapshot,'firstLessonDate',to_char(r.first_lesson_date,'YYYY-MM-DD'),
      'originalEnrollmentDate',case when r.original_enrollment_date is null then null else to_char(r.original_enrollment_date,'YYYY-MM-DD') end,
      'baseDay',r.tuition_reference_day,'tuition',r.tuition_amount,'parentPhone',r.parent_phone,'courseType',r.course_type,
      'feeEffectiveDate',case when r.fee_effective_date is null then null else to_char(r.fee_effective_date,'YYYY-MM-DD') end,
      'statusEffectiveDate',case when r.status_effective_date is null then null else to_char(r.status_effective_date,'YYYY-MM-DD') end,
      'teacherEffectiveDate',case when r.teacher_effective_date is null then null else to_char(r.teacher_effective_date,'YYYY-MM-DD') end,
      'reason',r.reason,'requesterName',r.requester_name,'requesterEmail',r.requester_email,
      'createdAt',to_char(r.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'processedAt',case when r.processed_at is null then null else to_char(r.processed_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI') end,
      'decisionMemo',r.decision_memo,'approvedStudentId',r.approved_student_id
    ) item,r.created_at sort_created,r.request_id sort_id
    from academy_app.student_requests r where v_status='' or r.status=v_status
    order by r.created_at desc,r.request_id desc limit v_limit offset v_offset
  )q;
  return jsonb_build_object('rows',v_rows,'total',v_total,'pending',v_pending,'canApprove',v_user.role='SUPER_ADMIN','limit',v_limit,'offset',v_offset);
end;
$$;

create or replace function public.get_student_change_form(p_student_id text)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s'
as $$
declare v_student academy_app.students%rowtype;v_current jsonb;v_future jsonb;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_student from academy_app.students where student_id=btrim(coalesce(p_student_id,''));
  if not found then raise exception using errcode='42501',message='학생을 찾을 수 없거나 수정 권한이 없습니다.'; end if;
  v_current:=academy_app.resolve_student_state(v_student.student_id,current_date);
  select coalesce(jsonb_agg(jsonb_build_object('effectiveDate',to_char(effective_date,'YYYY-MM-DD'),'field',field_label,'after',after_value)
    order by effective_date,created_at,source_row_number),'[]'::jsonb) into v_future
  from academy_app.student_timeline_events where student_id=v_student.student_id and event_status='완료' and effective_date>current_date;
  return jsonb_build_object(
    'studentId',v_student.student_id,'name',v_student.student_name,'grade',v_student.grade_label,
    'status',v_student.status,'teacherId',v_student.teacher_id,'firstLessonDate',left(coalesce(v_student.first_lesson_date,''),10),
    'originalEnrollmentDate',left(coalesce(v_student.enrollment_date,''),10),
    'baseDay',v_student.tuition_reference_day_number,'tuition',v_student.tuition_amount,
    'parentPhone',v_student.parent_phone,'courseType',coalesce(nullif(v_student.course_type,''),'정규'),
    'version',v_student.version,'currentState',v_current,'futureChanges',v_future
  );
end;
$$;

create or replace function public.decide_student_request(p_request_id uuid,p_decision text,p_memo text default null)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_decision text:=upper(btrim(coalesce(p_decision,'')));v_memo text:=nullif(btrim(coalesce(p_memo,'')),'');
  v_request academy_app.student_requests%rowtype;v_student academy_app.students%rowtype;
  v_before jsonb;v_after jsonb;v_student_id text;v_before_state jsonb;v_event_id text;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  if not exists(select 1 from academy_app.user_access where email=v_email and active=true and role='SUPER_ADMIN') then
    raise exception using errcode='42501',message='최고 관리자만 학생 요청을 처리할 수 있습니다.';
  end if;
  if v_decision not in ('APPROVE','REJECT') then raise exception using errcode='22023',message='승인 또는 반려를 선택해주세요.'; end if;
  if char_length(coalesce(v_memo,''))>500 then raise exception using errcode='22023',message='처리 메모는 500자 이내여야 합니다.'; end if;
  select * into v_request from academy_app.student_requests where request_id=p_request_id for update;
  if not found then raise exception using errcode='P0002',message='학생 요청을 찾을 수 없습니다.'; end if;
  if v_request.status<>'PENDING' then raise exception using errcode='55000',message='승인 대기 상태인 요청만 처리할 수 있습니다.'; end if;
  if v_decision='REJECT' then
    update academy_app.student_requests set status='REJECTED',processed_at=now(),processed_by_auth_user_id=v_uid,
      processed_by_email=v_email,decision_memo=v_memo,updated_at=now() where request_id=v_request.request_id;
    insert into academy_app.student_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
    values(v_request.request_id,'REJECTED','PENDING','REJECTED',v_uid,v_email,jsonb_build_object('memo',v_memo));
    return jsonb_build_object('requestId',v_request.request_id,'status','REJECTED');
  end if;

  if v_request.operation='CREATE' then
    if exists(select 1 from academy_app.students s
      where lower(regexp_replace(s.student_name,'[[:space:]]','','g'))=lower(regexp_replace(v_request.student_name,'[[:space:]]','','g'))
        and regexp_replace(coalesce(s.parent_phone,''),'[^0-9]','','g')<>''
        and regexp_replace(coalesce(s.parent_phone,''),'[^0-9]','','g')=regexp_replace(coalesce(v_request.parent_phone,''),'[^0-9]','','g')) then
      raise exception using errcode='23505',message='승인 전에 같은 이름과 보호자 전화번호의 학생이 등록되었습니다.';
    end if;
    v_student_id:='S-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
    insert into academy_app.students(
      student_id,student_name,grade_label,status,teacher_id,teacher_name,tuition_text,tuition_reference_day,
      enrollment_date,first_lesson_date,exit_date,course_type,parent_phone,sibling_discount_text,
      distribution_rate_text,source_run_id,source_system,version,updated_at,last_request_id,
      tuition_amount,tuition_reference_day_number,sibling_discount_amount
    ) select
      v_student_id,v_request.student_name,v_request.grade_label,'재원',v_request.teacher_id,v_request.teacher_name_snapshot,
      v_request.tuition_amount::text,v_request.tuition_reference_day::text,
      coalesce(to_char(v_request.original_enrollment_date,'YYYY-MM-DD'),to_char(v_request.first_lesson_date,'YYYY-MM-DD')),
      to_char(v_request.first_lesson_date,'YYYY-MM-DD'),null,v_request.course_type,v_request.parent_phone,'0',
      t.default_distribution_rate::text||'%',null,'SUPABASE',1,now(),v_request.request_id,
      v_request.tuition_amount,v_request.tuition_reference_day,0
    from academy_app.teachers t where t.teacher_id=v_request.teacher_id
    returning * into v_student;
    v_after:=to_jsonb(v_student);
    insert into academy_app.student_revisions(student_id,request_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
    values(v_student_id,v_request.request_id,'CREATE',null,1,null,v_after,v_uid,v_email);
  else
    select * into v_student from academy_app.students where student_id=v_request.target_student_id for update;
    if not found then raise exception using errcode='55000',message='수정할 학생을 찾을 수 없습니다.'; end if;
    if v_student.version<>v_request.base_student_version then
      raise exception using errcode='40001',message='요청 후 학생 원본이 변경되었습니다. 새 수정 요청을 등록해주세요.';
    end if;
    v_student_id:=v_student.student_id;v_before:=to_jsonb(v_student);
    if v_student.status is distinct from v_request.requested_status then
      v_before_state:=academy_app.resolve_student_state(v_student_id,v_request.status_effective_date-1);
      v_event_id:='EVT-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
      insert into academy_app.student_timeline_events(event_id,student_id,field_key,field_label,before_value,after_value,effective_date,created_at,request_id,actor_email,event_status,source_system)
      values(v_event_id,v_student_id,'STATUS','상태 변경',v_before_state->>'status',v_request.requested_status,v_request.status_effective_date,now(),v_request.request_id::text,v_email,'완료','SUPABASE');
    end if;
    if v_student.teacher_id is distinct from v_request.teacher_id then
      v_before_state:=academy_app.resolve_student_state(v_student_id,v_request.teacher_effective_date-1);
      v_event_id:='EVT-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
      insert into academy_app.student_timeline_events(event_id,student_id,field_key,field_label,before_value,after_value,reference_id,effective_date,created_at,request_id,actor_email,event_status,source_system)
      values(v_event_id,v_student_id,'TEACHER','담당 원장 변경',v_before_state->>'teacherName',v_request.teacher_name_snapshot,v_request.teacher_id,v_request.teacher_effective_date,now(),v_request.request_id::text,v_email,'완료','SUPABASE');
    end if;
    if coalesce(v_student.tuition_amount,0) is distinct from v_request.tuition_amount then
      v_before_state:=academy_app.resolve_student_state(v_student_id,v_request.fee_effective_date-1);
      v_event_id:='EVT-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
      insert into academy_app.student_timeline_events(event_id,student_id,field_key,field_label,before_value,after_value,effective_date,created_at,request_id,actor_email,event_status,source_system)
      values(v_event_id,v_student_id,'TUITION','수강료 변경',v_before_state->>'tuition',v_request.tuition_amount::text,v_request.fee_effective_date,now(),v_request.request_id::text,v_email,'완료','SUPABASE');
    end if;
    if coalesce(nullif(v_student.course_type,''),'정규') is distinct from v_request.course_type then
      v_before_state:=academy_app.resolve_student_state(v_student_id,current_date-1);
      v_event_id:='EVT-SB-'||upper(replace(gen_random_uuid()::text,'-',''));
      insert into academy_app.student_timeline_events(event_id,student_id,field_key,field_label,before_value,after_value,effective_date,created_at,request_id,actor_email,event_status,source_system)
      values(v_event_id,v_student_id,'COURSE_MODE','수강형태 변경',v_before_state->>'courseType',v_request.course_type,current_date,now(),v_request.request_id::text,v_email,'완료','SUPABASE');
    end if;
    update academy_app.students set
      student_name=v_request.student_name,grade_label=v_request.grade_label,status=v_request.requested_status,
      teacher_id=v_request.teacher_id,teacher_name=v_request.teacher_name_snapshot,
      tuition_text=v_request.tuition_amount::text,tuition_amount=v_request.tuition_amount,
      tuition_reference_day=v_request.tuition_reference_day::text,tuition_reference_day_number=v_request.tuition_reference_day,
      first_lesson_date=to_char(v_request.first_lesson_date,'YYYY-MM-DD'),
      enrollment_date=coalesce(to_char(v_request.original_enrollment_date,'YYYY-MM-DD'),enrollment_date),
      exit_date=case when v_request.requested_status='퇴원' then to_char(v_request.status_effective_date,'YYYY-MM-DD') else null end,
      course_type=v_request.course_type,parent_phone=v_request.parent_phone,version=version+1,updated_at=now(),last_request_id=v_request.request_id
    where student_id=v_student_id returning * into v_student;
    v_after:=to_jsonb(v_student);
    insert into academy_app.student_revisions(student_id,request_id,action,previous_version,new_version,before_data,after_data,actor_auth_user_id,actor_email)
    values(v_student_id,v_request.request_id,'UPDATE',v_request.base_student_version,v_student.version,v_before,v_after,v_uid,v_email);
  end if;
  update academy_app.student_requests set status='APPROVED',processed_at=now(),processed_by_auth_user_id=v_uid,
    processed_by_email=v_email,decision_memo=v_memo,approved_student_id=v_student_id,updated_at=now()
  where request_id=v_request.request_id;
  insert into academy_app.student_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email,details)
  values(v_request.request_id,'APPROVED','PENDING','APPROVED',v_uid,v_email,jsonb_build_object('studentId',v_student_id,'operation',v_request.operation,'memo',v_memo));
  return jsonb_build_object('requestId',v_request.request_id,'status','APPROVED','studentId',v_student_id,'operation',v_request.operation);
end;
$$;

create or replace function public.cancel_my_student_request(p_request_id uuid)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s'
as $$
declare v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));v_request academy_app.student_requests%rowtype;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_request from academy_app.student_requests where request_id=p_request_id for update;
  if not found or v_request.requester_auth_user_id<>v_uid then raise exception using errcode='42501',message='본인이 등록한 학생 요청만 취소할 수 있습니다.'; end if;
  if v_request.status<>'PENDING' then raise exception using errcode='55000',message='승인 대기 상태인 요청만 취소할 수 있습니다.'; end if;
  update academy_app.student_requests set status='CANCELLED',updated_at=now() where request_id=v_request.request_id;
  insert into academy_app.student_request_events(request_id,event_type,from_status,to_status,actor_auth_user_id,actor_email)
  values(v_request.request_id,'CANCELLED','PENDING','CANCELLED',v_uid,v_email);
  return jsonb_build_object('requestId',v_request.request_id,'status','CANCELLED');
end;
$$;

revoke all on function public.submit_student_request(text,text,text,text,text,text,date,date,integer,numeric,text,text,date,date,date,text,uuid) from public,anon;
revoke all on function public.search_my_student_requests(text,integer,integer) from public,anon;
revoke all on function public.get_student_change_form(text) from public,anon;
revoke all on function public.decide_student_request(uuid,text,text) from public,anon;
revoke all on function public.cancel_my_student_request(uuid) from public,anon;
grant execute on function public.submit_student_request(text,text,text,text,text,text,date,date,integer,numeric,text,text,date,date,date,text,uuid) to authenticated;
grant execute on function public.search_my_student_requests(text,integer,integer) to authenticated;
grant execute on function public.get_student_change_form(text) to authenticated;
grant execute on function public.decide_student_request(uuid,text,text) to authenticated;
grant execute on function public.cancel_my_student_request(uuid) to authenticated;

comment on table academy_app.student_requests is 'Typed STUDENT_CREATE and STUDENT_UPDATE approval requests preserving DB_요청 semantics.';
comment on table academy_app.student_revisions is 'Immutable before/after snapshots for approved student writes.';
comment on function public.decide_student_request(uuid,text,text) is 'Atomically approves or rejects a pending student request and records timeline/revision audit rows.';
