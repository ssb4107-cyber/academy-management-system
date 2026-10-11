create or replace function public.import_data_backup(
  p_export jsonb,p_label text,p_request_id uuid
)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='30s' as $$
declare
  v_uid uuid:=auth.uid();v_actor text:=academy_app.settings_admin_email();
  v_payload jsonb;v_manifest jsonb;v_supplied_manifest jsonb;v_checksum text;v_supplied_checksum text;
  v_label text:=left(btrim(coalesce(p_label,'')),120);v_bytes bigint;v_months integer;
  v_backup academy_app.data_backups%rowtype;v_new_blob boolean:=false;v_inserted boolean:=false;
  v_expected text[]:=array[
    'cash_receipt_revisions','client_error_reports','operation_diagnostic_runs','operational_settings',
    'payment_request_events','payment_requests','payment_revisions','payments','salary_entries',
    'salary_revisions','salary_settlements','settings_revisions','sibling_request_events',
    'sibling_requests','sibling_revisions','student_request_events','student_requests',
    'student_revisions','student_timeline_events','students','teacher_revisions','teachers',
    'user_access','vacation_periods','vacation_request_events','vacation_requests','vacation_revisions'
  ]::text[];
begin
  if p_request_id is null then raise exception using errcode='22023',message='가져오기 요청 ID가 필요합니다.'; end if;
  select * into v_backup from academy_app.data_backups where request_id=p_request_id;
  if found then
    return jsonb_build_object('backupId',v_backup.backup_id,'duplicateRequest',true,
      'status',v_backup.status,'checksum',v_backup.checksum);
  end if;
  if p_export is null or jsonb_typeof(p_export)<>'object' then
    raise exception using errcode='22023',message='백업 JSON 최상위 형식이 올바르지 않습니다.';
  end if;
  v_payload:=p_export->'payload';
  v_supplied_checksum:=lower(btrim(coalesce(p_export->>'checksum','')));
  v_supplied_manifest:=p_export->'manifest';
  if v_payload is null or jsonb_typeof(v_payload)<>'object'
    or jsonb_typeof(v_payload->'tables')<>'object' then
    raise exception using errcode='22023',message='백업 JSON에 payload.tables가 없습니다.';
  end if;
  if coalesce((v_payload->>'schemaVersion')::integer,0)<>1 then
    raise exception using errcode='22023',message='현재 프로그램에서 가져올 수 없는 백업 버전입니다.';
  end if;
  if (select count(*)<>27 or coalesce(bool_and(table_key=any(v_expected)),false)=false
      from jsonb_object_keys(v_payload->'tables') keys(table_key)) then
    raise exception using errcode='22023',message='백업 대상 27개 영역 구성이 올바르지 않습니다.';
  end if;
  if exists(select 1 from jsonb_each(v_payload->'tables') item where jsonb_typeof(item.value)<>'array') then
    raise exception using errcode='22023',message='백업 영역의 행 목록 형식이 올바르지 않습니다.';
  end if;
  if exists(
    select 1
    from jsonb_each(v_payload->'tables') table_item
    cross join lateral jsonb_array_elements(table_item.value) row_item
    where jsonb_typeof(row_item)<>'object'
      or (select array_agg(field order by field) from jsonb_object_keys(row_item) fields(field))
        is distinct from
        (select array_agg(column_name::text order by column_name::text)
          from information_schema.columns
          where table_schema='academy_app' and table_name=table_item.key)
  ) then
    raise exception using errcode='22023',message='백업 행의 필드 구성이 현재 데이터 구조와 다릅니다.';
  end if;
  v_manifest:=academy_app.backup_manifest(v_payload);
  v_checksum:=md5(v_payload::text);v_bytes:=octet_length(v_payload::text);
  if v_bytes<=0 or v_bytes>10*1024*1024 then
    raise exception using errcode='22023',message='백업 파일 내용은 10MB 이하여야 합니다.';
  end if;
  if v_supplied_checksum<>v_checksum then
    raise exception using errcode='22023',message='백업 체크섬이 파일 내용과 일치하지 않습니다.';
  end if;
  if v_supplied_manifest is null or v_supplied_manifest<>v_manifest then
    raise exception using errcode='22023',message='백업 행 수 요약이 파일 내용과 일치하지 않습니다.';
  end if;

  -- Force PostgreSQL to parse every imported row into its actual table type.
  perform * from jsonb_populate_recordset(null::academy_app.teachers,v_payload->'tables'->'teachers');
  perform * from jsonb_populate_recordset(null::academy_app.user_access,v_payload->'tables'->'user_access');
  perform * from jsonb_populate_recordset(null::academy_app.students,v_payload->'tables'->'students');
  perform * from jsonb_populate_recordset(null::academy_app.student_timeline_events,v_payload->'tables'->'student_timeline_events');
  perform * from jsonb_populate_recordset(null::academy_app.payments,v_payload->'tables'->'payments');
  perform * from jsonb_populate_recordset(null::academy_app.payment_requests,v_payload->'tables'->'payment_requests');
  perform * from jsonb_populate_recordset(null::academy_app.payment_request_events,v_payload->'tables'->'payment_request_events');
  perform * from jsonb_populate_recordset(null::academy_app.payment_revisions,v_payload->'tables'->'payment_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.student_requests,v_payload->'tables'->'student_requests');
  perform * from jsonb_populate_recordset(null::academy_app.student_request_events,v_payload->'tables'->'student_request_events');
  perform * from jsonb_populate_recordset(null::academy_app.student_revisions,v_payload->'tables'->'student_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.vacation_periods,v_payload->'tables'->'vacation_periods');
  perform * from jsonb_populate_recordset(null::academy_app.vacation_requests,v_payload->'tables'->'vacation_requests');
  perform * from jsonb_populate_recordset(null::academy_app.vacation_request_events,v_payload->'tables'->'vacation_request_events');
  perform * from jsonb_populate_recordset(null::academy_app.vacation_revisions,v_payload->'tables'->'vacation_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.sibling_requests,v_payload->'tables'->'sibling_requests');
  perform * from jsonb_populate_recordset(null::academy_app.sibling_request_events,v_payload->'tables'->'sibling_request_events');
  perform * from jsonb_populate_recordset(null::academy_app.sibling_revisions,v_payload->'tables'->'sibling_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.cash_receipt_revisions,v_payload->'tables'->'cash_receipt_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.salary_settlements,v_payload->'tables'->'salary_settlements');
  perform * from jsonb_populate_recordset(null::academy_app.salary_entries,v_payload->'tables'->'salary_entries');
  perform * from jsonb_populate_recordset(null::academy_app.salary_revisions,v_payload->'tables'->'salary_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.operational_settings,v_payload->'tables'->'operational_settings');
  perform * from jsonb_populate_recordset(null::academy_app.teacher_revisions,v_payload->'tables'->'teacher_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.settings_revisions,v_payload->'tables'->'settings_revisions');
  perform * from jsonb_populate_recordset(null::academy_app.operation_diagnostic_runs,v_payload->'tables'->'operation_diagnostic_runs');
  perform * from jsonb_populate_recordset(null::academy_app.client_error_reports,v_payload->'tables'->'client_error_reports');

  if not exists(
    select 1 from jsonb_array_elements(v_payload->'tables'->'user_access') item
    where lower(btrim(item->>'email'))=v_actor and item->>'role'='SUPER_ADMIN'
      and coalesce((item->>'active')::boolean,false)
  ) then
    raise exception using errcode='42501',message='가져온 백업에는 현재 최고 관리자 계정이 없습니다.';
  end if;
  if not exists(
    select 1 from jsonb_array_elements(v_payload->'tables'->'user_access') item
    where item->>'role'='SUPER_ADMIN' and coalesce((item->>'active')::boolean,false)
      and coalesce((item->>'protected_account')::boolean,false)
  ) then
    raise exception using errcode='42501',message='보호된 최고 관리자 계정이 없는 백업은 가져올 수 없습니다.';
  end if;
  if v_label='' then v_label:='외부 JSON 가져오기'; end if;
  insert into academy_app.backup_blobs(checksum,payload,manifest,payload_bytes)
  values(v_checksum,v_payload,v_manifest,v_bytes) on conflict(checksum) do nothing;
  v_new_blob:=found;
  select coalesce(value_text::integer,3) into v_months
    from academy_app.operational_settings where setting_key='BACKUP_RETENTION_MONTHS';
  insert into academy_app.data_backups(
    request_id,backup_type,label,checksum,created_by_auth_user_id,created_by_email,expires_at
  ) values(
    p_request_id,'IMPORTED',v_label,v_checksum,v_uid,v_actor,
    now()+make_interval(months=>greatest(1,least(coalesce(v_months,3),24)))
  ) returning * into v_backup;
  v_inserted:=true;
  return jsonb_build_object(
    'backupId',v_backup.backup_id,'status',v_backup.status,'checksum',v_checksum,
    'payloadBytes',v_bytes,'manifest',v_manifest,'newStoredContent',v_new_blob,
    'duplicateRequest',not v_inserted,
    'importedAt',to_char(v_backup.created_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    'expiresAt',to_char(v_backup.expires_at at time zone 'Asia/Seoul','YYYY-MM-DD')
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    raise exception using errcode='22023',message='백업 행의 값 또는 날짜 형식이 올바르지 않습니다.';
end;
$$;
