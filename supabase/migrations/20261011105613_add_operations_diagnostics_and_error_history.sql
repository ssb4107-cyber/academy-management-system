-- Supabase-native operations diagnostics and client error history.
-- Diagnostics are read-only against business data; only run/error history is written.

create table if not exists academy_app.operation_diagnostic_runs(
  run_id uuid primary key default gen_random_uuid(),
  status text not null check(status in ('HEALTHY','WARNING','CRITICAL')),
  issue_count integer not null check(issue_count>=0),
  critical_count integer not null check(critical_count>=0),
  warning_count integer not null check(warning_count>=0),
  metrics jsonb not null default '{}'::jsonb,
  issues jsonb not null default '[]'::jsonb check(jsonb_typeof(issues)='array'),
  duration_ms integer not null check(duration_ms>=0),
  actor_auth_user_id uuid not null,
  actor_email text not null check(actor_email=lower(btrim(actor_email))),
  created_at timestamptz not null default now()
);

create table if not exists academy_app.client_error_reports(
  error_id uuid primary key,
  fingerprint text not null check(char_length(fingerprint)=32),
  context text not null check(char_length(context) between 1 and 80),
  error_code text check(error_code is null or char_length(error_code)<=80),
  message text not null check(char_length(message) between 1 and 2000),
  detail text check(detail is null or char_length(detail)<=2000),
  stack_text text check(stack_text is null or char_length(stack_text)<=4000),
  page_path text check(page_path is null or char_length(page_path)<=500),
  browser_text text check(browser_text is null or char_length(browser_text)<=500),
  status text not null default 'OPEN' check(status in ('OPEN','RESOLVED')),
  actor_auth_user_id uuid not null,
  actor_email text not null check(actor_email=lower(btrim(actor_email))),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text check(resolution_note is null or char_length(resolution_note)<=500),
  version integer not null default 1 check(version>=1),
  last_request_id uuid,
  check(
    (status='OPEN' and resolved_at is null and resolved_by is null)
    or (status='RESOLVED' and resolved_at is not null and resolved_by is not null)
  )
);

create index if not exists academy_operation_diagnostic_runs_created_idx
  on academy_app.operation_diagnostic_runs(created_at desc);
create index if not exists academy_client_error_reports_status_created_idx
  on academy_app.client_error_reports(status,created_at desc);
create index if not exists academy_client_error_reports_actor_created_idx
  on academy_app.client_error_reports(actor_auth_user_id,created_at desc);
create index if not exists academy_client_error_reports_fingerprint_idx
  on academy_app.client_error_reports(fingerprint,created_at desc);

alter table academy_app.operation_diagnostic_runs enable row level security;
alter table academy_app.operation_diagnostic_runs force row level security;
alter table academy_app.client_error_reports enable row level security;
alter table academy_app.client_error_reports force row level security;

revoke all on table academy_app.operation_diagnostic_runs from public,anon,authenticated;
revoke all on table academy_app.client_error_reports from public,anon,authenticated;

create policy academy_operation_diagnostic_admin_read
on academy_app.operation_diagnostic_runs for select to authenticated
using((select academy_app.is_super_admin()));
create policy academy_operation_diagnostic_admin_insert
on academy_app.operation_diagnostic_runs for insert to authenticated
with check(
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and (select academy_app.is_super_admin())
);

create policy academy_client_error_owner_or_admin_read
on academy_app.client_error_reports for select to authenticated
using(
  actor_auth_user_id=(select auth.uid())
  or (select academy_app.is_super_admin())
);
create policy academy_client_error_owner_insert
on academy_app.client_error_reports for insert to authenticated
with check(
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(
    select 1 from academy_app.user_access u
    where u.email=actor_email and u.active=true
  )
);
create policy academy_client_error_admin_update
on academy_app.client_error_reports for update to authenticated
using((select academy_app.is_super_admin()))
with check((select academy_app.is_super_admin()));

grant select,insert on table academy_app.operation_diagnostic_runs to authenticated;
grant select,insert,update on table academy_app.client_error_reports to authenticated;

