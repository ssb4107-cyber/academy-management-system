"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);

const blockedNames = [
  /^\.clasp\.json$/i,
  /^\.clasprc\.json$/i,
  /(^|\/)\.env(?:\.|$)/i,
  /credentials.*\.json$/i,
  /secret.*\.json$/i,
  /\.(?:pem|key|xlsx|csv|tsv|zip|bak)$/i,
];

const secretPatterns = [
  { name: "personal email", pattern: /[A-Z0-9._%+-]+@(gmail\.com|naver\.com|daum\.net|kakao\.com|hanmail\.net|outlook\.com)/gi },
  { name: "Supabase secret key", pattern: /sb_secret_[A-Za-z0-9._-]{16,}/g },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "Google API key", pattern: /AIza[A-Za-z0-9_-]{30,}/g },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "hard-coded bearer token", pattern: /Authorization\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._-]{20,}/gi },
];

const failures = [];
for (const relative of tracked) {
  if (blockedNames.some((pattern) => pattern.test(relative))) {
    failures.push(`금지 파일 추적: ${relative}`);
    continue;
  }

  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;

  const content = fs.readFileSync(absolute, "utf8");
  for (const rule of secretPatterns) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) {
      failures.push(`${rule.name} 의심: ${relative}`);
    }
  }
}

if (failures.length) {
  console.error(JSON.stringify({ status: "FAIL", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASS",
  trackedFiles: tracked.length,
  message: "추적 파일에서 금지 파일명과 대표 비밀값 패턴을 찾지 못했습니다.",
}));
