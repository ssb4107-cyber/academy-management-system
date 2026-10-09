// Apps Script/HTML 전체 구문과 브라우저 RPC 연결을 운영 접속 없이 대조한다.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
assert.equal(manifest.webapp?.executeAs, 'USER_DEPLOYING', '웹앱은 배포자 권한으로 실행');
assert.equal(manifest.webapp?.access, 'ANYONE_ANONYMOUS', '공개 웹앱은 앱 자체 Google 인증을 사용');
const jsFiles = fs.readdirSync(root)
  .filter(name => name.endsWith('.js') && name !== 'vite.config.js')
  .sort();
const htmlFiles = fs.readdirSync(root).filter(name => name.endsWith('.html')).sort();
const definitions = new Map();
const definitionSources = new Map();
const duplicateDefinitions = [];
const generatedInlineScripts = [];

for (const file of jsFiles) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  new vm.Script(source, { filename: file });
  // Apps Script에서 공개될 수 있는 파일 최상위 함수만 센다. 들여쓴 중첩 함수는 제외한다.
  const topLevelMatches = [...source.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
  for (let index = 0; index < topLevelMatches.length; index++) {
    const match = topLevelMatches[index];
    const name = match[1];
    if (definitions.has(name)) duplicateDefinitions.push({ name, files: [definitions.get(name), file] });
    else {
      definitions.set(name, file);
      const end = index + 1 < topLevelMatches.length ? topLevelMatches[index + 1].index : source.length;
      definitionSources.set(name, source.slice(match.index, end));
    }
  }
  for (const match of source.matchAll(/\bonclick=\\?"([\s\S]*?google\.script\.run[\s\S]*?)\\?">/g)) {
    const handler = match[1].replace(/\\"/g, '"');
    new vm.Script(`function __generatedOnclick(){${handler}}`, { filename: `${file}#generated-onclick` });
    generatedInlineScripts.push({ file, source: handler });
  }
}

const inlineScripts = [];
const literalEventHandlers = [];
const rawRpcSites = [];
const staticRpcNames = new Set();
const dynamicRpcNames = new Set();
let independentFailureHandlers = 0;

function scanCallEnd(source, start) {
  let depth = 0, quote = '', escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '/' && next === '/') { i = source.indexOf('\n', i); if (i < 0) return source.length; continue; }
    if (char === '/' && next === '*') { i = source.indexOf('*/', i + 2); if (i < 0) return source.length; i++; continue; }
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i + 1;
  }
  return source.length;
}

function auditRpcSource(file, source) {
  for (const rpcMatch of source.matchAll(/google\s*\.\s*script\s*\.\s*run\b/g)) {
    let cursor = rpcMatch.index + rpcMatch[0].length, hasFailureHandler = false, serverFunction = '';
    while (cursor < source.length) {
      cursor += (source.slice(cursor).match(/^\s*/)||[''])[0].length;
      if (source[cursor] !== '.') break;
      const nameMatch = source.slice(cursor + 1).match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
      if (!nameMatch) break;
      const name = nameMatch[1];
      const callStart = cursor + 1 + nameMatch[0].lastIndexOf('(');
      cursor = scanCallEnd(source, callStart);
      if (name === 'withFailureHandler') hasFailureHandler = true;
      if (!/^with(?:Success|Failure|UserObject)Handler$/.test(name)) { serverFunction = name; break; }
    }
    rawRpcSites.push({ file, serverFunction });
    if (hasFailureHandler) independentFailureHandlers++;
    if (serverFunction) staticRpcNames.add(serverFunction);
  }
}

