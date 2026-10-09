-- Student migration foundation: typed teacher directory and effective-date timeline.
-- This preserves the Google model where the student row stores the latest planned
-- value while dated events reconstruct the value that is effective today.

create table if not exists academy_app.teachers (
  teacher_id text primary key,
  teacher_name text not null,
  active boolean not null default false,
  default_distribution_rate numeric(5,2) not null
    check (default_distribution_rate between 0 and 100),
  salary_target boolean not null default false,
  start_date text,
  end_date text,
  memo text,
  source_run_id uuid not null,
  source_updated_at text,
  synced_at timestamptz not null default now()
);

create table if not exists academy_app.student_timeline_events (
  event_id text primary key,
  student_id text not null references academy_app.students(student_id),
  field_key text not null check (field_key in ('STATUS','TEACHER','TUITION','COURSE_MODE','SIBLING_DISCOUNT')),
  field_label text not null,
  before_value text,
  after_value text,
  reference_id text,
  effective_date date not null,
  created_at timestamptz not null,
  request_id text,
  actor_email text,
  event_status text not null,
  source_system text not null default 'GOOGLE_SNAPSHOT'
    check (source_system in ('GOOGLE_SNAPSHOT','SUPABASE')),
  source_row_number integer,
  source_run_id uuid,
  synced_at timestamptz not null default now()
);

alter table academy_app.students
  alter column source_run_id drop not null;

alter table academy_app.students
  add column if not exists source_system text not null default 'GOOGLE_SNAPSHOT',
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_request_id uuid,
  add column if not exists tuition_amount numeric(14,2),
  add column if not exists tuition_reference_day_number integer,
  add column if not exists sibling_discount_amount numeric(14,2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='academy_students_source_system_check'
      and conrelid='academy_app.students'::regclass
  ) then
    alter table academy_app.students
      add constraint academy_students_source_system_check
      check (source_system in ('GOOGLE_SNAPSHOT','SUPABASE'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname='academy_students_version_check'
      and conrelid='academy_app.students'::regclass
  ) then
    alter table academy_app.students
      add constraint academy_students_version_check check (version >= 1);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname='academy_students_reference_day_check'
      and conrelid='academy_app.students'::regclass
  ) then
    alter table academy_app.students
      add constraint academy_students_reference_day_check
      check (tuition_reference_day_number is null or tuition_reference_day_number between 1 and 31);
  end if;
end
$$;

truncate table academy_app.teachers;
insert into academy_app.teachers (
  teacher_id, teacher_name, active, default_distribution_rate, salary_target,
  start_date, end_date, memo, source_run_id, source_updated_at, synced_at
)
select
  btrim(record_json->>'원장ID'),
  btrim(record_json->>'원장명'),
  lower(btrim(record_json->>'활성')) in ('true','1','yes','y','사용','활성'),
  regexp_replace(record_json->>'신규학생 기본배분율','[^0-9.-]','','g')::numeric(5,2),
  lower(btrim(record_json->>'급여정산대상')) in ('true','1','yes','y','사용','활성'),
  nullif(btrim(record_json->>'시작일'),''),
  nullif(btrim(record_json->>'종료일'),''),
  nullif(btrim(record_json->>'메모'),''),
  run_id,
  nullif(btrim(record_json->>'수정일시'),''),
  now()
from academy_mirror.latest_sheet_rows
where sheet_name='DB_원장'
  and source_row_number > 1
  and nullif(btrim(record_json->>'원장ID'),'') is not null;

update academy_app.students
set tuition_amount = coalesce(
      nullif(regexp_replace(coalesce(tuition_text,''),'[^0-9.-]','','g'),'')::numeric(14,2), 0
    ),
    tuition_reference_day_number = case
      when nullif(regexp_replace(coalesce(tuition_reference_day,''),'[^0-9]','','g'),'') is null then null
      else regexp_replace(tuition_reference_day,'[^0-9]','','g')::integer
    end,
    sibling_discount_amount = coalesce(
      nullif(regexp_replace(coalesce(sibling_discount_text,''),'[^0-9.-]','','g'),'')::numeric(14,2), 0
    );

