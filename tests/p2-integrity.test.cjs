// 운영 서비스에 접속하지 않는 로컬 회귀: node tests/p2-integrity.test.cjs
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.TZ = 'Asia/Seoul';
const root = path.resolve(__dirname, '..');
const properties = new Map();
const cache = new Map();
const propertyService = {
  getProperty: key => properties.get(key) ?? null,
  getProperties: () => Object.fromEntries(properties),
  setProperty(key, value) { properties.set(key, String(value)); return this; },
  setProperties(values) { Object.entries(values).forEach(([key, value]) => properties.set(key, String(value))); return this; },
  deleteProperty(key) { properties.delete(key); return this; }
};
properties.set('ACCESS_BOOTSTRAP_ADMINS_JSON', JSON.stringify([
  { email: 'recovery-one@example.com', displayName: '복구 관리자 1' },
  { email: 'recovery-two@example.com', displayName: '복구 관리자 2' }
]));
const cacheService = {
  get: key => cache.get(key) ?? null,
  getAll: keys => Object.fromEntries(keys.filter(key => cache.has(key)).map(key => [key, cache.get(key)])),
  put: (key, value) => cache.set(key, String(value)),
  putAll: values => Object.entries(values).forEach(([key, value]) => cache.set(key, String(value))),
  remove: key => cache.delete(key),
  removeAll: keys => keys.forEach(key => cache.delete(key))
};
function lock() {
  let held = false;
  return { hasLock: () => held, waitLock: () => { held = true; }, tryLock: () => { held = true; return true; }, releaseLock: () => { held = false; } };
}
const scriptLock = lock(), documentLock = lock();
const sheets = {};
let unexpectedSheetWrites = 0;
const spreadsheet = {
  getId: () => 'LOCAL-P2-TEST', getName: () => '[배포테스트] 로컬 모의',
  getSheetByName: name => sheets[name] || null,
  insertSheet() { unexpectedSheetWrites++; throw new Error('모의 시트 생성은 허용되지 않음'); }
};
function formatDate(date, timezone, pattern) {
  const values = { yyyy: date.getFullYear(), MM: String(date.getMonth() + 1).padStart(2, '0'),
    dd: String(date.getDate()).padStart(2, '0'), HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'), ss: String(date.getSeconds()).padStart(2, '0') };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, token => values[token]);
}
const context = vm.createContext({
  Date, console: { log() {}, warn() {}, error() {} },
  Utilities: { formatDate, getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (algorithm, value) => [...crypto.createHash(algorithm).update(Array.isArray(value) ? Buffer.from(value) : value).digest()],
    base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'), base64Encode: value => Buffer.from(value).toString('base64') },
  Session: { getScriptTimeZone: () => 'Asia/Seoul', getActiveUser: () => ({ getEmail: () => '' }),
    getEffectiveUser: () => ({ getEmail: () => '' }), getTemporaryActiveUserKey: () => 'LOCAL-SESSION' },
  PropertiesService: { getScriptProperties: () => propertyService, getUserProperties: () => propertyService },
  CacheService: { getScriptCache: () => cacheService, getUserCache: () => cacheService, getDocumentCache: () => cacheService },
  LockService: { getScriptLock: () => scriptLock, getDocumentLock: () => documentLock },
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
  ScriptApp: { EventType: { ON_CHANGE: 'ON_CHANGE', CLOCK: 'CLOCK' }, getProjectTriggers: () => [] }
});
const sourceFiles = fs.readdirSync(root)
  .filter(name => name.endsWith('.js') && name !== 'vite.config.js')
  .sort();
sourceFiles.forEach(name => new vm.Script(fs.readFileSync(path.join(root, name), 'utf8'), { filename: name }).runInContext(context));
const dashboardPaymentHtml = fs.readFileSync(path.join(root, 'DashboardPaymentModule.html'), 'utf8');
const dashboardCoreHtml = fs.readFileSync(path.join(root, 'DashboardCoreModule.html'), 'utf8');
const dashboardApprovalHtml = fs.readFileSync(path.join(root, 'DashboardApprovalModule.html'), 'utf8');
const dashboardUiHtml = fs.readFileSync(path.join(root, 'DashboardUI.html'), 'utf8');
const managerDashboardHtml = fs.readFileSync(path.join(root, 'ManagerDashboard.html'), 'utf8');
const authServiceSource = fs.readFileSync(path.join(root, '인증서비스.js'), 'utf8');
const authGatewayHtml = fs.readFileSync(path.join(root, 'AuthGateway.html'), 'utf8');
const accessRequestGatewayHtml = fs.readFileSync(path.join(root, 'AccessRequestGateway.html'), 'utf8');
const myRequestStatusHtml = fs.readFileSync(path.join(root, 'MyRequestStatus.html'), 'utf8');
const changeRequestServiceSource = fs.readFileSync(path.join(root, '작업요청서비스.js'), 'utf8');
const trashManagerHtml = fs.readFileSync(path.join(root, 'TrashManager.html'), 'utf8');
const changeLogViewerHtml = fs.readFileSync(path.join(root, 'ChangeLogViewer.html'), 'utf8');
const studentInfoModalHtml = fs.readFileSync(path.join(root, 'StudentInfoModalCommon.html'), 'utf8');
const settingsDashboardHtml = fs.readFileSync(path.join(root, 'SettingsDashboard.html'), 'utf8');
const salaryCommonHtml = fs.readFileSync(path.join(root, 'SalaryCommonModule.html'), 'utf8');
const salaryAdminHtml = fs.readFileSync(path.join(root, 'SalaryAdminModule.html'), 'utf8');
const managedUserSettingsSource = fs.readFileSync(path.join(root, '관리자_사용자설정서비스.js'), 'utf8');
context.TeacherDirectory_buildLookup_ = () => ({ list: [], byId: {}, byName: {} });
let integrationAssertions = 0;
const originalAssertEqual = context.assertEqual_;
context.assertEqual_ = (...args) => { integrationAssertions++; return originalAssertEqual(...args); };
assert.equal(context.runIntegrationRegressionTests_(), '통합 회귀 테스트 통과');

let targetedChecks = 0;
function check(label, fn) {
  try { fn(); targetedChecks++; } catch (error) { error.message = label + ': ' + error.message; throw error; }
}
function overrides(values, fn) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, context[key]]));
  Object.assign(context, values);
  try { return fn(); } finally { Object.assign(context, before); }
}
const names = context.SHEET_NAMES, idx = context.IDX;
function resetData() {
  properties.clear(); cache.clear(); Object.keys(sheets).forEach(name => delete sheets[name]); unexpectedSheetWrites = 0;
  context.QueryResultCache_runtime_ = {};
  context.DataRepository_runtimeRows_ = {};
}
function makeSheet(name, headers, sheetId = 42) {
  const rows = [Array.from(headers), Array(headers.length).fill('')];
  let writes = 0;
  return {
    rows, writes: () => writes, getName: () => name, getSheetId: () => sheetId,
    getMaxColumns: () => Math.max(headers.length, 1), getLastColumn: () => headers.length,
    getLastRow: () => rows.length, getMaxRows: () => 100,
    getRange(row, column, count, width) {
      return { getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => rows[row - 1 + i]?.[column - 1 + j] ?? '')),
        getDisplayValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => String(rows[row - 1 + i]?.[column - 1 + j] ?? ''))),
        setValues(values) { writes++; values.forEach((valuesRow, i) => { rows[row - 1 + i] ||= []; valuesRow.forEach((value, j) => { rows[row - 1 + i][column - 1 + j] = value; }); }); },
        setFontWeight() {} };
    },
    setFrozenRows() {}, appendRow(row) { writes++; rows.push(Array.from(row)); }
  };
}
function baseline(entries) {
  properties.set('MANAGED_STRUCTURE_BASELINE_V1', JSON.stringify({ spreadsheetId: spreadsheet.getId(), sheets: entries }));
}
const paymentData = { requestId: 'P2-REQUEST', payDate: '2026-08-18', payMethod: '카드',
  payments: [{ studentId: 'S-P2', items: [{ month: '2026-08', type: '수강료', amount: 400000 }] }] };
const normalized = context.PaymentLifecycle_normalizeRequestForRetry_(paymentData);
const fingerprint = context.PaymentLifecycle_requestFingerprint_(normalized);
function completionRow(memo) {
  const row = [];
  row[idx.EVENT.TYPE] = '수납일괄등록'; row[idx.EVENT.STATUS] = '완료';
  row[idx.EVENT.REQUEST_ID] = paymentData.requestId; row[idx.EVENT.MEMO] = memo;
  return row;
}

