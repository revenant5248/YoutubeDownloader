process.env.TZ = process.env.TZ || "Asia/Taipei";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");
const PUBLIC_DIR = __dirname;
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, "config.json");
const LOCATION_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "locations");
const MAX_LOCATION_PHOTO_BYTES = 5 * 1024 * 1024;
// Initial admin credentials come from environment variables so new deployments do not bake secrets into source code.
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "admin").trim();
const ADMIN_NAME = String(process.env.ADMIN_NAME || "帝汶").trim();
let generatedAdminPassword = "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

function loadConfig() {
  const defaults = { cancelCutoffHours: 1, openHour: 7, closeHour: 22, closeMinute: 30 };
  if (!fs.existsSync(CONFIG_FILE)) return defaults;
  const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  return {
    ...defaults,
    ...parsed,
    cancelCutoffHours: Number(parsed.cancelCutoffHours ?? defaults.cancelCutoffHours),
    openHour: Number(parsed.openHour ?? defaults.openHour),
    closeHour: Number(parsed.closeHour ?? defaults.closeHour),
    closeMinute: Number(parsed.closeMinute ?? defaults.closeMinute)
  };
}

const APP_CONFIG = loadConfig();

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

function endOfRentalDay(date) {
  const close = new Date(date);
  close.setHours(APP_CONFIG.closeHour, APP_CONFIG.closeMinute, 0, 0);
  return close;
}

function isHalfHourTime(date) {
  return date.getMinutes() === 0 || date.getMinutes() === 30;
}