truncate table academy_app.student_timeline_events;
insert into academy_app.student_timeline_events (
  event_id, student_id, field_key, field_label, before_value, after_value,
  reference_id, effective_date, created_at, request_id, actor_email,
  event_status, source_system, source_row_number, source_run_id, synced_at
)
select
  btrim(record_json->>'이벤트ID'),
  btrim(record_json->>'학생ID'),
  case btrim(record_json->>'변경항목')
    when '상태 변경' then 'STATUS'
    when '담당 원장 변경' then 'TEACHER'
    when '담당 강사 변경' then 'TEACHER'
    when '수강료 변경' then 'TUITION'
    when '수강형태 변경' then 'COURSE_MODE'
    when '수강 형태 변경' then 'COURSE_MODE'
    when '형제할인액' then 'SIBLING_DISCOUNT'
    when '형제 할인 변경' then 'SIBLING_DISCOUNT'
    when '형제할인액 변경' then 'SIBLING_DISCOUNT'
  end,
  btrim(record_json->>'변경항목'),
  nullif(btrim(record_json->>'변경전'),''),
  nullif(btrim(record_json->>'변경후'),''),
  nullif(btrim(record_json->>'참조ID'),''),
  left(btrim(record_json->>'적용일'),10)::date,
  (btrim(record_json->>'생성일시'))::timestamptz,
  nullif(btrim(record_json->>'요청ID'),''),
  nullif(lower(btrim(record_json->>'작업자이메일')),''),
  btrim(record_json->>'처리상태'),
  'GOOGLE_SNAPSHOT',
  source_row_number,
  run_id,
  now()
from academy_mirror.latest_sheet_rows
where sheet_name='DB_이벤트'
  and source_row_number > 1
  and btrim(record_json->>'처리상태')='완료'
  and nullif(btrim(record_json->>'이벤트ID'),'') is not null
  and nullif(btrim(record_json->>'학생ID'),'') is not null
  and btrim(record_json->>'변경항목') in (
    '상태 변경','담당 원장 변경','담당 강사 변경','수강료 변경',
    '수강형태 변경','수강 형태 변경','형제할인액','형제 할인 변경','형제할인액 변경'
  );

create index if not exists academy_teachers_active_name_idx
  on academy_app.teachers (active, teacher_name);
create index if not exists academy_student_timeline_lookup_idx
  on academy_app.student_timeline_events (
    student_id, field_key, effective_date desc, created_at desc, source_row_number desc
  );
create index if not exists academy_student_timeline_future_idx
  on academy_app.student_timeline_events (effective_date, student_id)
  where event_status='완료';

alter table academy_app.teachers enable row level security;
alter table academy_app.teachers force row level security;
alter table academy_app.student_timeline_events enable row level security;
alter table academy_app.student_timeline_events force row level security;
revoke all on table academy_app.teachers from public, anon, authenticated;
revoke all on table academy_app.student_timeline_events from public, anon, authenticated;

drop policy if exists academy_teacher_authorized_read on academy_app.teachers;
create policy academy_teacher_authorized_read
on academy_app.teachers
for select
to authenticated
using (
  exists (
    select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role in ('SUPER_ADMIN','MANAGER')
  )
);

drop policy if exists academy_student_timeline_scope_read on academy_app.student_timeline_events;
create policy academy_student_timeline_scope_read
on academy_app.student_timeline_events
for select
to authenticated
using (
  exists (
    select 1 from academy_app.students s
    where s.student_id=student_timeline_events.student_id
  )
);

grant select on table academy_app.teachers to authenticated;
grant select on table academy_app.student_timeline_events to authenticated;

