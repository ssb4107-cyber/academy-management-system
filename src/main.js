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
  vacationStudents: [],
  vacationStudentId: "",
  vacationPeriods: [],
  vacationRequestRows: [],
  vacationRequestTotal: 0,
  vacationRequestPending: 0,
  vacationRequestStatus: "",
  vacationRequestCanApprove: false,
  vacationReady: false,
  siblingStudents: [],
  siblingGroups: [],
  siblingRequestRows: [],
  siblingRequestTotal: 0,
  siblingRequestPending: 0,
  siblingRequestStatus: "",
  siblingRequestCanApprove: false,
  siblingFocusStudentId: "",
  siblingReady: false,
  cashReceiptStudents: [],
  cashReceiptRows: [],
  cashReceiptChanges: [],
  cashReceiptReady: false,
  statisticsOverview: null,
  statisticsData: null,
  statisticsStart: "",
  statisticsEnd: "",
  statisticsBasis: "PAY_DATE",
  statisticsReady: false,
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

function hasPermission(permission) {
  if (state.profile?.role === "SUPER_ADMIN") return true;
  const values = Array.isArray(state.profile?.permissions) ? state.profile.permissions : [];
  return values.join(",").split(",").map((value) => value.trim()).includes(permission);
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
  const vacationTab = element("button", "view-tab", "휴가 관리");
  const siblingTab = element("button", "view-tab", "형제 관리");
  const cashReceiptTab = element("button", "view-tab", "현금영수증");
  const statisticsTab = element("button", "view-tab", "기간 통계");
  studentTab.id = "student-tab";
  paymentTab.id = "payment-tab";
  requestTab.id = "request-tab";
  studentRequestTab.id = "student-request-tab";
  vacationTab.id = "vacation-tab";
  siblingTab.id = "sibling-tab";
  cashReceiptTab.id = "cash-receipt-tab";
  statisticsTab.id = "statistics-tab";
  studentTab.type = "button";
  paymentTab.type = "button";
  requestTab.type = "button";
  studentRequestTab.type = "button";
  vacationTab.type = "button";
  siblingTab.type = "button";
  cashReceiptTab.type = "button";
  statisticsTab.type = "button";
  cashReceiptTab.hidden = state.profile.role !== "SUPER_ADMIN";
  statisticsTab.hidden = state.profile.role !== "SUPER_ADMIN";
  viewSwitcher.append(studentTab, paymentTab, requestTab, studentRequestTab, vacationTab, siblingTab, cashReceiptTab, statisticsTab);
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
  const vacationView = createVacationView();
  vacationView.hidden = true;
  const siblingView = createSiblingView();
  siblingView.hidden = true;
  const cashReceiptView = createCashReceiptView();
  cashReceiptView.hidden = true;
  const statisticsView = createStatisticsView();
  statisticsView.hidden = true;
  main.append(studentView, paymentView, requestView, studentRequestView, vacationView, siblingView, cashReceiptView, statisticsView);

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
    vacationView.hidden = true;
    siblingView.hidden = true;
    cashReceiptView.hidden = true;
    statisticsView.hidden = true;
    studentTab.classList.add("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    vacationTab.classList.remove("active");
    siblingTab.classList.remove("active");
    cashReceiptTab.classList.remove("active");
    statisticsTab.classList.remove("active");
    showNotice("");
  });
  paymentTab.addEventListener("click", async () => {
    studentView.hidden = true;
    paymentView.hidden = false;
    requestView.hidden = true;
    studentRequestView.hidden = true;
    vacationView.hidden = true;
    siblingView.hidden = true;
    cashReceiptView.hidden = true;
    statisticsView.hidden = true;
    paymentTab.classList.add("active");
    studentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    vacationTab.classList.remove("active");
    siblingTab.classList.remove("active");
    cashReceiptTab.classList.remove("active");
    statisticsTab.classList.remove("active");
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
    vacationView.hidden = true;
    siblingView.hidden = true;
    cashReceiptView.hidden = true;
    statisticsView.hidden = true;
    requestTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    vacationTab.classList.remove("active");
    siblingTab.classList.remove("active");
    cashReceiptTab.classList.remove("active");
    statisticsTab.classList.remove("active");
    showNotice("");
    await loadPaymentRequests();
  });
  studentRequestTab.addEventListener("click", async () => {
    studentView.hidden = true;
    paymentView.hidden = true;
    requestView.hidden = true;
    studentRequestView.hidden = false;
    vacationView.hidden = true;
    siblingView.hidden = true;
    cashReceiptView.hidden = true;
    statisticsView.hidden = true;
    studentRequestTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    vacationTab.classList.remove("active");
    siblingTab.classList.remove("active");
    cashReceiptTab.classList.remove("active");
    statisticsTab.classList.remove("active");
    showNotice("");
    await loadStudentRequests();
  });
  vacationTab.addEventListener("click", async () => {
    studentView.hidden = true;
    paymentView.hidden = true;
    requestView.hidden = true;
    studentRequestView.hidden = true;
    vacationView.hidden = false;
    siblingView.hidden = true;
    cashReceiptView.hidden = true;
    statisticsView.hidden = true;
    vacationTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    siblingTab.classList.remove("active");
    cashReceiptTab.classList.remove("active");
    statisticsTab.classList.remove("active");
    showNotice("");
    await loadVacationWorkspace();
  });
  siblingTab.addEventListener("click", async () => {
    studentView.hidden = true;
    paymentView.hidden = true;
    requestView.hidden = true;
    studentRequestView.hidden = true;
    vacationView.hidden = true;
    siblingView.hidden = false;
    cashReceiptView.hidden = true;
    statisticsView.hidden = true;
    siblingTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    vacationTab.classList.remove("active");
    cashReceiptTab.classList.remove("active");
    statisticsTab.classList.remove("active");
    showNotice("");
    await loadSiblingWorkspace();
  });
  cashReceiptTab.addEventListener("click", async () => {
    if (state.profile.role !== "SUPER_ADMIN") return;
    studentView.hidden = true;
    paymentView.hidden = true;
    requestView.hidden = true;
    studentRequestView.hidden = true;
    vacationView.hidden = true;
    siblingView.hidden = true;
    cashReceiptView.hidden = false;
    statisticsView.hidden = true;
    cashReceiptTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    vacationTab.classList.remove("active");
    siblingTab.classList.remove("active");
    statisticsTab.classList.remove("active");
    showNotice("");
    await loadCashReceiptWorkspace();
  });
  statisticsTab.addEventListener("click", async () => {
    if (state.profile.role !== "SUPER_ADMIN") return;
    studentView.hidden = true;
    paymentView.hidden = true;
    requestView.hidden = true;
    studentRequestView.hidden = true;
    vacationView.hidden = true;
    siblingView.hidden = true;
    cashReceiptView.hidden = true;
    statisticsView.hidden = false;
    statisticsTab.classList.add("active");
    studentTab.classList.remove("active");
    paymentTab.classList.remove("active");
    requestTab.classList.remove("active");
    studentRequestTab.classList.remove("active");
    vacationTab.classList.remove("active");
    siblingTab.classList.remove("active");
    cashReceiptTab.classList.remove("active");
    showNotice("");
    if (!state.statisticsReady) await loadStatisticsOverview();
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

function createStatisticsTablePanel(titleText, copyText, tableId, columns) {
  const panel = element("section", "student-panel statistics-panel");
  const toolbar = element("div", "toolbar statistics-panel-header");
  toolbar.append(element("strong", "statistics-panel-title", titleText), element("p", "request-toolbar-copy", copyText));
  panel.append(toolbar);
  const wrap = element("div", "table-wrap");
  const table = element("table", "student-table statistics-table");
  const thead = element("thead");
  const head = element("tr");
  columns.forEach((label) => head.append(element("th", "", label)));
  thead.append(head);
  const tbody = element("tbody");
  tbody.id = tableId;
  table.append(thead, tbody);
  wrap.append(table);
  panel.append(wrap);
  return panel;
}

function createStatisticsView() {
  const view = element("div", "view-section statistics-view");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow statistics-eyebrow", "PERIOD ANALYTICS"));
  title.append(element("h1", "page-title", "기간별 통계"));
  title.append(element("p", "page-copy", "저장된 월별 스냅샷과 현재 수납·급여 원장을 함께 계산합니다."));
  const actions = element("div", "heading-actions");
  const exportButton = element("button", "quiet-button", "월별 CSV 저장");
  exportButton.id = "statistics-export";
  exportButton.type = "button";
  exportButton.disabled = true;
  exportButton.addEventListener("click", downloadStatisticsCsv);
  actions.append(exportButton);
  heading.append(title, actions);
  view.append(heading);

  const controlPanel = element("section", "student-panel statistics-control-panel");
  const form = element("form", "statistics-controls");
  const startField = element("label", "request-field");
  startField.append(element("span", "field-label", "시작 월"));
  const startInput = element("input", "text-input");
  startInput.id = "statistics-start";
  startInput.type = "month";
  startInput.required = true;
  startField.append(startInput);
  const endField = element("label", "request-field");
  endField.append(element("span", "field-label", "종료 월"));
  const endInput = element("input", "text-input");
  endInput.id = "statistics-end";
  endInput.type = "month";
  endInput.required = true;
  endField.append(endInput);
  const basisField = element("label", "request-field");
  basisField.append(element("span", "field-label", "매출 집계 기준"));
  const basis = element("select", "text-input");
  basis.id = "statistics-basis";
  [["PAY_DATE", "실제 납부일"], ["ATTRIBUTION", "수납 귀속월"]].forEach(([value, label]) => {
    const option = element("option", "", label);
    option.value = value;
    basis.append(option);
  });
  basisField.append(basis);
  const runButton = element("button", "primary-action-button", "통계 조회");
  runButton.id = "statistics-run";
  runButton.type = "submit";
  form.append(startField, endField, basisField, runButton);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.statisticsStart = startInput.value;
    state.statisticsEnd = endInput.value;
    state.statisticsBasis = basis.value;
    await loadPeriodStatistics();
  });
  controlPanel.append(form);
  const sourceNote = element("p", "statistics-source-note", "저장 자료 범위를 확인하고 있습니다…");
  sourceNote.id = "statistics-source-note";
  controlPanel.append(sourceNote);
  view.append(controlPanel);

  const stats = element("section", "stats-grid statistics-kpis");
  [
    ["총 수납액", "statistics-total-received", true],
    ["예상 수강료", "statistics-expected", false],
    ["수납률", "statistics-rate", false],
    ["미수금", "statistics-outstanding", false],
    ["월평균 재원생", "statistics-active", false],
    ["완납 / 부분 / 미납", "statistics-status", false],
    ["급여 지급액", "statistics-salary", false],
    ["급여 지급 후", "statistics-after-salary", false],
  ].forEach(([label, id, accent]) => {
    const card = createStat(label, "-", accent);
    card.querySelector(".stat-value").id = id;
    stats.append(card);
  });
  view.append(stats);

  view.append(createStatisticsTablePanel(
    "월별 추이",
    "수납 상태는 항상 귀속월을 기준으로 판단합니다.",
    "statistics-month-rows",
    ["월", "재원", "신규", "퇴원", "예상 수강료", "수강료 수납", "기타 수입", "총 수납", "수납률", "미수금", "급여 지급", "지급 후"]
  ));

  const dimensions = element("div", "statistics-dimension-grid");
  dimensions.append(
    createStatisticsTablePanel("원장별", "담당 학생과 수납 합계", "statistics-teacher-rows", ["원장", "학생-월", "예상", "수납"]),
    createStatisticsTablePanel("학년별", "학년별 수납 분포", "statistics-grade-rows", ["학년", "학생-월", "예상", "수납"]),
    createStatisticsTablePanel("결제수단별", "실제 결제수단 기준", "statistics-method-rows", ["결제수단", "건수", "수납액"]),
    createStatisticsTablePanel("급여 원장별", "확정·지급·잔액", "statistics-salary-rows", ["원장", "확정", "지급", "잔액"])
  );
  view.append(dimensions);

  view.append(createStatisticsTablePanel(
    "미수금 상세",
    "학생 이름을 누르면 동일한 학생 상세 정보가 열립니다.",
    "statistics-receivable-rows",
    ["귀속월", "학생", "학년", "담당", "상태", "예상", "수납", "미수금"]
  ));
  return view;
}

