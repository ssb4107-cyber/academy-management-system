create table if not exists academy_app.vacation_periods (
  period_id text primary key,
  student_id text not null references academy_app.students(student_id),
  student_name_snapshot text not null,
  start_date date not null,
  end_date date not null,
  vacation_reason text check (vacation_reason is null or char_length(vacation_reason)<=300),
  period_type text not null default '일반휴가' check (period_type in ('일반휴가','퇴원공백')),
  created_at timestamptz not null default now(),
  start_event_id text,
  end_event_id text,
  creation_method text,
  source_run_id uuid,
  source_system text not null default 'GOOGLE_SNAPSHOT' check (source_system in ('GOOGLE_SNAPSHOT','SUPABASE')),
  version integer not null default 1 check (version>=1),
  updated_at timestamptz not null default now(),
  last_request_id uuid,
  deleted_at timestamptz,
  deleted_by_email text,
  delete_reason text check (delete_reason is null or char_length(delete_reason)<=500),
  purge_after date,
  check (start_date<=end_date),
  check ((deleted_at is null and purge_after is null) or (deleted_at is not null and purge_after is not null))
);

truncate table academy_app.vacation_periods;
insert into academy_app.vacation_periods(
  period_id,student_id,student_name_snapshot,start_date,end_date,vacation_reason,
  period_type,created_at,start_event_id,end_event_id,creation_method,source_run_id,
  source_system,version,updated_at
)
select
  btrim(r.record_json->>'휴가ID'),
  btrim(r.record_json->>'학생ID'),
  btrim(r.record_json->>'학생명'),
  case when coalesce(r.record_json->>'시작일','') like '%T%'
    then ((r.record_json->>'시작일')::timestamptz at time zone 'Asia/Seoul')::date
    else left(r.record_json->>'시작일',10)::date end,
  case when coalesce(r.record_json->>'종료일','') like '%T%'
    then ((r.record_json->>'종료일')::timestamptz at time zone 'Asia/Seoul')::date
    else left(r.record_json->>'종료일',10)::date end,
  nullif(btrim(coalesce(r.record_json->>'사유','')),''),
  case when btrim(coalesce(r.record_json->>'기간유형',''))='퇴원공백' then '퇴원공백' else '일반휴가' end,
  case when coalesce(r.record_json->>'등록일시','')='' then r.captured_at
    else (r.record_json->>'등록일시')::timestamptz end,
  nullif(btrim(coalesce(r.record_json->>'시작이벤트ID','')),''),
  nullif(btrim(coalesce(r.record_json->>'종료이벤트ID','')),''),
  nullif(btrim(coalesce(r.record_json->>'생성방식','')),''),
  r.run_id,'GOOGLE_SNAPSHOT',1,now()
from academy_mirror.sheet_rows r
where r.sheet_name='DB_휴가기간' and r.source_row_number>1
  and nullif(btrim(r.record_json->>'휴가ID'),'') is not null
  and nullif(btrim(r.record_json->>'학생ID'),'') is not null;

create index if not exists academy_vacation_periods_student_dates_idx
  on academy_app.vacation_periods(student_id,start_date,end_date)
  where deleted_at is null;
create index if not exists academy_vacation_periods_purge_idx
  on academy_app.vacation_periods(purge_after)
  where deleted_at is not null;

alter table academy_app.vacation_periods enable row level security;
alter table academy_app.vacation_periods force row level security;
revoke all on table academy_app.vacation_periods from public,anon,authenticated;

create policy academy_vacation_scope_read on academy_app.vacation_periods
for select to authenticated
using (exists(
  select 1 from academy_app.students s
  where s.student_id=vacation_periods.student_id
));

grant select on table academy_app.vacation_periods to authenticated;

create or replace function public.get_my_student_vacations(p_student_id text)
returns jsonb
language plpgsql stable security invoker
set search_path=pg_catalog
set statement_timeout='5s'
as $$
declare
  v_uid uuid:=auth.uid();
  v_student academy_app.students%rowtype;
  v_rows jsonb;
begin
  if v_uid is null then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_student from academy_app.students
  where student_id=btrim(coalesce(p_student_id,''));
  if not found then raise exception using errcode='42501',message='학생을 찾을 수 없거나 휴가 조회 권한이 없습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'periodId',v.period_id,'studentId',v.student_id,'studentName',v.student_name_snapshot,
    'startDate',to_char(v.start_date,'YYYY-MM-DD'),'endDate',to_char(v.end_date,'YYYY-MM-DD'),
    'reason',v.vacation_reason,'periodType',v.period_type,'creationMethod',v.creation_method,
    'version',v.version,'canEdit',v.period_type='일반휴가'
  ) order by v.start_date desc,v.period_id desc),'[]'::jsonb)
  into v_rows from academy_app.vacation_periods v
  where v.student_id=v_student.student_id and v.deleted_at is null;
  return jsonb_build_object('studentId',v_student.student_id,'studentName',v_student.student_name,
    'rows',v_rows,'total',jsonb_array_length(v_rows));
end;
$$;

revoke all on function public.get_my_student_vacations(text) from public,anon;
grant execute on function public.get_my_student_vacations(text) to authenticated;

comment on table academy_app.vacation_periods is 'Typed vacation and retirement-gap periods migrated from DB_휴가기간; deleted rows remain recoverable.';
comment on function public.get_my_student_vacations(text) is 'Returns active vacation periods within the caller student scope.';
