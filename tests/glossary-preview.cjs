// 로컬 화면 검증 전용. Google 서비스나 운영 데이터를 호출하지 않습니다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
function source(name) { return fs.readFileSync(path.join(root, name + '.html'), 'utf8'); }
function expand(html) {
  return html.replace(/<\?!=\s*includeHtml_\(["']([^"']+)["']\);?\s*\?>/g, (_, name) => expand(source(name)))
    .replace(/<\?[\s\S]*?\?>/g, '');
}
const fixture = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>용어 도움말 검증</title>
<style>body{font:16px/1.6 Arial,sans-serif;margin:20px;color:#26364a}main{max-width:700px;margin:auto}label{display:block;margin:12px 0}th,td{padding:8px;border:1px solid #ccd8e8}button{cursor:pointer}#dynamic{margin-top:18px}</style>
<main><h1>급여 정산</h1><label>귀속월 <input type="month" value="2026-08"></label><label><input id="vacation" type="checkbox"> 휴가 적용</label>
<table><thead><tr><th id="sort" onclick="document.getElementById('sortCount').textContent=Number(document.getElementById('sortCount').textContent)+1">배분율</th></tr></thead><tbody><tr><td>60%</td></tr></tbody></table><p>정렬 실행: <output id="sortCount">0</output></p>
<label>메모 <input id="memo" value="귀속월에 관한 학생 메모"></label>
<button type="button" onclick="document.getElementById('dynamic').innerHTML='<label>수납 증빙</label><label>사용자 종류</label>'">동적 항목 표시</button>
<button type="button" onclick="document.getElementById('sort').textContent='다른 항목'">표 제목 변경</button>
<button type="button" onclick="document.getElementById('dynamic').innerHTML=Array.from({length:1000},(_,i)=>'<div>학생 '+i+'의 수납 내역</div>').join('')">학생 1000명 표시</button>
<div id="dynamic"></div></main>__GLOSSARY__</html>`;
const stub = `<script>window.google={script:{run:new Proxy(function(){},{get:function(){return function(){return google.script.run}}}),host:{close:function(){}}}};</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let html;
  if (url.pathname === '/') html = fixture.replace('__GLOSSARY__', source('AppGlossary'));
  else if (['/DashboardUI','/SettingsDashboard','/Manual','/StudentAddUI','/SalaryDashboard'].includes(url.pathname)) {
    html = expand(source(url.pathname.slice(1))).replace('<head>', '<head>' + stub);
    // 로컬에서는 외부 글꼴을 요청하지 않습니다.
    html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, '');
  } else { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(html);
});
server.listen(8766, '127.0.0.1', () => console.log('Glossary preview: http://127.0.0.1:8766'));
