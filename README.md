# 학원관리시스템

Google Apps Script, Supabase, GitHub를 역할별로 분리한 학원 운영 시스템입니다.

## 역할 분리

- Google Apps Script: 현재 운영 화면과 Google 스프레드시트 원본
- Supabase: 비공개 데이터 미러와 이후 이전할 서버 처리
- GitHub: 소스 코드, 테스트, 변경 이력만 보관

학생 데이터, 스프레드시트 ID, 배포 ID, 인증키와 환경파일은 GitHub에 저장하지 않습니다.

## 로컬 검사

```text
node tests/repository-security.test.cjs
node tests/static-audit.cjs
node tests/p2-integrity.test.cjs
node tests/glossary.test.cjs
```

배포는 검사를 통과한 코드만 별도 승인된 로컬 환경에서 수행합니다. GitHub Actions에는 운영 비밀값을 넣지 않습니다.

