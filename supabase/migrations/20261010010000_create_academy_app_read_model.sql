-- Private typed read model derived from the already-imported academy_mirror snapshot.
create schema if not exists academy_app;
revoke all on schema academy_app from public, anon, authenticated;

create table if not exists academy_app.user_access (
  user_key text primary key,
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('SUPER_ADMIN', 'MANAGER')),
  active boolean not null default false,
  permissions text[] not null default '{}'::text[],
  teacher_id text,
  student_scope text not null check (student_scope in ('NONE', 'LINKED_TEACHER', 'ALL_STUDENTS')),
  source_run_id uuid not null,
  source_updated_at text,
  synced_at timestamptz not null default now(),
  check (email = lower(btrim(email)) and email like '%@%')
);

create table if not exists academy_app.students (
  student_id text primary key,
  student_name text not null,
  grade_label text,
  status text not null,
  teacher_id text,
  teacher_name text,
  tuition_text text,
  tuition_reference_day text,
  enrollment_date text,
  first_lesson_date text,
  exit_date text,
  course_type text,
  parent_phone text,
  cash_receipt_number text,
  payer_name text,
  sibling_group_id text,
  sibling_group_name text,
  sibling_discount_text text,
  distribution_rate_text text,
  last_tuition_change_date text,
  source_run_id uuid not null,
  synced_at timestamptz not null default now()
);

alter table academy_app.user_access enable row level security;
alter table academy_app.students enable row level security;
alter table academy_app.user_access force row level security;
alter table academy_app.students force row level security;

revoke all on all tables in schema academy_app from public, anon, authenticated;
revoke all on all sequences in schema academy_app from public, anon, authenticated;
alter default privileges in schema academy_app revoke all on tables from public, anon, authenticated;
alter default privileges in schema academy_app revoke all on sequences from public, anon, authenticated;
alter default privileges in schema academy_app revoke execute on functions from public, anon, authenticated;

truncate table academy_app.user_access;
insert into academy_app.user_access (
  user_key, email, display_name, role, active, permissions, teacher_id,
  student_scope, source_run_id, source_updated_at, synced_at
)
select
  coalesce(nullif(btrim(record_json->>'사용자ID'), ''), lower(btrim(record_json->>'이메일'))),
  lower(btrim(record_json->>'이메일')),
  coalesce(nullif(btrim(record_json->>'표시명'), ''), lower(btrim(record_json->>'이메일'))),
  btrim(record_json->>'역할'),
  lower(btrim(record_json->>'활성')) in ('true', '1', 'yes', 'y', '사용', '활성'),
  case
    when nullif(btrim(record_json->>'추가권한'), '') is null then '{}'::text[]
    else regexp_split_to_array(upper(btrim(record_json->>'추가권한')), '\s*,\s*')
  end,
  nullif(btrim(record_json->>'연결원장ID'), ''),
  case
    when btrim(record_json->>'역할') = 'SUPER_ADMIN' then 'ALL_STUDENTS'
    when upper(btrim(record_json->>'학생접근범위')) in ('NONE', 'LINKED_TEACHER', 'ALL_STUDENTS')
      then upper(btrim(record_json->>'학생접근범위'))
    else 'NONE'
  end,
  run_id,
  nullif(btrim(record_json->>'수정일시'), ''),
  now()
from academy_mirror.latest_sheet_rows
where sheet_name = 'DB_사용자'
  and source_row_number > 1
  and nullif(btrim(record_json->>'이메일'), '') is not null;

truncate table academy_app.students;
insert into academy_app.students (
  student_id, student_name, grade_label, status, teacher_id, teacher_name,
  tuition_text, tuition_reference_day, enrollment_date, first_lesson_date,
  exit_date, course_type, parent_phone, cash_receipt_number, payer_name,
  sibling_group_id, sibling_group_name, sibling_discount_text,
  distribution_rate_text, last_tuition_change_date, source_run_id, synced_at
)
select
  btrim(record_json->>'학생ID'),
  btrim(record_json->>'학생명'),
  nullif(btrim(record_json->>'학번/학년'), ''),
  coalesce(nullif(btrim(record_json->>'상태'), ''), '미지정'),
  nullif(btrim(record_json->>'담당원장ID'), ''),
  nullif(btrim(record_json->>'담당 강사'), ''),
  nullif(btrim(record_json->>'수강료'), ''),
  nullif(btrim(record_json->>'수강료 기준일'), ''),
  nullif(btrim(record_json->>'최초입학일'), ''),
  nullif(btrim(record_json->>'첫 수업일'), ''),
  nullif(btrim(record_json->>'퇴원일'), ''),
  nullif(btrim(record_json->>'수강형태'), ''),
  nullif(btrim(record_json->>'부모님 전화번호'), ''),
  nullif(btrim(record_json->>'현금영수증번호'), ''),
  nullif(btrim(record_json->>'입금자명'), ''),
  nullif(btrim(record_json->>'형제그룹ID'), ''),
  nullif(btrim(record_json->>'형제그룹명'), ''),
  nullif(btrim(record_json->>'형제할인액'), ''),
  nullif(btrim(record_json->>'배분률'), ''),
  nullif(btrim(record_json->>'최근 수강료 변경일'), ''),
  run_id,
  now()
from academy_mirror.latest_sheet_rows
where sheet_name = 'DB_명단'
  and source_row_number > 1
  and nullif(btrim(record_json->>'학생ID'), '') is not null;

