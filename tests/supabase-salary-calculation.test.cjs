const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261011100845_add_salary_calculation_finalize_print.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.match(migration, /salary_calculation_rows/);
assert.match(migration, /salary_admin_email\(\)/);
assert.match(migration, /security invoker/gi);
assert.match(migration, /record_status='ACTIVE'/);
assert.match(migration, /teacherOwnerships/);
assert.match(migration, /vacation_periods/);
assert.match(migration, /trunc\(v_share\*0\.033\)/);
assert.match(migration, /preview_salary_month/);
assert.match(migration, /finalize_salary_month/);
assert.match(migration, /salary_operation_requests/);
assert.match(migration, /previewToken/);
assert.match(migration, /get_salary_statements/);
assert.match(migration, /revoke all on function public\.finalize_salary_month/);
assert.match(migration, /grant execute on function public\.finalize_salary_month/);

assert.equal(pkg.dependencies.html2canvas, "1.4.1");
assert.equal(pkg.dependencies.jspdf, "4.2.1");
assert.match(main, /supabase\.rpc\("preview_salary_month"/);
assert.match(main, /supabase\.rpc\("finalize_salary_month"/);
assert.match(main, /supabase\.rpc\("get_salary_statements"/);
assert.match(main, /전체 원장/);
assert.match(main, /원장별 개별 PDF/);
assert.match(main, /하나의 PDF로 병합/);
assert.match(main, /페이지별 개별 PNG 이미지/);
assert.match(main, /html2canvas/);
assert.match(main, /new jsPDF/);
assert.match(styles, /@page \{ size: A4 landscape/);

console.log(JSON.stringify({ status: "PASS", checks: 26, feature: "salary calculation, finalization and output" }));
