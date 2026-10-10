-- Preserve the already existing Google event history alongside new Supabase
-- revisions. Historical rows have no Supabase Auth user id, so provenance is
-- carried by source_system/source_event_id and the original actor email.

alter table academy_app.cash_receipt_revisions
  alter column actor_auth_user_id drop not null,
  add column if not exists source_system text not null default 'SUPABASE'
    check (source_system in ('GOOGLE_SNAPSHOT','SUPABASE')),
  add column if not exists source_event_id text;

create unique index if not exists academy_cash_receipt_revisions_source_event_idx
  on academy_app.cash_receipt_revisions (source_system, source_event_id)
  where source_event_id is not null;

drop policy if exists academy_cash_receipt_revision_admin_insert
  on academy_app.cash_receipt_revisions;
create policy academy_cash_receipt_revision_admin_insert
on academy_app.cash_receipt_revisions
for insert
to authenticated
with check (
  source_system = 'SUPABASE'
  and source_event_id is null
  and actor_auth_user_id = (select auth.uid())
  and actor_email = lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists (
    select 1
    from academy_app.user_access u
    where u.email = actor_email
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
);

with source_rows as (
  select
    r.record_json,
    btrim(r.record_json->>'학생ID') as student_id,
    btrim(coalesce(r.record_json->>'변경전','')) as before_text,
    btrim(coalesce(r.record_json->>'변경후','')) as after_text,
    nullif(btrim(split_part(coalesce(r.record_json->>'변경전',''),'/',1)),'') as before_number,
    nullif(btrim(split_part(coalesce(r.record_json->>'변경후',''),'/',1)),'') as after_number
  from academy_mirror.latest_sheet_rows r
  where r.sheet_name = 'DB_이벤트'
    and r.source_row_number > 1
    and btrim(coalesce(r.record_json->>'이벤트유형','')) = '현금영수증정보변경'
    and btrim(coalesce(r.record_json->>'변경항목','')) = '현금영수증'
    and btrim(coalesce(r.record_json->>'처리상태','')) = '완료'
    and nullif(btrim(r.record_json->>'이벤트ID'),'') is not null
    and nullif(btrim(r.record_json->>'학생ID'),'') is not null
), normalized as (
  select
    source_rows.*,
    case when strpos(before_text,'/') > 0
      then nullif(btrim(substr(before_text,strpos(before_text,'/')+1)),'') end as before_payer,
    case when strpos(after_text,'/') > 0
      then nullif(btrim(substr(after_text,strpos(after_text,'/')+1)),'') end as after_payer
  from source_rows
)
insert into academy_app.cash_receipt_revisions (
  student_id, action, previous_version, new_version,
  before_receipt_number, after_receipt_number,
  before_payer_name, after_payer_name,
  actor_auth_user_id, actor_email, created_at,
  source_system, source_event_id
)
select
  n.student_id,
  case when n.after_number is null then 'REMOVE'
       when n.before_number is null then 'ADD'
       else 'UPDATE' end,
  0, 1,
  n.before_number, n.after_number,
  n.before_payer, n.after_payer,
  null,
  coalesce(nullif(lower(btrim(n.record_json->>'작업자이메일')),''),'google-snapshot'),
  case when coalesce(n.record_json->>'생성일시','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
    then (n.record_json->>'생성일시')::timestamptz else now() end,
  'GOOGLE_SNAPSHOT',
  btrim(n.record_json->>'이벤트ID')
from normalized n
join academy_app.students s on s.student_id = n.student_id
on conflict (source_system, source_event_id) where source_event_id is not null do nothing;

comment on column academy_app.cash_receipt_revisions.source_system is
  'GOOGLE_SNAPSHOT for imported DB_이벤트 history; SUPABASE for new portal changes.';
