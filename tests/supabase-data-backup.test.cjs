const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011211439_add_verified_data_backup_workspace.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /create table if not exists academy_app\.backup_blobs/i);
assert.match(migration, /create table if not exists academy_app\.data_backups/i);
assert.match(migration, /checksum text primary key/i);
assert.match(migration, /references academy_app\.backup_blobs\(checksum\)/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /force row level security/i);
assert.match(migration, /create or replace function academy_app\.build_backup_payload/i);
assert.match(migration, /create or replace function academy_app\.backup_manifest/i);
assert.match(migration, /create or replace function public\.create_verified_data_backup/i);
assert.match(migration, /create or replace function public\.verify_data_backup/i);
assert.match(migration, /create or replace function public\.preview_data_backup_restore/i);
assert.match(migration, /create or replace function public\.download_data_backup/i);
assert.match(migration, /create or replace function academy_app\.run_scheduled_backup/i);
assert.match(migration, /security definer/i);
assert.match(migration, /revoke all on function academy_app\.run_scheduled_backup\(\) from public,anon,authenticated/i);
assert.match(migration, /create extension if not exists pg_cron/i);
assert.match(migration, /academy-midnight-verified-backup/);
assert.match(migration, /'0 15 \* \* \*'/);
assert.match(migration, /BACKUP_INTERVAL_DAYS/);
assert.match(migration, /BACKUP_RETENTION_MONTHS/);
assert.match(migration, /on conflict\(checksum\) do nothing/i);
assert.match(migration, /monthly_student_facts/i, "The migration should document or reference the derived snapshot decision");
assert.doesNotMatch(migration, /'monthly_student_facts'\s*,\s*\(select/i, "Derived monthly facts must not be copied into logical backups");

assert.match(main, /"검증 백업 및 외부 보관"/);
assert.match(main, /supabase\.rpc\("get_data_backup_workspace"/);
assert.match(main, /supabase\.rpc\("create_verified_data_backup"/);
assert.match(main, /supabase\.rpc\("verify_data_backup"/);
assert.match(main, /supabase\.rpc\("preview_data_backup_restore"/);
assert.match(main, /supabase\.rpc\("download_data_backup"/);
assert.match(main, /new Blob\(\[JSON\.stringify/);
assert.match(styles, /\.data-backup-row/);
assert.match(styles, /\.backup-preview-box/);

console.log(JSON.stringify({ status: "PASS", checks: 32, feature: "verified deduplicated Supabase data backups" }));
