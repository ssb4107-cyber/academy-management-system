-- Supabase-native teacher directory management.
-- Keeps the imported Google teacher IDs intact while adding guarded operational writes,
-- optimistic concurrency, idempotency and an immutable audit trail.

alter table academy_app.teachers
  alter column source_run_id drop not null,
  add column if not exists source_system text not null default 'GOOGLE_SNAPSHOT',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists version integer not null default 1,
  add column if not exists last_request_id uuid;

update academy_app.teachers
set created_at=coalesce(created_at,synced_at),
    updated_at=coalesce(updated_at,synced_at),
    updated_by=coalesce(updated_by,'google-import'),
    source_system=coalesce(nullif(source_system,''),'GOOGLE_SNAPSHOT'),
    version=greatest(coalesce(version,1),1);

alter table academy_app.teachers
  drop constraint if exists academy_teachers_rate_check,
  drop constraint if exists academy_teachers_version_check;
alter table academy_app.teachers
  add constraint academy_teachers_rate_check
    check (default_distribution_rate between 0 and 100),
  add constraint academy_teachers_version_check check (version >= 1);

create unique index if not exists academy_teachers_normalized_name_uq
  on academy_app.teachers (lower(btrim(teacher_name)));

create table if not exists academy_app.teacher_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  teacher_id text not null references academy_app.teachers(teacher_id),
  action text not null check (action in ('CREATE','UPDATE')),
  before_data jsonb,
  after_data jsonb not null,
  memo text,
  actor_email text not null,
  request_id uuid not null unique,
  created_at timestamptz not null default now()
);

