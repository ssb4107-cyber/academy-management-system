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

revoke all on function public.get_my_sibling_workspace() from public,anon;
grant execute on function public.get_my_sibling_workspace() to authenticated;
