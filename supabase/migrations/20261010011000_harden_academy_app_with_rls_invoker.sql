-- Run public RPCs with the caller's permissions; RLS is the authorization boundary.
grant usage on schema academy_app to authenticated;
grant select on table academy_app.user_access to authenticated;
grant select on table academy_app.students to authenticated;

drop policy if exists academy_user_self_read on academy_app.user_access;
create policy academy_user_self_read
on academy_app.user_access
for select
to authenticated
using (
  active = true
  and role in ('SUPER_ADMIN', 'MANAGER')
  and email = lower(btrim(coalesce(auth.jwt()->>'email', '')))
);

drop policy if exists academy_student_scope_read on academy_app.students;
create policy academy_student_scope_read
on academy_app.students
for select
to authenticated
using (
  exists (
    select 1
    from academy_app.user_access u
    where u.active = true
      and u.role in ('SUPER_ADMIN', 'MANAGER')
      and u.email = lower(btrim(coalesce(auth.jwt()->>'email', '')))
      and (
        u.student_scope = 'ALL_STUDENTS'
        or (u.student_scope = 'LINKED_TEACHER' and students.teacher_id = u.teacher_id)
      )
  )
);

alter function public.get_my_academy_session() security invoker;
alter function public.search_my_students(text, text, integer, integer) security invoker;
alter function public.get_my_student(text) security invoker;

revoke all on schema academy_app from public, anon;
revoke all on all tables in schema academy_app from public, anon;
