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
  paymentMonths: [],
  paymentMonth: "",
  paymentQuery: "",
  paymentMethod: "",
  paymentRows: [],
  paymentTotal: 0,
  paymentAmount: 0,
  paymentReady: false,
  requestRows: [],
  requestTotal: 0,
  requestPending: 0,
  requestStatus: "",
  requestCanApprove: false,
  requestReady: false,
  studentReference: null,
  studentRequestRows: [],
  studentRequestTotal: 0,
  studentRequestPending: 0,
  studentRequestStatus: "",
  studentRequestCanApprove: false,
  studentRequestReady: false,
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
  if (/최고 관리자만/i.test(message)) return "최고 관리자만 이 요청을 처리할 수 있습니다.";
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
  const viewSwitcher = element("nav", "view-switcher");
  viewSwitcher.setAttribute("aria-label", "업무 화면 선택");
  const studentTab = element("button", "view-tab active", "학생 조회");
  const paymentTab = element("button", "view-tab", "수납 조회");
  const requestTab = element("button", "view-tab", "수납 요청");
  const studentRequestTab = element("button", "view-tab", "학생 요청");
  studentTab.id = "student-tab";
  paymentTab.id = "payment-tab";
  requestTab.id = "request-tab";
  studentRequestTab.id = "student-request-tab";
  studentTab.type = "button";
  paymentTab.type = "button";
  requestTab.type = "button";
  studentRequestTab.type = "button";
  viewSwitcher.append(studentTab, paymentTab, requestTab, studentRequestTab);
  main.append(viewSwitcher);

  const studentView = element("div", "view-section");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow", "STUDENT DIRECTORY"));
  title.append(element("h1", "page-title", "학생 조회"));
  title.append(element("p", "page-copy", "학생 이름을 누르면 등록된 상세 정보를 확인할 수 있습니다."));
  const sync = element("div", "sync-badge");
  sync.append(icon("●", "sync-dot"), element("span", "", sessionData.syncedAt ? "Supabase 동기화 완료" : "동기화 확인 중"));
  const headingActions = element("div", "heading-actions");
  headingActions.append(sync);
  if (state.studentReference?.canAdd) {
    const createStudent = element("button", "primary-action-button", "+ 학생 등록 요청");
    createStudent.type = "button";
    createStudent.addEventListener("click", () => openStudentRequestModal());
    headingActions.append(createStudent);
  }
  heading.append(title, headingActions);
  studentView.append(heading);

  const stats = element("section", "stats-grid");
  stats.append(
    createStat("조회 가능한 학생", `${sessionData.studentCount.toLocaleString("ko-KR")}명`, true),
    createStat("현재 조회 결과", `${state.total.toLocaleString("ko-KR")}명`),
    createStat("학생 접근 범위", state.profile.studentScope === "ALL_STUDENTS" ? "전체 학생" : "담당 학생")
  );
  stats.id = "stats";
  studentView.append(stats);

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
  ["학생명", "학년/학번", "담당", "수강 형태", "수강료", "상태", "요청"].forEach((labelText) => headRow.append(element("th", "", labelText)));
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
  studentView.append(panel);

  const paymentView = createPaymentView();
  paymentView.hidden = true;
  const requestView = createPaymentRequestView();
  requestView.hidden = true;
  const studentRequestView = createStudentRequestView();
  studentRequestView.hidden = true;
  main.append(studentView, paymentView, requestView, studentRequestView);

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

  studentTab.addEventListener("click", () => {
    studentView.hidden = false;
    paymentView.hidden = true;
    requestView.hidden = true;
    studentRequestView.hidden = true;
    studentTab.classList.add("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    showNotice("");
  });
  paymentTab.addEventListener("click", async () => {
    studentView.hidden = true;
    paymentView.hidden = false;
    requestView.hidden = true;
    studentRequestView.hidden = true;
    paymentTab.classList.add("active");
    studentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    showNotice("");
    if (!state.paymentReady) {
      const ready = await loadPaymentOverview();
      if (ready) await loadPayments();
    }
  });
  requestTab.addEventListener("click", async () => {
    studentView.hidden = true;
    paymentView.hidden = true;
    requestView.hidden = false;
    studentRequestView.hidden = true;
    requestTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    showNotice("");
    await loadPaymentRequests();
  });
  studentRequestTab.addEventListener("click", async () => {
    studentView.hidden = true;
    paymentView.hidden = true;
    requestView.hidden = true;
    studentRequestView.hidden = false;
    studentRequestTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    showNotice("");
    await loadStudentRequests();
  });
}

