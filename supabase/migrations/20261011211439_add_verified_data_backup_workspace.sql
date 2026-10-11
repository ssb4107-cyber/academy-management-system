-- Content-addressed, verified logical backups for Supabase-managed academy data.
-- Identical snapshots reuse one JSONB blob so frequent backups do not duplicate storage.
-- monthly_student_facts is derived and intentionally excluded because it can be regenerated.

create table if not exists academy_app.backup_blobs(
  checksum text primary key check(char_length(checksum)=32),
  schema_version integer not null default 1 check(schema_version>=1),
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  manifest jsonb not null check(jsonb_typeof(manifest)='object'),
  payload_bytes bigint not null check(payload_bytes>0),
  created_at timestamptz not null default now(),
  verified_at timestamptz not null default now()
);

create table if not exists academy_app.data_backups(
  backup_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  backup_type text not null check(backup_type in ('MANUAL','AUTOMATIC','PRE_RESTORE')),
  label text not null check(char_length(label) between 1 and 120),
  checksum text not null references academy_app.backup_blobs(checksum),
  status text not null default 'VERIFIED' check(status in ('VERIFIED','INVALID')),
  created_by_auth_user_id uuid not null,
  created_by_email text not null check(created_by_email=lower(btrim(created_by_email))),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_verified_at timestamptz not null default now()
);

create index if not exists academy_data_backups_created_idx
  on academy_app.data_backups(created_at desc);
create index if not exists academy_data_backups_expiry_idx
  on academy_app.data_backups(expires_at) where status='VERIFIED';
create index if not exists academy_data_backups_checksum_idx
  on academy_app.data_backups(checksum);

alter table academy_app.backup_blobs enable row level security;
alter table academy_app.backup_blobs force row level security;
alter table academy_app.data_backups enable row level security;
alter table academy_app.data_backups force row level security;
revoke all on table academy_app.backup_blobs from public,anon,authenticated;
revoke all on table academy_app.data_backups from public,anon,authenticated;

create policy academy_backup_blobs_admin_read on academy_app.backup_blobs
for select to authenticated using((select academy_app.is_super_admin()));
create policy academy_backup_blobs_admin_insert on academy_app.backup_blobs
for insert to authenticated with check((select academy_app.is_super_admin()));
create policy academy_backup_blobs_admin_update on academy_app.backup_blobs
for update to authenticated using((select academy_app.is_super_admin()))
with check((select academy_app.is_super_admin()));
create policy academy_data_backups_admin_read on academy_app.data_backups
for select to authenticated using((select academy_app.is_super_admin()));
create policy academy_data_backups_admin_insert on academy_app.data_backups
for insert to authenticated with check(
  created_by_auth_user_id=(select auth.uid())
  and created_by_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and (select academy_app.is_super_admin())
);
create policy academy_data_backups_admin_update on academy_app.data_backups
for update to authenticated using((select academy_app.is_super_admin()))
with check((select academy_app.is_super_admin()));

grant select,insert,update on table academy_app.backup_blobs to authenticated;
grant select,insert,update on table academy_app.data_backups to authenticated;