create or replace function academy_app.diagnostic_recovery_action(p_code text)
returns text language sql immutable security invoker set search_path=pg_catalog as $$
  select case
    when p_code like 'USER_%' then '설정·권한에서 사용자 상태, 역할, 연결 원장과 학생 범위를 확인하세요.'
    when p_code like 'STUDENT_TEACHER_%' then '원장 관리와 학생 상세에서 담당 원장 연결을 확인하고 직접 DB 수정은 피하세요.'
    when p_code like 'ORPHAN_%' then '신규 저장을 잠시 멈추고 대상 학생·수납·휴가 기록의 연결 상태를 확인하세요.'
    when p_code like 'STALE_%' then '해당 요청 목록을 새로고침해 반영 여부를 먼저 확인한 뒤 같은 작업을 반복하지 마세요.'
    when p_code like 'SALARY_%' then '급여 관리에서 확정액·지급액·잔액과 상태를 대조하세요.'
    when p_code like 'SETTINGS_%' then '설정·권한에서 운영 설정 11개와 허용 범위를 확인하세요.'
    else '화면을 새로고침해 반영 여부를 확인하고, 계속되면 오류 이력의 오류 ID와 함께 점검하세요.'
  end
$$;

create or replace function public.report_client_error(
  p_error_id uuid,
  p_context text,
  p_error_code text,
  p_message text,
  p_detail text,
  p_stack_text text,
  p_page_path text,
  p_browser_text text
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare
  v_uid uuid:=auth.uid();
  v_email text:=lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_context text:=left(btrim(coalesce(p_context,'')),80);
  v_code text:=nullif(left(btrim(coalesce(p_error_code,'')),80),'');
  v_message text:=left(btrim(coalesce(p_message,'')),2000);
  v_detail text:=nullif(left(btrim(coalesce(p_detail,'')),2000),'');
  v_stack text:=nullif(left(btrim(coalesce(p_stack_text,'')),4000),'');
  v_path text:=nullif(left(btrim(coalesce(p_page_path,'')),500),'');
  v_browser text:=nullif(left(btrim(coalesce(p_browser_text,'')),500),'');
  v_fingerprint text;
  v_row academy_app.client_error_reports%rowtype;
  v_inserted boolean:=false;
begin
  if v_uid is null or v_email='' then
    raise exception using errcode='42501',message='로그인이 필요합니다.';
  end if;
  if not exists(select 1 from academy_app.user_access where email=v_email and active=true) then
    raise exception using errcode='42501',message='활성 사용자만 오류를 기록할 수 있습니다.';
  end if;
  if p_error_id is null then raise exception using errcode='22023',message='오류 ID가 필요합니다.'; end if;
  if v_context='' then v_context:='화면 작업'; end if;
  if v_message='' then raise exception using errcode='22023',message='오류 문구가 필요합니다.'; end if;
  v_fingerprint:=md5(lower(v_context||'|'||coalesce(v_code,'')||'|'||left(v_message,500)));

  insert into academy_app.client_error_reports(
    error_id,fingerprint,context,error_code,message,detail,stack_text,page_path,browser_text,
    actor_auth_user_id,actor_email
  ) values(
    p_error_id,v_fingerprint,v_context,v_code,v_message,v_detail,v_stack,v_path,v_browser,
    v_uid,v_email
  ) on conflict(error_id) do nothing returning * into v_row;
  if found then v_inserted:=true;
  else
    select * into v_row from academy_app.client_error_reports
    where error_id=p_error_id and actor_auth_user_id=v_uid;
    if not found then raise exception using errcode='23505',message='같은 오류 ID를 다른 계정에서 이미 사용했습니다.'; end if;
  end if;
  return jsonb_build_object('errorId',v_row.error_id,'duplicate',not v_inserted,'status',v_row.status);
end;
$$;

create or replace function public.resolve_client_error(
  p_error_id uuid,p_expected_version integer,p_resolution_note text,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare
  v_actor text:=academy_app.settings_admin_email();
  v_note text:=nullif(left(btrim(coalesce(p_resolution_note,'')),500),'');
  v_row academy_app.client_error_reports%rowtype;
begin
  if p_request_id is null then raise exception using errcode='22023',message='요청 ID가 필요합니다.'; end if;
  select * into v_row from academy_app.client_error_reports where error_id=p_error_id for update;
  if not found then raise exception using errcode='P0002',message='오류 기록을 찾을 수 없습니다.'; end if;
  if v_row.status='RESOLVED' then
    return jsonb_build_object('errorId',v_row.error_id,'status',v_row.status,'duplicate',v_row.last_request_id=p_request_id,'version',v_row.version);
  end if;
  if p_expected_version is null or p_expected_version<>v_row.version then
    raise exception using errcode='40001',message='다른 화면에서 오류 상태가 변경되었습니다. 새로고침해 주세요.';
  end if;
  update academy_app.client_error_reports set
    status='RESOLVED',resolved_at=now(),resolved_by=v_actor,resolution_note=v_note,
    version=version+1,last_request_id=p_request_id
  where error_id=p_error_id returning * into v_row;
  return jsonb_build_object('errorId',v_row.error_id,'status',v_row.status,'duplicate',false,'version',v_row.version);
end;
$$;

create or replace function public.run_operations_diagnostics()
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='10s' as $$
declare
  v_uid uuid:=auth.uid();
  v_actor text:=academy_app.settings_admin_email();
  v_started timestamptz:=clock_timestamp();
  v_run_id uuid:=gen_random_uuid();
  v_issues jsonb:='[]'::jsonb;
  v_metrics jsonb;
  v_count bigint;
  v_critical integer;
  v_warning integer;
  v_status text;
  v_duration integer;
begin
  select count(*) into v_count from academy_app.user_access where active and role='SUPER_ADMIN';
  if v_count<1 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','치명적','code','USER_NO_ACTIVE_SUPER_ADMIN','message','사용 중인 최고 관리자 계정이 없습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('USER_NO_ACTIVE_SUPER_ADMIN'))); end if;

  select count(*) into v_count from academy_app.user_access where active and role='SUPER_ADMIN' and protected_account;
  if v_count<1 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','치명적','code','USER_NO_PROTECTED_ADMIN','message','복구용 보호 관리자 계정이 없습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('USER_NO_PROTECTED_ADMIN'))); end if;

  select count(*) into v_count from academy_app.operational_settings;
  if v_count<>11 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','SETTINGS_COUNT_MISMATCH','message','운영 설정 항목 수가 11개와 다릅니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('SETTINGS_COUNT_MISMATCH'))); end if;

  select count(*) into v_count from academy_app.operational_settings
  where value_text !~ '^-?[0-9]+$' or min_value !~ '^-?[0-9]+$' or max_value !~ '^-?[0-9]+$';
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','SETTINGS_INVALID_NUMBER','message','숫자로 읽을 수 없는 운영 설정이 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('SETTINGS_INVALID_NUMBER'))); end if;

  select count(*) into v_count from academy_app.operational_settings
  where value_text ~ '^-?[0-9]+$' and min_value ~ '^-?[0-9]+$' and max_value ~ '^-?[0-9]+$'
    and (value_text::numeric<min_value::numeric or value_text::numeric>max_value::numeric);
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','SETTINGS_OUT_OF_RANGE','message','허용 범위를 벗어난 운영 설정이 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('SETTINGS_OUT_OF_RANGE'))); end if;

  select count(*) into v_count from academy_app.students s
  left join academy_app.teachers t on t.teacher_id=s.teacher_id
  where nullif(btrim(coalesce(s.teacher_id,'')),'') is null or t.teacher_id is null;
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','STUDENT_TEACHER_MISSING','message','담당 원장 ID가 없거나 존재하지 않는 학생이 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('STUDENT_TEACHER_MISSING'))); end if;

  select count(*) into v_count from academy_app.students s
  join academy_app.teachers t on t.teacher_id=s.teacher_id
  where nullif(btrim(coalesce(s.teacher_name,'')),'') is distinct from t.teacher_name;
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','STUDENT_TEACHER_NAME_MISMATCH','message','학생의 담당 원장 이름과 원장 ID가 서로 다릅니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('STUDENT_TEACHER_NAME_MISMATCH'))); end if;

  select count(*) into v_count from academy_app.user_access u
  left join academy_app.teachers t on t.teacher_id=u.teacher_id
  where u.active and u.teacher_id is not null and (t.teacher_id is null or not t.active);
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','USER_TEACHER_INVALID','message','사용 중인 계정이 없거나 사용 중지된 원장과 연결되어 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('USER_TEACHER_INVALID'))); end if;

  select count(*) into v_count from academy_app.user_access u where u.active and (
    (u.role='SUPER_ADMIN' and u.student_scope<>'ALL_STUDENTS')
    or (u.role='MANAGER' and u.teacher_id is not null and u.student_scope<>'LINKED_TEACHER')
    or (u.role='MANAGER' and u.teacher_id is null and u.student_scope='LINKED_TEACHER')
  );
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','USER_SCOPE_INVALID','message','계정 종류와 학생 조회 범위가 맞지 않는 사용자가 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('USER_SCOPE_INVALID'))); end if;

  select count(*) into v_count from academy_app.payments p
  left join academy_app.students s on s.student_id=p.student_id where s.student_id is null;
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','치명적','code','ORPHAN_PAYMENT_STUDENT','message','존재하지 않는 학생을 참조하는 수납 기록이 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('ORPHAN_PAYMENT_STUDENT'))); end if;

  select count(*) into v_count from academy_app.vacation_periods v
  left join academy_app.students s on s.student_id=v.student_id where s.student_id is null;
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','치명적','code','ORPHAN_VACATION_STUDENT','message','존재하지 않는 학생을 참조하는 휴가 기록이 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('ORPHAN_VACATION_STUDENT'))); end if;

  select count(*) into v_count from academy_app.student_timeline_events e
  left join academy_app.students s on s.student_id=e.student_id where s.student_id is null;
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','치명적','code','ORPHAN_TIMELINE_STUDENT','message','존재하지 않는 학생을 참조하는 변경 일정이 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('ORPHAN_TIMELINE_STUDENT'))); end if;

  select sum(c) into v_count from (
    select count(*) c from academy_app.payment_requests where status='PROCESSING' and updated_at<now()-interval '15 minutes'
    union all select count(*) from academy_app.student_requests where status='PROCESSING' and updated_at<now()-interval '15 minutes'
    union all select count(*) from academy_app.vacation_requests where status='PROCESSING' and updated_at<now()-interval '15 minutes'
    union all select count(*) from academy_app.sibling_requests where status='PROCESSING' and updated_at<now()-interval '15 minutes'
  ) stale;
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','STALE_PROCESSING_REQUEST','message','15분 이상 처리 중인 요청이 있습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('STALE_PROCESSING_REQUEST'))); end if;

  select count(*) into v_count from academy_app.salary_settlements
  where settlement_status<>'취소' and (
    balance_amount<>greatest(final_amount-paid_amount,0)
    or settlement_status<>academy_app.salary_status(final_amount,paid_amount)
  );
  if v_count>0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object(
    'severity','높음','code','SALARY_BALANCE_MISMATCH','message','급여 확정액·지급액·잔액 또는 상태가 맞지 않습니다.',
    'count',v_count,'action',academy_app.diagnostic_recovery_action('SALARY_BALANCE_MISMATCH'))); end if;

  select jsonb_build_object(
    'students',(select count(*) from academy_app.students),
    'teachers',(select count(*) from academy_app.teachers),
    'users',(select count(*) from academy_app.user_access),
    'payments',(select count(*) from academy_app.payments),
    'vacations',(select count(*) from academy_app.vacation_periods where deleted_at is null),
    'pendingRequests',(
      (select count(*) from academy_app.payment_requests where status='PENDING')+
      (select count(*) from academy_app.student_requests where status='PENDING')+
      (select count(*) from academy_app.vacation_requests where status='PENDING')+
      (select count(*) from academy_app.sibling_requests where status='PENDING')
    ),
    'salarySettlements',(select count(*) from academy_app.salary_settlements where settlement_status<>'취소'),
    'openErrors',(select count(*) from academy_app.client_error_reports where status='OPEN')
  ) into v_metrics;

  select count(*) filter(where value->>'severity' in ('치명적','높음')),
         count(*) filter(where value->>'severity' not in ('치명적','높음'))
    into v_critical,v_warning from jsonb_array_elements(v_issues);
  v_status:=case when v_critical>0 then 'CRITICAL' when v_warning>0 then 'WARNING' else 'HEALTHY' end;
  v_duration:=greatest(0,floor(extract(epoch from clock_timestamp()-v_started)*1000)::integer);

  insert into academy_app.operation_diagnostic_runs(
    run_id,status,issue_count,critical_count,warning_count,metrics,issues,duration_ms,
    actor_auth_user_id,actor_email
  ) values(
    v_run_id,v_status,jsonb_array_length(v_issues),v_critical,v_warning,v_metrics,v_issues,
    v_duration,v_uid,v_actor
  );
  return jsonb_build_object(
    'runId',v_run_id,'status',v_status,'healthy',v_status='HEALTHY',
    'issueCount',jsonb_array_length(v_issues),'criticalCount',v_critical,'warningCount',v_warning,
    'metrics',v_metrics,'issues',v_issues,'durationMs',v_duration,
    'createdAt',to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')
  );
