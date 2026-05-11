(function () {
  const TOKEN_KEY = "scheduler-auth-token-v1";
  const API = "/api";
  const OPEN_HOUR = 7;
  const CLOSE_HOUR = 22;
  const CLOSE_MINUTE = 30;
  const HOURS = Array.from({ length: CLOSE_HOUR - OPEN_HOUR + 1 }, (_, index) => index + OPEN_HOUR);
  const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

  let state = {
    currentUser: null,
    users: [],
    locations: [],
    bookings: [],
    pointTransactions: [],
    scheduling: { cycleStart: "", releaseAt: "", priorityEndsAt: "", coaches: [] },
    rentalAvailability: { isOpen: false, startDate: "", endDate: "", completedCount: 0, totalCount: 0 },
    config: { cancelCutoffHours: 1, openHour: 7, closeHour: 22, closeMinute: 30 },
    settings: {}
  };
  let token = localStorage.getItem(TOKEN_KEY) || "";
  let selectedLocationId = "";
  let selectedWeekDate = startOfWeek(new Date());
  let authMode = "login";
  let authOpen = false;
  let activeAdminTab = "overview";
  let modalSlot = null;
  let detailLocationId = "";
  let editLocationId = "";
  let statsRange = defaultMonthRange();
  let statsRows = [];
  let statsSummary = { totalPoints: 0, totalRevenue: 0 };

  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function datetimeLocalValue(date) {
    return `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function dateLabel(date) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function dateText(value) {
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function startOfWeek(date) {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    const day = next.getDay() || 7;
    next.setDate(next.getDate() - day + 1);
    return next;
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function addHours(date, hours) {
    const next = new Date(date);
    next.setMinutes(next.getMinutes() + hours * 60);
    return next;
  }

  function addMinutes(date, minutes) {
    const next = new Date(date);
    next.setMinutes(next.getMinutes() + minutes);
    return next;
  }

  function endOfRentalDay(date) {
    const close = new Date(date);
    close.setHours(CLOSE_HOUR, CLOSE_MINUTE, 0, 0);
    return close;
  }

  function defaultMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: dateKey(start), end: dateKey(end) };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatClock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatTimeRange(start, end) {
    return `${formatClock(new Date(start))}-${formatClock(new Date(end))}`;
  }

  function formatPoints(points) {
    return Number(points).toFixed(points % 1 ? 1 : 0);
  }

  function formatMoney(amount) {
    return Number(amount || 0).toLocaleString("zh-TW", {
      minimumFractionDigits: Number(amount || 0) % 1 ? 1 : 0,
      maximumFractionDigits: 2
    });
  }

  function bookingHours(booking) {
    return (new Date(booking.end) - new Date(booking.start)) / 36e5;
  }

  function transactionLabel(transaction) {
    if (transaction.type === "credit") return "儲值";
    if (transaction.source === "booking") return "租用扣點";
    if (transaction.source === "manual-adjustment") return "管理者扣點";
    return "點數異動";
  }

  function formatTransactionAmount(amount) {
    const value = Number(amount);
    return `${value > 0 ? "+" : ""}${formatPoints(value)} 點`;
  }

  function scheduleStatusLabel(user) {
    return user?.scheduleCompleted ? "已排課" : "未排課";
  }

  function scheduleStatusClass(user) {
    return user?.scheduleCompleted ? "ok" : "pending";
  }

  function rentalAvailabilityLabel() {
    const availability = state.rentalAvailability || {};
    const range = `${dateText(availability.startDate)}到${dateText(availability.endDate)}`;
    return `${availability.isOpen ? "已開放" : "尚未開放"}${range}場租`;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
  }

  function getUserName(userId) {
    return state.users.find((user) => user.id === userId)?.name || "未知使用者";
  }

  function displayBookingOwner(booking, user) {
    if (!user) return "已佔用";
    return getUserName(booking.userId);
  }

  function roleLabel(role) {
    return { admin: "管理者", coach: "教練" }[role] || "教練";
  }

  function approvalLabel(status) {
    return { approved: "已通過", pending: "等待審核", rejected: "未通過" }[status] || "已通過";
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${API}${path}`, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "伺服器發生錯誤。");
    return payload;
  }

  function photoFileData(form) {
    const file = form.get("photo");
    if (!(file instanceof File) || !file.size) return Promise.resolve("");
    if (!file.type.startsWith("image/")) return Promise.reject(new Error("請上傳圖片檔。"));
    if (file.size > 5 * 1024 * 1024) return Promise.reject(new Error("圖片大小不能超過 5MB。"));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")));
      reader.addEventListener("error", () => reject(new Error("圖片讀取失敗。")));
      reader.readAsDataURL(file);
    });
  }

  async function refresh() {
    try {
      const data = await request("/bootstrap");
      state = data;
      if (!state.currentUser) {
        token = "";
        localStorage.removeItem(TOKEN_KEY);
      }
      if (!state.locations.some((location) => location.id === selectedLocationId)) {
        selectedLocationId = state.locations[0]?.id || "";
      }
      render();
    } catch (error) {
      localStorage.removeItem(TOKEN_KEY);
      token = "";
      state.currentUser = null;
      render();
      showToast(error.message);
    }
  }

  function canUserBook(user, slotStart) {
    if (!user) return { ok: false, message: "請先登入。" };
    if (user.role === "admin") return { ok: true };
    if (slotStart < new Date()) return { ok: false, message: "不能排定已經過去的時段。" };

    const thisWeekStart = startOfWeek(new Date());
    const nextWeekStart = startOfWeek(addDays(new Date(), 7));
    const nextWeekEnd = addDays(nextWeekStart, 7);
    const releaseTime = addDays(nextWeekStart, -3);
    releaseTime.setHours(12, 0, 0, 0);

    if (slotStart < thisWeekStart || slotStart >= nextWeekEnd) {
      return { ok: false, message: "教練只能排定本週或下週一到週日。" };
    }
    if (slotStart < nextWeekStart) {
      return { ok: true };
    }
    if (new Date() < releaseTime) {
      return { ok: false, message: `下週時段將於 ${dateKey(releaseTime)} 12:00 開放。` };
    }
    const priorityEndsAt = addDays(nextWeekStart, -1);
    priorityEndsAt.setHours(12, 0, 0, 0);
    if (new Date() < priorityEndsAt) {
      const blockers = (state.scheduling?.coaches || [])
        .filter((coach) => coach.id !== user.id && Number(coach.schedulePriority || 9999) < Number(user.schedulePriority || 9999) && !coach.scheduleCompleted)
        .map((coach) => coach.name);
      if (blockers.length) {
        return { ok: false, message: `請等待優先序較前的教練完成排課：${blockers.join("、")}。` };
      }
    }
    return { ok: true };
  }

  function isWithinRentalHours(start, end) {
    const open = new Date(start);
    open.setHours(OPEN_HOUR, 0, 0, 0);
    return start >= open && end <= endOfRentalDay(start) && dateKey(start) === dateKey(end);
  }

  function findOverlap(locationId, start, end) {
    return state.bookings.find((booking) => {
      if (booking.locationId !== locationId) return false;
      return overlaps(start, end, new Date(booking.start), new Date(booking.end));
    });
  }

  function findOverlaps(locationId, start, end) {
    return state.bookings.filter((booking) => {
      if (booking.locationId !== locationId) return false;
      return overlaps(start, end, new Date(booking.start), new Date(booking.end));
    });
  }

  function bookingsForSlot(locationId, day, hour) {
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    const end = addHours(start, 1);
    return state.bookings.filter((booking) => {
      if (booking.locationId !== locationId) return false;
      return overlaps(start, end, new Date(booking.start), new Date(booking.end));
    });
  }

  function visibleSegmentsForSlot(locationId, day, hour) {
    const bookings = bookingsForSlot(locationId, day, hour);
    return bookings
      .map((booking) => ({ booking, segment: bookingSegmentForHour(booking, day, hour) }))
      .filter((item) => item.segment)
      .map((item, _index, items) => {
        const concurrent = items.filter((other) => {
          const aStart = item.segment.top;
          const aEnd = item.segment.top + item.segment.height;
          const bStart = other.segment.top;
          const bEnd = other.segment.top + other.segment.height;
          return aStart < bEnd && aEnd > bStart;
        });
        const slotIndex = concurrent.findIndex((other) => other.booking.id === item.booking.id);
        return {
          ...item,
          laneIndex: Math.max(0, slotIndex),
          laneCount: Math.max(1, concurrent.length)
        };
      });
  }

  function bookingSegmentForHour(booking, day, hour) {
    const hourStart = new Date(day);
    hourStart.setHours(hour, 0, 0, 0);
    const hourEnd = addHours(hourStart, 1);
    const bookingStart = new Date(booking.start);
    const bookingEnd = new Date(booking.end);
    if (!overlaps(hourStart, hourEnd, bookingStart, bookingEnd)) return null;

    const segmentStart = bookingStart > hourStart ? bookingStart : hourStart;
    const segmentEnd = bookingEnd < hourEnd ? bookingEnd : hourEnd;
    return {
      top: ((segmentStart - hourStart) / 36e5) * 100,
      height: ((segmentEnd - segmentStart) / 36e5) * 100,
      isFirst: segmentStart.getTime() === bookingStart.getTime()
    };
  }

  function durationOptions(start) {
    const close = endOfRentalDay(start);
    const maxUnits = Math.floor((close - start) / 18e5);
    return Array.from({ length: Math.max(0, maxUnits) }, (_, index) => (index + 1) * 0.5);
  }

  function cancelPermission(user, booking) {
    if (!user) return { ok: false, message: "請先登入。" };
    if (user.role === "admin") return { ok: true };
    if (booking.userId !== user.id) return { ok: false, message: "只能取消自己的租用。" };
    if ((new Date(booking.start) - new Date()) / 36e5 <= Number(state.config?.cancelCutoffHours || 1)) {
      return { ok: false, message: `開始前 ${Number(state.config?.cancelCutoffHours || 1)} 小時內需由管理者取消。` };
    }
    return { ok: true };
  }

  function render() {
    renderApp(state.currentUser);
  }

  function renderAuth() {
    return `
      <div class="modal-backdrop auth-backdrop">
        <section class="auth-card">
          <button class="icon-btn close-auth" id="closeAuth" type="button" aria-label="關閉登入視窗">×</button>
          <div class="tabs" role="tablist">
            <button class="tab-btn ${authMode === "login" ? "active" : ""}" data-auth-mode="login">登入</button>
            <button class="tab-btn ${authMode === "register" ? "active" : ""}" data-auth-mode="register">註冊</button>
          </div>
          <form id="authForm" class="form-grid">
            ${authMode === "register" ? `
              <label>姓名
                <input name="name" autocomplete="name" required placeholder="例：王小明">
              </label>
              <label>電話
                <input name="phone" autocomplete="tel" required placeholder="例：0912-345-678">
              </label>
            ` : ""}
            <label>帳號
              <input name="username" autocomplete="username" required placeholder="輸入帳號">
            </label>
            <label>密碼
              <input name="password" type="password" autocomplete="${authMode === "login" ? "current-password" : "new-password"}" required placeholder="至少 6 個字">
            </label>
            <button class="btn" type="submit">${authMode === "login" ? "登入系統" : "建立帳號"}</button>
            ${authMode === "register" ? `<p class="small">送出後需等待管理者審核，審核通過才可登入與排課。</p>` : ""}
          </form>
        </section>
      </div>
    `;
  }

  function bindAuthEvents() {
    document.querySelectorAll("[data-auth-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        authMode = button.dataset.authMode;
        render();
      });
    });
    document.getElementById("authForm")?.addEventListener("submit", handleAuth);
    document.getElementById("closeAuth")?.addEventListener("click", () => {
      authOpen = false;
      render();
    });
    document.querySelector(".auth-backdrop")?.addEventListener("click", (event) => {
      if (event.target.classList.contains("auth-backdrop")) {
        authOpen = false;
        render();
      }
    });
  }

  async function handleAuth(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      username: String(form.get("username")).trim(),
      password: String(form.get("password")).trim()
    };
    if (authMode === "register") {
      body.name = String(form.get("name")).trim();
      body.phone = String(form.get("phone")).trim();
    }

    try {
      const result = await request(authMode === "login" ? "/login" : "/register", {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (authMode === "register") {
        authMode = "login";
        showToast(result.message || "註冊已送出，請等待管理者審核。");
        render();
        return;
      }
      token = result.token;
      localStorage.setItem(TOKEN_KEY, token);
      authOpen = false;
      await refresh();
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderApp(user) {
    const location = state.locations.find((item) => item.id === selectedLocationId);
    app.innerHTML = `
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">排</div>
            <div>
              <h1>場地排課租用</h1>
              <p>線上資料庫版本</p>
            </div>
          </div>
          <div class="userbox">
            ${user ? `
              <div class="user-meta">
                <strong>${escapeHtml(user.name)}</strong>
                <p>${escapeHtml(user.username)}${user.role === "admin" ? ` · <span class="role-pill">${roleLabel(user.role)}</span>` : ` · ${scheduleStatusLabel(user)}`} · ${formatPoints(user.pointsBalance || 0)} 點</p>
              </div>
              <button class="btn secondary slim" id="logoutBtn">登出</button>
            ` : `
              <button class="btn slim" id="openAuth">登入</button>
            `}
          </div>
        </header>
        <main class="main">
          <section class="hero-strip">
            <div>
              <span class="tag">公開瀏覽</span>
              <h2>查看場地日曆，不需登入。</h2>
              <p>${user ? `目前剩餘 ${formatPoints(user.pointsBalance || 0)} 點。` : "登入後才可排課、取消租用或進入管理功能；新帳號需管理者審核通過。"}</p>
              ${user ? renderRentalAvailability() : ""}
            </div>
            <img src="assets/court-schedule-illustration.png" alt="籃球場排課插畫">
          </section>
          <div class="layout">
            ${renderSidebar(user)}
            <section>
              ${renderCalendar(location, user)}
              ${user ? renderScheduleStatusPanel(user) : ""}
              ${user?.role === "admin" ? renderAdminPanel() : user ? renderMyBookings(user) : ""}
            </section>
          </div>
        </main>
      </div>
      ${modalSlot ? renderBookingModal(user) : ""}
      ${detailLocationId ? renderLocationDetailModal() : ""}
      ${editLocationId ? renderLocationEditModal() : ""}
      ${authOpen ? renderAuth() : ""}
    `;
    bindAppEvents(user);
  }

  function renderSidebar(user) {
    const showRules = user?.role === "coach";
    return `
      <aside class="sidebar">
        <section class="panel">
          <h2>排課地點</h2>
          <div class="location-list">
            ${state.locations.map((location) => `
              <div class="location-item ${user?.role === "admin" ? "with-actions" : ""}">
                <button class="location-btn ${location.id === selectedLocationId ? "active" : ""}" data-location-id="${location.id}">
                  ${escapeHtml(location.name)}
                </button>
                ${user?.role === "admin" ? `
                  <button class="icon-btn" data-edit-location="${location.id}" title="編輯場地資訊" aria-label="編輯 ${escapeHtml(location.name)}">編</button>
                  <button class="icon-btn danger" data-delete-location="${location.id}" title="刪除場地" aria-label="刪除 ${escapeHtml(location.name)}">×</button>
                ` : ""}
              </div>
            `).join("") || `<div class="empty">尚無地點</div>`}
          </div>
          ${user?.role === "admin" ? `
            <form id="locationForm" class="location-form" style="margin-top: 14px;">
              <label class="hidden" for="locationName">新增地點</label>
              <input id="locationName" name="name" required placeholder="新增地點名稱">
              <input name="address" placeholder="場地地址（可不填）">
              <input name="contactName" placeholder="聯絡人姓名（可不填）">
              <input name="contactPhone" type="tel" placeholder="聯絡人電話（可不填）">
              <label class="file-field">場地相片（可不傳）
                <input name="photo" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
              </label>
              <button class="btn slim" type="submit">新增</button>
            </form>
          ` : ""}
        </section>
        ${showRules ? `
        <section class="panel">
          <h3>排課規則</h3>
          <p class="small">目前剩餘 <strong>${formatPoints(user.pointsBalance || 0)} 點</strong>。</p>
          <ul class="rule-list" aria-label="排課規則清單">
            <li>
              <strong>排課範圍</strong>
              <span>一般教練不能排過去的時段；教練只能排本週，或下週一到週日。</span>
            </li>
            <li>
              <strong>下週開放時間</strong>
              <span>下週時段要等到該週前一個週五 12:00 才開放。</span>
            </li>
            <li>
              <strong>教練優先序</strong>
              <span>下週排課會依管理者設定的教練優先序；前面優先序的教練未標記完成時，後面的教練不能排。</span>
            </li>
            <li>
              <strong>週日解除優先序</strong>
              <span>一旦到了週日 12:00，教練們就無優先順序，所有教練都可以排下週時段。</span>
            </li>
            <li>
              <strong>管理者權限</strong>
              <span>管理者不受一般教練排課限制。</span>
            </li>
            <li>
              <strong>租用時間</strong>
              <span>租用時間限 07:00 到 22:30。</span>
            </li>
            <li>
              <strong>時間單位</strong>
              <span>開始時間必須是整點或半點；租用長度必須是 0.5 小時的倍數。</span>
            </li>
            <li>
              <strong>點數扣除</strong>
              <span>點數在時段結束後才自動扣除，每 1 小時扣 1 點。</span>
            </li>
            <li>
              <strong>共用時段</strong>
              <span>已有租用的時段仍可共用，會跳確認視窗。</span>
            </li>
            <li>
              <strong>取消租用</strong>
              <span>一般使用者只能取消自己的租用；開始前 1 小時內需由管理者取消。</span>
            </li>
            <li>
              <strong>場租開放</strong>
              <span>本輪所有已通過審核的教練標記完成後會開放；若到了該週週一 08:00，系統會自動視為全部教練已排課並開放外租。</span>
            </li>
          </ul>
        </section>
        ` : ""}
      </aside>
    `;
  }

  function renderRentalAvailability() {
    const availability = state.rentalAvailability || {};
    const statusClass = availability.isOpen ? "open" : "closed";
    const progress = `${Number(availability.completedCount || 0)}/${Number(availability.totalCount || 0)} 位教練已完成`;
    return `
      <div class="rental-status ${statusClass}" aria-label="${escapeHtml(rentalAvailabilityLabel())}">
        <span class="status-light" aria-hidden="true"></span>
        <div>
          <strong>${escapeHtml(rentalAvailabilityLabel())}</strong>
          <span>${escapeHtml(progress)}</span>
        </div>
      </div>
    `;
  }

  function renderScheduleStatusPanel(user) {
    const coaches = state.scheduling?.coaches || [];
    return `
      <section class="panel schedule-status-panel">
        <div class="schedule-status-head">
          <div>
            <h2>本輪排課狀態</h2>
            <p class="hint">排課週期：${escapeHtml(state.scheduling?.cycleStart || "未開放")} 起的下週時段</p>
          </div>
          ${user.role !== "admin" ? `<button class="btn slim" id="markScheduleComplete" ${user.scheduleCompleted ? "disabled" : ""}>${user.scheduleCompleted ? "已標記完成" : "下週已排課"}</button>` : ""}
        </div>
        <div class="schedule-list">
          ${coaches.map((coach) => `
            <div class="schedule-status-row">
              <span class="schedule-priority">${Number(coach.schedulePriority || 0)}</span>
              <strong>${escapeHtml(coach.name)}</strong>
              <span class="badge ${scheduleStatusClass(coach)}">${scheduleStatusLabel(coach)}</span>
            </div>
          `).join("") || `<div class="empty">尚無教練帳號</div>`}
        </div>
      </section>
    `;
  }

  function renderCalendar(location, user) {
    const days = Array.from({ length: 7 }, (_, index) => addDays(selectedWeekDate, index));
    const weekEnd = addDays(selectedWeekDate, 6);
    return `
      <section class="panel calendar-panel">
        <div class="calendar-head">
          <div>
            <h2>${location ? escapeHtml(location.name) : "尚無地點"}</h2>
            ${location ? `<button class="link-btn" type="button" data-location-detail="${location.id}">場地詳細資訊</button>` : ""}
            <p class="hint">${dateKey(selectedWeekDate)} 到 ${dateKey(weekEnd)}</p>
          </div>
          <div class="week-tools">
            <button class="btn secondary slim" id="prevWeek">上一週</button>
            <button class="btn secondary slim" id="todayWeek">本週</button>
            <button class="btn secondary slim" id="nextWeek">下一週</button>
            <label class="hidden" for="jumpDate">選擇日期</label>
            <input id="jumpDate" type="date" value="${dateKey(selectedWeekDate)}">
          </div>
        </div>
        <div class="calendar-scroll">
          <div class="calendar">
            <div class="time-head">時間</div>
            ${days.map((day, index) => `<div class="day-head">週${WEEKDAYS[index]}<span>${dateLabel(day)}</span></div>`).join("")}
            ${HOURS.map((hour) => `
              <div class="time-cell">${pad(hour)}:00</div>
              ${days.map((day) => renderSlot(location?.id, day, hour, user)).join("")}
            `).join("")}
          </div>
        </div>
      </section>
    `;
  }

  function renderSlot(locationId, day, hour, user) {
    if (!locationId) return `<div class="slot disabled">尚無地點</div>`;
    const halfStarts = [0, 30].map((minute) => {
      const slotStart = new Date(day);
      slotStart.setHours(hour, minute, 0, 0);
      return slotStart;
    });
    const segments = visibleSegmentsForSlot(locationId, day, hour).map(({ booking, segment, laneIndex, laneCount }) => {
      const width = 100 / laneCount;
      const left = laneIndex * width;
      const title = user ? "此時段已有租用，可點擊空白處共用" : "此時段已被租用";
      return `
        <div class="booking-block ${booking.userId === user?.id ? "mine" : ""}" title="${escapeHtml(title)}" style="top: ${segment.top}%; height: ${segment.height}%; left: calc(${left}% + 6px); width: calc(${width}% - 12px);">
          ${segment.isFirst ? `
            <span class="slot-title">${escapeHtml(displayBookingOwner(booking, user))}</span>
            ${user ? `<span class="slot-meta">${formatTimeRange(booking.start, booking.end)} ${formatPoints(bookingHours(booking))}點</span>` : ""}
          ` : `<span class="slot-meta">${user ? "續用中" : "已佔用"}</span>`}
        </div>
      `;
    }).join("");

    return `
      <div class="slot">
        ${halfStarts.map((slotStart, index) => {
          const slotEnd = addMinutes(slotStart, 30);
          const permission = canUserBook(user, slotStart);
          const shared = Boolean(findOverlap(locationId, slotStart, slotEnd));
          const blocked = !permission.ok || !isWithinRentalHours(slotStart, slotEnd);
          const label = `${formatClock(slotStart)}-${formatClock(slotEnd)}`;
          return `
            <button class="half-slot ${index === 0 ? "top-half" : "bottom-half"} ${shared ? "shared" : ""}" data-slot="${slotStart.toISOString()}" ${blocked ? "disabled" : ""} title="${blocked ? escapeHtml(permission.message || "不可租用") : shared ? `此時段已有租用，點擊可共用 ${label}` : `新增租用 ${label}`}">
              <span>${blocked ? "" : shared ? "可共用" : "可租用"}</span>
            </button>
          `;
        }).join("")}
        ${segments}
      </div>
    `;
  }

  function renderBookingModal(user) {
    const start = new Date(modalSlot.start);
    return `
      <div class="modal-backdrop">
        <form class="modal" id="bookingForm">
          <h2>新增租用時段</h2>
          <div class="form-grid">
            <label>開始時間
              <input name="start" type="datetime-local" value="${datetimeLocalValue(start)}" min="${dateKey(start)}T${pad(OPEN_HOUR)}:00" max="${dateKey(start)}T${pad(CLOSE_HOUR)}:00" step="1800" required>
            </label>
              <label>租用長度
                <select name="duration">
                  ${durationOptions(start).map((duration) => `<option value="${duration}">${duration} 小時 / ${formatPoints(duration)} 點</option>`).join("")}
                </select>
              </label>
              <p class="small">此點數會在租用結束後由系統自動扣除，不會在建立時段時立即扣點。</p>
            ${user.role === "admin" ? `
              <label>租用人
                <select name="userId">
                  ${state.users.filter((item) => item.approvalStatus === "approved").map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("")}
                </select>
              </label>
            ` : ""}
            <label>備註
              <input name="note" placeholder="可留空">
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn secondary" type="button" id="closeModal">取消</button>
            <button class="btn" type="submit">確認租用</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderLocationDetailModal() {
    const location = state.locations.find((item) => item.id === detailLocationId);
    if (!location) {
      detailLocationId = "";
      return "";
    }
    const address = String(location.address || "").trim();
    const contactName = String(location.contactName || "").trim();
    const contactPhone = String(location.contactPhone || "").trim();
    const photoUrl = String(location.photoUrl || "").trim();
    const hasDetails = address || contactName || contactPhone || photoUrl;
    return `
      <div class="modal-backdrop location-detail-backdrop">
        <section class="modal location-detail-modal" role="dialog" aria-modal="true" aria-labelledby="locationDetailTitle">
          <h2 id="locationDetailTitle">${escapeHtml(location.name)}</h2>
          ${photoUrl ? `<img class="location-photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(location.name)} 場地相片">` : ""}
          <dl class="detail-list">
            <div>
              <dt>地址</dt>
              <dd>${address ? escapeHtml(address) : "未提供"}</dd>
            </div>
            <div>
              <dt>聯絡人</dt>
              <dd>${contactName ? escapeHtml(contactName) : "未提供"}</dd>
            </div>
            <div>
              <dt>聯絡電話</dt>
              <dd>${contactPhone ? escapeHtml(contactPhone) : "未提供"}</dd>
            </div>
            ${photoUrl ? `
              <div>
                <dt>場地相片</dt>
                <dd><a href="${escapeHtml(photoUrl)}" target="_blank" rel="noreferrer">開啟原圖</a></dd>
              </div>
            ` : ""}
          </dl>
          ${hasDetails ? "" : `<p class="empty">尚未提供此場地的詳細資訊。</p>`}
          <div class="modal-actions">
            <button class="btn secondary" type="button" id="closeLocationDetail">關閉</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderLocationEditModal() {
    const location = state.locations.find((item) => item.id === editLocationId);
    if (!location) {
      editLocationId = "";
      return "";
    }
    return `
      <div class="modal-backdrop location-edit-backdrop">
        <form class="modal" id="locationEditForm">
          <h2>編輯場地資訊</h2>
          <div class="form-grid">
            <label>場地名稱
              <input name="name" required value="${escapeHtml(location.name)}">
            </label>
            <label>場地地址
              <input name="address" value="${escapeHtml(location.address || "")}" placeholder="可不填">
            </label>
            <label>聯絡人姓名
              <input name="contactName" value="${escapeHtml(location.contactName || "")}" placeholder="可不填">
            </label>
            <label>聯絡人電話
              <input name="contactPhone" type="tel" value="${escapeHtml(location.contactPhone || "")}" placeholder="可不填">
            </label>
            <label class="file-field">場地相片
              <input name="photo" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
            </label>
            ${location.photoUrl ? `
              <div class="current-photo">
                <img src="${escapeHtml(location.photoUrl)}" alt="${escapeHtml(location.name)} 目前場地相片">
                <label class="switch-line">
                  <span>移除目前相片</span>
                  <input name="removePhoto" type="checkbox">
                </label>
              </div>
            ` : `<p class="small">尚未上傳場地相片。</p>`}
          </div>
          <div class="modal-actions">
            <button class="btn secondary" type="button" id="closeLocationEdit">取消</button>
            <button class="btn" type="submit">儲存</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderMyBookings(user) {
    const myBookings = state.bookings
      .filter((booking) => booking.userId === user.id)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    return `
      <section class="panel" style="margin-top: 20px;">
        <h2>我的租用</h2>
        <div class="booking-list">
          ${myBookings.map((booking) => renderBookingRow(booking, user)).join("") || `<div class="empty">尚未租用任何時段</div>`}
        </div>
      </section>
      ${renderPointHistory(user)}
    `;
  }

  function renderPointHistory(user) {
    const transactions = state.pointTransactions
      .filter((transaction) => transaction.userId === user.id)
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `
      <section class="panel" style="margin-top: 20px;">
        <h2>點數紀錄</h2>
        <div class="stats-list">
          ${transactions.map(renderTransactionRow).join("") || `<div class="empty">尚無儲值或消耗紀錄</div>`}
        </div>
      </section>
    `;
  }

  function renderAdminPanel() {
    const pendingCount = state.users.filter((user) => user.approvalStatus === "pending").length;
    return `
      <section class="panel admin-tabs-panel">
        <div class="tabs admin-tabs" role="tablist">
          <button class="tab-btn ${activeAdminTab === "overview" ? "active" : ""}" data-admin-tab="overview">管理總覽</button>
          <button class="tab-btn ${activeAdminTab === "users" ? "active" : ""}" data-admin-tab="users">使用者批核${pendingCount ? ` (${pendingCount})` : ""}</button>
        </div>
      </section>
      ${activeAdminTab === "users" ? renderUserApprovalPanel() : `
      <section class="admin-grid">
        <div class="panel">
          <h2>教練排課狀態</h2>
          <div class="user-list" style="margin-top: 12px;">
            ${(state.scheduling?.coaches || []).map((user) => `
              <div class="user-row">
                <div>
                  <strong>${escapeHtml(user.name)}</strong>
                  <span class="small">${escapeHtml(user.username)} · 優先序 ${Number(user.schedulePriority || 0)}</span>
                </div>
                <span class="badge ${scheduleStatusClass(user)}">${scheduleStatusLabel(user)}</span>
              </div>
            `).join("") || `<div class="empty">尚無教練帳號</div>`}
          </div>
        </div>
        <div class="panel">
          <h2>點數統計</h2>
          <p class="small">依期間內已實際扣除的租用點數統計，會扣除同期間取消退點，不含管理者手動扣點；收益依目前設定的每點金額換算。</p>
          <form id="pointValueForm" class="rate-form">
            <label>1 點等於多少錢
              <input name="pointValueMoney" type="number" min="0" step="0.01" value="${Number(state.settings?.pointValueMoney || 0)}" required>
            </label>
            <button class="btn slim" type="submit">儲存</button>
          </form>
          <form id="statsForm" class="range-row">
            <label>開始
              <input name="start" type="date" value="${statsRange.start}" required>
            </label>
            <label>結束
              <input name="end" type="date" value="${statsRange.end}" required>
            </label>
            <button class="btn slim" type="submit">統計</button>
          </form>
          <div class="stats-summary" aria-label="期間統計總計">
            <div>
              <span>期間點數總計</span>
              <strong>${formatPoints(statsSummary.totalPoints || 0)} 點</strong>
            </div>
            <div>
              <span>換算金額總和</span>
              <strong>${formatMoney(statsSummary.totalRevenue || 0)} 元</strong>
            </div>
          </div>
          <div class="stats-list" style="margin-top: 12px;">
            ${statsRows.map((row) => `
              <div class="stat-row">
                <div>
                  <strong>${escapeHtml(row.name)}</strong>
                  <span class="stat-label">${escapeHtml(row.username)} · ${formatPoints(row.points)} 點</span>
                </div>
                <div class="stat-points">${formatMoney(row.revenue)} 元</div>
              </div>
            `).join("") || `<div class="empty">尚無使用者</div>`}
          </div>
        </div>
        <div class="panel" style="grid-column: 1 / -1;">
          <h2>所有租用紀錄</h2>
          <div class="booking-list">
            ${state.bookings.slice().sort((a, b) => new Date(a.start) - new Date(b.start)).map((booking) => renderBookingRow(booking, state.currentUser)).join("") || `<div class="empty">尚無租用紀錄</div>`}
          </div>
        </div>
      </section>
      `}
    `;
  }

  function renderUserApprovalPanel() {
    const pendingUsers = state.users.filter((user) => user.approvalStatus === "pending");
    const decidedUsers = state.users.filter((user) => user.role !== "admin" && user.approvalStatus !== "pending");
    const approvedUsers = state.users.filter((user) => user.approvalStatus === "approved");
    const approvedCoaches = approvedUsers.filter((user) => user.role !== "admin").sort((a, b) => Number(a.schedulePriority || 9999) - Number(b.schedulePriority || 9999));
    return `
      <section class="admin-grid">
        <div class="panel">
          <h2>待審核使用者</h2>
          <div class="user-list">
            ${pendingUsers.map((user) => renderApprovalRow(user, true)).join("") || `<div class="empty">目前沒有待審核帳號</div>`}
          </div>
        </div>
        <div class="panel">
          <h2>已處理名單</h2>
          <div class="user-list">
            ${decidedUsers.map((user) => renderApprovalRow(user, false)).join("") || `<div class="empty">尚無已處理帳號</div>`}
          </div>
        </div>
        <div class="panel" style="grid-column: 1 / -1;">
          <h2>排課優先序</h2>
          <div class="user-list">
            ${approvedCoaches.map(renderSchedulePriorityRow).join("") || `<div class="empty">尚無已通過教練</div>`}
          </div>
        </div>
        <div class="panel" style="grid-column: 1 / -1;">
          <h2>點數調整</h2>
          <div class="user-list">
            ${approvedUsers.map(renderPointAdjustmentRow).join("") || `<div class="empty">尚無可調整點數的使用者</div>`}
          </div>
        </div>
        <div class="panel" style="grid-column: 1 / -1;">
          <h2>點數流水</h2>
          <div class="stats-list">
            ${state.pointTransactions.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(renderTransactionRow).join("") || `<div class="empty">尚無儲值或消耗紀錄</div>`}
          </div>
        </div>
      </section>
    `;
  }

  function renderSchedulePriorityRow(user) {
    return `
      <form class="user-row priority-row" data-priority-user="${user.id}">
        <div>
          <strong>${escapeHtml(user.name)}</strong>
          <span class="small">${escapeHtml(user.username)} · ${scheduleStatusLabel(user)}</span>
        </div>
        <div class="priority-actions">
          <label class="hidden" for="priority-${user.id}">排課優先序</label>
          <input id="priority-${user.id}" name="schedulePriority" type="number" min="1" step="1" value="${Number(user.schedulePriority || 1)}" required>
          <button class="btn slim" type="submit">更新</button>
        </div>
      </form>
    `;
  }

  function renderPointAdjustmentRow(user) {
    return `
      <form class="user-row recharge-row" data-recharge-user="${user.id}">
        <div>
          <strong>${escapeHtml(user.name)}</strong>
          <span class="small">${escapeHtml(user.username)} · 目前 ${formatPoints(user.pointsBalance || 0)} 點</span>
        </div>
        <div class="recharge-actions">
          <label class="hidden" for="points-${user.id}">調整點數</label>
          <input id="points-${user.id}" name="amount" type="number" step="0.5" placeholder="+儲值 / -扣點" required>
          <input name="note" placeholder="備註">
          <button class="btn slim" type="submit">調整</button>
        </div>
      </form>
    `;
  }

  function renderApprovalRow(user, pending) {
    const badgeClass = user.approvalStatus === "approved" ? "ok" : user.approvalStatus === "pending" ? "pending" : "warn";
    return `
      <div class="user-row approval-row">
        <div>
          <strong>${escapeHtml(user.name)}</strong>
          <span class="small">${escapeHtml(user.username)} · ${escapeHtml(user.phone || "未留電話")}</span>
          <span class="badge ${badgeClass}">${approvalLabel(user.approvalStatus)}</span>
        </div>
        <div class="approval-actions">
          ${pending ? `
            <button class="btn slim" data-approve-user="${user.id}">通過</button>
            <button class="btn danger slim" data-reject-user="${user.id}">退回</button>
          ` : user.approvalStatus === "rejected" ? `
            <button class="btn slim" data-approve-user="${user.id}">改為通過</button>
          ` : `
            <button class="btn secondary slim" data-pending-user="${user.id}">改回待審</button>
          `}
        </div>
      </div>
    `;
  }

  function renderBookingRow(booking, user) {
    const location = state.locations.find((item) => item.id === booking.locationId)?.name || "未知地點";
    const permission = cancelPermission(user, booking);
    const canSeeCancel = user?.role === "admin" || booking.userId === user?.id;
    return `
      <div class="booking-row">
        <div>
          <strong>${escapeHtml(getUserName(booking.userId))} · ${escapeHtml(location)}</strong>
          <span class="small">${dateKey(new Date(booking.start))} ${formatTimeRange(booking.start, booking.end)} · ${formatPoints(bookingHours(booking))} 點</span>
          ${booking.note ? `<span class="small">${escapeHtml(booking.note)}</span>` : ""}
          ${canSeeCancel && !permission.ok ? `<span class="small badge warn">${escapeHtml(permission.message)}</span>` : ""}
        </div>
        ${canSeeCancel ? `<button class="btn danger slim" data-delete-booking="${booking.id}" ${permission.ok ? "" : "disabled"} title="${escapeHtml(permission.message)}">取消租用</button>` : ""}
      </div>
    `;
  }

  function renderTransactionRow(transaction) {
    const owner = getUserName(transaction.userId);
    const amountClass = Number(transaction.amount) >= 0 ? "credit" : "debit";
    return `
      <div class="stat-row transaction-row">
        <div>
          <strong>${escapeHtml(owner)} · ${transactionLabel(transaction)}</strong>
          <span class="stat-label">${new Date(transaction.createdAt).toLocaleString("zh-TW")} · ${escapeHtml(transaction.note || "無備註")}</span>
          <span class="stat-label">結餘 ${formatPoints(transaction.balanceAfter || 0)} 點</span>
        </div>
        <div class="stat-points ${amountClass}">${formatTransactionAmount(transaction.amount)}</div>
      </div>
    `;
  }

  function bindAppEvents(user) {
    document.getElementById("logoutBtn")?.addEventListener("click", () => {
      localStorage.removeItem(TOKEN_KEY);
      token = "";
      state.currentUser = null;
      render();
    });
    document.getElementById("openAuth")?.addEventListener("click", () => {
      authOpen = true;
      authMode = "login";
      render();
    });
    document.querySelectorAll("[data-location-id]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedLocationId = button.dataset.locationId;
        render();
      });
    });
    document.querySelectorAll("[data-location-detail]").forEach((button) => {
      button.addEventListener("click", () => {
        detailLocationId = button.dataset.locationDetail;
        render();
      });
    });
    document.getElementById("prevWeek").addEventListener("click", () => {
      selectedWeekDate = addDays(selectedWeekDate, -7);
      render();
    });
    document.getElementById("todayWeek").addEventListener("click", () => {
      selectedWeekDate = startOfWeek(new Date());
      render();
    });
    document.getElementById("nextWeek").addEventListener("click", () => {
      selectedWeekDate = addDays(selectedWeekDate, 7);
      render();
    });
    document.getElementById("jumpDate").addEventListener("change", (event) => {
      selectedWeekDate = startOfWeek(new Date(`${event.target.value}T00:00:00`));
      render();
    });
    document.querySelectorAll("[data-slot]").forEach((button) => {
      button.addEventListener("click", () => {
        modalSlot = { start: button.dataset.slot };
        render();
      });
    });
    document.getElementById("markScheduleComplete")?.addEventListener("click", markScheduleComplete);
    bindBookingCancelEvents(user);
    if (user?.role === "admin") bindAdminEvents();
    if (modalSlot) bindBookingModal(user);
    if (detailLocationId) bindLocationDetailModal();
    if (editLocationId) bindLocationEditModal();
    if (authOpen) bindAuthEvents();
  }

  function bindAdminEvents() {
    document.querySelectorAll("[data-admin-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        activeAdminTab = button.dataset.adminTab;
        render();
      });
    });
    document.getElementById("locationForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("name")).trim();
      if (!name) return;
      try {
        const photoData = await photoFileData(form);
        await request("/locations", {
          method: "POST",
          body: JSON.stringify({
            name,
            address: String(form.get("address")).trim(),
            contactName: String(form.get("contactName")).trim(),
            contactPhone: String(form.get("contactPhone")).trim(),
            photoData
          })
        });
        showToast("已新增地點。");
        await refresh();
      } catch (error) {
        showToast(error.message);
      }
    });
    document.querySelectorAll("[data-edit-location]").forEach((button) => {
      button.addEventListener("click", () => {
        editLocationId = button.dataset.editLocation;
        render();
      });
    });
    document.querySelectorAll("[data-delete-location]").forEach((button) => {
      button.addEventListener("click", async () => {
        const location = state.locations.find((item) => item.id === button.dataset.deleteLocation);
        if (!location) return;
        if (!window.confirm(`確定刪除「${location.name}」嗎？此場地的租用紀錄也會一併刪除。`)) return;
        try {
          await request(`/locations/${location.id}`, { method: "DELETE" });
          showToast("場地已刪除。");
          await refresh();
        } catch (error) {
          showToast(error.message);
        }
      });
    });
    document.querySelectorAll("[data-priority-user]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = new FormData(event.currentTarget);
        try {
          await request(`/users/${form.dataset.priorityUser}/scheduling`, {
            method: "PUT",
            body: JSON.stringify({ schedulePriority: Number(body.get("schedulePriority")) })
          });
          showToast("排課優先序已更新。");
          await refresh();
        } catch (error) {
          showToast(error.message);
        }
      });
    });
    document.querySelectorAll("[data-approve-user], [data-reject-user], [data-pending-user]").forEach((button) => {
      button.addEventListener("click", async () => {
        const userId = button.dataset.approveUser || button.dataset.rejectUser || button.dataset.pendingUser;
        const approvalStatus = button.dataset.approveUser ? "approved" : button.dataset.rejectUser ? "rejected" : "pending";
        try {
          await request(`/users/${userId}/approval`, {
            method: "PUT",
            body: JSON.stringify({ approvalStatus })
          });
          showToast(approvalStatus === "approved" ? "已通過使用者。" : approvalStatus === "rejected" ? "已退回申請。" : "已改回待審。");
          await refresh();
        } catch (error) {
          showToast(error.message);
        }
      });
    });
    document.querySelectorAll("[data-recharge-user]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = new FormData(event.currentTarget);
        const amount = Number(body.get("amount"));
        const note = String(body.get("note") || "").trim();
        try {
          await request(`/users/${form.dataset.rechargeUser}/points`, {
            method: "POST",
            body: JSON.stringify({ amount, note })
          });
          showToast(amount > 0 ? "點數已儲值。" : "點數已扣除。");
          await refresh();
        } catch (error) {
          showToast(error.message);
        }
      });
    });
    document.getElementById("pointValueForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await request("/settings", {
          method: "PUT",
          body: JSON.stringify({ pointValueMoney: Number(form.get("pointValueMoney")) })
        });
        state.settings = result.settings || state.settings;
        showToast("點數收益換算已更新。");
        await loadStats();
      } catch (error) {
        showToast(error.message);
      }
    });
    document.getElementById("statsForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      statsRange = { start: String(form.get("start")), end: String(form.get("end")) };
      await loadStats();
    });
  }

  async function markScheduleComplete() {
    try {
      await request("/schedule-complete", { method: "POST" });
      showToast("已標記本輪排課完成。");
      await refresh();
    } catch (error) {
      showToast(error.message);
    }
  }

  function bindBookingCancelEvents(user) {
    document.querySelectorAll("[data-delete-booking]").forEach((button) => {
      button.addEventListener("click", async () => {
        const booking = state.bookings.find((item) => item.id === button.dataset.deleteBooking);
        if (!booking) return;
        await cancelBooking(user, booking);
      });
    });
  }

  async function cancelBooking(user, booking) {
    const permission = cancelPermission(user, booking);
    if (!permission.ok) {
      showToast(permission.message);
      return;
    }
    const location = state.locations.find((item) => item.id === booking.locationId)?.name || "未知地點";
    if (!window.confirm(`確定取消「${location}」${dateKey(new Date(booking.start))} ${formatTimeRange(booking.start, booking.end)} 的租用嗎？`)) return;
    try {
      await request(`/bookings/${booking.id}`, { method: "DELETE" });
      showToast("租用時段已取消。");
      await refresh();
    } catch (error) {
      showToast(error.message);
    }
  }

  function bindBookingModal(user) {
    document.getElementById("closeModal").addEventListener("click", () => {
      modalSlot = null;
      render();
    });
    document.querySelector(".modal-backdrop").addEventListener("click", (event) => {
      if (event.target.classList.contains("modal-backdrop")) {
        modalSlot = null;
        render();
      }
    });
    document.getElementById("bookingForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const start = new Date(String(form.get("start")));
      const duration = Number(form.get("duration"));
      const overlaps = findOverlaps(selectedLocationId, start, addHours(start, duration));
      if (overlaps.length) {
        const sharedWith = overlaps
          .map((booking) => `${getUserName(booking.userId)} ${formatTimeRange(booking.start, booking.end)}`)
          .join("、");
        if (!window.confirm(`此時段已有其他租用紀錄：${sharedWith}。仍要共用這個時段嗎？`)) return;
      }
      try {
        await request("/bookings", {
          method: "POST",
          body: JSON.stringify({
            locationId: selectedLocationId,
            userId: user.role === "admin" ? String(form.get("userId")) : user.id,
            start: start.toISOString(),
            duration,
            note: String(form.get("note")).trim()
          })
        });
        modalSlot = null;
        showToast("租用時段已建立。");
        await refresh();
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  function bindLocationDetailModal() {
    document.getElementById("closeLocationDetail")?.addEventListener("click", () => {
      detailLocationId = "";
      render();
    });
    document.querySelector(".location-detail-backdrop")?.addEventListener("click", (event) => {
      if (event.target.classList.contains("location-detail-backdrop")) {
        detailLocationId = "";
        render();
      }
    });
  }

  function bindLocationEditModal() {
    document.getElementById("closeLocationEdit")?.addEventListener("click", () => {
      editLocationId = "";
      render();
    });
    document.querySelector(".location-edit-backdrop")?.addEventListener("click", (event) => {
      if (event.target.classList.contains("location-edit-backdrop")) {
        editLocationId = "";
        render();
      }
    });
    document.getElementById("locationEditForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("name")).trim();
      if (!name) return;
      try {
        const photoData = await photoFileData(form);
        await request(`/locations/${editLocationId}`, {
          method: "PUT",
          body: JSON.stringify({
            name,
            address: String(form.get("address")).trim(),
            contactName: String(form.get("contactName")).trim(),
            contactPhone: String(form.get("contactPhone")).trim(),
            photoData,
            removePhoto: form.get("removePhoto") === "on"
          })
        });
        editLocationId = "";
        showToast("場地資訊已更新。");
        await refresh();
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  async function loadStats() {
    try {
      const query = new URLSearchParams(statsRange).toString();
      const result = await request(`/stats?${query}`);
      statsRows = result.rows;
      statsSummary = {
        totalPoints: Number(result.totalPoints || 0),
        totalRevenue: Number(result.totalRevenue || 0)
      };
      state.settings = { ...state.settings, pointValueMoney: result.pointValueMoney };
      render();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function boot() {
    await refresh();
    if (state.currentUser?.role === "admin") await loadStats();
  }

  boot();
})();
