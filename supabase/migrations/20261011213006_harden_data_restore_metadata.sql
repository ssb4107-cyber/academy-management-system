-- Explicitly deny direct approval-table access and cover restore metadata foreign keys.
create policy academy_backup_restore_approvals_no_direct_access
on academy_app.backup_restore_approvals
for all to authenticated using(false) with check(false);

create index if not exists academy_backup_restore_approvals_backup_idx
  on academy_app.backup_restore_approvals(backup_id);
create index if not exists academy_data_restore_runs_backup_idx
  on academy_app.data_restore_runs(backup_id);
create index if not exists academy_data_restore_runs_pre_backup_idx
  on academy_app.data_restore_runs(pre_restore_backup_id);