end;
$$;

create or replace function public.get_operations_diagnostics_workspace()
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_actor text:=academy_app.settings_admin_email();v_result jsonb;
begin
  select jsonb_build_object(
    'summary',jsonb_build_object(
      'openErrors',(select count(*) from academy_app.client_error_reports where status='OPEN'),
      'errors24h',(select count(*) from academy_app.client_error_reports where created_at>=now()-interval '24 hours'),
      'diagnosticRuns',(select count(*) from academy_app.operation_diagnostic_runs),
      'lastRunStatus',(select status from academy_app.operation_diagnostic_runs order by created_at desc limit 1)
    ),
    'latestRun',(select jsonb_build_object(
      'runId',run_id,'status',status,'healthy',status='HEALTHY','issueCount',issue_count,
      'criticalCount',critical_count,'warningCount',warning_count,'metrics',metrics,'issues',issues,
      'durationMs',duration_ms,'actorEmail',actor_email,
      'createdAt',to_char(created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')
    ) from academy_app.operation_diagnostic_runs order by created_at desc limit 1),
    'recentRuns',(select coalesce(jsonb_agg(jsonb_build_object(
      'runId',run_id,'status',status,'issueCount',issue_count,'durationMs',duration_ms,
      'actorEmail',actor_email,'createdAt',to_char(created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')
    ) order by created_at desc),'[]'::jsonb) from(
      select * from academy_app.operation_diagnostic_runs order by created_at desc limit 12
    ) runs),
    'errors',(select coalesce(jsonb_agg(jsonb_build_object(
      'errorId',error_id,'fingerprint',fingerprint,'context',context,'code',error_code,
      'message',message,'detail',detail,'pagePath',page_path,'status',status,
      'actorEmail',actor_email,'createdAt',to_char(created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
      'resolvedAt',case when resolved_at is null then null else to_char(resolved_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS') end,
      'resolvedBy',resolved_by,'resolutionNote',resolution_note,'version',version
    ) order by created_at desc),'[]'::jsonb) from(
      select * from academy_app.client_error_reports order by created_at desc limit 80
    ) errors),
    'currentUser',jsonb_build_object('email',v_actor)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function academy_app.diagnostic_recovery_action(text) from public,anon;
grant execute on function academy_app.diagnostic_recovery_action(text) to authenticated;
revoke all on function public.report_client_error(uuid,text,text,text,text,text,text,text) from public,anon;
revoke all on function public.resolve_client_error(uuid,integer,text,uuid) from public,anon;
revoke all on function public.run_operations_diagnostics() from public,anon;
revoke all on function public.get_operations_diagnostics_workspace() from public,anon;
grant execute on function public.report_client_error(uuid,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.resolve_client_error(uuid,integer,text,uuid) to authenticated;
grant execute on function public.run_operations_diagnostics() to authenticated;
grant execute on function public.get_operations_diagnostics_workspace() to authenticated;

comment on table academy_app.operation_diagnostic_runs is 'Immutable read-only business-data diagnostic history.';
comment on table academy_app.client_error_reports is 'Sanitized client and RPC error history without business form payloads.';
comment on function public.run_operations_diagnostics() is 'Super-admin data integrity diagnostic that never mutates business records.';
comment on function public.report_client_error(uuid,text,text,text,text,text,text,text) is 'Authenticated sanitized client error recorder.';
