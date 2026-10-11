const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011104347_add_access_and_operational_settings_management.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /protected_account boolean not null default false/i);
assert.match(migration, /create table if not exists academy_app\.settings_revisions/i);
assert.match(migration, /create table if not exists academy_app\.settings_operation_requests/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /force row level security/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /academy_protect_user_access_row/i);
assert.match(migration, /비상 관리자 계정의 이메일·역할·사용 상태는 변경할 수 없습니다/);
assert.match(migration, /p_expected_version/i);
assert.match(migration, /PAYMENT_SILENT_DIFF_WON/);
assert.match(migration, /큰 차이 경고 기준은 완납 허용 오차보다 커야 합니다/);
assert.match(migration, /create or replace function public\.get_student_reference_data/i);
assert.match(migration, /defaultFees/);
assert.match(migration, /revoke all on function public\.save_managed_user_access/i);
assert.match(migration, /grant execute on function public\.save_operational_settings/i);

assert.match(main, /"설정·권한"/);
assert.match(main, /supabase\.rpc\("get_access_settings_workspace"/);
assert.match(main, /supabase\.rpc\("save_managed_user_access"/);
assert.match(main, /supabase\.rpc\("save_operational_settings"/);
assert.match(main, /state\.studentReference\?\.defaultFees/);
assert.match(main, /p_request_id:crypto\.randomUUID\(\)/);
assert.match(styles, /\.operational-settings-grid/);
assert.match(styles, /\.access-permission-grid/);

console.log(JSON.stringify({ status: "PASS", checks: 23, feature: "supabase access and operational settings" }));
