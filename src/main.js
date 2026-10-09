import { createClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import "./styles.css";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});

const state = {
  session: null,
  profile: null,
  rows: [],
  total: 0,
  query: "",
  status: "",
};

const app = document.querySelector("#app");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(mark, className = "icon") {
  return element("span", className, mark);
}

function normalizeError(error) {
  const message = String(error?.message || error || "알 수 없는 오류");
  if (/registered|활성 사용자|권한/i.test(message)) {
    return "등록된 운영 계정이 아니거나 현재 사용이 중지된 계정입니다.";
  }
  if (/rate limit/i.test(message)) return "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
  return message;
}

function showNotice(message, tone = "info") {
  const notice = document.querySelector("#notice");
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = !message;
}

function renderLogin() {
  app.replaceChildren();
  const shell = element("main", "login-shell");
  const card = element("section", "login-card");
  const brand = element("div", "brand-mark");
  brand.append(icon("학", "brand-letter"));
  card.append(brand);
  card.append(element("p", "eyebrow", "ACADEMY OPERATIONS"));
  card.append(element("h1", "login-title", "학원 관리 시스템"));
  card.append(element("p", "login-copy", "등록된 운영 이메일로 안전하게 로그인하세요."));

  const form = element("form", "login-form");
  form.id = "login-form";
  const label = element("label", "field-label", "이메일");
  label.htmlFor = "email";
  const input = element("input", "text-input");
  input.id = "email";
  input.name = "email";
  input.type = "email";
  input.autocomplete = "email";
  input.placeholder = "name@example.com";
  input.required = true;
  const button = element("button", "primary-button", "로그인 링크 받기");
  button.type = "submit";
  const notice = element("p", "notice");
  notice.id = "notice";
  notice.hidden = true;
  form.append(label, input, button, notice);
  card.append(form);
  card.append(element("p", "security-note", "로그인 후에도 등록 사용자와 학생 열람 범위를 서버에서 다시 확인합니다."));
  shell.append(card);
  app.append(shell);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = input.value.trim().toLowerCase();
    button.disabled = true;
    button.textContent = "전송 중…";
    showNotice("");
    const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).href;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    button.disabled = false;
    button.textContent = "로그인 링크 받기";
    if (error) {
      showNotice(normalizeError(error), "error");
      return;
    }
    showNotice("이메일로 보낸 로그인 링크를 열어주세요. 이 화면은 그대로 두어도 됩니다.", "success");
  });
}

function makeHeader() {
  const header = element("header", "app-header");
  const identity = element("div", "app-identity");
  const logo = element("div", "compact-logo", "학");
  const titleGroup = element("div");
  titleGroup.append(element("strong", "app-name", "학원 관리 시스템"));
  titleGroup.append(element("span", "app-subtitle", "Supabase 보안 전환 화면"));
  identity.append(logo, titleGroup);

  const account = element("div", "account-area");
  const accountText = element("div", "account-text");
  accountText.append(element("strong", "account-name", state.profile.displayName));
  accountText.append(element("span", "account-role", state.profile.role === "SUPER_ADMIN" ? "최고 관리자" : "관리자"));
  const logout = element("button", "quiet-button", "로그아웃");
  logout.type = "button";
  logout.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });
  account.append(accountText, logout);
  header.append(identity, account);
  return header;
}

function createStat(label, value, accent = false) {
  const card = element("article", accent ? "stat-card accent" : "stat-card");
  card.append(element("span", "stat-label", label));
  card.append(element("strong", "stat-value", value));
  return card;
}

function renderApp(sessionData) {
  app.replaceChildren();
  const page = element("div", "app-page");
  page.append(makeHeader());

  const main = element("main", "content");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow", "STUDENT DIRECTORY"));
  title.append(element("h1", "page-title", "학생 조회"));
  title.append(element("p", "page-copy", "학생 이름을 누르면 등록된 상세 정보를 확인할 수 있습니다."));
  const sync = element("div", "sync-badge");
  sync.append(icon("●", "sync-dot"), element("span", "", sessionData.syncedAt ? "Supabase 동기화 완료" : "동기화 확인 중"));
  heading.append(title, sync);
  main.append(heading);

  const stats = element("section", "stats-grid");
  stats.append(
    createStat("조회 가능한 학생", `${sessionData.studentCount.toLocaleString("ko-KR")}명`, true),
    createStat("현재 조회 결과", `${state.total.toLocaleString("ko-KR")}명`),
    createStat("학생 접근 범위", state.profile.studentScope === "ALL_STUDENTS" ? "전체 학생" : "담당 학생")
  );
  stats.id = "stats";
  main.append(stats);

  const panel = element("section", "student-panel");
  const toolbar = element("div", "toolbar");
  const searchWrap = element("label", "search-wrap");
  searchWrap.append(icon("⌕", "search-icon"));
  const search = element("input", "search-input");
  search.type = "search";
  search.placeholder = "학생명 또는 학년 검색";
  search.value = state.query;
  search.setAttribute("aria-label", "학생명 또는 학년 검색");
  searchWrap.append(search);
  const status = element("select", "status-select");
  status.setAttribute("aria-label", "학생 상태 필터");
  [["", "전체 상태"], ["재원", "재원"], ["퇴원", "퇴원"]].forEach(([value, labelText]) => {
    const option = element("option", "", labelText);
    option.value = value;
    option.selected = value === state.status;
    status.append(option);
  });
  toolbar.append(searchWrap, status);
  panel.append(toolbar);

  const tableWrap = element("div", "table-wrap");
  const table = element("table", "student-table");
  const thead = element("thead");
  const headRow = element("tr");
  ["학생명", "학년/학번", "담당", "수강 형태", "수강료", "상태"].forEach((labelText) => headRow.append(element("th", "", labelText)));
  thead.append(headRow);
  const tbody = element("tbody");
  tbody.id = "student-rows";
  table.append(thead, tbody);
  tableWrap.append(table);
  panel.append(tableWrap);

  const empty = element("div", "empty-state");
  empty.id = "empty-state";
  empty.append(icon("⌕", "empty-icon"), element("strong", "", "조건에 맞는 학생이 없습니다."), element("span", "", "검색어나 상태 조건을 바꿔보세요."));
  panel.append(empty);
  main.append(panel);

  const notice = element("p", "notice page-notice");
  notice.id = "notice";
  notice.hidden = true;
  main.append(notice);
  page.append(main);
  app.append(page);
  renderRows();

  let timer;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      state.query = search.value.trim();
      await loadStudents();
    }, 250);
  });
  status.addEventListener("change", async () => {
    state.status = status.value;
    await loadStudents();
  });
}