function createPaymentView() {
  const view = element("div", "view-section");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow", "PAYMENT LEDGER"));
  title.append(element("h1", "page-title", "월별 수납 조회"));
  title.append(element("p", "page-copy", "귀속월별 수납 내역과 학생별 납부 기록을 확인할 수 있습니다."));
  const secure = element("div", "sync-badge");
  secure.append(icon("●", "sync-dot"), element("span", "", "권한 범위 적용"));
  const headingActions = element("div", "heading-actions");
  const createButton = element("button", "primary-action-button", "+ 수납 등록 요청");
  createButton.type = "button";
  createButton.addEventListener("click", () => openPaymentRequestModal());
  headingActions.append(secure, createButton);
  heading.append(title, headingActions);
  view.append(heading);

  const stats = element("section", "stats-grid");
  const amountCard = createStat("선택 월 수납액", "-", true);
  amountCard.querySelector(".stat-value").id = "payment-total-amount";
  const countCard = createStat("선택 월 수납 건수", "-");
  countCard.querySelector(".stat-value").id = "payment-total-count";
  const monthCard = createStat("조회 귀속월", "-");
  monthCard.querySelector(".stat-value").id = "payment-selected-month";
  stats.append(amountCard, countCard, monthCard);
  view.append(stats);

  const panel = element("section", "student-panel");
  const toolbar = element("div", "toolbar payment-toolbar");
  const searchWrap = element("label", "search-wrap");
  searchWrap.append(icon("⌕", "search-icon"));
  const search = element("input", "search-input");
  search.type = "search";
  search.placeholder = "학생명 또는 학년 검색";
  search.value = state.paymentQuery;
  search.setAttribute("aria-label", "수납 학생명 또는 학년 검색");
  searchWrap.append(search);

  const month = element("select", "status-select payment-month-select");
  month.id = "payment-month";
  month.disabled = true;
  month.setAttribute("aria-label", "수납 귀속월 선택");
  month.append(element("option", "", "월 불러오는 중"));

  const method = element("select", "status-select");
  method.id = "payment-method";
  method.setAttribute("aria-label", "납부 방식 필터");
  ["", "카드", "현금영수증", "동백전", "동백전QR", "토스", "모락", "계좌이체"].forEach((value) => {
    const option = element("option", "", value || "전체 방식");
    option.value = value;
    option.selected = value === state.paymentMethod;
    method.append(option);
  });
  toolbar.append(searchWrap, month, method);
  panel.append(toolbar);

  const tableWrap = element("div", "table-wrap");
  const table = element("table", "student-table payment-table");
  const thead = element("thead");
  const headRow = element("tr");
  ["납부일", "학생명", "학년/학번", "수납항목", "납부금액", "납부방식", "메모", "요청"].forEach((labelText) => headRow.append(element("th", "", labelText)));
  thead.append(headRow);
  const tbody = element("tbody");
  tbody.id = "payment-rows";
  table.append(thead, tbody);
  tableWrap.append(table);
  panel.append(tableWrap);

  const empty = element("div", "empty-state");
  empty.id = "payment-empty-state";
  empty.append(icon("⌕", "empty-icon"), element("strong", "", "조건에 맞는 수납 기록이 없습니다."), element("span", "", "조회 월이나 검색 조건을 바꿔보세요."));
  panel.append(empty);
  view.append(panel);

  let timer;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      state.paymentQuery = search.value.trim();
      await loadPayments();
    }, 250);
  });
  month.addEventListener("change", async () => {
    state.paymentMonth = month.value;
    await loadPayments();
  });
  method.addEventListener("change", async () => {
    state.paymentMethod = method.value;
    await loadPayments();
  });
  return view;
}

async function loadPaymentOverview() {
  const { data, error } = await supabase.rpc("get_my_payment_overview");
  if (error) {
    showNotice(normalizeError(error), "error");
    return false;
  }
  state.paymentMonths = Array.isArray(data?.months) ? data.months : [];
  state.paymentMonth = state.paymentMonth || data?.latestMonth || state.paymentMonths[0] || "";
  state.paymentReady = true;

  const select = document.querySelector("#payment-month");
  if (select) {
    select.replaceChildren();
    state.paymentMonths.forEach((value) => {
      const option = element("option", "", value);
      option.value = value;
      option.selected = value === state.paymentMonth;
      select.append(option);
    });
    select.disabled = state.paymentMonths.length === 0;
  }
  return true;
}

async function loadPayments() {
  if (!state.paymentReady) {
    const ready = await loadPaymentOverview();
    if (!ready) return;
  }
  showNotice("");
  const { data, error } = await supabase.rpc("search_my_payments", {
    p_month: state.paymentMonth || null,
    p_query: state.paymentQuery || null,
    p_method: state.paymentMethod || null,
    p_limit: 300,
    p_offset: 0,
  });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.paymentMonth = data?.month || state.paymentMonth;
  state.paymentRows = Array.isArray(data?.rows) ? data.rows : [];
  state.paymentTotal = Number(data?.total || 0);
  state.paymentAmount = Number(data?.totalAmount || 0);
  renderPaymentRows();
}

function renderPaymentRows() {
  const tbody = document.querySelector("#payment-rows");
  const empty = document.querySelector("#payment-empty-state");
  if (!tbody || !empty) return;
  tbody.replaceChildren();
  empty.hidden = state.paymentRows.length > 0;
  state.paymentRows.forEach((payment) => {
    const row = element("tr");
    const nameCell = element("td");
    const nameButton = element("button", "student-link", payment.studentName || "이름 없음");
    nameButton.type = "button";
    nameButton.addEventListener("click", () => openStudent(payment.studentId, nameButton));
    nameCell.append(nameButton);
    const actionCell = element("td");
    const editButton = element("button", "table-action-button", "수정 요청");
    editButton.type = "button";
    editButton.addEventListener("click", () => openPaymentRequestModal(payment));
    actionCell.append(editButton);
    row.append(
      element("td", "", payment.payDate || "-"),
      nameCell,
      element("td", "", payment.gradeLabel || "-"),
      element("td", "", payment.itemType || "-"),
      element("td", "money-cell", formatMoney(payment.amount)),
      element("td", "", payment.paymentMethod || "-"),
      element("td", "memo-cell", payment.memo || "-"),
      actionCell
    );
    tbody.append(row);
  });

  const amount = document.querySelector("#payment-total-amount");
  const count = document.querySelector("#payment-total-count");
  const month = document.querySelector("#payment-selected-month");
  if (amount) amount.textContent = formatMoney(state.paymentAmount);
  if (count) count.textContent = `${state.paymentTotal.toLocaleString("ko-KR")}건`;
  if (month) month.textContent = state.paymentMonth || "-";
}

