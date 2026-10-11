-- Guarded, transactional restore for verified logical backups.
-- A restore requires a short-lived one-time token created from a fresh preview.

create table if not exists academy_app.backup_restore_approvals(
  approval_id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check(char_length(token_hash)=32),
  backup_id uuid not null references academy_app.data_backups(backup_id),
  backup_checksum text not null check(char_length(backup_checksum)=32),
  current_checksum text not null check(char_length(current_checksum)=32),
  confirmation_text text not null,
  requested_by_auth_user_id uuid not null,
  requested_by_email text not null check(requested_by_email=lower(btrim(requested_by_email))),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check(expires_at>created_at)
);

create table if not exists academy_app.data_restore_runs(
  restore_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  backup_id uuid not null references academy_app.data_backups(backup_id),
  pre_restore_backup_id uuid not null references academy_app.data_backups(backup_id),
  source_checksum text not null check(char_length(source_checksum)=32),
  before_checksum text not null check(char_length(before_checksum)=32),
  after_checksum text not null check(char_length(after_checksum)=32),
  restored_rows integer not null check(restored_rows>=0),
  changed_tables integer not null check(changed_tables>=0),
  status text not null default 'COMPLETED' check(status='COMPLETED'),
  created_by_auth_user_id uuid not null,
  created_by_email text not null check(created_by_email=lower(btrim(created_by_email))),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

create index if not exists academy_backup_restore_approvals_expiry_idx
  on academy_app.backup_restore_approvals(expires_at) where used_at is null;
create index if not exists academy_data_restore_runs_created_idx
  on academy_app.data_restore_runs(created_at desc);

alter table academy_app.backup_restore_approvals enable row level security;
alter table academy_app.backup_restore_approvals force row level security;
alter table academy_app.data_restore_runs enable row level security;
alter table academy_app.data_restore_runs force row level security;
revoke all on table academy_app.backup_restore_approvals from public,anon,authenticated;
revoke all on table academy_app.data_restore_runs from public,anon,authenticated;

create policy academy_data_restore_runs_admin_read on academy_app.data_restore_runs
for select to authenticated using((select academy_app.is_super_admin()));
grant select on table academy_app.data_restore_runs to authenticated;

create or replace function academy_app.prepare_data_backup_restore_internal(p_backup_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog set statement_timeout='25s' as $$
declare
  v_uid uuid:=auth.uid();v_actor text:=academy_app.settings_admin_email();
  v_backup academy_app.data_backups%rowtype;v_blob academy_app.backup_blobs%rowtype;
  v_current jsonb;v_current_manifest jsonb;v_tables jsonb;v_token text;
  v_confirmation text;v_expires timestamptz:=now()+interval '5 minutes';
begin
  if p_backup_id is null then raise exception using errcode='22023',message='복원할 백업 ID가 필요합니다.'; end if;
  select b.* into v_backup from academy_app.data_backups b where b.backup_id=p_backup_id and b.status='VERIFIED';
  if not found then raise exception using errcode='P0002',message='검증된 백업을 찾을 수 없습니다.'; end if;
  select blob.* into v_blob from academy_app.backup_blobs blob where blob.checksum=v_backup.checksum;
  if not found or md5(v_blob.payload::text)<>v_blob.checksum
    or academy_app.backup_manifest(v_blob.payload)<>v_blob.manifest then
    raise exception using errcode='P0001',message='백업 무결성 검증에 실패했습니다. 다시 검증해주세요.';
  end if;
  if coalesce((v_blob.manifest->>'schemaVersion')::integer,0)<>1
    or coalesce((v_blob.manifest->>'tableCount')::integer,0)<>27 then
    raise exception using errcode='P0001',message='현재 프로그램에서 복원할 수 없는 백업 형식입니다.';
  end if;
  if not exists(
    select 1 from jsonb_array_elements(v_blob.payload->'tables'->'user_access') item
    where lower(btrim(item->>'email'))=v_actor and item->>'role'='SUPER_ADMIN'
      and coalesce((item->>'active')::boolean,false)
  ) then
    raise exception using errcode='42501',message='이 백업에는 현재 최고 관리자 계정이 없어 복원할 수 없습니다.';
  end if;
  if not exists(
    select 1 from jsonb_array_elements(v_blob.payload->'tables'->'user_access') item
    where item->>'role'='SUPER_ADMIN' and coalesce((item->>'active')::boolean,false)
      and coalesce((item->>'protected_account')::boolean,false)
  ) then
    raise exception using errcode='42501',message='보호된 최고 관리자 계정이 없는 백업은 복원할 수 없습니다.';
  end if;
  v_current:=academy_app.build_backup_payload();
  v_current_manifest:=academy_app.backup_manifest(v_current);
  select coalesce(jsonb_agg(jsonb_build_object(
    'table',table_key,
    'currentRows',coalesce((v_current_manifest->'tables'->>table_key)::integer,0),
    'backupRows',coalesce((v_blob.manifest->'tables'->>table_key)::integer,0),
    'changed',coalesce(v_current->'tables'->table_key,'[]'::jsonb)<>coalesce(v_blob.payload->'tables'->table_key,'[]'::jsonb)
  ) order by table_key),'[]'::jsonb) into v_tables
  from jsonb_object_keys(v_blob.manifest->'tables') as keys(table_key);
  update academy_app.backup_restore_approvals
    set used_at=now()
    where requested_by_auth_user_id=v_uid and used_at is null;
  v_token:=gen_random_uuid()::text||gen_random_uuid()::text;
  v_confirmation:='백업 복원 '||substr(v_blob.checksum,1,8);
  insert into academy_app.backup_restore_approvals(
    token_hash,backup_id,backup_checksum,current_checksum,confirmation_text,
    requested_by_auth_user_id,requested_by_email,expires_at
  ) values(
    md5(v_token),p_backup_id,v_blob.checksum,md5(v_current::text),v_confirmation,
    v_uid,v_actor,v_expires
  );
  return jsonb_build_object(
    'backupId',p_backup_id,'backupChecksum',v_blob.checksum,'currentChecksum',md5(v_current::text),
    'matchesCurrent',md5(v_current::text)=v_blob.checksum,
    'changedTables',(select count(*) from jsonb_array_elements(v_tables) item where (item->>'changed')::boolean),
    'tables',v_tables,'currentManifest',v_current_manifest,'backupManifest',v_blob.manifest,
    'restoreToken',v_token,'confirmationText',v_confirmation,
    'expiresAt',to_char(v_expires at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    'previewedBy',v_actor
  );
end;
$$;

create or replace function public.prepare_data_backup_restore(p_backup_id uuid)
returns jsonb language sql volatile security invoker set search_path=pg_catalog as $$
  select academy_app.prepare_data_backup_restore_internal(p_backup_id)
$$;

create or replace function academy_app.execute_data_backup_restore_internal(
  p_backup_id uuid,p_restore_token text,p_confirmation_text text,p_request_id uuid
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog set statement_timeout='90s' set lock_timeout='5s' as $$
declare
  v_uid uuid:=auth.uid();v_actor text:=academy_app.settings_admin_email();
  v_existing academy_app.data_restore_runs%rowtype;v_approval academy_app.backup_restore_approvals%rowtype;
  v_backup academy_app.data_backups%rowtype;v_blob academy_app.backup_blobs%rowtype;
  v_before jsonb;v_before_manifest jsonb;v_before_checksum text;v_after jsonb;v_after_checksum text;
  v_pre_backup_id uuid;v_months integer;v_changed integer;v_restore academy_app.data_restore_runs%rowtype;
begin
  if p_request_id is null then raise exception using errcode='22023',message='복원 요청 ID가 필요합니다.'; end if;
  select * into v_existing from academy_app.data_restore_runs where request_id=p_request_id;
  if found then
    return jsonb_build_object('restoreId',v_existing.restore_id,'duplicateRequest',true,'status',v_existing.status,
      'backupId',v_existing.backup_id,'preRestoreBackupId',v_existing.pre_restore_backup_id,
      'afterChecksum',v_existing.after_checksum,'restoredRows',v_existing.restored_rows);
  end if;
  if coalesce(p_restore_token,'')='' then raise exception using errcode='22023',message='복원 승인값이 필요합니다.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('academy_app.data_backup_restore',0));
  select * into v_approval from academy_app.backup_restore_approvals
    where token_hash=md5(p_restore_token) and backup_id=p_backup_id
      and requested_by_auth_user_id=v_uid and requested_by_email=v_actor
      and used_at is null and expires_at>now()
    for update;
  if not found then raise exception using errcode='42501',message='복원 승인이 만료되었거나 이미 사용되었습니다. 영향을 다시 확인해주세요.'; end if;
  if btrim(coalesce(p_confirmation_text,''))<>v_approval.confirmation_text then
    raise exception using errcode='22023',message='복원 확인 문구가 일치하지 않습니다.';
  end if;
  select b.* into v_backup from academy_app.data_backups b where b.backup_id=p_backup_id and b.status='VERIFIED' for update;
  if not found then raise exception using errcode='P0002',message='검증된 백업을 찾을 수 없습니다.'; end if;
  select blob.* into v_blob from academy_app.backup_blobs blob where blob.checksum=v_backup.checksum;
  if not found or v_blob.checksum<>v_approval.backup_checksum
    or md5(v_blob.payload::text)<>v_blob.checksum
    or academy_app.backup_manifest(v_blob.payload)<>v_blob.manifest then
    raise exception using errcode='P0001',message='백업 무결성 또는 승인 정보가 변경되었습니다.';
  end if;

  lock table
    academy_app.teachers,academy_app.user_access,academy_app.students,academy_app.student_timeline_events,
    academy_app.payments,academy_app.payment_requests,academy_app.payment_request_events,academy_app.payment_revisions,
    academy_app.student_requests,academy_app.student_request_events,academy_app.student_revisions,
    academy_app.vacation_periods,academy_app.vacation_requests,academy_app.vacation_request_events,academy_app.vacation_revisions,
    academy_app.sibling_requests,academy_app.sibling_request_events,academy_app.sibling_revisions,
    academy_app.cash_receipt_revisions,academy_app.salary_settlements,academy_app.salary_entries,academy_app.salary_revisions,
    academy_app.operational_settings,academy_app.teacher_revisions,academy_app.settings_revisions,
    academy_app.operation_diagnostic_runs,academy_app.client_error_reports,
    academy_app.monthly_student_facts,academy_app.salary_operation_requests,
    academy_app.settings_operation_requests,academy_app.teacher_operation_requests
  in access exclusive mode;

  v_before:=academy_app.build_backup_payload();v_before_checksum:=md5(v_before::text);
  if v_before_checksum<>v_approval.current_checksum then
    raise exception using errcode='40001',message='미리보기 이후 데이터가 변경되었습니다. 복원 영향을 다시 확인해주세요.';
  end if;
  v_before_manifest:=academy_app.backup_manifest(v_before);
  select count(*) into v_changed from jsonb_object_keys(v_blob.manifest->'tables') key_name
    where coalesce(v_before->'tables'->key_name,'[]'::jsonb)<>coalesce(v_blob.payload->'tables'->key_name,'[]'::jsonb);

  insert into academy_app.backup_blobs(checksum,payload,manifest,payload_bytes)
  values(v_before_checksum,v_before,v_before_manifest,octet_length(v_before::text)) on conflict(checksum) do nothing;
  select coalesce(value_text::integer,3) into v_months from academy_app.operational_settings where setting_key='BACKUP_RETENTION_MONTHS';
  insert into academy_app.data_backups(
    request_id,backup_type,label,checksum,created_by_auth_user_id,created_by_email,expires_at
  ) values(
    p_request_id,'PRE_RESTORE','복원 직전 자동 백업',v_before_checksum,v_uid,v_actor,
    now()+make_interval(months=>greatest(1,least(coalesce(v_months,3),24)))
  ) returning backup_id into v_pre_backup_id;

  truncate table
    academy_app.payment_request_events,academy_app.payment_revisions,academy_app.payment_requests,
    academy_app.student_request_events,academy_app.student_revisions,academy_app.student_requests,
    academy_app.vacation_request_events,academy_app.vacation_revisions,academy_app.vacation_requests,
    academy_app.sibling_request_events,academy_app.sibling_revisions,academy_app.student_timeline_events,
    academy_app.cash_receipt_revisions,academy_app.monthly_student_facts,academy_app.payments,
    academy_app.vacation_periods,academy_app.students,academy_app.sibling_requests,
    academy_app.salary_entries,academy_app.salary_revisions,academy_app.salary_settlements,
    academy_app.teacher_revisions,academy_app.teachers,academy_app.user_access,
    academy_app.settings_revisions,academy_app.operational_settings,
    academy_app.operation_diagnostic_runs,academy_app.client_error_reports,
    academy_app.salary_operation_requests,academy_app.settings_operation_requests,academy_app.teacher_operation_requests;

  insert into academy_app.teachers select * from jsonb_populate_recordset(null::academy_app.teachers,v_blob.payload->'tables'->'teachers');
  insert into academy_app.user_access select * from jsonb_populate_recordset(null::academy_app.user_access,v_blob.payload->'tables'->'user_access');
  insert into academy_app.sibling_requests select * from jsonb_populate_recordset(null::academy_app.sibling_requests,v_blob.payload->'tables'->'sibling_requests');
  insert into academy_app.students select * from jsonb_populate_recordset(null::academy_app.students,v_blob.payload->'tables'->'students');
  insert into academy_app.student_timeline_events select * from jsonb_populate_recordset(null::academy_app.student_timeline_events,v_blob.payload->'tables'->'student_timeline_events');
  insert into academy_app.payments select * from jsonb_populate_recordset(null::academy_app.payments,v_blob.payload->'tables'->'payments');
  insert into academy_app.payment_requests select * from jsonb_populate_recordset(null::academy_app.payment_requests,v_blob.payload->'tables'->'payment_requests');
  insert into academy_app.payment_request_events select * from jsonb_populate_recordset(null::academy_app.payment_request_events,v_blob.payload->'tables'->'payment_request_events');
  insert into academy_app.payment_revisions select * from jsonb_populate_recordset(null::academy_app.payment_revisions,v_blob.payload->'tables'->'payment_revisions');
  insert into academy_app.student_requests select * from jsonb_populate_recordset(null::academy_app.student_requests,v_blob.payload->'tables'->'student_requests');
  insert into academy_app.student_request_events select * from jsonb_populate_recordset(null::academy_app.student_request_events,v_blob.payload->'tables'->'student_request_events');
  insert into academy_app.student_revisions select * from jsonb_populate_recordset(null::academy_app.student_revisions,v_blob.payload->'tables'->'student_revisions');
  insert into academy_app.vacation_periods select * from jsonb_populate_recordset(null::academy_app.vacation_periods,v_blob.payload->'tables'->'vacation_periods');
  insert into academy_app.vacation_requests select * from jsonb_populate_recordset(null::academy_app.vacation_requests,v_blob.payload->'tables'->'vacation_requests');
  insert into academy_app.vacation_request_events select * from jsonb_populate_recordset(null::academy_app.vacation_request_events,v_blob.payload->'tables'->'vacation_request_events');
  insert into academy_app.vacation_revisions select * from jsonb_populate_recordset(null::academy_app.vacation_revisions,v_blob.payload->'tables'->'vacation_revisions');
  insert into academy_app.sibling_request_events select * from jsonb_populate_recordset(null::academy_app.sibling_request_events,v_blob.payload->'tables'->'sibling_request_events');
  insert into academy_app.sibling_revisions select * from jsonb_populate_recordset(null::academy_app.sibling_revisions,v_blob.payload->'tables'->'sibling_revisions');
  insert into academy_app.cash_receipt_revisions select * from jsonb_populate_recordset(null::academy_app.cash_receipt_revisions,v_blob.payload->'tables'->'cash_receipt_revisions');
  insert into academy_app.salary_settlements select * from jsonb_populate_recordset(null::academy_app.salary_settlements,v_blob.payload->'tables'->'salary_settlements');
  insert into academy_app.salary_entries select * from jsonb_populate_recordset(null::academy_app.salary_entries,v_blob.payload->'tables'->'salary_entries');
  insert into academy_app.salary_revisions select * from jsonb_populate_recordset(null::academy_app.salary_revisions,v_blob.payload->'tables'->'salary_revisions');
  insert into academy_app.operational_settings select * from jsonb_populate_recordset(null::academy_app.operational_settings,v_blob.payload->'tables'->'operational_settings');
  insert into academy_app.teacher_revisions select * from jsonb_populate_recordset(null::academy_app.teacher_revisions,v_blob.payload->'tables'->'teacher_revisions');
  insert into academy_app.settings_revisions select * from jsonb_populate_recordset(null::academy_app.settings_revisions,v_blob.payload->'tables'->'settings_revisions');
  insert into academy_app.operation_diagnostic_runs select * from jsonb_populate_recordset(null::academy_app.operation_diagnostic_runs,v_blob.payload->'tables'->'operation_diagnostic_runs');
  insert into academy_app.client_error_reports select * from jsonb_populate_recordset(null::academy_app.client_error_reports,v_blob.payload->'tables'->'client_error_reports');

  v_after:=academy_app.build_backup_payload();v_after_checksum:=md5(v_after::text);
  if v_after_checksum<>v_blob.checksum then
    raise exception using errcode='P0001',message='복원 후 검증값이 백업과 일치하지 않아 모든 변경을 취소했습니다.';
  end if;
  update academy_app.backup_restore_approvals set used_at=now() where approval_id=v_approval.approval_id;
  insert into academy_app.data_restore_runs(
    request_id,backup_id,pre_restore_backup_id,source_checksum,before_checksum,after_checksum,
    restored_rows,changed_tables,created_by_auth_user_id,created_by_email
  ) values(
    p_request_id,p_backup_id,v_pre_backup_id,v_blob.checksum,v_before_checksum,v_after_checksum,
    (v_blob.manifest->>'rowCount')::integer,v_changed,v_uid,v_actor
  ) returning * into v_restore;
  return jsonb_build_object(
    'restoreId',v_restore.restore_id,'status',v_restore.status,'backupId',p_backup_id,
    'preRestoreBackupId',v_pre_backup_id,'beforeChecksum',v_before_checksum,
    'afterChecksum',v_after_checksum,'restoredRows',v_restore.restored_rows,
    'changedTables',v_changed,'duplicateRequest',false,
    'completedAt',to_char(v_restore.completed_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')
  );
end;
$$;

create or replace function public.execute_data_backup_restore(
  p_backup_id uuid,p_restore_token text,p_confirmation_text text,p_request_id uuid
)
returns jsonb language sql volatile security invoker set search_path=pg_catalog as $$
  select academy_app.execute_data_backup_restore_internal(p_backup_id,p_restore_token,p_confirmation_text,p_request_id)
$$;

create or replace function public.get_data_restore_history()
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_actor text:=academy_app.settings_admin_email();v_result jsonb;
begin
  select jsonb_build_object(
    'summary',jsonb_build_object(
      'restoreCount',(select count(*) from academy_app.data_restore_runs),
      'latestRestoreAt',(select to_char(created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS') from academy_app.data_restore_runs order by created_at desc limit 1)
    ),
    'runs',(select coalesce(jsonb_agg(jsonb_build_object(
      'restoreId',r.restore_id,'backupId',r.backup_id,'preRestoreBackupId',r.pre_restore_backup_id,
      'status',r.status,'restoredRows',r.restored_rows,'changedTables',r.changed_tables,
      'sourceChecksum',r.source_checksum,'beforeChecksum',r.before_checksum,'afterChecksum',r.after_checksum,
      'createdBy',r.created_by_email,
      'completedAt',to_char(r.completed_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')
    ) order by r.created_at desc),'[]'::jsonb) from (
      select * from academy_app.data_restore_runs order by created_at desc limit 20
    ) r),
    'currentUser',jsonb_build_object('email',v_actor)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function academy_app.prepare_data_backup_restore_internal(uuid) from public,anon;
revoke all on function academy_app.execute_data_backup_restore_internal(uuid,text,text,uuid) from public,anon;
revoke all on function public.prepare_data_backup_restore(uuid) from public,anon;
revoke all on function public.execute_data_backup_restore(uuid,text,text,uuid) from public,anon;
revoke all on function public.get_data_restore_history() from public,anon;
grant execute on function academy_app.prepare_data_backup_restore_internal(uuid) to authenticated;
grant execute on function academy_app.execute_data_backup_restore_internal(uuid,text,text,uuid) to authenticated;
grant execute on function public.prepare_data_backup_restore(uuid) to authenticated;
grant execute on function public.execute_data_backup_restore(uuid,text,text,uuid) to authenticated;
grant execute on function public.get_data_restore_history() to authenticated;

comment on table academy_app.backup_restore_approvals is 'Short-lived, one-time restore approvals stored only as token hashes.';
comment on table academy_app.data_restore_runs is 'Completed transactional restore audit history.';
comment on function public.prepare_data_backup_restore(uuid) is 'Creates a five-minute one-time approval from a fresh restore impact preview.';
comment on function public.execute_data_backup_restore(uuid,text,text,uuid) is 'Restores a verified backup atomically after an automatic pre-restore backup and checksum validation.';