function renderRows() {
  const tbody = document.querySelector("#student-rows");
  const empty = document.querySelector("#empty-state");
  if (!tbody || !empty) return;
  tbody.replaceChildren();
  empty.hidden = state.rows.length > 0;
  state.rows.forEach((student) => {
    const row = element("tr");
    const nameCell = element("td");
    const nameButton = element("button", "student-link", student.studentName || "이름 없음");
    nameButton.type = "button";
    nameButton.addEventListener("click", () => openStudent(student.studentId, nameButton));
    nameCell.append(nameButton);
    row.append(
      nameCell,
      element("td", "", student.gradeLabel || "-"),
      element("td", "", student.teacherName || "-"),
      element("td", "", student.courseType || "-"),
      element("td", "money-cell", formatMoney(student.tuition)),
      statusCell(student.status)
    );
    tbody.append(row);
  });

  const stats = document.querySelector("#stats");
  if (stats?.children[1]) stats.children[1].querySelector(".stat-value").textContent = `${state.total.toLocaleString("ko-KR")}명`;
}

function statusCell(status) {
  const cell = element("td");
  const badge = element("span", status === "재원" ? "status-badge active" : "status-badge", status || "미지정");
  cell.append(badge);
  return cell;
}

function formatMoney(value) {
  const digits = String(value || "").replace(/[^0-9-]/g, "");
  if (!digits || Number.isNaN(Number(digits))) return value || "-";
  return `${Number(digits).toLocaleString("ko-KR")}원`;
}

async function loadStudents() {
  showNotice("");
  const { data, error } = await supabase.rpc("search_my_students", {
    p_query: state.query || null,
    p_status: state.status || null,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.rows = Array.isArray(data?.rows) ? data.rows : [];
  state.total = Number(data?.total || 0);
  renderRows();
}

function detailRow(label, value, emphasis = false) {
  const row = element("div", "detail-row");
  row.append(element("dt", "detail-label", label), element("dd", emphasis ? "detail-value emphasis" : "detail-value", value || "-"));
  return row;
}

async function openStudent(studentId, returnFocus) {
  const { data, error } = await supabase.rpc("get_my_student", { p_student_id: studentId });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }

  const backdrop = element("div", "modal-backdrop");
  const dialog = element("section", "student-modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "student-modal-title");
  const header = element("header", "modal-header");
  const titleWrap = element("div", "modal-title-wrap");
  titleWrap.append(icon("♟", "modal-title-icon"));
  const titles = element("div");
  const title = element("h2", "modal-title", "학생 상세 정보");
  title.id = "student-modal-title";
  titles.append(title, element("p", "modal-student-name", data.studentName));
  titleWrap.append(titles);
  const close = element("button", "modal-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "닫기");
  header.append(titleWrap, close);

  const details = element("dl", "detail-grid");
  details.append(
    detailRow("학년/학번", data.gradeLabel),
    detailRow("담당 선생님", data.teacherName),
    detailRow("기본 수강료", formatMoney(data.tuition), true),
    detailRow("수납 기준일", data.tuitionReferenceDay),
    detailRow("최초 입학일", data.enrollmentDate),
    detailRow("첫 수업일", data.firstLessonDate),
    detailRow("퇴원일", data.exitDate),
    detailRow("현재 상태", data.status),
    detailRow("수강 형태", data.courseType),
    detailRow("보호자 연락처", data.parentPhone),
    detailRow("입금자명", data.payerName),
    detailRow("현금영수증 번호", data.cashReceiptNumber),
    detailRow("형제 그룹", data.siblingGroupName),
    detailRow("형제 할인액", formatMoney(data.siblingDiscount))
  );
  const footer = element("footer", "modal-footer");
  const closeBottom = element("button", "secondary-button", "닫기");
  closeBottom.type = "button";
  footer.append(closeBottom);
  dialog.append(header, details, footer);
  backdrop.append(dialog);
  document.body.append(backdrop);
  document.body.classList.add("modal-open");

  const dismiss = () => {
    backdrop.remove();
    document.body.classList.remove("modal-open");
    returnFocus?.focus();
  };
  close.addEventListener("click", dismiss);
  closeBottom.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) dismiss();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss();
  });
  close.focus();
}

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;
  if (!session) {
    renderLogin();
    return;
  }

  app.replaceChildren(element("div", "boot-state", "사용자 권한과 학생 정보를 확인하고 있습니다…"));
  const { data, error } = await supabase.rpc("get_my_academy_session");
  if (error) {
    await supabase.auth.signOut({ scope: "local" });
    state.session = null;
    renderLogin();
    showNotice(normalizeError(error), "error");
    return;
  }
  state.profile = data.profile;
  await loadStudents();
  renderApp(data);
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.access_token === state.session?.access_token) return;
  state.session = session;
  window.setTimeout(boot, 0);
});

boot();