function createPaymentRequestView() {
  const view = element("div", "view-section");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow", "PAYMENT REQUESTS"));
  title.append(element("h1", "page-title", "수납 요청 처리"));
  title.append(element("p", "page-copy", state.profile.role === "SUPER_ADMIN"
    ? "요청 내용을 확인한 뒤 승인하면 수납 원장과 변경 이력에 함께 반영됩니다."
    : "등록·수정 요청은 최고 관리자 승인 후 수납 원장에 반영됩니다."));
  const createButton = element("button", "primary-action-button", "+ 새 수납 요청");
  createButton.type = "button";
  createButton.addEventListener("click", () => openPaymentRequestModal());
  heading.append(title, createButton);
  view.append(heading);

  const stats = element("section", "stats-grid");
  const total = createStat("표시 요청", "0건", true);
  total.querySelector(".stat-value").id = "request-total";
  const pending = createStat("승인 대기", "0건");
  pending.querySelector(".stat-value").id = "request-pending";
  const role = createStat("현재 역할", state.profile.role === "SUPER_ADMIN" ? "승인 가능" : "요청 가능");
  stats.append(total, pending, role);
  view.append(stats);

  const panel = element("section", "student-panel request-panel");
  const toolbar = element("div", "toolbar request-toolbar");
  const description = element("p", "request-toolbar-copy", "처리 완료 요청도 이력으로 보존됩니다.");
  const status = element("select", "status-select");
  status.setAttribute("aria-label", "수납 요청 상태 필터");
  [["", "전체 상태"], ["PENDING", "승인 대기"], ["APPROVED", "승인 완료"], ["REJECTED", "반려"], ["CANCELLED", "취소"]]
    .forEach(([value, labelText]) => {
      const option = element("option", "", labelText);
      option.value = value;
      option.selected = value === state.requestStatus;
      status.append(option);
    });
  status.addEventListener("change", async () => {
    state.requestStatus = status.value;
    await loadPaymentRequests();
  });
  const reload = element("button", "quiet-button", "새로고침");
  reload.type = "button";
  reload.addEventListener("click", loadPaymentRequests);
  toolbar.append(description, status, reload);
  panel.append(toolbar);
  const list = element("div", "request-list");
  list.id = "payment-request-list";
  panel.append(list);
  view.append(panel);
  return view;
}