create table if not exists academy_app.teacher_operation_requests (
  request_id uuid primary key,
  operation text not null check (operation='SAVE'),
  actor_email text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists academy_teacher_revisions_teacher_created_idx
  on academy_app.teacher_revisions (teacher_id,created_at desc);

alter table academy_app.teacher_revisions enable row level security;
alter table academy_app.teacher_revisions force row level security;
alter table academy_app.teacher_operation_requests enable row level security;
alter table academy_app.teacher_operation_requests force row level security;

revoke all on table academy_app.teacher_revisions from public,anon,authenticated;
revoke all on table academy_app.teacher_operation_requests from public,anon,authenticated;

create or replace function academy_app.is_super_admin()
returns boolean language sql stable security definer
set search_path=pg_catalog as $$
  select exists(select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce(auth.jwt()->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN')
$$;
revoke all on function academy_app.is_super_admin() from public,anon;
grant execute on function academy_app.is_super_admin() to authenticated;

drop policy if exists academy_user_admin_read on academy_app.user_access;
create policy academy_user_admin_read on academy_app.user_access
for select to authenticated using (
  (select academy_app.is_super_admin())
);

drop policy if exists academy_teacher_admin_insert on academy_app.teachers;
create policy academy_teacher_admin_insert on academy_app.teachers
for insert to authenticated with check (
  exists(select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN')
);

drop policy if exists academy_teacher_admin_update on academy_app.teachers;
create policy academy_teacher_admin_update on academy_app.teachers
for update to authenticated using (
  exists(select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN')
) with check (
  exists(select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN')
);

create policy academy_teacher_revision_admin_read on academy_app.teacher_revisions
for select to authenticated using (
  exists(select 1 from academy_app.user_access u
    where u.email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
      and u.active=true and u.role='SUPER_ADMIN')
);
create policy academy_teacher_revision_admin_insert on academy_app.teacher_revisions
for insert to authenticated with check (
  actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.user_access u
    where u.email=actor_email and u.active=true and u.role='SUPER_ADMIN')
);
create policy academy_teacher_operation_admin_read on academy_app.teacher_operation_requests
for select to authenticated using (
  actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.user_access u
    where u.email=actor_email and u.active=true and u.role='SUPER_ADMIN')
);
create policy academy_teacher_operation_admin_insert on academy_app.teacher_operation_requests
for insert to authenticated with check (
  actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(select 1 from academy_app.user_access u
    where u.email=actor_email and u.active=true and u.role='SUPER_ADMIN')
);

grant select,insert,update on table academy_app.teachers to authenticated;
grant select,insert on table academy_app.teacher_revisions to authenticated;
grant select,insert on table academy_app.teacher_operation_requests to authenticated;

create or replace function academy_app.teacher_admin_email()
returns text language plpgsql stable security invoker
set search_path=pg_catalog as $$
declare v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
begin
  if auth.uid() is null or v_email='' then
    raise exception using errcode='42501',message='로그인이 필요합니다.';
  end if;
  if not exists(select 1 from academy_app.user_access u
    where u.email=v_email and u.active=true and u.role='SUPER_ADMIN') then
    raise exception using errcode='42501',message='최고 관리자만 원장 관리를 사용할 수 있습니다.';
  end if;
  return v_email;
end;
$$;

create or replace function public.get_teacher_management_workspace(
  p_query text default null,p_filter text default null
)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare
  v_email text:=academy_app.teacher_admin_email();
  v_query text:=btrim(coalesce(p_query,''));
  v_filter text:=lower(btrim(coalesce(p_filter,'')));
  v_result jsonb;
begin
  if v_filter not in ('','active','inactive','salary') then
    raise exception using errcode='22023',message='원장 상태 필터가 올바르지 않습니다.';
  end if;

  with teacher_usage as materialized (
    select t.*,
      (select count(*) from academy_app.user_access u where u.active=true and u.teacher_id=t.teacher_id) linked_users,
      (select count(*) from academy_app.students s where s.status='재원' and s.teacher_id=t.teacher_id) active_students
    from academy_app.teachers t
  ), filtered as materialized (
    select * from teacher_usage t
    where (v_query='' or t.teacher_name ilike '%'||v_query||'%')
      and (v_filter='' or (v_filter='active' and t.active)
        or (v_filter='inactive' and not t.active)
        or (v_filter='salary' and t.salary_target))
  )
  select jsonb_build_object(
    'rows',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',teacher_id,'name',teacher_name,'active',active,
      'defaultRate',default_distribution_rate,'salaryTarget',salary_target,
      'startDate',case when nullif(btrim(coalesce(start_date,'')),'') is null then null
        else left(start_date,10) end,
      'endDate',case when nullif(btrim(coalesce(end_date,'')),'') is null then null
        else left(end_date,10) end,
      'memo',memo,'sourceSystem',source_system,'version',version,
      'updatedAt',to_char(updated_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'updatedBy',updated_by,'linkedUsers',linked_users,'activeStudents',active_students,
      'canDeactivate',(linked_users=0)
    ) order by active desc,teacher_name),'[]'::jsonb) from filtered),
    'summary',(select jsonb_build_object(
      'total',count(*),'active',count(*) filter(where active),
      'salary',count(*) filter(where salary_target),
      'linkedUsers',coalesce(sum(linked_users),0),'activeStudents',coalesce(sum(active_students),0)
    ) from teacher_usage),
    'recentRevisions',(select coalesce(jsonb_agg(jsonb_build_object(
      'teacherId',r.teacher_id,'teacherName',t.teacher_name,'action',r.action,
      'memo',r.memo,'actorEmail',r.actor_email,
      'createdAt',to_char(r.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI')
    ) order by r.created_at desc),'[]'::jsonb)
      from (select * from academy_app.teacher_revisions order by created_at desc limit 30) r
      join academy_app.teachers t using(teacher_id)),
    'diagnostics',(select jsonb_build_object(
      'duplicateNames',(select count(*) from (select lower(btrim(teacher_name)) from academy_app.teachers group by 1 having count(*)>1)d),
      'invalidRates',count(*) filter(where default_distribution_rate<0 or default_distribution_rate>100),
      'invalidPeriods',count(*) filter(where nullif(left(start_date,10),'') is not null
        and nullif(left(end_date,10),'') is not null and left(start_date,10)>left(end_date,10)),
      'healthy',not exists(select 1 from academy_app.teachers
        where default_distribution_rate<0 or default_distribution_rate>100
          or (nullif(left(start_date,10),'') is not null and nullif(left(end_date,10),'') is not null
            and left(start_date,10)>left(end_date,10)))
    ) from teacher_usage)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.save_managed_teacher(
  p_teacher_id text,p_name text,p_active boolean,p_default_rate numeric,
  p_salary_target boolean,p_start_date date,p_end_date date,p_memo text,
  p_expected_version integer,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare
  v_email text:=academy_app.teacher_admin_email();
  v_id text:=nullif(btrim(coalesce(p_teacher_id,'')),'');
  v_name text:=btrim(coalesce(p_name,''));
  v_memo text:=nullif(btrim(coalesce(p_memo,'')),'');
  v_current academy_app.teachers%rowtype;
  v_saved academy_app.teachers%rowtype;
  v_result jsonb;
  v_action text;
  v_linked text;
begin
  if p_request_id is null then raise exception using errcode='22023',message='요청 ID가 필요합니다.'; end if;
  select result into v_result from academy_app.teacher_operation_requests
    where request_id=p_request_id and actor_email=v_email and operation='SAVE';
  if found then return v_result; end if;
  if v_name='' or length(v_name)>40 then raise exception using errcode='22023',message='원장명은 1~40자로 입력해주세요.'; end if;
  if p_default_rate is null or p_default_rate<0 or p_default_rate>100 then
    raise exception using errcode='22023',message='신규학생 기본 배분율은 0~100 사이여야 합니다.';
  end if;
  if length(coalesce(v_memo,''))>500 then raise exception using errcode='22023',message='메모는 500자 이내로 입력해주세요.'; end if;
  if p_start_date is not null and p_end_date is not null and p_start_date>p_end_date then
    raise exception using errcode='22023',message='종료일은 시작일보다 빠를 수 없습니다.';
  end if;

  if exists(select 1 from academy_app.teachers t
    where lower(btrim(t.teacher_name))=lower(v_name) and (v_id is null or t.teacher_id<>v_id)) then
    raise exception using errcode='23505',message='같은 이름의 원장이 이미 등록되어 있습니다.';
  end if;

  if v_id is null then
    v_id:='TCH-'||gen_random_uuid()::text;
    insert into academy_app.teachers(
      teacher_id,teacher_name,active,default_distribution_rate,salary_target,
      start_date,end_date,memo,source_run_id,source_updated_at,synced_at,
      source_system,created_at,updated_at,updated_by,version,last_request_id
    ) values (
      v_id,v_name,coalesce(p_active,true),p_default_rate,coalesce(p_salary_target,true),
      case when p_start_date is null then null else to_char(p_start_date,'YYYY-MM-DD') end,
      case when p_end_date is null then null else to_char(p_end_date,'YYYY-MM-DD') end,
      v_memo,null,null,now(),'SUPABASE',now(),now(),v_email,1,p_request_id
    ) returning * into v_saved;
    v_action:='CREATE';
  else
    select * into v_current from academy_app.teachers where teacher_id=v_id for update;
    if not found then raise exception using errcode='P0002',message='수정할 원장 정보를 찾을 수 없습니다. 목록을 새로고침해 주세요.'; end if;
    if v_current.teacher_name<>v_name then
      raise exception using errcode='22023',message='기존 원장명 변경은 학생 이력과 함께 처리해야 하므로 현재 화면에서는 지원하지 않습니다.';
    end if;
    if p_expected_version is null or v_current.version<>p_expected_version then
      raise exception using errcode='40001',message='다른 화면에서 원장 정보가 변경되었습니다. 목록을 새로고침해 주세요.';
    end if;
    if coalesce(p_active,true)=false and v_current.active=true then
      select string_agg(email,', ' order by email) into v_linked
      from academy_app.user_access where active=true and teacher_id=v_id;
      if v_linked is not null then
        raise exception using errcode='23503',message='활성 사용자와 연결된 원장은 비활성화할 수 없습니다. 설정에서 연결 원장을 먼저 변경해 주세요: '||v_linked;
      end if;
    end if;
    update academy_app.teachers set
      active=coalesce(p_active,true),default_distribution_rate=p_default_rate,
      salary_target=coalesce(p_salary_target,true),
      start_date=case when p_start_date is null then null else to_char(p_start_date,'YYYY-MM-DD') end,
      end_date=case when p_end_date is null then null else to_char(p_end_date,'YYYY-MM-DD') end,
      memo=v_memo,source_system='SUPABASE',updated_at=now(),updated_by=v_email,
      version=version+1,last_request_id=p_request_id
    where teacher_id=v_id returning * into v_saved;
    v_action:='UPDATE';
  end if;

  v_result:=jsonb_build_object('id',v_saved.teacher_id,'name',v_saved.teacher_name,
    'active',v_saved.active,'defaultRate',v_saved.default_distribution_rate,
    'salaryTarget',v_saved.salary_target,'version',v_saved.version,'action',v_action);
  insert into academy_app.teacher_revisions(
    teacher_id,action,before_data,after_data,memo,actor_email,request_id
  ) values (v_saved.teacher_id,v_action,
    case when v_action='CREATE' then null else to_jsonb(v_current) end,
    to_jsonb(v_saved),v_memo,v_email,p_request_id);
  insert into academy_app.teacher_operation_requests(request_id,operation,actor_email,result)
  values(p_request_id,'SAVE',v_email,v_result);
  return v_result;
end;
$$;

revoke all on function academy_app.teacher_admin_email() from public,anon;
grant execute on function academy_app.teacher_admin_email() to authenticated;
revoke all on function public.get_teacher_management_workspace(text,text) from public,anon;
revoke all on function public.save_managed_teacher(text,text,boolean,numeric,boolean,date,date,text,integer,uuid) from public,anon;
grant execute on function public.get_teacher_management_workspace(text,text) to authenticated;
grant execute on function public.save_managed_teacher(text,text,boolean,numeric,boolean,date,date,text,integer,uuid) to authenticated;

comment on table academy_app.teacher_revisions is 'Immutable audit trail for Supabase teacher directory changes.';
comment on function public.get_teacher_management_workspace(text,text) is 'Super-admin teacher directory workspace with usage and diagnostics.';
comment on function public.save_managed_teacher(text,text,boolean,numeric,boolean,date,date,text,integer,uuid) is 'Idempotent guarded create/update for teacher reference data.';