resetData();
context.AccessSession_store_({ email: 'unregistered@example.com', sub: 'C-USER' }, { persistent: false });
check('C창구 세션은 현재 브라우저 캐시에서 확인', () => assert.equal(context.AccessSession_getCurrent_().email, 'unregistered@example.com'));
check('C창구 세션은 영구 속성에 저장하지 않음', () => assert.equal(
  [...properties.keys()].filter(key => key.startsWith(context.ACCESS_SESSION_PROPERTY_PREFIX)).length, 0));
context.AccessSession_clearCurrent_();
const nativeCompletionRequest = { id: 'CHGREQ-P2', category: context.UNIFIED_REQUEST_CATEGORY.CHANGE,
  type: 'STUDENT_UPDATE', targetId: 'S-P2', targetName: '테스트학생', summary: '연락처 변경',
  payloadText: '{"phone":"010-1111-2222"}', requesterEmail: 'manager@example.com',
  requesterName: '관리 원장', sourceSheet: names.REQUESTS, sourceId: 'CHGREQ-P2', effectiveDate: '2026-09-09' };
const nativeCompletionFingerprint = context.UnifiedRequest_nativeRequestFingerprint_(nativeCompletionRequest);
check('작업요청 완료 표식은 요청 원문 지문과 결속', () =>
  assert.equal(context.UnifiedRequest_nativeCompletionBinding_({ requestFingerprint: nativeCompletionFingerprint }, nativeCompletionRequest).matches, true));
check('작업요청 완료 표식은 변경된 원문 자동 복구 차단', () =>
  assert.equal(context.UnifiedRequest_nativeCompletionBinding_({ requestFingerprint: nativeCompletionFingerprint },
    { ...nativeCompletionRequest, payloadText: '{"phone":"010-9999-9999"}' }).matches, false));
check('지문 없는 과거 작업요청 완료 표식 자동 복구 차단', () =>
  assert.equal(context.UnifiedRequest_nativeCompletionBinding_({ requestId: 'CHGREQ-P2' }, nativeCompletionRequest).matches, false));
context.UnifiedRequest_storeNativeCompletion_('CHGREQ-P2', '처리 완료', 'admin@example.com', '확인', nativeCompletionFingerprint);
check('작업요청 완료 표식에 요청 지문 영속 보존', () =>
  assert.equal(context.UnifiedRequest_getNativeCompletion_('CHGREQ-P2').requestFingerprint, nativeCompletionFingerprint));
context.UnifiedRequest_clearNativeCompletion_('CHGREQ-P2');
check('동기화 완료 뒤 작업요청 완료 표식 정리', () =>
  assert.equal(context.UnifiedRequest_getNativeCompletion_('CHGREQ-P2'), null));
context.AccessSession_store_({ email: 'manager@example.com', sub: 'B-USER' }, { persistent: true });
check('A/B 허용 세션은 캐시 복구용 속성에 저장', () => assert.equal(
  [...properties.keys()].filter(key => key.startsWith(context.ACCESS_SESSION_PROPERTY_PREFIX)).length, 1));
overrides({ CacheService:{ getScriptCache:() => ({ put:() => { throw new Error('EXPECTED_CACHE_FAILURE'); } }) } }, () => {
check('원본 커밋 뒤 완료 보조 캐시 실패는 성공 흐름을 깨지 않음', () => assert.equal(
    context.markRequestCompleted_('REQ-CACHE-FAIL', { saved:true }), false));
});
const trashPaymentRow = [];
trashPaymentRow[idx.PAYMENT.ID] = 'PAY-RESTORE';
trashPaymentRow[idx.PAYMENT.STUDENT_ID] = 'S-RESTORE';
check('휴지통 수납 원문 ID·학생 결합 검증', () => assert.deepEqual(
  { ...context.PaymentLifecycle_assertTrashRowBinding_(
    names.PAYMENTS, 'PAY-RESTORE', 'S-RESTORE', trashPaymentRow) },
  { recordId:'PAY-RESTORE', studentId:'S-RESTORE' }));
check('휴지통 메타와 다른 원문 ID 복구 차단', () => assert.throws(
  () => context.PaymentLifecycle_assertTrashRowBinding_(
    names.PAYMENTS, 'PAY-OTHER', 'S-RESTORE', trashPaymentRow),
  /기록 ID와 복구 원문/));
check('휴지통 메타와 다른 학생 원문 복구 차단', () => assert.throws(
  () => context.PaymentLifecycle_assertTrashRowBinding_(
    names.PAYMENTS, 'PAY-RESTORE', 'S-OTHER', trashPaymentRow),
  /학생 정보와 복구 원문/));

const siblingRows = [[], [], [], []];
siblingRows[1][idx.STUDENT.ID] = 'S-IN'; siblingRows[1][idx.STUDENT.FAMILY_ID] = 'F-2';
siblingRows[2][idx.STUDENT.ID] = 'S-OUT'; siblingRows[2][idx.STUDENT.FAMILY_ID] = 'F-2';
siblingRows[3][idx.STUDENT.ID] = 'S-OTHER'; siblingRows[3][idx.STUDENT.FAMILY_ID] = 'F-3';
check('형제 해제 후 한 명만 남는 자동 변경 대상 확장', () => assert.deepEqual(
  Array.from(context.SiblingDomain_expandAffectedStudentIdsFromRows_(['S-IN'], 'UNGROUP', siblingRows)),
  ['S-IN', 'S-OUT']));
check('형제 그룹 설정은 선택 학생만 변경 대상으로 유지', () => assert.deepEqual(
  Array.from(context.SiblingDomain_expandAffectedStudentIdsFromRows_(['S-IN', 'S-OTHER'], 'GROUP', siblingRows)),
  ['S-IN', 'S-OTHER']));
check('형제 해제 승인 지문은 현재 가족 전체를 포함', () => assert.deepEqual(
  Array.from(context.SiblingDomain_expandSnapshotStudentIdsFromRows_(['S-IN'], 'UNGROUP', siblingRows)),
  ['S-IN', 'S-OUT']));
let siblingRequestMeta = null;
overrides({
  requireAuthorizedUser_: () => ({ email:'manager@example.com', role:context.ACCESS_CONTROL.ROLES.MANAGER,
    teacherId:'T-IN', studentScope:context.STUDENT_ACCESS_SCOPES.LINKED_TEACHER }),
  DataRepository_getRows_: sheetName => sheetName === names.STUDENTS ? siblingRows : [],
  ChangeRequest_submit_: (_type, _payload, meta) => { siblingRequestMeta = meta; return { message:'요청됨' }; }
}, () => context.updateSiblingGroup(['S-IN'], 'UNGROUP', ''));
check('관리자 형제 해제 요청이 자동 변경 대상을 범위 검사 메타에 포함', () => assert.deepEqual(
  Array.from(siblingRequestMeta.studentIds), ['S-IN', 'S-OUT']));
check('관리자 형제 해제 요청이 현재 가족 전체를 승인 지문 메타에 포함', () => assert.deepEqual(
  Array.from(siblingRequestMeta.snapshotStudentIds), ['S-IN', 'S-OUT']));
overrides({
  ChangeRequest_getStudentScopes_: () => ({
    'S-IN': { id:'S-IN', name:'범위 안 학생', teacherId:'T-IN' },
    'S-OUT': { id:'S-OUT', name:'범위 밖 형제', teacherId:'T-OUT' }
  })
}, () => check('범위 밖 자동 해제 형제는 기존 학생 범위 경계에서 차단', () => assert.throws(
  () => context.ChangeRequest_assertStudentScope_({
    email:'manager@example.com', role:context.ACCESS_CONTROL.ROLES.MANAGER,
    teacherId:'T-IN', studentScope:context.STUDENT_ACCESS_SCOPES.LINKED_TEACHER
  }, siblingRequestMeta.studentIds),
  /연결된 담당 원장의 학생만 요청/)));

resetData();
properties.set(context.ACCESS_OAUTH_CLIENT_SECRET_PROPERTY, 'LOCAL-SECRET');
const oauthScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/LOCAL/exec' }) };
overrides({ ScriptApp: oauthScriptApp }, () => {
  const first = context.AccessSession_createOAuthRequest_();
  const reused = context.AccessSession_createOAuthRequest_();
  check('OAuth 동일 세션 30초 요청 재사용', () => {
    assert.equal(reused.authorizationUrl, first.authorizationUrl); assert.equal(reused.reused, true);
  });
  const keys = context.AccessSession_oauthIssueKeys_(context.AccessSession_key_(), 'LOGIN');
  const stateFrom = request => new URL(request.authorizationUrl).searchParams.get('state');
  cache.delete(context.ACCESS_OAUTH_STATE_PREFIX + stateFrom(first)); cache.delete(keys.reuse);
  for (let i = 1; i < context.ACCESS_OAUTH_ISSUE_MAX_NEW; i++) {
    const request = context.AccessSession_createOAuthRequest_();
    cache.delete(context.ACCESS_OAUTH_STATE_PREFIX + stateFrom(request)); cache.delete(keys.reuse);
  }
  check('OAuth 60초 신규 발급 한도 초과 시 5분 차단', () => assert.throws(
    () => context.AccessSession_createOAuthRequest_(), /300초 뒤/));
  check('OAuth 로그인 차단과 계정 전환 한도 분리', () => assert.equal(
    context.AccessSession_createOAuthRequest_({ allowSessionKeyChange: true }).reused, false));
});