create index if not exists academy_students_scope_idx
  on academy_app.students (teacher_id, status, student_name);
create index if not exists academy_students_name_idx
  on academy_app.students (lower(student_name));

create or replace function public.get_my_academy_session()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_user academy_app.user_access%rowtype;
  v_student_count bigint;
  v_synced_at timestamptz;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;

  select * into v_user
  from academy_app.user_access
  where email = v_email and active = true;

  if not found or v_user.role not in ('SUPER_ADMIN', 'MANAGER') then
    raise exception using errcode = '42501', message = '등록된 활성 사용자가 아닙니다.';
  end if;

  select count(*), max(synced_at)
  into v_student_count, v_synced_at
  from academy_app.students s
  where v_user.student_scope = 'ALL_STUDENTS'
     or (v_user.student_scope = 'LINKED_TEACHER' and s.teacher_id = v_user.teacher_id);

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'email', v_user.email,
      'displayName', v_user.display_name,
      'role', v_user.role,
      'permissions', to_jsonb(v_user.permissions),
      'teacherId', v_user.teacher_id,
      'studentScope', v_user.student_scope
    ),
    'studentCount', v_student_count,
    'syncedAt', v_synced_at
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
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_user academy_app.user_access%rowtype;
  v_query text := btrim(coalesce(p_query, ''));
  v_status text := btrim(coalesce(p_status, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;

  select * into v_user
  from academy_app.user_access
  where email = v_email and active = true;

  if not found or v_user.role not in ('SUPER_ADMIN', 'MANAGER') then
    raise exception using errcode = '42501', message = '학생 조회 권한이 없습니다.';
  end if;

  select count(*) into v_total
  from academy_app.students s
  where (v_user.student_scope = 'ALL_STUDENTS'
      or (v_user.student_scope = 'LINKED_TEACHER' and s.teacher_id = v_user.teacher_id))
    and (v_status = '' or s.status = v_status)
    and (v_query = '' or s.student_name ilike '%' || v_query || '%'
      or coalesce(s.grade_label, '') ilike '%' || v_query || '%');

  select coalesce(jsonb_agg(item order by sort_name, sort_id), '[]'::jsonb)
  into v_rows
  from (
    select
      jsonb_build_object(
        'studentId', s.student_id,
        'studentName', s.student_name,
        'gradeLabel', s.grade_label,
        'status', s.status,
        'teacherName', s.teacher_name,
        'courseType', s.course_type,
        'tuition', s.tuition_text
      ) as item,
      s.student_name as sort_name,
      s.student_id as sort_id
    from academy_app.students s
    where (v_user.student_scope = 'ALL_STUDENTS'
        or (v_user.student_scope = 'LINKED_TEACHER' and s.teacher_id = v_user.teacher_id))
      and (v_status = '' or s.status = v_status)
      and (v_query = '' or s.student_name ilike '%' || v_query || '%'
        or coalesce(s.grade_label, '') ilike '%' || v_query || '%')
    order by s.student_name, s.student_id
    limit v_limit offset v_offset
  ) q;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

create or replace function public.get_my_student(p_student_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_user academy_app.user_access%rowtype;
  v_result jsonb;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;

  select * into v_user
  from academy_app.user_access
  where email = v_email and active = true;

  if not found or v_user.role not in ('SUPER_ADMIN', 'MANAGER') then
    raise exception using errcode = '42501', message = '학생 상세 조회 권한이 없습니다.';
  end if;

  select jsonb_build_object(
    'studentId', s.student_id,
    'studentName', s.student_name,
    'gradeLabel', s.grade_label,
    'status', s.status,
    'teacherName', s.teacher_name,
    'tuition', s.tuition_text,
    'tuitionReferenceDay', s.tuition_reference_day,
    'enrollmentDate', s.enrollment_date,
    'firstLessonDate', s.first_lesson_date,
    'exitDate', s.exit_date,
    'courseType', s.course_type,
    'parentPhone', s.parent_phone,
    'cashReceiptNumber', s.cash_receipt_number,
    'payerName', s.payer_name,
    'siblingGroupName', s.sibling_group_name,
    'siblingDiscount', s.sibling_discount_text
  ) into v_result
  from academy_app.students s
  where s.student_id = btrim(coalesce(p_student_id, ''))
    and (v_user.student_scope = 'ALL_STUDENTS'
      or (v_user.student_scope = 'LINKED_TEACHER' and s.teacher_id = v_user.teacher_id));

  if v_result is null then
    raise exception using errcode = '42501', message = '학생을 찾을 수 없거나 조회 권한이 없습니다.';
  end if;
  return v_result;
end;
$$;

revoke all on function public.get_my_academy_session() from public, anon;
revoke all on function public.search_my_students(text, text, integer, integer) from public, anon;
revoke all on function public.get_my_student(text) from public, anon;
grant execute on function public.get_my_academy_session() to authenticated;
grant execute on function public.search_my_students(text, text, integer, integer) to authenticated;
grant execute on function public.get_my_student(text) to authenticated;

comment on schema academy_app is 'Private typed read model derived from academy_mirror; never expose directly through the Data API.';
comment on function public.get_my_academy_session() is 'Returns the signed-in allowlisted user profile and authorized student count.';
comment on function public.search_my_students(text, text, integer, integer) is 'Returns an access-scoped, paginated student list.';
comment on function public.get_my_student(text) is 'Returns one access-scoped student detail record.';
