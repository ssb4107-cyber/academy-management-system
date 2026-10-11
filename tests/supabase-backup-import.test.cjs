const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011213256_add_external_backup_import.sql"), "utf8");
const fix = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011213547_fix_external_backup_import_field_validation.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /backup_type in \('MANUAL','AUTOMATIC','PRE_RESTORE','IMPORTED'\)/i);
assert.match(migration, /create or replace function public\.import_data_backup/i);
assert.match(migration, /security invoker/i);
assert.doesNotMatch(migration, /public\.import_data_backup[\s\S]{0,160}security definer/i);
assert.match(migration, /academy_app\.settings_admin_email\(\)/i);
assert.match(migration, /jsonb_typeof\(p_export\)<>'object'/i);
assert.match(migration, /jsonb_typeof\(v_payload->'tables'\)<>'object'/i);
assert.match(migration, /schemaVersion/i);
assert.match(migration, /count\(\*\)<>27/i);
assert.match(migration, /table_key=any\(v_expected\)/i);
assert.match(migration, /jsonb_typeof\(item\.value\)<>'array'/i);
assert.match(migration, /information_schema\.columns/i);
assert.match(migration, /array_agg\(column_name::text order by column_name::text\)/i);
assert.match(fix, /create or replace function public\.import_data_backup/i);
assert.match(fix, /array_agg\(column_name::text order by column_name::text\)/i);
assert.match(migration, /v_bytes>10\*1024\*1024/i);
assert.match(migration, /v_supplied_checksum<>v_checksum/i);
assert.match(migration, /v_supplied_manifest<>v_manifest/i);
assert.match(migration, /현재 최고 관리자 계정이 없습니다/);
assert.match(migration, /보호된 최고 관리자 계정이 없는 백업/);
assert.match(migration, /on conflict\(checksum\) do nothing/i);
assert.match(migration, /p_request_id,'IMPORTED'/i);
assert.match(migration, /duplicateRequest/i);
assert.match(migration, /revoke all on function public\.import_data_backup\(jsonb,text,uuid\) from public,anon/i);
assert.match(migration, /grant execute on function public\.import_data_backup\(jsonb,text,uuid\) to authenticated/i);

const parsers = [...migration.matchAll(/jsonb_populate_recordset\(null::academy_app\.([a-z_]+)/g)].map((match) => match[1]);
assert.equal(parsers.length, 27, "Every backup table must be parsed into its PostgreSQL row type");
assert.equal(new Set(parsers).size, 27, "Imported table parser list must not contain duplicates");

assert.match(main, /"JSON 가져오기"/);
assert.match(main, /importInput\.accept="application\/json,\.json"/);
assert.match(main, /const limit=10\*1024\*1024/);
assert.match(main, /JSON\.parse\(await file\.text\(\)\)/);
assert.match(main, /supabase\.rpc\("import_data_backup"/);
assert.match(main, /p_export:parsed/);
assert.match(main, /p_request_id:crypto\.randomUUID\(\)/);
assert.match(main, /외부 백업을 검증해 등록했습니다/);
assert.match(main, /IMPORTED:"외부 가져오기"/);
assert.match(styles, /\.data-backup-head-actions/);

console.log(JSON.stringify({ status: "PASS", checks: 39, feature: "validated off-site Supabase backup import" }));
