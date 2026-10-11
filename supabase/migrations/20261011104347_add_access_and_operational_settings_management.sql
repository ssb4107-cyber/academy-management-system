-- Supabase-native user access and operational settings management.
-- Existing Google-imported IDs and values remain intact; new writes gain versioning,
-- idempotency, protected recovery accounts and an immutable audit trail.

alter table academy_app.user_access
  alter column source_run_id drop not null,
  add column if not exists protected_account boolean not null default false,
  add column if not exists source_system text not null default 'GOOGLE_SNAPSHOT',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists version integer not null default 1,
  add column if not exists last_request_id uuid;

update academy_app.user_access set
  protected_account=(active=true and role='SUPER_ADMIN'),
  created_at=coalesce(created_at,synced_at),updated_at=coalesce(updated_at,synced_at),
  updated_by=coalesce(updated_by,'google-import'),version=greatest(coalesce(version,1),1),
  source_system=coalesce(nullif(source_system,''),'GOOGLE_SNAPSHOT');

alter table academy_app.user_access
  drop constraint if exists academy_user_access_version_check;
alter table academy_app.user_access
  add constraint academy_user_access_version_check check(version>=1);

alter table academy_app.operational_settings
  alter column source_run_id drop not null,
  add column if not exists default_value numeric,
  add column if not exists source_system text not null default 'GOOGLE_SNAPSHOT',
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists version integer not null default 1,
  add column if not exists last_request_id uuid;

insert into academy_app.operational_settings(
  setting_key,category,setting_label,value_text,value_type,min_value,max_value,description,
  source_run_id,synced_at,default_value,source_system,updated_at,updated_by,version
) values
  ('DASHBOARD_MONTH_CUTOFF_DAY','화면','대시보드 당월 전환일','10','NUMBER','1','28','이 날짜 전날까지는 전달, 해당일부터 당월을 기본으로 표시합니다.',null,now(),10,'SUPABASE',now(),'migration',1),
  ('PAYMENT_TOLERANCE_WON','금액','완납 허용 오차','1000','NUMBER','0','100000','청구액보다 부족해도 완납으로 보는 최대 차이입니다.',null,now(),1000,'SUPABASE',now(),'migration',1),
  ('PAYMENT_WARNING_HIGH_WON','금액','큰 차이 경고 기준','5000','NUMBER','1','1000000','이 금액 이상 차이나면 강한 경고로 표시합니다.',null,now(),5000,'SUPABASE',now(),'migration',1),
  ('PAYMENT_SILENT_DIFF_WON','금액','표시 생략 오차','10','NUMBER','0','10000','이 금액 이하의 차이는 별도 경고를 표시하지 않습니다.',null,now(),10,'SUPABASE',now(),'migration',1),
  ('FEBRUARY_BILLING_DAYS','일할 계산','2월 일할 기준일수','30','NUMBER','28','31','2월 수강료 일할 계산의 분모로 사용합니다.',null,now(),30,'SUPABASE',now(),'migration',1),
  ('PRORATION_AMOUNT_WARNING_PERCENT','일할 계산','일할 금액 차이 경고율','20','NUMBER','0','100','서버 계산액과 실제 입력액의 차이가 이 비율을 넘으면 저장을 막고 재확인을 요청합니다.',null,now(),20,'SUPABASE',now(),'migration',1),
  ('ELEMENTARY_DEFAULT_FEE','학생 등록','초등 기본 수강료','250000','NUMBER','0','10000000','신규 학생 등록 시 학년에 따라 자동 제시합니다.',null,now(),250000,'SUPABASE',now(),'migration',1),
  ('MIDDLE_DEFAULT_FEE','학생 등록','중등 기본 수강료','350000','NUMBER','0','10000000','신규 학생 등록 시 학년에 따라 자동 제시합니다.',null,now(),350000,'SUPABASE',now(),'migration',1),
  ('HIGH_DEFAULT_FEE','학생 등록','고등 기본 수강료','400000','NUMBER','0','10000000','신규 학생 등록 시 학년에 따라 자동 제시합니다.',null,now(),400000,'SUPABASE',now(),'migration',1),
  ('BACKUP_INTERVAL_DAYS','백업','자동 백업 주기','3','NUMBER','1','30','마지막 정상 백업 후 다음 자동 백업까지의 일수입니다.',null,now(),3,'SUPABASE',now(),'migration',1),
  ('BACKUP_RETENTION_MONTHS','백업','백업 보관 개월','3','NUMBER','1','24','이 기간보다 오래된 정기 백업을 자동 정리합니다.',null,now(),3,'SUPABASE',now(),'migration',1)