async function loadPaymentRequests() {
  const { data, error } = await supabase.rpc("search_my_payment_requests", {
    p_status: state.requestStatus || null,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.requestRows = Array.isArray(data?.rows) ? data.rows : [];
  state.requestTotal = Number(data?.total || 0);
  state.requestPending = Number(data?.pending || 0);
  state.requestCanApprove = data?.canApprove === true;
  state.requestReady = true;
  renderPaymentRequests();
}

function requestStatusLabel(status) {
  return { PENDING: "승인 대기", APPROVED: "승인 완료", REJECTED: "반려", CANCELLED: "취소" }[status] || status;
}

function renderPaymentRequests() {
  const list = document.querySelector("#payment-request-list");
  if (!list) return;
  list.replaceChildren();
  const total = document.querySelector("#request-total");
  const pending = document.querySelector("#request-pending");
  if (total) total.textContent = `${state.requestTotal.toLocaleString("ko-KR")}건`;
  if (pending) pending.textContent = `${state.requestPending.toLocaleString("ko-KR")}건`;
  if (!state.requestRows.length) {
    const empty = element("div", "empty-state");
    empty.append(icon("✓", "empty-icon"), element("strong", "", "표시할 수납 요청이 없습니다."), element("span", "", "상태 조건을 바꾸거나 새 요청을 등록해보세요."));
    list.append(empty);
    return;
  }

  state.requestRows.forEach((request) => {
    const card = element("article", `request-card status-${String(request.status || "").toLowerCase()}`);
    const head = element("div", "request-card-head");
    const identity = element("div");
    const nameButton = element("button", "student-link request-student", request.studentName || "학생");
    nameButton.type = "button";
    nameButton.addEventListener("click", () => openStudent(request.studentId, nameButton));
    identity.append(nameButton, element("span", "request-kind", request.operation === "UPDATE" ? "수정 요청" : "등록 요청"));
    head.append(identity, element("span", `request-status status-${String(request.status || "").toLowerCase()}`, requestStatusLabel(request.status)));

    const grid = element("dl", "request-grid");
    [["귀속월", request.paymentMonth], ["납부일", request.payDate], ["수납항목", request.itemType],
      ["금액", formatMoney(request.amount)], ["납부방식", request.paymentMethod], ["요청자", request.requesterName]]
      .forEach(([label, value]) => grid.append(detailRow(label, value)));
    card.append(head, grid);
    if (request.memo) card.append(element("p", "request-note", `메모: ${request.memo}`));
    if (request.reason) card.append(element("p", "request-note", `요청 사유: ${request.reason}`));
    if (Number(request.duplicatePaymentCount || 0) > 0 && request.status === "PENDING") {
      card.append(element("p", "request-warning", `같은 학생·귀속월·항목·금액·납부일의 기존 수납이 ${request.duplicatePaymentCount}건 있습니다.`));
    }
    if (request.decisionMemo) card.append(element("p", "request-decision", `처리 메모: ${request.decisionMemo}`));
    card.append(element("p", "request-meta", `${request.createdAt || ""}${request.processedAt ? ` · 처리 ${request.processedAt}` : ""}`));

    if (request.status === "PENDING") {
      const actions = element("div", "request-actions");
      if (state.requestCanApprove) {
        const reject = element("button", "danger-button", "반려");
        const approve = element("button", "approve-button", "승인·반영");
        reject.type = approve.type = "button";
        reject.addEventListener("click", () => decidePaymentRequest(request, "REJECT", reject));
        approve.addEventListener("click", () => decidePaymentRequest(request, "APPROVE", approve));
        actions.append(reject, approve);
      } else {
        const cancel = element("button", "danger-button", "요청 취소");
        cancel.type = "button";
        cancel.addEventListener("click", () => cancelPaymentRequest(request, cancel));
        actions.append(cancel);
      }
      card.append(actions);
    }
    list.append(card);
  });
}

async function decidePaymentRequest(request, decision, button) {
  const actionText = decision === "APPROVE" ? "승인하여 수납 원장에 반영" : "반려";
  if (!window.confirm(`${request.studentName} 학생의 ${formatMoney(request.amount)} 요청을 ${actionText}할까요?`)) return;
  const memo = window.prompt("처리 메모가 있으면 입력해주세요. (선택)", "");
  if (memo === null) return;
  button.disabled = true;
  const { error } = await supabase.rpc("decide_payment_request", {
    p_request_id: request.requestId,
    p_decision: decision,
    p_memo: memo.trim() || null,
  });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    await loadPaymentRequests();
    return;
  }
  state.paymentReady = false;
  showNotice(decision === "APPROVE" ? "승인한 내용이 수납 원장과 변경 이력에 반영되었습니다." : "수납 요청을 반려했습니다.", "success");
  await loadPaymentRequests();
}

async function cancelPaymentRequest(request, button) {
  if (!window.confirm("아직 승인되지 않은 이 수납 요청을 취소할까요?")) return;
  button.disabled = true;
  const { error } = await supabase.rpc("cancel_my_payment_request", { p_request_id: request.requestId });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  showNotice("수납 요청을 취소했습니다.", "success");
  await loadPaymentRequests();
}

async function loadRequestStudentOptions() {
  const { data, error } = await supabase.rpc("search_my_students", {
    p_query: null,
    p_status: null,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) throw error;
  return Array.isArray(data?.rows) ? data.rows : [];
}

async function openPaymentRequestModal(payment = null) {
  let students;
  try {
    students = await loadRequestStudentOptions();
  } catch (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  const isEdit = Boolean(payment?.paymentId);
  const backdrop = element("div", "modal-backdrop");
  const dialog = element("section", "student-modal payment-request-modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "payment-request-title");
  const header = element("header", "modal-header");
  const titleWrap = element("div", "modal-title-wrap");
  titleWrap.append(icon("₩", "modal-title-icon"));
  const titles = element("div");
  const title = element("h2", "modal-title", isEdit ? "수납 수정 요청" : "수납 등록 요청");
  title.id = "payment-request-title";
  titles.append(title, element("p", "modal-student-name", "승인 전에는 원장이 변경되지 않습니다."));
  titleWrap.append(titles);
  const close = element("button", "modal-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "닫기");
  header.append(titleWrap, close);

  const form = element("form", "request-form");
  const field = (labelText, control) => {
    const wrap = element("label", "request-field");
    wrap.append(element("span", "field-label", labelText), control);
    return wrap;
  };
  const student = element("select", "text-input");
  student.required = true;
  const studentPlaceholder = element("option", "", "학생 선택");
  studentPlaceholder.value = "";
  studentPlaceholder.disabled = true;
  studentPlaceholder.selected = !isEdit;
  student.append(studentPlaceholder);
  students.forEach((item) => {
    const option = element("option", "", `${item.studentName} · ${item.gradeLabel || "학년 미지정"}`);
    option.value = item.studentId;
    option.selected = item.studentId === payment?.studentId;
    student.append(option);
  });
  if (isEdit) student.disabled = true;
  const payDate = element("input", "text-input");
  payDate.type = "date";
  payDate.required = true;
  payDate.value = payment?.payDate || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const month = element("input", "text-input");
  month.type = "month";
  month.required = true;
  month.value = payment?.paymentMonth || state.paymentMonth || payDate.value.slice(0, 7);
  const itemType = element("select", "text-input");
  ["수강료", "특강비"].forEach((value) => {
    const option = element("option", "", value);
    option.value = value;
    option.selected = value === (payment?.itemType || "수강료");
    itemType.append(option);
  });
  const amount = element("input", "text-input");
  amount.type = "number";
  amount.min = "0";
  amount.max = "100000000";
  amount.step = "1";
  amount.required = true;
  amount.value = payment?.amount ?? "";
  const method = element("select", "text-input");
  ["모락", "카드", "동백전QR", "현금영수증", "계좌이체", "동백전", "토스"].forEach((value) => {
    const option = element("option", "", value);
    option.value = value;
    option.selected = value === (payment?.paymentMethod || "카드");
    method.append(option);
  });
  const memo = element("textarea", "text-area");
  memo.maxLength = 1000;
  memo.placeholder = "수납 메모 (선택)";
  memo.value = payment?.memo || "";
  const reason = element("textarea", "text-area");
  reason.maxLength = 500;
  reason.placeholder = isEdit ? "수정 사유를 입력해주세요." : "요청 사유 (선택)";
  if (isEdit) reason.required = true;

  const fields = element("div", "request-form-grid");
  fields.append(
    field("학생", student), field("납부일", payDate), field("귀속월", month),
    field("수납항목", itemType), field("납부금액", amount), field("납부방식", method),
    field("메모", memo), field("요청 사유", reason)
  );
  const footer = element("footer", "modal-footer request-form-footer");
  const cancel = element("button", "secondary-button", "취소");
  cancel.type = "button";
  const submit = element("button", "primary-action-button", isEdit ? "수정 승인 요청" : "등록 승인 요청");
  submit.type = "submit";
  footer.append(cancel, submit);
  form.append(fields, footer);
  dialog.append(header, form);
  backdrop.append(dialog);
  document.body.append(backdrop);
  document.body.classList.add("modal-open");

  const idempotencyKey = crypto.randomUUID();
  const dismiss = () => {
    backdrop.remove();
    document.body.classList.remove("modal-open");
  };
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) dismiss(); });
  dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") dismiss(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "요청 저장 중…";
    const { data, error } = await supabase.rpc("submit_payment_request", {
      p_operation: isEdit ? "UPDATE" : "CREATE",
      p_student_id: student.value,
      p_pay_date: payDate.value,
      p_payment_month: month.value,
      p_item_type: itemType.value,
      p_amount: Number(amount.value),
      p_payment_method: method.value,
      p_memo: memo.value.trim() || null,
      p_reason: reason.value.trim() || null,
      p_target_payment_id: payment?.paymentId || null,
      p_idempotency_key: idempotencyKey,
    });
    submit.disabled = false;
    submit.textContent = isEdit ? "수정 승인 요청" : "등록 승인 요청";
    if (error) {
      const inline = form.querySelector(".form-error") || element("p", "form-error");
      inline.textContent = normalizeError(error);
      if (!inline.parentNode) form.insertBefore(inline, footer);
      return;
    }
    dismiss();
    document.querySelector("#request-tab")?.click();
    const duplicateCount = Number(data?.duplicatePaymentCount || 0);
    showNotice(duplicateCount > 0
      ? `요청을 등록했습니다. 같은 조건의 기존 수납 ${duplicateCount}건이 있어 승인 화면에 경고가 표시됩니다.`
      : "수납 승인 요청을 등록했습니다.", "success");
  });
  student.focus();
}

