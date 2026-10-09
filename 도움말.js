function showHelpGuide() {
  requireAuthorizedUser_();
  var html = HtmlService.createTemplateFromFile('HelpGuide').evaluate()
      .setWidth(400)
      .setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '왕초보 사용 설명서');
}

// HelpGuide.html의 내용을 글자로 가져오는 함수
function getHelpContent() {
  requireAuthorizedUser_();
  return HtmlService.createTemplateFromFile('HelpGuide').evaluate().getContent();
}

function includeHtml_(filename) {
  // 템플릿 조각은 인증된 화면을 조립할 때 서버 내부에서만 포함됩니다.
  // 밑줄로 끝나는 함수는 브라우저 RPC로 직접 호출할 수 없으므로 조각마다 권한표를 다시 읽지 않습니다.
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
