drop policy if exists academy_sibling_request_insert on academy_app.sibling_requests;
create policy academy_sibling_request_insert on academy_app.sibling_requests
for insert to authenticated with check (
  requester_auth_user_id=(select auth.uid())
  and requester_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(
    select 1 from academy_app.user_access u
    where u.email=requester_email and u.active=true
      and (u.role='SUPER_ADMIN' or array_to_string(u.permissions,',') ~* '(^|,)[[:space:]]*SIBLING_MANAGER[[:space:]]*(,|$)')
  )
  and selected_student_ids <@ snapshot_student_ids
  and cardinality(snapshot_student_ids)=(select count(distinct snapshot_id) from unnest(snapshot_student_ids) snapshot_id)
  and cardinality(snapshot_student_ids)=(
    select count(*) from academy_app.students s where s.student_id=any(snapshot_student_ids)
  )
  and not exists(
    select 1 from academy_app.students s
    where s.student_id=any(snapshot_student_ids)
      and (
        coalesce((snapshot_versions->>s.student_id)::integer,-1)<>s.version
        or coalesce(student_names_snapshot->>s.student_id,'')<>s.student_name
      )
  )
);

drop policy if exists academy_sibling_request_event_insert on academy_app.sibling_request_events;
create policy academy_sibling_request_event_insert on academy_app.sibling_request_events
for insert to authenticated with check (
  actor_auth_user_id=(select auth.uid())
  and actor_email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  and exists(
    select 1 from academy_app.sibling_requests r
    where r.request_id=sibling_request_events.request_id
      and (
        (r.requester_auth_user_id=(select auth.uid()) and sibling_request_events.event_type in ('SUBMITTED','CANCELLED'))
        or exists(
          select 1 from academy_app.user_access u
          where u.email=actor_email and u.active=true and u.role='SUPER_ADMIN'
        )
      )
  )
);