on conflict(setting_key) do update set
  category=excluded.category,setting_label=excluded.setting_label,value_type=excluded.value_type,
  min_value=excluded.min_value,max_value=excluded.max_value,description=excluded.description,
  default_value=excluded.default_value;

update academy_app.operational_settings set
  updated_at=coalesce(updated_at,synced_at),updated_by=coalesce(updated_by,'google-import'),
  version=greatest(coalesce(version,1),1),source_system=coalesce(nullif(source_system,''),'GOOGLE_SNAPSHOT');

alter table academy_app.operational_settings
  alter column default_value set not null,
  drop constraint if exists academy_operational_settings_version_check;
alter table academy_app.operational_settings
  add constraint academy_operational_settings_version_check check(version>=1);

create table if not exists academy_app.settings_revisions(
  revision_id uuid primary key default gen_random_uuid(),
  action text not null check(action in ('USER_CREATE','USER_UPDATE','SETTINGS_UPDATE','SETTINGS_RESET')),
  target_id text not null,
  before_data jsonb,
  after_data jsonb not null,
  memo text,
  actor_email text not null,
  request_id uuid not null unique,
  created_at timestamptz not null default now()
);

create table if not exists academy_app.settings_operation_requests(
  request_id uuid primary key,
  operation text not null check(operation in ('USER_SAVE','SETTINGS_SAVE')),
  actor_email text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists academy_settings_revisions_created_idx
  on academy_app.settings_revisions(created_at desc);

alter table academy_app.settings_revisions enable row level security;
alter table academy_app.settings_revisions force row level security;
alter table academy_app.settings_operation_requests enable row level security;
alter table academy_app.settings_operation_requests force row level security;
revoke all on table academy_app.settings_revisions from public,anon,authenticated;
revoke all on table academy_app.settings_operation_requests from public,anon,authenticated;

drop policy if exists academy_user_admin_insert on academy_app.user_access;
create policy academy_user_admin_insert on academy_app.user_access
for insert to authenticated with check(
  (select academy_app.is_super_admin()) and protected_account=false
);
drop policy if exists academy_user_admin_update on academy_app.user_access;
create policy academy_user_admin_update on academy_app.user_access
for update to authenticated using((select academy_app.is_super_admin()))
with check((select academy_app.is_super_admin()));

drop policy if exists academy_operational_settings_admin_insert on academy_app.operational_settings;
create policy academy_operational_settings_admin_insert on academy_app.operational_settings
for insert to authenticated with check((select academy_app.is_super_admin()));
drop policy if exists academy_operational_settings_admin_update on academy_app.operational_settings;
create policy academy_operational_settings_admin_update on academy_app.operational_settings
for update to authenticated using((select academy_app.is_super_admin()))
with check((select academy_app.is_super_admin()));

create policy academy_settings_revision_admin_read on academy_app.settings_revisions
for select to authenticated using((select academy_app.is_super_admin()));
create policy academy_settings_revision_admin_insert on academy_app.settings_revisions
for insert to authenticated with check(
  actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and (select academy_app.is_super_admin())
);
create policy academy_settings_operation_admin_read on academy_app.settings_operation_requests
for select to authenticated using(
  actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and (select academy_app.is_super_admin())
);
create policy academy_settings_operation_admin_insert on academy_app.settings_operation_requests
for insert to authenticated with check(
  actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and (select academy_app.is_super_admin())
);

grant select,insert,update on table academy_app.user_access to authenticated;
grant select,insert,update on table academy_app.operational_settings to authenticated;
grant select,insert on table academy_app.settings_revisions to authenticated;
grant select,insert on table academy_app.settings_operation_requests to authenticated;

create or replace function academy_app.allowed_manager_permissions()
returns text[] language sql immutable security invoker set search_path=pg_catalog as $$
  select array['STUDENT_ADD','STUDENT_EDIT','STUDENT_VACATION','SIBLING_MANAGER','PAYMENT_DASHBOARD']::text[]
$$;

create or replace function academy_app.settings_admin_email()
returns text language plpgsql stable security invoker set search_path=pg_catalog as $$
declare v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
begin
  if auth.uid() is null or v_email='' then
    raise exception using errcode='42501',message='로그인이 필요합니다.';
  end if;
  if not (select academy_app.is_super_admin()) then
    raise exception using errcode='42501',message='최고 관리자만 설정 및 사용자 권한을 관리할 수 있습니다.';
  end if;
  return v_email;
end;
$$;

create or replace function academy_app.protect_user_access_row()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
begin
  if tg_op='UPDATE' then
    if new.protected_account is distinct from old.protected_account then
      raise exception using errcode='42501',message='보호 계정 표시는 변경할 수 없습니다.';
    end if;
    if old.protected_account and (
      new.email is distinct from old.email or new.role<>'SUPER_ADMIN' or new.active=false
    ) then
      raise exception using errcode='42501',message='비상 관리자 계정의 이메일·역할·사용 상태는 변경할 수 없습니다.';
    end if;
    if old.email=v_email and (
      new.email is distinct from old.email or new.role<>'SUPER_ADMIN' or new.active=false
    ) then
      raise exception using errcode='42501',message='현재 로그인한 최고 관리자 계정은 이메일·역할을 변경하거나 사용 중지할 수 없습니다.';
    end if;
  end if;
  if new.role='SUPER_ADMIN' then
    new.student_scope:='ALL_STUDENTS';
    new.permissions:=academy_app.allowed_manager_permissions();
  end if;
  return new;
end;
$$;

drop trigger if exists academy_protect_user_access_row on academy_app.user_access;
create trigger academy_protect_user_access_row
before insert or update on academy_app.user_access
for each row execute function academy_app.protect_user_access_row();

create or replace function academy_app.validate_operational_setting_row()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v numeric;
begin
  if new.value_text !~ '^-?[0-9]+$' then
    raise exception using errcode='22023',message=new.setting_label||'은(는) 정수로 입력해주세요.';
  end if;
  v:=new.value_text::numeric;
  if v<new.min_value::numeric or v>new.max_value::numeric then
    raise exception using errcode='22023',message=new.setting_label||'은(는) '||new.min_value||'~'||new.max_value||' 범위로 입력해주세요.';
  end if;
  return new;
end;
$$;
drop trigger if exists academy_validate_operational_setting_row on academy_app.operational_settings;
create trigger academy_validate_operational_setting_row
before insert or update of value_text on academy_app.operational_settings
for each row execute function academy_app.validate_operational_setting_row();

create or replace function academy_app.validate_operational_setting_relations()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v_silent numeric;v_tolerance numeric;v_warning numeric;
begin
  select value_text::numeric into v_silent from academy_app.operational_settings where setting_key='PAYMENT_SILENT_DIFF_WON';
  select value_text::numeric into v_tolerance from academy_app.operational_settings where setting_key='PAYMENT_TOLERANCE_WON';
  select value_text::numeric into v_warning from academy_app.operational_settings where setting_key='PAYMENT_WARNING_HIGH_WON';
  if v_silent>v_tolerance then raise exception using errcode='22023',message='표시 생략 오차는 완납 허용 오차보다 클 수 없습니다.'; end if;
  if v_warning<=v_tolerance then raise exception using errcode='22023',message='큰 차이 경고 기준은 완납 허용 오차보다 커야 합니다.'; end if;
  return null;
end;
$$;
drop trigger if exists academy_validate_operational_setting_relations on academy_app.operational_settings;
create constraint trigger academy_validate_operational_setting_relations
after insert or update of value_text on academy_app.operational_settings
deferrable initially deferred for each row
execute function academy_app.validate_operational_setting_relations();

create or replace function public.get_access_settings_workspace()
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_email text:=academy_app.settings_admin_email();v_result jsonb;
begin
  select jsonb_build_object(
    'users',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',u.user_key,'email',u.email,'name',u.display_name,'role',u.role,'active',u.active,
      'permissionKeys',to_jsonb(u.permissions),'teacherId',u.teacher_id,'teacherName',t.teacher_name,
      'teacherActive',coalesce(t.active,false),'studentScope',u.student_scope,
      'protected',u.protected_account,'current',u.email=v_email,'version',u.version,
      'createdAt',to_char(u.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'updatedAt',to_char(u.updated_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'updatedBy',u.updated_by,'sourceSystem',u.source_system
    ) order by u.active desc,u.protected_account desc,u.role,u.display_name,u.email),'[]'::jsonb)
      from academy_app.user_access u left join academy_app.teachers t on t.teacher_id=u.teacher_id),
    'teachers',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',teacher_id,'name',teacher_name,'active',active
    ) order by active desc,teacher_name),'[]'::jsonb) from academy_app.teachers),
    'managerPermissions',jsonb_build_array(
      jsonb_build_object('key','STUDENT_ADD','group','학생 관리','label','학생 등록'),
      jsonb_build_object('key','STUDENT_EDIT','group','학생 관리','label','학생 정보 수정·퇴원'),
      jsonb_build_object('key','STUDENT_VACATION','group','학생 관리','label','학생 휴가'),
      jsonb_build_object('key','SIBLING_MANAGER','group','학생 관리','label','형제·자매 관리'),
      jsonb_build_object('key','PAYMENT_DASHBOARD','group','수납 관리','label','수납 대시보드')
    ),
    'settings',(select coalesce(jsonb_agg(jsonb_build_object(
      'key',setting_key,'category',category,'label',setting_label,
      'value',value_text::numeric,'defaultValue',default_value,'type',value_type,
      'min',min_value::numeric,'max',max_value::numeric,'description',description,
      'modified',value_text::numeric<>default_value,'version',version,
      'updatedAt',to_char(updated_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),
      'updatedBy',updated_by
    ) order by category,setting_key),'[]'::jsonb) from academy_app.operational_settings),
    'counts',(select jsonb_build_object(
      'total',count(*),'active',count(*) filter(where active),
      'superAdmins',count(*) filter(where active and role='SUPER_ADMIN'),
      'managers',count(*) filter(where active and role='MANAGER'),
      'protected',count(*) filter(where protected_account)
    ) from academy_app.user_access),
    'currentUser',jsonb_build_object('email',v_email),
    'recentRevisions',(select coalesce(jsonb_agg(jsonb_build_object(
      'action',action,'targetId',target_id,'memo',memo,'actorEmail',actor_email,
      'createdAt',to_char(created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI')
    ) order by created_at desc),'[]'::jsonb)
      from(select * from academy_app.settings_revisions order by created_at desc limit 40)r),
    'diagnostics',jsonb_build_object(
      'activeSuperAdmins',(select count(*) from academy_app.user_access where active and role='SUPER_ADMIN'),
      'protectedAccounts',(select count(*) from academy_app.user_access where protected_account and active and role='SUPER_ADMIN'),
      'invalidTeacherLinks',(select count(*) from academy_app.user_access u left join academy_app.teachers t on t.teacher_id=u.teacher_id where u.teacher_id is not null and t.teacher_id is null),
      'invalidScopes',(select count(*) from academy_app.user_access where
        (role='SUPER_ADMIN' and student_scope<>'ALL_STUDENTS')
        or (role='MANAGER' and teacher_id is not null and student_scope<>'LINKED_TEACHER')
        or (role='MANAGER' and teacher_id is null and student_scope='LINKED_TEACHER')),
      'missingSettings',(select 11-count(*) from academy_app.operational_settings),
      'healthy',(
        (select count(*) from academy_app.user_access where active and role='SUPER_ADMIN')>=1
        and (select count(*) from academy_app.user_access where protected_account and active and role='SUPER_ADMIN')>=1
        and not exists(select 1 from academy_app.user_access u left join academy_app.teachers t on t.teacher_id=u.teacher_id where u.teacher_id is not null and t.teacher_id is null)
        and (select count(*) from academy_app.operational_settings)=11
      )
    )
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.save_managed_user_access(
  p_user_key text,p_email text,p_display_name text,p_identity_mode text,p_teacher_id text,
  p_student_scope text,p_role text,p_active boolean,p_permissions text[],
  p_expected_version integer,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare
  v_actor text:=academy_app.settings_admin_email();
  v_id text:=nullif(btrim(coalesce(p_user_key,'')),'');
  v_email text:=lower(btrim(coalesce(p_email,'')));
  v_name text:=btrim(coalesce(p_display_name,''));
  v_mode text:=upper(btrim(coalesce(p_identity_mode,'')));
  v_teacher_id text:=nullif(btrim(coalesce(p_teacher_id,'')),'');
  v_scope text:=upper(btrim(coalesce(p_student_scope,'')));
  v_role text:=upper(btrim(coalesce(p_role,'MANAGER')));
  v_active boolean:=coalesce(p_active,true);
  v_allowed text[]:=academy_app.allowed_manager_permissions();
  v_permissions text[];
  v_current academy_app.user_access%rowtype;
  v_saved academy_app.user_access%rowtype;
  v_result jsonb;v_action text;
begin
  if p_request_id is null then raise exception using errcode='22023',message='요청 ID가 필요합니다.'; end if;
  select result into v_result from academy_app.settings_operation_requests
    where request_id=p_request_id and actor_email=v_actor and operation='USER_SAVE';
  if found then return v_result; end if;
  if v_email='' or length(v_email)>120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode='22023',message='이메일 형식이 올바르지 않습니다.';
  end if;
  if v_mode not in ('TEACHER','CUSTOM') then raise exception using errcode='22023',message='표시명 입력 방식을 확인할 수 없습니다.'; end if;
  if v_role not in ('SUPER_ADMIN','MANAGER') then raise exception using errcode='22023',message='허용되지 않은 역할입니다.'; end if;
  if v_mode='TEACHER' then
    if v_teacher_id is null then raise exception using errcode='22023',message='이 사용자의 원장을 선택해주세요.'; end if;
    select teacher_name into v_name from academy_app.teachers where teacher_id=v_teacher_id;
    if not found then raise exception using errcode='22023',message='선택한 원장 정보를 찾을 수 없습니다.'; end if;
  else
    v_teacher_id:=null;
    if v_name='' or length(v_name)>40 then raise exception using errcode='22023',message='표시명은 1~40자로 입력해주세요.'; end if;
  end if;
  if v_role='SUPER_ADMIN' then
    v_scope:='ALL_STUDENTS';v_permissions:=v_allowed;
  elsif v_mode='TEACHER' then
    v_scope:='LINKED_TEACHER';
  elsif v_scope not in ('NONE','ALL_STUDENTS') then
    raise exception using errcode='22023',message='원장과 연결하지 않은 사용자는 학생을 보지 않거나 모든 학생을 보도록 선택해주세요.';
  end if;
  if v_role='MANAGER' then
    if p_permissions is null then v_permissions:=v_allowed;
    else select coalesce(array_agg(x order by array_position(v_allowed,x)),'{}'::text[])
      into v_permissions from unnest(v_allowed)x where x=any(p_permissions); end if;
  end if;

  if exists(select 1 from academy_app.user_access u where u.email=v_email and (v_id is null or u.user_key<>v_id)) then
    raise exception using errcode='23505',message='이미 등록된 이메일입니다.';
  end if;
  if v_id is null then
    v_id:='USR-'||gen_random_uuid()::text;v_action:='USER_CREATE';
    insert into academy_app.user_access(
      user_key,email,display_name,role,active,permissions,teacher_id,student_scope,
      source_run_id,source_updated_at,synced_at,protected_account,source_system,
      created_at,updated_at,updated_by,version,last_request_id
    ) values(v_id,v_email,v_name,v_role,coalesce(p_active,true),v_permissions,v_teacher_id,v_scope,
      null,null,now(),false,'SUPABASE',now(),now(),v_actor,1,p_request_id)
    returning * into v_saved;
  else
    select * into v_current from academy_app.user_access where user_key=v_id for update;
    if not found then raise exception using errcode='P0002',message='수정할 사용자 정보를 찾을 수 없습니다. 목록을 새로고침해 주세요.'; end if;
    if p_expected_version is null or v_current.version<>p_expected_version then
      raise exception using errcode='40001',message='다른 화면에서 사용자 정보가 변경되었습니다. 목록을 새로고침해 주세요.';
    end if;
    if v_current.protected_account then
      if v_email<>v_current.email then raise exception using errcode='42501',message='비상 관리자 계정의 이메일은 변경할 수 없습니다.'; end if;
      v_role:='SUPER_ADMIN';v_active:=true;v_scope:='ALL_STUDENTS';v_permissions:=v_allowed;
    end if;
    if v_current.email=v_actor and (v_email<>v_current.email or v_active=false or v_role<>'SUPER_ADMIN') then
      raise exception using errcode='42501',message='현재 로그인한 최고 관리자 계정은 이메일·역할을 변경하거나 사용 중지할 수 없습니다.';
    end if;
    v_action:='USER_UPDATE';
    update academy_app.user_access set
      email=v_email,display_name=v_name,role=v_role,active=v_active,
      permissions=v_permissions,teacher_id=v_teacher_id,student_scope=v_scope,
      source_system='SUPABASE',updated_at=now(),updated_by=v_actor,version=version+1,last_request_id=p_request_id
    where user_key=v_id returning * into v_saved;
  end if;
  v_result:=jsonb_build_object('id',v_saved.user_key,'email',v_saved.email,'name',v_saved.display_name,
    'role',v_saved.role,'active',v_saved.active,'teacherId',v_saved.teacher_id,
    'studentScope',v_saved.student_scope,'permissionKeys',to_jsonb(v_saved.permissions),
    'version',v_saved.version,'action',v_action);
  insert into academy_app.settings_revisions(action,target_id,before_data,after_data,memo,actor_email,request_id)
  values(v_action,v_saved.user_key,case when v_action='USER_CREATE' then null else to_jsonb(v_current) end,
    to_jsonb(v_saved),'사용자 접근권한 저장',v_actor,p_request_id);
  insert into academy_app.settings_operation_requests(request_id,operation,actor_email,result)
  values(p_request_id,'USER_SAVE',v_actor,v_result);
  return v_result;
end;
$$;

create or replace function public.save_operational_settings(
  p_values jsonb,p_expected_versions jsonb,p_request_id uuid,p_reset boolean
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare
  v_actor text:=academy_app.settings_admin_email();v_result jsonb;v_before jsonb;
  v_changed integer;v_action text:=case when coalesce(p_reset,false) then 'SETTINGS_RESET' else 'SETTINGS_UPDATE' end;
begin
  if p_request_id is null then raise exception using errcode='22023',message='요청 ID가 필요합니다.'; end if;
  select result into v_result from academy_app.settings_operation_requests
    where request_id=p_request_id and actor_email=v_actor and operation='SETTINGS_SAVE';
  if found then return v_result; end if;
  if jsonb_typeof(p_values)<>'object' then
    raise exception using errcode='22023',message='운영 설정 11개를 모두 확인해주세요.';
  end if;
  if (select count(*) from jsonb_object_keys(p_values))<>11 then
    raise exception using errcode='22023',message='운영 설정 11개를 모두 확인해주세요.';
  end if;
  if exists(select 1 from jsonb_each_text(p_values)e
    left join academy_app.operational_settings s on s.setting_key=e.key where s.setting_key is null) then
    raise exception using errcode='22023',message='알 수 없는 운영 설정이 포함되어 있습니다.';
  end if;
  if exists(select 1 from jsonb_each_text(p_values)e join academy_app.operational_settings s on s.setting_key=e.key
    where e.value !~ '^-?[0-9]+$' or e.value::numeric<s.min_value::numeric or e.value::numeric>s.max_value::numeric) then
    raise exception using errcode='22023',message='운영 설정은 각 항목의 허용 범위 안에서 정수로 입력해주세요.';
  end if;
  if (p_values->>'PAYMENT_SILENT_DIFF_WON')::numeric>(p_values->>'PAYMENT_TOLERANCE_WON')::numeric then
    raise exception using errcode='22023',message='표시 생략 오차는 완납 허용 오차보다 클 수 없습니다.';
  end if;
  if (p_values->>'PAYMENT_WARNING_HIGH_WON')::numeric<=(p_values->>'PAYMENT_TOLERANCE_WON')::numeric then
    raise exception using errcode='22023',message='큰 차이 경고 기준은 완납 허용 오차보다 커야 합니다.';
  end if;
  if jsonb_typeof(p_expected_versions)<>'object' then
    raise exception using errcode='40001',message='다른 화면에서 운영 설정이 변경되었습니다. 목록을 새로고침해 주세요.';
  end if;
  if exists(
    select 1 from academy_app.operational_settings s
    where not(p_expected_versions?s.setting_key)
      or (p_expected_versions->>s.setting_key)!~'^[0-9]+$'
      or (p_expected_versions->>s.setting_key)::integer<>s.version
  ) then raise exception using errcode='40001',message='다른 화면에서 운영 설정이 변경되었습니다. 목록을 새로고침해 주세요.'; end if;
  select jsonb_object_agg(setting_key,value_text::numeric) into v_before from academy_app.operational_settings;
  select count(*) into v_changed from academy_app.operational_settings s
    where s.value_text::numeric<>(p_values->>s.setting_key)::numeric;
  update academy_app.operational_settings s set
    value_text=((p_values->>s.setting_key)::numeric)::bigint::text,
    source_system='SUPABASE',updated_at=now(),updated_by=v_actor,
    version=s.version+1,last_request_id=p_request_id
  where s.value_text::numeric<>(p_values->>s.setting_key)::numeric;
  v_result:=jsonb_build_object('saved',true,'changed',v_changed,'reset',coalesce(p_reset,false));
  if v_changed>0 then
    insert into academy_app.settings_revisions(action,target_id,before_data,after_data,memo,actor_email,request_id)
    values(v_action,'OPERATIONAL_SETTINGS',v_before,p_values,
      case when p_reset then '운영 설정 기본값 복원' else '운영 설정 저장' end,v_actor,p_request_id);
  end if;
  insert into academy_app.settings_operation_requests(request_id,operation,actor_email,result)
  values(p_request_id,'SETTINGS_SAVE',v_actor,v_result);
  return v_result;
end;
$$;

create or replace function public.get_student_reference_data()
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare
  v_uid uuid:=auth.uid();v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_user academy_app.user_access%rowtype;v_teachers jsonb;v_settings jsonb;
begin
  if v_uid is null or v_email='' then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
  select * into v_user from academy_app.user_access where email=v_email and active=true;
  if not found then raise exception using errcode='42501',message='학생 관리 권한이 없습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'teacherId',teacher_id,'teacherName',teacher_name,'active',active,'defaultRate',default_distribution_rate
  ) order by active desc,teacher_name),'[]'::jsonb) into v_teachers from academy_app.teachers;
  select jsonb_object_agg(setting_key,value_text::numeric) into v_settings
    from academy_app.operational_settings where setting_key in(
      'ELEMENTARY_DEFAULT_FEE','MIDDLE_DEFAULT_FEE','HIGH_DEFAULT_FEE','DASHBOARD_MONTH_CUTOFF_DAY'
    );
  return jsonb_build_object(
    'teachers',v_teachers,
    'canAdd',v_user.role='SUPER_ADMIN' or 'STUDENT_ADD'=any(v_user.permissions),
    'canEdit',v_user.role='SUPER_ADMIN' or 'STUDENT_EDIT'=any(v_user.permissions),
    'linkedTeacherId',v_user.teacher_id,'studentScope',v_user.student_scope,
    'defaultFees',jsonb_build_object(
      'elementary',coalesce((v_settings->>'ELEMENTARY_DEFAULT_FEE')::numeric,250000),
      'middle',coalesce((v_settings->>'MIDDLE_DEFAULT_FEE')::numeric,350000),
      'high',coalesce((v_settings->>'HIGH_DEFAULT_FEE')::numeric,400000)
    ),
    'dashboardMonthCutoffDay',coalesce((v_settings->>'DASHBOARD_MONTH_CUTOFF_DAY')::integer,10)
  );
