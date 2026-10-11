const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011105613_add_operations_diagnostics_and_error_history.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /create table if not exists academy_app\.operation_diagnostic_runs/i);
assert.match(migration, /create table if not exists academy_app\.client_error_reports/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /force row level security/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /actor_auth_user_id=\(select auth\.uid\(\)\)/i);
assert.match(migration, /create or replace function public\.report_client_error/i);
assert.match(migration, /create or replace function public\.resolve_client_error/i);
assert.match(migration, /create or replace function public\.run_operations_diagnostics/i);
assert.match(migration, /create or replace function public\.get_operations_diagnostics_workspace/i);
assert.match(migration, /STUDENT_TEACHER_NAME_MISMATCH/);
assert.match(migration, /ORPHAN_PAYMENT_STUDENT/);
assert.match(migration, /STALE_PROCESSING_REQUEST/);
assert.match(migration, /SALARY_BALANCE_MISMATCH/);
assert.match(migration, /statement_timeout='10s'/i);
assert.match(migration, /revoke all on function public\.report_client_error/i);
assert.match(migration, /grant execute on function public\.run_operations_diagnostics/i);

assert.match(main, /"운영 상태 진단"/);
assert.match(main, /"오류 이력 및 자력 해결"/);
assert.match(main, /supabase\.rpc\("report_client_error"/);
assert.match(main, /supabase\.rpc\("run_operations_diagnostics"/);
assert.match(main, /supabase\.rpc\("get_operations_diagnostics_workspace"/);
assert.match(main, /supabase\.rpc\("resolve_client_error"/);
assert.match(main, /window\.addEventListener\("unhandledrejection"/);
assert.match(main, /오류 ID:/);
assert.match(main, /function recoveryAdviceFor/);
assert.doesNotMatch(main, /p_(form|payload|student|payment)_data\s*:/i);

assert.match(styles, /\.operations-summary-grid/);
assert.match(styles, /\.diagnostic-issue-row/);
assert.match(styles, /\.client-error-row/);
assert.match(styles, /\.error-recovery-advice/);

console.log(JSON.stringify({ status: "PASS", checks: 31, feature: "Supabase operations diagnostics and error history" }));
