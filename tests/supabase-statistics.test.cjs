const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261010013129_add_period_statistics_read_model.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /create table if not exists academy_app\.monthly_student_facts/i);
assert.match(migration, /create table if not exists academy_app\.salary_settlements/i);
assert.match(migration, /create table if not exists academy_app\.salary_entries/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /force row level security/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /u\.role='SUPER_ADMIN'/i);
assert.match(migration, /최대 36개월/);
assert.match(migration, /source','SUPABASE_STORED_SNAPSHOT'/i);
assert.match(migration, /revoke all on function public\.get_period_statistics\(text,text,text\) from public,anon/i);
assert.match(migration, /grant execute on function public\.get_statistics_overview\(\) to authenticated/i);

assert.match(main, /"기간 통계"/);
assert.match(main, /supabase\.rpc\("get_statistics_overview"\)/);
assert.match(main, /supabase\.rpc\("get_period_statistics"/);
assert.match(main, /openStudent\(item\.studentId/);
assert.match(main, /downloadStatisticsCsv/);
assert.match(main, /PAY_DATE/);
assert.match(main, /ATTRIBUTION/);
assert.match(styles, /\.statistics-kpis/);
assert.match(styles, /\.statistics-dimension-grid/);

console.log(JSON.stringify({ status: "PASS", checks: 20, feature: "supabase period statistics" }));