for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptPattern.exec(html))) {
    if (/\bsrc\s*=|\btype\s*=\s*["'](?:application\/json|application\/ld\+json)["']/i.test(scriptMatch[1])) continue;
    const source = scriptMatch[2];
    if (!source.trim()) continue;
    const syntaxSource = source.replace(/<\?[!=]?[\s\S]*?\?>/g, '0');
    new vm.Script(syntaxSource, { filename: `${file}#inline-${inlineScripts.length + 1}` });
    inlineScripts.push({ file, source });
    auditRpcSource(file, source);
    if (/\b(?:var|let|const)\s+runner\s*=\s*google\s*\.\s*script\s*\.\s*run\b/.test(source)) {
      for (const dynamicMatch of source.matchAll(/\brunner\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        dynamicRpcNames.add(dynamicMatch[1]);
      }
    }
  }
  // <script> 블록 밖 HTML 태그에 직접 선언한 onclick/onchange/oninput 등의
  // 이벤트 처리기도 브라우저 함수 본문으로 컴파일해 구문 오류를 잡습니다.
  // Apps Script 템플릿 표현식과 자주 쓰는 HTML 엔티티는 실행 가능한 값으로 바꿉니다.
  const markupOnly = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const eventPattern = /\s(on[a-z][a-z0-9]*)\s*=\s*(["'])([\s\S]*?)\2/gi;
  let eventMatch;
  while ((eventMatch = eventPattern.exec(markupOnly))) {
    const source = eventMatch[3]
      .replace(/<\?[!=]?[\s\S]*?\?>/g, '0')
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:39|x27);/gi, "'")
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
    new vm.Script(`function __eventHandler(event){${source}}`, {
      filename: `${file}#${eventMatch[1]}-${literalEventHandlers.length + 1}`
    });
    literalEventHandlers.push({ file, event: eventMatch[1].toLowerCase(), source });
  }
}
generatedInlineScripts.forEach(item => auditRpcSource(item.file + '#generated-onclick', item.source));

const reachableRpcNames = new Set([...staticRpcNames, ...dynamicRpcNames]);
const unresolvedRpcSites = rawRpcSites.filter(site => !site.serverFunction).length;
const missingDefinitions = [...reachableRpcNames].filter(name => !definitions.has(name)).sort();
assert.deepEqual(duplicateDefinitions, [], '전역 함수 중복 정의');
assert.deepEqual(missingDefinitions, [], 'HTML RPC 서버 함수 누락');
assert.equal(independentFailureHandlers, rawRpcSites.length, 'google.script.run 실패 처리 누락');
assert.equal(unresolvedRpcSites, dynamicRpcNames.size ? 1 : 0, '해석하지 못한 동적 RPC 호출');

const publicFunctions = [...definitions].filter(([name]) => !name.endsWith('_')).map(([name]) => name).sort();
assert.equal(publicFunctions.includes('authenticateGoogleCredential'), false,
  'nonce 없는 ID 토큰 로그인 함수를 공개 RPC로 노출하면 안 됨');
assert.equal(publicFunctions.includes('authorizeGoogleOAuthNetworkAccess'), false,
  'OAuth 외부통신 권한 승인 본체를 공개 RPC로 노출하면 안 됨');
const purePublicFunctions = new Set([
  'DateMoney_parseDateOnly', 'DateMoney_formatDateOnly', 'fastFormatDate', 'DateMoney_parseMonthStart',
  'DateMoney_roundWon', 'DateMoney_truncateWon', 'DateMoney_inclusiveDays', 'DateMoney_prorate',
  'DateMoney_billingDays', 'PaymentDomain_sumTuitionPayments', 'PaymentDomain_calculateBalance',
  'PaymentDomain_classifyDifference', 'PaymentDomain_adjustMonthlyFee', 'PaymentDomain_prorateAdjustedFee',
  'StudentTimeline_buildHistories', 'StudentTimeline_resolveValue', 'StudentTimeline_resolveState',
  'StudentTimeline_normalizeFeeEffectiveDate', 'getGradeColor', 'getTeacherColor', 'stringToPastelColor',
  'showAccessDeniedMessage'
]);
// 이 공개 래퍼들은 아래의 권한 검증 공개/비공개 진입점에만 위임합니다. 각 실제 진입점도 별도로 검사됩니다.
const auditedDelegatingPublicFunctions = new Set([
  'runAdminMonthlySnapshotPreflightFromMenu', 'enableAdminMonthlySnapshotDeploymentFromMenu',
  'disableAdminMonthlySnapshotDeploymentFromMenu', 'getDashboardData', 'getDashboardDataWithRefresh',
  'getExistingTeachers', 'listHistoricalSalaryRecords', 'recordSalaryPayment', 'submitManagerPaymentRequest'
]);
const trustedTriggerPublicFunctions = new Set(['onEdit']);
const menuSource = fs.readFileSync(path.join(root, '관리자_메뉴.js'), 'utf8');
const spreadsheetMenuFunctions = new Set([
  'onOpen',
  ...[...menuSource.matchAll(/\.addItem\([^,\n]+,\s*['"]([A-Za-z_$][\w$]*)['"]\s*\)/g)].map(match => match[1])
]);
const missingMenuDefinitions = [...spreadsheetMenuFunctions].filter(name => !definitions.has(name)).sort();
const menuFunctionsWithoutSpreadsheetBoundary = [...spreadsheetMenuFunctions].filter(name =>
  !/requireSpreadsheet(?:AuthorizedUser_|SuperAdmin_|ManagerPermission_)|AccessControl_assertSpreadsheetUiContext_/.test(
    definitionSources.get(name) || ''
  )).sort();
const menuRpcOverlap = [...reachableRpcNames].filter(name => spreadsheetMenuFunctions.has(name)).sort();
const rpcFunctionsWithSpreadsheetBoundary = [...reachableRpcNames].filter(name =>
  /requireSpreadsheet(?:AuthorizedUser_|SuperAdmin_|ManagerPermission_)|AccessControl_assertSpreadsheetUiContext_/.test(
    definitionSources.get(name) || ''
  )).sort();
assert.deepEqual(missingMenuDefinitions, [], '스프레드시트 메뉴 함수 정의 누락');
assert.deepEqual(menuFunctionsWithoutSpreadsheetBoundary, [], '스프레드시트 메뉴 전용 인증 경계 누락');
assert.deepEqual(menuRpcOverlap, [], '스프레드시트 메뉴 함수를 웹 RPC에서 직접 호출하면 안 됨');
assert.deepEqual(rpcFunctionsWithSpreadsheetBoundary, [], '웹 RPC에서 스프레드시트 메뉴 인증 경계 사용 금지');
const authorizedBoundarySource = definitionSources.get('requireAuthorizedUser_') || '';
assert.ok(
  authorizedBoundarySource.includes('var email = getCurrentInteractiveUserEmail_();') &&
  authorizedBoundarySource.includes('var spreadsheetExecutionEmail = String(AccessControl_spreadsheetExecutionEmail_ || "")') &&
  authorizedBoundarySource.includes('options.allowActiveUser === true') &&
  authorizedBoundarySource.includes('if (!email && allowActiveUser) email = getCurrentUserEmail_();'),
  '일반 공개 서버 권한은 앱 OAuth 세션을 기본값으로 사용'
);
assert.equal(authorizedBoundarySource.includes('AccessControl_isSpreadsheetUiContext_()'), false,
  '일반 공개 서버 권한은 실행 환경 자동 추정으로 활성 계정을 허용하면 안 됨');
const spreadsheetBoundarySource = definitionSources.get('requireSpreadsheetAuthorizedUser_') || '';
assert.ok(
  spreadsheetBoundarySource.includes('AccessControl_assertSpreadsheetUiContext_();') &&
  spreadsheetBoundarySource.includes('requireAuthorizedUser_({ allowActiveUser:true })') &&
  spreadsheetBoundarySource.includes('AccessControl_spreadsheetExecutionEmail_ = user.email'),
  '스프레드시트 메뉴 경계는 검증한 실행 사용자만 내부 호출에 전달'
);
const activeFallbackPublicFunctions = publicFunctions.filter(name =>
  /allowActiveUser\s*:\s*true/.test(definitionSources.get(name) || '')).sort();
assert.deepEqual(activeFallbackPublicFunctions, [], '공개 서버 함수의 Apps Script 활성 계정 직접 허용');
assert.match(definitionSources.get('runScheduledMaintenance') || '',
  /Maintenance_requireRegisteredTimeTrigger_\(event\)/,
  '공개 시간 트리거 함수는 등록 triggerUid를 검증');
const boundaryPattern = /require(?:AuthorizedUser_|SuperAdmin_|ManagerPermission_|InteractiveAuthorizedUser_|AutomationSuperAdmin_|SpreadsheetAuthorizedUser_|SpreadsheetSuperAdmin_|SpreadsheetManagerPermission_)|MutationPipeline_run_|AccessSession_(?:createOAuthRequest_|renderOAuthCallback_|verifyGoogleToken_)|AccessControl_|PaymentLifecycle_|SalaryMutation_|TeacherManagement_require|Management_require|Backup_require|RequestService_require/;
const publicWithoutBoundary = publicFunctions.filter(name =>
  !purePublicFunctions.has(name) && !auditedDelegatingPublicFunctions.has(name) &&
  !trustedTriggerPublicFunctions.has(name) && !boundaryPattern.test(definitionSources.get(name) || ''));
assert.deepEqual(publicWithoutBoundary, [], '공개 서버 함수의 인증·권한 경계 누락 후보');
const publicGateways = ['AuthGateway.html', 'AccessRequestGateway.html'];
const gatewayRpcSites = publicGateways.reduce((count, file) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.equal(/google\s*\.\s*script\s*\.\s*run\b/.test(source), false,
    `${file}에는 업무 데이터 RPC가 없어야 함`);
  return count + (source.match(/google\s*\.\s*script\s*\.\s*run\b/g) || []).length;
}, 0);
const salaryDashboardSource = fs.readFileSync(path.join(root, 'SalaryDashboard.html'), 'utf8');
const salaryCalculationSource = fs.readFileSync(path.join(root, 'SalaryCalculationModule.html'), 'utf8');
const salaryExportSource = fs.readFileSync(path.join(root, 'SalaryFinalizePrintModule.html'), 'utf8');
const salaryManagementSource = fs.readFileSync(path.join(root, '급여관리서비스.js'), 'utf8');
assert.match(salaryDashboardSource, /id="exportTeacherSelect"/, '급여 출력 대상은 전체 원장 또는 원장 선택 목록을 제공');
assert.equal(/name="exportTarget"/.test(salaryDashboardSource), false, '현재 화면 기준 출력 대상 라디오를 제거');
assert.match(salaryDashboardSource, /value="image_separate"/, '페이지별 개별 이미지 저장 선택지 제공');
assert.match(salaryExportSource, /#resultContainer \.print-section/, '출력 대상은 준비용 복제본이 아닌 원본 원장 목록에서 선택');
assert.match(salaryExportSource, /generateImagesFromElement/, '급여 정산서를 개별 이미지로 생성');
assert.match(salaryExportSource, /exportImagePageCuts/, '긴 정산서는 페이지별 이미지로 분리');
assert.match(salaryExportSource, /imageIndex < preparedSections\.length/, '전체 원장 이미지도 원장별 개별 파일로 저장');
assert.match(salaryCalculationSource, /salaryPreviewPayload\(wrapper, freshSource\)/, '급여 미리보기 요청은 원본 강제 조회 여부를 전달');
assert.match(salaryCalculationSource, /function finalizeSection[\s\S]*requestSalaryPreview\([\s\S]*, true\);/, '개별 급여 확정 직전에는 원본 미리보기를 요청');
assert.match(salaryExportSource, /requestSalaryPreview\(wrapper\.id[\s\S]*reject, true\);/, '월 일괄 확정 직전에도 원본 미리보기를 요청');
assert.match(salaryManagementSource, /if \(data\.freshSource === true\) return SalaryManagement_buildPreview_\(data\);/, '확정용 급여 미리보기는 캐시 없이 원본을 읽음');
const finalizeSalaryBody = salaryManagementSource.match(/function finalizeSalarySettlement\(data\) \{[\s\S]*?\n\}/)[0];
const finalizeSalaryBatchBody = salaryManagementSource.match(/function finalizeSalarySettlementsBatch\(data\) \{[\s\S]*?\n\}/)[0];
assert.doesNotMatch(finalizeSalaryBody, /Management_ensureInfrastructure_\(\)/, '개별 급여 확정은 토큰 검사 전에 기반자료를 변경하지 않음');
assert.doesNotMatch(finalizeSalaryBatchBody, /Management_ensureInfrastructure_\(\)/, '월 일괄 급여 확정은 토큰 검사 전에 기반자료를 변경하지 않음');
const result = {
  status: 'PASS', productionAccess: false,
  javascript: { files: jsFiles.length, globalDefinitions: definitions.size,
    publicFunctions: publicFunctions.length, duplicateDefinitions: duplicateDefinitions.length,
    publicFunctionsWithoutBoundary: publicWithoutBoundary.length,
    spreadsheetMenuHandlers: spreadsheetMenuFunctions.size,
    activeFallbackPublicFunctions: activeFallbackPublicFunctions.length },
  html: { files: htmlFiles.length, inlineScripts: inlineScripts.length,
    literalEventHandlers: literalEventHandlers.length,
    generatedInlineScripts: generatedInlineScripts.length, publicGatewayRpcSites: gatewayRpcSites },
  rpc: { rawSites: rawRpcSites.length, staticUnique: staticRpcNames.size,
    dynamicNames: [...dynamicRpcNames].sort(), reachableUnique: reachableRpcNames.size,
    missingDefinitions, independentFailureHandlers, unresolvedRpcSites,
    spreadsheetMenuOverlap: menuRpcOverlap.length,
    spreadsheetBoundaryRpcFunctions: rpcFunctionsWithSpreadsheetBoundary.length }
};
console.log(JSON.stringify(result, null, 2));
