-- Cash-receipt target management. The Google sheet model is intentionally
-- preserved: the receipt number and payer name remain properties of a student.

create table if not exists academy_app.cash_receipt_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  student_id text not null references academy_app.students(student_id),
  action text not null check (action in ('ADD','UPDATE','REMOVE')),
  previous_version integer not null,
  new_version integer not null,
  before_receipt_number text,
  after_receipt_number text,
  before_payer_name text,
  after_payer_name text,
  actor_auth_user_id uuid not null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  check (new_version = previous_version + 1)
);

create index if not exists academy_cash_receipt_revisions_student_idx
  on academy_app.cash_receipt_revisions (student_id, created_at desc);

alter table academy_app.cash_receipt_revisions enable row level security;
alter table academy_app.cash_receipt_revisions force row level security;
revoke all on table academy_app.cash_receipt_revisions from public, anon, authenticated;

create policy academy_cash_receipt_revision_admin_read
on academy_app.cash_receipt_revisions
for select
to authenticated
using (
  exists (
    select 1
    from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
);

create policy academy_cash_receipt_revision_admin_insert
on academy_app.cash_receipt_revisions
for insert
to authenticated
with check (
  actor_auth_user_id = (select auth.uid())
  and actor_email = lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists (
    select 1
    from academy_app.user_access u
    where u.email = actor_email
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
);

grant select, insert on table academy_app.cash_receipt_revisions to authenticated;

create or replace function public.get_cash_receipt_workspace()
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_targets jsonb;
  v_active_students jsonb;
  v_revisions jsonb;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;
  if not exists (
    select 1 from academy_app.user_access u
    where u.email = v_email and u.active = true and u.role = 'SUPER_ADMIN'
  ) then
    raise exception using errcode = '42501', message = '최고 관리자만 현금영수증 명단을 관리할 수 있습니다.';
  end if;

  with resolved as materialized (
    select s.*, academy_app.resolve_student_state(s.student_id, current_date) as current_state
    from academy_app.students s
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'studentId', student_id,
        'studentName', student_name,
        'gradeLabel', grade_label,
        'status', current_state->>'status',
        'baseDay', tuition_reference_day_number,
        'parentPhone', parent_phone,
        'receiptNumber', cash_receipt_number,
        'payerName', payer_name,
        'version', version
      ) order by student_name, student_id
    ) filter (where nullif(btrim(cash_receipt_number),'') is not null), '[]'::jsonb),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'studentId', student_id,
        'studentName', student_name,
        'gradeLabel', grade_label,
        'parentPhone', parent_phone,
        'payerName', payer_name,
        'version', version
      ) order by student_name, student_id
    ) filter (where current_state->>'status' = '재원'), '[]'::jsonb)
  into v_targets, v_active_students
  from resolved;

  select coalesce(jsonb_agg(item order by sort_created desc, sort_id desc), '[]'::jsonb)
  into v_revisions
  from (
    select jsonb_build_object(
      'revisionId', r.revision_id,
      'studentId', r.student_id,
      'studentName', s.student_name,
      'action', r.action,
      'beforeReceiptNumber', r.before_receipt_number,
      'afterReceiptNumber', r.after_receipt_number,
      'beforePayerName', r.before_payer_name,
      'afterPayerName', r.after_payer_name,
      'actorEmail', r.actor_email,
      'createdAt', to_char(r.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI')
    ) as item, r.created_at as sort_created, r.revision_id as sort_id
    from academy_app.cash_receipt_revisions r
    join academy_app.students s on s.student_id = r.student_id
    order by r.created_at desc, r.revision_id desc
    limit 30
  ) recent;

  return jsonb_build_object(
    'receiptList', v_targets,
    'allStudents', v_active_students,
    'recentChanges', v_revisions,
    'targetCount', jsonb_array_length(v_targets),
    'activeStudentCount', jsonb_array_length(v_active_students)
  );
end;
$$;

create or replace function public.update_cash_receipt_target(
  p_student_id text,
  p_receipt_number text,
  p_payer_name text default null,
  p_is_delete boolean default false,
  p_expected_version integer default null
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
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_student academy_app.students%rowtype;
  v_state jsonb;
  v_student_id text := btrim(coalesce(p_student_id,''));
  v_receipt_number text := nullif(btrim(coalesce(p_receipt_number,'')),'');
  v_payer_name text := nullif(btrim(coalesce(p_payer_name,'')),'');
  v_action text;
  v_before_version integer;
  v_before_receipt_number text;
  v_before_payer_name text;
begin
  if v_uid is null or v_email = '' then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;
  if not exists (
    select 1 from academy_app.user_access u
    where u.email = v_email and u.active = true and u.role = 'SUPER_ADMIN'
  ) then
    raise exception using errcode = '42501', message = '최고 관리자만 현금영수증 명단을 변경할 수 있습니다.';
  end if;
  if v_student_id = '' then
    raise exception using errcode = '22023', message = '학생을 선택해주세요.';
  end if;
  if not coalesce(p_is_delete,false) and v_receipt_number is null then
    raise exception using errcode = '22023', message = '현금영수증 발급용 번호를 입력해주세요.';
  end if;
  if char_length(coalesce(v_receipt_number,'')) > 30 then
    raise exception using errcode = '22023', message = '현금영수증 번호는 30자 이내여야 합니다.';
  end if;
  if char_length(coalesce(v_payer_name,'')) > 40 then
    raise exception using errcode = '22023', message = '입금자명은 40자 이내여야 합니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_student_id, 827341));
  select * into v_student
  from academy_app.students
  where student_id = v_student_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '학생을 찾을 수 없습니다.';
  end if;
  if p_expected_version is not null and v_student.version <> p_expected_version then
    raise exception using errcode = '40001', message = '다른 화면에서 학생 정보가 변경되었습니다. 명단을 새로고침한 뒤 다시 저장해주세요.';
  end if;

  if not coalesce(p_is_delete,false) then
    v_state := academy_app.resolve_student_state(v_student.student_id, current_date);
    if v_state->>'status' <> '재원' then
      raise exception using errcode = '55000', message = '현재 재원 중인 학생만 현금영수증 대상에 추가할 수 있습니다.';
    end if;
  else
    v_receipt_number := null;
    v_payer_name := null;
  end if;

  if v_student.cash_receipt_number is not distinct from v_receipt_number
     and v_student.payer_name is not distinct from v_payer_name then
    return jsonb_build_object(
      'studentId', v_student.student_id,
      'version', v_student.version,
      'unchanged', true,
      'action', case when coalesce(p_is_delete,false) then 'REMOVE' else 'UPDATE' end
    );
  end if;

  v_action := case
    when coalesce(p_is_delete,false) then 'REMOVE'
    when nullif(btrim(coalesce(v_student.cash_receipt_number,'')),'') is null then 'ADD'
    else 'UPDATE'
  end;
  v_before_version := v_student.version;
  v_before_receipt_number := v_student.cash_receipt_number;
  v_before_payer_name := v_student.payer_name;

  update academy_app.students
  set cash_receipt_number = v_receipt_number,
      payer_name = v_payer_name,
      source_system = 'SUPABASE',
      version = version + 1,
      updated_at = now()
  where student_id = v_student.student_id
  returning * into v_student;

  insert into academy_app.cash_receipt_revisions (
    student_id, action, previous_version, new_version,
    before_receipt_number, after_receipt_number,
    before_payer_name, after_payer_name,
    actor_auth_user_id, actor_email
  ) values (
    v_student.student_id, v_action, v_before_version, v_student.version,
    v_before_receipt_number,
    v_receipt_number,
    v_before_payer_name,
    v_payer_name,
    v_uid, v_email
  );

  return jsonb_build_object(
    'studentId', v_student.student_id,
    'version', v_student.version,
    'unchanged', false,
    'action', v_action
  );
end;
$$;

revoke all on function public.get_cash_receipt_workspace() from public, anon;
revoke all on function public.update_cash_receipt_target(text,text,text,boolean,integer) from public, anon;
grant execute on function public.get_cash_receipt_workspace() to authenticated;
grant execute on function public.update_cash_receipt_target(text,text,text,boolean,integer) to authenticated;

comment on table academy_app.cash_receipt_revisions is
  'Immutable before/after audit history for direct super-admin cash-receipt target changes.';
comment on function public.get_cash_receipt_workspace() is
  'Returns the super-admin-only cash-receipt target list, active students, and recent changes.';
comment on function public.update_cash_receipt_target(text,text,text,boolean,integer) is
  'Atomically adds, edits, or removes a student cash-receipt target with optimistic locking.';
