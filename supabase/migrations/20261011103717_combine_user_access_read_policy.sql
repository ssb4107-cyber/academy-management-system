-- Keep one permissive SELECT policy so Postgres evaluates the user-access boundary once.
drop policy if exists academy_user_self_read on academy_app.user_access;
drop policy if exists academy_user_admin_read on academy_app.user_access;

create policy academy_user_self_or_admin_read
on academy_app.user_access
for select
to authenticated
using (
  (
    active=true
    and role in ('SUPER_ADMIN','MANAGER')
    and email=lower(btrim(coalesce((select auth.jwt())->>'email','')))
  )
  or (select academy_app.is_super_admin())
);