create or replace function academy_app.resolve_student_state(
  p_student_id text,
  p_as_of date default current_date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_student academy_app.students%rowtype;
  v_as_of date := coalesce(p_as_of,current_date);
  v_status text;
  v_teacher_name text;
  v_teacher_id text;
  v_tuition text;
  v_course_mode text;
  v_discount text;
  v_event academy_app.student_timeline_events%rowtype;
begin
  select * into v_student
  from academy_app.students
  where student_id=btrim(coalesce(p_student_id,''));
  if not found then return null; end if;

  select * into v_event
  from academy_app.student_timeline_events
  where student_id=v_student.student_id and field_key='STATUS'
    and event_status='완료' and effective_date <= v_as_of
  order by effective_date desc, created_at desc, source_row_number desc nulls last
  limit 1;
  if found then v_status := v_event.after_value;
  else
    select before_value into v_status
    from academy_app.student_timeline_events
    where student_id=v_student.student_id and field_key='STATUS' and event_status='완료'
    order by created_at, source_row_number nulls last limit 1;
    v_status := coalesce(v_status,v_student.status);
  end if;

  select * into v_event
  from academy_app.student_timeline_events
  where student_id=v_student.student_id and field_key='TEACHER'
    and event_status='완료' and effective_date <= v_as_of
  order by effective_date desc, created_at desc, source_row_number desc nulls last
  limit 1;
  if found then
    v_teacher_name := v_event.after_value;
    v_teacher_id := nullif(v_event.reference_id,'');
  else
    select before_value into v_teacher_name
    from academy_app.student_timeline_events
    where student_id=v_student.student_id and field_key='TEACHER' and event_status='완료'
    order by created_at, source_row_number nulls last limit 1;
    v_teacher_name := coalesce(v_teacher_name,v_student.teacher_name);
  end if;
  if v_teacher_id is null then
    if v_teacher_name is not distinct from v_student.teacher_name then
      v_teacher_id := v_student.teacher_id;
    end if;
    if v_teacher_id is null then
      select teacher_id into v_teacher_id from academy_app.teachers
      where teacher_name=v_teacher_name order by active desc,teacher_id limit 1;
    end if;
  end if;

  select * into v_event
  from academy_app.student_timeline_events
  where student_id=v_student.student_id and field_key='TUITION'
    and event_status='완료' and effective_date <= v_as_of
  order by effective_date desc, created_at desc, source_row_number desc nulls last
  limit 1;
  if found then v_tuition := v_event.after_value;
  else
    select before_value into v_tuition
    from academy_app.student_timeline_events
    where student_id=v_student.student_id and field_key='TUITION' and event_status='완료'
    order by created_at, source_row_number nulls last limit 1;
    v_tuition := coalesce(v_tuition,v_student.tuition_text,'0');
  end if;

  select * into v_event
  from academy_app.student_timeline_events
  where student_id=v_student.student_id and field_key='COURSE_MODE'
    and event_status='완료' and effective_date <= v_as_of
  order by effective_date desc, created_at desc, source_row_number desc nulls last
  limit 1;
  if found then v_course_mode := v_event.after_value;
  else
    select before_value into v_course_mode
    from academy_app.student_timeline_events
    where student_id=v_student.student_id and field_key='COURSE_MODE' and event_status='완료'
    order by created_at, source_row_number nulls last limit 1;
    v_course_mode := coalesce(nullif(v_course_mode,''),nullif(v_student.course_type,''),'정규');
  end if;
  if v_course_mode not in ('정규','특강전용') then v_course_mode := '정규'; end if;

  select * into v_event
  from academy_app.student_timeline_events
  where student_id=v_student.student_id and field_key='SIBLING_DISCOUNT'
    and event_status='완료' and effective_date <= v_as_of
  order by effective_date desc, created_at desc, source_row_number desc nulls last
  limit 1;
  if found then v_discount := v_event.after_value;
  else
    select before_value into v_discount
    from academy_app.student_timeline_events
    where student_id=v_student.student_id and field_key='SIBLING_DISCOUNT' and event_status='완료'
    order by created_at, source_row_number nulls last limit 1;
    v_discount := coalesce(v_discount,v_student.sibling_discount_text,'0');
  end if;

  return jsonb_build_object(
    'status',coalesce(v_status,v_student.status),
    'teacherId',v_teacher_id,
    'teacherName',coalesce(v_teacher_name,v_student.teacher_name),
    'tuition',case when v_course_mode='특강전용' then 0 else coalesce(nullif(regexp_replace(v_tuition,'[^0-9.-]','','g'),''),'0')::numeric end,
    'courseType',v_course_mode,
    'siblingDiscount',coalesce(nullif(regexp_replace(v_discount,'[^0-9.-]','','g'),''),'0')::numeric
  );
end;
$$;

grant execute on function academy_app.resolve_student_state(text,date) to authenticated;

create or replace function public.get_student_reference_data()
returns jsonb
language plpgsql
stable
security invoker
set search_path=pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_user academy_app.user_access%rowtype;
  v_teachers jsonb;
begin
  if v_uid is null or v_email='' then
    raise exception using errcode='42501',message='로그인이 필요합니다.';
  end if;
  select * into v_user from academy_app.user_access
  where email=v_email and active=true;
  if not found then
    raise exception using errcode='42501',message='학생 관리 권한이 없습니다.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'teacherId',teacher_id,'teacherName',teacher_name,
    'active',active,'defaultRate',default_distribution_rate
  ) order by active desc,teacher_name),'[]'::jsonb)
  into v_teachers from academy_app.teachers;
  return jsonb_build_object(
    'teachers',v_teachers,
    'canAdd',v_user.role='SUPER_ADMIN' or array_to_string(v_user.permissions,',') ~* '(^|,)[[:space:]]*STUDENT_ADD[[:space:]]*(,|$)',
    'canEdit',v_user.role='SUPER_ADMIN' or array_to_string(v_user.permissions,',') ~* '(^|,)[[:space:]]*STUDENT_EDIT[[:space:]]*(,|$)',
    'linkedTeacherId',v_user.teacher_id,
    'studentScope',v_user.student_scope
  );
