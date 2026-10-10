const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261010014256_add_salary_management_workflow.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /create table if not exists academy_app\.salary_revisions/i);
assert.match(migration, /create table if not exists academy_app\.salary_operation_requests/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /force row level security/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /for update/i);
assert.match(migration, /p_expected_version/i);
assert.match(migration, /last_request_id/i);
assert.match(migration, /academy_salary_settlements_active_teacher_month_uidx/i);
assert.match(migration, /최고 관리자만 급여 관리를 사용할 수 있습니다/);
assert.match(migration, /revoke all on function public\.update_salary_settlement/i);
assert.match(migration, /grant execute on function public\.pay_salary_month/i);

assert.match(main, /"급여 관리"/);
assert.match(main, /supabase\.rpc\("get_salary_management_workspace"/);
assert.match(main, /supabase\.rpc\("update_salary_settlement"/);
assert.match(main, /supabase\.rpc\("pay_salary_month"/);
assert.match(main, /supabase\.rpc\("create_historical_salary_record"/);
assert.match(main, /supabase\.rpc\("cancel_salary_settlement"/);
assert.match(main, /crypto\.randomUUID\(\)/);
assert.match(styles, /\.salary-kpis/);
assert.match(styles, /\.salary-audit-row/);

console.log(JSON.stringify({ status: "PASS", checks: 21, feature: "supabase salary management" }));