function isWithinRentalHours(start, end) {
  const open = new Date(start);
  open.setHours(APP_CONFIG.openHour, 0, 0, 0);
  return start >= open && end <= endOfRentalDay(start) && dateKey(start) === dateKey(end);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function initialAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return String(process.env.ADMIN_PASSWORD);
  // A generated password is printed only on first database creation when ADMIN_PASSWORD was not provided.
  generatedAdminPassword = generatedAdminPassword || crypto.randomBytes(18).toString("base64url");
  return generatedAdminPassword;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(":");
  if (!salt || !expected) return false;
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function nextSchedulePriority(users) {
  const priorities = users
    .filter((user) => user.role !== "admin")
    .map((user) => Number(user.schedulePriority || 0))
    .filter((value) => Number.isFinite(value));
  return Math.max(0, ...priorities) + 1;
}

function defaultDb() {
  return {
    users: [
      {
        id: "admin",
        username: ADMIN_USERNAME,
        passwordHash: hashPassword(initialAdminPassword()),
        name: ADMIN_NAME,
        phone: "",
        role: "admin",
        approvalStatus: "approved",
        pointsBalance: 0,
        schedulePriority: 0,
        scheduleCompleteCycleStart: "",
        createdAt: new Date().toISOString()
      }
    ],
    locations: [
      { id: "court-a", name: "主場地 A", address: "", contactName: "", contactPhone: "", photoUrl: "" },
      { id: "court-b", name: "訓練場 B", address: "", contactName: "", contactPhone: "", photoUrl: "" }
    ],
    bookings: [],
    pointTransactions: [],
    settings: {
      pointValueMoney: 0
    },
    sessions: {}
  };
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    saveDb(db);
    return db;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  let changed = false;
  if (!db.sessions) db.sessions = {};
  if (!db.settings) db.settings = {};
  if (!Object.hasOwn(db.settings, "pointValueMoney")) {
    db.settings.pointValueMoney = 0;
    changed = true;
  }
  if (Object.hasOwn(db.settings, "studentsCanBook")) {
    delete db.settings.studentsCanBook;
    changed = true;
  }
  if (!db.pointTransactions) {
    db.pointTransactions = [];
    changed = true;
  }
  if (!db.users.some((user) => user.role === "admin")) {
    db.users.unshift(defaultDb().users[0]);
    changed = true;
  }
  db.users.forEach((user) => {
    if (!Object.hasOwn(user, "phone")) {
      user.phone = "";
      changed = true;
    }
    if (!user.approvalStatus) {
      user.approvalStatus = user.role === "admin" ? "approved" : "approved";
      changed = true;
    }
    if (user.role === "student") {
      user.role = "coach";
      changed = true;
    }
    if (!Object.hasOwn(user, "pointsBalance")) {
      user.pointsBalance = 0;
      changed = true;
    }
    if (!Object.hasOwn(user, "schedulePriority")) {
      user.schedulePriority = user.role === "admin" ? 0 : nextSchedulePriority(db.users);
      changed = true;
    }
    if (!Object.hasOwn(user, "scheduleCompleteCycleStart")) {
      user.scheduleCompleteCycleStart = "";
      changed = true;
    }
    if (user.id === "admin" && user.name === "管理者") {
      user.name = "帝汶";
      changed = true;
    }
  });
  if (!Array.isArray(db.locations)) {
    db.locations = [];
    changed = true;
  }
  db.locations.forEach((location) => {
    ["address", "contactName", "contactPhone", "photoUrl"].forEach((field) => {
      if (!Object.hasOwn(location, field)) {
        location[field] = "";
        changed = true;
      }
    });
  });
  db.bookings.forEach((booking) => {
    if (!Object.hasOwn(booking, "pointsChargedAt") && new Date(booking.end) <= new Date()) {
      booking.pointsChargeSkipped = true;
      changed = true;
    }
  });
  if (changed) saveDb(db);
  return db;
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function deleteLocalLocationPhoto(photoUrl) {
  if (!photoUrl || !photoUrl.startsWith("/uploads/locations/")) return;
  const filePath = path.normalize(path.join(PUBLIC_DIR, photoUrl));
  if (!filePath.startsWith(LOCATION_UPLOAD_DIR)) return;
  fs.rm(filePath, { force: true }, () => {});
}

function saveLocationPhotoUpload(locationId, photoData, previousPhotoUrl = "") {
  if (!photoData) return { ok: true, photoUrl: previousPhotoUrl };
  const match = String(photoData).match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return { ok: false, message: "請上傳 PNG、JPG、WEBP 或 GIF 圖片。" };

  const type = match[1] === "jpeg" ? "jpg" : match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return { ok: false, message: "圖片檔案是空的。" };
  if (buffer.length > MAX_LOCATION_PHOTO_BYTES) return { ok: false, message: "圖片大小不能超過 5MB。" };

  fs.mkdirSync(LOCATION_UPLOAD_DIR, { recursive: true });
  const fileName = `${locationId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${type}`;
  const filePath = path.join(LOCATION_UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  deleteLocalLocationPhoto(previousPhotoUrl);
  return { ok: true, photoUrl: `/uploads/locations/${fileName}` };
}

let db = loadDb();

function bookingHours(booking) {
  return (new Date(booking.end) - new Date(booking.start)) / 36e5;
}

function currentSchedulingCycle(now = new Date()) {
  const thisWeekStart = startOfWeek(now);
  const nextCycle = bookableSchedulingCycle(now);
  const activeWeekStart = now >= nextCycle.releaseTime ? nextCycle.nextWeekStart : thisWeekStart;
  const releaseTime = addDays(activeWeekStart, -3);
  releaseTime.setHours(12, 0, 0, 0);
  return {
    key: dateKey(activeWeekStart),
    nextWeekStart: activeWeekStart,
    nextWeekEnd: addDays(activeWeekStart, 7),
    releaseTime
  };
}

function bookableSchedulingCycle(now = new Date()) {
  const nextWeekStart = startOfWeek(addDays(now, 7));
  const releaseTime = addDays(nextWeekStart, -3);
  releaseTime.setHours(12, 0, 0, 0);
  return {
    key: dateKey(nextWeekStart),
    nextWeekStart,
    nextWeekEnd: addDays(nextWeekStart, 7),
    releaseTime
  };
}

function priorityRestrictionEndsAt(nextWeekStart) {
  const endsAt = addDays(nextWeekStart, -1);
  endsAt.setHours(12, 0, 0, 0);
  return endsAt;
}

function priorityRestrictionActiveFor(cycle, now = new Date()) {
  return now < priorityRestrictionEndsAt(cycle.nextWeekStart);
}

function autoRentalReleaseStartsAt(cycle) {
  const startsAt = new Date(cycle.nextWeekStart);
  startsAt.setHours(8, 0, 0, 0);
  return startsAt;
}

function autoRentalReleaseActive(cycle = currentSchedulingCycle(), now = new Date()) {
  return now >= autoRentalReleaseStartsAt(cycle);
}

function isScheduleComplete(user, cycle = currentSchedulingCycle(), now = new Date()) {
  return user.scheduleCompleteCycleStart === cycle.key || autoRentalReleaseActive(cycle, now);
}

function approvedCoaches() {
  return db.users.filter((user) => user.role !== "admin" && user.approvalStatus === "approved");
}

function incompleteHigherPriorityCoaches(user) {
  const cycle = currentSchedulingCycle();
  const priority = Number(user.schedulePriority || 9999);
  return approvedCoaches()
    .filter((coach) => coach.id !== user.id && Number(coach.schedulePriority || 9999) < priority && !isScheduleComplete(coach, cycle))
    .sort((a, b) => Number(a.schedulePriority || 9999) - Number(b.schedulePriority || 9999));
}

function rentalAvailability() {
  const cycle = currentSchedulingCycle();
  const coaches = approvedCoaches();
  // 場租等本輪教練完成排課；若週一 08:00 已到，系統會自動視為完成並開放。
  const isOpen = coaches.length > 0 && coaches.every((coach) => isScheduleComplete(coach, cycle));
  return {
    isOpen,
    startDate: dateKey(cycle.nextWeekStart),
    endDate: dateKey(addDays(cycle.nextWeekEnd, -1)),
    completedCount: coaches.filter((coach) => isScheduleComplete(coach, cycle)).length,
    totalCount: coaches.length,
    autoReleaseAt: autoRentalReleaseStartsAt(cycle).toISOString()
  };
}

function userPointTransactions(userId) {
  return db.pointTransactions
    .filter((transaction) => transaction.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function createPointTransaction({ userId, amount, type, source, note, bookingId = "", createdBy = "system" }) {
  const user = db.users.find((item) => item.id === userId);
  if (!user) return null;
  const transaction = {
    id: makeId("point"),
    userId,
    amount,
    type,
    source,
    note: String(note || "").trim(),
    bookingId,
    createdBy,
    balanceAfter: Number((Number(user.pointsBalance || 0) + amount).toFixed(2)),
    createdAt: new Date().toISOString()
  };
  user.pointsBalance = transaction.balanceAfter;
  db.pointTransactions.push(transaction);
  return transaction;
}

function bookingPointNote(booking) {
  const location = db.locations.find((item) => item.id === booking.locationId)?.name || "未知地點";
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  return `${location} ${dateKey(start)} ${pad(start.getHours())}:${pad(start.getMinutes())}-${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

function chargeBookingPoints(booking, createdBy = "system") {
  if (booking.pointsChargedAt || booking.pointsChargeSkipped) return null;
  const transaction = createPointTransaction({
    userId: booking.userId,
    amount: -bookingHours(booking),
    type: "debit",
    source: "booking",
    bookingId: booking.id,
    note: bookingPointNote(booking),
    createdBy
  });
  if (transaction) {
    booking.pointsChargedAt = transaction.createdAt;
    booking.pointTransactionId = transaction.id;
  }
  return transaction;
}

function refundBookingPoints(booking, createdBy) {
  if (!booking.pointsChargedAt || booking.pointsRefundedAt) return null;
  const transaction = createPointTransaction({
    userId: booking.userId,
    amount: bookingHours(booking),
    type: "credit",
    source: "booking-refund",
    bookingId: booking.id,
    note: `取消退點：${bookingPointNote(booking)}`,
    createdBy
  });
  if (transaction) {
    booking.pointsRefundedAt = transaction.createdAt;
    booking.pointRefundTransactionId = transaction.id;
  }
  return transaction;
}

function processPointDeductions() {
  let changed = false;
  const now = new Date();
  db.bookings.forEach((booking) => {
    if (booking.pointsChargedAt || booking.pointsChargeSkipped || new Date(booking.end) > now) return;
    if (chargeBookingPoints(booking)) changed = true;
  });
  if (changed) saveDb(db);
}

function publicPointTransaction(transaction, { adminView = false } = {}) {
  const next = {
    id: transaction.id,
    userId: transaction.userId,
    amount: transaction.amount,
    type: transaction.type,
    source: transaction.source,
    note: transaction.note,
    bookingId: transaction.bookingId || "",
    balanceAfter: transaction.balanceAfter,
    createdAt: transaction.createdAt
  };
  if (adminView) next.createdBy = transaction.createdBy;
  return next;
}

function publicUser(user, { adminView = false, includeBalance = false } = {}) {
  const next = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    approvalStatus: user.approvalStatus || "approved",
    schedulePriority: Number(user.schedulePriority || 0),
    scheduleCompleteCycleStart: user.scheduleCompleteCycleStart || "",
    scheduleCompleted: isScheduleComplete(user),
    createdAt: user.createdAt
  };
  if (includeBalance || adminView) next.pointsBalance = Number(user.pointsBalance || 0);
  if (adminView) {
    next.phone = user.phone || "";
    next.approvedAt = user.approvedAt || "";
    next.approvedBy = user.approvedBy || "";
    next.rejectedAt = user.rejectedAt || "";
  }
  return next;
}

function publicBooking(booking, { authenticated = false } = {}) {
  const next = {
    id: booking.id,
    locationId: booking.locationId,
    start: booking.start,
    end: booking.end
  };
  if (authenticated) {
    next.userId = booking.userId;
    next.note = booking.note || "";
    next.createdBy = booking.createdBy || "";
    next.createdAt = booking.createdAt || "";
    next.pointsChargedAt = booking.pointsChargedAt || "";
    next.pointsRefundedAt = booking.pointsRefundedAt || "";
  }
  return next;
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function error(res, status, message) {
  json(res, status, { error: message });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getAuthUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = token ? db.sessions[token] : null;
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function currentUserOrNull(req) {
  const user = getAuthUser(req);
  if (!user || user.approvalStatus !== "approved") return null;
  return user;
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) error(res, 401, "請先登入。");
  else if (user.approvalStatus !== "approved") {
    error(res, 403, user.approvalStatus === "pending" ? "等待審核中" : "帳號未通過審核，請聯絡管理者。");
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    error(res, 403, "需要管理者權限。");
    return null;
  }
  return user;
}

function canBook(user, start) {
  if (user.role === "admin") return { ok: true };
  if (start < new Date()) return { ok: false, message: "不能排定已經過去的時段。" };
  if (user.role !== "coach") {
    return { ok: false, message: "此身份沒有排課權限。" };
  }

  const thisWeekStart = startOfWeek(new Date());
  const cycle = bookableSchedulingCycle();
  const { nextWeekStart, nextWeekEnd, releaseTime } = cycle;

  if (start < thisWeekStart || start >= nextWeekEnd) {
    return { ok: false, message: "教練只能排定本週或下週一到週日。" };
  }
  if (start < nextWeekStart) {
    return { ok: true };
  }
  if (new Date() < releaseTime) {
    return { ok: false, message: `下週時段將於 ${dateKey(releaseTime)} 12:00 開放。` };
  }
  if (priorityRestrictionActiveFor(cycle)) {
    const blockers = incompleteHigherPriorityCoaches(user);
    if (blockers.length) {
      return { ok: false, message: `請等待優先序較前的教練完成排課：${blockers.map((coach) => coach.name).join("、")}。` };
    }
  }
  return { ok: true };
}

function findOverlap(locationId, start, end) {
  return db.bookings.find((booking) => {
    if (booking.locationId !== locationId) return false;
    return overlaps(start, end, new Date(booking.start), new Date(booking.end));
  });
}

function canCancel(user, booking) {
  if (user.role === "admin") return { ok: true };
  if (booking.userId !== user.id) return { ok: false, message: "只能取消自己的租用。" };
  if ((new Date(booking.start) - new Date()) / 36e5 <= APP_CONFIG.cancelCutoffHours) {
    return { ok: false, message: `開始前 ${APP_CONFIG.cancelCutoffHours} 小時內需由管理者取消。` };
  }
  return { ok: true };
}

function sendStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}data${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  try {
    processPointDeductions();

    if (req.method === "POST" && url.pathname === "/api/register") {
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "").trim();
      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      if (!username || !password || !name || !phone) return error(res, 400, "請填寫姓名、電話、帳號與密碼。");
      if (password.length < 6) return error(res, 400, "密碼至少需要 6 個字。");
      if (db.users.some((user) => user.username === username)) return error(res, 409, "這個帳號已經被使用。");
      const user = {
        id: makeId("user"),
        username,
        passwordHash: hashPassword(password),
        name,
        phone,
        role: "coach",
        approvalStatus: "pending",
        pointsBalance: 0,
        schedulePriority: nextSchedulePriority(db.users),
        scheduleCompleteCycleStart: "",
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      saveDb(db);
      return json(res, 201, { message: "註冊已送出，請等待管理者審核。" });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req);
      const user = db.users.find((item) => item.username === String(body.username || "").trim());
      if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
        return error(res, 401, "帳號或密碼不正確。");
      }
      if (user.approvalStatus === "pending") return error(res, 403, "等待審核中");
      if (user.approvalStatus === "rejected") return error(res, 403, "帳號未通過審核，請聯絡管理者。");
      const token = crypto.randomBytes(32).toString("hex");
      db.sessions[token] = { userId: user.id, createdAt: new Date().toISOString() };
      saveDb(db);
      return json(res, 200, { token, user: publicUser(user, { includeBalance: true }) });
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const user = currentUserOrNull(req);
      const isAdmin = user?.role === "admin";
      const cycle = currentSchedulingCycle();
      return json(res, 200, {
        currentUser: user ? publicUser(user, { adminView: isAdmin, includeBalance: true }) : null,
        users: db.users
          .filter((item) => user && (isAdmin || item.approvalStatus === "approved"))
          .map((item) => publicUser(item, { adminView: isAdmin })),
        locations: db.locations,
        bookings: db.bookings.map((booking) => publicBooking(booking, { authenticated: Boolean(user) })),
        pointTransactions: user
          ? (isAdmin ? db.pointTransactions : userPointTransactions(user.id)).map((transaction) => publicPointTransaction(transaction, { adminView: isAdmin }))
          : [],
        scheduling: {
          cycleStart: cycle.key,
          releaseAt: cycle.releaseTime.toISOString(),
          priorityEndsAt: priorityRestrictionEndsAt(cycle.nextWeekStart).toISOString(),
          coaches: user
            ? approvedCoaches()
              .sort((a, b) => Number(a.schedulePriority || 9999) - Number(b.schedulePriority || 9999))
              .map((coach) => publicUser(coach, { adminView: isAdmin }))
            : []
        },
        rentalAvailability: rentalAvailability(),
        config: APP_CONFIG,
        settings: db.settings
      });
    }

    if (req.method === "PUT" && url.pathname === "/api/settings") {
      requireAdmin(req, res);
      if (res.headersSent) return;
      const body = await readJson(req);
      const pointValueMoney = Number(body.pointValueMoney);
      if (!Number.isFinite(pointValueMoney) || pointValueMoney < 0) return error(res, 400, "每點金額需為 0 以上的數字。");
      db.settings.pointValueMoney = Number(pointValueMoney.toFixed(2));
      saveDb(db);
      return json(res, 200, { settings: db.settings });
    }

    if (req.method === "POST" && url.pathname === "/api/locations") {
      requireAdmin(req, res);
      if (res.headersSent) return;
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      if (!name) return error(res, 400, "請輸入地點名稱。");
      const id = makeId("location");
      const photo = saveLocationPhotoUpload(id, body.photoData);
      if (!photo.ok) return error(res, 400, photo.message);
      const location = {
        id,
        name,
        address: String(body.address || "").trim(),
        contactName: String(body.contactName || "").trim(),
        contactPhone: String(body.contactPhone || "").trim(),
        photoUrl: photo.photoUrl
      };
      db.locations.push(location);
      saveDb(db);
      return json(res, 201, { location });
    }

    const locationUpdate = url.pathname.match(/^\/api\/locations\/([^/]+)$/);
    if (req.method === "PUT" && locationUpdate) {
      requireAdmin(req, res);
      if (res.headersSent) return;
      const id = decodeURIComponent(locationUpdate[1]);
      const location = db.locations.find((item) => item.id === id);
      if (!location) return error(res, 404, "找不到場地。");
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      if (!name) return error(res, 400, "請輸入地點名稱。");
      const photo = saveLocationPhotoUpload(id, body.photoData, location.photoUrl || "");
      if (!photo.ok) return error(res, 400, photo.message);
      if (body.removePhoto && !body.photoData) deleteLocalLocationPhoto(location.photoUrl);
      location.name = name;
      location.address = String(body.address || "").trim();
      location.contactName = String(body.contactName || "").trim();
      location.contactPhone = String(body.contactPhone || "").trim();
      location.photoUrl = body.removePhoto && !body.photoData ? "" : photo.photoUrl;
      saveDb(db);
      return json(res, 200, { location });
    }

    if (req.method === "DELETE" && locationUpdate) {
      requireAdmin(req, res);
      if (res.headersSent) return;
      const id = decodeURIComponent(locationUpdate[1]);
      db.locations = db.locations.filter((location) => location.id !== id);
      db.bookings = db.bookings.filter((booking) => booking.locationId !== id);
      saveDb(db);
      return json(res, 200, { ok: true });
    }

    const schedulingUpdate = url.pathname.match(/^\/api\/users\/([^/]+)\/scheduling$/);
    if (req.method === "PUT" && schedulingUpdate) {
      requireAdmin(req, res);
      if (res.headersSent) return;
      const body = await readJson(req);
      const user = db.users.find((item) => item.id === decodeURIComponent(schedulingUpdate[1]));
      if (!user) return error(res, 404, "找不到使用者。");
      if (user.role === "admin") return error(res, 400, "管理者不需要排課優先序。");
      const schedulePriority = Number(body.schedulePriority);
      if (!Number.isInteger(schedulePriority) || schedulePriority < 1) return error(res, 400, "排課優先序需為大於 0 的整數。");
      user.schedulePriority = schedulePriority;
      saveDb(db);
      return json(res, 200, { user: publicUser(user, { adminView: true }) });
    }

    const pointsRecharge = url.pathname.match(/^\/api\/users\/([^/]+)\/points$/);
    if (req.method === "POST" && pointsRecharge) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readJson(req);
      const target = db.users.find((item) => item.id === decodeURIComponent(pointsRecharge[1]));
      if (!target) return error(res, 404, "找不到使用者。");
      if (target.approvalStatus !== "approved") return error(res, 400, "只能替已通過審核的使用者調整點數。");
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount === 0 || amount % 0.5 !== 0) return error(res, 400, "調整點數需為 0.5 的非零倍數。");
      const transaction = createPointTransaction({
        userId: target.id,
        amount,
        type: amount > 0 ? "credit" : "debit",
        source: amount > 0 ? "recharge" : "manual-adjustment",
        note: body.note || (amount > 0 ? "管理者儲值" : "管理者扣點"),
        createdBy: admin.id
      });
      saveDb(db);
      return json(res, 201, {
        user: publicUser(target, { adminView: true }),
        transaction: publicPointTransaction(transaction, { adminView: true })
      });
    }

    const approvalUpdate = url.pathname.match(/^\/api\/users\/([^/]+)\/approval$/);
    if (req.method === "PUT" && approvalUpdate) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readJson(req);
      const user = db.users.find((item) => item.id === decodeURIComponent(approvalUpdate[1]));
      if (!user) return error(res, 404, "找不到使用者。");
      if (user.role === "admin") return error(res, 400, "管理者不需要審核。");
      if (!["approved", "rejected", "pending"].includes(body.approvalStatus)) return error(res, 400, "審核狀態不正確。");
      user.approvalStatus = body.approvalStatus;
      if (body.approvalStatus === "approved") {
        user.approvedAt = new Date().toISOString();
        user.approvedBy = admin.id;
        delete user.rejectedAt;
      }
      if (body.approvalStatus === "rejected") {
        user.rejectedAt = new Date().toISOString();
        delete user.approvedAt;
        delete user.approvedBy;
      }
      Object.keys(db.sessions).forEach((token) => {
        if (db.sessions[token].userId === user.id) delete db.sessions[token];
      });
      saveDb(db);
      return json(res, 200, { user: publicUser(user, { adminView: true }) });
    }

    if (req.method === "POST" && url.pathname === "/api/schedule-complete") {
      const user = requireAuth(req, res);
      if (!user) return;
      if (user.role === "admin") return error(res, 400, "管理者不需要標記排課完成。");
      const cycle = currentSchedulingCycle();
      if (new Date() < cycle.releaseTime) return error(res, 400, `本輪排課將於 ${dateKey(cycle.releaseTime)} 12:00 開放。`);
      user.scheduleCompleteCycleStart = cycle.key;
      saveDb(db);
      return json(res, 200, { user: publicUser(user, { includeBalance: true }) });
    }

    if (req.method === "POST" && url.pathname === "/api/bookings") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJson(req);
      const location = db.locations.find((item) => item.id === body.locationId);
      if (!location) return error(res, 404, "找不到場地。");

      const bookingUserId = user.role === "admin" ? String(body.userId || user.id) : user.id;
      const bookingUser = db.users.find((item) => item.id === bookingUserId);
      if (!bookingUser) return error(res, 404, "找不到租用人。");
      if (bookingUser.approvalStatus !== "approved") return error(res, 403, "此使用者尚未通過審核。");

      const start = new Date(body.start);
      const duration = Number(body.duration);
      const end = addHours(start, duration);
      if (Number.isNaN(start.getTime()) || duration <= 0 || duration % 0.5 !== 0) return error(res, 400, "請確認租用時間。");
      if (!isHalfHourTime(start)) return error(res, 400, "開始時間需以整點或半點為單位。");
      if (!isWithinRentalHours(start, end)) return error(res, 400, `出租時間限 ${pad(APP_CONFIG.openHour)}:00 到 ${pad(APP_CONFIG.closeHour)}:${pad(APP_CONFIG.closeMinute)}，且不得跨日。`);
      const permission = user.role === "admin" ? { ok: true } : canBook(user, start);
      if (!permission.ok) return error(res, 403, permission.message);

      const booking = {
        id: makeId("booking"),
        locationId: location.id,
        userId: bookingUser.id,
        start: start.toISOString(),
        end: end.toISOString(),
        note: String(body.note || "").trim(),
        createdBy: user.id,
        createdAt: new Date().toISOString()
      };
      db.bookings.push(booking);
      if (end <= new Date()) chargeBookingPoints(booking, user.id);
      saveDb(db);
      return json(res, 201, { booking });
    }

    const bookingDelete = url.pathname.match(/^\/api\/bookings\/([^/]+)$/);
    if (req.method === "DELETE" && bookingDelete) {
      const user = requireAuth(req, res);
      if (!user) return;
      const booking = db.bookings.find((item) => item.id === decodeURIComponent(bookingDelete[1]));
      if (!booking) return error(res, 404, "找不到租用紀錄。");
      const permission = canCancel(user, booking);
      if (!permission.ok) return error(res, 403, permission.message);
      refundBookingPoints(booking, user.id);
      db.bookings = db.bookings.filter((item) => item.id !== booking.id);
      saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      requireAdmin(req, res);
      if (res.headersSent) return;
      const start = new Date(`${url.searchParams.get("start")}T00:00:00`);
      const end = new Date(`${url.searchParams.get("end")}T23:59:59`);
      const pointValueMoney = Number(db.settings.pointValueMoney || 0);
      const totals = new Map();
      db.pointTransactions.forEach((transaction) => {
        const createdAt = new Date(transaction.createdAt);
        if (createdAt < start || createdAt > end) return;
        if (transaction.type === "debit" && transaction.source === "booking") {
          totals.set(transaction.userId, (totals.get(transaction.userId) || 0) + Math.abs(transaction.amount));
        }
        if (transaction.type === "credit" && transaction.source === "booking-refund") {
          totals.set(transaction.userId, (totals.get(transaction.userId) || 0) - Math.abs(transaction.amount));
        }
      });
      const rows = db.users
        .filter((user) => user.approvalStatus === "approved")
        .map((user) => {
          const points = Math.max(0, totals.get(user.id) || 0);
          return { ...publicUser(user), points, revenue: Number((points * pointValueMoney).toFixed(2)) };
        });
      const totalPoints = Number(rows.reduce((sum, row) => sum + Number(row.points || 0), 0).toFixed(2));
      return json(res, 200, {
        pointValueMoney,
        totalPoints,
        totalRevenue: Number((totalPoints * pointValueMoney).toFixed(2)),
        rows
      });
    }

    return error(res, 404, "找不到 API。");
  } catch (err) {
    console.error(err);
    return error(res, 500, "伺服器發生錯誤。");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  sendStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Scheduler server running on http://${HOST}:${PORT}`);
  console.log(`Database file: ${DB_FILE}`);
  if (generatedAdminPassword) {
    console.log(`Generated initial admin username: ${ADMIN_USERNAME}`);
    console.log(`Generated initial admin password: ${generatedAdminPassword}`);
    console.log("Set ADMIN_USERNAME and ADMIN_PASSWORD environment variables before first startup to control these credentials.");
  }
});

// Keep point balances current even when nobody is clicking around at the exact booking end time.
setInterval(processPointDeductions, 60 * 1000);