create or replace function academy_app.build_backup_payload()
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='15s' as $$
declare v_payload jsonb;
begin
  if auth.uid() is not null then perform academy_app.settings_admin_email();
  elsif current_user not in ('postgres','supabase_admin') then
    raise exception using errcode='42501',message='백업 생성 권한이 없습니다.';
  end if;
  select jsonb_build_object(
    'schemaVersion',1,
    'tables',jsonb_build_object(
      'teachers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.teacher_id),'[]'::jsonb) from academy_app.teachers x),
      'user_access',(select coalesce(jsonb_agg(to_jsonb(x) order by x.user_key),'[]'::jsonb) from academy_app.user_access x),
      'students',(select coalesce(jsonb_agg(to_jsonb(x) order by x.student_id),'[]'::jsonb) from academy_app.students x),
      'student_timeline_events',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_id),'[]'::jsonb) from academy_app.student_timeline_events x),
      'payments',(select coalesce(jsonb_agg(to_jsonb(x) order by x.payment_id),'[]'::jsonb) from academy_app.payments x),
      'payment_requests',(select coalesce(jsonb_agg(to_jsonb(x) order by x.request_id),'[]'::jsonb) from academy_app.payment_requests x),
      'payment_request_events',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_id),'[]'::jsonb) from academy_app.payment_request_events x),
      'payment_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.payment_revisions x),
      'student_requests',(select coalesce(jsonb_agg(to_jsonb(x) order by x.request_id),'[]'::jsonb) from academy_app.student_requests x),
      'student_request_events',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_id),'[]'::jsonb) from academy_app.student_request_events x),
      'student_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.student_revisions x),
      'vacation_periods',(select coalesce(jsonb_agg(to_jsonb(x) order by x.period_id),'[]'::jsonb) from academy_app.vacation_periods x),
      'vacation_requests',(select coalesce(jsonb_agg(to_jsonb(x) order by x.request_id),'[]'::jsonb) from academy_app.vacation_requests x),
      'vacation_request_events',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_id),'[]'::jsonb) from academy_app.vacation_request_events x),
      'vacation_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.vacation_revisions x),
      'sibling_requests',(select coalesce(jsonb_agg(to_jsonb(x) order by x.request_id),'[]'::jsonb) from academy_app.sibling_requests x),
      'sibling_request_events',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_id),'[]'::jsonb) from academy_app.sibling_request_events x),
      'sibling_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.sibling_revisions x),
      'cash_receipt_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.cash_receipt_revisions x),
      'salary_settlements',(select coalesce(jsonb_agg(to_jsonb(x) order by x.settlement_id),'[]'::jsonb) from academy_app.salary_settlements x),
      'salary_entries',(select coalesce(jsonb_agg(to_jsonb(x) order by x.entry_id),'[]'::jsonb) from academy_app.salary_entries x),
      'salary_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.salary_revisions x),
      'operational_settings',(select coalesce(jsonb_agg(to_jsonb(x) order by x.setting_key),'[]'::jsonb) from academy_app.operational_settings x),
      'teacher_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.teacher_revisions x),
      'settings_revisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_id),'[]'::jsonb) from academy_app.settings_revisions x),
      'operation_diagnostic_runs',(select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at,x.run_id),'[]'::jsonb) from academy_app.operation_diagnostic_runs x),
      'client_error_reports',(select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at,x.error_id),'[]'::jsonb) from academy_app.client_error_reports x)
    )
  ) into v_payload;
  return v_payload;
end;
$$;

create or replace function academy_app.run_scheduled_backup()
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog set statement_timeout='30s' as $$
declare
  v_last timestamptz;v_interval integer;v_months integer;v_payload jsonb;v_manifest jsonb;
  v_checksum text;v_bytes bigint;v_backup_id uuid;v_deleted integer;v_new_blob boolean:=false;
begin
  select max(created_at) into v_last from academy_app.data_backups where status='VERIFIED';
  select coalesce(value_text::integer,3) into v_interval from academy_app.operational_settings where setting_key='BACKUP_INTERVAL_DAYS';
  if v_last is not null and v_last>now()-make_interval(days=>greatest(1,least(coalesce(v_interval,3),30))) then
    return jsonb_build_object('created',false,'reason','interval_wait','lastBackupAt',v_last);
  end if;
  v_payload:=academy_app.build_backup_payload();v_manifest:=academy_app.backup_manifest(v_payload);
  if (v_manifest->>'tableCount')::integer<>27 then raise exception using errcode='P0001',message='자동 백업 대상 구성이 올바르지 않습니다.'; end if;
  v_checksum:=md5(v_payload::text);v_bytes:=octet_length(v_payload::text);
  insert into academy_app.backup_blobs(checksum,payload,manifest,payload_bytes)
  values(v_checksum,v_payload,v_manifest,v_bytes) on conflict(checksum) do nothing;
  v_new_blob:=found;
  select coalesce(value_text::integer,3) into v_months from academy_app.operational_settings where setting_key='BACKUP_RETENTION_MONTHS';
  insert into academy_app.data_backups(
    request_id,backup_type,label,checksum,created_by_auth_user_id,created_by_email,expires_at
  ) values(
    gen_random_uuid(),'AUTOMATIC','자정 자동 백업',v_checksum,'00000000-0000-4000-8000-000000000000',
    'system@supabase.local',now()+make_interval(months=>greatest(1,least(coalesce(v_months,3),24)))
  ) returning backup_id into v_backup_id;
  delete from academy_app.data_backups where expires_at<now() and backup_id<>v_backup_id;
  get diagnostics v_deleted=row_count;
  delete from academy_app.backup_blobs blob where not exists(
    select 1 from academy_app.data_backups backup where backup.checksum=blob.checksum
  );
  return jsonb_build_object('created',true,'backupId',v_backup_id,'checksum',v_checksum,
    'payloadBytes',v_bytes,'newStoredContent',v_new_blob,'expiredBackupsRemoved',v_deleted);
