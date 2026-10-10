const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261009192557_add_cash_receipt_management.sql"), "utf8");
const historyMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261009193138_import_legacy_cash_receipt_history.sql"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

assert.match(migration, /create table if not exists academy_app\.cash_receipt_revisions/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /force row level security/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /u\.role = 'SUPER_ADMIN'/i);
assert.match(migration, /p_expected_version/i);
assert.match(migration, /for update/i);
assert.match(migration, /previous_version, new_version/i);
assert.match(migration, /revoke all on function public\.get_cash_receipt_workspace\(\) from public, anon/i);
assert.match(migration, /revoke all on function public\.update_cash_receipt_target\(text,text,text,boolean,integer\) from public, anon/i);
assert.match(historyMigration, /source_system in \('GOOGLE_SNAPSHOT','SUPABASE'\)/i);
assert.match(historyMigration, /academy_cash_receipt_revisions_source_event_idx/i);
assert.match(historyMigration, /sheet_name = 'DB_이벤트'/i);
assert.match(historyMigration, /source_system = 'SUPABASE'/i);

assert.match(main, /"현금영수증"/);
assert.match(main, /supabase\.rpc\("get_cash_receipt_workspace"\)/);
assert.match(main, /supabase\.rpc\("update_cash_receipt_target"/);
assert.match(main, /openStudent\(item\.studentId/);
assert.match(main, /window\.print\(\)/);
assert.match(styles, /@media print/);
assert.match(styles, /\.receipt-print-only/);

console.log(JSON.stringify({ status: "PASS", checks: 21, feature: "supabase cash receipt management" }));