end;
$$;

create or replace function public.search_my_students(
  p_query text default null,
  p_status text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_query text := btrim(coalesce(p_query,''));
  v_status text := btrim(coalesce(p_status,''));
  v_limit integer := least(greatest(coalesce(p_limit,100),1),200);
  v_offset integer := greatest(coalesce(p_offset,0),0);
  v_total bigint;
  v_rows jsonb;
begin
  if v_uid is null or v_email='' then
    raise exception using errcode='42501',message='로그인이 필요합니다.';
  end if;
  if not exists (select 1 from academy_app.user_access where email=v_email and active=true) then
    raise exception using errcode='42501',message='학생 조회 권한이 없습니다.';
  end if;

  select count(*) into v_total
  from academy_app.students s
  cross join lateral academy_app.resolve_student_state(s.student_id,current_date) st
  where (v_status='' or st->>'status'=v_status)
    and (v_query='' or s.student_name ilike '%'||v_query||'%'
      or coalesce(s.grade_label,'') ilike '%'||v_query||'%');

  select coalesce(jsonb_agg(item order by sort_name,sort_id),'[]'::jsonb)
  into v_rows
  from (
    select jsonb_build_object(
      'studentId',s.student_id,'studentName',s.student_name,
      'gradeLabel',s.grade_label,'status',st->>'status',
      'teacherName',st->>'teacherName','courseType',st->>'courseType',
      'tuition',st->'tuition',
      'hasScheduledChanges',exists(
        select 1 from academy_app.student_timeline_events e
        where e.student_id=s.student_id and e.event_status='완료' and e.effective_date>current_date
      )
    ) item,s.student_name sort_name,s.student_id sort_id
    from academy_app.students s
    cross join lateral academy_app.resolve_student_state(s.student_id,current_date) st
    where (v_status='' or st->>'status'=v_status)
      and (v_query='' or s.student_name ilike '%'||v_query||'%'
        or coalesce(s.grade_label,'') ilike '%'||v_query||'%')
    order by s.student_name,s.student_id
    limit v_limit offset v_offset
  ) q;
  return jsonb_build_object('rows',v_rows,'total',v_total,'limit',v_limit,'offset',v_offset);
end;
$$;

create or replace function public.get_my_student(p_student_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_student academy_app.students%rowtype;
  v_state jsonb;
  v_future jsonb;
begin
  if v_uid is null or v_email='' then
    raise exception using errcode='42501',message='로그인이 필요합니다.';
  end if;
  select * into v_student from academy_app.students
  where student_id=btrim(coalesce(p_student_id,''));
  if not found then
    raise exception using errcode='42501',message='학생을 찾을 수 없거나 조회 권한이 없습니다.';
  end if;
  v_state := academy_app.resolve_student_state(v_student.student_id,current_date);
  select coalesce(jsonb_agg(jsonb_build_object(
    'effectiveDate',to_char(effective_date,'YYYY-MM-DD'),
    'field',field_label,'before',before_value,'after',after_value
  ) order by effective_date,created_at,source_row_number),'[]'::jsonb)
  into v_future
  from academy_app.student_timeline_events
  where student_id=v_student.student_id and event_status='완료' and effective_date>current_date;

  return jsonb_build_object(
    'studentId',v_student.student_id,'studentName',v_student.student_name,
    'gradeLabel',v_student.grade_label,'status',v_state->>'status',
    'teacherName',v_state->>'teacherName','teacherId',v_state->>'teacherId',
    'tuition',v_state->'tuition','tuitionReferenceDay',v_student.tuition_reference_day,
    'enrollmentDate',v_student.enrollment_date,'firstLessonDate',v_student.first_lesson_date,
    'exitDate',v_student.exit_date,'courseType',v_state->>'courseType',
    'parentPhone',v_student.parent_phone,'cashReceiptNumber',v_student.cash_receipt_number,
    'payerName',v_student.payer_name,'siblingGroupName',v_student.sibling_group_name,
    'siblingDiscount',v_state->'siblingDiscount','futureChanges',v_future,
    'version',v_student.version
  );
end;
$$;

revoke all on function public.get_student_reference_data() from public,anon;
grant execute on function public.get_student_reference_data() to authenticated;

comment on table academy_app.teachers is 'Typed mirror of DB_원장 used as the authoritative teacher reference for student requests.';
comment on table academy_app.student_timeline_events is 'Effective-dated student changes migrated from DB_이벤트 and later extended by Supabase approvals.';
comment on function academy_app.resolve_student_state(text,date) is 'Reconstructs status, teacher, tuition, course mode, and sibling discount at an effective date.';
