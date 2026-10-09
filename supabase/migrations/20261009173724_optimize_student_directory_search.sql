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

  with
  past_event as materialized (
    select distinct on (e.student_id,e.field_key)
      e.student_id,e.field_key,e.after_value,e.reference_id
    from academy_app.student_timeline_events e
    where e.event_status='완료' and e.effective_date<=current_date
    order by e.student_id,e.field_key,e.effective_date desc,e.created_at desc,e.source_row_number desc nulls last
  ),
  first_event as materialized (
    select distinct on (e.student_id,e.field_key)
      e.student_id,e.field_key,e.before_value
    from academy_app.student_timeline_events e
    where e.event_status='완료'
    order by e.student_id,e.field_key,e.created_at,e.source_row_number nulls last
  ),
  event_state as materialized (
    select s.student_id,
      coalesce(ps.after_value,fs.before_value,s.status) as resolved_status,
      coalesce(pt.after_value,ft.before_value,s.teacher_name) as resolved_teacher_name,
      coalesce(pu.after_value,fu.before_value,s.tuition_text,'0') as resolved_tuition_text,
      case
        when coalesce(nullif(pc.after_value,''),nullif(fc.before_value,''),nullif(s.course_type,''),'정규') in ('정규','특강전용')
        then coalesce(nullif(pc.after_value,''),nullif(fc.before_value,''),nullif(s.course_type,''),'정규')
        else '정규'
      end as resolved_course_type,
      exists(
        select 1 from academy_app.student_timeline_events future
        where future.student_id=s.student_id and future.event_status='완료' and future.effective_date>current_date
      ) as has_scheduled_changes
    from academy_app.students s
    left join past_event ps on ps.student_id=s.student_id and ps.field_key='STATUS'
    left join first_event fs on fs.student_id=s.student_id and fs.field_key='STATUS'
    left join past_event pt on pt.student_id=s.student_id and pt.field_key='TEACHER'
    left join first_event ft on ft.student_id=s.student_id and ft.field_key='TEACHER'
    left join past_event pu on pu.student_id=s.student_id and pu.field_key='TUITION'
    left join first_event fu on fu.student_id=s.student_id and fu.field_key='TUITION'
    left join past_event pc on pc.student_id=s.student_id and pc.field_key='COURSE_MODE'
    left join first_event fc on fc.student_id=s.student_id and fc.field_key='COURSE_MODE'
  ),
  filtered as materialized (
    select s.student_id,s.student_name,s.grade_label,
      es.resolved_status,es.resolved_teacher_name,es.resolved_course_type,
      case when es.resolved_course_type='특강전용' then 0
        else coalesce(nullif(regexp_replace(es.resolved_tuition_text,'[^0-9.-]','','g'),''),'0')::numeric
      end as resolved_tuition,
      es.has_scheduled_changes
    from academy_app.students s
    join event_state es on es.student_id=s.student_id
    where (v_status='' or es.resolved_status=v_status)
      and (v_query='' or s.student_name ilike '%'||v_query||'%'
        or coalesce(s.grade_label,'') ilike '%'||v_query||'%')
  )
  select count(*),coalesce((
    select jsonb_agg(jsonb_build_object(
      'studentId',page.student_id,'studentName',page.student_name,
      'gradeLabel',page.grade_label,'status',page.resolved_status,
      'teacherName',page.resolved_teacher_name,'courseType',page.resolved_course_type,
      'tuition',page.resolved_tuition,'hasScheduledChanges',page.has_scheduled_changes
    ) order by page.student_name,page.student_id)
    from (
      select * from filtered
      order by student_name,student_id limit v_limit offset v_offset
    ) page
  ),'[]'::jsonb)
  into v_total,v_rows
  from filtered;

  return jsonb_build_object('rows',v_rows,'total',v_total,'limit',v_limit,'offset',v_offset);
end;
$$;

revoke all on function public.search_my_students(text,text,integer,integer) from public,anon;
grant execute on function public.search_my_students(text,text,integer,integer) to authenticated;

comment on function public.search_my_students(text,text,integer,integer)
is 'Bulk-resolves effective student directory state once per request to avoid repeated per-row timeline scans.';
