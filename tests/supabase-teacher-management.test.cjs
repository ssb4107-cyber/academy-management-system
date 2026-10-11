const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011103029_add_teacher_management_workflow.sql"), "utf8");
const policyMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011103717_combine_user_access_read_policy.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /create table if not exists academy_app\.teacher_revisions/i);
assert.match(migration, /create table if not exists academy_app\.teacher_operation_requests/i);
assert.match(migration, /academy_teachers_normalized_name_uq/i);
assert.match(migration, /default_distribution_rate between 0 and 100/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /force row level security/i);
assert.match(migration, /p_expected_version/i);
assert.match(migration, /활성 사용자와 연결된 원장은 비활성화할 수 없습니다/);
assert.match(migration, /기존 원장명 변경은 학생 이력과 함께 처리해야 하므로/);
assert.match(migration, /revoke all on function public\.save_managed_teacher/i);
assert.match(migration, /grant execute on function public\.save_managed_teacher/i);
assert.match(policyMigration, /drop policy if exists academy_user_self_read/i);
assert.match(policyMigration, /create policy academy_user_self_or_admin_read/i);

assert.match(main, /"원장 관리"/);
assert.match(main, /supabase\.rpc\("get_teacher_management_workspace"/);
assert.match(main, /supabase\.rpc\("save_managed_teacher"/);
assert.match(main, /p_request_id: crypto\.randomUUID\(\)/);
assert.match(main, /state\.salaryReady = false/);
assert.match(main, /await loadStudentReferenceData\(\)/);
assert.match(styles, /\.teacher-kpis/);
assert.match(styles, /\.teacher-audit-row/);

console.log(JSON.stringify({ status: "PASS", checks: 22, feature: "supabase teacher management" }));
