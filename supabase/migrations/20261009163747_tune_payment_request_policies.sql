create index if not exists academy_payment_requests_approved_payment_idx
  on academy_app.payment_requests (approved_payment_id)
  where approved_payment_id is not null;

drop policy if exists academy_payment_request_admin_update on academy_app.payment_requests;
drop policy if exists academy_payment_request_owner_cancel on academy_app.payment_requests;

create policy academy_payment_request_update
on academy_app.payment_requests
for update
to authenticated
using (
  exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
  or (
    requester_auth_user_id = (select auth.uid())
    and status = 'PENDING'
  )
)
with check (
  exists (
    select 1 from academy_app.user_access u
    where u.email = lower(btrim(coalesce((select auth.jwt())->>'email', '')))
      and u.active = true
      and u.role = 'SUPER_ADMIN'
  )
  or (
    requester_auth_user_id = (select auth.uid())
    and status = 'CANCELLED'
  )
);
