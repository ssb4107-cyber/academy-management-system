// 운영 데이터에 접속하지 않는 공통 용어 안내의 정적 회귀 검사.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const component = read('AppGlossary.html');
const script = component.match(/<script>([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({window:{},document:{readyState:'loading',addEventListener(){}},Set});
vm.runInContext(script, context);
const glossary = context.window.AppGlossary;
assert.ok(glossary.terms.length >= 42);
const aliases = new Map();
for (const item of glossary.terms) {
  assert.ok(item.meaning && item.example, item.term);
  for (const alias of [item.term, ...item.aliases]) {
    const key = alias.replace(/\s/g, '');
    assert.ok(!aliases.has(key) || aliases.get(key) === item.term, '뜻이 겹치는 용어: ' + key);
    aliases.set(key, item.term);
  }
}
vm.runInContext(script, context);
assert.equal(context.window.AppGlossary, glossary, '중복 포함 시 한 번만 초기화');
assert.ok(!/google\.script|fetch\s*\(|XMLHttpRequest|setInterval\s*\(/.test(script), '추가 서버 조회·주기적 순회 금지');
assert.match(component, /@media print/);
assert.match(component, /#appGlossaryDialog\[open\]\{display:flex;flex-direction:column\}/);
assert.match(component, /#appGlossaryResults\{[^}]*overflow-y:auto/);
assert.match(component, /results\.scrollTop=0/);
assert.match(read('Manual.html'), /수강료\/퇴원\/재등록 처리방법/);
assert.match(read('Manual.html'), /7월 31일까지 수강하고 8월부터 그만둔 학생의 퇴원일은 7월 31일/);
assert.match(read('Manual.html'), /이름 입력칸 하단에 붉은색 경고 문구/);
const pages = ['CashReceipt','ChangeLogViewer','DashboardUI','HelpGuide','ManagerDashboard','Manual','MyRequestStatus','PaymentChecklist','PaymentEdit','SalaryDashboard','SettingsDashboard','SiblingManager','StatisticsDashboard','StudentAddUI','StudentEdit','StudentRosterPrint','StudentVacation','TeacherManagement','TrashManager'];
for (const name of pages) {
  const html = read(name + '.html');
  assert.equal((html.match(/includeHtml_\("AppGlossary"\)/g)||[]).length, 1, name);
  assert.ok(html.lastIndexOf('includeHtml_("AppGlossary")') < html.lastIndexOf('</body>'), name);
}
assert.ok(!read('DashboardUtilityModule.html').includes('includeHtml_("AppGlossary")'));
assert.match(read('모바일 구현.js'), /\$\{appGlossary\}/);
for (const [file,page] of [['도움말.js','HelpGuide'],['변경이력.js','ChangeLogViewer'],['휴지통서비스.js','TrashManager']]) {
  assert.ok(read(file).includes('createTemplateFromFile'), page);
  assert.ok(!new RegExp('createHtmlOutputFromFile\\(["\\\']' + page).test(read(file)), page);
}
assert.match(read('DashboardUI.html'), /data-term="수강료 기준일">기준일<\/th>/);
console.log(JSON.stringify({status:'PASS',terms:glossary.terms.length,pages:pages.length,productionAccess:false}));