async function loadStatisticsOverview() {
  const { data, error } = await supabase.rpc("get_statistics_overview");
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.statisticsOverview = data || {};
  state.statisticsStart = data?.defaultStart || data?.availableStart || "";
  state.statisticsEnd = data?.defaultEnd || data?.availableEnd || "";
  state.statisticsReady = true;
  const start = document.querySelector("#statistics-start");
  const end = document.querySelector("#statistics-end");
  [start, end].forEach((input) => {
    if (!input) return;
    input.min = data?.availableStart || "";
    input.max = data?.availableEnd || "";
  });
  if (start) start.value = state.statisticsStart;
  if (end) end.value = state.statisticsEnd;
  const note = document.querySelector("#statistics-source-note");
  if (note) note.textContent = `저장 범위 ${data?.availableStart || "-"} ~ ${data?.availableEnd || "-"} · 학생-월 ${Number(data?.studentFacts || 0).toLocaleString("ko-KR")}건 · 급여정산 ${Number(data?.salarySettlements || 0).toLocaleString("ko-KR")}건`;
  await loadPeriodStatistics();
}

async function loadPeriodStatistics() {
  if (!state.statisticsStart || !state.statisticsEnd) return;
  const button = document.querySelector("#statistics-run");
  if (button) {
    button.disabled = true;
    button.textContent = "계산 중…";
  }
  const { data, error } = await supabase.rpc("get_period_statistics", {
    p_start_month: state.statisticsStart,
    p_end_month: state.statisticsEnd,
    p_revenue_basis: state.statisticsBasis,
  });
  if (button) {
    button.disabled = false;
    button.textContent = "통계 조회";
  }
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.statisticsData = data || {};
  renderPeriodStatistics();
  showNotice(`${state.statisticsStart} ~ ${state.statisticsEnd} 통계를 불러왔습니다.`, "success");
}

function setStatisticsValue(id, value) {
  const target = document.querySelector(`#${id}`);
  if (target) target.textContent = value;
}

function renderPeriodStatistics() {
  const data = state.statisticsData || {};
  const totals = data.totals || {};
  setStatisticsValue("statistics-total-received", formatMoney(totals.totalReceived));
  setStatisticsValue("statistics-expected", formatMoney(totals.expectedTuition));
  setStatisticsValue("statistics-rate", `${Number(totals.collectionRate || 0).toLocaleString("ko-KR")}%`);
  setStatisticsValue("statistics-outstanding", formatMoney(totals.outstanding));
  setStatisticsValue("statistics-active", `${Number(totals.averageActiveStudents || 0).toLocaleString("ko-KR")}명`);
  setStatisticsValue("statistics-status", `${Number(totals.fullPaid || 0).toLocaleString("ko-KR")} / ${Number(totals.partialPaid || 0).toLocaleString("ko-KR")} / ${Number(totals.unpaid || 0).toLocaleString("ko-KR")}`);
  setStatisticsValue("statistics-salary", formatMoney(totals.salaryPaidAmount));
  setStatisticsValue("statistics-after-salary", formatMoney(totals.afterSalaryAmount));
  const exportButton = document.querySelector("#statistics-export");
  if (exportButton) exportButton.disabled = !(data.months || []).length;

  const monthRows = document.querySelector("#statistics-month-rows");
  if (monthRows) {
    monthRows.replaceChildren();
    (data.months || []).forEach((item) => {
      const row = element("tr");
      [item.month, `${item.activeStudents || 0}명`, item.newStudents || 0, item.exitedStudents || 0,
        formatMoney(item.expectedTuition), formatMoney(item.tuitionReceived), formatMoney(item.otherRevenue),
        formatMoney(item.totalReceived), `${Number(item.collectionRate || 0).toLocaleString("ko-KR")}%`,
        formatMoney(item.outstanding), formatMoney(item.salaryPaidAmount), formatMoney(item.afterSalaryAmount)]
        .forEach((value, index) => row.append(element("td", index >= 4 ? "statistics-number" : "", value)));
      monthRows.append(row);
    });
  }
  renderStatisticsDimension("statistics-teacher-rows", data.teachers || [], "standard");
  renderStatisticsDimension("statistics-grade-rows", data.grades || [], "standard");
  renderStatisticsDimension("statistics-method-rows", data.methods || [], "method");
  renderStatisticsDimension("statistics-salary-rows", data.salaries || [], "salary");

  const receivableRows = document.querySelector("#statistics-receivable-rows");
  if (receivableRows) {
    receivableRows.replaceChildren();
    const items = data.receivables || [];
    if (!items.length) {
      const row = element("tr");
      const cell = element("td", "cash-receipt-empty", "선택 기간에 미수금이 없습니다.");
      cell.colSpan = 8;
      row.append(cell);
      receivableRows.append(row);
    } else {
      items.slice(0, 300).forEach((item) => {
        const row = element("tr");
        row.append(element("td", "", item.month || "-"));
        const nameCell = element("td");
        const name = element("button", "student-link", item.name || "학생");
        name.type = "button";
        name.addEventListener("click", () => openStudent(item.studentId, name));
        nameCell.append(name);
        row.append(nameCell, element("td", "", item.grade || "-"), element("td", "", item.teacher || "-"),
          element("td", "", item.status || "-"), element("td", "statistics-number", formatMoney(item.expected)),
          element("td", "statistics-number", formatMoney(item.received)), element("td", "statistics-number outstanding-cell", formatMoney(item.outstanding)));
        receivableRows.append(row);
      });
    }
  }
}