end;
$$;

revoke all on function academy_app.allowed_manager_permissions() from public,anon;
revoke all on function academy_app.settings_admin_email() from public,anon;
revoke all on function academy_app.protect_user_access_row() from public,anon,authenticated;
revoke all on function academy_app.validate_operational_setting_row() from public,anon,authenticated;
revoke all on function academy_app.validate_operational_setting_relations() from public,anon,authenticated;
grant execute on function academy_app.allowed_manager_permissions() to authenticated;
grant execute on function academy_app.settings_admin_email() to authenticated;
revoke all on function public.get_access_settings_workspace() from public,anon;
revoke all on function public.save_managed_user_access(text,text,text,text,text,text,text,boolean,text[],integer,uuid) from public,anon;
revoke all on function public.save_operational_settings(jsonb,jsonb,uuid,boolean) from public,anon;
grant execute on function public.get_access_settings_workspace() to authenticated;
grant execute on function public.save_managed_user_access(text,text,text,text,text,text,text,boolean,text[],integer,uuid) to authenticated;
grant execute on function public.save_operational_settings(jsonb,jsonb,uuid,boolean) to authenticated;

comment on table academy_app.settings_revisions is 'Immutable audit trail for user access and operational setting changes.';
comment on function public.get_access_settings_workspace() is 'Super-admin workspace for user access and operational settings.';
comment on function public.save_managed_user_access(text,text,text,text,text,text,text,boolean,text[],integer,uuid) is 'Idempotent guarded user access create/update.';
comment on function public.save_operational_settings(jsonb,jsonb,uuid,boolean) is 'Atomic validated operational settings update.';