end;
$$;

create or replace function academy_app.backup_manifest(p_payload jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog as $$
  select jsonb_build_object(
    'schemaVersion',coalesce((p_payload->>'schemaVersion')::integer,0),
    'tableCount',count(*),
    'rowCount',coalesce(sum(jsonb_array_length(value)),0),
    'tables',coalesce(jsonb_object_agg(key,jsonb_array_length(value) order by key),'{}'::jsonb)
  )
  from jsonb_each(coalesce(p_payload->'tables','{}'::jsonb))
  where jsonb_typeof(value)='array'
$$;

create or replace function public.create_verified_data_backup(
  p_label text,p_backup_type text,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='20s' as $$
declare
  v_uid uuid:=auth.uid();v_actor text:=academy_app.settings_admin_email();
  v_label text:=left(btrim(coalesce(p_label,'')),120);
  v_type text:=upper(btrim(coalesce(p_backup_type,'MANUAL')));
  v_payload jsonb;v_manifest jsonb;v_checksum text;v_bytes bigint;v_months integer;
  v_backup academy_app.data_backups%rowtype;v_new_blob boolean:=false;v_inserted boolean:=false;
begin
  if p_request_id is null then raise exception using errcode='22023',message='요청 ID가 필요합니다.'; end if;
  select * into v_backup from academy_app.data_backups where request_id=p_request_id;
  if found then return jsonb_build_object('backupId',v_backup.backup_id,'duplicateRequest',true,'status',v_backup.status,'checksum',v_backup.checksum); end if;
  if v_type not in ('MANUAL','AUTOMATIC','PRE_RESTORE') then raise exception using errcode='22023',message='백업 종류가 올바르지 않습니다.'; end if;
  if v_label='' then v_label:=case v_type when 'MANUAL' then '수동 백업' when 'AUTOMATIC' then '자동 백업' else '복구 전 백업' end; end if;
  v_payload:=academy_app.build_backup_payload();
  v_manifest:=academy_app.backup_manifest(v_payload);
  if (v_manifest->>'tableCount')::integer<>27 then raise exception using errcode='P0001',message='백업 대상 테이블 구성이 올바르지 않습니다.'; end if;
  v_checksum:=md5(v_payload::text);v_bytes:=octet_length(v_payload::text);
  if v_bytes<=0 or md5(v_payload::text)<>v_checksum then raise exception using errcode='P0001',message='백업 내용 검증에 실패했습니다.'; end if;
  insert into academy_app.backup_blobs(checksum,payload,manifest,payload_bytes)
  values(v_checksum,v_payload,v_manifest,v_bytes) on conflict(checksum) do nothing;
  v_new_blob:=found;
  select coalesce(value_text::integer,3) into v_months from academy_app.operational_settings where setting_key='BACKUP_RETENTION_MONTHS';
  insert into academy_app.data_backups(
    request_id,backup_type,label,checksum,created_by_auth_user_id,created_by_email,expires_at
  ) values(
    p_request_id,v_type,v_label,v_checksum,v_uid,v_actor,
    now()+make_interval(months=>greatest(1,least(coalesce(v_months,3),24)))
  ) returning * into v_backup;
  v_inserted:=true;
  return jsonb_build_object(
    'backupId',v_backup.backup_id,'status',v_backup.status,'checksum',v_checksum,
    'payloadBytes',v_bytes,'manifest',v_manifest,'newStoredContent',v_new_blob,
    'duplicateRequest',not v_inserted,
    'createdAt',to_char(v_backup.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    'expiresAt',to_char(v_backup.expires_at at time zone 'Asia/Seoul','YYYY-MM-DD')
  );
end;
$$;

create or replace function public.get_data_backup_workspace()
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_actor text:=academy_app.settings_admin_email();v_result jsonb;
begin
  select jsonb_build_object(
    'summary',jsonb_build_object(
      'backupCount',(select count(*) from academy_app.data_backups),
      'verifiedCount',(select count(*) from academy_app.data_backups where status='VERIFIED'),
      'uniqueContentCount',(select count(*) from academy_app.backup_blobs),
      'storedPayloadBytes',(select coalesce(sum(payload_bytes),0) from academy_app.backup_blobs),
      'latestBackupAt',(select to_char(created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS') from academy_app.data_backups order by created_at desc limit 1),
      'databaseBytes',pg_database_size(current_database()),
      'retentionMonths',(select value_text::integer from academy_app.operational_settings where setting_key='BACKUP_RETENTION_MONTHS'),
      'intervalDays',(select value_text::integer from academy_app.operational_settings where setting_key='BACKUP_INTERVAL_DAYS')
    ),
    'backups',(select coalesce(jsonb_agg(jsonb_build_object(
      'backupId',b.backup_id,'type',b.backup_type,'label',b.label,'status',b.status,
      'checksum',b.checksum,'payloadBytes',blob.payload_bytes,'manifest',blob.manifest,
      'createdBy',b.created_by_email,
      'createdAt',to_char(b.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
      'expiresAt',to_char(b.expires_at at time zone 'Asia/Seoul','YYYY-MM-DD'),
      'lastVerifiedAt',to_char(b.last_verified_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')
    ) order by b.created_at desc),'[]'::jsonb)
      from academy_app.data_backups b join academy_app.backup_blobs blob on blob.checksum=b.checksum),
    'currentUser',jsonb_build_object('email',v_actor)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.verify_data_backup(p_backup_id uuid)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='10s' as $$
declare v_actor text:=academy_app.settings_admin_email();v_backup academy_app.data_backups%rowtype;v_blob academy_app.backup_blobs%rowtype;v_valid boolean;
begin
  select * into v_backup from academy_app.data_backups where backup_id=p_backup_id for update;
  if not found then raise exception using errcode='P0002',message='백업을 찾을 수 없습니다.'; end if;
  select * into v_blob from academy_app.backup_blobs where checksum=v_backup.checksum;
  v_valid:=found and md5(v_blob.payload::text)=v_blob.checksum and academy_app.backup_manifest(v_blob.payload)=v_blob.manifest;
  update academy_app.data_backups set status=case when v_valid then 'VERIFIED' else 'INVALID' end,last_verified_at=now()
  where backup_id=v_backup.backup_id returning * into v_backup;
  if v_valid then update academy_app.backup_blobs set verified_at=now() where checksum=v_blob.checksum; end if;
  return jsonb_build_object('backupId',v_backup.backup_id,'valid',v_valid,'status',v_backup.status,'checksum',v_backup.checksum,'manifest',v_blob.manifest);
end;
$$;

create or replace function public.preview_data_backup_restore(p_backup_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='20s' as $$
declare v_actor text:=academy_app.settings_admin_email();v_blob academy_app.backup_blobs%rowtype;v_current jsonb;v_current_manifest jsonb;v_tables jsonb;
begin
  select blob.* into v_blob from academy_app.data_backups backup
  join academy_app.backup_blobs blob on blob.checksum=backup.checksum
  where backup.backup_id=p_backup_id and backup.status='VERIFIED';
  if not found then raise exception using errcode='P0002',message='검증된 백업을 찾을 수 없습니다.'; end if;
  v_current:=academy_app.build_backup_payload();v_current_manifest:=academy_app.backup_manifest(v_current);
  select coalesce(jsonb_agg(jsonb_build_object(
    'table',table_key,
    'currentRows',coalesce((v_current_manifest->'tables'->>table_key)::integer,0),
    'backupRows',coalesce((v_blob.manifest->'tables'->>table_key)::integer,0),
    'changed',coalesce(v_current->'tables'->table_key,'[]'::jsonb)<>coalesce(v_blob.payload->'tables'->table_key,'[]'::jsonb)
  ) order by table_key),'[]'::jsonb) into v_tables
  from jsonb_object_keys(v_blob.manifest->'tables') as keys(table_key);
  return jsonb_build_object(
    'backupId',p_backup_id,'backupChecksum',v_blob.checksum,'currentChecksum',md5(v_current::text),
    'matchesCurrent',md5(v_current::text)=v_blob.checksum,
    'changedTables',(select count(*) from jsonb_array_elements(v_tables) item where (item->>'changed')::boolean),
    'tables',v_tables,'currentManifest',v_current_manifest,'backupManifest',v_blob.manifest,
    'previewedBy',v_actor
  );
end;
$$;

create or replace function public.download_data_backup(p_backup_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='20s' as $$
declare v_actor text:=academy_app.settings_admin_email();v_result jsonb;
begin
  select jsonb_build_object(
    'backupId',b.backup_id,'label',b.label,'checksum',b.checksum,'manifest',blob.manifest,
    'createdAt',to_char(b.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    'exportedAt',to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    'exportedBy',v_actor,'payload',blob.payload
  ) into v_result from academy_app.data_backups b join academy_app.backup_blobs blob on blob.checksum=b.checksum
  where b.backup_id=p_backup_id and b.status='VERIFIED';
  if v_result is null then raise exception using errcode='P0002',message='다운로드할 검증 백업을 찾을 수 없습니다.'; end if;
  return v_result;
end;
$$;

revoke all on function academy_app.build_backup_payload() from public,anon;
revoke all on function academy_app.backup_manifest(jsonb) from public,anon;
revoke all on function academy_app.run_scheduled_backup() from public,anon,authenticated;
revoke all on function public.create_verified_data_backup(text,text,uuid) from public,anon;
revoke all on function public.get_data_backup_workspace() from public,anon;
revoke all on function public.verify_data_backup(uuid) from public,anon;
revoke all on function public.preview_data_backup_restore(uuid) from public,anon;
revoke all on function public.download_data_backup(uuid) from public,anon;
grant execute on function academy_app.build_backup_payload() to authenticated;
grant execute on function academy_app.backup_manifest(jsonb) to authenticated;
grant execute on function public.create_verified_data_backup(text,text,uuid) to authenticated;
grant execute on function public.get_data_backup_workspace() to authenticated;
grant execute on function public.verify_data_backup(uuid) to authenticated;
grant execute on function public.preview_data_backup_restore(uuid) to authenticated;
grant execute on function public.download_data_backup(uuid) to authenticated;

comment on table academy_app.backup_blobs is 'Deduplicated verified logical backup payloads.';
comment on table academy_app.data_backups is 'Backup history and retention metadata referencing content-addressed payloads.';
comment on function public.preview_data_backup_restore(uuid) is 'Read-only table-level restore impact preview; does not restore data.';

create extension if not exists pg_cron with schema pg_catalog;
do $$
declare v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname='academy-midnight-verified-backup'
  loop perform cron.unschedule(v_job_id); end loop;
  perform cron.schedule(
    'academy-midnight-verified-backup',
    '0 15 * * *',
    'select academy_app.run_scheduled_backup();'
  );
end;
$$;