function renderStatisticsDimension(id, rows, kind) {
  const body = document.querySelector(`#${id}`);
  if (!body) return;
  body.replaceChildren();
  if (!rows.length) {
    const row = element("tr");
    const cell = element("td", "cash-receipt-empty", "표시할 자료가 없습니다.");
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
    return;
  }
  rows.forEach((item) => {
    const row = element("tr");
    let values;
    if (kind === "method") values = [item.name || "미지정", Number(item.paymentCount || 0).toLocaleString("ko-KR"), formatMoney(item.totalReceived)];
    else if (kind === "salary") values = [item.name || "미지정", formatMoney(item.finalAmount), formatMoney(item.paidAmount), formatMoney(item.balanceAmount)];
    else values = [item.name || "미지정", Number(item.activeStudents || 0).toLocaleString("ko-KR"), formatMoney(item.expectedTuition), formatMoney(item.totalReceived)];
    values.forEach((value, index) => row.append(element("td", index ? "statistics-number" : "", value)));
    body.append(row);
  });
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadStatisticsCsv() {
  const months = state.statisticsData?.months || [];
  if (!months.length) return;
  const headers = ["월", "재원생", "신규", "퇴원", "예상수강료", "수강료수납", "기타수입", "총수납", "수납률", "미수금", "급여확정", "급여지급", "급여잔액", "급여지급후"];
  const lines = [headers.map(csvCell).join(",")];
  months.forEach((item) => lines.push([
    item.month, item.activeStudents, item.newStudents, item.exitedStudents, item.expectedTuition,
    item.tuitionReceived, item.otherRevenue, item.totalReceived, item.collectionRate, item.outstanding,
    item.salaryFinalAmount, item.salaryPaidAmount, item.salaryBalanceAmount, item.afterSalaryAmount,
  ].map(csvCell).join(",")));
  const blob = new Blob(["\ufeff", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = element("a");
  link.href = url;
  link.download = `기간통계_${state.statisticsStart}_${state.statisticsEnd}_${state.statisticsBasis}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function cashReceiptMonthLabels() {
  const now = new Date();
  return [0, 1, 2].map((offset) => {
    const value = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return `${value.getMonth() + 1}월`;
  });
}

function createCashReceiptView() {
  const view = element("div", "view-section cash-receipt-view");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow cash-receipt-eyebrow", "CASH RECEIPT DIRECTORY"));
  title.append(element("h1", "page-title", "현금영수증 발급 명단"));
  title.append(element("p", "page-copy", "학생 원장의 발급번호와 입금자명을 그대로 관리하며, 모든 변경은 이력으로 남습니다."));
  const actions = element("div", "heading-actions");
  const printButton = element("button", "cash-receipt-print-button", "명단 인쇄 · PDF 저장");
  printButton.type = "button";
  printButton.addEventListener("click", () => window.print());
  const refreshButton = element("button", "quiet-button", "새로고침");
  refreshButton.type = "button";
  refreshButton.addEventListener("click", loadCashReceiptWorkspace);
  actions.append(printButton, refreshButton);
  heading.append(title, actions);
  view.append(heading);

  const stats = element("section", "stats-grid");
  const targetStat = createStat("발급 대상", "0명", true);
  targetStat.querySelector(".stat-value").id = "cash-receipt-target-total";
  const activeStat = createStat("현재 재원생", "0명");
  activeStat.querySelector(".stat-value").id = "cash-receipt-active-total";
  const changeStat = createStat("최근 변경 이력", "0건");
  changeStat.querySelector(".stat-value").id = "cash-receipt-change-total";
  stats.append(targetStat, activeStat, changeStat);
  view.append(stats);

  const addPanel = element("section", "student-panel cash-receipt-add-panel");
  const addHeader = element("div", "toolbar cash-receipt-toolbar");
  addHeader.append(
    element("strong", "cash-receipt-toolbar-title", "신규 발급 대상자 추가"),
    element("p", "request-toolbar-copy", "현재 재원 중이며 명단에 없는 학생만 선택됩니다.")
  );
  addPanel.append(addHeader);
  const form = element("form", "cash-receipt-add-form");
  const studentField = element("label", "request-field");
  studentField.append(element("span", "field-label", "학생 선택"));
  const studentSelect = element("select", "text-input");
  studentSelect.id = "cash-receipt-student-select";
  studentSelect.required = true;
  studentField.append(studentSelect);
  const payerField = element("label", "request-field");
  payerField.append(element("span", "field-label", "입금자명"));
  const payerInput = element("input", "text-input");
  payerInput.id = "cash-receipt-payer";
  payerInput.maxLength = 40;
  payerInput.placeholder = "부모님 성함";
  payerField.append(payerInput);
  const numberField = element("label", "request-field");
  numberField.append(element("span", "field-label", "발급용 번호"));
  const numberInput = element("input", "text-input");
  numberInput.id = "cash-receipt-number";
  numberInput.maxLength = 30;
  numberInput.placeholder = "010-0000-0000";
  numberInput.required = true;
  numberField.append(numberInput);
  const addButton = element("button", "primary-action-button", "저장 · 추가");
  addButton.type = "submit";
  studentSelect.addEventListener("change", () => {
    const selected = state.cashReceiptStudents.find((student) => student.studentId === studentSelect.value);
    payerInput.value = selected?.payerName || "";
    numberInput.value = selected?.parentPhone || "";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = state.cashReceiptStudents.find((student) => student.studentId === studentSelect.value);
    if (!selected) return;
    await saveCashReceiptTarget({
      studentId: selected.studentId,
      receiptNumber: numberInput.value,
      payerName: payerInput.value,
      version: selected.version,
    }, addButton);
  });
  form.append(studentField, payerField, numberField, addButton);
  addPanel.append(form);
  view.append(addPanel);

  const listPanel = element("section", "student-panel cash-receipt-list-panel");
  const tableWrap = element("div", "table-wrap");
  const table = element("table", "student-table cash-receipt-table");
  const thead = element("thead");
  const headRow = element("tr");
  ["학년/학번", "학생명", "입금자명", "기준일", "현금영수증 번호"].forEach((labelText) => headRow.append(element("th", "", labelText)));
  cashReceiptMonthLabels().forEach((labelText) => headRow.append(element("th", "receipt-print-only", labelText)));
  headRow.append(element("th", "cash-receipt-actions", "관리"));
  thead.append(headRow);
  const tbody = element("tbody");
  tbody.id = "cash-receipt-rows";
  table.append(thead, tbody);
  tableWrap.append(table);
  listPanel.append(tableWrap);
  view.append(listPanel);

  const historyPanel = element("section", "student-panel cash-receipt-history-panel");
  const historyToolbar = element("div", "toolbar cash-receipt-toolbar");
  historyToolbar.append(
    element("strong", "cash-receipt-toolbar-title", "최근 변경 이력"),
    element("p", "request-toolbar-copy", "추가·수정·제외 시점과 처리 계정을 확인할 수 있습니다.")
  );
  historyPanel.append(historyToolbar);
  const historyList = element("div", "cash-receipt-history-list");
  historyList.id = "cash-receipt-history-list";
  historyPanel.append(historyList);
  view.append(historyPanel);
  return view;
}

async function loadCashReceiptWorkspace() {
  const { data, error } = await supabase.rpc("get_cash_receipt_workspace");
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.cashReceiptStudents = Array.isArray(data?.allStudents) ? data.allStudents : [];
  state.cashReceiptRows = Array.isArray(data?.receiptList) ? data.receiptList : [];
  state.cashReceiptChanges = Array.isArray(data?.recentChanges) ? data.recentChanges : [];
  state.cashReceiptReady = true;
  renderCashReceiptWorkspace();
}

function renderCashReceiptWorkspace() {
  const targetTotal = document.querySelector("#cash-receipt-target-total");
  const activeTotal = document.querySelector("#cash-receipt-active-total");
  const changeTotal = document.querySelector("#cash-receipt-change-total");
  if (targetTotal) targetTotal.textContent = `${state.cashReceiptRows.length.toLocaleString("ko-KR")}명`;
  if (activeTotal) activeTotal.textContent = `${state.cashReceiptStudents.length.toLocaleString("ko-KR")}명`;
  if (changeTotal) changeTotal.textContent = `${state.cashReceiptChanges.length.toLocaleString("ko-KR")}건`;

  const select = document.querySelector("#cash-receipt-student-select");
  if (select) {
    select.replaceChildren();
    const placeholder = element("option", "", "학생을 선택하세요");
    placeholder.value = "";
    placeholder.selected = true;
    placeholder.disabled = true;
    select.append(placeholder);
    const registered = new Set(state.cashReceiptRows.map((row) => row.studentId));
    state.cashReceiptStudents.filter((student) => !registered.has(student.studentId)).forEach((student) => {
      const option = element("option", "", `${student.studentName} · ${student.gradeLabel || "학년 미지정"}`);
      option.value = student.studentId;
      select.append(option);
    });
  }
  const payer = document.querySelector("#cash-receipt-payer");
  const number = document.querySelector("#cash-receipt-number");
  if (payer) payer.value = "";
  if (number) number.value = "";

  const rows = document.querySelector("#cash-receipt-rows");
  if (rows) {
    rows.replaceChildren();
    if (!state.cashReceiptRows.length) {
      const tr = element("tr");
      const td = element("td", "cash-receipt-empty", "등록된 발급 대상자가 없습니다.");
      td.colSpan = 9;
      tr.append(td);
      rows.append(tr);
    } else {
      state.cashReceiptRows.forEach((item) => {
        const tr = element("tr");
        tr.append(element("td", "", item.gradeLabel || "-"));
        const studentCell = element("td");
        const studentLink = element("button", "student-link", item.studentName || "학생");
        studentLink.type = "button";
        studentLink.addEventListener("click", () => openStudent(item.studentId, studentLink));
        studentCell.append(studentLink);
        if (item.status !== "재원") studentCell.append(element("span", "scheduled-badge", item.status || "상태 미지정"));
        tr.append(studentCell);
        const payerCell = element("td");
        const payerInput = element("input", "cash-receipt-inline-input");
        payerInput.value = item.payerName || "";
        payerInput.maxLength = 40;
        payerInput.placeholder = "입금자명";
        payerInput.setAttribute("aria-label", `${item.studentName} 입금자명`);
        payerCell.append(payerInput);
        tr.append(payerCell);
        tr.append(element("td", "", item.baseDay ? `매월 ${item.baseDay}일` : "-"));
        const numberCell = element("td");
        const numberInput = element("input", "cash-receipt-inline-input receipt-number-input");
        numberInput.value = item.receiptNumber || "";
        numberInput.maxLength = 30;
        numberInput.placeholder = "발급용 번호";
        numberInput.setAttribute("aria-label", `${item.studentName} 현금영수증 번호`);
        numberCell.append(numberInput);
        tr.append(numberCell);
        cashReceiptMonthLabels().forEach(() => {
          const monthCell = element("td", "receipt-print-only");
          const check = element("input", "receipt-print-check");
          check.type = "checkbox";
          monthCell.append(check);
          tr.append(monthCell);
        });
        const actionCell = element("td", "cash-receipt-actions");
        const saveButton = element("button", "table-action-button", "저장");
        const removeButton = element("button", "danger-button compact", "제외");
        saveButton.type = removeButton.type = "button";
        saveButton.addEventListener("click", () => saveCashReceiptTarget({
          studentId: item.studentId,
          receiptNumber: numberInput.value,
          payerName: payerInput.value,
          version: item.version,
        }, saveButton));
        removeButton.addEventListener("click", () => removeCashReceiptTarget(item, removeButton));
        actionCell.append(saveButton, removeButton);
        tr.append(actionCell);
        rows.append(tr);
      });
    }
  }
  renderCashReceiptHistory();
}

function renderCashReceiptHistory() {
  const list = document.querySelector("#cash-receipt-history-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.cashReceiptChanges.length) {
    list.append(element("p", "vacation-empty", "수파베이스 전환 후 변경 이력이 아직 없습니다."));
    return;
  }
  const actionLabels = { ADD: "명단 추가", UPDATE: "정보 수정", REMOVE: "명단 제외" };
  state.cashReceiptChanges.forEach((change) => {
    const row = element("article", "cash-receipt-history-row");
    const summary = element("div", "cash-receipt-history-summary");
    const name = element("button", "student-link", change.studentName || "학생");
    name.type = "button";
    name.addEventListener("click", () => openStudent(change.studentId, name));
    summary.append(name, element("span", `cash-receipt-change-action action-${String(change.action || "").toLowerCase()}`, actionLabels[change.action] || change.action));
    const detail = element("p", "cash-receipt-history-detail");
    const before = `${change.beforePayerName || "-"} / ${change.beforeReceiptNumber || "-"}`;
    const after = `${change.afterPayerName || "-"} / ${change.afterReceiptNumber || "-"}`;
    detail.textContent = `${before} → ${after}`;
    const meta = element("span", "cash-receipt-history-meta", `${change.createdAt || ""} · ${change.actorEmail || ""}`);
    row.append(summary, detail, meta);
    list.append(row);
  });
}

async function saveCashReceiptTarget(target, button) {
  const receiptNumber = String(target.receiptNumber || "").trim();
  if (!receiptNumber) {
    showNotice("현금영수증 발급용 번호를 입력해주세요.", "error");
    return;
  }
  button.disabled = true;
  const { data, error } = await supabase.rpc("update_cash_receipt_target", {
    p_student_id: target.studentId,
    p_receipt_number: receiptNumber,
    p_payer_name: String(target.payerName || "").trim() || null,
    p_is_delete: false,
    p_expected_version: target.version,
  });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    await loadCashReceiptWorkspace();
    return;
  }
  showNotice(data?.unchanged ? "변경된 내용이 없습니다." : "현금영수증 정보를 저장하고 변경 이력에 반영했습니다.", "success");
  await loadCashReceiptWorkspace();
}

async function removeCashReceiptTarget(target, button) {
  if (!window.confirm(`${target.studentName || "선택한 학생"}을(를) 현금영수증 발급 명단에서 제외할까요?`)) return;
  button.disabled = true;
  const { data, error } = await supabase.rpc("update_cash_receipt_target", {
    p_student_id: target.studentId,
    p_receipt_number: null,
    p_payer_name: null,
    p_is_delete: true,
    p_expected_version: target.version,
  });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    await loadCashReceiptWorkspace();
    return;
  }
  showNotice(data?.unchanged ? "이미 명단에서 제외된 학생입니다." : "발급 명단에서 제외하고 변경 이력에 반영했습니다.", "success");
  await loadCashReceiptWorkspace();
}

function createSiblingView() {
  const view = element("div", "view-section");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow sibling-eyebrow", "SIBLING MANAGEMENT"));
  title.append(element("h1", "page-title", "형제·자매 관계 관리"));
  title.append(element("p", "page-copy", "가족 그룹과 월별 할인액을 확인하고 변경 승인을 요청할 수 있습니다."));
  const createButton = element("button", "sibling-action-button", "+ 가족 그룹 설정 요청");
  createButton.type = "button";
  createButton.hidden = !hasPermission("SIBLING_MANAGER");
  createButton.addEventListener("click", () => openSiblingGroupModal());
  heading.append(title, createButton);
  view.append(heading);

  const stats = element("section", "stats-grid");
  const groupStat = createStat("형제 그룹", "0개", true);
  groupStat.querySelector(".stat-value").id = "sibling-group-total";
  const studentStat = createStat("그룹 소속 학생", "0명");
  studentStat.querySelector(".stat-value").id = "sibling-student-total";
  const pendingStat = createStat("승인 대기", "0건");
  pendingStat.querySelector(".stat-value").id = "sibling-request-pending";
  stats.append(groupStat, studentStat, pendingStat);
  view.append(stats);

  const groupPanel = element("section", "student-panel sibling-group-panel");
  const groupToolbar = element("div", "toolbar sibling-toolbar");
  groupToolbar.append(
    element("strong", "sibling-toolbar-title", "등록된 가족 그룹"),
    element("p", "request-toolbar-copy", "관계를 해제하면 해당 학생의 형제 할인도 0원으로 종료됩니다.")
  );
  const refresh = element("button", "quiet-button", "그룹 새로고침");
  refresh.type = "button";
  refresh.addEventListener("click", loadSiblingWorkspace);
  groupToolbar.append(refresh);
  groupPanel.append(groupToolbar);
  const groups = element("div", "sibling-group-list");
  groups.id = "sibling-group-list";
  groupPanel.append(groups);
  view.append(groupPanel);

  const requestPanel = element("section", "student-panel request-panel");
  const requestToolbar = element("div", "toolbar request-toolbar");
  const description = element("p", "request-toolbar-copy", "그룹·할인 변경은 승인 후 학생 정보와 계산 기준에 반영됩니다.");
  const status = element("select", "status-select");
  status.setAttribute("aria-label", "형제 관리 요청 상태 필터");
  [["", "전체 상태"], ["PENDING", "승인 대기"], ["APPROVED", "승인 완료"], ["REJECTED", "반려"], ["CANCELLED", "취소"]]
    .forEach(([value, labelText]) => {
      const option = element("option", "", labelText);
      option.value = value;
      option.selected = value === state.siblingRequestStatus;
      status.append(option);
    });
  status.addEventListener("change", async () => {
    state.siblingRequestStatus = status.value;
    await loadSiblingRequests();
  });
  const requestRefresh = element("button", "quiet-button", "요청 새로고침");
  requestRefresh.type = "button";
  requestRefresh.addEventListener("click", loadSiblingRequests);
  requestToolbar.append(description, status, requestRefresh);
  requestPanel.append(requestToolbar);
  const requests = element("div", "request-list");
  requests.id = "sibling-request-list";
  requestPanel.append(requests);
  view.append(requestPanel);
  return view;
}

async function loadSiblingWorkspace() {
  const { data, error } = await supabase.rpc("get_my_sibling_workspace");
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.siblingStudents = Array.isArray(data?.students) ? data.students : [];
  state.siblingGroups = Array.isArray(data?.groups) ? data.groups : [];
  state.siblingRequestCanApprove = data?.canApprove === true;
  state.siblingReady = true;
  renderSiblingGroups();
  await loadSiblingRequests();
}

function renderSiblingGroups() {
  const list = document.querySelector("#sibling-group-list");
  if (!list) return;
  list.replaceChildren();
  const groupedCount = state.siblingGroups.reduce((sum, group) => sum + (Array.isArray(group.members) ? group.members.length : 0), 0);
  const groupTotal = document.querySelector("#sibling-group-total");
  const studentTotal = document.querySelector("#sibling-student-total");
  if (groupTotal) groupTotal.textContent = `${state.siblingGroups.length.toLocaleString("ko-KR")}개`;
  if (studentTotal) studentTotal.textContent = `${groupedCount.toLocaleString("ko-KR")}명`;
  if (!state.siblingGroups.length) {
    list.append(element("p", "vacation-empty", "등록된 형제·자매 그룹이 없습니다."));
    return;
  }
  let focusCard = null;
  state.siblingGroups.forEach((group) => {
    const members = Array.isArray(group.members) ? group.members : [];
    const card = element("article", "sibling-group-card");
    card.dataset.groupId = group.groupId || "";
    const head = element("header", "sibling-group-head");
    const identity = element("div");
    identity.append(
      element("strong", "sibling-group-name", group.groupName || "이름 없는 가족"),
      element("span", "sibling-group-count", `${members.length}명 · ${group.groupId || "그룹 ID 없음"}`)
    );
    const actions = element("div", "sibling-group-actions");
    if (hasPermission("SIBLING_MANAGER")) {
      const rename = element("button", "table-action-button", "그룹명 변경");
      const ungroupAll = element("button", "danger-button compact", "전체 해제 요청");
      rename.type = ungroupAll.type = "button";
      rename.addEventListener("click", () => openSiblingGroupModal(group));
      ungroupAll.addEventListener("click", () => submitSiblingUngroup(members.map((member) => member.studentId), group.groupName || "가족 그룹"));
      actions.append(rename, ungroupAll);
    }
    head.append(identity, actions);
    const memberList = element("div", "sibling-member-list");
    members.forEach((member) => {
      const row = element("div", "sibling-member-row");
      const student = element("div", "sibling-member-student");
      const name = element("button", "student-link", member.studentName || "학생");
      name.type = "button";
      name.addEventListener("click", () => openStudent(member.studentId, name));
      student.append(name, element("span", "sibling-member-meta", `${member.gradeLabel || "학년 미지정"} · ${member.teacherName || "담당 미지정"} · ${member.status || "상태 미지정"}`));
      const discount = element("strong", "sibling-discount", `할인 ${formatMoney(member.siblingDiscount)}`);
      const memberActions = element("div", "sibling-member-actions");
      if (hasPermission("SIBLING_MANAGER")) {
        const editDiscount = element("button", "table-action-button", "할인 변경");
        const ungroup = element("button", "danger-button compact", "관계 해제");
        editDiscount.type = ungroup.type = "button";
        editDiscount.addEventListener("click", () => openSiblingDiscountModal(member));
        ungroup.addEventListener("click", () => submitSiblingUngroup([member.studentId], member.studentName || "학생"));
        memberActions.append(editDiscount, ungroup);
      }
      row.append(student, discount, memberActions);
      memberList.append(row);
      if (member.studentId === state.siblingFocusStudentId) focusCard = card;
    });
    card.append(head, memberList);
    list.append(card);
  });
  if (state.siblingFocusStudentId) {
    if (focusCard) {
      focusCard.classList.add("focused");
      window.setTimeout(() => focusCard.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
    } else {
      showNotice("현재 형제 그룹에 등록되지 않은 학생입니다.");
    }
    state.siblingFocusStudentId = "";
  }
}

async function loadSiblingRequests() {
  const { data, error } = await supabase.rpc("search_my_sibling_requests", {
    p_status: state.siblingRequestStatus || null,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.siblingRequestRows = Array.isArray(data?.rows) ? data.rows : [];
  state.siblingRequestTotal = Number(data?.total || 0);
  state.siblingRequestPending = Number(data?.pending || 0);
  state.siblingRequestCanApprove = data?.canApprove === true;
  renderSiblingRequests();
}

function renderSiblingRequests() {
  const list = document.querySelector("#sibling-request-list");
  if (!list) return;
  list.replaceChildren();
  const pending = document.querySelector("#sibling-request-pending");
  if (pending) pending.textContent = `${state.siblingRequestPending.toLocaleString("ko-KR")}건`;
  if (!state.siblingRequestRows.length) {
    const empty = element("div", "empty-state");
    empty.append(icon("✓", "empty-icon"), element("strong", "", "표시할 형제 관리 요청이 없습니다."), element("span", "", "새 그룹이나 할인 변경 요청을 등록해보세요."));
    list.append(empty);
    return;
  }
  const operationLabel = { GROUP: "가족 그룹 설정", UNGROUP: "형제 관계 해제", DISCOUNT: "형제 할인 변경" };
  state.siblingRequestRows.forEach((request) => {
    const ids = Array.isArray(request.studentIds) ? request.studentIds : [];
    const names = request.studentNames && typeof request.studentNames === "object" ? request.studentNames : {};
    const studentNames = ids.map((id) => names[id] || id).join(", ");
    const card = element("article", `request-card status-${String(request.status || "").toLowerCase()}`);
    const head = element("div", "request-card-head");
    const identity = element("div");
    identity.append(element("strong", "request-student-name", studentNames || "대상 학생"), element("span", "request-kind", operationLabel[request.operation] || request.operation));
    head.append(identity, element("span", `request-status status-${String(request.status || "").toLowerCase()}`, requestStatusLabel(request.status)));
    const grid = element("dl", "request-grid");
    [["그룹명", request.groupName || "-"], ["할인액", request.operation === "DISCOUNT" ? formatMoney(request.discountAmount) : "-"],
      ["적용 월", request.effectiveMonth || "-"], ["요청자", request.requesterName], ["대상 인원", `${ids.length}명`]]
      .forEach(([label, value]) => grid.append(detailRow(label, value)));
    card.append(head, grid);
    if (request.requestReason) card.append(element("p", "request-note", `요청 사유: ${request.requestReason}`));
    if (request.decisionMemo) card.append(element("p", "request-decision", `처리 메모: ${request.decisionMemo}`));
    card.append(element("p", "request-meta", `${request.createdAt || ""}${request.processedAt ? ` · 처리 ${request.processedAt}` : ""}`));
    if (request.status === "PENDING") {
      const actions = element("div", "request-actions");
      if (state.siblingRequestCanApprove) {
        const reject = element("button", "danger-button", "반려");
        const approve = element("button", "approve-button", "승인·반영");
        reject.type = approve.type = "button";
        reject.addEventListener("click", () => decideSiblingRequest(request, "REJECT", reject));
        approve.addEventListener("click", () => decideSiblingRequest(request, "APPROVE", approve));
        actions.append(reject, approve);
      } else {
        const cancel = element("button", "danger-button", "요청 취소");
        cancel.type = "button";
        cancel.addEventListener("click", () => cancelSiblingRequest(request, cancel));
        actions.append(cancel);
      }
      card.append(actions);
    }
    list.append(card);
  });
}

async function decideSiblingRequest(request, decision, button) {
  const action = decision === "APPROVE" ? "승인하여 학생 정보와 계산 기준에 반영" : "반려";
  if (!window.confirm(`이 형제 관리 요청을 ${action}할까요?`)) return;
  const memo = window.prompt("처리 메모가 있으면 입력해주세요. (선택)", "");
  if (memo === null) return;
  button.disabled = true;
  const { error } = await supabase.rpc("decide_sibling_request", {
    p_request_id: request.requestId,
    p_decision: decision,
    p_memo: memo.trim() || null,
  });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    await loadSiblingRequests();
    return;
  }
  showNotice(decision === "APPROVE" ? "형제 관리 요청을 승인하고 변경 이력에 반영했습니다." : "형제 관리 요청을 반려했습니다.", "success");
  await loadSiblingWorkspace();
}

async function cancelSiblingRequest(request, button) {
  if (!window.confirm("아직 승인되지 않은 이 형제 관리 요청을 취소할까요?")) return;
  button.disabled = true;
  const { error } = await supabase.rpc("cancel_my_sibling_request", { p_request_id: request.requestId });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  showNotice("형제 관리 요청을 취소했습니다.", "success");
  await loadSiblingRequests();
}

async function submitSiblingUngroup(studentIds, label) {
  if (!hasPermission("SIBLING_MANAGER")) return;
  if (!window.confirm(`${label}의 형제 관계 해제를 승인 요청할까요? 남은 구성원이 한 명이면 함께 해제됩니다.`)) return;
  const reason = window.prompt("관계 해제 사유를 입력해주세요. (선택)", "");
  if (reason === null) return;
  const { error } = await supabase.rpc("submit_sibling_request", {
    p_operation: "UNGROUP",
    p_student_ids: studentIds,
    p_group_name: null,
    p_discount_amount: null,
    p_effective_month: null,
    p_request_reason: reason.trim() || null,
    p_idempotency_key: crypto.randomUUID(),
  });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  showNotice("형제 관계 해제 승인 요청을 등록했습니다.", "success");
  await loadSiblingRequests();
}

async function openSiblingGroupModal(group = null) {
  if (!hasPermission("SIBLING_MANAGER")) return;
  if (!state.siblingReady) await loadSiblingWorkspace();
  const members = Array.isArray(group?.members) ? group.members : [];
  const fixedIds = members.map((member) => member.studentId);
  const backdrop = element("div", "modal-backdrop");
  const dialog = element("section", "student-modal sibling-request-modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const header = element("header", "modal-header");
  const titleWrap = element("div", "modal-title-wrap");
  titleWrap.append(icon("♣", "modal-title-icon sibling-icon"));
  const titles = element("div");
  titles.append(element("h2", "modal-title", group ? "가족 그룹명 변경 요청" : "가족 그룹 설정 요청"), element("p", "modal-student-name sibling-copy", "승인 전에는 학생 관계가 변경되지 않습니다."));
  titleWrap.append(titles);
  const close = element("button", "modal-close", "×");
  close.type = "button";
  header.append(titleWrap, close);
  const form = element("form", "request-form");
  const fields = element("div", "request-form-grid");
  const name = element("input", "text-input");
  name.type = "text";
  name.required = true;
  name.maxLength = 40;
  name.value = group?.groupName || "";
  name.placeholder = "예: 김온유네";
  const nameField = element("label", "request-field field-wide");
  nameField.append(element("span", "field-label", "가족 그룹명"), name);
  const students = element("select", "text-input sibling-student-multiselect");
  students.multiple = true;
  students.size = 12;
  const sourceStudents = group ? members : state.siblingStudents;
  sourceStudents.forEach((student) => {
    const option = element("option", "", `${student.studentName} · ${student.gradeLabel || "학년 미지정"} · ${student.groupName || "그룹 없음"}`);
    option.value = student.studentId;
    option.selected = fixedIds.includes(student.studentId);
    students.append(option);
  });
  if (group) students.disabled = true;
  const studentField = element("label", "request-field field-wide");
  studentField.append(element("span", "field-label", group ? "현재 구성원" : "학생 선택 · Ctrl 또는 Command로 여러 명 선택"), students);
  const reason = element("textarea", "text-area");
  reason.maxLength = 500;
  reason.placeholder = "승인 요청 메모 (선택)";
  const reasonField = element("label", "request-field field-wide");
  reasonField.append(element("span", "field-label", "요청 메모"), reason);
  fields.append(nameField, studentField, reasonField);
  const footer = element("footer", "modal-footer request-form-footer");
  const cancel = element("button", "secondary-button", "취소");
  cancel.type = "button";
  const submit = element("button", "sibling-action-button", "설정 승인 요청");
  submit.type = "submit";
  footer.append(cancel, submit);
  form.append(fields, footer);
  dialog.append(header, form);
  backdrop.append(dialog);
  document.body.append(backdrop);
  document.body.classList.add("modal-open");
  const idempotencyKey = crypto.randomUUID();
  const dismiss = () => { backdrop.remove(); document.body.classList.remove("modal-open"); };
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) dismiss(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedIds = group ? fixedIds : Array.from(students.selectedOptions).map((option) => option.value);
    if (selectedIds.length < 2) {
      const inline = form.querySelector(".form-error") || element("p", "form-error");
      inline.textContent = "형제로 묶을 학생을 2명 이상 선택해주세요.";
      if (!inline.parentNode) form.insertBefore(inline, footer);
      return;
    }
    submit.disabled = true;
    const { error } = await supabase.rpc("submit_sibling_request", {
      p_operation: "GROUP",
      p_student_ids: selectedIds,
      p_group_name: name.value.trim(),
      p_discount_amount: null,
      p_effective_month: null,
      p_request_reason: reason.value.trim() || null,
      p_idempotency_key: idempotencyKey,
    });
    submit.disabled = false;
    if (error) {
      const inline = form.querySelector(".form-error") || element("p", "form-error");
      inline.textContent = normalizeError(error);
      if (!inline.parentNode) form.insertBefore(inline, footer);
      return;
    }
    dismiss();
    showNotice(group ? "가족 그룹명 변경 승인 요청을 등록했습니다." : "가족 그룹 설정 승인 요청을 등록했습니다.", "success");
    await loadSiblingRequests();
  });
  name.focus();
}

async function openSiblingDiscountModal(member) {
  if (!hasPermission("SIBLING_MANAGER")) return;
  const backdrop = element("div", "modal-backdrop");
  const dialog = element("section", "student-modal sibling-request-modal compact-modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const header = element("header", "modal-header");
  const titleWrap = element("div", "modal-title-wrap");
  titleWrap.append(icon("₩", "modal-title-icon sibling-icon"));
  const titles = element("div");
  titles.append(element("h2", "modal-title", "형제 할인 변경 요청"), element("p", "modal-student-name sibling-copy", member.studentName || "학생"));
  titleWrap.append(titles);
  const close = element("button", "modal-close", "×");
  close.type = "button";
  header.append(titleWrap, close);
  const form = element("form", "request-form");
  const fields = element("div", "request-form-grid");
  const amount = element("input", "text-input");
  amount.type = "number";
  amount.min = "0";
  amount.max = "10000000";
  amount.step = "1000";
  amount.required = true;
  amount.value = String(Number(member.siblingDiscount || 0));
  const month = element("input", "text-input");
  month.type = "month";
  month.required = true;
  month.value = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 7);
  const reason = element("textarea", "text-area");
  reason.maxLength = 500;
  reason.placeholder = "할인 변경 사유 (선택)";
  const field = (label, control, wide = false) => {
    const wrap = element("label", wide ? "request-field field-wide" : "request-field");
    wrap.append(element("span", "field-label", label), control);
    return wrap;
  };
  fields.append(field("형제 할인액", amount), field("적용 월", month), field("요청 메모", reason, true));
  const footer = element("footer", "modal-footer request-form-footer");
  const cancel = element("button", "secondary-button", "취소");
  cancel.type = "button";
  const submit = element("button", "sibling-action-button", "할인 승인 요청");
  submit.type = "submit";
  footer.append(cancel, submit);
  form.append(fields, footer);
  dialog.append(header, form);
  backdrop.append(dialog);
  document.body.append(backdrop);
  document.body.classList.add("modal-open");
  const idempotencyKey = crypto.randomUUID();
  const dismiss = () => { backdrop.remove(); document.body.classList.remove("modal-open"); };
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) dismiss(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const { error } = await supabase.rpc("submit_sibling_request", {
      p_operation: "DISCOUNT",
      p_student_ids: [member.studentId],
      p_group_name: null,
      p_discount_amount: Number(amount.value),
      p_effective_month: `${month.value}-01`,
      p_request_reason: reason.value.trim() || null,
      p_idempotency_key: idempotencyKey,
    });
    submit.disabled = false;
    if (error) {
      const inline = form.querySelector(".form-error") || element("p", "form-error");
      inline.textContent = normalizeError(error);
      if (!inline.parentNode) form.insertBefore(inline, footer);
      return;
    }
    dismiss();
    showNotice("형제 할인 변경 승인 요청을 등록했습니다.", "success");
    await loadSiblingRequests();
  });
  amount.focus();
}

function createVacationView() {
  const view = element("div", "view-section");
  const heading = element("section", "page-heading");
  const title = element("div");
  title.append(element("p", "eyebrow vacation-eyebrow", "VACATION MANAGEMENT"));
  title.append(element("h1", "page-title", "학생 휴가 관리"));
  title.append(element("p", "page-copy", "휴가 기간을 조회하고 등록·수정·휴지통 이동을 승인 요청할 수 있습니다."));
  const createButton = element("button", "vacation-action-button", "+ 휴가 등록 요청");
  createButton.type = "button";
  createButton.hidden = !hasPermission("STUDENT_VACATION");
  createButton.addEventListener("click", () => openVacationRequestModal());
  heading.append(title, createButton);
  view.append(heading);

  const stats = element("section", "stats-grid");
  const periodStat = createStat("선택 학생 기간", "0건", true);
  periodStat.querySelector(".stat-value").id = "vacation-period-total";
  const requestStat = createStat("표시 요청", "0건");
  requestStat.querySelector(".stat-value").id = "vacation-request-total";
  const pendingStat = createStat("승인 대기", "0건");
  pendingStat.querySelector(".stat-value").id = "vacation-request-pending";
  stats.append(periodStat, requestStat, pendingStat);
  view.append(stats);

  const periodPanel = element("section", "student-panel vacation-period-panel");
  const toolbar = element("div", "toolbar vacation-toolbar");
  const student = element("select", "status-select vacation-student-select");
  student.id = "vacation-student-select";
  student.setAttribute("aria-label", "휴가 관리 학생 선택");
  student.addEventListener("change", async () => {
    state.vacationStudentId = student.value;
    await loadVacationPeriods();
  });
  const refresh = element("button", "quiet-button", "선택 학생 새로고침");
  refresh.type = "button";
  refresh.addEventListener("click", loadVacationPeriods);
  toolbar.append(element("strong", "vacation-toolbar-title", "학생별 휴가·퇴원공백"), student, refresh);
  periodPanel.append(toolbar);
  const periods = element("div", "vacation-period-list");
  periods.id = "vacation-period-list";
  periodPanel.append(periods);
  view.append(periodPanel);

  const requestPanel = element("section", "student-panel request-panel");
  const requestToolbar = element("div", "toolbar request-toolbar");
  const description = element("p", "request-toolbar-copy", "승인 완료·반려·취소 요청도 감사 이력으로 보존됩니다.");
  const status = element("select", "status-select");
  status.setAttribute("aria-label", "휴가 요청 상태 필터");
  [["", "전체 상태"], ["PENDING", "승인 대기"], ["APPROVED", "승인 완료"], ["REJECTED", "반려"], ["CANCELLED", "취소"]]
    .forEach(([value, labelText]) => {
      const option = element("option", "", labelText);
      option.value = value;
      option.selected = value === state.vacationRequestStatus;
      status.append(option);
    });
  status.addEventListener("change", async () => {
    state.vacationRequestStatus = status.value;
    await loadVacationRequests();
  });
  const requestRefresh = element("button", "quiet-button", "요청 새로고침");
  requestRefresh.type = "button";
  requestRefresh.addEventListener("click", loadVacationRequests);
  requestToolbar.append(description, status, requestRefresh);
  requestPanel.append(requestToolbar);
  const requests = element("div", "request-list");
  requests.id = "vacation-request-list";
  requestPanel.append(requests);
  view.append(requestPanel);
  return view;
}

async function loadVacationWorkspace() {
  if (!state.vacationReady) {
    try {
      state.vacationStudents = await loadRequestStudentOptions();
      state.vacationReady = true;
    } catch (error) {
      showNotice(normalizeError(error), "error");
      return;
    }
  }
  renderVacationStudentOptions();
  await Promise.all([loadVacationRequests(), loadVacationPeriods()]);
}

function renderVacationStudentOptions() {
  const select = document.querySelector("#vacation-student-select");
  if (!select) return;
  select.replaceChildren();
  const placeholder = element("option", "", `학생 선택 (${state.vacationStudents.length}명)`);
  placeholder.value = "";
  placeholder.selected = !state.vacationStudentId;
  select.append(placeholder);
  state.vacationStudents.forEach((student) => {
    const option = element("option", "", `${student.studentName} · ${student.gradeLabel || "학년 미지정"} · ${student.teacherName || "담당 미지정"}`);
    option.value = student.studentId;
    option.selected = student.studentId === state.vacationStudentId;
    select.append(option);
  });
}

async function loadVacationPeriods() {
  if (!state.vacationStudentId) {
    state.vacationPeriods = [];
    renderVacationPeriods();
    return;
  }
  const { data, error } = await supabase.rpc("get_my_student_vacations", { p_student_id: state.vacationStudentId });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.vacationPeriods = Array.isArray(data?.rows) ? data.rows : [];
  renderVacationPeriods();
}

function renderVacationPeriods() {
  const list = document.querySelector("#vacation-period-list");
  const total = document.querySelector("#vacation-period-total");
  if (total) total.textContent = `${state.vacationPeriods.length.toLocaleString("ko-KR")}건`;
  if (!list) return;
  list.replaceChildren();
  if (!state.vacationStudentId) {
    list.append(element("p", "vacation-empty", "학생을 선택하면 등록된 휴가와 퇴원공백을 표시합니다."));
    return;
  }
  if (!state.vacationPeriods.length) {
    list.append(element("p", "vacation-empty", "등록된 휴가·퇴원공백이 없습니다."));
    return;
  }
  state.vacationPeriods.forEach((period) => {
    const item = element("article", "vacation-period-item");
    const copy = element("div", "vacation-period-copy");
    copy.append(element("strong", "vacation-period-dates", `${period.startDate} ~ ${period.endDate}`));
    copy.append(element("span", "vacation-period-reason", period.reason || "사유 없음"));
    const badge = element("span", period.periodType === "퇴원공백" ? "vacation-type auto" : "vacation-type", period.periodType || "일반휴가");
    item.append(badge, copy);
    const actions = element("div", "vacation-period-actions");
    if (period.canEdit && hasPermission("STUDENT_VACATION")) {
      const edit = element("button", "table-action-button", "수정 요청");
      const remove = element("button", "danger-button compact", "휴지통 요청");
      edit.type = remove.type = "button";
      edit.addEventListener("click", () => openVacationRequestModal(period));
      remove.addEventListener("click", () => requestVacationDelete(period, remove));
      actions.append(edit, remove);
    } else {
      actions.append(element("span", "vacation-managed", "자동 관리"));
    }
    item.append(actions);
    list.append(item);
  });
}

async function loadVacationRequests() {
  const { data, error } = await supabase.rpc("search_my_vacation_requests", {
    p_status: state.vacationRequestStatus || null,
    p_limit: 200,
    p_offset: 0,
  });
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  state.vacationRequestRows = Array.isArray(data?.rows) ? data.rows : [];
  state.vacationRequestTotal = Number(data?.total || 0);
  state.vacationRequestPending = Number(data?.pending || 0);
  state.vacationRequestCanApprove = data?.canApprove === true;
  renderVacationRequests();
}

function renderVacationRequests() {
  const list = document.querySelector("#vacation-request-list");
  if (!list) return;
  list.replaceChildren();
  const total = document.querySelector("#vacation-request-total");
  const pending = document.querySelector("#vacation-request-pending");
  if (total) total.textContent = `${state.vacationRequestTotal.toLocaleString("ko-KR")}건`;
  if (pending) pending.textContent = `${state.vacationRequestPending.toLocaleString("ko-KR")}건`;
  if (!state.vacationRequestRows.length) {
    const empty = element("div", "empty-state");
    empty.append(icon("✓", "empty-icon"), element("strong", "", "표시할 휴가 요청이 없습니다."), element("span", "", "학생을 선택해 새 휴가 요청을 등록해보세요."));
    list.append(empty);
    return;
  }
  const operationLabel = { CREATE: "등록 요청", UPDATE: "수정 요청", DELETE: "휴지통 요청" };
  state.vacationRequestRows.forEach((request) => {
    const card = element("article", `request-card status-${String(request.status || "").toLowerCase()}`);
    const head = element("div", "request-card-head");
    const identity = element("div");
    const nameButton = element("button", "student-link request-student", request.studentName || "학생");
    nameButton.type = "button";
    nameButton.addEventListener("click", () => openStudent(request.studentId, nameButton));
    identity.append(nameButton, element("span", "request-kind", operationLabel[request.operation] || request.operation));
    head.append(identity, element("span", `request-status status-${String(request.status || "").toLowerCase()}`, requestStatusLabel(request.status)));
    const grid = element("dl", "request-grid");
    [["시작일", request.startDate], ["종료일", request.endDate], ["기간 유형", request.periodType],
      ["휴가 사유", request.vacationReason || "-"], ["요청자", request.requesterName], ["대상 ID", request.targetPeriodId || "신규"]]
      .forEach(([label, value]) => grid.append(detailRow(label, value)));
    card.append(head, grid);
    if (request.requestReason) card.append(element("p", "request-note", `요청 사유: ${request.requestReason}`));
    if (request.decisionMemo) card.append(element("p", "request-decision", `처리 메모: ${request.decisionMemo}`));
    card.append(element("p", "request-meta", `${request.createdAt || ""}${request.processedAt ? ` · 처리 ${request.processedAt}` : ""}`));
    if (request.status === "PENDING") {
      const actions = element("div", "request-actions");
      if (state.vacationRequestCanApprove) {
        const reject = element("button", "danger-button", "반려");
        const approve = element("button", "approve-button", request.operation === "DELETE" ? "승인·휴지통" : "승인·반영");
        reject.type = approve.type = "button";
        reject.addEventListener("click", () => decideVacationRequest(request, "REJECT", reject));
        approve.addEventListener("click", () => decideVacationRequest(request, "APPROVE", approve));
        actions.append(reject, approve);
      } else {
        const cancel = element("button", "danger-button", "요청 취소");
        cancel.type = "button";
        cancel.addEventListener("click", () => cancelVacationRequest(request, cancel));
        actions.append(cancel);
      }
      card.append(actions);
    }
    list.append(card);
  });
}

async function decideVacationRequest(request, decision, button) {
  const actionText = decision === "APPROVE" ? "승인하여 휴가 원장에 반영" : "반려";
  if (!window.confirm(`${request.studentName} 학생의 휴가 요청을 ${actionText}할까요?`)) return;
  const memo = window.prompt("처리 메모가 있으면 입력해주세요. (선택)", "");
  if (memo === null) return;
  button.disabled = true;
  const { error } = await supabase.rpc("decide_vacation_request", {
    p_request_id: request.requestId,
    p_decision: decision,
    p_memo: memo.trim() || null,
  });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    await loadVacationRequests();
    return;
  }
  showNotice(decision === "APPROVE" ? "승인한 내용이 휴가 원장과 변경 이력에 반영되었습니다." : "휴가 요청을 반려했습니다.", "success");
  await Promise.all([loadVacationRequests(), loadVacationPeriods()]);
}

async function cancelVacationRequest(request, button) {
  if (!window.confirm("아직 승인되지 않은 이 휴가 요청을 취소할까요?")) return;
  button.disabled = true;
  const { error } = await supabase.rpc("cancel_my_vacation_request", { p_request_id: request.requestId });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  showNotice("휴가 요청을 취소했습니다.", "success");
  await loadVacationRequests();
}

async function requestVacationDelete(period, button) {
  if (!window.confirm(`${period.startDate} ~ ${period.endDate} 휴가를 휴지통으로 이동 요청할까요?`)) return;
  const reason = window.prompt("휴지통 이동 사유를 입력해주세요.", "기간 관리 화면에서 삭제");
  if (reason === null || !reason.trim()) return;
  button.disabled = true;
  const { error } = await supabase.rpc("submit_vacation_request", {
    p_operation: "DELETE",
    p_student_id: state.vacationStudentId,
    p_period_id: period.periodId,
    p_start_date: null,
    p_end_date: null,
    p_vacation_reason: null,
    p_request_reason: reason.trim(),
    p_idempotency_key: crypto.randomUUID(),
  });
  button.disabled = false;
  if (error) {
    showNotice(normalizeError(error), "error");
    return;
  }
  showNotice("휴지통 이동 승인 요청을 등록했습니다.", "success");
  await loadVacationRequests();
}

async function openVacationRequestModal(period = null) {
  const isEdit = Boolean(period?.periodId);
  if (!hasPermission("STUDENT_VACATION")) {
    showNotice("이 계정에는 학생 휴가 권한이 없습니다.", "error");
    return;
  }
  if (!state.vacationStudents.length) {
    try {
      state.vacationStudents = await loadRequestStudentOptions();
      state.vacationReady = true;
    } catch (error) {
      showNotice(normalizeError(error), "error");
      return;
    }
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const selectedStudentId = period?.studentId || state.vacationStudentId || "";
  const backdrop = element("div", "modal-backdrop");
  const dialog = element("section", "student-modal vacation-request-modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "vacation-request-modal-title");
  const header = element("header", "modal-header");
  const titleWrap = element("div", "modal-title-wrap");
  titleWrap.append(icon("☀", "modal-title-icon vacation-icon"));
  const titles = element("div");
  const title = element("h2", "modal-title", isEdit ? "휴가 기간 수정 요청" : "휴가 등록 요청");
  title.id = "vacation-request-modal-title";
  titles.append(title, element("p", "modal-student-name vacation-copy", "승인 전에는 휴가 원장이 변경되지 않습니다."));
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
  const student = element("select", "text-input");
  student.required = true;
  const placeholder = element("option", "", "학생 선택");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = !selectedStudentId;
  student.append(placeholder);
  state.vacationStudents.forEach((item) => {
    const option = element("option", "", `${item.studentName} · ${item.gradeLabel || "학년 미지정"}`);
    option.value = item.studentId;
    option.selected = item.studentId === selectedStudentId;
    student.append(option);
  });
  if (isEdit) student.disabled = true;
  const startDate = element("input", "text-input");
  startDate.type = "date";
  startDate.required = true;
  startDate.value = period?.startDate || today;
  const endDate = element("input", "text-input");
  endDate.type = "date";
  endDate.required = true;
  endDate.value = period?.endDate || today;
  const vacationReason = element("input", "text-input");
  vacationReason.type = "text";
  vacationReason.maxLength = 300;
  vacationReason.placeholder = "예: 가족여행, 병가";
  vacationReason.value = period?.reason || "";
  const requestReason = element("textarea", "text-area");
  requestReason.maxLength = 500;
  requestReason.placeholder = isEdit ? "수정 요청 사유 (선택)" : "승인 요청 메모 (선택)";
  const fields = element("div", "request-form-grid");
  fields.append(field("학생", student, true), field("휴가 시작일", startDate), field("휴가 종료일", endDate),
    field("휴가 사유", vacationReason, true), field("요청 메모", requestReason, true));
  const footer = element("footer", "modal-footer request-form-footer");
  const cancel = element("button", "secondary-button", "취소");
  cancel.type = "button";
  const submit = element("button", "vacation-action-button", isEdit ? "수정 승인 요청" : "등록 승인 요청");
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
    if (startDate.value > endDate.value) {
      const inline = form.querySelector(".form-error") || element("p", "form-error");
      inline.textContent = "휴가 종료일은 시작일보다 빠를 수 없습니다.";
      if (!inline.parentNode) form.insertBefore(inline, footer);
      return;
    }
    submit.disabled = true;
    submit.textContent = "요청 저장 중…";
    const { error } = await supabase.rpc("submit_vacation_request", {
      p_operation: isEdit ? "UPDATE" : "CREATE",
      p_student_id: student.value,
      p_period_id: period?.periodId || null,
      p_start_date: startDate.value,
      p_end_date: endDate.value,
      p_vacation_reason: vacationReason.value.trim() || null,
      p_request_reason: requestReason.value.trim() || null,
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
    state.vacationStudentId = student.value;
    dismiss();
    document.querySelector("#vacation-tab")?.click();
    showNotice(isEdit ? "휴가 수정 승인 요청을 등록했습니다." : "휴가 등록 승인 요청을 등록했습니다.", "success");
  });
  student.focus();
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
  const digits = String(value ?? "").replace(/[^0-9-]/g, "");
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
  footer.append(closeBottom);
  if (hasPermission("STUDENT_VACATION")) {
    const vacation = element("button", "vacation-action-button", "휴가 관리");
    vacation.type = "button";
    vacation.addEventListener("click", () => {
      state.vacationStudentId = studentId;
      dismiss();
      document.querySelector("#vacation-tab")?.click();
    });
    footer.append(vacation);
  }
  if (hasPermission("SIBLING_MANAGER")) {
    const sibling = element("button", "sibling-action-button", "형제 관리");
    sibling.type = "button";
    sibling.addEventListener("click", () => {
      state.siblingFocusStudentId = studentId;
      dismiss();
      document.querySelector("#sibling-tab")?.click();
    });
    footer.append(sibling);
  }
  if (state.studentReference?.canEdit) {
    const edit = element("button", "primary-action-button", "학생 정보 수정 요청");
    edit.type = "button";
    edit.addEventListener("click", () => {
      dismiss();
      openStudentRequestModal(studentId);
    });
    footer.append(edit);
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