check('OAuth 완료 응답은 중간 화면 없이 메인 화면을 직접 렌더링', () => {
  const callbackBody = authServiceSource.match(/function AccessSession_renderOAuthCallback_\([\s\S]*?\n}/)[0];
  assert.match(callbackBody, /if \(!loginResult\.accessGranted\) return AccessSession_renderAccessRequest_/);
  assert.match(callbackBody, /return createMainMenuHtml\(\)/);
  assert.doesNotMatch(callbackBody, /메인 화면 열기|ScriptApp\.getService\(\)\.getUrl\(\)/);
});
check('iframe 로그인은 새 최상위 탭, 일반 웹앱 로그인은 현재 탭에서 시작', () => {
  assert.match(authGatewayHtml, /target="_blank" rel="noopener" onclick="if\(window\.top===window\.self\)this\.target='_self'"/);
  assert.equal((accessRequestGatewayHtml.match(/target="_blank" rel="noopener" onclick="if\(window\.top===window\.self\)this\.target='_self'"/g) || []).length, 2);
  assert.doesNotMatch(authGatewayHtml, /target="_top"/);
  assert.doesNotMatch(accessRequestGatewayHtml, /target="_top"/);
});
check('OAuth 완료 화면의 무동작 자동 이동과 내부 프레임 대체 제거', () => {
  assert.doesNotMatch(authServiceSource, /<meta http-equiv="refresh"/);
  assert.doesNotMatch(authServiceSource, /window\.top\.location|window\.location\.replace|setTimeout\(function\(\)\{try\{window\.top/);
});
check('요청 처리 카드에 CHGREQ 내부 번호를 표시하지 않음', () => {
  assert.equal((myRequestStatusHtml.match(/esc\(r\.id\)/g) || []).length, 1);
  assert.match(myRequestStatusHtml, /cancelMyOperationRequest\(btn\.dataset\.id,btn\.dataset\.category\)/);
});
check('작업 요청 완료 안내에 내부 요청번호를 표시하지 않음', () => {
  assert.doesNotMatch(changeRequestServiceSource, /요청번호:/);
  assert.match(changeRequestServiceSource, /요청 처리 현황에서 진행 상태를 확인해주세요/);
});
check('일반 요청 화면에 내부 ID와 영문 폴백을 표시하지 않음', () => {
  assert.doesNotMatch(managerDashboardHtml, /요청 ID:[\s\S]*?r\.requestId/);
  assert.doesNotMatch(myRequestStatusHtml, /\}\[v\]\|\|v/);
  assert.doesNotMatch(changeRequestServiceSource, /target:item\.targetName \|\| item\.targetId/);
});
check('휴지통과 변경 이력에 원본 ID·DB 행번호를 표시하지 않음', () => {
  assert.doesNotMatch(trashManagerHtml, /item\.recordId/);
  assert.doesNotMatch(changeLogViewerHtml, />학생ID<|>행번호<|row\.rowNumber/);
  assert.match(changeLogViewerHtml, /data-student-modal-id[^\n]*row\.studentId/);
});
check('이름·권한 누락 때 내부 코드를 사용자 문구로 대체', () => {
  assert.doesNotMatch(settingsDashboardHtml, /map\[k\]\|\|k/);
  assert.doesNotMatch(salaryCommonHtml, /adjustment\.typeText \|\| adjustment\.type|excludedStudents\[id\] \|\| id/);
  assert.doesNotMatch(managedUserSettingsSource, /throw new Error\([^\n]*(requestId|target\.requestId)/);
});
check('요청함 0건은 숨기고 대기 건수만 배지로 표시', () => {
  assert.match(dashboardUiHtml, /class="approval-queue-count" hidden>0<\/span>/);
  assert.match(dashboardUiHtml, /\.approval-queue-count\[hidden\] \{ display:none; \}/);
  assert.match(dashboardApprovalHtml, /count\.hidden = total <= 0/);
  assert.match(dashboardApprovalHtml, /대기 요청 " \+ total \+ "건/);
});

check('첨부 없는 승인 요청은 Drive 준비 생략', () => {
  const result = context.PaymentRequest_saveEvidence_('REQ-NO-EVIDENCE', '2026-08-28', [], {}, null);
  assert.equal(result.skipped, true); assert.deepEqual(Array.from(result.fileIds), []);
  assert.deepEqual(Array.from(result.evidenceIntegrity), []); assert.equal(result.folderId, '');
});
check('증빙 파일 시그니처 확인', () => {
  assert.equal(context.PaymentRequest_hasImageSignature_([0xff, 0xd8, 0xff], 'image/jpeg'), true);
  assert.equal(context.PaymentRequest_hasImageSignature_([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a], 'image/png'), true);
  assert.equal(context.PaymentRequest_hasImageSignature_([0x3c,0x73,0x63,0x72,0x69,0x70,0x74,0x3e], 'image/png'), false);
});
check('2MB 초과 증빙은 동기 예외 없이 제출 Promise에서 복구', () => {
  assert.match(dashboardPaymentHtml, /if \(validationError\) return Promise\.reject\(new Error\(validationError\)\)/);
  assert.match(managerDashboardHtml, /if\(error\)return Promise\.reject\(new Error\(error\)\)/);
});
check('두 수납 화면의 FileReader 지연은 15초 뒤 안전 중단', () => {
  assert.match(dashboardPaymentHtml, /setTimeout\(function\(\)[\s\S]*?reader\.abort\(\)[\s\S]*?15000/);
  assert.match(managerDashboardHtml, /setTimeout\(function\(\)[\s\S]*?reader\.abort\(\)[\s\S]*?15000/);
});
check('상태 옆 요청 배지는 귀속월과 무관하게 모든 대기 요청을 반영', () => {
  assert.match(fs.readFileSync(path.join(root, '납부기록.js'), 'utf8'), /all: Dashboard_allPendingPaymentsFor_/);
  assert.match(dashboardCoreHtml, /pendingPayments\.all/);
  assert.match(dashboardCoreHtml, /allPendingPayments\.length/);
});
check('증빙 요청 성능은 대상 조회·증빙·기록 단계로 분리', () => {
  assert.match(fs.readFileSync(path.join(root, '일반관리자서비스.js'), 'utf8'), /evidenceMs:[\s\S]*?writeMs:[\s\S]*?serverMs:/);
  assert.match(managerDashboardHtml, /clientAndTransportMs/);
});
check('통합·수납 요청 반려 메모는 선택 입력', () => {
  assert.match(fs.readFileSync(path.join(root, '통합요청서비스.js'), 'utf8'), /memo = optionalText_\(memo, 500\)/);
  assert.match(fs.readFileSync(path.join(root, '수납승인서비스.js'), 'utf8'), /decisionMemo = optionalText_\(decisionMemo, 300\)/);
  assert.doesNotMatch(dashboardApprovalHtml, /if\(!reason\)/);
});
check('증빙 원본은 확대·축소·화면 맞춤으로 확인', () => {
  assert.match(dashboardApprovalHtml, /changeApprovalEvidenceZoom_/);
  assert.match(dashboardApprovalHtml, /fitApprovalEvidence_/);
  assert.match(dashboardUiHtml, /approvalEvidenceZoomLabel/);
  assert.match(dashboardUiHtml, /evidence-image-viewport/);
});
let evidenceBlobs = [];
overrides({
  PaymentRequest_getEvidenceRootFolder_: () => ({ id:'ROOT' }),
  PaymentRequest_getManagerMonthFolder_: () => ({
    createFile(blob) { evidenceBlobs.push(blob); return { getId:() => 'FILE-MONTH-1', setTrashed() {} }; }
  }),
  Utilities: Object.assign({}, context.Utilities, {
    base64Decode: () => [0xff, 0xd8, 0xff, 0x00],
    newBlob: (bytes, mime, name) => ({ bytes, mime, name })
  })
}, () => {
  const result = context.PaymentRequest_saveEvidence_('PAYREQ-MONTH-DIRECT', '2026-08-28',
    [{ type:'image/jpeg', base64:'VALID' }], { email:'manager@example.com' }, null);
  check('증빙은 요청별 폴더 없이 원장 연월 폴더에 직접 저장', () => {
    assert.deepEqual(Array.from(result.fileIds), ['FILE-MONTH-1']); assert.equal(result.folderId, '');
    assert.equal(evidenceBlobs.length, 1); assert.equal(evidenceBlobs[0].name, '증빙_PAYREQ-MONTH-DIRECT_1.jpg');
    assert.deepEqual(JSON.parse(JSON.stringify(result.evidenceIntegrity)), [{
      fileId:'FILE-MONTH-1', mimeType:'image/jpeg', size:4,
      sha256:context.PaymentRequest_hashBytes_([0xff, 0xd8, 0xff, 0x00])
    }]);
  });
});

const integrityBytes = [0xff, 0xd8, 0xff, 0x00];
const integrityRow = [];
integrityRow[idx.REQUEST.ID] = 'PAYREQ-INTEGRITY';
integrityRow[idx.REQUEST.EVIDENCE_IDS] = 'FILE-INTEGRITY';
integrityRow[idx.REQUEST.PAYLOAD] = JSON.stringify({ requestId:'PAYREQ-INTEGRITY', evidenceIntegrity:[{
  fileId:'FILE-INTEGRITY', mimeType:'image/jpeg', size:integrityBytes.length,
  sha256:context.PaymentRequest_hashBytes_(integrityBytes)
}], payments:[{}] });
let liveIntegrityBytes = integrityBytes.slice();
overrides({ DriveApp:{ getFileById:() => ({ isTrashed:() => false, getName:() => 'receipt.jpg',
  getBlob:() => ({ getContentType:() => 'image/jpeg', getBytes:() => liveIntegrityBytes.slice() }) }) } }, () => {
  check('신규 증빙은 제출 당시 SHA-256과 일치할 때만 확인', () => assert.equal(
    context.PaymentApproval_loadVerifiedEvidence_(integrityRow, 'FILE-INTEGRITY').legacy, false));
  check('승인 감사용 증빙 SHA-256 목록 보존', () => {
    const verified = context.PaymentApproval_verifyAllEvidence_(integrityRow);
    assert.equal(verified.legacy, false); assert.equal(verified.count, 1);
    assert.equal(verified.files[0].sha256, context.PaymentRequest_hashBytes_(integrityBytes));
  });
  liveIntegrityBytes = [0xff, 0xd8, 0xff, 0x01];
  check('같은 파일 ID의 제출 후 내용 변경 차단', () => assert.throws(
    () => context.PaymentApproval_loadVerifiedEvidence_(integrityRow, 'FILE-INTEGRITY'), /제출 이후 변경/));
});
const legacyIntegrityRow = integrityRow.slice();
legacyIntegrityRow[idx.REQUEST.PAYLOAD] = JSON.stringify({ requestId:'PAYREQ-INTEGRITY', payments:[{}] });
liveIntegrityBytes = integrityBytes.slice();
overrides({ DriveApp:{ getFileById:() => ({ isTrashed:() => false, getName:() => 'legacy.jpg',
  getBlob:() => ({ getContentType:() => 'image/jpeg', getBytes:() => liveIntegrityBytes.slice() }) }) } }, () => {
  check('기존 무결성 표식 없는 요청은 형식 검사 후 호환 처리', () => assert.equal(
    context.PaymentApproval_loadVerifiedEvidence_(legacyIntegrityRow, 'FILE-INTEGRITY').legacy, true));
});

let forwardedEvidence = null;
const managerPayment = { role:context.ACCESS_CONTROL.ROLES.MANAGER, email:'manager@example.com',
  permissions:'PAYMENT_DASHBOARD', studentScope:context.STUDENT_ACCESS_SCOPES.ALL_STUDENTS };
overrides({ requireAuthorizedUser_: () => managerPayment, ChangeRequest_isManager_: () => true,
  AccessControl_requireStudentDataAccess_: () => true,
  ManagerPaymentRequest_submitBatch_: items => { forwardedEvidence = items[0].attachments; return [{ requestId:items[0].requestId }]; } }, () => {
  const attachments = [{ name:'receipt.png', type:'image/png', base64:'LOCAL' }];
  const result = context.processPaymentBatch({ requestId:'B-BATCH', payDate:'2026-08-28', payMethod:'카드', attachments,
    payments:[{ studentId:'S-B', items:[{ month:'2026-08', type:'수강료', amount:400000 }] }] });
  check('B통로 대시보드 증빙을 승인 요청으로 전달', () => {
    assert.equal(result.requested, true); assert.equal(forwardedEvidence, attachments);
    assert.deepEqual(Array.from(result.affectedStudentIds), ['S-B']);
  });
});

const pendingDisplayRow = [], approvedDisplayRow = [], changeDisplayRow = [];
pendingDisplayRow[idx.REQUEST.ID] = 'PAYREQ-DISPLAY'; pendingDisplayRow[idx.REQUEST.CREATED_AT] = new Date('2026-08-28T09:00:00+09:00');
pendingDisplayRow[idx.REQUEST.CATEGORY] = context.UNIFIED_REQUEST_CATEGORY.PAYMENT;
pendingDisplayRow[idx.REQUEST.STATUS] = context.PAYMENT_REQUEST_STATUS.PENDING;
pendingDisplayRow[idx.REQUEST.TARGET_ID] = 'S-DISPLAY'; pendingDisplayRow[idx.REQUEST.EVIDENCE_IDS] = 'FILE-1';
pendingDisplayRow[idx.REQUEST.PAYLOAD] = JSON.stringify({ payDate:'2026-08-28', payMethod:'카드',
  payments:[{ studentId:'S-DISPLAY', items:[{ month:'2026-08', type:'수강료', amount:410000, memo:'예정' }] }] });
approvedDisplayRow[idx.REQUEST.ID] = 'PAYREQ-OLD'; approvedDisplayRow[idx.REQUEST.CATEGORY] = context.UNIFIED_REQUEST_CATEGORY.PAYMENT;
approvedDisplayRow[idx.REQUEST.STATUS] = context.PAYMENT_REQUEST_STATUS.APPROVED;
approvedDisplayRow[idx.REQUEST.TARGET_ID] = 'S-DISPLAY'; approvedDisplayRow[idx.REQUEST.PAYLOAD] = pendingDisplayRow[idx.REQUEST.PAYLOAD];
changeDisplayRow[idx.REQUEST.ID] = 'CHGREQ-DISPLAY'; changeDisplayRow[idx.REQUEST.CATEGORY] = context.UNIFIED_REQUEST_CATEGORY.CHANGE;
changeDisplayRow[idx.REQUEST.STATUS] = context.PAYMENT_REQUEST_STATUS.PENDING; changeDisplayRow[idx.REQUEST.TARGET_ID] = 'S-DISPLAY';
const pendingDisplayMap = context.Dashboard_buildPendingPaymentMap_([pendingDisplayRow, approvedDisplayRow, changeDisplayRow]);
check('대시보드에는 승인 대기 수납 요청만 별도 예정 데이터로 전달', () => {
  const items = pendingDisplayMap['S-DISPLAY']['2026-08'];
  assert.equal(items.length, 1); assert.equal(items[0].requestId, 'PAYREQ-DISPLAY');
  assert.equal(items[0].amount, 410000); assert.equal(items[0].evidenceCount, 1);
});

const approvedCleanupRow = [], rejectedCleanupRow = [];
approvedCleanupRow[idx.REQUEST.ID] = 'PAYREQ-APPROVED'; approvedCleanupRow[idx.REQUEST.CATEGORY] = context.UNIFIED_REQUEST_CATEGORY.PAYMENT;
approvedCleanupRow[idx.REQUEST.STATUS] = context.PAYMENT_REQUEST_STATUS.APPROVED;
approvedCleanupRow[idx.REQUEST.RESULT] = JSON.stringify({ payIds:['PAY-CLEANUP'] });
rejectedCleanupRow[idx.REQUEST.ID] = 'PAYREQ-REJECTED'; rejectedCleanupRow[idx.REQUEST.CATEGORY] = context.UNIFIED_REQUEST_CATEGORY.PAYMENT;
rejectedCleanupRow[idx.REQUEST.STATUS] = context.PAYMENT_REQUEST_STATUS.REJECTED;
overrides({ requireSuperAdmin_: () => ({ email:'admin@example.com' }),
  ResolvedPaymentRequest_collectRows_: () => [{ row:approvedCleanupRow }, { row:rejectedCleanupRow }],
  ResolvedPaymentRequest_activePaymentMap_: () => ({ 'PAY-CLEANUP':true }) }, () => {
  const cleanup = context.getResolvedPaymentRequestsForCleanup();
  check('승인 완료 수납 연결 확인 후 삭제 가능', () => assert.equal(cleanup.items.find(x => x.requestId === 'PAYREQ-APPROVED').deletable, true));
  check('반려 수납 요청 삭제 가능', () => assert.equal(cleanup.items.find(x => x.requestId === 'PAYREQ-REJECTED').deletable, true));
});
overrides({ requireSuperAdmin_: () => ({ email:'admin@example.com' }),
  ResolvedPaymentRequest_cleanupOverview_: () => ({ items:[
    { requestId:'PAYREQ-APPROVED', deletable:true }, { requestId:'PAYREQ-BLOCKED', deletable:false }
  ], deletableCount:1 }),
  deleteResolvedPaymentRequests: requestIds => ({ deleted:requestIds.length, requestIds:Array.from(requestIds) }) }, () => {
  const cleared = context.deleteAllResolvedPaymentRequestsForCleanup();
  check('항목 선택 없이 정리 가능한 요청만 일괄 삭제', () => {
    assert.deepEqual(Array.from(cleared.requestIds), ['PAYREQ-APPROVED']);
    assert.equal(cleared.remainingCount, 0);
  });
});
overrides({ requireSuperAdmin_: () => ({ email:'admin@example.com' }),
  ResolvedPaymentRequest_collectRows_: () => [{ row:approvedCleanupRow }], ResolvedPaymentRequest_activePaymentMap_: () => ({}) }, () => {
  check('연결 수납이 사라진 승인 요청 삭제 차단 표시', () => assert.equal(
    context.getResolvedPaymentRequestsForCleanup().items[0].deletable, false));
});

let cleanupEvents = [], cleanupDeletes = [], cleanupInvalidations = [];
overrides({
  requireSuperAdmin_: () => ({ email:'admin@example.com' }),
  UnifiedRequest_find_: requestId => requestId === 'PAYREQ-APPROVED'
    ? { row:approvedCleanupRow, rowNumber:4 }
    : { row:rejectedCleanupRow, rowNumber:9 },
  ResolvedPaymentRequest_activePaymentMap_: () => ({ 'PAY-CLEANUP':true }),
  DataRepository_getSheet_: () => ({ name:names.REQUESTS }),
  MutationPipeline_run_: (options, executor) => executor({
    queueEvent:event => cleanupEvents.push(event),
    deleteRows:(sheet, rowNumber, count) => cleanupDeletes.push({ sheet, rowNumber, count }),
    invalidate:namesToInvalidate => cleanupInvalidations.push(...namesToInvalidate)
  })
}, () => {
  const deleted = context.deleteResolvedPaymentRequests(['PAYREQ-APPROVED', 'PAYREQ-REJECTED']);
  check('승인 완료·반려 요청 행만 일괄 삭제', () => {
    assert.equal(deleted.deleted, 2);
    assert.deepEqual(cleanupDeletes.map(item => item.rowNumber), [9, 4]);
    assert.deepEqual(cleanupDeletes.map(item => item.count), [1, 1]);
  });
  check('요청 삭제 감사 이벤트와 캐시 무효화 유지', () => {
    assert.deepEqual(cleanupEvents.map(event => event.eventType), ['수납요청기록삭제', '수납요청기록삭제']);
    assert.deepEqual(cleanupInvalidations, [names.REQUESTS, names.EVENTS]);
  });
});

const pendingCleanupRow = [];
pendingCleanupRow[idx.REQUEST.ID] = 'PAYREQ-PENDING'; pendingCleanupRow[idx.REQUEST.CATEGORY] = context.UNIFIED_REQUEST_CATEGORY.PAYMENT;
pendingCleanupRow[idx.REQUEST.STATUS] = context.PAYMENT_REQUEST_STATUS.PENDING;
overrides({ requireSuperAdmin_: () => ({ email:'admin@example.com' }),
  UnifiedRequest_find_: () => ({ row:pendingCleanupRow, rowNumber:5 }),
  MutationPipeline_run_: (options, executor) => executor({}) }, () => {
  check('대기 중인 수납 요청 삭제 차단', () => assert.throws(
    () => context.deleteResolvedPaymentRequests(['PAYREQ-PENDING']), /승인 완료 또는 반려 상태가 아닌/));
});

const deletedRequestEvent = [];
deletedRequestEvent[idx.EVENT.TYPE] = '수납요청기록삭제';
deletedRequestEvent[idx.EVENT.REQUEST_ID] = 'PAYREQ-DELETED';
overrides({ LookupIndex_findRowsForValues_: () => [{ row:deletedRequestEvent }] }, () => {
  check('삭제된 수납 요청 ID 재사용 차단 표식 조회', () => assert.equal(
    context.ManagerPaymentRequest_deletedIdMap_(['PAYREQ-DELETED'])['PAYREQ-DELETED'], true));
});

resetData();
const eventSheet = { getLastRow: () => 2 };
sheets[names.EVENTS] = eventSheet;
let eventRows = [{ row: completionRow(JSON.stringify({ requestFingerprint: fingerprint })) }];
let paymentRows = [];
overrides({ LookupIndex_findRows_: name => name === names.EVENTS ? eventRows : paymentRows }, () => {
  check('수납 시트가 없어도 완료 지문 유지', () => assert.equal(context.Mutation_findCompletedRequest_(paymentData.requestId).requestFingerprint, fingerprint));
  sheets[names.PAYMENTS] = { getLastRow: () => 1 };
  check('수납 시트에 헤더만 남아도 완료 지문 유지', () => assert.equal(context.Mutation_findCompletedRequest_(paymentData.requestId).requestFingerprint, fingerprint));
  const paymentRow = [];
  Object.assign(paymentRow, { [idx.PAYMENT.ID]: 'PAY-P2', [idx.PAYMENT.REQUEST_ID]: paymentData.requestId,
    [idx.PAYMENT.STUDENT_ID]: 'S-P2', [idx.PAYMENT.PAY_DATE]: '2026-08-18', [idx.PAYMENT.MONTH]: '2026-08',
    [idx.PAYMENT.TYPE]: '수강료', [idx.PAYMENT.AMOUNT]: 400000, [idx.PAYMENT.METHOD]: '카드',
    [idx.PAYMENT.ACTIVE_DAYS]: 0, [idx.PAYMENT.CALC_START]: new Date(2026, 7, 1), [idx.PAYMENT.RECORD_STATUS]: 'ACTIVE' });
  paymentRows = [{ row: paymentRow }]; sheets[names.PAYMENTS] = { getLastRow: () => 2 };
  const recovered = context.Mutation_findCompletedRequest_(paymentData.requestId);
  check('원본 행 재구성 후 지문 보존', () => assert.equal(recovered.requestFingerprint, fingerprint));
  check('재구성 시 적용일수 0 보존', () => assert.equal(recovered.savedRows[0].activeDays, 0));
  check('재구성 시 날짜 셀 정규화', () => assert.equal(recovered.savedRows[0].calcStart, '2026-08-01'));
  const changedBaseDay = JSON.parse(JSON.stringify(paymentData)); changedBaseDay.payments[0].newBaseDay = 21;
  const changedNormalized = context.PaymentLifecycle_normalizeRequestForRetry_(changedBaseDay);
  check('캐시 만료 후 기준일만 변경한 재시도 차단', () => assert.throws(() => context.PaymentLifecycle_assertSameCompletedRequest_(
    recovered, changedNormalized, context.PaymentLifecycle_requestFingerprint_(changedNormalized)), /이전과 다른 수납 내용/));
  paymentRows = []; delete sheets[names.PAYMENTS];
  for (const memo of ['null', '[]', '"legacy"', '{broken', '{}']) {
    eventRows = [{ row: completionRow(memo) }];
    check('자료 없는 완료 이벤트 보존 및 차단 ' + memo, () => {
      const result = context.Mutation_findCompletedRequest_(paymentData.requestId);
      assert.ok(result); assert.throws(() => context.PaymentLifecycle_assertSameCompletedRequest_(result, normalized, fingerprint), /확인 전에는 새 요청/);
    });
  }
  delete sheets[names.EVENTS];
  properties.set('PENDING_EVENT_P2', JSON.stringify(completionRow(JSON.stringify({ requestFingerprint: fingerprint }))));
  check('대기 이벤트만 남아도 완료 지문 복구', () => assert.equal(context.Mutation_findCompletedRequest_(paymentData.requestId).requestFingerprint, fingerprint));
  sheets[names.EVENTS] = eventSheet; eventRows = [{ row: completionRow('{}') }];
  check('과거 이벤트가 대기열의 새 지문을 덮어쓰지 않음', () => assert.equal(context.Mutation_findCompletedRequest_(paymentData.requestId).requestFingerprint, fingerprint));
});
overrides({ getCompletedRequest_: () => '과거 저장 완료', Mutation_findCompletedRequest_: () => null }, () => {
  check('상세 없는 완료 캐시도 성공 반환 금지', () => assert.throws(() => context.PaymentLifecycle_createBatchInTransaction_(paymentData, {}), /기록이 부족/));
});
let approvalWrites = 0;
const approvalRow = []; approvalRow[idx.REQUEST.STATUS] = 'PENDING';
overrides({ requireSuperAdmin_: () => ({ email: 'admin@example.com' }),
  MutationPipeline_run_: (options, executor) => executor({ writeRange() { approvalWrites++; }, queueEvent() { approvalWrites++; } }),
  PaymentApproval_findRequest_: () => ({ row: approvalRow }), PaymentApproval_toObject_: () => ({ requestId: paymentData.requestId }),
  PaymentApproval_parsePayload_: () => paymentData, PaymentApproval_validatePayloadAgainstRow_: value => value,
  Mutation_findCompletedRequest_: () => ({ savedRows: [] }) }, () => {
  check('승인 복구도 비교 자료 없는 표식 차단', () => assert.throws(() => context.approvePaymentApprovalRequest(paymentData.requestId, ''), /기록이 부족/));
  check('차단된 승인 상태·이벤트 쓰기 없음', () => assert.equal(approvalWrites, 0));
});

resetData();
const headers = context.DataSchema_getDefinitions_()[names.STUDENTS];
let studentSheet = makeSheet(names.STUDENTS, headers);
sheets[names.STUDENTS] = studentSheet;
studentSheet.rows[0][1] = '';
check('손상 헤더 ensure 자동 덮어쓰기 차단', () => assert.throws(() => context.DataSchema_ensureSheet_(names.STUDENTS), /저장을 중단/));
check('손상 헤더 실제 쓰기 없음', () => assert.equal(studentSheet.writes(), 0));
let executorRan = false;
check('공통 변경 파이프라인 선행 차단', () => assert.throws(() => context.MutationPipeline_run_(
  { authorizedUser: { email: 'admin@example.com', bootstrap: true } }, () => { executorRan = true; }), /저장을 중단/));
check('구조 손상 시 업무 본체 실행 안 함', () => assert.equal(executorRan, false));
check('구조 손상 시 다른 시트 생성 안 함', () => assert.equal(unexpectedSheetWrites, 0));
studentSheet.rows[0][1] = '학생명';
context.DataSchema_captureManagedStructure_();
delete sheets[names.STUDENTS];
check('등록된 시트 삭제 후 ensure 재생성 차단', () => assert.throws(() => context.DataSchema_ensureSheet_(names.STUDENTS), /삭제 또는 이름 변경/));
sheets[names.STUDENTS] = makeSheet(names.STUDENTS, headers, 43);
check('검증된 복구 전 다른 시트 ID 거부', () => assert.throws(() => context.DataSchema_assertManagedStructure_(), /시트 식별자/));
context.DataSchema_captureManagedStructure_(); // 백업 검증 후 실행하는 동일한 재등록 경로
check('검증된 복구 후 새 시트 ID 등록', () => assert.equal(context.DataSchema_assertManagedStructure_(), true));

resetData();
studentSheet = makeSheet(names.STUDENTS, headers); sheets[names.STUDENTS] = studentSheet;
context.DataSchema_captureManagedStructure_();
function trigger(id, handler = 'DataMutation_onSpreadsheetChange_', source = spreadsheet.getId(), type = 'ON_CHANGE') {
  return { getUniqueId: () => id, getHandlerFunction: () => handler, getTriggerSourceId: () => source, getEventType: () => type };
}
const changeTrigger = trigger('CHANGE-1');
let recordedEvents = [], monthlyInvalidations = 0, snapshotInvalidations = 0, settingsInvalidations = 0, homeInvalidations = 0;
const changeOverrides = {
  ScriptApp: { EventType: { ON_CHANGE: 'ON_CHANGE' }, getProjectTriggers: () => [changeTrigger] },
  getAutomationUserEmail_: () => 'bootstrap@example.com',
  Mutation_recordEvents_: events => { recordedEvents.push(...events); },
  MonthlyCache_markAllDirty_: () => { monthlyInvalidations++; },
  MonthlySnapshotStore_markAllStale_: () => { snapshotInvalidations++; },
  OperationalSettings_clearCache_: () => { settingsInvalidations++; }, markHomeDashboardDirty_: () => { homeInvalidations++; }
};
const changeEvent = { source: spreadsheet, triggerUid: 'CHANGE-1', changeType: 'REMOVE_ROW', user: { getEmail: () => 'editor@example.com' } };
overrides(changeOverrides, () => {
  check('등록되지 않은 변경 이벤트 무시', () => assert.equal(context.DataMutation_onSpreadsheetChange_({ ...changeEvent, triggerUid: 'FORGED' }).ignored, true));
  check('다른 스프레드시트 이벤트 무시', () => assert.equal(context.DataMutation_onSpreadsheetChange_({ ...changeEvent, source: { getId: () => 'OTHER' } }).ignored, true));
  context.DataMutation_onSpreadsheetChange_(changeEvent);
  check('구조 변경 시 12개 원본 세대 갱신', () => context.DataMutation_managedEditSheetNames_().forEach(name => assert.equal(properties.get(context.DataRepository_generationKey_(name)), '1')));
  check('월별·스냅샷·설정·홈 무효화', () => assert.deepEqual([monthlyInvalidations, snapshotInvalidations, settingsInvalidations, homeInvalidations], [1, 1, 1, 1]));
  check('구조 변경 감사와 실제 편집자 구분', () => {
    assert.equal(recordedEvents.length, 1); assert.equal(recordedEvents[0].eventType, '시트구조직접변경');
    assert.equal(JSON.parse(recordedEvents[0].memo).editorEmail, 'editor@example.com');
  });
  check('원본 행은 자동 복구·수정하지 않음', () => assert.equal(studentSheet.writes(), 0));
  check('정상 값 편집은 중복 구조 감사 없음', () => assert.equal(context.DataMutation_onSpreadsheetChange_({ ...changeEvent, changeType: 'EDIT' }).ignored, true));
  studentSheet.rows[0][1] = '';
  check('헤더 편집 손상 감지', () => assert.match(context.DataMutation_onSpreadsheetChange_({ ...changeEvent, changeType: 'EDIT' }).schemaError, /학생명/));
});
studentSheet.rows[0][1] = '학생명';
overrides({ ...changeOverrides, MonthlyCache_markAllDirty_: () => { throw new Error('EXPECTED_CACHE_FAILURE'); } }, () => {
  const previousEvents = recordedEvents.length;
  check('구조 변경 후 일부 캐시 실패도 보고', () => assert.throws(() => context.DataMutation_onSpreadsheetChange_(changeEvent), /EXPECTED_CACHE_FAILURE/));
  check('캐시 실패에도 감사 기록과 실패 상태 보존', () => {
    assert.equal(recordedEvents.length, previousEvents + 1);
    assert.match(JSON.parse(properties.get('MANAGED_STRUCTURE_LAST_CHANGE_V1')).errors[0], /EXPECTED_CACHE_FAILURE/);
  });
});
baseline({ [names.STUDENTS]: { sheetId: 42, columns: [1, 2] }, [names.EVENTS]: { sheetId: 99, columns: [1] } });
const pendingOverrides = { ...changeOverrides }; delete pendingOverrides.Mutation_recordEvents_;
overrides(pendingOverrides, () => {
  context.DataMutation_onSpreadsheetChange_(changeEvent);
  check('이벤트 시트 삭제 시 감사 대기열 보존', () => assert.equal([...properties.keys()].filter(key => key.startsWith('PENDING_EVENT_')).length, 1));
  check('삭제된 이벤트 시트 자동 재생성 안 함', () => assert.equal(unexpectedSheetWrites, 0));
});

resetData(); sheets[names.STUDENTS] = makeSheet(names.STUDENTS, headers);
const oldMaintenance = trigger('OLD-MAINTENANCE', 'runScheduledMaintenance', null, 'CLOCK');
const unrelated = trigger('UNRELATED', 'unrelatedHandler', null, 'CLOCK');
let liveTriggers, failChangeCreation;
const fakeScriptApp = {
  EventType: { ON_CHANGE: 'ON_CHANGE', CLOCK: 'CLOCK' }, getProjectTriggers: () => liveTriggers.slice(),
  deleteTrigger: item => { liveTriggers = liveTriggers.filter(value => value !== item); },
  newTrigger(handler) {
    const builder = { timeBased: () => builder, everyDays: () => builder, atHour: () => builder,
      forSpreadsheet: () => builder, onChange: () => builder, create() {
        if (failChangeCreation && handler === 'DataMutation_onSpreadsheetChange_') throw new Error('EXPECTED_INSTALL_FAILURE');
        const created = trigger('NEW-' + handler, handler, spreadsheet.getId(), handler === 'runScheduledMaintenance' ? 'CLOCK' : 'ON_CHANGE');
        liveTriggers.push(created); return created;
      } };
    return builder;
  }
};
overrides({ ScriptApp: fakeScriptApp, requireSpreadsheetSuperAdmin_: () => ({}), requireAutomationSuperAdmin_: () => ({}),
  OperationalSettings_getNumber_: (key, fallback) => fallback }, () => {
  liveTriggers = [oldMaintenance, unrelated]; failChangeCreation = true;
  check('구조 트리거 설치 실패 전달', () => assert.throws(() => context.installMaintenanceTrigger(), /EXPECTED_INSTALL_FAILURE/));
  check('설치 실패 때 기존 트리거 보존 및 새 트리거 정리', () => assert.deepEqual(liveTriggers, [oldMaintenance, unrelated]));
  failChangeCreation = false;
  context.installMaintenanceTrigger();
  check('두 트리거 설치 후 기존 자동 운영 교체', () => {
    assert.equal(liveTriggers.length, 3); assert.ok(liveTriggers.includes(unrelated)); assert.ok(!liveTriggers.includes(oldMaintenance));
    assert.equal(context.DataMutation_structureTriggers_(liveTriggers, spreadsheet.getId()).length, 1);
  });
  const maintenanceTrigger = liveTriggers.find(item => item.getHandlerFunction() === 'runScheduledMaintenance');
  check('등록되지 않은 시간 트리거 호출 차단', () =>
    assert.throws(() => context.Maintenance_requireRegisteredTimeTrigger_({ triggerUid: 'FORGED' }), /등록되지 않은/));
  check('등록된 시간 트리거 이벤트 허용', () =>
    assert.equal(context.Maintenance_requireRegisteredTimeTrigger_({ triggerUid: maintenanceTrigger.getUniqueId() }), undefined));
  context.installMaintenanceTrigger();
  check('재설치해도 트리거 중복 없음', () => assert.equal(liveTriggers.length, 3));
});

resetData();
const indexedSheet = makeSheet(names.STUDENTS, ['학생ID', '학생명']);
indexedSheet.rows[1] = ['S-A', 'A']; indexedSheet.rows.push(['S-B', 'B']); sheets[names.STUDENTS] = indexedSheet;
context.QueryResultCache_runtime_ = {};
context.LookupIndex_get_(names.STUDENTS, 1);
indexedSheet.rows.splice(1, 1);
check('트리거 실행 전 행 삭제에도 인덱스 재계산', () => {
  const found = context.LookupIndex_findRows_(names.STUDENTS, 1, 'S-B');
  assert.equal(found.length, 1); assert.equal(found[0].rowNumber, 2); assert.equal(found[0].row[0], 'S-B');
});
indexedSheet.rows.push(['S-A', 'A']);
context.LookupIndex_get_(names.STUDENTS, 1);
[indexedSheet.rows[1], indexedSheet.rows[2]] = [indexedSheet.rows[2], indexedSheet.rows[1]];
check('같은 행 수의 정렬 후 다른 ID 반환 방지', () => {
  const found = context.LookupIndex_findRows_(names.STUDENTS, 1, 'S-B');
  assert.equal(found.length, 1); assert.equal(found[0].rowNumber, 3); assert.equal(found[0].row[0], 'S-B');
});
indexedSheet.rows.splice(1, 0, ['S-X', 'X']);
check('트리거 실행 전 행 삽입에도 대상 행 일치', () => assert.equal(context.LookupIndex_findRows_(names.STUDENTS, 1, 'S-B')[0].rowNumber, 4));

let boundingReads = [];
let boundingRangeListReads = 0;
const boundingRows = Array.from({ length: 20 }, (_, index) => ['S-' + (index + 1), '학생' + (index + 1)]);
const boundingSheet = {
  getLastRow: () => boundingRows.length,
  getLastColumn: () => 2,
  getRange(row, column, count, width) {
    boundingReads.push([row, column, count, width]);
    return { getValues: () => boundingRows.slice(row - 1, row - 1 + count).map(item => item.slice(0, width)) };
  },
  getRangeList() {
    boundingRangeListReads++;
    return { getRanges: () => [] };
  }
};
const boundingResult = context.LookupIndex_readRows_(boundingSheet, [2, 4, 6, 8]);
check('밀집된 다중 인덱스 행은 한 번의 경계 범위로 읽음', () => {
  assert.deepEqual(boundingReads, [[2, 1, 7, 2]]);
  assert.equal(boundingRangeListReads, 0);
  assert.deepEqual(Array.from(boundingResult, item => item.rowNumber), [2, 4, 6, 8]);
});

resetData();
let repositoryGeneration = 3;
let repositoryPersistentReads = 0;
overrides({
  DataRepository_getGeneration_: () => repositoryGeneration,
  DataRepository_readCachedRows_: () => {
    repositoryPersistentReads++;
    return [['학생ID'], ['S-RUNTIME']];
  }
}, () => {
  const first = context.DataRepository_getRowsRaw_(names.STUDENTS, {});
  const second = context.DataRepository_getRowsRaw_(names.STUDENTS, {});
  check('같은 실행의 같은 세대 원본은 영구 캐시를 한 번만 해석', () => {
    assert.equal(repositoryPersistentReads, 1);
    assert.equal(first, second);
  });
  context.DataRepository_evictCache_(names.STUDENTS);
  context.DataRepository_getRowsRaw_(names.STUDENTS, {});
  check('원본 임시 캐시 제거 뒤 영구 캐시를 다시 확인', () => assert.equal(repositoryPersistentReads, 2));
  repositoryGeneration++;
  context.DataRepository_getRowsRaw_(names.STUDENTS, {});
  check('원본 세대 변경 뒤 실행 캐시 재사용 차단', () => assert.equal(repositoryPersistentReads, 3));
});

resetData();
overrides({
  DataRepository_getGeneration_: () => 9,
  DataRepository_getSheet_: () => ({ getDataRange: () => ({ getValues: () => [['학생ID'], ['S-RACE']] }) }),
  DataRepository_writeCachedRows_: () => false
}, () => {
  context.DataRepository_getRowsRaw_(names.STUDENTS, { fresh:true });
  check('세대 경쟁으로 영구 캐시 저장이 거절되면 실행 캐시에도 보존하지 않음', () =>
    assert.equal(Object.prototype.hasOwnProperty.call(context.DataRepository_runtimeRows_, names.STUDENTS), false));
});

context.QueryResultCache_namespaceSalt_ = '';
const ordinarySignature = context.QueryResultCache_signature_('P2_PERF', 'STATIC', []);
context.QueryResultCache_namespaceSalt_ = 'ISOLATED';
const isolatedSignature = context.QueryResultCache_signature_('P2_PERF', 'STATIC', []);
context.QueryResultCache_namespaceSalt_ = '';
check('진단 전용 캐시 키는 일반 캐시 키와 분리되고 종료 뒤 원복', () => {
  assert.notEqual(isolatedSignature, ordinarySignature);
  assert.equal(context.QueryResultCache_signature_('P2_PERF', 'STATIC', []), ordinarySignature);
});

const studentDetailSource = fs.readFileSync(path.join(root, '학생정보수정.js'), 'utf8')
  .match(/function StudentDetail_build_\([\s\S]*$/)[0];
check('학생 상세는 학생·이력 전체행 대신 ID 인덱스 사용', () => {
  assert.match(studentDetailSource, /LookupIndex_findRows_\(SHEET_NAMES\.STUDENTS/);
  assert.match(studentDetailSource, /EventRepository_getLegacyRowsForStudents_/);
  assert.doesNotMatch(studentDetailSource, /DataRepository_loadContext_/);
});
check('학생 상세 공통 조회는 세대 기반 캐시와 서버 권한·담당 범위를 적용', () => {
  assert.match(studentDetailSource, /QueryResultCache_signature_\("STUDENT_DETAIL_V1"/);
  assert.match(studentDetailSource, /AccessControl_hasStudentDataAccess_\(access\)/);
  assert.match(studentDetailSource, /AccessControl_getStudentScope_\(access\)/);
  assert.match(studentDetailSource, /function getStudentInfoModalData[\s\S]*requireAuthorizedUser_/);
});
check('공통 학생정보 모달은 동적 이름 링크·키보드·포커스·오류 처리를 지원', () => {
  assert.match(studentInfoModalHtml, /\[data-student-modal-id\]/);
  assert.match(studentInfoModalHtml, /event\.key==="Escape"/);
  assert.match(studentInfoModalHtml, /state\.returnFocus\.focus\(\)/);
  assert.match(studentInfoModalHtml, /withFailureHandler[\s\S]*getStudentInfoModalData/);
  assert.match(studentInfoModalHtml, /max-width:calc\(100vw - 36px\)/);
  assert.match(studentInfoModalHtml, /student-info-common-table th[^}]*width:34%/);
  assert.match(studentInfoModalHtml, /overflow-x:hidden/);
});
check('학생명이 있는 운영 화면은 공통 학생정보 모달을 포함', () => {
  ['DashboardUI.html','ManagerDashboard.html','CashReceipt.html','ChangeLogViewer.html','PaymentChecklist.html',
    'PaymentEdit.html','SalaryDashboard.html','SiblingManager.html','StatisticsDashboard.html','StudentEdit.html',
    'StudentRosterPrint.html','StudentVacation.html','MyRequestStatus.html','TrashManager.html'].forEach(name => {
      assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /includeHtml_\("StudentInfoModalCommon"\)/, name);
    });
});
const vacationReadSource = fs.readFileSync(path.join(root, '학생 휴가관리.js'), 'utf8')
  .match(/function getVacationPeriodsForStudent\([\s\S]*?\n}/)[0];
check('학생별 휴가 조회는 전체행 대신 학생 ID 인덱스 사용', () => {
  assert.match(vacationReadSource, /LookupIndex_findRows_\(SHEET_NAMES\.VACATIONS/);
  assert.doesNotMatch(vacationReadSource, /DataRepository_getRows_/);
});
const performanceDiagnosticsSource = fs.readFileSync(path.join(root, '관리자_성능진단서비스.js'), 'utf8');
check('성능 진단은 사례별 콜드·웜 쌍이며 월별 세대를 변경하지 않음', () => {
  assert.match(performanceDiagnosticsSource, /"COLD_PASS"[\s\S]*"WARM_PASS"/);
  assert.match(performanceDiagnosticsSource, /warmComparisons[\s\S]*warmRegressions/);
  assert.match(performanceDiagnosticsSource, /PerformanceDiagnostics_median_/);
  assert.match(performanceDiagnosticsSource, /WARM_RECHECK_/);
  assert.doesNotMatch(performanceDiagnosticsSource, /PerformanceDiagnostics_clearReadCaches_[\s\S]*?MonthlyCache_markAllDirty_\(\)/);
});
check('급여 관리 탭은 정산 기록·원장 목록을 통합 RPC 한 번으로 조회', () => {
  const loadBody = salaryAdminHtml.match(/function salaryAdminLoad\([\s\S]*?\n      }/)[0];
  assert.match(loadBody, /getSalaryAdminInitialData\(\)/);
  assert.equal((loadBody.match(/google\.script\.run/g) || []).length, 1);
  assert.doesNotMatch(loadBody, /listSalarySettlementRecords|getManagedTeachers/);
});
const allServerSource = sourceFiles.map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
check('핵심 소스의 직접 전체행 읽기와 행별 추가 호출 예산 유지', () => {
  assert.ok((allServerSource.match(/getDataRange\(\)\.getValues\(\)/g) || []).length <= 8);
  assert.doesNotMatch(allServerSource, /\.appendRow\s*\(/);
});

let snapshotLookupForces = [];
overrides({
  MonthlySnapshotStore_sourceVersion_: () => 'SNAPSHOT-V1',
  MonthlySnapshotStore_getSheet_: () => ({ getLastRow: () => 2 }),
  MonthlySnapshotStore_expectedStudentIds_: () => ['S-A'],
  LookupIndex_findRows_: (_sheetName, _columnNumber, _targetYm, forceRebuild) => {
    snapshotLookupForces.push(!!forceRebuild);
    return forceRebuild ? [{ row: ['2026-08|S-A', '2026-08', 'S-A', 'SNAPSHOT-V1', '{}'] }] : [];
  }
}, () => {
  check('월별 스냅샷 행 수 불일치 때 조회 인덱스 강제 재생성', () => {
    const result = context.MonthlySnapshotStore_read_('2026-08', {}, true, true);
    assert.equal(result.status, 'persistent_hit');
    assert.ok(result.facts['S-A']);
    assert.deepEqual(snapshotLookupForces, [false, true]);
  });
});

snapshotLookupForces = [];
let snapshotDirectReads = 0;
overrides({
  MonthlySnapshotStore_sourceVersion_: () => 'SNAPSHOT-V1',
  MonthlySnapshotStore_getSheet_: () => ({ getLastRow: () => 2, getLastColumn: () => 6 }),
  MonthlySnapshotStore_expectedStudentIds_: () => ['S-A'],
  LookupIndex_findRows_: (_sheetName, _columnNumber, _targetYm, forceRebuild) => {
    snapshotLookupForces.push(!!forceRebuild);
    return [];
  },
  MonthlySnapshotStore_readRowsDirect_: () => {
    snapshotDirectReads++;
    return [{ row: ['2026-08|S-A', '2026-08', 'S-A', 'SNAPSHOT-V1', '{}'] }];
  }
}, () => {
  check('월별 스냅샷 인덱스 연속 누락 때 저장 행 직접 대조', () => {
    const result = context.MonthlySnapshotStore_read_('2026-08', {}, true, true);
    assert.equal(result.status, 'persistent_hit');
    assert.ok(result.facts['S-A']);
    assert.deepEqual(snapshotLookupForces, [false, true]);
    assert.equal(snapshotDirectReads, 1);
  });
});

check('퇴원공백 자동 생성은 기존 일반휴가와 겹치면 차단', () => {
  const vacationRow = [];
  vacationRow[idx.VACATION.ID] = 'VAC-OVERLAP';
  vacationRow[idx.VACATION.STUDENT_ID] = 'S-RETURN';
  vacationRow[idx.VACATION.STUDENT_NAME] = '복귀학생';
  vacationRow[idx.VACATION.START_DATE] = '2026-03-10';
  vacationRow[idx.VACATION.END_DATE] = '2026-03-12';
  vacationRow[idx.VACATION.PERIOD_TYPE] = context.VACATION_PERIOD_TYPES.VACATION;
  overrides({
    VacationDomain_getOrCreateSheet_: () => ({}),
    LookupIndex_findRows_: () => [{ rowNumber:2, row:vacationRow }]
  }, () => {
    assert.throws(() => context.VacationDomain_appendRetirementGap_({}, {
      studentId: 'S-RETURN', studentName: '복귀학생',
      exitDate: '2026-01-31', returnDate: '2026-07-10'
    }), /겹쳐/);
  });
});

resetData();
const pendingEventA = Array(context.EVENT_HEADERS.length).fill('');
const pendingEventB = Array(context.EVENT_HEADERS.length).fill('');
pendingEventA[0] = 'EVT-PENDING-A'; pendingEventA[1] = '2026-09-09T10:00:00.000Z';
pendingEventB[0] = 'EVT-PENDING-B'; pendingEventB[1] = '2026-09-09T10:01:00.000Z';
properties.set('PENDING_EVENT_A', JSON.stringify(pendingEventA));
properties.set('PENDING_EVENT_B', JSON.stringify(pendingEventB));
let pendingBatchWrites = [];
const pendingEventSheet = {
  getLastRow: () => 1,
  getRange(row, column, count, width) {
    return { setValues: values => pendingBatchWrites.push({ row, column, count, width, values }) };
  }
};
overrides({
  Mutation_getEventSheet_: () => pendingEventSheet,
  Mutation_invalidateTimelineCachesAfterRestore_: () => true
}, () => {
  context.Mutation_retryPendingEvents_();
  check('대기 이벤트 복원은 여러 행을 한 번에 기록', () => {
    assert.equal(pendingBatchWrites.length, 1);
    assert.equal(pendingBatchWrites[0].values.length, 2);
    assert.equal(properties.has('PENDING_EVENT_A'), false);
    assert.equal(properties.has('PENDING_EVENT_B'), false);
  });
});
console.log(JSON.stringify({ sourceFilesLoaded: sourceFiles.length, integrationAssertions, targetedChecks, productionAccess: false, status: 'PASS' }, null, 2));