async function loadStudentReferenceData() {
  const { data, error } = await supabase.rpc("get_student_reference_data");
  if (error) throw error;
  state.studentReference = data || { teachers: [], canAdd: false, canEdit: false };
  return state.studentReference;
}

function createStudentRequestView() {
  const view = element("div", "view-section");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow", "STUDENT REQUESTS"));
  title.append(element("h1", "page-title", "학생 등록·수정 요청"));
  title.append(element("p", "page-copy", state.profile.role === "SUPER_ADMIN"
    ? "승인하면 학생 원장, 시점별 변경 내역, 감사 이력에 한 번에 반영됩니다."
    : "등록·수정 내용은 최고 관리자 승인 후 학생 원장에 반영됩니다."));
  const createButton = element("button", "primary-action-button", "+ 학생 등록 요청");
  createButton.type = "button";
  createButton.hidden = !state.studentReference?.canAdd;
  createButton.addEventListener("click", () => openStudentRequestModal());
  heading.append(title, createButton);
  view.append(heading);

  const stats = element("section", "stats-grid");
  const total = createStat("표시 요청", "0건", true);
  total.querySelector(".stat-value").id = "student-request-total";
  const pending = createStat("승인 대기", "0건");
  pending.querySelector(".stat-value").id = "student-request-pending";
  stats.append(total, pending, createStat("현재 역할", state.profile.role === "SUPER_ADMIN" ? "승인 가능" : "요청 가능"));
  view.append(stats);

  const panel = element("section", "student-panel request-panel");
  const toolbar = element("div", "toolbar request-toolbar");
  const description = element("p", "request-toolbar-copy", "처리 결과와 변경 이력은 삭제하지 않고 보존됩니다.");
  const status = element("select", "status-select");
  status.setAttribute("aria-label", "학생 요청 상태 필터");
  [["", "전체 상태"], ["PENDING", "승인 대기"], ["APPROVED", "승인 완료"], ["REJECTED", "반려"], ["CANCELLED", "취소"]]
    .forEach(([value, labelText]) => {
      const option = element("option", "", labelText);
      option.value = value;
      option.selected = value === state.studentRequestStatus;
      status.append(option);
    });
  status.addEventListener("change", async () => {
    state.studentRequestStatus = status.value;
    await loadStudentRequests();
  });
  const reload = element("button", "quiet-button", "새로고침");
  reload.type = "button";
  reload.addEventListener("click", loadStudentRequests);
  toolbar.append(description, status, reload);
  panel.append(toolbar);
  const list = element("div", "request-list");
  list.id = "student-request-list";
  panel.append(list);
  view.append(panel);
  return view;
}

async function loadStudentRequests() {
  const { data, error } = await supabase.rpc("search_my_student_requests", {
    p_status: state.studentRequestStatus || null,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.studentRequestRows = Array.isArray(data?.rows) ? data.rows : [];
  state.studentRequestTotal = Number(data?.total || 0);
  state.studentRequestPending = Number(data?.pending || 0);
  state.studentRequestCanApprove = data?.canApprove === true;
  state.studentRequestReady = true;
  renderStudentRequests();
}

function renderStudentRequests() {
  const list = document.querySelector("#student-request-list");
  if (!list) return;
  list.replaceChildren();
  const total = document.querySelector("#student-request-total");
  const pending = document.querySelector("#student-request-pending");
  if (total) total.textContent = `${state.studentRequestTotal.toLocaleString("ko-KR")}건`;
  if (pending) pending.textContent = `${state.studentRequestPending.toLocaleString("ko-KR")}건`;
  if (!state.studentRequestRows.length) {
    const empty = element("div", "empty-state");
    empty.append(icon("✓", "empty-icon"), element("strong", "", "표시할 학생 요청이 없습니다."), element("span", "", "상태 조건을 바꾸거나 새 등록 요청을 만들어보세요."));
    list.append(empty);
    return;
  }

  state.studentRequestRows.forEach((request) => {
    const card = element("article", `request-card status-${String(request.status || "").toLowerCase()}`);
    const head = element("div", "request-card-head");
    const identity = element("div");
    const studentId = request.approvedStudentId || request.targetStudentId;
    if (studentId) {
      const nameButton = element("button", "student-link request-student", request.studentName || "학생");
      nameButton.type = "button";
      nameButton.addEventListener("click", () => openStudent(studentId, nameButton));
      identity.append(nameButton);
    } else {
      identity.append(element("strong", "request-student-name", request.studentName || "학생"));
    }
    identity.append(element("span", "request-kind", request.operation === "UPDATE" ? "수정 요청" : "등록 요청"));
    head.append(identity, element("span", `request-status status-${String(request.status || "").toLowerCase()}`, requestStatusLabel(request.status)));

    const grid = element("dl", "request-grid");
    [["학년/학번", request.gradeLabel], ["담당", request.teacherName], ["상태", request.requestedStatus],
      ["수강 형태", request.courseType], ["수강료", formatMoney(request.tuition)], ["수납 기준일", `매월 ${request.baseDay}일`],
      ["첫 수업일", request.firstLessonDate], ["요청자", request.requesterName]]
      .forEach(([label, value]) => grid.append(detailRow(label, value)));
    card.append(head, grid);
    if (request.operation === "UPDATE") {
      card.append(element("p", "request-note", `적용일 · 수강료 ${request.feeEffectiveDate || "-"} / 상태 ${request.statusEffectiveDate || "-"} / 담당 ${request.teacherEffectiveDate || "-"}`));
    }
    if (request.reason) card.append(element("p", "request-note", `요청 사유: ${request.reason}`));
    if (request.decisionMemo) card.append(element("p", "request-decision", `처리 메모: ${request.decisionMemo}`));
    card.append(element("p", "request-meta", `${request.createdAt || ""}${request.processedAt ? ` · 처리 ${request.processedAt}` : ""}`));

    if (request.status === "PENDING") {
      const actions = element("div", "request-actions");
      if (state.studentRequestCanApprove) {
        const reject = element("button", "danger-button", "반려");
        const approve = element("button", "approve-button", "승인·반영");
        reject.type = approve.type = "button";
        reject.addEventListener("click", () => decideStudentRequest(request, "REJECT", reject));
        approve.addEventListener("click", () => decideStudentRequest(request, "APPROVE", approve));
        actions.append(reject, approve);
      } else {
        const cancel = element("button", "danger-button", "요청 취소");
        cancel.type = "button";
        cancel.addEventListener("click", () => cancelStudentRequest(request, cancel));
        actions.append(cancel);
      }
      card.append(actions);
    }
    list.append(card);
  });
}

async function decideStudentRequest(request, decision, button) {
  const actionText = decision === "APPROVE" ? "승인하여 학생 원장에 반영" : "반려";
  if (!window.confirm(`${request.studentName} 학생의 요청을 ${actionText}할까요?`)) return;
  const memo = window.prompt("처리 메모가 있으면 입력해주세요. (선택)", "");
  if (memo === null) return;
  button.disabled = true;
  const { error } = await supabase.rpc("decide_student_request", {
    p_request_id: request.requestId,
    p_decision: decision,
    p_memo: memo.trim() || null,
  });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    await loadStudentRequests();
    return;
  }
  if (decision === "APPROVE") {
    await loadStudents();
    showNotice("승인한 내용이 학생 원장과 변경 이력에 반영되었습니다.", "success");
  } else {
    showNotice("학생 요청을 반려했습니다.", "success");
  }
  await loadStudentRequests();
}

async function cancelStudentRequest(request, button) {
  if (!window.confirm("아직 승인되지 않은 이 학생 요청을 취소할까요?")) return;
  button.disabled = true;
  const { error } = await supabase.rpc("cancel_my_student_request", { p_request_id: request.requestId });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  showNotice("학생 요청을 취소했습니다.", "success");
  await loadStudentRequests();
}

async function openStudentRequestModal(studentId = null) {
  const isEdit = Boolean(studentId);
  try {
    if (!state.studentReference) await loadStudentReferenceData();
  } catch (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  if ((isEdit && !state.studentReference?.canEdit) || (!isEdit && !state.studentReference?.canAdd)) {
    showNotice("이 학생 작업을 요청할 권한이 없습니다.", "error");
    return;
  }

  let initial = null;
  if (isEdit) {
    const { data, error } = await supabase.rpc("get_student_change_form", { p_student_id: studentId });
    if (error) {
      showNotice(normalizeError(error), "error");
      return;
    }
    initial = data;
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const backdrop = element("div", "modal-backdrop");
  const dialog = element("section", "student-modal student-request-modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "student-request-modal-title");
  const header = element("header", "modal-header");
  const titleWrap = element("div", "modal-title-wrap");
  titleWrap.append(icon("♟", "modal-title-icon"));
  const titles = element("div");
  const title = element("h2", "modal-title", isEdit ? "학생 정보 수정 요청" : "학생 등록 요청");
  title.id = "student-request-modal-title";
  titles.append(title, element("p", "modal-student-name", "승인 전에는 학생 원장이 변경되지 않습니다."));
  titleWrap.append(titles);
  const close = element("button", "modal-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "닫기");
  header.append(titleWrap, close);

  const form = element("form", "request-form");
  const field = (labelText, control, wide = false) => {
    const wrap = element("label", wide ? "request-field field-wide" : "request-field");
    wrap.append(element("span", "field-label", labelText), control);
    return wrap;
  };
  const input = (type, value = "") => {
    const control = element("input", "text-input");
    control.type = type;
    control.value = value ?? "";
    return control;
  };
  const name = input("text", initial?.name || "");
  name.maxLength = 40;
  name.required = true;
  const grade = input("text", initial?.grade || "");
  grade.maxLength = 30;
  grade.required = true;
  const status = element("select", "text-input");
  ["재원", "퇴원"].forEach((value) => {
    const option = element("option", "", value);
    option.value = value;
    option.selected = value === (initial?.status || "재원");
    status.append(option);
  });
  status.disabled = !isEdit;
  const teacher = element("select", "text-input");
  teacher.required = true;
  const linkedTeacherId = state.studentReference?.studentScope === "LINKED_TEACHER" ? state.studentReference.linkedTeacherId : null;
  const initialTeacherId = initial?.teacherId || linkedTeacherId || "";
  (state.studentReference?.teachers || [])
    .filter((item) => item.active || item.teacherId === initialTeacherId)
    .forEach((item) => {
      const option = element("option", "", `${item.teacherName}${item.active ? "" : " (비활성)"}`);
      option.value = item.teacherId;
      option.selected = item.teacherId === initialTeacherId;
      teacher.append(option);
    });
  if (linkedTeacherId) teacher.disabled = true;
  const firstLessonDate = input("date", String(initial?.firstLessonDate || today).slice(0, 10));
  firstLessonDate.required = true;
  const originalEnrollmentDate = input("date", String(initial?.originalEnrollmentDate || "").slice(0, 10));
  const baseDay = input("number", initial?.baseDay || Number(firstLessonDate.value.slice(8, 10)) || 1);
  baseDay.min = "1";
  baseDay.max = "31";
  baseDay.step = "1";
  baseDay.required = true;
  let baseDayTouched = isEdit;
  baseDay.addEventListener("input", () => { baseDayTouched = true; });
  firstLessonDate.addEventListener("change", () => {
    if (!baseDayTouched && firstLessonDate.value) baseDay.value = String(Number(firstLessonDate.value.slice(8, 10)));
  });
  const tuition = input("number", initial?.tuition ?? "");
  tuition.min = "0";
  tuition.max = "10000000";
  tuition.step = "1";
  tuition.required = true;
  const phone = input("tel", initial?.parentPhone || "");
  phone.maxLength = 30;
  phone.placeholder = "보호자 연락처 (선택)";
  const courseType = element("select", "text-input");
  ["정규", "특강전용"].forEach((value) => {
    const option = element("option", "", value);
    option.value = value;
    option.selected = value === (initial?.courseType || "정규");
    courseType.append(option);
  });
  let regularTuition = courseType.value === "정규" ? tuition.value : "";
  const syncCourseTuition = () => {
    const special = courseType.value === "특강전용";
    if (special) {
      regularTuition = tuition.value || regularTuition;
      tuition.value = "0";
    } else if (tuition.value === "0" && regularTuition) {
      tuition.value = regularTuition;
    }
    tuition.readOnly = special;
  };
  courseType.addEventListener("change", syncCourseTuition);
  syncCourseTuition();
  const feeEffectiveDate = input("date", today);
  const statusEffectiveDate = input("date", today);
  const teacherEffectiveDate = input("date", today);
  const reason = element("textarea", "text-area");
  reason.maxLength = 500;
  reason.placeholder = isEdit ? "수정 사유를 입력해주세요." : "요청 사유 (선택)";
  reason.required = isEdit;

  const fields = element("div", "request-form-grid");
  fields.append(
    field("학생 이름", name), field("학년/학번", grade), field("현재 상태", status), field("담당 선생님", teacher),
    field("첫 수업일", firstLessonDate), field("최초 입학일 (선택)", originalEnrollmentDate),
    field("수납 기준일", baseDay), field("기본 수강료", tuition), field("보호자 연락처", phone), field("수강 형태", courseType)
  );
  if (isEdit) {
    fields.append(field("수강료 적용 기준일", feeEffectiveDate), field("상태 적용일", statusEffectiveDate), field("담당 적용일", teacherEffectiveDate));
    const future = Array.isArray(initial?.futureChanges) ? initial.futureChanges : [];
    if (future.length) {
      const warning = element("div", "form-warning field-wide");
      warning.append(element("strong", "", "이미 예약된 변경이 있습니다."));
      future.forEach((item) => warning.append(element("span", "", `${item.effectiveDate} · ${item.field} → ${item.after}`)));
      fields.append(warning);
    }
  }
  fields.append(field("요청 사유", reason, true));
  const footer = element("footer", "modal-footer request-form-footer");
  const cancel = element("button", "secondary-button", "취소");
  cancel.type = "button";
  const submit = element("button", "primary-action-button", isEdit ? "수정 승인 요청" : "등록 승인 요청");
  submit.type = "submit";
  footer.append(cancel, submit);
  form.append(fields, footer);
  dialog.append(header, form);
  backdrop.append(dialog);
  document.body.append(backdrop);
  document.body.classList.add("modal-open");

  const idempotencyKey = crypto.randomUUID();
  const dismiss = () => {
    backdrop.remove();
    document.body.classList.remove("modal-open");
  };
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) dismiss(); });
  dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") dismiss(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "요청 저장 중…";
    const { error } = await supabase.rpc("submit_student_request", {
      p_operation: isEdit ? "UPDATE" : "CREATE",
      p_student_id: studentId,
      p_name: name.value.trim(),
      p_grade: grade.value.trim(),
      p_status: isEdit ? status.value : "재원",
      p_teacher_id: teacher.value,
      p_first_lesson_date: firstLessonDate.value,
      p_original_enrollment_date: originalEnrollmentDate.value || null,
      p_base_day: Number(baseDay.value),
      p_tuition: Number(tuition.value),
      p_parent_phone: phone.value.trim() || null,
      p_course_type: courseType.value,
      p_fee_effective_date: isEdit ? feeEffectiveDate.value : null,
      p_status_effective_date: isEdit ? statusEffectiveDate.value : null,
      p_teacher_effective_date: isEdit ? teacherEffectiveDate.value : null,
      p_reason: reason.value.trim() || null,
      p_idempotency_key: idempotencyKey,
    });
    submit.disabled = false;
    submit.textContent = isEdit ? "수정 승인 요청" : "등록 승인 요청";
    if (error) {
      const inline = form.querySelector(".form-error") || element("p", "form-error");
      inline.textContent = normalizeError(error);
      if (!inline.parentNode) form.insertBefore(inline, footer);
      return;
    }
    dismiss();
    document.querySelector("#student-request-tab")?.click();
    showNotice(isEdit ? "학생 수정 승인 요청을 등록했습니다." : "학생 등록 승인 요청을 등록했습니다.", "success");
  });
  name.focus();
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
    if (student.hasScheduledChanges) nameCell.append(element("span", "scheduled-badge", "예약 변경"));
    const actionCell = element("td");
    if (state.studentReference?.canEdit) {
      const editButton = element("button", "table-action-button", "수정 요청");
      editButton.type = "button";
      editButton.addEventListener("click", () => openStudentRequestModal(student.studentId));
      actionCell.append(editButton);
    } else {
      actionCell.textContent = "-";
    }
    row.append(
      nameCell,
      element("td", "", student.gradeLabel || "-"),
      element("td", "", student.teacherName || "-"),
      element("td", "", student.courseType || "-"),
      element("td", "money-cell", formatMoney(student.tuition)),
      statusCell(student.status),
      actionCell
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
  const paymentAction = element("div", "modal-payment-action");
  const paymentButton = element("button", "payment-history-button", "▣ 전체 수납기록 보기");
  paymentButton.type = "button";
  paymentAction.append(paymentButton);
  const paymentHistory = element("section", "payment-history");
  paymentHistory.hidden = true;
  const futureChanges = Array.isArray(data.futureChanges) ? data.futureChanges : [];
  const schedule = element("section", "scheduled-changes");
  schedule.hidden = futureChanges.length === 0;
  if (futureChanges.length) {
    schedule.append(element("strong", "scheduled-title", "예약된 변경"));
    futureChanges.forEach((item) => {
      schedule.append(element("p", "scheduled-item", `${item.effectiveDate} · ${item.field}: ${item.before || "-"} → ${item.after || "-"}`));
    });
  }
  let paymentHistoryLoaded = false;
  paymentButton.addEventListener("click", async () => {
    if (paymentHistoryLoaded) {
      paymentHistory.hidden = !paymentHistory.hidden;
      paymentButton.textContent = paymentHistory.hidden ? "▣ 전체 수납기록 보기" : "▣ 수납기록 접기";
      return;
    }
    paymentButton.disabled = true;
    paymentButton.textContent = "수납 기록 불러오는 중…";
    const { data: payments, error: paymentError } = await supabase.rpc("get_my_student_payments", {
      p_student_id: studentId,
      p_limit: 200,
      p_offset: 0,
    });
    paymentButton.disabled = false;
    if (paymentError) {
      paymentButton.textContent = "다시 시도";
      paymentHistory.hidden = false;
      paymentHistory.replaceChildren(element("p", "history-error", normalizeError(paymentError)));
      return;
    }
    renderStudentPaymentHistory(paymentHistory, payments);
    paymentHistoryLoaded = true;
    paymentHistory.hidden = false;
    paymentButton.textContent = "▣ 수납기록 접기";
  });
  const footer = element("footer", "modal-footer");
  const closeBottom = element("button", "secondary-button", "닫기");
  closeBottom.type = "button";
  if (state.studentReference?.canEdit) {
    const edit = element("button", "primary-action-button", "학생 정보 수정 요청");
    edit.type = "button";
    edit.addEventListener("click", () => {
      dismiss();
      openStudentRequestModal(studentId);
    });
    footer.append(closeBottom, edit);
  } else {
    footer.append(closeBottom);
  }
  dialog.append(header, details, schedule, paymentAction, paymentHistory, footer);
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

function renderStudentPaymentHistory(container, data) {
  container.replaceChildren();
  const summary = element("div", "history-summary");
  const copy = element("div");
  copy.append(element("strong", "history-title", "전체 수납 기록"));
  copy.append(element("span", "history-count", `총 ${Number(data?.total || 0).toLocaleString("ko-KR")}건`));
  summary.append(copy, element("strong", "history-amount", formatMoney(data?.totalAmount)));
  container.append(summary);

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (!rows.length) {
    container.append(element("p", "history-empty", "등록된 수납 기록이 없습니다."));
    return;
  }
  const wrap = element("div", "history-table-wrap");
  const table = element("table", "history-table");
  const thead = element("thead");
  const head = element("tr");
  ["귀속월", "납부일", "수납항목", "납부금액", "납부방식"].forEach((label) => head.append(element("th", "", label)));
  thead.append(head);
  const tbody = element("tbody");
  rows.forEach((payment) => {
    const row = element("tr");
    row.append(
      element("td", "", payment.paymentMonth || "-"),
      element("td", "", payment.payDate || "-"),
      element("td", "", payment.itemType || "-"),
      element("td", "money-cell", formatMoney(payment.amount)),
      element("td", "", payment.paymentMethod || "-")
    );
    tbody.append(row);
  });
  table.append(thead, tbody);
  wrap.append(table);
  container.append(wrap);
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
  try {
    await Promise.all([loadStudents(), loadStudentReferenceData()]);
  } catch (referenceError) {
    await supabase.auth.signOut({ scope: "local" });
    state.session = null;
    renderLogin();
    showNotice(normalizeError(referenceError), "error");
    return;
  }
  renderApp(data);
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.access_token === state.session?.access_token) return;
  state.session = session;
  window.setTimeout(boot, 0);
});

boot();
