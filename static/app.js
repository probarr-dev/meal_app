const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// dow (0-6) is an offset from the week's start day, which is configurable —
// these get rebuilt in boot() once we know what day the week actually starts.
let DAYS = WEEKDAY_NAMES;
let SHORT = WEEKDAY_SHORT;

const S = {
  weekId: null, weeks: [], people: [], aisles: [], tags: [], meals: [], week: null,
  // Who's using the app right now. No auth — this is a LAN app for one household,
  // and passwords for children are friction with no threat model behind them.
  meId: null, // set from the sign-in by /api/bootstrap
  mealFilter: { tag: "", q: "" },
};

const me = () => S.people.find((p) => p.id === S.meId) || null;
const isParent = () => me()?.role === "parent";
const isAdmin = () => !!me()?.is_admin;
const KID_COLORS = ["#ff5fa2", "#7c4dff", "#3ee08a", "#ffc93c", "#4f8cff", "#ff7a45", "#00d4c8"];
const MEAL_TYPES = [
  ["proper", "Proper meal", "Proper meals"], ["light", "Light bite", "Light bites"],
  ["pudding", "Pudding", "Puddings"], ["kids_lunch", "Lunch", "Lunches"],
  ["takeaway", "Takeaway", "Takeaways"],
];
const TAB_KEYS = [
  ["plan", "Plan"], ["shopping", "Shopping"], ["extras", "Extras"], ["meals", "Meals"],
  ["vote", "Vote"], ["rewards", "Rewards"], ["pricing", "Prices"], ["compare", "Compare"], ["history", "History"], ["settings", "Settings"],
];
// null/unset allowed_tabs = everyone, unchanged from before this feature
// existed. Admins always keep Settings regardless of what's configured —
// otherwise an admin could lock themselves out of the one place that fixes it.
function allowedTabsFor(p) {
  if (!p) return TAB_KEYS.map(([k]) => k);
  if (!p.allowed_tabs) return TAB_KEYS.map(([k]) => k);
  const set = new Set(p.allowed_tabs.split(","));
  // Extras used to live inside Vote/Shopping; History now lives inside Settings.
  if (set.has("vote") || set.has("shopping")) set.add("extras");
  if (set.has("settings")) set.add("history");
  if (p.is_admin) set.add("settings");
  // Everyone gets Settings: without page access to it, it only shows their own
  // things (look, notifications, password, sign out). See personalSettingsOnly.
  set.add("settings");
  return [...set];
}
const personalSettingsOnly = (p) => !!p && !!p.allowed_tabs && !p.is_admin && !p.allowed_tabs.split(",").includes("settings");
const mealHasType = (m, t) => (m.meal_type || "").split(",").includes(t);

// The weekly loop, made visible. Vote -> Plan -> Shop is the actual order
// things happen in, but the nav is ordered for daily use (Plan first, because
// "what's for dinner tonight" is opened far more often than the weekly setup
// runs). This strip carries the sequence without reshuffling the nav: it
// shows where you are and doubles as a shortcut to the next step. Extras are
// deliberately NOT a step — that window stays open in parallel, from voting
// right up until the shop is marked done.
function cycleStripHTML(current) {
  const steps = [["vote", "Vote", "#/vote"], ["plan", "Plan days", "#/plan"], ["shop", "Shop", "#/shopping"]];
  return `<nav class="cycle-strip no-print">${steps.map(([key, label, href]) =>
    `<a href="${href}" class="cycle-step ${key === current ? "on" : ""}">${esc(label)}</a>`).join("")}</nav>`;
}

// Dice coefficient over character bigrams. Deterministic, ~10 lines, no
// dependency — enough to catch "Mozzerella" vs "Mozzarella" at the moment
// someone types it, which is the only point a duplicate is cheap to stop.
// Merging them afterwards is guesswork; asking once, up front, isn't.
function similarity(a, b) {
  a = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  b = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, 2 + i); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const A = grams(a), B = grams(b);
  let hits = 0, total = 0;
  for (const [g, n] of A) { total += n; hits += Math.min(n, B.get(g) || 0); }
  for (const n of B.values()) total += n;
  return total ? (2 * hits) / total : 0;
}

// An existing name suspiciously close to what was just typed, or null.
// Never auto-corrects: "Pepper" and "Peppers" score high but are genuinely
// different things, so this only ever asks.
function closeExistingName(typed) {
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const list = S.ingredientNames || [];
  if (!typed.trim() || list.some((n) => norm(n) === norm(typed))) return null;
  let best = null, score = 0;
  for (const n of list) { const s = similarity(typed, n); if (s > score) { score = s; best = n; } }
  // 0.75 tuned against the real library: catches Mozzerella/Cucmber/Tomatos,
  // while 0.80 missed them and 0.70 started nagging that "Jacket Potatoes"
  // might be "Potatoes". Exact matches never reach here, so names that
  // already exist side by side never prompt.
  return score >= 0.75 ? best : null;
}

// Shared by the shopping "add an item" box and the meal ingredient editor.
// Returns the name to actually use, or null if the user backed out.
async function confirmNewName(typed) {
  const near = closeExistingName(typed);
  if (!near) return typed;
  const useExisting = await confirmDialog(
    `You already have "${near}".`,
    { title: "Use the existing one?", okLabel: `Use "${near}"`, cancelLabel: `Add "${typed}" separately` });
  return useExisting ? near : typed;
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

// A whole coordinated dark palette built from one picked colour — background,
// cards and borders all tinted with its hue, not just the accent. That's
// what actually reads as "my colour scheme" rather than "my button colour".
const TEXT_SIZES = [["S", 90], ["M", 100], ["L", 112], ["XL", 125]];
function textSizeKey() { return `mealplan-textsize-${S.meId || "anon"}`; }
function applyTextSize() {
  let pct = 100, compact = false;
  try {
    pct = +localStorage.getItem(textSizeKey()) || 100;
    compact = localStorage.getItem(`mealplan-compact-${S.meId || "anon"}`) === "1";
  } catch { /* ignore */ }
  document.documentElement.style.fontSize = `${pct}%`;
  document.documentElement.classList.toggle("compact", compact);
}
function applyTheme() {
  applyTextSize();
  const p = me();
  document.documentElement.dataset.funTheme = p?.theme === "fun" ? "1" : "0";
  const pad = String(p?.theme || "").startsWith("notepad");
  document.documentElement.dataset.notepad = pad ? "1" : "0";
  document.documentElement.dataset.pad = pad ? (p.theme.split("-")[1] || "cream") : "";
  const root = document.documentElement.style;
  if (p?.color && !pad) {
    const [h] = hexToHsl(p.color);
    root.setProperty("--accent", p.color);
    root.setProperty("--bg", `hsl(${h.toFixed(0)}, 38%, 9%)`);
    root.setProperty("--card", `hsl(${h.toFixed(0)}, 40%, 15%)`);
    root.setProperty("--border", `hsl(${h.toFixed(0)}, 38%, 25%)`);
  } else {
    ["--accent", "--bg", "--card", "--border"].forEach((v) => root.removeProperty(v));
  }
}

// Any failure here must be visible. A silent catch means clicking a tab
// appears to do nothing, which is impossible to diagnose from the outside.
const scroller = () => document.scrollingElement;
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
const pendingTicks = () => lsGet("mealplan-pending-ticks") || [];
function queueTick(t) {
  lsSet("mealplan-pending-ticks", pendingTicks().filter((x) => !(x.week_id === t.week_id && x.item === t.item)).concat(t));
}
async function flushTicks() {
  for (const t of pendingTicks()) {
    try { await api.post("/api/shop-tick", t); } catch { return; }
    lsSet("mealplan-pending-ticks", pendingTicks().filter((x) => !(x.week_id === t.week_id && x.item === t.item)));
  }
}
window.addEventListener("online", () => flushTicks());

async function req(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error(`Can't reach the server. Is it running?\n\n${e.message}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned ${res.status}, not JSON:\n${text.slice(0, 300)}`);
  }
  if (res.status === 401 && body.error === "signin") {
    showSignIn(!!body.setup);
    throw new Error("Signed out");
  }
  if (!res.ok || body.error) throw new Error(body.error || `${path} → HTTP ${res.status}`);
  if (body.notice) showRequestNotice(body.notice);
  return body;
}

// A nudge when someone piles up extra requests (levels 1-3), and the reset at the limit (4).
function showRequestNotice(n) {
  const html = `<p style="font-size:1.15rem;text-align:center;margin:8px 0">${esc(n.text)}</p>
    <button class="primary" style="width:100%" onclick="closeModal()">${n.level === 4 ? "OK" : "Fair enough"}</button>`;
  setTimeout(() => { openModal(n.level === 4 ? "Requests reset" : "Hold on…", html); if (n.level === 4 && typeof boot === "function") boot().then(() => route()); }, 0);
}

// Sign-in (or, on a brand-new install, create the first account). Plain
// form fields so password managers fill and save them.
function showSignIn(setup) {
  if (document.getElementById("signinForm")) return;
  S.pauseSync = true;
  document.querySelector(".tabs").style.display = "none";
  document.getElementById("voteFab")?.classList.add("hidden");
  document.getElementById("view").innerHTML = `
    <div class="login-gate">
      <h1>${setup ? "Welcome" : "Sign in"}</h1>
      <p class="subtitle">${setup ? "Create the first account. You'll be the admin and can add everyone else from Settings." : ""}</p>
      <form id="signinForm" class="card pad" style="max-width:340px;margin:0 auto">
        ${setup ? `<label class="field"><span>Your name</span><input id="siName" maxlength="30" autocomplete="name" required></label>` : ""}
        <label class="field"><span>Username</span><input id="siUser" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" ${setup ? "" : "required"}></label>
        <label class="field"><span>Password</span><input id="siPass" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required></label>
        <p id="siErr" class="pin-error"></p>
        <button class="primary" style="width:100%">${setup ? "Create account" : "Sign in"}</button>
      </form>
    </div>`;
  const f = document.getElementById("signinForm");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById("siErr");
    const btn = f.querySelector("button");
    btn.disabled = true;
    err.textContent = ""; err.classList.remove("show");
    try {
      const res = await fetch(setup ? "/api/setup" : "/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(setup
          ? { name: document.getElementById("siName").value, username: document.getElementById("siUser").value, password: document.getElementById("siPass").value }
          : { username: document.getElementById("siUser").value, password: document.getElementById("siPass").value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't sign in.");
      location.reload();
    } catch (ex) {
      err.textContent = ex.message; err.classList.add("show");
      document.getElementById("siPass").value = "";
      btn.disabled = false;
    }
  };
  (document.getElementById(setup ? "siName" : "siUser")).focus();
}

// Change your own password. `forced` = signed in with a temporary one.
function changePasswordForm(forced) {
  return `
    <form id="pwForm" class="card pad" style="max-width:340px;${forced ? "margin:0 auto" : ""}">
      <input type="text" autocomplete="username" value="${esc(me()?.username || "")}" hidden>
      ${forced ? "" : `<label class="field"><span>Current password</span><input id="pwCur" type="password" autocomplete="current-password" required></label>`}
      <label class="field"><span>New password</span><input id="pwNew" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="field"><span>New password again</span><input id="pwNew2" type="password" autocomplete="new-password" minlength="8" required></label>
      <p class="hint">At least 8 characters. A short sentence is easiest to remember.</p>
      <button class="primary" style="width:100%">Save password</button>
    </form>`;
}
function wirePasswordForm(onDone) {
  const f = document.getElementById("pwForm");
  if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const nw = document.getElementById("pwNew").value;
    if (nw !== document.getElementById("pwNew2").value) return toast("The two new passwords don't match.", "bad");
    try {
      await api.post("/api/password", { current: document.getElementById("pwCur")?.value || "", new: nw });
      toast("Password saved.", "good");
      onDone();
    } catch (ex) { toast(ex.message, "bad"); }
  };
}

const api = {
  get: (p) => req(p),
  post: (p, b) => req(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b),
  }),
};

// A non-blocking notice. alert() would be wrong here: you're stood in a shop
// with one hand on the trolley, and a modal you have to dismiss to carry on
// ticking is worse than the problem it's reporting.
function toast(msg, kind, durationMs = 4500) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.className = "toast show" + (kind ? " " + kind : "");
  t.textContent = msg;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), durationMs);
}

const OFFLINE_MSG = "Couldn't save \u2014 no connection to the server. Reconnect and try again.";

// Every async button/select handler in the app wraps its element in this.
// Two things a tap needs that neither the network nor the browser gives for
// free: the element visibly goes into a pending state THE INSTANT it's
// pressed (not when the server eventually replies), and it's genuinely
// inert to a second tap for the whole round trip — so an impatient kid
// double-tapping "Add" on a slow connection gets one item, not two. Restores
// itself in a finally block, so a failed request never leaves a button stuck.
// If the handler re-renders the page (most do), the element it was disabling
// is simply gone by the time finally runs — touching a detached node is a
// harmless no-op, so no isConnected check is needed.
function busy(el, fn) {
  return async (...args) => {
    if (!el || el.disabled) return;
    el.disabled = true;
    el.classList.add("busy");
    try {
      return await fn(...args);
    } finally {
      el.disabled = false;
      el.classList.remove("busy");
    }
  };
}

// ------------------------------------------------------------ in-app dialogs
// Native confirm()/alert()/prompt() are un-stylable browser chrome that block
// the whole page and are the single biggest "this is a website, not an app"
// tell — and prompt() in particular gives no guarantee of a numeric keypad,
// which matters a lot for a 4-digit PIN. These three replace every use of
// them with the app's own modal, closeable the same way (✕, or Cancel).

// Wires the modal's ✕ so it resolves an in-flight dialog's promise instead of
// just closing silently and leaving the caller awaiting forever.
function withCloseGuard(onClose) {
  const btn = document.getElementById("modalClose");
  const prev = btn.onclick;
  btn.onclick = () => { onClose(); btn.onclick = prev; };
  return () => { btn.onclick = prev; };
}

function confirmDialog(message, opts = {}) {
  const { danger = false, okLabel = "OK", cancelLabel = "Cancel", title = "Are you sure?" } = opts;
  return new Promise((resolve) => {
    openModal(title, `
      <p style="white-space:pre-wrap;margin:0 0 4px">${esc(message)}</p>
      <div class="modal-actions" style="justify-content:flex-end;gap:8px">
        <button id="confirmCancel" class="ghost">${esc(cancelLabel)}</button>
        <button id="confirmOk" class="primary${danger ? " danger" : ""}">${esc(okLabel)}</button>
      </div>`);
    const restore = withCloseGuard(() => finish(false));
    const finish = (val) => { restore(); closeModal(); resolve(val); };
    document.getElementById("confirmCancel").onclick = () => finish(false);
    document.getElementById("confirmOk").onclick = () => finish(true);
  });
}

// This app is served over plain http:// on the LAN, which is NOT a secure
// context — so navigator.clipboard and navigator.share don't merely fail,
// they don't exist. Anything that reached for them threw on the spot and the
// button appeared to do nothing at all. execCommand is deprecated but it is
// what still works here, and there's a visible fallback behind it.
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// Always shows the link itself. Copying can fail for reasons the browser
// won't explain, so the text has to be on screen and selectable regardless —
// otherwise a failed copy leaves you with nothing to send.
function shareLinkDialog(title, url, note = "") {
  openModal(title, `
    ${note ? `<p class="hint" style="margin:0 0 8px">${esc(note)}</p>` : ""}
    <input id="slUrl" readonly value="${esc(url)}" style="width:100%;font-size:.8rem">
    <div class="modal-actions" style="justify-content:flex-end;gap:8px">
      <button id="slCopy" class="primary">Copy link</button>
      <button id="slClose" class="ghost">Close</button>
    </div>`);
  const input = document.getElementById("slUrl");
  input.focus(); input.select();
  const restore = withCloseGuard(() => { restore(); closeModal(); });
  document.getElementById("slClose").onclick = () => { restore(); closeModal(); };
  const btn = document.getElementById("slCopy");
  btn.onclick = async () => {
    input.select();
    btn.textContent = (await copyText(url)) ? "Copied ✓" : "Press ⌘/Ctrl+C";
  };
}

// Free-text replacement for prompt() — used for the one place that's genuinely
// asking for arbitrary text (a redemption note), not a PIN.
function textPrompt(title, opts = {}) {
  const { placeholder = "", okLabel = "OK" } = opts;
  return new Promise((resolve) => {
    openModal(title, `
      <input id="tpInput" placeholder="${esc(placeholder)}" style="width:100%">
      <div class="modal-actions" style="justify-content:flex-end;gap:8px">
        <button id="tpCancel" class="ghost">Cancel</button>
        <button id="tpOk" class="primary">${esc(okLabel)}</button>
      </div>`);
    const input = document.getElementById("tpInput");
    input.focus();
    const restore = withCloseGuard(() => finish(null));
    const finish = (val) => { restore(); closeModal(); resolve(val); };
    document.getElementById("tpCancel").onclick = () => finish(null);
    document.getElementById("tpOk").onclick = () => finish(input.value.trim());
    input.onkeydown = (e) => { if (e.key === "Enter") finish(input.value.trim()); };
  });
}

function showError(e) {
  if (document.getElementById("signinForm")) return; // signed out: the sign-in screen is showing
  document.getElementById("view").innerHTML = `
    <div class="error-box">
      <h2>Something went wrong</h2>
      <pre>${esc(e.message)}</pre>
      <p class="hint">If the server isn't running:
        <code>cd meal-plan &amp;&amp; python3 server.py</code></p>
      <button onclick="location.reload()">Retry</button>
    </div>`;
}

const el = (h) => { const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const r0 = (n) => Math.round(n || 0);
// "11 – 17 Aug" style range from a week's ISO start_date, for headers.
const fmtWeekRange = (startISO) => {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const day = (d) => d.toLocaleDateString("en-GB", { day: "numeric" });
  const mon = (d) => d.toLocaleDateString("en-GB", { month: "short" });
  const sameMonth = start.getMonth() === end.getMonth();
  return sameMonth
    ? `${day(start)}–${day(end)} ${mon(end)}`
    : `${day(start)} ${mon(start)} – ${day(end)} ${mon(end)}`;
};

// Which week you're looking at is the first thing to establish on all three
// step pages, so it gets its own centred line at a readable size rather than
// a small grey aside next to the title (or, on Shopping, buried in prose).
// Date in the page title doubles as the This/Next week switch.
const weekNavHTML = (startISO) => {
  if (!startISO) return "";
  const onNext = S.weekId === S.nextWeekId;
  return `<span class="week-range week-nav">
    <button class="weekNavBtn" data-to="this" ${onNext ? "" : "disabled"} aria-label="This week">‹</button>
    ${esc(fmtWeekRange(startISO))}
    <button class="weekNavBtn" data-to="next" ${onNext ? "disabled" : ""} aria-label="Next week">›</button></span>`;
};
document.addEventListener("click", (e) => {
  const b = e.target.closest(".weekNavBtn");
  if (!b || b.disabled) return;
  S.weekId = b.dataset.to === "next" ? S.nextWeekId : S.thisWeekId;
  route();
});
const meBadge = () => me() ? `<span class="me-badge" title="Signed in as ${esc(me().name)}">${me().emoji ? esc(me().emoji) : esc(me().name[0])}</span>` : "";

const weekBannerHTML = (startISO) =>
  startISO ? `<span class="week-range">${esc(fmtWeekRange(startISO))}</span>` : "";

// Average of the last 6 shops with a real total typed in.
function shopAverage() {
  const done = S.weeks.filter((w) => w.shop_total > 0).sort((a, b) => b.start_date.localeCompare(a.start_date)).slice(0, 6);
  return done.length ? { avg: done.reduce((s, w) => s + w.shop_total, 0) / done.length, n: done.length } : null;
}
async function askShopTotal(weekId, current) {
  const v = await textPrompt("How much did the shop come to?", { placeholder: current ? `£${current.toFixed(2)}` : "e.g. 68.40", okLabel: "Save" });
  if (v === null) return false;
  const n = parseFloat(v.replace(/[£,\s]/g, ""));
  if (v !== "" && !(n >= 0)) { toast("That doesn't look like an amount.", "bad"); return false; }
  const r = await api.post("/api/week/shop-total", { actor_id: S.meId, week_id: weekId, total: v === "" ? null : n });
  if (r.error) { toast(r.error, "bad"); return false; }
  return true;
}

// One coloured initial per voter (their own colour from Settings): the count
// and who, at a glance, in less room than "2 votes · Alex, Sam".
const VOTER_FALLBACK = ["#4f8cff", "#e0553c", "#3ec97a", "#e0a83c", "#9a5fc8", "#2fb3b3"];
function voterChips(voters) {
  return String(voters || "").split(",").map((n) => n.trim()).filter(Boolean).map((n) => {
    const p = S.people.find((x) => x.name === n);
    const col = p?.color || VOTER_FALLBACK[(p?.id || n.length) % VOTER_FALLBACK.length];
    if (p?.emoji) return `<span class="voter-emoji" title="${esc(n)}" aria-label="${esc(n)}">${esc(p.emoji)}</span>`;
    return `<span class="voter-chip" style="background:${col}" title="${esc(n)}" aria-label="${esc(n)}">${esc(n[0].toUpperCase())}</span>`;
  }).join("");
}
const ICON_CHOICES = ["🦊","🐼","🐯","🦁","🐸","🐵","🐶","🐱","🐰","🐻","🐨","🦄","🐙","🦖","🐝","🦋","🐧","🦉","🐬","🦈",
  "⭐","🌈","🔥","⚡","🌙","☀️","🍀","🌸","🍕","🍩","🍓","🍉","⚽","🏀","🎮","🎸","🚀","🚗","👑","💎"];
function pickIcon(personId, asAdmin) {
  openModal("Pick an icon", `<div class="icon-grid">${ICON_CHOICES.map((e) =>
    `<button class="iconPick" data-e="${e}">${e}</button>`).join("")}</div>
    <div class="icon-own"><input id="iconOwn" placeholder="Or type any emoji…" maxlength="16" autocomplete="off">
      <button id="iconOwnGo" class="primary">Use</button></div>
    <div class="modal-actions"><button class="iconPick ghost" data-e="">Use my initial instead</button></div>`);
  const save = async (e) => {
    const res = await api.post("/api/person", { id: personId, ...(asAdmin ? { admin_id: S.meId } : { actor_id: S.meId }), emoji: e || null });
    if (res.error) return toast(res.error, "bad");
    closeModal(); await boot();
  };
  const go = document.getElementById("iconOwnGo");
  go.onclick = busy(go, async () => {
    const v = document.getElementById("iconOwn").value.trim();
    // Keep just the first character a person would see (an emoji can be several code points).
    const first = v ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v)][0].segment : "";
    if (!first) return toast("Type an emoji first.", "bad");
    await save(first);
  });
  document.querySelectorAll(".iconPick").forEach((b) => (b.onclick = busy(b, () => save(b.dataset.e))));
}
const THEMES = [["classic", "Plain"], ["fun", "Fun colours"], ["notepad", "Notepad"], ["notepad-dark", "Notepad · dark"], ["notepad-mint", "Notepad · mint"], ["notepad-rose", "Notepad · rose"]];
const TAG_EMOJI = { "Healthy": "🥦", "Kids' favourite": "⭐", "Quick": "⚡", "Low carb": "🥗", "Batch cook": "🍲", "Treat": "🍰" };
const tagEmojis = (m) => {
  const bits = [];
  if (m.draft) bits.push(["🆕", "New"]);
  if (m.v?.chosen) bits.push(["✅", "On the shortlist"]);
  (m.tags || "").split(",").filter(Boolean).forEach((t) => bits.push([TAG_EMOJI[t] || "🏷️", t]));
  return bits.length ? ` <span class="vote-emojis">${bits.map(([e, t]) => `<span title="${esc(t)}" aria-label="${esc(t)}">${e}</span>`).join("")}</span>` : "";
};

const weekWords = (id) => (id === S.thisWeekId ? "this week" : id === S.nextWeekId ? "next week" : "the week of");

// A suggested meal starts as just a name — no ingredients, so it can't go on
// the shopping list yet. Checked live against S.meals (not the `draft` flag)
// so it stays accurate even for an older meal that was never marked draft.
const mealNeedsIngredients = (mealId) => {
  const m = S.meals.find((x) => x.id === mealId);
  // Takeaway/eating-out is deliberately empty — that's not a meal someone
  // forgot to finish writing, it's correctly never going to have ingredients.
  return !!m && !m.no_ingredients && !mealHasType(m, "takeaway") && (!m.ingredients || !m.ingredients.length);
};
const ingredientsWarningHTML = (needsIt) =>
  needsIt ? `<span class="tag tag-warn" title="No ingredients yet — can't go on the shopping list until someone fills them in">⚠ no ingredients</span>` : "";

// Unmissable rollup, not just a small tag buried in the list — every distinct
// meal that's picked up a vote this week but still has nobody's ingredients
// entered, so it can be fixed before it gets applied to the plan and quietly
// vanishes off the shopping list.
const missingIngredientsAlertHTML = (tally) => {
  const seen = new Map();
  for (const t of tally) {
    if (t.total > 0 && !seen.has(t.id) && mealNeedsIngredients(t.id)) seen.set(t.id, t.name);
  }
  if (!seen.size) return "";
  return `<div class="notice small info">
    <strong>⚠ ${seen.size} voted meal${seen.size > 1 ? "s" : ""} still need${seen.size > 1 ? "" : "s"} ingredients:</strong>
    ${[...seen.values()].map(esc).join(", ")} — edit them from the Meals page before applying the plan.
  </div>`;
};

/* ---------------------------------------------------------------- boot */

// Points land server-side whenever a parent finalises a healthy meal a kid
// voted for — which usually happens when that kid isn't even looking at the
// app. The parent gets an immediate diff in their own finalise toast (see
// wireFinalizePanel); this is the kid's half: the moment THEY next pick up
// their own device and become "them" again, if their balance has grown since
// the last time this same device saw them, say so. Keyed in localStorage
// (per-device, per-person) rather than anything server-side — this household
// is one device each, so "last seen on this phone" is exactly "last seen by
// this kid", and it means no server changes and no risk of a stale balance
// leaking to someone else's device.
async function celebrateNewPoints(personId) {
  let balance;
  try {
    balance = ((await api.get("/api/rewards")).balances || {})[personId] || 0;
  } catch (err) {
    return; // offline — nothing to celebrate, and nothing worth erroring over
  }
  const key = `mealplan-points-seen-${personId}`;
  const seen = localStorage.getItem(key);
  localStorage.setItem(key, String(balance));
  if (seen === null) return; // first time this device has ever seen them — don't
                              // "celebrate" a balance that's just always been there
  const delta = balance - Number(seen);
  if (delta > 0) {
    toast(`🎉 +${delta} point${delta === 1 ? "" : "s"} since you were last here! You're at ${balance} now.`, "good", 7000);
  }
}

async function boot() {
  // Wire navigation FIRST. If bootstrap fails after this, tabs still respond
  // and each one reports the real error instead of doing nothing.
  if (!boot.wired) {
    window.addEventListener("hashchange", route);
    document.getElementById("modalClose").onclick = closeModal;
    // Clicking the already-active tab fires no hashchange — handle it directly.
    document.querySelectorAll(".tabs a").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        document.body.classList.remove("nav-open"); // close the mobile drawer, if open
        const want = `#/${a.dataset.tab}`;
        if (location.hash === want) route();
        else location.hash = want;
      });
    });
    document.getElementById("navToggle").onclick = () => document.body.classList.toggle("nav-open");
    document.getElementById("navBackdrop").onclick = () => document.body.classList.remove("nav-open");
    boot.wired = true;
  }

  const b = await api.get("/api/bootstrap");
  S.meId = b.meId;
  S.weeks = b.weeks;
  S.people = b.people;
  S.aisles = b.aisles;
  S.tags = b.tags || [];
  applyTheme();

  document.querySelector(".tabs").style.display = "";
  if (b.mustChangePassword) {
    S.pauseSync = true;
    document.querySelector(".tabs").style.display = "none";
    document.getElementById("view").innerHTML = `
      <div class="login-gate"><h1>Choose your password</h1>
        <p class="subtitle">You signed in with a temporary one. Pick your own to carry on.</p>
        ${changePasswordForm(true)}</div>`;
    wirePasswordForm(() => location.reload());
    return;
  }
  if (!boot.celebrated) { boot.celebrated = true; celebrateNewPoints(S.meId); }
  // Opened by tapping a notification (app wasn't running): handle ?req= once, then tidy the URL.
  if (!boot.notified && new URLSearchParams(location.search).get("req")) {
    boot.notified = true;
    const url = location.href;
    history.replaceState(null, "", location.pathname + location.hash);
    setTimeout(() => openFromNotification(url), 300);
  }

  S.thisWeekId = b.thisWeekId;
  S.nextWeekId = b.nextWeekId;
  S.shopWeekId = b.shopWeekId || b.thisWeekId;
  S.shopViewWeekId = b.shopViewWeekId || S.shopWeekId;
  S.voteWeekId = b.voteWeekId;
  S.votingOpen = b.votingOpen;
  S.weekStartDow = b.weekStartDow ?? 5;
  S.mealsTargetDefault = b.mealsTargetDefault ?? 7;
  S.protectedWeeks = b.protectedWeekIds || [];
  S.allowHistoricEdits = !!b.allowHistoricEdits;
  S.extrasNeedPush = !!b.extrasNeedPush;
  S.boredDays = b.boredDays ?? 28;
  S.extrasFloodLimit = b.extrasFloodLimit ?? 12; S.extrasFloodTimeoutMin = b.extrasFloodTimeoutMin ?? 15;
  S.lastBackup = b.lastBackup ? JSON.parse(b.lastBackup) : null;
  S.morrisonsEnabled = !!b.morrisonsEnabled;
  S.vetoesPerPerson = b.vetoesPerPerson ?? 1;
  S.shopDone = !!b.shopDone;
  DAYS = WEEKDAY_NAMES.slice(S.weekStartDow).concat(WEEKDAY_NAMES.slice(0, S.weekStartDow));
  SHORT = WEEKDAY_SHORT.slice(S.weekStartDow).concat(WEEKDAY_SHORT.slice(0, S.weekStartDow));
  if (!S.weekId || !S.weeks.some((w) => w.id === S.weekId)) S.weekId = S.thisWeekId;

  const toggle = document.getElementById("weekToggle");
  const syncToggle = () => {
    toggle.querySelectorAll("button").forEach((b) => {
      const id = b.dataset.which === "this" ? S.thisWeekId : S.nextWeekId;
      b.classList.toggle("on", id === S.weekId);
    });
  };
  toggle.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      S.weekId = b.dataset.which === "this" ? S.thisWeekId : S.nextWeekId;
      syncToggle();
      route();
    };
  });
  syncToggle();

  route();
}

function route() {
  if (location.hash === "#/vote/extras" || location.hash === "#/shopping/regulars") { location.hash = "#/extras"; return; }
  const allowed = allowedTabsFor(me());
  let tab = (location.hash.replace("#/", "") || "plan").split("/")[0];
  document.querySelectorAll(".tabs a").forEach((a) =>
    a.classList.toggle("hidden", !allowed.includes(a.dataset.tab)));
  if (!allowed.includes(tab)) {
    // A stale link/bookmark to a tab this person no longer has — bounce to
    // whatever they can actually see instead of rendering a page they shouldn't.
    tab = allowed.includes("plan") ? "plan" : allowed[0];
    location.hash = `#/${tab}`;
    return;
  }
  document.querySelectorAll(".tabs a").forEach((a) =>
    a.classList.toggle("active", a.dataset.tab === tab));
  document.body.dataset.tab = tab;
  // Shopping always opens on the shop week (see shopWeekId); other pages go back to
  // the week you were on. The This/Next toggle still overrides while you're there.
  if (tab !== S.lastTab) {
    if (tab === "shopping" && S.shopViewWeekId) { S.weekBeforeShop = S.weekId; S.weekId = S.shopViewWeekId; }
    else if (S.lastTab === "shopping" && S.weekBeforeShop) { S.weekId = S.weekBeforeShop; S.weekBeforeShop = null; }
    S.lastTab = tab;
    S.showIdeas = false;
    document.querySelectorAll("#weekToggle button").forEach((b) =>
      b.classList.toggle("on", (b.dataset.which === "this" ? S.thisWeekId : S.nextWeekId) === S.weekId));
  }

  const view = {
    plan: viewPlan, meals: viewMeals,
    vote: viewVote, shopping: viewShopping, extras: viewRegulars, pricing: viewPricing, compare: viewCompare,
    rewards: viewRewards, history: viewHistory, settings: viewSettings,
  }[tab] || viewPlan;
  updateVoteFab(tab);
  return Promise.resolve()
    .then(() => (S.weeks.length ? view() : boot()))
    .catch(showError);
}

// A floating "vote now" CTA — the tab bar alone gets lost in a mobile swipe,
// so anything outstanding gets a hard-to-miss nudge instead.
async function updateVoteFab(currentTab) {
  const fab = document.getElementById("voteFab");
  // Never on Shopping: you're standing in a shop with the phone in one hand,
  // and a floating pill parked over the aisle list hides the items you're
  // trying to read. The nudge can wait until you're back on another page.
  const voteTab = document.querySelector('.tabs a[data-tab="vote"]');
  if (!fab || !S.meId || !S.votingOpen) {
    fab?.classList.add("hidden"); voteTab?.classList.remove("needs-vote"); return;
  }
  try {
    // /api/poll, not the old /api/votes — that read the superseded per-day
    // `vote` table, which nothing writes to any more, so the tally came back
    // empty forever and "have I voted?" was permanently false. The nudge
    // never went away no matter how much you'd voted.
    const { tally } = await api.get(`/api/poll?id=${S.voteWeekId}&person=${S.meId}`);
    const iHaveVoted = tally.some((t) => t.mine);
    fab.classList.toggle("hidden", iHaveVoted || !["plan", "meals"].includes(currentTab));
    voteTab?.classList.toggle("needs-vote", !iHaveVoted);
  } catch { fab.classList.add("hidden"); }
}

/* ---------------------------------------------------------------- plan */

async function viewPlan() {
  const [data, pool] = await Promise.all([
    api.get(`/api/week?id=${S.weekId}&person=${S.meId || ""}`),
    api.get(`/api/week/pool?id=${S.weekId}`),
  ]);
  S.week = data;
  if (!S.meals.length) S.meals = (await api.get(`/api/meals?person=${S.meId || ""}`)).meals;
  const parent = isParent();

  // The whole point of this page is "open it, see what I'm cooking". That
  // needs today to be findable at a glance, which means real dates and a
  // marked row — not seven identical cards you have to count through.
  S.lunchOpen = S.lunchOpen || new Set();
  S.swapOpen = S.swapOpen || new Set();
  S.changeOpen = S.changeOpen || new Set();
  const weekStart = new Date(`${data.week.start_date}T00:00:00`);
  const dateOf = (dow) => { const d = new Date(weekStart); d.setDate(d.getDate() + dow); return d; };
  const dayNum = (dow) => dateOf(dow).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  let todayDow = null;
  for (let i = 0; i < 7; i++) {
    if (dateOf(i).getTime() === midnight.getTime()) { todayDow = i; break; }
  }
  const today = todayDow === null ? null : data.days[todayDow];
  // Compared on real dates rather than dow, so an entire past week reads as
  // history — not just the days before today in the current one.
  const isPast = (dow) => dateOf(dow).getTime() < midnight.getTime();
  const pastCount = data.days.filter((d) => isPast(d.dow)).length;
  const canEdit = (dow) => parent && S.planEdit && (!isPast(dow) || S.allowHistoricEdits);

  // Colour is what makes a borderless list scannable — you find the day by
  // hue before you read a word of it. Meal type is the only categorical axis
  // this page has, so that's what the badge encodes.
  const badgeKind = (meal) => {
    if (!meal) return "none";
    if (mealHasType(meal, "takeaway")) return "takeaway";
    if (mealHasType(meal, "pudding")) return "pudding";
    if (mealHasType(meal, "light")) return "light";
    return "proper";
  };
  const dayDate = (dow) => dateOf(dow).getDate();

  const dayOpts = () => `<option value="">— pick a day —</option>` +
    data.days.filter((d) => canEdit(d.dow)).flatMap((d) => [
      d.lunch ? "" : `<option value="${d.dow}:lunch">${esc(DAYS[d.dow])} · lunch</option>`,
      d.meal ? "" : `<option value="${d.dow}:dinner">${esc(DAYS[d.dow])} · dinner</option>`,
    ]).join("");

  const swapOpts = (mine) => `<option value="">Swap with…</option>` +
    data.days.filter((d) => d.dow !== mine).map((d) =>
      `<option value="${d.dow}">${esc(DAYS[d.dow])}${d.meal ? ` (${esc(d.meal.name)})` : " (empty)"}</option>`).join("");

  // Two groups so the week's actual plan stays the obvious choice, but the rest
  // of the library is one tap away when plans change.
  const poolIds = new Set(pool.pool.map((m) => m.id));
  const poolOpts = pool.pool.length
    ? `<optgroup label="This week's list">${pool.pool
        .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</optgroup>`
    : "";
  const libraryOpts = `<optgroup label="Anything else from the library">${S.meals
    .filter((m) => !poolIds.has(m.id) && !(mealHasType(m, "kids_lunch") && !mealHasType(m, "proper") && !mealHasType(m, "light")))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</optgroup>`;
  // Same two groups an empty day gets, just with whatever's currently on the
  // day pre-selected — so opening "Change" shows where you already are,
  // rather than defaulting back to "— nothing assigned —".
  const mealChangeOpts = (currentId) =>
    `${pool.pool.length ? `<optgroup label="This week's list">${pool.pool
        .map((m) => `<option value="${m.id}" ${m.id === currentId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</optgroup>` : ""}
     <optgroup label="Anything else from the library">${S.meals
        .filter((m) => !poolIds.has(m.id) && !(mealHasType(m, "kids_lunch") && !mealHasType(m, "proper") && !mealHasType(m, "light")))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => `<option value="${m.id}" ${m.id === currentId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</optgroup>`;

  document.getElementById("view").innerHTML = `
    <header class="block-head">
      <h1>Meal Plan</h1>
      ${weekNavHTML(data.week.start_date)}
      <div class="actions">${parent ? `<button id="planEditBtn" class="plan-edit-btn ${S.planEdit ? "on" : ""}" aria-label="Edit the plan" title="Edit the plan">✏️</button>` : ""}${parent ? `<a href="#/meals/new" class="btn-link" aria-label="Add meal" title="Add meal"><span aria-hidden="true">+</span><span class="btn-label">Add meal</span></a>` : ""}</div></header>
    ${parent ? cycleStripHTML("plan") : ""}

    ${today ? `
      <div class="today-card ${today.meal ? "" : "empty"}">
        <div class="today-when">Today · ${esc(DAYS[todayDow])} ${esc(dayNum(todayDow))}</div>
        ${today.lunch ? todayLine("Lunch", today.lunch, true) : ""}
        ${today.meal ? todayLine(today.lunch ? "Dinner" : "", today.meal, !!today.lunch)
          : `<div class="today-meal none">Nothing planned yet</div>`}
      </div>` : ""}


    ${parent && pool.pool.length && !S.planEdit ? `<button class="notice small no-print" style="display:block;width:100%;text-align:left;border:none;color:var(--text);cursor:pointer" onclick="document.getElementById('planEditBtn').click()">📌 ${pool.pool.length} meal${pool.pool.length === 1 ? "" : "s"} still need a day — tap ✏️ to place ${pool.pool.length === 1 ? "it" : "them"}.</button>` : ""}
    ${parent && pool.pool.length && S.planEdit ? `
      <div class="notice attend-confirm">
        <strong>Not yet assigned to a day</strong>
        <p class="hint">Pick a day for each — cook the ones with fresher ingredients first, or whatever's quickest on a busy night.
          Any day left empty can take anything from the meal library, not just this list.</p>
        <div class="overview-days"><div class="overview-day">
          ${pool.pool.map((m) => `
            <div class="overview-row">
              <span class="ov-name">${esc(m.name)}</span>
              <select class="poolAssign" data-id="${m.id}">${dayOpts(null)}</select>
              <button class="dropMeal ghost" data-id="${m.id}" title="Not needed this week after all">Not needed →</button>
            </div>`).join("")}
        </div></div>
      </div>` : ""}

    ${pastCount && pastCount < data.days.length ? `<button id="togglePast" class="past-toggle"
        aria-expanded="${S.showPast ? "true" : "false"}">${S.showPast
          ? "▾ Hide earlier days"
          : `▸ Earlier this week (${pastCount})`}</button>` : ""}

    <ol class="timeline ${pastCount && pastCount < data.days.length && !S.showPast ? "past-hidden" : ""}">
      ${data.days.map((d) => `
        <li class="tl-day ${d.dow === todayDow ? "is-today" : ""} ${d.meal || d.lunch ? "" : "is-empty"} ${isPast(d.dow) ? "is-past" : ""}" id="day-${d.dow}">
          <span class="tl-badge" data-kind="${badgeKind(d.meal)}">${dayDate(d.dow)}</span>
          <div class="tl-body">
            <p class="tl-meta">${esc(DAYS[d.dow])}${d.dow === todayDow ? ` · <span class="tl-today">Today</span>` : ""}</p>
            ${canEdit(d.dow) ? `<div class="tl-extras tl-lunch-row">${canEdit(d.dow)
                ? (d.lunch || S.lunchOpen.has(d.dow)
                    ? `<label class="tl-ctl"><span>Lunch</span>
                     <select class="kidsLunchSelect" data-dow="${d.dow}">
                       <option value="">— none —</option>
                       ${d.lunch && !pool.kidsLunch.some((m) => m.id === d.lunch.id) ? `<option value="${d.lunch.id}" selected>${esc(d.lunch.name)}</option>` : ""}
                       <optgroup label="Lunches">${pool.kidsLunch.map((m) => `<option value="${m.id}" ${m.id === d.lunch?.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</optgroup>
                       ${poolOpts}${libraryOpts}
                     </select></label>`
                    : `<button class="addLunch ghost" data-dow="${d.dow}">+ Lunch</button>`)
                : ""}</div>` : ""}
            <div class="tl-title">
              ${canEdit(d.dow)
                ? `${d.meal
                     ? `${d.dow === todayDow
                          // Today's meal is already named and detailed in the
                          // card above — repeating it here as a second "Burgers"
                          // read as the same meal twice on one screen. Just the
                          // controls remain; the name stays only where it isn't
                          // a duplicate.
                          ? `<span class="simple-meal">Today</span>`
                          : `<button class="simple-meal meal-peek" data-id="${d.meal.id}" title="See what's in it">${esc(d.meal.name)}</button>`}
                        <span class="day-hidden"><button class="openChange" data-dow="${d.dow}"></button><button class="openSwap" data-dow="${d.dow}"></button><button class="unassign" data-dow="${d.dow}"></button></span>
                        <button class="dayMenu ghost" data-dow="${d.dow}" data-has-meal="1" data-has-lunch="${d.lunch || S.lunchOpen.has(d.dow) ? 1 : 0}" aria-label="Options for this day">⋯</button>`
                     // An empty day can take anything from the library, not just
                     // what won the poll — "we've got a pizza in the freezer" is a
                     // perfectly good plan and used to have nowhere to go.
                     : `<select class="dayMealSelect" data-dow="${d.dow}">
                          <option value="">— nothing assigned —</option>
                          ${poolOpts}
                          ${libraryOpts}
                        </select>
                        ${d.lunch || S.lunchOpen.has(d.dow) ? "" : `<button class="dayMenu ghost" data-dow="${d.dow}" data-has-meal="0" data-has-lunch="0" aria-label="Options for this day">⋯</button>`}`}`
                : `${d.lunch ? `<span class="tl-lunch">Lunch · <button class="meal-peek" data-id="${d.lunch.id}">${esc(d.lunch.name)}</button></span>` : ""}
                     ${d.meal ? `<button class="simple-meal meal-peek" data-id="${d.meal.id}" title="See what's in it">${esc(d.meal.name)}</button>` : `<span class="simple-meal none">Not decided yet</span>`}`}
            </div>
            ${canEdit(d.dow) ? `<div class="tl-extras">
              <!-- swap picker (parents, on demand), then lunch -->
              ${canEdit(d.dow) && d.meal && S.changeOpen.has(d.dow) ? `<label class="tl-ctl"><span>Change to</span>
                 <select class="changeMealSelect" data-dow="${d.dow}">${mealChangeOpts(d.meal.id)}</select></label>` : ""}
              ${canEdit(d.dow) && d.meal && S.swapOpen.has(d.dow) ? `<label class="tl-ctl"><span>Move to</span>
                 <select class="swapDaySelect" data-dow="${d.dow}">${swapOpts(d.dow)}</select></label>` : ""}

            </div>` : ""}
          </div>
        </li>`).join("")}
    </ol>

    ${parent && !pool.pool.length && data.days.some((d) => d.meal) && !(S.weeks.find((w) => w.id === S.weekId) || {}).shop_closed ? `
      <a href="#/shopping" class="plan-done-btn no-print">✅ Plan done →</a>` : ""}`;
  document.getElementById("view").insertAdjacentHTML("afterbegin", installBannerHTML());
  wireInstallBanner();

  // Toggling is a class flip, not a re-render — nothing moves except the fold.
  const togglePast = document.getElementById("togglePast");
  if (togglePast) togglePast.onclick = () => {
    S.showPast = !S.showPast;
    document.querySelector(".timeline").classList.toggle("past-hidden", !S.showPast);
    togglePast.setAttribute("aria-expanded", S.showPast ? "true" : "false");
    togglePast.textContent = S.showPast ? "▾ Hide earlier days" : `▸ Earlier this week (${pastCount})`;
  };

  document.querySelectorAll(".openSwap").forEach((b) => (b.onclick = () => {
    const dow = +b.dataset.dow;
    S.swapOpen.has(dow) ? S.swapOpen.delete(dow) : S.swapOpen.add(dow);
    viewPlan();
  }));
  document.querySelectorAll(".openChange").forEach((b) => (b.onclick = () => {
    const dow = +b.dataset.dow;
    S.changeOpen.has(dow) ? S.changeOpen.delete(dow) : S.changeOpen.add(dow);
    viewPlan();
  }));
  document.querySelectorAll(".changeMealSelect").forEach((sel) => {
    sel.onchange = busy(sel, async () => {
      if (!sel.value) return;
      await api.post("/api/week/day", {
        week_id: S.weekId, dow: +sel.dataset.dow, meal_id: +sel.value, person_id: S.meId,
      });
      // Same tidy-up as the day-swap picker: the job's done, so the picker
      // shouldn't linger open on a row that's already moved on.
      S.changeOpen.delete(+sel.dataset.dow);
      viewPlan();
    });
  });
  document.querySelectorAll(".addLunch").forEach((b) => (b.onclick = () => {
    S.lunchOpen.add(+b.dataset.dow);
    viewPlan();
  }));
  document.querySelectorAll(".dayMealSelect").forEach((sel) => {
    sel.onchange = busy(sel, async () => {
      if (!sel.value) return;
      await api.post("/api/week/day", {
        week_id: S.weekId, dow: +sel.dataset.dow, meal_id: +sel.value, person_id: S.meId,
      });
      viewPlan();
    });
  });
  document.querySelectorAll(".meal-peek").forEach((b) => (b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    mealPeek(+b.dataset.id);
  }));
  document.querySelectorAll(".poolAssign").forEach((sel) => {
    sel.onchange = busy(sel, async () => {
      if (!sel.value) return;
      const [dow, slot] = sel.value.split(":");
      await api.post("/api/week/day", {
        week_id: S.weekId, dow: +dow, person_id: S.meId,
        ...(slot === "lunch" ? { lunch_meal_id: +sel.dataset.id } : { meal_id: +sel.dataset.id }),
      });
      viewPlan();
    });
  });
  document.querySelectorAll(".dropMeal").forEach((b) => {
    b.onclick = busy(b, async () => {
      await api.post("/api/week/drop-meal", { week_id: S.weekId, meal_id: +b.dataset.id, actor_id: S.meId });
      viewPlan();
    });
  });
  const pe = document.getElementById("planEditBtn");
  if (pe) pe.onclick = () => { S.planEdit = !S.planEdit; viewPlan(); };
  document.querySelectorAll(".today-det").forEach((d) => (d.ontoggle = () => {
    try { localStorage.setItem("mealplan-today-open", d.open ? "1" : "0"); } catch { /* ignore */ }
  }));
  document.querySelectorAll(".dayMenu").forEach((b) => (b.onclick = () => {
    const dow = b.dataset.dow, meal = b.dataset.hasMeal === "1", lunch = b.dataset.hasLunch === "1";
    const opts = [
      meal && ["openChange", "🔁 Change meal"],
      meal && ["openSwap", "⇅ Move to another day"],
      !lunch && ["addLunch", "🥪 Add a lunch"],
      meal && ["unassign", "✕ Clear this day"],
    ].filter(Boolean);
    openModal(DAYS[+dow], `<div class="action-sheet">${opts.map(([cls, label]) =>
      `<button class="sheetBtn ${cls === "unassign" ? "danger-text" : ""}" data-cls="${cls}">${label}</button>`).join("")}</div>`);
    document.querySelectorAll(".sheetBtn").forEach((s) => (s.onclick = () => {
      closeModal();
      document.querySelector(`.${s.dataset.cls}[data-dow="${dow}"]`)?.click();
    }));
  }));
  document.querySelectorAll(".unassign").forEach((b) => {
    b.onclick = busy(b, async () => {
      await api.post("/api/week/day", { week_id: S.weekId, dow: +b.dataset.dow, meal_id: null, person_id: S.meId });
      viewPlan();
    });
  });
  // Swaps this day's dinner with another day's — covers both real cases:
  // "don't fancy Wednesday's, swap it for Thursday's" (two meals trade places)
  // and "the chicken expires before Friday, bring it forward" (an empty day
  // and a full one trade just as well — the empty side just goes empty the
  // other way). Lunch is untouched; it belongs to the day, not the dinner.
  document.querySelectorAll(".swapDaySelect").forEach((sel) => {
    sel.onchange = busy(sel, async () => {
      if (!sel.value) return;
      try {
        await api.post("/api/week/swap-days", {
          week_id: S.weekId, dow_a: +sel.dataset.dow, dow_b: +sel.value, actor_id: S.meId,
        });
      } catch (err) { toast(err.message, "bad"); }
      // The move is done — collapse the picker again rather than leaving it
      // hanging open on a row whose meal has already gone somewhere else.
      S.swapOpen.delete(+sel.dataset.dow);
      viewPlan();
    });
  });
  document.querySelectorAll(".kidsLunchSelect").forEach((sel) => {
    sel.onchange = busy(sel, async () => {
      await api.post("/api/week/day", {
        week_id: S.weekId, dow: +sel.dataset.dow,
        lunch_meal_id: sel.value ? +sel.value : null, person_id: S.meId,
      });
      viewPlan();
    });
  });
}

// Read-only "what's actually in this?" glance from the Plan page — the common
// question is "what do I need to get out of the freezer", not "let me edit it".
// Straight into the Today card, no tap needed — the whole point of opening
// this page is usually "what do I need out for tonight", and making that a
// second step (peek modal) was exactly the friction being removed here.
// One meal on the Today card: name on its own line, ingredients folded
// behind an arrow (remembered open/closed on this phone). No arrow when
// there's nothing to list, e.g. a takeaway.
function todayLine(label, meal, inline) {
  const ings = todayIngredientsHTML(meal.id, true);
  const head = label ? `<span class="today-lunch">${esc(label)} · <span class="today-name">${esc(meal.name)}</span></span>`
                     : `<span class="today-meal">${esc(meal.name)}</span>`;
  if (!ings) return `<div class="today-line">${head}</div>`;
  let open = false;
  try { open = localStorage.getItem("mealplan-today-open") === "1"; } catch { /* ignore */ }
  return `<details class="today-det" ${open ? "open" : ""}><summary class="today-line">${head}<span class="today-arrow" aria-hidden="true">▾</span></summary>${ings}</details>`;
}

function todayIngredientsHTML(mealId, sub = false) {
  const m = S.meals.find((x) => x.id === mealId);
  const ings = m?.ingredients || [];
  // Lunch is the secondary meal on the card — if it has nothing recorded, say
  // nothing rather than repeating an empty-state under the dinner's list.
  if (!ings.length) return "";
  return `<ul class="today-ings${sub ? " sub" : ""}">${ings.map((i) =>
    `<li><span class="pk-qty">${esc(fmtIng(i))}</span><span>${esc(i.item)}</span></li>`).join("")}</ul>`;
}

// Deliberately separate from the weekly poll's vote tally, which shows who
// voted for what on purpose. This is the opposite: a lasting "is this
// generally a hit" score that nobody has to worry reads as a personal
// verdict on whoever cooked it — the server only ever returns the aggregate
// and your own pick, never anyone else's. Reused on the Meals card and here.
const mealRatingHTML = (m) => `
  <div class="meal-rating" data-id="${m.id}">
    <span class="rating-avg">${m.rating_count ? `★ ${m.rating_avg} <span class="hint" style="display:inline">(${m.rating_count})</span>` : `<span class="hint">Not rated yet</span>`}</span>
    <span class="rating-picker" title="Rate it — anonymous, nobody sees who gave what">
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star-btn ${(m.my_rating || 0) >= n ? "on" : ""}" data-stars="${n}" aria-label="Rate ${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}
    </span>
  </div>`;

const wireMealRating = (container, mealId, onRated) => {
  container.querySelectorAll(".star-btn").forEach((b) => (b.onclick = busy(b, async () => {
    if (!S.meId) return toast("Pick who you are first (top right).", "bad");
    const res = await api.post("/api/meal/rate", { meal_id: mealId, person_id: S.meId, stars: +b.dataset.stars });
    if (res.error) return toast(res.error, "bad");
    const m = S.meals.find((x) => x.id === mealId);
    if (m) { m.rating_avg = res.rating_avg; m.rating_count = res.rating_count; m.my_rating = +b.dataset.stars; }
    onRated();
  })));
};

function mealPeek(mealId) {
  const m = S.meals.find((x) => x.id === mealId);
  if (!m) return;
  const ings = m.ingredients || [];
  openModal(m.name, `
    ${(m.tags || "").split(",").filter(Boolean)
      .map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
    ${m.note ? `<p class="hint" style="margin:8px 0 0">${esc(m.note)}</p>` : ""}
    ${mealRatingHTML(m)}
    <h4>Ingredients</h4>
    ${ings.length ? `<ul class="peek-ings">${ings.map((i) => `
      <li><span class="pk-qty">${esc(fmtIng(i))}</span><span>${esc(i.item)}</span></li>`).join("")}</ul>`
      : `<p class="empty">No ingredients recorded yet.</p>`}
    ${isParent() ? `<div class="modal-actions"><button id="peekEdit" class="primary">Edit this meal</button></div>` : ""}
  `);
  wireMealRating(document.getElementById("modalBody"), mealId, () => mealPeek(mealId));
  const edit = document.getElementById("peekEdit");
  if (edit) edit.onclick = () => mealEditor(m);
}

// Mirrors the server's fmt_qty so the peek reads the same as the shopping list.
function fmtIng(i) {
  const a = i.amount, u = i.unit;
  if (u === "g") return a >= 1000 ? `${a / 1000}kg` : `${a}g`;
  if (u === "ml") return a >= 1000 ? `${a / 1000}L` : `${a}ml`;
  const n = Math.ceil(a - 1e-9);
  if (u === "unit") return `× ${n}`;
  const plurals = { loaf: "loaves", bunch: "bunches", box: "boxes" };
  return n === 1 ? `${n} ${u}` : `${n} ${plurals[u] || u + "s"}`;
}

/* ---------------------------------------------------------------- shopping */

// Fixes the exact "Mozzerella" vs "Mozerella" problem — two extras that are
// really the same thing but don't merge because the text doesn't match
// exactly. Renaming one to match the other here folds them back together
// the next time the shopping list is built (aggregation is by exact name).
function extraEditor(extra) {
  const personOpts = `<option value="">Everyone</option>` +
    S.people.map((p) => `<option value="${p.id}" ${p.id === extra.person_id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const aisleOpts = S.aisles.map((a) => `<option ${a === extra.aisle ? "selected" : ""}>${esc(a)}</option>`).join("");
  openModal("Edit item", `
    <label class="field"><span>Item</span><input id="exEditItem" value="${esc(extra.item)}"></label>
    <div class="add-extra">
      <label class="mini"><span>How many</span>
        <input id="exEditAmt" type="number" value="${extra.amount}" min="0" step="1" style="max-width:76px"></label>
      <label class="mini"><span>Sold as</span>
        <select id="exEditUnit">
          ${["unit", "pack", "bottle", "g"].map((u) => `<option ${u === extra.unit ? "selected" : ""}>${u}</option>`).join("")}
        </select></label>
      <label class="mini"><span>Aisle in shop</span>
        <select id="exEditAisle">${aisleOpts}</select></label>
      <label class="inline"><input type="checkbox" id="exEditRec" ${extra.recurring ? "checked" : ""}> every week</label>
      <label class="field"><span>Pick one of (optional, comma-separated)</span>
        <input id="exEditOpts" value="${esc(extra.options || "")}" placeholder="e.g. Aubree: crêpes, Ethan: cereal"></label>
      <label class="inline"><input type="checkbox" id="exEditAdult" ${extra.adults_only ? "checked" : ""}> grown-ups only (kids won't see it)</label>
    </div>
    <div class="modal-actions"><button id="exEditDel" class="ghost danger-text">Delete forever</button><button id="exEditSave" class="primary">Save</button></div>
  `);
  const exEditDel = document.getElementById("exEditDel");
  exEditDel.onclick = busy(exEditDel, async () => {
    if (!(await confirmDialog("Delete this forever from your household list? (Use − instead if you just don't want it this week.)",
        { danger: true, okLabel: "Delete forever" }))) return;
    const res = await api.post("/api/extra/delete", { id: extra.id, actor_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    closeModal(); viewRegulars();
  });
  const exEditSaveBtn = document.getElementById("exEditSave");
  exEditSaveBtn.onclick = busy(exEditSaveBtn, async () => {
    const item = document.getElementById("exEditItem").value.trim();
    if (!item) return toast("Needs a name.", "bad");
    await api.post("/api/extra", {
      id: extra.id, item,
      amount: +document.getElementById("exEditAmt").value,
      unit: document.getElementById("exEditUnit").value,
      aisle: document.getElementById("exEditAisle").value,
      person_id: null,
      recurring: document.getElementById("exEditRec").checked ? 1 : 0,
      adults_only: document.getElementById("exEditAdult").checked ? 1 : 0,
      options: document.getElementById("exEditOpts").value,
    });
    closeModal();
    viewRegulars();
  });
}

const priceText = (lo, hi) => lo == null ? "" : `£${lo.toFixed(2)}${hi > lo ? `–${hi.toFixed(2)}` : ""}`;

// Cupboard check: what the shop is now estimated at, and what the ticked items are saving.
function pantrySummaryHTML(groups) {
  let low = 0, high = 0, saveLow = 0, saveHigh = 0, ticked = 0, unpriced = 0;
  groups.forEach((g) => g.items.forEach((i) => {
    if (i.pantryChecked) ticked++;
    if (i.priceLow == null) { if (!i.pantryChecked) unpriced++; return; }
    if (i.pantryChecked) { saveLow += i.priceLow; saveHigh += i.priceHigh; } else { low += i.priceLow; high += i.priceHigh; }
  }));
  const range = (a, b) => `£${a.toFixed(2)}${b - a >= 0.005 ? `–£${b.toFixed(2)}` : ""}`;
  return `💷 To buy ≈ <strong>${range(low, high)}</strong>${unpriced ? ` <span class="hint" style="display:inline">(${unpriced} not priced)</span>` : ""}
    · 🧺 From the cupboard saves <strong>${range(saveLow, saveHigh)}</strong> <span class="hint" style="display:inline">(${ticked} ticked)</span>`;
}

async function viewShopping() {
  if (!S.stores) S.stores = (await api.get("/api/stores")).stores;
  if (!S.storeId || !S.stores.some((s) => s.id === S.storeId)) {
    S.storeId = +(localStorage.getItem("mealplan-store") || 0) || S.stores[0]?.id || null;
  }
  // Supermarket signal is patchy: keep the last good list on the phone and
  // show it (with any unsynced ticks applied) when the server can't be reached.
  const cacheKey = `mealplan-shopcache-${S.weekId}-${S.storeId || 0}`;
  let shopData, offline = false;
  try {
    shopData = await Promise.all([
      api.get(`/api/shopping?id=${S.weekId}${S.storeId ? `&store_id=${S.storeId}` : ""}`),
      api.get(`/api/extras?week_id=${S.weekId}`),
    ]);
    lsSet(cacheKey, shopData);
  } catch (err) {
    shopData = lsGet(cacheKey);
    if (!shopData) throw err;
    offline = true;
  }
  const pend = pendingTicks().filter((t) => t.week_id === S.weekId);
  shopData[0].groups.forEach((g) => g.items.forEach((i) => {
    const p = pend.find((t) => t.item === i.key);
    if (p) i.checked = !!p.checked;
  }));
  const [{ groups: rawGroups, phase, estimate }, { extras, requests }] = shopData;
  if (!S.meals.length) S.meals = (await api.get(`/api/meals?person=${S.meId || ""}`)).meals;
  const parent = isParent();

  // The cupboard-check phase is deliberately its own small screen, not a mode
  // bolted onto the full shopping page — a focused "what have we already
  // got" pass with nothing else competing for attention. Nothing here is
  // ever hidden or moved: that's the whole point, it's what the trolley
  // split doesn't give you. Stays open until someone taps "Heading out" —
  // no auto-advance, no timeout, revisit it as many times as you like.
  if (phase === "pantry") {
    const groups = rawGroups;
    const hue = (name) => {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
      return h;
    };
    document.getElementById("view").innerHTML = `
      <header class="block-head">
        <h1>🧺 Cupboard check</h1>
        ${weekNavHTML(S.weeks.find((w) => w.id === S.weekId)?.start_date || "")}</header>
      ${cycleStripHTML("shop")}
      <div class="notice good no-print pantry-intro">
        <strong>Step 1 of 2 — before you go.</strong><br>
        Tick everything you've <strong>already got</strong> at home. Ticked items come off the shopping list.
        Come back to this any time before you go.
        <button id="headingOutBtn" class="ghost">✓ Heading to the shop →</button>
      </div>
      <div class="notice small shop-estimate" id="pantrySummary"></div>
      <div class="card">
        ${groups.map((g) => `
          <div class="aisle" style="--dot:hsl(${hue(g.aisle)} 52% 58%)">
            <h3><span class="aisle-dot"></span>${esc(g.aisle)}</h3>
            <div class="aisle-items">${g.items.map((i) => `
              <label class="row shop-row" data-key="${esc(i.key)}">
                <input type="checkbox" class="pantryCb" data-item="${esc(i.key)}" ${i.pantryChecked ? "checked" : ""}>
                <span class="qty">${esc(i.qty)}</span>
                <span class="shop-item"><span class="shop-name">${esc(i.item)}${i.options ? ` <span class="hint" style="display:inline">(${i.options.map(esc).join(" / ")})</span>` : ""}</span>
                  <span class="pantry-parts">${i.parts.map((x) => `<span class="part ${x.kind}">${x.kind === "meal" ? `🍽 ${esc(x.name)}` : `➕ Extra${x.name === "everyone" ? "" : ` (${esc(x.name)})`}`} <b>${esc(x.qty)}</b></span>`).join("")}</span></span>
                <span class="pantry-price">${priceText(i.priceLow, i.priceHigh)}</span>
              </label>`).join("")}</div>
          </div>`).join("")}
      </div>`;
    const showSavings = () => { document.getElementById("pantrySummary").innerHTML = pantrySummaryHTML(groups); };
    showSavings();
    document.querySelectorAll(".pantryCb").forEach((cb) => (cb.onchange = busy(cb, async () => {
      groups.forEach((g) => g.items.forEach((i) => { if (i.key === cb.dataset.item) i.pantryChecked = cb.checked; }));
      showSavings();
      await api.post("/api/pantry-tick", { week_id: S.weekId, item: cb.dataset.item, checked: cb.checked ? 1 : 0 });
    })));
    const headingOut = document.getElementById("headingOutBtn");
    if (headingOut) headingOut.onclick = busy(headingOut, async () => {
      await api.post("/api/week/shopping-phase", { week_id: S.weekId, phase: "shopping" });
      viewShopping();
    });
    return;
  }
  // Settled in the cupboard check — not needed, shouldn't clutter the
  // in-store list. Filtered here so shopping-phase's remaining/trolley split
  // below never has to know pantry-check exists at all.
  const groups = rawGroups.map((g) => ({ ...g, items: g.items.filter((i) => !i.pantryChecked) }))
                 .filter((g) => g.items.length);

  // Whole-row tap target, and a name that doubles as content — kept out of the
  // template literal below since both the aisle list and the trolley list need
  // an identical row shape. showAisle only applies in the trolley: it's a flat
  // list mixing every aisle together, so the item alone isn't always enough
  // context to recognise it at a glance; inside its own aisle section the
  // heading already says that, so it would just be noise there.
  const shopRow = (i, aisle, showAisle) => {
    const meta = [
      ...i.tags.filter((t) => t !== "everyone").map((t) => `<span class="tag ${t === "protein" ? "tag-protein" : ""}">${esc(t)}</span>`),
      i.note ? `<span class="hint">${esc(i.note)}</span>` : "",
      i.meals.length ? `<span class="shop-source-inline">${i.meals.map((m) => parent
        ? `<button class="shop-source-btn" data-id="${m.id}">${esc(m.name)}</button>`
        : esc(m.name)).join(", ")}</span>` : "",
      showAisle ? `<span class="aisle-tag">${esc(aisle)}</span>` : "",
    ].filter(Boolean).join("");
    return `
    <label class="row shop-row" data-aisle="${esc(aisle)}" data-key="${esc(i.key)}">
      <input type="checkbox" data-item="${esc(i.key)}" ${i.checked ? "checked" : ""}>
      <span class="qty">${esc(i.qty)}</span>
      <span class="shop-item">
        <span class="shop-name">${esc(i.item)}${i.options ? ` <span class="hint" style="display:inline">(${i.options.map(esc).join(" / ")})</span>` : ""}</span>${i.priceLow != null ? `<span class="shop-price">£${i.priceLow.toFixed(2)}${i.priceHigh > i.priceLow ? `–${i.priceHigh.toFixed(2)}` : ""}</span>` : ""}
        ${meta ? `<span class="shop-meta">${meta}</span>` : ""}
      </span>
    </label>`;
  };

  const aisleHue = (name) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  };

  const inTrolleyOnLoad = [];
  // Whether anything is still to be found, as opposed to whether the markup
  // string is non-empty — every aisle can render and still leave nothing to
  // buy, which used to show an empty card instead of "that's the lot".
  const anyRemaining = groups.some((g) => g.items.some((i) => !i.checked));
  const list = groups.map((g) => {
    const remaining = g.items.filter((i) => !i.checked);
    g.items.filter((i) => i.checked).forEach((i) => inTrolleyOnLoad.push({ ...i, aisle: g.aisle }));
    return `
    <div class="aisle ${remaining.length ? "" : "aisle-empty"}" data-aisle="${esc(g.aisle)}"
         style="--dot:hsl(${aisleHue(g.aisle)} 52% 58%)">
      <h3><span class="drag-handle">⠿</span><span class="aisle-dot"></span>${esc(g.aisle)}</h3>
      <div class="aisle-items">${remaining.map((i) => shopRow(i, g.aisle, false)).join("")}</div>
    </div>`;
  }).join("");

  const trolleyListHtml = inTrolleyOnLoad
    .map((i) => `<div class="trolley-item" data-aisle="${esc(i.aisle)}">${shopRow(i, i.aisle, true)}</div>`).join("");

  const personOpts = `<option value="">Everyone</option>` +
    S.people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const aisleOpts = S.aisles.map((a) => `<option ${a === "Household" ? "selected" : ""}>${esc(a)}</option>`).join("");

  document.getElementById("view").innerHTML = `
    <header class="block-head">
      <h1>🛒 Shopping List</h1>
      ${weekNavHTML(S.weeks.find((w) => w.id === S.weekId)?.start_date || "")}
      <div class="actions no-print">
        <button id="copyBtn" class="desktop-only" aria-label="Copy list" title="Copy list"><span aria-hidden="true">📋</span><span class="btn-label">Copy</span></button>
        ${navigator.share ? `<button id="shareBtn" aria-label="Export list" title="Export list"><span aria-hidden="true">📤</span><span class="btn-label">Export…</span></button>` : ""}
        <button onclick="window.print()" class="desktop-only" aria-label="Print list" title="Print list"><span aria-hidden="true">🖨️</span><span class="btn-label">Print</span></button>
      </div></header>
    ${cycleStripHTML("shop")}
    ${offline ? `<div class="notice small warn no-print">📶 No connection — showing the list saved on this phone. Ticks are kept and sync when you're back online.</div>` : ""}
    ${(() => {
      const av = shopAverage(), has = estimate && estimate.high > 0;
      if (!av && !has) return "";
      const parts = [];
      if (av) parts.push(`Usual shop <strong>£${Math.round(av.avg)}</strong>`);
      if (has) parts.push(`this list ≈ <strong>£${Math.round(estimate.low)}${Math.round(estimate.high) > Math.round(estimate.low) ? `–£${Math.round(estimate.high)}` : ""}</strong>${estimate.unpriced.length ? ` <span class="hint" style="display:inline">(${estimate.unpriced.length} not priced)</span>` : ""}`);
      return `<div class="notice small shop-estimate">💷 ${parts.join(" · ")}</div>`;
    })()}

    ${(S.weeks.find((w) => w.id === S.weekId) || {}).shop_closed ? "" : `<button id="backToPantryBtn" class="link-toggle no-print" style="margin-bottom:8px">← Back to cupboard check</button>`}
    ${(S.weeks.find((w) => w.id === S.weekId) || {}).shop_closed
      ? (parent ? `<button id="shopCloseBtn" data-closed="0" class="shop-done-btn no-print">🔒 Shopping done — Reopen?</button>
          <button id="scanReceiptBtn" class="plan-done-btn no-print" style="position:static">🧾 Scan receipt</button>
          <div id="receiptSummary" class="notice small receipt-summary" hidden></div>
          ${(() => { const w = S.weeks.find((x) => x.id === S.weekId) || {}; const av = shopAverage();
            return `<button id="shopTotalBtn" class="notice small no-print shop-total-line">${w.shop_total != null
              ? `💷 Spent <strong>£${w.shop_total.toFixed(2)}</strong>${av ? ` · average £${av.avg.toFixed(2)} over ${av.n} shop${av.n === 1 ? "" : "s"}` : ""} <span class="hint" style="display:inline">· edit</span>`
              : `💷 Add what this shop cost →`}</button>`; })()}`
                : `<div class="notice small good no-print">🔒 <strong>Shopping done</strong></div>`)
      : `<button id="shopCloseBtn" data-closed="1" class="primary no-print" style="margin:0 0 10px 8px">✅ Done — lock list</button>`}


    ${S.stores.length > 1 ? `<div class="notice small no-print">
        Shopping at <select id="storeSel">${S.stores.map((s) => `<option value="${s.id}" ${s.id === S.storeId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>` : ""}

    ${parent && requests.length ? `
    <section class="block no-print">
      <h2 class="sec-title">⏳ ${requests.length} request${requests.length === 1 ? "" : "s"} waiting for your OK</h2>
      <p class="subtitle">Approve to add to the list.</p>
      <div class="card pad">
        ${requests.map((r) => `
          <div class="row redemption-row">
            <span class="row-label">${esc(r.person)} wants <strong>${esc(r.item)}</strong>
              <span class="when">${r.amount} ${esc(r.unit)} · ${esc(r.aisle)}</span></span>
            <button class="reqApprove" data-id="${r.id}">Approve</button>
            <button class="reqDeny ghost" data-id="${r.id}">Deny</button>
          </div>`).join("")}
      </div>
    </section>` : ""}




    <div class="card ${anyRemaining ? "" : "hidden"}" id="aisleList">${list}</div>
    <div class="all-done ${!anyRemaining && inTrolleyOnLoad.length ? "" : "hidden"}" id="allDone">
      <span class="all-done-tick">✓</span>
      <p><strong>That's the lot.</strong> Everything on this week's list is in the trolley.</p>
    </div>

    <div class="card trolley-card ${inTrolleyOnLoad.length ? "" : "hidden"}" id="trolleyCard">
      <h3 class="trolley-heading">🛒 In trolley <span id="trolleyCount">${inTrolleyOnLoad.length}</span></h3>
      <p class="hint" style="margin:0 0 6px">Tap to put something back on the list.</p>
      <div id="trolleyList">${trolleyListHtml}</div>
    </div>`;

  // Ticking strikes the item through straight away (instant feedback, easy to
  // spot a slipped tap) but only actually leaves the visible list after a
  // pause, and the pause is cancelled by unticking — a couple of seconds is
  // enough to catch "wrong item" without the list visibly jumping under your
  // thumb while you're still deciding. Whatever's already ticked from a
  // previous visit starts collapsed in the trolley on load; only a live tap
  // gets the delay-then-fade treatment.
  const DEMOTE_DELAY_MS = 1800;
  S.trolleyTimers = S.trolleyTimers || new Map();

  const trolleyCard = document.getElementById("trolleyCard");
  const trolleyListEl = document.getElementById("trolleyList");
  const trolleyCountEl = document.getElementById("trolleyCount");
  const aisleListEl = document.getElementById("aisleList");
  const allDoneEl = document.getElementById("allDone");
  const refreshRemaining = () => {
    const left = document.querySelectorAll("#aisleList .shop-row").length;
    aisleListEl.classList.toggle("hidden", left === 0);
    allDoneEl.classList.toggle("hidden", left > 0 || trolleyListEl.children.length === 0);
  };

  const refreshTrolleyVisibility = () => {
    const n = trolleyListEl.children.length;
    trolleyCountEl.textContent = n;
    trolleyCard.classList.toggle("hidden", n === 0);
  };

  function demoteToTrolley(row) {
    const key = row.dataset.key;
    S.trolleyTimers.delete(key);
    if (!row.querySelector("input[type=checkbox]").checked) return; // unticked during the delay
    row.classList.add("row-leaving");
    setTimeout(() => {
      const wrap = document.createElement("div");
      wrap.className = "trolley-item";
      wrap.dataset.aisle = row.dataset.aisle;
      row.classList.remove("row-leaving");
      wrap.appendChild(row);
      trolleyListEl.appendChild(wrap);
      // Start transparent, then let the next frame transition it to visible —
      // a plain class-add-on-append doesn't animate because there's nothing
      // to transition FROM in the same paint.
      wrap.classList.add("row-entering");
      requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.remove("row-entering")));
      refreshTrolleyVisibility();
      const aisleBlock = document.querySelector(`.aisle[data-aisle="${CSS.escape(row.dataset.aisle)}"]`);
      if (aisleBlock && !aisleBlock.querySelector(".aisle-items").children.length) {
        aisleBlock.classList.add("aisle-empty");
      }
      refreshRemaining();
    }, 280); // matches --row-fade in style.css
  }

  function promoteFromTrolley(row) {
    const wrap = row.closest(".trolley-item");
    const aisle = row.dataset.aisle;
    const aisleBlock = document.querySelector(`.aisle[data-aisle="${CSS.escape(aisle)}"]`);
    const itemsEl = aisleBlock?.querySelector(".aisle-items");
    if (!itemsEl) { wrap?.remove(); refreshTrolleyVisibility(); refreshRemaining(); return; }
    aisleBlock.classList.remove("aisle-empty");
    // The trolley is a flat mixed-aisle list so its rows carry an aisle tag;
    // back under its own aisle heading that's just saying the same thing twice.
    row.querySelector(".aisle-tag")?.remove();
    const name = row.querySelector(".shop-item").textContent.trim().toLowerCase();
    const after = [...itemsEl.children].find((r) =>
      r.querySelector(".shop-item").textContent.trim().toLowerCase() > name);
    row.classList.add("row-entering");
    if (after) itemsEl.insertBefore(row, after); else itemsEl.appendChild(row);
    requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove("row-entering")));
    wrap?.remove();
    refreshTrolleyVisibility();
    refreshRemaining();
  }

  document.querySelectorAll(".shop-row input").forEach((cb) => {
    // Fire-and-forget used to mean an offline tick looked saved and wasn't:
    // the box stayed ticked, the POST failed silently, and the whole lot came
    // back unticked on the next load. Put the box back and say so instead.
    cb.onchange = async (ev) => {
      const box = ev.target;
      const row = box.closest(".shop-row");
      const key = row.dataset.key;
      const wanted = box.checked;
      try {
        await api.post("/api/shop-tick", {
          week_id: S.weekId, item: box.dataset.item, checked: wanted,
        });
      } catch (err) {
        queueTick({ week_id: S.weekId, item: box.dataset.item, checked: wanted });
        toast("No signal — tick saved on this phone, it'll sync later.", "good");
      }
      if (wanted) {
        const timer = setTimeout(() => demoteToTrolley(row), DEMOTE_DELAY_MS);
        S.trolleyTimers.set(key, timer);
      } else if (S.trolleyTimers.has(key)) {
        clearTimeout(S.trolleyTimers.get(key));
        S.trolleyTimers.delete(key); // caught before it left — nothing else to undo
      } else if (row.closest(".trolley-item")) {
        promoteFromTrolley(row);
      }
    };
  });
  document.querySelectorAll(".shop-source-btn").forEach((b) => {
    b.onclick = (ev) => {
      ev.preventDefault(); // inside a checkbox <label> — don't toggle the tick
      ev.stopPropagation();
      const meal = S.meals.find((m) => m.id === +b.dataset.id);
      if (meal) mealEditor(meal);
    };
  });
  document.querySelectorAll(".reqApprove").forEach((b) => (b.onclick = busy(b, async () => {
    const res = await api.post("/api/extra-request/resolve", { id: +b.dataset.id, decision: "approve", resolver_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    viewShopping();
  })));
  document.querySelectorAll(".reqDeny").forEach((b) => (b.onclick = busy(b, async () => {
    const res = await api.post("/api/extra-request/resolve", { id: +b.dataset.id, decision: "deny", resolver_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    viewShopping();
  })));
  const shoppingText = () => groups.map((g) =>
    g.aisle.toUpperCase() + "\n" + g.items.map((i) => `  ${i.qty}  ${i.item}`).join("\n")).join("\n\n");

  const scanBtn = document.getElementById("scanReceiptBtn");
  if (scanBtn) scanBtn.onclick = () => receiptFlow();
  const rs = document.getElementById("receiptSummary");
  if (rs) api.post("/api/receipt/summary", { week_id: S.weekId }).then(({ summary }) => {
    if (!summary) return;
    const b = summary.by, f = (k) => (b[k] ? `£${b[k].toFixed(2)}` : "£0");
    const LABEL = { meal: "🍽️ Meals", extra: "🛒 Extras", treat: "🍭 Treats", oneoff: "↩️ One-offs" };
    const ofKind = (k) => summary.lines.filter((l) => l.kind === k || (k === "extra" && l.kind === "regular"));
    rs.innerHTML = `🧾 ${["meal", "extra", "treat", "oneoff"].filter((k) => k !== "oneoff" || b.oneoff).map((k) =>
      `<button class="rcKind" data-k="${k}">${LABEL[k]} £${ofKind(k).reduce((s, l) => s + l.amount, 0).toFixed(2)}</button>`).join(" ")}`;
    rs.hidden = false;
    rs.querySelectorAll(".rcKind").forEach((btn) => (btn.onclick = () => {
      const k = btn.dataset.k, ls = ofKind(k);
      openModal(`${LABEL[k]} · £${ls.reduce((s, l) => s + l.amount, 0).toFixed(2)}`, ls.length
        ? `<div class="rc-lines">${ls.map((l) => `<div class="rc-line"><span class="rc-name">${l.qty > 1 ? `${l.qty} × ` : ""}${esc(l.item_key || l.text)}${
            l.item_key && l.item_key.toUpperCase() !== l.text ? ` <span class="hint" style="display:inline">(${esc(l.text)})</span>` : ""}</span>
            <span class="rc-amt">£${l.amount.toFixed(2)}</span></div>`).join("")}</div>`
        : `<p class="empty">Nothing in this group.</p>`);
    }));
  }).catch(() => {});
  const shopTotalBtn = document.getElementById("shopTotalBtn");
  if (shopTotalBtn) shopTotalBtn.onclick = busy(shopTotalBtn, async () => {
    const w = S.weeks.find((x) => x.id === S.weekId) || {};
    if (await askShopTotal(S.weekId, w.shop_total)) await boot();
  });
  const shopClose = document.getElementById("shopCloseBtn");
  if (shopClose) shopClose.onclick = busy(shopClose, async () => {
    const closing = shopClose.dataset.closed === "1";
    if (closing && !(await confirmDialog("Lock this week's list? Nobody will be able to add extras to it after this.",
        { title: "Shopping done?", okLabel: "Lock it" }))) return;
    await api.post("/api/week/shop-close", { week_id: S.weekId, closed: closing ? 1 : 0, actor_id: me()?.id });
    if (closing) await askShopTotal(S.weekId);
    await boot();
  });
  const backToPantry = document.getElementById("backToPantryBtn");
  if (backToPantry) backToPantry.onclick = busy(backToPantry, async () => {
    await api.post("/api/week/shopping-phase", { week_id: S.weekId, phase: "pantry" });
    viewShopping();
  });

  const copyBtn = document.getElementById("copyBtn");
  copyBtn.onclick = busy(copyBtn, async () => {
    const label = copyBtn.querySelector(".btn-label");
    const ok = await copyText(shoppingText());
    if (!ok) return toast("Couldn't copy — use Print or Export instead.", "bad");
    if (label) { label.textContent = "Copied"; setTimeout(() => (label.textContent = "Copy"), 1500); }
    else toast("Copied", "good");
  });
  const shareBtn = document.getElementById("shareBtn");
  if (shareBtn) shareBtn.onclick = busy(shareBtn, () => navigator.share({
    title: "Shopping list", text: shoppingText(),
  }).catch(() => {}));

  // Pointer Events, not HTML5 drag-and-drop — the old dragstart/dragover
  // implementation only ever fires from a mouse. iOS Safari and Android
  // Chrome don't send those events for a touch at all, no polyfill in place,
  // so "drag a section heading to reorder" quietly did nothing on a phone —
  // exactly the device this page is mostly used on. Pointer Events unify
  // mouse and touch into one event stream and fire correctly on both.
  {
    const container = document.getElementById("aisleList");
    let dragEl = null;

    const reorderUnderPointer = (ev) => {
      if (!dragEl) return;
      const siblings = [...container.querySelectorAll(".aisle")].filter((b) => b !== dragEl);
      for (const b of siblings) {
        const r = b.getBoundingClientRect();
        if (ev.clientY < r.top || ev.clientY > r.bottom) continue;
        const before = ev.clientY < r.top + r.height / 2;
        container.insertBefore(dragEl, before ? b : b.nextSibling);
        break;
      }
    };

    const endDrag = async (ev) => {
      if (!dragEl) return;
      dragEl.classList.remove("dragging");
      try { dragEl.releasePointerCapture(ev.pointerId); } catch (err) { /* already released */ }
      const el = dragEl;
      dragEl = null;
      document.removeEventListener("pointermove", reorderUnderPointer);
      document.removeEventListener("pointerup", endDrag);
      document.removeEventListener("pointercancel", endDrag);
      const order = [...container.querySelectorAll(".aisle")].map((b) => b.dataset.aisle);
      try {
        await api.post("/api/store/aisles/reorder", { store_id: S.storeId, actor_id: S.meId, order });
      } catch (err) { toast(OFFLINE_MSG, "bad"); }
    };

    container.querySelectorAll(".drag-handle").forEach((handle) => {
      handle.addEventListener("pointerdown", (ev) => {
        dragEl = handle.closest(".aisle");
        dragEl.classList.add("dragging");
        try { handle.setPointerCapture(ev.pointerId); } catch (err) { /* Safari <13 falls back to plain listeners */ }
        document.addEventListener("pointermove", reorderUnderPointer);
        document.addEventListener("pointerup", endDrag);
        document.addEventListener("pointercancel", endDrag);
      });
    });
  }

  const storeSel = document.getElementById("storeSel");
  if (storeSel) storeSel.onchange = busy(storeSel, () => {
    S.storeId = +storeSel.value;
    localStorage.setItem("mealplan-store", S.storeId);
    return viewShopping();
  });

}

/* --------------------------------------------------- regulars (usual items) */

// Split out of the Shopping page. Two reasons, and the second is the one that
// actually bites: (1) it's the "build next week's list" job, which happens
// before you set off, whereas Shopping is the "walk round ticking things off"
// job — different moments; (2) it sat BELOW the aisle list, so tapping + added
// the item to the list above it and shoved the whole section down ~167px,
// moving the next row out from under your finger mid-tap. On its own page
// there's no list above it to grow.
/* ---------------------------------------------- add an extra (shared) ---- */
// Lives on the Extras page. Adding something is nearly always just a name —
// one of milk, in the aisle the app already knows — so the other five fields
// wait behind a disclosure rather than fronting a five-field form every time
// someone remembers they need bin bags.
function addExtraHTML() {
  const aisleOpts = S.aisles.map((a) => `<option ${a === "Household" ? "selected" : ""}>${esc(a)}</option>`).join("");
  return `
    <div class="pk-wrap"><input id="exItem" class="big-input" placeholder="What do you need?" autocomplete="off" autocorrect="off" spellcheck="false"></div>
    <datalist id="extraNames"></datalist>
    <div ${isParent() ? "" : "hidden"}>
      <div class="add-sheet-row"><span>How many</span>
        <div class="extra-stepper">
          <button type="button" class="stepBtn stepMinus" id="exMinus">−</button>
          <input id="exAmt" class="ex-amt" type="number" value="1" min="1" step="1" inputmode="numeric">
          <button type="button" class="stepBtn stepPlus" id="exPlus">+</button>
        </div>
        <select id="exUnit" class="ex-unit">${["each", "pack", "bottle", "bag", "tin", "box"].map((u) => `<option value="${u === "each" ? "unit" : u}">${u}</option>`).join("")}</select>
      </div>
      <label class="add-sheet-row"><span>Aisle <span id="exAisleHint" class="hint" style="display:inline"></span></span>
        <select id="exAisle">${aisleOpts}</select></label>
      <label class="add-sheet-row"><span>🔁 Buy every week</span><input type="checkbox" id="exRec" class="ex-switch"></label>
    </div>
    <button id="exAdd" class="plan-done-btn" style="position:static;margin-top:14px">${isParent() ? "Add to next shop" : "Ask for it"}</button>`;
}

// weekId: which shop the addition belongs to. A parent's add lands on the
// household list straight away; anyone else's becomes a request a parent
// approves from the Shopping page — same box, same page, different outcome.
function wireAddExtra(onDone, weekId) {
  // Typing a name we already know puts it in the aisle it actually lives in,
  // rather than leaving everything in the "Household" default — items filed in
  // the wrong aisle make the per-store ordering useless when you're walking round.
  if (!S.ingredientAisles) {
    api.get("/api/ingredient-names").then(({ names, aisleFor }) => {
      S.ingredientNames = names;
      S.ingredientAisles = aisleFor || {};
      const dl = document.getElementById("extraNames");
      if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
    });
  } else {
    const dl = document.getElementById("extraNames");
    if (dl) dl.innerHTML = (S.ingredientNames || []).map((n) => `<option value="${esc(n)}">`).join("");
  }
  const exItem = document.getElementById("exItem");
  const exAisle = document.getElementById("exAisle");
  const exAisleHint = document.getElementById("exAisleHint");
  // The aisle picker lives behind the disclosure, so say out loud where the
  // item is about to land — otherwise hiding the field hides the decision.
  const showAisleHint = () => {
    exAisleHint.textContent = exItem.value.trim() && S.ingredientAisles?.[exItem.value.trim().replace(/\s+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())] ? "(guessed)" : "";
  };
  const exAmt = document.getElementById("exAmt");
  document.getElementById("exMinus").onclick = () => { exAmt.value = Math.max(1, (+exAmt.value || 1) - 1); };
  document.getElementById("exPlus").onclick = () => { exAmt.value = (+exAmt.value || 0) + 1; };
  attachPicker(exItem, (it) => {
    if (it.aisle && [...exAisle.options].some((o) => o.value === it.aisle)) exAisle.value = it.aisle;
  });
  setTimeout(() => exItem.focus(), 50);
  exItem.oninput = () => {
    const key = exItem.value.trim().replace(/\s+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const aisle = S.ingredientAisles?.[key];
    if (aisle && [...exAisle.options].some((o) => o.value === aisle)) exAisle.value = aisle;
    showAisleHint();
  };
  exAisle.onchange = showAisleHint;

  // Enter adds, so the common case never needs the button at all.
  exItem.onkeydown = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); document.getElementById("exAdd").click(); }
  };

  const exAddBtn = document.getElementById("exAdd");
  exAddBtn.onclick = busy(exAddBtn, async () => {
    let item = document.getElementById("exItem").value.trim();
    if (!item) return;
    const amount = +document.getElementById("exAmt").value;
    const unit = document.getElementById("exUnit").value;
    const aisle = document.getElementById("exAisle").value;
    const recurring = document.getElementById("exRec").checked ? 1 : 0;
    const aldi = document.getElementById("exItem").dataset.aldi;

    if (!isParent()) {
      if (!S.meId) return toast("Pick who you are first (top right).", "bad");
      const sent = await api.post("/api/extra-request", {
        person_id: S.meId, item, amount, unit, aisle, week_id: weekId,
      }).catch(() => null);
      if (!sent) return toast(OFFLINE_MSG, "bad");
      closeModal();
      return toast(`Asked for ${item} — a grown-up will add it.`, "good");
    }

    item = await confirmNewName(item);
    const added = await api.post("/api/extra", {
      item, amount, unit, aisle,
      person_id: null, by: S.meId,
      recurring,
      week_id: weekId,
    }).catch(() => null);
    if (!added) return toast(OFFLINE_MSG, "bad");
    S.pickerItems = null;
    if (aldi) await linkAldi(item, aldi);
    closeModal();
    toast(added.alreadyOnList ? `${item} is already on this list.` : `${item} added.`, added.alreadyOnList ? "bad" : "good");
    onDone();
  });
}

async function viewRegulars() {
  const shopWeekId = S.shopWeekId;
  // Always the next shop you'll do: this week's until it's marked done.
  const weekId = shopWeekId;
  const parent = isParent();
  let { extras, requests = [], kids = [], myDevices = 0, needPush = false } = await api.get(`/api/extras?week_id=${weekId}`);
  if (!parent && needPush && !myDevices) {
    document.getElementById("view").innerHTML = `
      <header class="block-head"><h1>Extras</h1></header>
      <div class="card pad" style="text-align:center">
        <p style="font-size:1.1rem;margin:6px 0 4px">🔔 Turn on notifications to ask for extras</p>
        <p class="hint">Then Mum and Dad can remind you before they go shopping.</p>
        <button id="extrasPushOn" class="primary" style="margin-top:10px">Turn on notifications</button>
      </div>`;
    const eb = document.getElementById("extrasPushOn");
    eb.onclick = busy(eb, async () => { if (await enablePushHere()) viewRegulars(); });
    return;
  }
  if (!parent) extras = extras.filter((e) => !e.adults_only);
  const myAsk = {};
  if (!parent) requests.filter((r) => r.person_id === S.meId)
    .forEach((r) => { myAsk[r.item.toLowerCase()] = r.amount | 0; });

  document.getElementById("view").innerHTML = `
    <header class="block-head">
      <h1>Extras</h1>
      ${weekBannerHTML(S.weeks.find((w) => w.id === weekId)?.start_date || "")}</header>
    ${!parent ? `<div id="kidPushOffer" class="notice small hidden" style="display:flex;align-items:center;gap:8px">
      🔔 <span>Get a nudge when we're going shopping, so you never miss adding something.</span>
      <button id="kidPushOn" style="margin-left:auto">Turn on</button></div>` : ""}
    ${parent && kids.length ? `<div class="remind-row">
      <span class="hint">Remind to add extras</span>
      ${kids.map((k) => `<button class="nudgeExtras ghost" data-id="${k.id}" data-name="${esc(k.name)}">🛒 ${esc(k.name)}${k.notifiable ? "" : " 🔕"}</button>`).join("")}
    </div>` : ""}
    ${parent && requests.length ? `<section class="block">
      <h2 class="sec-title">⏳ ${requests.length} request${requests.length === 1 ? "" : "s"} waiting for your OK</h2>
      <div class="card pad">${requests.map((r) => `
        <div class="row redemption-row">
          <span class="row-label">${esc(r.person)} wants <strong>${esc(r.item)}</strong>${r.amount > 1 ? ` × ${r0(r.amount)}` : ""}</span>
          <button class="xReq" data-id="${r.id}" data-d="approve">Approve</button>
          <button class="xReq ghost" data-id="${r.id}" data-d="deny">Say no</button>
        </div>`).join("")}</div></section>` : ""}
    ${cycleStripHTML("shop")}
    <div class="notice pantry-intro">🛒 Adding to your <strong>next shop</strong>
      (${esc(fmtWeekRange(S.weeks.find((w) => w.id === weekId)?.start_date || ""))}).</div>

    <button id="openAddExtra" class="plan-done-btn no-print" style="position:static;margin:0 0 12px">＋ Add item</button>
    ${(() => {
      const usual = extras.filter((e) => (e.prior_weeks || 0) >= 3 && !(parent ? e.active : myAsk[e.item.toLowerCase()]))
        .sort((x, y) => y.prior_weeks - x.prior_weeks).slice(0, 8);
      return usual.length ? `<div class="usual-row no-print"><span class="hint" style="display:inline">You usually get:</span>
        ${usual.map((e) => `<button class="usualChip" data-id="${e.id}">＋ ${esc(e.item)}</button>`).join("")}</div>` : "";
    })()}

    <div class="card">
      ${extras.map((e) => {
        const asked = myAsk[e.item.toLowerCase()] || 0;
        const qty = parent ? (e.active ? (e.qty || 1) : 0) : asked;
        return `
        <div class="row extra-row ${(parent ? e.active : asked) ? "on" : ""}">
          <div class="extra-stepper">
            <button class="stepBtn stepMinus" data-id="${e.id}" data-qty="${qty - 1}"
              title="${qty <= 1 ? "Remove from this week" : "One fewer"}">−</button>
            <span class="extra-qty-val">${qty || "0"}</span>
            <button class="stepBtn stepPlus" data-id="${e.id}" data-qty="${qty + 1}" title="One more">+</button>
          </div>
          <span class="shop-item">${esc(e.item)}${e.recurring ? ` <span class="tag tag-protein">weekly</span>` : ""}${parent && e.adults_only ? ` <span class="tag" title="Hidden from kids on their Extras list">grown-ups only</span>` : ""}</span>
          ${parent ? `<span class="extra-actions">
            <button class="editExtra ghost" data-id="${e.id}" aria-label="Edit name, amount, aisle" title="Edit">✏️</button>

          </span>` : ""}
        </div>`;
      }).join("") || `<p class="empty">Nothing yet — add your first item above.</p>`}
    </div>

    <div class="modal-actions" style="justify-content:center;margin-top:18px">

    </div>`;

  // Re-rendering after every tap is the simple, always-correct option, but it
  // reflows the page. Rather than hand-patching the DOM (and risking it drift
  // out of step with the server), put the button you just pressed back exactly
  // where your finger left it. Works no matter what changed above it.
  document.getElementById("openAddExtra").onclick = () => {
    openModal("Add an item", addExtraHTML());
    wireAddExtra(viewRegulars, weekId);
  };

  const keepUnderFinger = (selector, fn) =>
    document.querySelectorAll(selector).forEach((b) => (b.onclick = busy(b, async () => {
      const before = b.getBoundingClientRect().top;
      const id = b.dataset.id, cls = b.className;
      if ((await fn(b)) === false) return;
      await viewRegulars();
      const again = [...document.querySelectorAll(selector)]
        .find((x) => x.dataset.id === id && x.className === cls);
      if (again) scroller().scrollBy(0, Math.round(again.getBoundingClientRect().top - before));
    })));

  document.querySelectorAll(".usualChip").forEach((b) => (b.onclick = busy(b, async () => {
    const r = parent
      ? await api.post("/api/extra/set-qty", { week_id: weekId, id: +b.dataset.id, qty: 1, by: S.meId }).catch(() => null)
      : await api.post("/api/extra-request/set", { person_id: S.meId, extra_id: +b.dataset.id, week_id: weekId, qty: 1 }).catch(() => null);
    if (!r || r.error) return toast(r?.error || OFFLINE_MSG, "bad");
    toast(parent ? "Added to the next shop." : "Asked — a grown-up will check it.", "good");
    viewRegulars();
  })));
  keepUnderFinger(".stepBtn", async (b) => {
    if (!parent) {
      const q = +b.dataset.qty;
      if (q > 3) { toast("3 is the most you can ask for — a grown-up can add more.", "bad"); return false; }
      const r = await api.post("/api/extra-request/set", { person_id: S.meId, extra_id: +b.dataset.id, week_id: weekId, qty: Math.max(0, q) }).catch(() => null);
      if (!r || r.error) { toast(r?.error || OFFLINE_MSG, "bad"); return false; }
      if (q > 0) toast("Asked — a grown-up will check it.", "good");
      return;
    }
    try {
      await api.post("/api/extra/set-qty", { week_id: weekId, id: +b.dataset.id, qty: +b.dataset.qty, by: S.meId });
    } catch (err) { toast(/reach the server/.test(err.message) ? OFFLINE_MSG : err.message, "bad"); return false; }
  });
  keepUnderFinger(".del", async (b) => {
    if (!(await confirmDialog('Delete this forever from your household list? (Use − instead if you just don\'t want it this week.)',
        { danger: true, okLabel: "Delete forever" }))) return false;
    const res = await api.post("/api/extra/delete", { id: +b.dataset.id, actor_id: S.meId });
    if (res.error) { toast(res.error, "bad"); return false; }
  });
  document.querySelectorAll(".editExtra").forEach((b) => (b.onclick = () => {
    const extra = extras.find((x) => x.id === +b.dataset.id);
    if (extra) extraEditor(extra);
  }));
  // Children: offer notifications right here if this phone doesn't have them on.
  const offer = document.getElementById("kidPushOffer");
  if (offer && "serviceWorker" in navigator && "PushManager" in window && isSecureContext
      && Notification.permission !== "denied") {
    currentSub().then((sub) => { if (!sub) offer.classList.remove("hidden"); }).catch(() => {});
    const kb = document.getElementById("kidPushOn");
    kb.onclick = busy(kb, async () => { if (await enablePushHere()) offer.remove(); });
  }
  document.querySelectorAll(".nudgeExtras").forEach((b) => (b.onclick = busy(b, async () => {
    try {
      const r = await api.post("/api/push/nudge-extras", { actor_id: S.meId, target_id: +b.dataset.id });
      toast(r.devices ? `Reminded ${b.dataset.name}.` : `${b.dataset.name} hasn't turned notifications on.`, r.devices ? "good" : "bad");
    } catch (e) { toast(e.message, "bad"); }
  })));
  document.querySelectorAll(".xReq").forEach((b) => (b.onclick = busy(b, async () => {
    try {
      await api.post("/api/extra-request/resolve", { id: +b.dataset.id, decision: b.dataset.d, resolver_id: S.meId });
      viewRegulars();
    } catch (e) { toast(e.message, "bad"); }
  })));
}

/* ---------------------------------------------------------------- meals */

// "Last had 3 weeks ago" and the "bored of this" tap, shown on library cards and the vote list.
function lastHadText(m) {
  if (!m.lastHad) return "Not had yet";
  const thisStart = (S.weeks.find((w) => w.id === S.thisWeekId) || {}).start_date;
  if (!thisStart) return "";
  const n = Math.round((new Date(thisStart) - new Date(m.lastHad)) / (7 * 86400000));
  return n <= 0 ? "Had this week" : n === 1 ? "Last had last week" : `Last had ${n} weeks ago`;
}
function boredHTML(m) {
  const full = m.boredMine ? "You're bored of this one. Tap to undo." : m.boredCount ? `${m.boredCount} bored of this. Tap if you are too.` : "Sick of eating this? Tap to say so (it's not a veto).";
  return `<button class="bored-btn ${m.boredMine ? "on" : ""} ${m.boredCount ? "has" : ""}" data-bored="${m.id}" title="${esc(full)}" aria-label="${esc(full)}" aria-pressed="${m.boredMine ? "true" : "false"}">😴${m.boredCount ? `<span class="bored-n">${m.boredCount}</span>` : ""}</button>`;
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-bored]");
  if (!b) return;
  e.stopPropagation(); e.preventDefault();
  try { await api.post("/api/meal/bored", { meal_id: +b.dataset.bored }); }
  catch (ex) { return toast(ex.message, "bad"); }
  S.meals = [];
  route();
}, true);

async function tidyMeals() {
  let weeks = lsGet("mealplan-tidy-weeks") || 8;
  const load = async () => {
    const { unused, archived } = await api.get(`/api/meals/unused?weeks=${weeks}`);
    document.getElementById("modalBody").innerHTML = `
      <label class="field"><span>Not on the plan for</span>
        <select id="tidyWeeks">${[4, 8, 12, 26].map((n) => `<option value="${n}" ${n === weeks ? "selected" : ""}>${n} weeks</option>`).join("")}</select></label>
      ${unused.length ? `<div class="tidy-list">${unused.map((m) => `<label class="inline tag-opt tidy-row">
          <input type="checkbox" class="tidyCb" value="${m.id}"> <span>${esc(m.name)} <span class="hint" style="display:inline">${m.lastHad ? "last had " + esc(m.lastHad) : "never picked"}</span></span></label>`).join("")}</div>
        <button id="tidyGo" class="primary" style="width:100%" disabled>Archive selected</button>
        <p class="hint">Archived meals leave the library and the vote list, but you can bring them back from here.</p>`
        : `<p class="hint">Nothing has gone unused for ${weeks} weeks. 🎉</p>`}
      ${archived.length ? `<details><summary class="hint">${archived.length} archived</summary>${archived.map((m) => `<div class="tidy-row">${esc(m.name)}
          <button class="tidyBack ghost" data-id="${m.id}">Bring back</button></div>`).join("")}</details>` : ""}`;
    document.getElementById("tidyWeeks").onchange = (ev) => { weeks = +ev.target.value; lsSet("mealplan-tidy-weeks", weeks); load(); };
    const go = document.getElementById("tidyGo");
    const sync = () => { const n = document.querySelectorAll(".tidyCb:checked").length; go.disabled = !n; go.textContent = n ? `Archive ${n} meal${n === 1 ? "" : "s"}` : "Archive selected"; };
    document.querySelectorAll(".tidyCb").forEach((cb) => (cb.onchange = sync));
    if (go) go.onclick = busy(go, async () => {
      const ids = [...document.querySelectorAll(".tidyCb:checked")].map((c) => +c.value);
      await api.post("/api/meals/archive", { ids, actor_id: S.meId });
      S.meals = []; toast(`Archived ${ids.length}.`, "good"); await load(); viewMeals();
    });
    document.querySelectorAll(".tidyBack").forEach((bt) => (bt.onclick = busy(bt, async () => {
      await api.post("/api/meal/restore", { id: +bt.dataset.id, actor_id: S.meId });
      S.meals = []; toast("Brought back.", "good"); await load(); viewMeals();
    })));
  };
  openModal("🧹 Tidy up meals", `<p class="hint">Loading…</p>`);
  await load();
}

// Draft meals kept apart from the library (and from voting) until a parent adds them.
async function viewIdeas() {
  S.showIdeas = true;
  const { ideas: all, pricing } = await api.get("/api/ideas");
  const cantBuy = (m) => m.priced && m.priced.missing.length;
  const ideas = S.showUnbuyable ? all : all.filter((m) => !cantBuy(m));
  const hidden = all.length - all.filter((m) => !cantBuy(m)).length;
  if (pricing || all.some((m) => !m.priced)) setTimeout(() => { if (S.showIdeas) viewIdeas(); }, 6000);  // prices are still being worked out
  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>💡 Meal ideas</h1>
      <div class="actions"><button id="ideasBack" class="ghost">← Library</button></div></header>
    <p class="subtitle">Popular evening meals to pick from, priced from Aldi's website for the family. Nothing here is on your votes or shopping lists until you add it.</p>
    ${hidden ? `<p class="hint"><button id="ideasUnbuyable" class="link-btn">${S.showUnbuyable ? "Hide" : "Show"} ${hidden} that need something Aldi doesn't sell</button></p>` : ""}
    <div class="meal-grid">${ideas.map((m) => `
      <div class="meal-card idea" data-id="${m.id}"><div class="meal-card-main">
        <div class="meal-card-head"><h3>${esc(m.name)}</h3>
          ${(m.tags || "").split(",").filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
        <p class="hint" style="margin:2px 0">${esc(m.note)}</p>
        <p class="idea-price">${m.priced ? `≈ <strong>£${m.priced.total.toFixed(2)}</strong> at Aldi${cantBuy(m) ? ` <span class="danger-text">· not at Aldi: ${m.priced.missing.map(esc).join(", ")}</span>` : ""}` : `<span class="hint">pricing…</span>`}</p>
        <details><summary class="hint">${m.ingredients.length} ingredients</summary>
          <p class="hint">${m.priced ? m.priced.lines.map((l) => `${esc(l.item)} ${esc(String(l.amount))}${esc(l.unit === "unit" ? "" : " " + l.unit)} — ${l.product ? `${esc(l.product.name)} (${esc(l.product.size || "")}) £${l.cost.toFixed(2)}` : `<span class="danger-text">not at Aldi</span>`}`).join("<br>")
            : m.ingredients.map((i) => `${esc(i.item)} × ${esc(String(i.amount))} ${esc(i.unit)}`).join("<br>")}</p></details>
        <div class="idea-actions"><button class="ideaAdd primary" data-id="${m.id}">＋ Add to my meals</button>
          <button class="ideaNo ghost" data-id="${m.id}">Not for us</button></div>
      </div></div>`).join("") || `<p class="empty">No more ideas.</p>`}</div>`;
  document.getElementById("ideasBack").onclick = () => { S.showIdeas = false; viewMeals(); };
  const ub = document.getElementById("ideasUnbuyable");
  if (ub) ub.onclick = () => { S.showUnbuyable = !S.showUnbuyable; viewIdeas(); };
  const act = (cls, path, msg) => document.querySelectorAll(cls).forEach((b) => (b.onclick = busy(b, async () => {
    try { await api.post(path, { id: +b.dataset.id, actor_id: S.meId }); }
    catch (ex) { return toast(ex.message, "bad"); }
    S.meals = []; toast(msg, "good"); viewIdeas();
  })));
  act(".ideaAdd", "/api/idea/add", "Added to your meals.");
  act(".ideaNo", "/api/idea/dismiss", "Removed from ideas.");
}

async function viewMeals() {
  if (S.showIdeas) return viewIdeas();  // a live refresh must not drop you out of Ideas
  S.meals = (await api.get(`/api/meals?person=${S.meId || ""}`)).meals;
  const { tag, q, type } = S.mealFilter;
  const shown = S.meals.filter((m) =>
    (!type || mealHasType(m, type)) &&
    (!tag || (m.tags || "").split(",").includes(tag)) &&
    (!q || m.name.toLowerCase().includes(q.toLowerCase())));

  const parent = isParent();
  const ideaCount = parent ? (await api.get("/api/ideas").catch(() => ({ ideas: [] }))).ideas.length : 0;
  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Meal Library</h1>
      <div class="actions">${parent ? `<button id="tidyBtn" title="Archive meals nobody picks"><span aria-hidden="true">🧹</span><span class="btn-label">Tidy up</span></button>` : ""}${parent && ideaCount ? `<button id="ideasBtn" title="Draft meals you can add">💡 <span class="btn-label">Ideas ${ideaCount}</span></button>` : ""}${parent ? `<button id="newMeal" aria-label="New meal" title="New meal"><span aria-hidden="true">+</span><span class="btn-label">New meal</span></button>` : ""}</div></header>
    

    <div class="filter-bar">
      <input id="mealQ" placeholder="Search meals…" value="${esc(q)}">
      <div class="tag-filters">
        <button class="tagf ${!type ? "on" : ""}" data-typef="">All ${S.meals.length}</button>
        ${MEAL_TYPES.map(([val, label, plural]) => `
          <button class="tagf ${type === val ? "on" : ""}" data-typef="${val}">${esc(plural)} ${S.meals.filter((m) => mealHasType(m, val)).length}</button>`).join("")}
      </div>
      <div class="tag-filters">
        <button class="tagf ${!tag ? "on" : ""}" data-tag="">All tags</button>
        ${S.tags.map((t) => {
          const n = S.meals.filter((m) => (m.tags || "").split(",").includes(t)).length;
          return `<button class="tagf ${tag === t ? "on" : ""}" data-tag="${esc(t)}">${esc(t)} ${n}</button>`;
        }).join("")}
      </div>
    </div>

    ${parent && shown.some((m) => mealNeedsIngredients(m.id)) ? `<p class="notice small warn">⚠️ ${shown.filter((m) => mealNeedsIngredients(m.id)).length} meal${shown.filter((m) => mealNeedsIngredients(m.id)).length === 1 ? "" : "s"} need ingredients — shown first. Tap one to add them, or tick "No ingredients needed" (e.g. a takeaway).</p>` : ""}
    <div class="meal-grid">
      ${[...shown].sort((x, y) => (mealNeedsIngredients(y.id) ? 1 : 0) - (mealNeedsIngredients(x.id) ? 1 : 0)).map((m) => `
        <div class="meal-card ${parent && mealNeedsIngredients(m.id) ? "needs-ings" : ""}" data-id="${m.id}">
          ${m.has_photo ? `<img class="meal-photo" loading="lazy" alt="" src="/api/meal-photo?id=${m.id}&v=${S.photoV || 0}">` : ""}
          <div class="meal-card-main">
            <div class="meal-card-head">
              <h3>${esc(m.name)}</h3>
              ${MEAL_TYPES.filter(([val]) => mealHasType(m, val))
                .map(([val, label]) => `<span class="tag ${val === "light" ? "tag-protein" : ""}">${esc(label)}</span>`).join("")}
              ${(m.tags || "").split(",").filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
              ${m.recurring ? `<span class="tag tag-protein">🔁 ${esc(S.people.find((p) => p.id === m.person_id)?.name || "Everyone")}</span>` : ""}
            </div>
            <div class="meal-card-stats">
              <span class="hint last-had">${lastHadText(m)}</span>${boredHTML(m)}
              ${m.costHigh > 0 ? `<span class="meal-cost" title="Share of Aldi pack prices this meal uses${m.unpriced ? `; ${m.unpriced} ingredient${m.unpriced === 1 ? "" : "s"} not priced yet` : ""}">≈ £${m.costLow.toFixed(2)}${m.costHigh - m.costLow >= 0.005 ? `–${m.costHigh.toFixed(2)}` : ""}${m.unpriced ? "+" : ""}</span>` : ""}
              <span class="hint ing-preview">${m.ingredients.length
                ? esc(m.ingredients.map((i) => i.item).join(", "))
                : "no ingredients yet"}</span>
            </div>
            ${mealRatingHTML(m)}
          </div>
          ${parent ? `<button class="edit day-hidden" data-id="${m.id}"></button>` : ""}
        </div>`).join("") || `<p class="empty">Nothing matches that filter.</p>`}
    </div>`;

  document.querySelectorAll(".meal-rating").forEach((el) =>
    wireMealRating(el, +el.dataset.id, viewMeals));
  const ideasBtn = document.getElementById("ideasBtn");
  if (ideasBtn) ideasBtn.onclick = viewIdeas;
  const tidyBtn = document.getElementById("tidyBtn");
  if (tidyBtn) tidyBtn.onclick = tidyMeals;

  const qBox = document.getElementById("mealQ");
  qBox.oninput = (e) => { S.mealFilter.q = e.target.value; viewMeals().then(() => {
    const b = document.getElementById("mealQ"); b.focus(); b.setSelectionRange(b.value.length, b.value.length);
  }); };
  document.querySelectorAll(".tagf[data-typef]").forEach((b) => (b.onclick = () => {
    S.mealFilter.type = b.dataset.typef; viewMeals();
  }));
  document.querySelectorAll(".tagf[data-tag]").forEach((b) => (b.onclick = () => {
    S.mealFilter.tag = b.dataset.tag; viewMeals();
  }));
  if (!parent) return;

  document.getElementById("newMeal").onclick = () => mealEditor(null);
  document.querySelectorAll(".meal-card .edit").forEach((b) =>
    (b.onclick = () => mealEditor(S.meals.find((m) => m.id === +b.dataset.id))));

  // "+ Add meal" on the Plan page jumps here via #/meals/new — open the
  // editor immediately instead of making them find the button twice.
  if (location.hash === "#/meals/new") {
    history.replaceState(null, "", "#/meals");
    mealEditor(null);
  }
  if (parent) document.querySelectorAll(".meal-card").forEach((c) => {
    c.classList.add("tappable");
    c.onclick = (ev) => {
      if (ev.target.closest(".meal-rating, button, a, input")) return;
      c.querySelector(".edit")?.click();
    };
  });
  document.querySelectorAll(".meal-card .del").forEach((b) =>
    (b.onclick = busy(b, async () => {
      if (!(await confirmDialog("Delete this meal? Weeks that used it keep their history.",
          { danger: true, okLabel: "Delete meal" }))) return;
      await api.post("/api/meal/delete", { id: +b.dataset.id, actor_id: S.meId });
      viewMeals();
    })));
}

function mealEditor(meal) {
  const m = meal || { name: "", ingredients: [], portions: [] };
  const aisleOpts = (sel) => S.aisles.map((a) => `<option ${a === sel ? "selected" : ""}>${esc(a)}</option>`).join("");

  const ingRow = (i = {}) => `
    <div class="grid-row ing">
      <input class="i-item" placeholder="Ingredient" value="${esc(i.item || "")}" autocomplete="off" autocorrect="off" spellcheck="false">
      <input class="i-amt" type="number" step="any" placeholder="Qty" value="${i.amount ?? ""}">
      <select class="i-unit">${["g", "ml", "unit", "pack", "tin", "jar", "bottle", "bag", "tub", "loaf"]
        .map((u) => `<option ${u === i.unit ? "selected" : ""}>${u}</option>`).join("")}</select>
      <select class="i-aisle">${aisleOpts(i.aisle)}</select>
      <button class="rm" aria-label="Remove this ingredient">✕</button>
    </div>`;

  openModal(meal ? "Edit meal" : "New meal", `
    <label class="field"><span>Meal name</span><input id="mName" value="${esc(m.name)}"></label>
    <label class="inline" style="display:block;margin:-4px 0 10px"><input type="checkbox" id="mNoIng" ${m.no_ingredients ? "checked" : ""}> No ingredients needed (e.g. takeaway, eating out)</label>
    <div class="field"><span>What kind of meal is this?</span>
      <div class="tag-picker">
        ${MEAL_TYPES.map(([val, label]) => `<label class="inline tag-opt">
          <input type="checkbox" class="mType" value="${val}"
            ${((m.meal_type || (m.id ? "" : "proper")).split(",").includes(val)) ? "checked" : ""}> ${esc(label)}</label>`).join("")}
      </div>
      <p class="hint" style="margin:4px 0 10px">Tick as many as apply — a meal can be a proper dinner one night and a
        light lunch another. Used to sort the dropdowns and filters, never a hard restriction.</p>
    </div>
    <div class="field"><span>Categories</span>
      <div class="tag-picker">
        ${S.tags.map((t) => `<label class="inline tag-opt">
          <input type="checkbox" class="mTag" value="${esc(t)}"
            ${(m.tags || "").split(",").includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")}
      </div>
    </div>

    <div class="field">
      <label class="inline tag-opt"><input type="checkbox" id="mRecurring" ${m.recurring ? "checked" : ""}>
        Recurring — needed every week regardless of the plan</label>
      <p class="hint" style="margin:4px 0 8px">For a standing need, not a family dinner decision — someone's WFH
        lunch, a packed lunch for work. Its ingredients land on every week's shopping list automatically;
        it's never put to a vote.</p>
      <label class="field" id="mRecurringForWrap" style="${m.recurring ? "" : "display:none"};max-width:220px">
        <span>For</span>
        <select id="mRecurringFor">
          <option value="">Everyone</option>
          ${S.people.map((p) => `<option value="${p.id}" ${m.person_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
      </label>
    </div>

    <h4>Ingredients <span class="hint">— the family shop, quantities for everyone</span></h4>
    <div id="ings">${(m.ingredients.length ? m.ingredients : [{}]).map(ingRow).join("")}</div>
    <button id="addIng" class="ghost">+ ingredient</button>
    <datalist id="ingNames">${(S.ingredientNames || []).map((n) => `<option value="${esc(n)}">`).join("")}</datalist>

    ${m.id && isParent() ? `<div class="field"><span>Photo</span>
      ${m.has_photo ? `<img class="meal-photo-edit" alt="" src="/api/meal-photo?id=${m.id}&v=${S.photoV || 0}">` : ""}
      <input type="file" id="mPhoto" accept="image/*">
      ${m.has_photo ? `<button id="mPhotoRm" class="ghost">Remove photo</button>` : ""}
    </div>` : `<p class="hint">Save the meal first, then open it again to add a photo.</p>`}

    <div class="modal-actions">${m.id ? `<button id="delMeal" class="ghost danger-text">Delete meal</button>` : ""}<button id="saveMeal" class="primary">Save meal</button></div>
  `);
  const setPhoto = async (data) => {
    const r = await api.post("/api/meal-photo", { meal_id: m.id, actor_id: S.meId, data });
    if (r.error) return toast(r.error, "bad");
    S.photoV = Date.now();
    S.meals = (await api.get(`/api/meals?person=${S.meId || ""}`)).meals || S.meals;
    closeModal(); route();
    toast(data ? "Photo added." : "Photo removed.", "good");
  };
  const mPhoto = document.getElementById("mPhoto");
  if (mPhoto) mPhoto.onchange = async () => {
    const f = mPhoto.files[0]; if (!f) return;
    const img = new Image(); img.src = URL.createObjectURL(f);
    await img.decode().catch(() => null);
    if (!img.width) return toast("Couldn't read that photo.", "bad");
    const k = Math.min(1, 900 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    await setPhoto(c.toDataURL("image/jpeg", 0.75));
  };
  const mPhotoRm = document.getElementById("mPhotoRm");
  if (mPhotoRm) mPhotoRm.onclick = () => setPhoto(null);
  if (!S.ingredientNames) {
    api.get("/api/ingredient-names").then(({ names, aisleFor }) => {
      S.ingredientNames = names;
      S.ingredientAisles = aisleFor || {};
      const dl = document.getElementById("ingNames");
      if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
    });
  }

  const wire = () => document.querySelectorAll("#modalBody .rm").forEach((b) =>
    (b.onclick = () => { const p = b.parentElement; if (p.parentElement.children.length > 1) p.remove(); }));
  wire();
  const pickAll = () => document.querySelectorAll("#ings .i-item").forEach((inp) => attachPicker(inp, (it) => {
    const s = inp.closest(".ing")?.querySelector(".i-aisle");
    if (it.aisle && s && [...s.options].some((o) => o.value === it.aisle)) s.value = it.aisle;
  }));
  document.getElementById("addIng").onclick = () => {
    document.getElementById("ings").appendChild(el(ingRow())); wire(); pickAll();
    document.querySelector("#ings .ing:last-child .i-item")?.focus();
  };

  pickAll();
  document.getElementById("mRecurring").onchange = (e) => {
    document.getElementById("mRecurringForWrap").style.display = e.target.checked ? "" : "none";
  };

  const delMealBtn = document.getElementById("delMeal");
  if (delMealBtn) delMealBtn.onclick = busy(delMealBtn, async () => {
    if (!(await confirmDialog("Delete this meal? Weeks that used it keep their history.",
        { danger: true, okLabel: "Delete meal" }))) return;
    await api.post("/api/meal/delete", { id: m.id, actor_id: S.meId });
    closeModal(); viewMeals();
  });
  const saveMealBtn = document.getElementById("saveMeal");
  saveMealBtn.onclick = busy(saveMealBtn, async () => {
    const name = document.getElementById("mName").value.trim();
    if (!name) return toast("Give the meal a name.", "bad");
    // Pull every field out to plain values before any await — confirmNewName
    // below can open its own modal per near-duplicate ingredient, which would
    // otherwise wipe out this form's DOM (and any not-yet-read rows) mid-loop.
    const rawIngredients = [...document.querySelectorAll("#ings .ing")].map((r) => ({
      item: r.querySelector(".i-item").value.trim(),
      aldi: r.querySelector(".i-item").dataset.aldi,
      amount: r.querySelector(".i-amt").value,
      unit: r.querySelector(".i-unit").value,
      aisle: r.querySelector(".i-aisle").value,
    })).filter((i) => i.item);
    const tags = [...document.querySelectorAll(".mTag:checked")].map((c) => c.value).join(",");
    const meal_type = [...document.querySelectorAll(".mType:checked")].map((c) => c.value).join(",");
    if (!meal_type) return toast("Tick at least one of Proper meal / Light bite / Pudding.", "bad");

    const ingredients = [];
    for (const ing of rawIngredients) ingredients.push({ ...ing, item: await confirmNewName(ing.item) });

    const recurring = document.getElementById("mRecurring").checked ? 1 : 0;
    const person_id = document.getElementById("mRecurringFor").value || null;
    const res = await api.post("/api/meal", {
      id: m.id, actor_id: S.meId, name,
      meal_type, tags, ingredients, recurring, person_id,
      no_ingredients: document.getElementById("mNoIng")?.checked ? 1 : 0,
    });
    if (res.error) return toast(res.error, "bad");
    S.pickerItems = null;
    for (const ing of ingredients) if (ing.aldi) await linkAldi(ing.item, ing.aldi);
    closeModal();
    S.meals = [];
    // new/edited ingredients (and their aisles) should show up next time
    S.ingredientNames = null;
    S.ingredientAisles = null;
    viewMeals();
  });
}

/* ---------------------------------------------------------------- vote */

async function viewVote() {
  // Voting always targets whichever calendar week isn't confirmed yet — not
  // whatever the This/Next toggle happens to be showing on the Plan page,
  // and not necessarily "next week" if that one's already been locked in.
  const voteWeekId = S.voteWeekId;
  if (!S.meals.length) S.meals = (await api.get(`/api/meals?person=${S.meId || ""}`)).meals;
  const { tally, my_vetoes = [], vetoes_allowed: vAllowed = 1, target, picks = [] } = await api.get(`/api/poll?id=${voteWeekId}&person=${S.meId || ""}`);
  const vLeft = vAllowed - my_vetoes.length;
  const parent = isParent();
  const typeFilter = S.voteTypeFilter || "";

  const likedCount = tally.filter((t) => t.mine).length;
  const chosenCount = tally.filter((t) => t.chosen).length;
  // Soft cap, not a hard rule — same spirit as the finalise panel's own
  // target ("a guide, not a hard rule"). Nothing stops a parent raising the
  // target or a kid unliking something to free a slot; this just stops the
  // tally turning into "everyone liked everything", which made it useless as
  // a signal. Modelled on Google Forms' "limit to N selections": picks you've
  // already made stay tappable (to undo), only new ones grey out at the cap.
  const atCap = likedCount >= target;

  const ranked = S.meals
    .filter((m) => !typeFilter || mealHasType(m, typeFilter))
    .filter((m) => !mealHasType(m, "kids_lunch") || mealHasType(m, "proper") || mealHasType(m, "light"))
    // Takeaway/eating-out is a Plan-day decision a parent makes directly, not
    // something to vote on. A standing/recurring meal (someone's WFH lunch)
    // isn't a shared-dinner decision either — it's needed every week
    // regardless of any vote, so putting it in the poll would be meaningless.
    .filter((m) => !mealHasType(m, "takeaway") && !m.recurring)
    .map((m) => ({ ...m, v: tally.find((t) => t.id === m.id) || { parent_votes: 0, child_votes: 0, total: 0, mine: false, vetoed: false, chosen: false } }))
    .sort((a, b) =>
      // Vetoed meals surface first — "someone's sick of this" is the loudest
      // signal on the page, ahead of vote counts.
      ((b.v.vetoed ? 1 : 0) - (a.v.vetoed ? 1 : 0)) ||
      (b.v.parent_votes - a.v.parent_votes) ||
      (b.v.child_votes - a.v.child_votes) ||
      a.name.localeCompare(b.name));

  document.getElementById("view").innerHTML = `
    <header class="block-head">
      <h1>Vote ${meBadge()}</h1>
      <span class="week-range">Voting for ${weekWords(voteWeekId)} · ${esc(fmtWeekRange((S.weeks.find((w) => w.id === voteWeekId) || {}).start_date || ""))}</span></header>
    ${cycleStripHTML(!S.votingOpen && voteWeekId === S.thisWeekId && !(S.weeks.find((w) => w.id === S.thisWeekId) || {}).shop_closed ? "shop" : "vote")}
    ${parent && S.votingOpen && picks.some((x) => x.id !== S.meId && x.used < target) ? `<div class="remind-row">
      <span class="hint">Still to vote · tap to remind</span>
      ${picks.filter((x) => x.id !== S.meId && x.used < target).map((x) => `<button class="remindOne ghost" data-id="${x.id}" data-name="${esc(x.name)}" ${x.notifiable ? "" : `title="Hasn't turned notifications on"`}>🔔 ${esc(x.name)} · ${target - x.used} left${x.notifiable ? "" : " 🔕"}</button>`).join("")}
    </div>` : ""}
    ${parent && S.voteFinalizeOpen ? `<div class="votes-left" id="pickCount"></div>`
      : S.meId && S.votingOpen ? `<div class="votes-left ${likedCount >= target ? "done" : ""}">${likedCount >= target ? "✓ All picks used" : `<strong>${target - likedCount}</strong> of ${target} picks left`}</div>` : ""}
    ${chosenCount ? `<p class="hint">${chosenCount} already on the shortlist.</p>` : ""}

    ${!S.votingOpen ? `<div class="notice small warn">
        ${voteWeekId === S.thisWeekId && !(S.weeks.find((w) => w.id === S.thisWeekId) || {}).shop_closed
          ? "This week's meals are picked. Voting for next week opens once this week's shop is marked done."
          : "Voting is closed — the list for this week has been finalised."}
        ${parent && !(voteWeekId === S.thisWeekId && !(S.weeks.find((w) => w.id === S.thisWeekId) || {}).shop_closed) ? `<button id="reopenVoting" class="ghost" style="margin-left:8px">Reopen voting</button>` : ""}
      </div>` : ""}
    ${missingIngredientsAlertHTML(tally)}

    ${parent && S.votingOpen ? `<button id="voteFinalizeToggle" class="${S.voteFinalizeOpen ? "ghost finalize-toggle open" : "plan-done-btn finalize-toggle"}">
      ${S.voteFinalizeOpen ? "✕ Close" : `✅ Finalise ${weekWords(voteWeekId)}'s meals →`}
    </button>` : ""}
    ${parent && S.voteFinalizeOpen ? renderFinalizePanel(tally, target) : ""}

    <div class="tag-filters vote-type-filter">
      <button class="tagf ${!typeFilter ? "on" : ""}" data-typef="">All meals</button>
      ${MEAL_TYPES.filter(([val]) => val !== "kids_lunch" && val !== "takeaway").map(([val, label, plural]) => `
        <button class="tagf ${typeFilter === val ? "on" : ""}" data-typef="${val}">${esc(plural)}</button>`).join("")}
    </div>

    <div class="vote-grid">
      ${ranked.map((m, i) => {
        const isMyVeto = my_vetoes.includes(m.id);
        const vetoedByAnyone = m.v.vetoed;
        const needsIngredients = !m.ingredients || !m.ingredients.length;
        // Already-liked meals stay tappable regardless — that's the only way
        // to free a slot, whether the cap is what's holding it (below) or a
        // veto landed on it after you'd already picked it. A fresh like is
        // what's actually blocked in both cases.
        const cappedOut = atCap && !m.v.mine && !vetoedByAnyone;
        const vetoBlocksTap = vetoedByAnyone && !m.v.mine;
        // Same vocabulary as the Plan timeline and the shopping list: a round
        // tap target, the standing on a quiet line above, the name itself the
        // loudest thing in the row. Veto is a rare action, so it stops
        // shouting from a box of its own and sits out on the right.
        // Always the meal's own standing. It used to say "No picks left" on an
        // unvoted meal once you hit the cap, which replaced the one fact the
        // line exists to carry with a note about you — the cap is explained on
        // tap now, so it doesn't need to squat here.
        const standing = vetoedByAnyone ? "Vetoed — sick of this one"
          : m.v.favourite ? `✅ Family favourite · ${m.v.total} votes · ${esc(m.v.voters || "")}`
          : m.v.total ? `${m.v.total} vote${m.v.total > 1 ? "s" : ""} · ${esc(m.v.voters || "")}`
          : "No votes yet";
        return `
        <div class="vote-row ${m.v.mine ? "voted" : ""} ${vetoedByAnyone ? "vetoed" : ""} ${m.v.chosen ? "chosen" : ""} ${cappedOut ? "capped" : ""}">
          <button class="vote-hit" data-id="${m.id}"
                  data-blocked="${vetoBlocksTap ? "vetoed" : !S.votingOpen ? "closed" : cappedOut ? "capped" : ""}"
                  aria-disabled="${vetoBlocksTap || !S.votingOpen || cappedOut ? "true" : "false"}"
                  aria-pressed="${m.v.mine ? "true" : "false"}"
                  aria-label="${m.v.mine ? "Unlike" : "Like"} ${esc(m.name)}">
            <span class="vote-check" aria-hidden="true"></span>
            ${S.meals?.find((x) => x.id === m.id)?.has_photo ? `<img class="vote-photo" loading="lazy" alt="" src="/api/meal-photo?id=${m.id}&v=${S.photoV || 0}">` : ""}
            <span class="vote-body">
              <span class="vote-name">${esc(m.name)}${tagEmojis(m)}</span>
              ${vetoedByAnyone ? `<span class="vote-who vetoed-note">🚫 Vetoed</span>` : m.v.total ? `<span class="vote-who">${voterChips(m.v.voters)}</span>` : ""}
              ${(() => { const f = S.meals?.find((x) => x.id === m.id); return f ? `<span class="vote-lasthad">${lastHadText(f)}</span>` : ""; })()}

            </span>
          </button>
          ${(() => { const f = S.meals?.find((x) => x.id === m.id); return f ? boredHTML(f) : ""; })()}
          ${isMyVeto || (vLeft > 0 && !m.v.total && !vetoedByAnyone) ? `<button class="veto-btn ${isMyVeto ? "on" : ""}" data-veto="${m.id}"
            title="${isMyVeto ? "Undo your veto" : `Veto (${vLeft} left)`}">${isMyVeto ? "↩️" : "🚫"}</button>` : ""}
          ${needsIngredients ? `<div class="vote-ing-warn">
              ${ingredientsWarningHTML(true)}
              ${parent ? `<button class="addIngBtn ghost" data-id="${m.id}">+ Add ingredients</button>` : ""}
            </div>` : ""}
        </div>`;
      }).join("") || `<p class="empty">Nothing matches that filter.</p>`}
    </div>

    <div class="suggest-box">
      <h3>Not on the list?</h3>
      <p class="hint">Suggest anything — it gets added with your vote on it. A grown-up fills in what goes into it.</p>
      <div class="suggest-row">
        <input id="sugName" placeholder="e.g. Chicken Katsu Curry" maxlength="60">
        <button id="sugGo" class="primary">Suggest &amp; vote</button>
      </div>
    </div>

  `;

  const reopen = document.getElementById("reopenVoting");
  if (reopen) reopen.onclick = busy(reopen, async () => {
    if (!(await confirmDialog("Reopen voting for this week? The shortlist you've already ticked stays as it is.",
        { okLabel: "Reopen voting" }))) return;
    try {
      await api.post("/api/week/unconfirm", { week_id: voteWeekId, actor_id: S.meId });
    } catch (e) { return toast(e.message, "bad"); }
    await boot();
    location.hash = "#/vote";
    viewVote();
  });
  const finalizeToggle = document.getElementById("voteFinalizeToggle");
  if (finalizeToggle) finalizeToggle.onclick = () => { S.voteFinalizeOpen = !S.voteFinalizeOpen; viewVote(); };
  wireFinalizePanel(voteWeekId);
  document.querySelectorAll(".remindOne").forEach((b) => (b.onclick = busy(b, async () => {
    try {
      const r = await api.post("/api/push/remind", { week_id: voteWeekId, actor_id: S.meId, target_id: +b.dataset.id });
      toast(r.names.length ? `Reminded ${b.dataset.name}.` : `${b.dataset.name} hasn't turned notifications on.`, r.names.length ? "good" : "bad");
    } catch (e) { toast(e.message, "bad"); }
  })));
  document.querySelectorAll(".vote-type-filter .tagf").forEach((b) => (b.onclick = () => {
    S.voteTypeFilter = b.dataset.typef; viewVote();
  }));
  const BLOCKED_WHY = {
    vetoed: "Someone's vetoed this one, so it's off the list this week.",
    closed: "Voting's closed for this week — the meals are already picked.",
    capped: `That's all ${target} picks used. Untap one you've already liked to free a slot.`,
  };
  document.querySelectorAll(".vote-hit").forEach((c) => (c.onclick = busy(c, async () => {
    const why = BLOCKED_WHY[c.dataset.blocked];
    if (why) return toast(why, "bad");
    if (!S.meId) return toast("Pick who you are first (top right).", "bad");
    await api.post("/api/poll-vote", { week_id: voteWeekId, meal_id: +c.dataset.id, person_id: S.meId });
    viewVote();
  })));
  document.querySelectorAll(".veto-btn").forEach((b) => (b.onclick = busy(b, async (ev) => {
    ev.stopPropagation();
    if (!S.meId) return toast("Pick who you are first (top right).", "bad");
    try {
      await api.post("/api/poll-veto", { week_id: voteWeekId, meal_id: +b.dataset.veto, person_id: S.meId });
    } catch (e) { toast(e.message, "bad"); }
    viewVote();
  })));
  document.querySelectorAll(".addIngBtn").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    mealEditor(S.meals.find((x) => x.id === +b.dataset.id));
  }));
  const sugGoBtn = document.getElementById("sugGo");
  const sug = busy(sugGoBtn, async () => {
    const name = document.getElementById("sugName").value.trim();
    if (!name) return;
    if (!S.meId) return toast("Pick who you are first (top right).", "bad");
    const res = await api.post("/api/poll-suggest", { week_id: voteWeekId, name, person_id: S.meId });
    S.meals = [];
    if (res.existed) toast(`"${name}" was already on the list — your vote's been added.`);
    viewVote();
  });
  sugGoBtn.onclick = sug;
  document.getElementById("sugName").onkeydown = (e) => { if (e.key === "Enter") sug(); };
}

// Parent-only results/ticking panel. Shows the poll ranked, with a checkbox
// per meal — ticking is manual, never an automatic top-N cutoff, because a
// blind algorithm was exactly the thing that didn't work. Hitting "Finalise"
// both saves the ticks and closes voting for the week in one action.
function renderFinalizePanel(tally, target) {
  const ranked = [...tally].sort((a, b) =>
    (b.parent_votes - a.parent_votes) || (b.total - a.total) || a.name.localeCompare(b.name));
  return `
    <div class="winner-box">
      <h3>Pick the meals</h3>
      <p class="hint">Tick what makes the cut — about ${target} needed.</p>
      <label class="field" style="max-width:160px"><span>Meals needed</span>
        <input id="mealsTargetInput" type="number" min="1" value="${target}"></label>
      <button id="autoPickBtn" class="big-action">⚖️ Auto-pick fairly</button>
      <p id="autoPickNote" class="hint"></p>
      <div class="overview-days"><div class="overview-day">
        ${ranked.filter((t) => t.total > 0 || t.chosen).map((t) => `
          <label class="overview-row ${t.chosen ? "applied" : ""}">
            <input type="checkbox" class="finalizeCb" data-id="${t.id}" data-voters="${esc(t.voters || "")}" data-total="${t.total || 0}" ${t.vetoed ? `data-vetoed="1"` : ""} ${t.chosen || t.favourite ? "checked" : ""}>
            <span class="ov-body">
              <span class="ov-name">${esc(t.name)} <span class="vote-who">${voterChips(t.voters)}</span> ${ingredientsWarningHTML(mealNeedsIngredients(t.id))}</span>
            </span>
          </label>`).join("") || `<p class="empty">No votes yet.</p>`}
      </div></div>
      <button id="finalizeBtn" class="primary">Finalise list →</button>
    </div>`;
}

function wireFinalizePanel(voteWeekId) {
  const btn = document.getElementById("finalizeBtn");
  if (!btn) return;
  // Floating "5 of 7 picked" while ticking the shortlist.
  const pc = document.getElementById("pickCount");
  const tgt = document.getElementById("mealsTargetInput");
  const count = () => {
    if (!pc) return;
    const n = document.querySelectorAll(".finalizeCb:checked").length, t = +tgt.value || 0;
    pc.innerHTML = `<strong>${n}</strong> of ${t} meals picked`;
    pc.classList.toggle("done", n >= t && t > 0);
  };
  document.querySelectorAll(".finalizeCb").forEach((c) => c.addEventListener("change", count));
  // Fair auto-pick (proportional approval): each pick goes to the meal with the most
  // weight, where a person's like counts 1, then 1/2, 1/3… for each of their likes
  // already picked. So nobody's favourites crowd everyone else out. Only ticks boxes.
  const ap = document.getElementById("autoPickBtn");
  if (ap) ap.onclick = () => {
    const boxes = [...document.querySelectorAll(".finalizeCb")].filter((c) => !c.dataset.vetoed);
    const voters = (c) => (c.dataset.voters || "").split(",").map((x) => x.trim()).filter(Boolean);
    const got = {}, picked = [];
    const want = Math.min(+tgt.value || 0, boxes.length);
    while (picked.length < want) {
      let best = null, bestScore = -1;
      for (const c of boxes) {
        if (picked.includes(c)) continue;
        const sc = voters(c).reduce((s, v) => s + 1 / (1 + (got[v] || 0)), 0);
        if (sc > bestScore || (sc === bestScore && +c.dataset.total > +best.dataset.total)) { best = c; bestScore = sc; }
      }
      if (!best || bestScore <= 0) break;
      picked.push(best);
      voters(best).forEach((v) => { got[v] = (got[v] || 0) + 1; });
    }
    document.querySelectorAll(".finalizeCb").forEach((c) => { c.checked = picked.includes(c); });
    const names = [...new Set(boxes.flatMap(voters))];
    document.getElementById("autoPickNote").textContent = names.length
      ? "Each person's picks that made it: " + names.map((n) => `${n} ${got[n] || 0}`).join(" · ")
      : "No votes to go on yet.";
    count();
  };
  tgt?.addEventListener("input", count);
  count();
  btn.onclick = busy(btn, async () => {
    const meal_ids = [...document.querySelectorAll(".finalizeCb:checked")].map((c) => +c.dataset.id);
    const meals_target = +document.getElementById("mealsTargetInput").value || undefined;
    const wk = S.weeks.find((w) => w.id === voteWeekId);
    if (!(await confirmDialog(
        `Lock in ${meal_ids.length} meal${meal_ids.length === 1 ? "" : "s"} for ${weekWords(voteWeekId)} (${fmtWeekRange(wk ? wk.start_date : "")})?`,
        { title: "Which week is this for?", okLabel: "Lock it in" }))) return;
    // Points land on finalize (server-side, tied to healthy-tagged winners) but
    // nothing about that shows up anywhere in the moment — a parent finalising
    // the week has no idea it just happened unless they separately go check
    // Rewards. Diffing balances immediately before/after and folding the
    // result into this same toast makes the reward visible right when it's
    // actually earned, for the person doing the action that earns it.
    const before = (await api.get("/api/rewards")).balances;
    const res = await api.post("/api/week/finalize", {
      week_id: voteWeekId, actor_id: S.meId, meal_ids, meals_target,
    });
    if (res.error) return toast(res.error, "bad");
    const after = (await api.get("/api/rewards")).balances;
    const earners = S.people
      .filter((p) => p.role !== "parent")
      .map((p) => ({ name: p.name, delta: (after[p.id] || 0) - (before[p.id] || 0) }))
      .filter((p) => p.delta > 0);
    const pointsLine = earners.length
      ? ` 🎉 ${earners.map((e) => `${e.name} +${e.delta}`).join(", ")} for healthy picks.`
      : "";
    toast(`${meal_ids.length} meal${meal_ids.length === 1 ? "" : "s"} on this week's list. Now pick which day each one lands on.${pointsLine}`, "good");
    // Land on the week we just finalised, not whatever Plan happened to be
    // showing. Without this you finalise next week's meals, get dropped on
    // THIS week's plan, and the shortlist you just picked is nowhere to be
    // seen — the pool is fetched per-week and would come back empty.
    S.weekId = voteWeekId;
    location.hash = "#/plan";
  });
}

/* ----------------------------------------------------- extra requests page */

// Reached from the Vote page once someone's all voted up — deliberately its
// own page, not tacked onto the bottom of the vote list. Anything sent here
// goes to a parent to approve before it's a real shopping-list item; nothing
// here writes to the list directly. Revisiting later (the link works again)
// just lets you send more — there's no one-shot lock on it.
async function viewSettings() {
  const p = me();
  if (!S.stores) S.stores = (await api.get("/api/stores")).stores;

  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Settings</h1></header>
    <div class="notice small" style="display:flex;align-items:center;gap:8px">${meBadge()} Signed in as <strong>${esc(me()?.name || "")}</strong> <span class="hint" style="display:inline">(${esc(me()?.username || "")})</span>
      <button id="signOutBtn" class="ghost" style="margin-left:auto">Sign out</button></div>
    ${isInstalled() ? "" : `<button id="installSettings" class="notice small" style="display:block;width:100%;text-align:left;color:var(--text);border:none;cursor:pointer">📲 <strong>Add to home screen</strong> →</button>`}
    <a href="#/history" class="notice small" style="display:block;text-decoration:none;color:var(--text)">🕘 <strong>Past weeks</strong> →</a>
    <button id="extraLogBtn" class="notice small" style="display:block;width:100%;text-align:left;color:var(--text);border:none;cursor:pointer">🧾 <strong>Extras history</strong> — who added what →</button>

    <h2 class="sec-title">Look &amp; feel</h2>
    
    <div class="card pad">
      ${p ? `
      <div class="row"><span class="row-label">Text size<span class="when">on this device</span></span>
        <div class="size-picker">${TEXT_SIZES.map(([l, v]) => {
          let cur = 100; try { cur = +localStorage.getItem(textSizeKey()) || 100; } catch { /* ignore */ }
          return `<button class="sizeBtn ${cur === v ? "on" : ""}" data-v="${v}" style="font-size:${v / 100}rem">${l === "M" ? "A" : l}</button>`;
        }).join("")}</div></div>
      <label class="row"><span class="row-label">Compact view<span class="when">less space between things, on this device</span></span>
        <input type="checkbox" id="compactToggle" ${document.documentElement.classList.contains("compact") ? "checked" : ""}></label>
      <label class="row"><span class="row-label">Look<span class="when">how the app looks on your screen</span></span>
        <select id="themeSel">${THEMES
          .map(([v, l]) => `<option value="${v}" ${(p.theme || "classic") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="row"><span class="row-label">My icon<span class="when">shows next to your votes</span></span>
        <button id="myIconBtn" class="icon-current">${p.emoji ? esc(p.emoji) : `<span class="voter-chip" style="background:${p.color || "#888"}">${esc(p.name[0])}</span>`} change</button></div>
      <div class="row" style="align-items:flex-start">
        <span class="row-label">My colour<span class="when">picks the app's accent colour whenever you're the one signed in</span></span>
        <div class="color-swatches">
          ${KID_COLORS.map((c) => `<button class="swatch ${p.color === c ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}
          <button class="swatch swatch-clear ${!p.color ? "on" : ""}" data-color="">✕</button>
        </div>
      </div>
      ` : `<p class="empty">Pick who you are, top right.</p>`}
    </div>

    ${p ? `<h2 class="sec-title">Notifications</h2>
    <p class="subtitle">On this device. Works once the app's installed to your home screen.</p>
    <div class="card pad" id="pushCard"><p class="empty">Checking…</p></div>` : ""}

    <h2 class="sec-title">My password</h2>
    ${changePasswordForm(false)}

    <h2 class="sec-title">Family</h2>
    <p class="subtitle">Parents' votes outrank children's.</p>
    <div class="card pad">
      ${S.people.filter((x) => !x.is_placeholder).map((x) => `
        <div class="person-row-full">
          <div class="row person-line">
            <span class="person-icon">${x.emoji ? esc(x.emoji) : `<span class="voter-chip" style="background:${x.color || VOTER_FALLBACK[x.id % VOTER_FALLBACK.length]}">${esc(x.name[0])}</span>`}</span>
            <span class="row-label">${esc(x.name)} <span class="hint" style="display:inline">${x.role === "parent" ? "Parent" : "Child"}${x.is_admin ? " · admin" : ""}</span>${isParent() ? ` <span class="hint" style="display:inline">· ${esc(x.username || "")}</span>` : ""}${isParent() && !x.has_password ? ` <span class="tag" style="color:var(--low)">no password yet</span>` : ""}</span>
            ${isParent() ? `<button class="personMenu ghost" data-id="${x.id}" aria-label="Options for ${esc(x.name)}">⋯</button>` : ""}
          </div>
          <div class="row person-row day-hidden">
            <select class="roleSel" data-id="${x.id}" ${isAdmin() ? "" : "disabled"}>
              <option value="parent" ${x.role === "parent" ? "selected" : ""}>Parent</option>
              <option value="child"  ${x.role === "child" ? "selected" : ""}>Child</option>
            </select>
            ${isParent() ? `<button class="resetVotesBtn ghost" data-id="${x.id}" data-name="${esc(x.name)}" title="Clear ${esc(x.name)}'s likes and veto for this week">↺ Reset this week's votes</button>
              ${isAdmin() || x.role !== "parent" ? `<button class="setPwBtn ghost" data-id="${x.id}" data-name="${esc(x.name)}">🔑 Set password</button>` : ""}` : ""}
            ${isAdmin() ? `<button class="usernameBtn ghost" data-id="${x.id}" data-name="${esc(x.name)}" data-u="${esc(x.username || "")}">Username</button>` : ""}
            ${isAdmin() ? `<button class="adminToggle" data-id="${x.id}" data-on="${x.is_admin ? 1 : 0}">${x.is_admin ? "Remove admin" : "Make admin"}</button>` : ""}
            ${isAdmin() ? `<button class="delPerson" data-id="${x.id}" aria-label="Remove ${esc(x.name)}">✕ Delete</button>` : ""}
          </div>
          ${isAdmin() ? `<span class="day-hidden"><button class="adminIcon" data-id="${x.id}"></button></span>` : ""}
        </div>`).join("")}
      ${isAdmin() ? `<div class="add-extra">
        <input id="newPerson" placeholder="Add someone">
        <select id="newRole"><option value="child">Child</option><option value="parent">Parent</option></select>
        <button id="addPerson">Add</button>
      </div>` : `<p class="hint">Only the household admin can add, remove, or change roles.</p>`}
    </div>

    ${isAdmin() ? `
    <h2 class="sec-title">Household</h2>
    
    <div class="card pad">
      <label class="field"><span>Week starts on</span>
        <select id="weekStartSel">
          ${WEEKDAY_NAMES.map((n, i) => `<option value="${i}" ${i === S.weekStartDow ? "selected" : ""}>${n}</option>`).join("")}
        </select></label>
      <label class="field"><span>Meals needed per week (default)</span>
        <input id="mealsTargetSel" type="number" min="1" value="${S.mealsTargetDefault}"></label>
      <p class="hint">Can still be bumped up for one busy or holiday week from the Vote page.</p>
      <label class="field field-check"><span>Children need notifications on to ask for extras</span>
        <input id="extrasNeedPushChk" type="checkbox" ${S.extrasNeedPush ? "checked" : ""}></label>
      <p class="hint">So your "anything from the shop?" reminders always reach them.</p>
      <label class="field"><span>Requests per person per week before a reset</span>
        <input id="floodLimit" type="number" min="0" max="99" value="${S.extrasFloodLimit}"></label>
      <label class="field"><span>Then a break from asking (minutes)</span>
        <input id="floodMins" type="number" min="0" max="240" value="${S.extrasFloodTimeoutMin}"></label>
      <label class="field"><span>"Bored of this" taps fade after (days)</span>
        <input id="boredDays" type="number" min="0" max="365" value="${S.boredDays}"></label>
      <p class="hint">Past about half the limit they get a few "are you sure?" warnings. At the limit their requests
        for the week (and the history of them) are cleared, you're told, and they can't ask again for the break.
        Anything you'd already approved stays on the list. 0 turns this off.</p>
      <label class="field field-check"><span>Allow historic edits</span>
        <input id="historicEditsChk" type="checkbox" ${S.allowHistoricEdits ? "checked" : ""}></label>
      <p class="hint">Off by default: days that have already been and gone show as read-only history
        on the Plan. Turn on to correct something after the fact.</p>
      <label class="field"><span>Vetoes per person each week</span>
        <input id="vetoesSel" type="number" min="0" max="10" value="${S.vetoesPerPerson}"></label>
      <p class="hint">0 switches vetoes off.</p>
      <label class="field field-check"><span>Morrisons prices (beta)</span>
        <input id="morrisonsChk" type="checkbox" ${S.morrisonsEnabled ? "checked" : ""}></label>
      <p class="hint">Adds Morrisons as a second store when linking prices on the Prices page. While off, the app never contacts Morrisons.</p>
    </div>

    <h2 class="sec-title">Shopping Stores</h2>
    <p class="subtitle">Reorder aisles by dragging them on the Shopping page.</p>
    <div class="card pad" id="storeList">
      ${S.stores.map((s) => `
        <div class="row" data-id="${s.id}">
          <input class="storeNameInput" value="${esc(s.name)}" style="flex:1">
          <button class="storeSave ghost">Save</button>
          ${S.stores.length > 1 ? `<button class="storeDel ghost">Delete</button>` : ""}
        </div>`).join("")}
      <div class="add-extra">
        <input id="newStoreName" placeholder="Add a store (e.g. Tesco, Aldi)">
        <button id="addStore">Add</button>
      </div>
    </div>

    <h2 class="sec-title">Page Access</h2>
    <p class="subtitle">Which pages each person sees.</p>
    <div class="card pad" id="pageAccessList">
      ${S.people.filter((x) => !x.is_placeholder).map((x) => {
        const allowed = allowedTabsFor(x);
        const unrestricted = !x.allowed_tabs;
        return `
        <div class="access-row" data-id="${x.id}">
          <div class="access-row-name">${esc(x.name)}${x.is_admin ? ` <span class="tag">admin</span>` : ""}</div>
          <div class="tag-picker">
            ${TAB_KEYS.map(([key, label]) => `
              <label class="inline tag-opt">
                <input type="checkbox" class="accessCb" data-key="${key}"
                  ${allowed.includes(key) ? "checked" : ""}
                  ${key === "settings" && x.is_admin ? "disabled" : ""}> ${esc(label)}</label>`).join("")}
          </div>
          <button class="accessSave ghost">Save</button>
          ${unrestricted ? `<span class="hint">— currently unrestricted</span>` : ""}
        </div>`;
      }).join("")}
    </div>
    ` : ""}

    <h2 class="sec-title">Data</h2>
    <div class="card pad">
      ${isAdmin() ? `<p class="subtitle"><strong>Full backup</strong> is everything, including passwords and sign-ins, so keep the file private.
        Restoring it puts the app back exactly as it was and replaces what's here now.</p>
      <p class="subtitle">Last full backup: <strong>${S.lastBackup ? `${esc(new Date(S.lastBackup.at.replace(" ", "T") + "Z").toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))} by ${esc(S.lastBackup.by)}` : "never"}</strong></p>
      <a class="btn-link" href="/api/backup" download>Download full backup</a>
      <button id="restoreBtn" class="ghost">Restore from a backup…</button>
      <input type="file" id="restoreFile" accept=".db,application/octet-stream" hidden>
      <p class="subtitle" style="margin-top:14px">The readable export has no passwords, for looking at or moving the data.</p>` : ""}
      <a class="btn-link" href="/api/export" download>Download readable export (JSON)</a>
    </div>`;
  document.querySelector('a[href="/api/backup"]')?.addEventListener("click", () => setTimeout(() => boot().then(viewSettings), 1500));
  const rb = document.getElementById("restoreBtn"), rf = document.getElementById("restoreFile");
  if (rb) {
    rb.onclick = () => rf.click();
    rf.onchange = async () => {
      const file = rf.files[0]; rf.value = "";
      if (!file) return;
      if (!(await confirmDialog(`Replace everything in the app with "${file.name}"? A copy of what's here now is kept on the server first. You'll be signed out and need the backup's passwords.`,
          { okLabel: "Restore" }))) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const res = await api.post("/api/restore", { data: btoa(bin), actor_id: S.meId }).catch((e) => ({ error: e.message }));
      if (res.error) return toast(res.error, "bad");
      toast("Restored. Signing in again…", "good");
      setTimeout(() => location.reload(), 1200);
    };
  }

  if (!p) return;

  document.querySelectorAll(".personMenu").forEach((b) => (b.onclick = () => {
    const x = S.people.find((p) => p.id === +b.dataset.id); if (!x) return;
    const id = x.id, admin = isAdmin();
    const click = (sel) => { closeModal(); document.querySelector(`${sel}[data-id="${id}"]`)?.click(); };
    const acts = [
      ["resetVotesBtn", "↺ Reset this week's votes"],
      (admin || x.role !== "parent") && x.id !== S.meId && ["setPwBtn", "🔑 Set a temporary password"],
      admin && ["usernameBtn", `👤 Username: ${x.username || "—"}`],
      admin && ["adminIcon", `${x.emoji || "🙂"} Change icon`],
      admin && ["role", x.role === "parent" ? "👶 Make a child" : "🧑 Make a parent"],
      admin && ["adminToggle", x.is_admin ? "Remove admin" : "Make admin"],
      admin && ["delPerson", "✕ Delete"],
    ].filter(Boolean);
    openModal(x.name, `<div class="action-sheet">
      ${admin ? `<label class="field"><span>Look</span><select id="sheetTheme">${THEMES.map(([v, l]) =>
        `<option value="${v}" ${(x.theme || "classic") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
      ${admin ? `<div class="color-swatches sheet-swatches">${KID_COLORS.map((c) =>
        `<button class="swatch sheetSwatch ${x.color === c ? "on" : ""}" data-color="${c}" style="background:${c}" aria-label="Colour"></button>`).join("")}
        <button class="swatch swatch-clear sheetSwatch ${!x.color ? "on" : ""}" data-color="">✕</button></div>` : ""}
      ${acts.map(([k, l]) => `<button class="sheetBtn ${k === "delPerson" ? "danger-text" : ""}" data-k="${k}">${l}</button>`).join("")}</div>`);
    const st = document.getElementById("sheetTheme");
    if (st) st.onchange = busy(st, async () => {
      const res = await api.post("/api/person", { id, admin_id: S.meId, theme: st.value });
      if (res.error) return toast(res.error, "bad");
      closeModal(); await boot(); viewSettings(); toast(`${x.name}'s look changed.`, "good");
    });
    document.querySelectorAll(".sheetSwatch").forEach((sw) => (sw.onclick = busy(sw, async () => {
      const res = await api.post("/api/person", { id, admin_id: S.meId, color: sw.dataset.color || null });
      if (res.error) return toast(res.error, "bad");
      closeModal(); await boot(); viewSettings();
    })));
    document.querySelectorAll(".sheetBtn").forEach((s) => (s.onclick = () => {
      if (s.dataset.k === "role") {
        closeModal();
        const sel = document.querySelector(`.roleSel[data-id="${id}"]`);
        if (sel) { sel.value = x.role === "parent" ? "child" : "parent"; sel.dispatchEvent(new Event("change")); }
      } else click(`.${s.dataset.k}`);
    }));
  }));
  document.querySelectorAll(".roleSel").forEach((sel) => (sel.onchange = busy(sel, async () => {
    const person = S.people.find((x) => x.id === +sel.dataset.id);
    const res = await api.post("/api/person", { id: person.id, name: person.name, role: sel.value, admin_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  })));
  document.querySelectorAll(".setPwBtn").forEach((b) => (b.onclick = busy(b, async () => {
    const pw = prompt(`Temporary password for ${b.dataset.name} (at least 8 characters). They'll choose their own when they sign in.`);
    if (!pw) return;
    try {
      const r = await api.post("/api/person/set-password", { id: +b.dataset.id, password: pw });
      toast(`Done. ${b.dataset.name} signs in as "${r.username}" with that password.`, "good", 7000);
      await boot(); viewSettings();
    } catch (ex) { toast(ex.message, "bad"); }
  })));
  document.querySelectorAll(".usernameBtn").forEach((b) => (b.onclick = busy(b, async () => {
    const u = prompt(`Username for ${b.dataset.name}`, b.dataset.u);
    if (!u || u === b.dataset.u) return;
    try { await api.post("/api/person/username", { id: +b.dataset.id, username: u }); await boot(); viewSettings(); }
    catch (ex) { toast(ex.message, "bad"); }
  })));
  document.querySelectorAll(".resetVotesBtn").forEach((b) => (b.onclick = busy(b, async () => {
    if (!(await confirmDialog(
        `Clears ${b.dataset.name}'s likes and any veto for this week, so they can vote again from scratch. Use this if someone's voted as them by mistake — or on purpose.`,
        { title: `Reset ${b.dataset.name}'s votes?`, danger: true, okLabel: "Reset" }))) return;
    const r = await api.post("/api/person/reset-votes", { id: +b.dataset.id, week_id: S.voteWeekId, admin_id: S.meId });
    if (r.error) return toast(r.error, "bad");
    toast(`${b.dataset.name}'s votes for this week are cleared.`, "good");
  })));
  document.querySelectorAll(".delPerson").forEach((b) => (b.onclick = busy(b, async () => {
    const who = S.people.find((x) => x.id === +b.dataset.id);
    if (!(await confirmDialog(`Remove ${who?.name || "this person"}? Their votes, vetoes and reward points all go with them, permanently.`,
        { danger: true, okLabel: "Remove" }))) return;
    // The server refuses with 409 if they still have points banked, rather
    // than quietly destroying them — surface that and ask a second time.
    let res;
    try {
      res = await api.post("/api/person/delete", { id: +b.dataset.id, admin_id: S.meId });
    } catch (e) {
      if (!/reward points banked/.test(e.message)) return toast(e.message, "bad");
      if (!(await confirmDialog(e.message, { danger: true, okLabel: "Delete anyway" }))) return;
      try {
        res = await api.post("/api/person/delete", { id: +b.dataset.id, admin_id: S.meId, confirm_points: true });
      } catch (e2) { return toast(e2.message, "bad"); }
    }
    if (res?.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  })));
  const addPerson = document.getElementById("addPerson");
  if (addPerson) addPerson.onclick = busy(addPerson, async () => {
    const name = document.getElementById("newPerson").value.trim();
    if (!name) return;
    const res = await api.post("/api/person", { name, role: document.getElementById("newRole").value, admin_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  });

  const sob = document.getElementById("signOutBtn");
  if (sob) sob.onclick = busy(sob, async () => {
    await api.post("/api/logout", {}).catch(() => {});
    location.reload();
  });
  wirePasswordForm(() => viewSettings());
  const installSettings = document.getElementById("installSettings");
  if (installSettings) installSettings.onclick = showInstall;
  if (p) renderPushCard(p);
  const extraLogBtn = document.getElementById("extraLogBtn");
  if (extraLogBtn) extraLogBtn.onclick = busy(extraLogBtn, async () => {
    const { log } = await api.get(`/api/extra-log?person=${S.meId || ""}`);
    openModal("Extras history", log.length ? `<table class="redeemed-table">
      <tr><th>When</th>${isParent() ? "<th>Who</th>" : ""}<th>What</th></tr>
      ${log.map((l) => `<tr><td>${esc(new Date(l.created_at.replace(" ", "T") + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</td>
        ${isParent() ? `<td>${esc(l.person_name || "—")}</td>` : ""}<td>${esc(l.item)} <span class="hint" style="display:inline">${esc(l.action)}</span></td></tr>`).join("")}
    </table>` : `<p class="empty">Nothing yet.</p>`);
  });
  const compactToggle = document.getElementById("compactToggle");
  if (compactToggle) compactToggle.onchange = () => {
    try { localStorage.setItem(`mealplan-compact-${S.meId || "anon"}`, compactToggle.checked ? "1" : "0"); } catch { /* ignore */ }
    applyTextSize();
  };
  document.querySelectorAll(".sizeBtn").forEach((b) => (b.onclick = () => {
    try { localStorage.setItem(textSizeKey(), b.dataset.v); } catch { /* ignore */ }
    applyTextSize(); viewSettings();
  }));
  const themeSel = document.getElementById("themeSel");
  if (themeSel) themeSel.onchange = busy(themeSel, async () => {
    await api.post("/api/person", { id: p.id, actor_id: S.meId, theme: themeSel.value });
    await boot(); applyTheme(); viewSettings();
  });
  const myIconBtn = document.getElementById("myIconBtn");
  if (myIconBtn) myIconBtn.onclick = () => pickIcon(p.id, false);
  document.querySelectorAll(".adminIcon").forEach((b) => (b.onclick = () => pickIcon(+b.dataset.id, true)));
  document.querySelectorAll(".swatch:not(.adminSwatch)").forEach((sw) => (sw.onclick = busy(sw, async () => {
    await api.post("/api/person", { id: p.id, actor_id: S.meId, color: sw.dataset.color || null });
    await boot(); applyTheme(); viewSettings();
  })));
  // Kids without Settings access can't pick their own colour — an admin can
  // do it for them, right from the Family list.
  document.querySelectorAll(".adminSwatch").forEach((sw) => (sw.onclick = busy(sw, async () => {
    const res = await api.post("/api/person", { id: +sw.dataset.id, admin_id: S.meId, color: sw.dataset.color || null });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  })));

  document.querySelectorAll(".adminToggle").forEach((b) => (b.onclick = busy(b, async () => {
    await api.post("/api/person", {
      id: +b.dataset.id, name: S.people.find((x) => x.id === +b.dataset.id).name,
      is_admin: b.dataset.on === "1" ? 0 : 1, admin_id: p.id,
    });
    await boot(); viewSettings();
  })));

  const weekStartSel = document.getElementById("weekStartSel");
  if (weekStartSel) weekStartSel.onchange = busy(weekStartSel, async (e) => {
    const res = await api.post("/api/config", { week_start_dow: +e.target.value, admin_id: p.id });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  });
  const mealsTargetSel = document.getElementById("mealsTargetSel");
  if (mealsTargetSel) mealsTargetSel.onchange = busy(mealsTargetSel, async (e) => {
    const res = await api.post("/api/config", {
      meals_target_default: +e.target.value, admin_id: p.id,
    });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  });

  const vetoesSel = document.getElementById("vetoesSel");
  if (vetoesSel) vetoesSel.onchange = busy(vetoesSel, async () => {
    const res = await api.post("/api/config", { vetoes_per_person: +vetoesSel.value || 0, admin_id: p.id });
    if (res.error) return toast(res.error, "bad");
    await boot(); toast(`Vetoes per person: ${+vetoesSel.value || 0}`, "good");
  });
  const morrisonsChk = document.getElementById("morrisonsChk");
  if (morrisonsChk) morrisonsChk.onchange = busy(morrisonsChk, async (e) => {
    const res = await api.post("/api/config", { morrisons_enabled: e.target.checked ? 1 : 0, admin_id: p.id });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  });
  for (const [id, key, msg] of [["boredDays", "bored_days", "Saved."], ["floodLimit", "extras_flood_limit", "Request limit saved."], ["floodMins", "extras_flood_timeout_min", "Break length saved."]]) {
    const el = document.getElementById(id);
    if (el) el.onchange = async () => {
      try { await api.post("/api/config", { [key]: +el.value || 0, admin_id: p.id }); toast(msg, "good"); await boot(); }
      catch (ex) { toast(ex.message, "bad"); }
    };
  }
  const enpChk = document.getElementById("extrasNeedPushChk");
  if (enpChk) enpChk.onchange = busy(enpChk, async (e) => {
    try { await api.post("/api/config", { extras_need_push: e.target.checked ? 1 : 0, admin_id: p.id }); }
    catch (ex) { return toast(ex.message, "bad"); }
    await boot(); viewSettings();
  });
  const historicEditsChk = document.getElementById("historicEditsChk");
  if (historicEditsChk) historicEditsChk.onchange = busy(historicEditsChk, async (e) => {
    const res = await api.post("/api/config", {
      allow_historic_edits: e.target.checked ? 1 : 0, admin_id: p.id,
    });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
    toast(e.target.checked ? "Past days can now be edited" : "Past days are read-only", "good");
  });

  document.querySelectorAll(".storeSave").forEach((btn) => (btn.onclick = busy(btn, async () => {
    const row = btn.closest(".row");
    const name = row.querySelector(".storeNameInput").value.trim();
    if (!name) return toast("Needs a name.", "bad");
    const res = await api.post("/api/store", { id: +row.dataset.id, name, admin_id: p.id });
    if (res.error) return toast(res.error, "bad");
    S.stores = null;
    viewSettings();
  })));
  document.querySelectorAll(".storeDel").forEach((btn) => (btn.onclick = busy(btn, async () => {
    const row = btn.closest(".row");
    if (!(await confirmDialog("Delete this store? Its aisle order goes with it.",
        { danger: true, okLabel: "Delete store" }))) return;
    const res = await api.post("/api/store/delete", { id: +row.dataset.id, admin_id: p.id });
    if (res.error) return toast(res.error, "bad");
    S.stores = null;
    viewSettings();
  })));
  const addStore = document.getElementById("addStore");
  if (addStore) addStore.onclick = busy(addStore, async () => {
    const name = document.getElementById("newStoreName").value.trim();
    if (!name) return;
    const res = await api.post("/api/store", { name, admin_id: p.id });
    if (res.error) return toast(res.error, "bad");
    S.stores = null;
    viewSettings();
  });

  document.querySelectorAll(".accessSave").forEach((btn) => (btn.onclick = busy(btn, async () => {
    const row = btn.closest(".access-row");
    const checked = [...row.querySelectorAll(".accessCb:checked")].map((c) => c.dataset.key);
    const allKeys = TAB_KEYS.map(([k]) => k);
    // All ticked = store null (unrestricted) rather than a list that just
    // happens to name everything — keeps "no restriction" meaning exactly that.
    const allowed_tabs = checked.length === allKeys.length ? "" : checked.join(",");
    const res = await api.post("/api/person", {
      id: +row.dataset.id, name: S.people.find((x) => x.id === +row.dataset.id).name,
      allowed_tabs, admin_id: p.id,
    });
    if (res.error) return toast(res.error, "bad");
    await boot();
    if (+row.dataset.id === S.meId) route(); // may have just changed our own visible tabs
    viewSettings();
  })));

  if (personalSettingsOnly(p)) {
    // Keep only the personal sections: drop household links and everything after "My password".
    document.querySelectorAll("#extraLogBtn, #view a[href='#/history']").forEach((n) => n.remove());
    const pw = document.getElementById("pwForm");
    while (pw && pw.nextElementSibling) pw.nextElementSibling.remove();
  }
}

/* ---------------------------------------------------------------- rewards */

async function viewRewards() {
  const { balances, catalog, requests, myBalance, healthyTags, pointsMode = "all", earned = {}, myEarned = 0, history = [] } =
    await api.get(`/api/rewards?person=${S.meId || ""}`);
  const parent = isParent();
  const nameOf = (id) => S.people.find((p) => p.id === id)?.name || "?";
  const pending = requests.filter((r) => r.status === "pending");

  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Rewards</h1></header>
    <p class="subtitle">1 point for each healthy meal you vote for that makes the list.</p>

    <div class="reward-balance-card">
      <div class="reward-balance-big">${myBalance}</div>
      <div class="hint">points ${esc(me()?.name || "you")} can spend</div>
      <div style="margin-top:8px">${myEarned} earned all time${myEarned - myBalance > 0 ? ` · ${myEarned - myBalance} spent` : ""}</div>
      ${me() ? `<button id="rewardIconBtn" class="icon-current" style="margin-top:10px">${me().emoji ? esc(me().emoji) + " my icon" : "🙂 pick my icon"}</button>` : ""}
    </div>

    <h2 class="sec-title">Redeem</h2>
    <div class="reward-grid">
      ${catalog.map((r) => `
        <div class="reward-card ${myBalance >= r.points_cost ? "" : "locked"}">
          <div class="reward-name">${esc(r.name)}</div>
          <div class="reward-cost">${r.points_cost} pts</div>
          ${r.suggested_budget_gbp ? `<div class="hint">up to ~£${r.suggested_budget_gbp} suggested</div>` : ""}
          ${parent ? "" : `<div class="hint">${myBalance >= r.points_cost ? "Enough points — ask a parent!" : `Need ${r.points_cost - myBalance} more`}</div>`}
        </div>`).join("")}
    </div>

    ${pending.length ? `
    <h2 class="sec-title">${parent ? "Waiting for your decision" : "Waiting on a parent"}</h2>
    <div class="card pad">
      ${pending.map((r) => `
        <div class="row redemption-row">
          <span class="row-label">${esc(r.person_name)} wants <strong>${esc(r.reward_name)}</strong>
            <span class="when">${r.points_cost} pts${r.note ? " · " + esc(r.note) : ""}</span></span>
          ${parent ? `
            <input class="approveBudget" type="number" placeholder="£ budget" data-id="${r.id}" style="max-width:90px">
            <button class="approveBtn" data-id="${r.id}">Approve</button>
            <button class="denyBtn ghost" data-id="${r.id}">Deny</button>` : `<span class="tag">pending</span>`}
        </div>`).join("")}
    </div>` : ""}

    ${parent ? `
    <h2 class="sec-title">Everyone's balance</h2>
    <div class="card pad">
      ${S.people.filter((p) => p.role !== "parent").map((p) => `
        <div class="row"><span class="row-label">${esc(p.name)}</span><span class="grams">${earned[p.id] || 0} earned · ${balances[p.id] || 0} left</span>
          <button class="grantBtn ghost" data-id="${p.id}" data-name="${esc(p.name)}" data-bal="${balances[p.id] || 0}">🎁 Redeem</button></div>`).join("")}
    </div>` : ""}

    ${(() => { const mine = history.filter((h) => parent || h.person_id === S.meId);
      return mine.length ? `
    <h2 class="sec-title">Points history</h2>
    <div class="card pad"><table class="redeemed-table">
      <tr><th>Week</th>${parent ? "<th>Who</th>" : ""}<th>What</th><th>Points</th></tr>
      ${mine.map((h) => `<tr><td>${esc(new Date(h.when_date + "T00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</td>
        ${parent ? `<td>${esc(h.person_name)}</td>` : ""}<td>${esc(h.reason)}</td>
        <td style="color:${h.delta > 0 ? "var(--good)" : "var(--bad)"};font-weight:700">${h.delta > 0 ? "+" : "−"}${Math.abs(h.delta)}</td></tr>`).join("")}
    </table></div>` : ""; })()}

    ${(() => { const done = requests.filter((r) => r.status === "approved" && (parent || r.person_id === S.meId));
      return done.length ? `
    <h2 class="sec-title">Redeemed</h2>
    <div class="card pad"><table class="redeemed-table">
      <tr><th>Date</th>${parent ? "<th>Who</th>" : ""}<th>Reward</th><th>Points</th></tr>
      ${done.map((r) => `<tr><td>${esc(new Date((r.resolved_at || r.requested_at).replace(" ", "T") + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</td>
        ${parent ? `<td>${esc(r.person_name)}</td>` : ""}<td>${esc(r.reward_name)}${r.budget_gbp ? ` (£${r.budget_gbp})` : ""}${r.note ? `<br><span class="hint">${esc(r.note)}</span>` : ""}</td><td>−${r.points_cost}</td></tr>`).join("")}
    </table></div>` : ""; })()}

    ${parent ? `

    ${isAdmin() ? `
    <h2 class="sec-title">What counts as healthy?</h2>
    
    <div class="card pad">
      <div class="tag-picker">
        ${S.tags.map((t) => `<label class="inline tag-opt">
          <input type="checkbox" class="healthyTagCb" value="${esc(t)}" ${healthyTags.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")}
      </div>
    </div>

    <h2 class="sec-title">How points are earned</h2>
    <div class="card pad">
      <label class="inline tag-opt"><input type="radio" name="pointsMode" class="pointsModeRb" value="all" ${pointsMode === "all" ? "checked" : ""}>
        <span><strong>Every healthy vote</strong> earns a point, as soon as it's cast.</span></label><br>
      <label class="inline tag-opt"><input type="radio" name="pointsMode" class="pointsModeRb" value="chosen" ${pointsMode === "chosen" ? "checked" : ""}>
        <span>Only votes for healthy meals that <strong>make the week's list</strong>.</span></label>
      <p class="hint">Changing this re-counts everyone's past votes straight away.</p>
    </div>

    <h2 class="sec-title">Reward catalog</h2>
    
    <div class="card pad" id="rewardCatalogEdit">
      ${catalog.map((r) => `
        <div class="grid-row" data-id="${r.id}">
          <input class="rw-name" value="${esc(r.name)}" style="flex:2">
          <input class="rw-cost" type="number" value="${r.points_cost}" placeholder="points" style="max-width:80px">
          <input class="rw-budget" type="number" value="${r.suggested_budget_gbp ?? ""}" placeholder="£ suggested" style="max-width:100px">
          <button class="rw-save primary">Save</button>
        </div>`).join("")}
      <div class="grid-row" id="rw-new">
        <input class="rw-name" placeholder="New reward" style="flex:2">
        <input class="rw-cost" type="number" placeholder="points" style="max-width:80px">
        <input class="rw-budget" type="number" placeholder="£ suggested" style="max-width:100px">
        <button id="rw-add" class="primary">Add</button>
      </div>
    </div>
    ` : ""}
    ` : ""}`;

  const rib = document.getElementById("rewardIconBtn");
  if (rib) rib.onclick = () => pickIcon(S.meId, false);
  document.querySelectorAll(".grantBtn").forEach((b) => (b.onclick = async () => {
    const bal = +b.dataset.bal;
    const [tw, nw] = await Promise.all([S.thisWeekId, S.nextWeekId].map((id) => api.get(`/api/week?id=${id}`).catch(() => null)));
    if (!S.meals.length) S.meals = (await api.get(`/api/meals?person=${S.meId || ""}`)).meals;
    const swapMeals = S.meals.filter((m) => /takeaway|eating out|restaurant/i.test(m.name));
    const dayChoices = [[S.thisWeekId, tw, "this week"], [S.nextWeekId, nw, "next week"]].flatMap(([wid, wk, label]) =>
      (wk?.days || []).map((d) => {
        const dt = new Date((wk.week?.start_date || "") + "T00:00"); dt.setDate(dt.getDate() + d.dow);
        return { ...d, dt };
      }).filter((d) => { const t = new Date(); t.setHours(0, 0, 0, 0); return isNaN(d.dt) || d.dt >= t; }).map((d) =>
        `<option value="${wid}:${d.dow}" data-when="${esc(d.dt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }))}">${esc(d.dt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }))}${d.meal ? ` (instead of ${esc(d.meal.name)})` : " (empty)"}</option>`));
    const opts = catalog.filter((r) => r.points_cost <= bal);
    if (!opts.length) return toast(`${b.dataset.name} hasn't got enough points for anything yet.`, "bad");
    openModal(`Redeem for ${b.dataset.name}`, `
      <p class="hint">${bal} points left to spend.</p>
      <label class="field"><span>Reward</span><select id="grantReward">${opts.map((r) =>
        `<option value="${r.id}">${esc(r.name)} — ${r.points_cost} pts</option>`).join("")}</select></label>
      <label class="field"><span>£ budget (optional)</span><input id="grantBudget" type="number" step="any"></label>
      ${swapMeals.length ? `<label class="field"><span>Swap a day's meal for it? (takes that meal off the shopping list)</span>
        <select id="grantDay"><option value="">— no, don't change the plan —</option>${dayChoices.join("")}</select></label>
      <label class="field"><span>Replace with</span><select id="grantSwapMeal">${swapMeals.map((m) =>
        `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</select></label>` : ""}
      <div class="modal-actions"><button id="grantGo" class="primary">Redeem</button></div>`);
    const rSel = document.getElementById("grantReward"), mSel = document.getElementById("grantSwapMeal");
    const syncSwap = () => {
      if (!mSel) return;
      const want = /restaurant|eat/i.test(rSel.selectedOptions[0]?.text || "") ? /eating out|restaurant/i : /takeaway/i;
      const hit = [...mSel.options].find((o) => want.test(o.text)); if (hit) mSel.value = hit.value;
    };
    rSel.onchange = syncSwap; syncSwap();
    const go = document.getElementById("grantGo");
    go.onclick = busy(go, async () => {
      const budget = document.getElementById("grantBudget").value;
      const res = await api.post("/api/redemption/grant", { actor_id: S.meId, person_id: +b.dataset.id,
        reward_id: +document.getElementById("grantReward").value, budget_gbp: budget ? +budget : null,
        note: document.getElementById("grantDay")?.value
          ? `${document.getElementById("grantSwapMeal").selectedOptions[0].text} on ${document.getElementById("grantDay").selectedOptions[0].dataset.when}` : "",
        ...(document.getElementById("grantDay")?.value ? {
          swap_week_id: +document.getElementById("grantDay").value.split(":")[0],
          swap_dow: +document.getElementById("grantDay").value.split(":")[1],
          swap_meal_id: +document.getElementById("grantSwapMeal").value,
        } : {}) });
      if (res.error) return toast(res.error, "bad");
      closeModal(); toast("Redeemed — it's in the Redeemed list.", "good"); viewRewards();
    });
  }));
  document.querySelectorAll(".redeemBtn").forEach((b) => (b.onclick = busy(b, async () => {
    if (!S.meId) return toast("Pick who you are first (top right).", "bad");
    const note = (await textPrompt("Anything specific?",
      { placeholder: 'Optional — e.g. "Miller & Carter"', okLabel: "Request" })) ?? "";
    const res = await api.post("/api/redemption/request", { person_id: S.meId, reward_id: +b.dataset.id, note });
    if (res.error) return toast(res.error, "bad");
    viewRewards();
  })));
  document.querySelectorAll(".approveBtn").forEach((b) => (b.onclick = busy(b, async () => {
    const budget = document.querySelector(`.approveBudget[data-id="${b.dataset.id}"]`).value;
    const res = await api.post("/api/redemption/resolve", {
      id: +b.dataset.id, decision: "approve", resolver_id: S.meId, budget_gbp: budget ? +budget : null,
    });
    if (res.error) return toast(res.error, "bad");
    viewRewards();
  })));
  document.querySelectorAll(".denyBtn").forEach((b) => (b.onclick = busy(b, async () => {
    const res = await api.post("/api/redemption/resolve", { id: +b.dataset.id, decision: "deny", resolver_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    viewRewards();
  })));
  document.querySelectorAll(".pointsModeRb").forEach((rb) => (rb.onchange = busy(rb, async () => {
    await api.post("/api/config/points-mode", { mode: rb.value, admin_id: S.meId });
    toast("Points re-counted.", "good"); viewRewards();
  })));
  document.querySelectorAll(".healthyTagCb").forEach((cb) => (cb.onchange = busy(cb, async () => {
    const tags = [...document.querySelectorAll(".healthyTagCb:checked")].map((c) => c.value);
    await api.post("/api/config/healthy-tags", { tags, admin_id: S.meId });
    viewRewards();
  })));
  document.querySelectorAll("#rewardCatalogEdit .rw-save").forEach((b) => (b.onclick = busy(b, async () => {
    const row = b.closest(".grid-row");
    await api.post("/api/reward/save", {
      id: +row.dataset.id, admin_id: S.meId,
      name: row.querySelector(".rw-name").value.trim(),
      points_cost: +row.querySelector(".rw-cost").value,
      suggested_budget_gbp: row.querySelector(".rw-budget").value || null,
    });
    viewRewards();
  })));
  const addBtn = document.getElementById("rw-add");
  if (addBtn) addBtn.onclick = busy(addBtn, async () => {
    const row = document.getElementById("rw-new");
    const name = row.querySelector(".rw-name").value.trim();
    const cost = +row.querySelector(".rw-cost").value;
    if (!name || !cost) return toast("Needs a name and a points cost.", "bad");
    await api.post("/api/reward/save", {
      admin_id: S.meId, name, points_cost: cost,
      suggested_budget_gbp: row.querySelector(".rw-budget").value || null,
    });
    viewRewards();
  });
}

async function viewHistory() {
  const thisStart = (S.weeks.find((w) => w.id === S.thisWeekId) || {}).start_date || "";
  const weeks = (await api.get("/api/history")).weeks.filter((w) => w.start_date < thisStart);
  const admin = isAdmin();
  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Past Weeks</h1></header>
    <p class="subtitle">Reuse any week as a starting point.</p>
    ${weeks.map((w) => `
      <div class="card hist">
        <div class="hist-head">
          <h3>w/c ${esc(w.start_date)}</h3>
          <div class="actions">
            <button class="reuse" data-id="${w.id}">Copy to a new week</button>
            ${admin ? ((S.protectedWeeks || []).includes(w.id)
              ? `<span class="hint" title="This is the current, next or voting week — it's recreated automatically">in use</span>`
              : `<button class="delWeek ghost" data-id="${w.id}">Delete</button>`) : ""}
          </div>
        </div>
        <div class="hist-days">
          ${SHORT.map((s, i) => {
            const m = w.meals.find((x) => x.dow === i);
            return `<div class="hist-day"><span class="hist-dow">${s}</span><span>${m ? esc(m.name) : "—"}</span></div>`;
          }).join("")}
        </div>
      </div>`).join("") || `<p class="empty">No history yet.</p>`}`;

  document.querySelectorAll(".reuse").forEach((b) => (b.onclick = busy(b, async () => {
    const res = await api.post("/api/week/new", { copy_from: +b.dataset.id });
    if (res.existed) toast("That week already exists — switching to it.");
    await boot();
    S.weekId = res.id;
    location.hash = "#/plan";
  })));
  document.querySelectorAll(".delWeek").forEach((b) => (b.onclick = busy(b, async () => {
    if (!(await confirmDialog("Delete this week permanently? Its meals, votes and ticks all go with it.",
        { danger: true, okLabel: "Delete week" }))) return;
    const res = await api.post("/api/week/delete", { id: +b.dataset.id, admin_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    await boot();
    viewHistory();
  })));
}

/* ---------------------------------------------------------------- modal */

function openModal(title, html) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modal").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal").classList.add("hidden"); }

boot().catch(showError);

// Live sync: any write on the server bumps a counter; when it moves, re-render
// the current page — unless someone's mid-typing or has a dialog open.
let liveV = null, liveBuild = null;
setInterval(async () => {
  if (document.hidden) return;
  let v;
  let pending = 0, build;
  try { ({ v, pending, build } = await api.get("/api/version")); } catch { return; }
  if (pendingTicks().length) await flushTicks();
  // New code deployed while this page sat open: reload so nobody keeps
  // running (and acting on) an old version of the app.
  if (liveBuild && build && build !== liveBuild) {
    const el = document.activeElement;
    if (!(el && /INPUT|TEXTAREA|SELECT/.test(el.tagName))) return location.reload();
  }
  liveBuild = liveBuild || build;
  const shopTab = document.querySelector('.tabs a[data-tab="shopping"]');
  if (shopTab) shopTab.dataset.badge = typeof S !== "undefined" && isParent() && pending ? pending : "";
  if (liveV !== null && v !== liveV) {
    const el = document.activeElement;
    const busyTyping = el && /INPUT|TEXTAREA|SELECT/.test(el.tagName);
    const modalOpen = !document.getElementById("modal")?.classList.contains("hidden");
    if (!busyTyping && !modalOpen && !S.pauseSync && !document.querySelector("dialog[open], .confirm-dialog")) {
      liveV = v;
      if (typeof S !== "undefined" && S.meId && location.hash !== "") {
        const y = scroller().scrollTop;
        // Full refresh, not just the page: people's settings (look, colour,
        // icon) may have been changed on another device.
        await boot();
        applyTheme();
        scroller().scrollTo(0, y);
      }
      return;
    }
    return;
  }
  liveV = v;
}, 4000);

/* ---------------------------------------------------------------- pricing */
// Desktop admin page: every ingredient and extra in one place, each linked to
// one or more Aldi products so the shopping list can show a price range.
async function viewPricing() {
  if (!isParent()) {
    document.getElementById("view").innerHTML = `<p class="empty">Prices are for parents.</p>`;
    return;
  }
  S.pricingFilter = S.pricingFilter || { q: "", show: "all" };
  S.pricingFilter.open = S.pricingFilter.open || new Set();
  const f = S.pricingFilter;
  const { items, lastChecked } = await api.get("/api/pricing/items");
  const shown = items.filter((i) => (!f.q || i.key.toLowerCase().includes(f.q.toLowerCase()))
    && (f.show === "all" || (f.show === "unlinked" ? !i.products.length : i.products.length)));
  const linked = items.filter((i) => i.products.length).length;
  const money = (n) => `£${n.toFixed(2)}`;
  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Prices</h1>
      <span class="week-range">${linked} of ${items.length} items priced</span>
      <div class="actions"><button id="priceRefresh" class="primary">↻ Refresh prices</button></div></header>
    <p class="subtitle">${S.morrisonsEnabled ? "Aldi and Morrisons" : "Aldi"} prices${lastChecked ? `, last checked ${esc(new Date(lastChecked.replace(" ", "T") + "Z").toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}` : ""}. Link more than one product to get a price range.</p>
    ${dupesHTML(items)}
    ${S.morrisonsEnabled ? `<a href="#/compare" class="notice small desktop-only" style="display:block;text-decoration:none;color:var(--text)">🔬 <strong>Compare with Morrisons</strong> — matches and prices →</a>` : ""}
    <div class="pricing-bar">
      <input id="priceQ" placeholder="Search items…" value="${esc(f.q)}">
      <select id="priceShow">${[["all", "All items"], ["unlinked", "Not priced yet"], ["linked", "Priced"]]
        .map(([v, l]) => `<option value="${v}" ${f.show === v ? "selected" : ""}>${l}</option>`).join("")}</select>
    </div>
    <div class="card pricing-table-wrap"><table class="pricing-table">
      <tr><th>Item</th><th>Used in</th><th>Aldi products</th><th>Range</th><th></th></tr>
      ${shown.map((i) => `<tr class="${i.variants.length ? "pt-parent" : ""}" ${i.variants.length ? `data-open="${esc(i.key)}"` : ""}>
        <td class="pt-item">${i.variants.length ? `<span class="pt-tri ${f.open.has(i.key) ? "open" : ""}" aria-hidden="true">▸</span>` : ""}<button class="itemEdit link-btn" data-key="${esc(i.key)}" title="Quantities per meal, or merge">${esc(i.key)} ✏️</button>${i.variants.length ? ` <span class="hint" style="display:inline">${i.variants.length} counted as</span>` : ""}</td>
        <td class="pt-meals">${esc(i.meals.join(", "))}</td>
        <td>${i.products.map((p) => `<span class="price-chip ${p.missing ? "missing" : ""}" title="${esc(p.category)}">
            <span class="store-badge ${esc(p.store || "aldi")}">${(p.store || "aldi") === "morrisons" ? "M" : "A"}</span> ${esc(p.name)} <span class="hint" style="display:inline">${esc(p.size)}</span> <strong>${money(p.price)}</strong>
            <button class="unlinkBtn" data-id="${p.id}" aria-label="Remove">✕</button></span>`).join("") || `<span class="hint" style="display:inline">—</span>`}</td>
        <td class="pt-range">${i.low != null ? money(i.low) + (i.high > i.low ? `–${money(i.high)}` : "") : ""}</td>
        <td><button class="linkBtn ghost" data-key="${esc(i.key)}">＋ Link</button></td>
      </tr>${f.open.has(i.key) ? i.variants.map((v) => `<tr class="pt-variant">
        <td class="pt-item">↳ ${esc(v.name)}</td>
        <td class="pt-meals">Bought ${v.times}×${v.paid.length ? `, paid ${money(Math.min(...v.paid))}${Math.max(...v.paid) > Math.min(...v.paid) ? `–${money(Math.max(...v.paid))}` : ""}` : ""}</td>
        <td>${v.products.map((p) => `<span class="price-chip ${p.missing ? "missing" : ""}"><span class="store-badge ${esc(p.store || "aldi")}">${(p.store || "aldi") === "morrisons" ? "M" : "A"}</span> ${esc(p.name)} <span class="hint" style="display:inline">${esc(p.size)}</span> <strong>${money(p.price)}</strong>
            <button class="unlinkBtn" data-id="${p.id}" aria-label="Remove">✕</button></span>`).join("") || `<span class="hint" style="display:inline">—</span>`}</td>
        <td class="pt-range">${money(v.low)}${v.high > v.low ? `–${money(v.high)}` : ""}</td>
        <td><button class="linkBtn ghost" data-key="${esc(i.key)}" data-variant="${esc(v.code)}" data-vname="${esc(v.name)}">＋ Link</button></td>
      </tr>`).join("") : ""}`).join("") || `<tr><td colspan="5" class="empty">Nothing matches.</td></tr>`}
    </table></div>`;

  const q = document.getElementById("priceQ");
  q.oninput = () => { f.q = q.value; clearTimeout(viewPricing._t); viewPricing._t = setTimeout(async () => {
    await viewPricing(); const el = document.getElementById("priceQ"); el.focus(); el.setSelectionRange(el.value.length, el.value.length);
  }, 250); };
  document.getElementById("priceShow").onchange = (e) => { f.show = e.target.value; viewPricing(); };
  document.querySelectorAll(".unlinkBtn").forEach((b) => (b.onclick = busy(b, async () => {
    await api.post("/api/pricing/unlink", { id: +b.dataset.id, actor_id: S.meId });
    viewPricing();
  })));
  const refresh = document.getElementById("priceRefresh");
  refresh.onclick = busy(refresh, async () => {
    const r = await api.post("/api/pricing/refresh", { actor_id: S.meId });
    if (r.error) return toast(r.error, "bad");
    openModal("Prices refreshed", `
      <p>Checked ${r.checked} product${r.checked === 1 ? "" : "s"}.</p>
      ${r.changed.length ? `<table class="redeemed-table"><tr><th>Product</th><th>Was</th><th>Now</th></tr>
        ${r.changed.map((c) => `<tr><td>${esc(c.name)}</td><td>${money(c.old)}</td><td><strong>${money(c.new)}</strong></td></tr>`).join("")}</table>`
        : `<p class="hint">No price changes.</p>`}
      ${r.missing.length ? `<p class="danger-text">No longer listed: ${esc(r.missing.join(", "))}</p>` : ""}
      ${r.failed ? `<p class="hint">${r.failed} couldn't be checked — try again later.</p>` : ""}`);
    viewPricing();
  });
  document.querySelectorAll(".linkBtn").forEach((b) => (b.onclick = () => priceLinker(b.dataset.key, b.dataset.variant, b.dataset.vname)));
  document.querySelectorAll("tr[data-open]").forEach((tr) => (tr.onclick = (e) => {
    if (e.target.closest("button")) return;  // edit / link / unlink keep their own jobs
    f.open.has(tr.dataset.open) ? f.open.delete(tr.dataset.open) : f.open.add(tr.dataset.open);
    viewPricing();
  }));
  document.querySelectorAll(".itemEdit").forEach((b) => (b.onclick = () => itemEditor(items.find((i) => i.key === b.dataset.key), items)));
  document.querySelectorAll(".dupMerge").forEach((b) => (b.onclick = busy(b, async () => {
    const r = await api.post("/api/pricing/merge", { actor_id: S.meId, from: b.dataset.from, to: b.dataset.to });
    if (r.error) return toast(r.error, "bad");
    toast(`Combined into "${b.dataset.to}".`, "good"); S.meals = []; viewPricing();
  })));
  document.querySelectorAll(".dupSkip").forEach((b) => (b.onclick = () => {
    const skip = lsGet("mealplan-dup-skip") || []; skip.push(b.dataset.pair); lsSet("mealplan-dup-skip", skip); viewPricing();
  }));
}

function priceLinker(key, variant, vname) {
  // A receipt product opens on its code: Aldi looks the exact product up, far more reliably than its abbreviated till text.
  let store = "aldi";
  openModal(`Link products — ${vname || key}`, `
    ${S.morrisonsEnabled ? `<div class="store-tabs"><button class="storeTab on" data-s="aldi">Aldi</button><button class="storeTab" data-s="morrisons">Morrisons</button></div>` : ""}
    <div class="pricing-bar"><input id="aldiQ" value="${esc(variant || key)}"><button id="aldiGo" class="primary">Search</button></div>
    <div id="aldiResults" class="aldi-results"><p class="hint">Searching…</p></div>`);
  const added = new Set();
  let miss = false;
  const run = async () => {
    const box = document.getElementById("aldiResults");
    box.innerHTML = `<p class="hint">Searching…</p>`;
    const r = await api.get(`/api/pricing/search?q=${encodeURIComponent(document.getElementById("aldiQ").value)}${store === "morrisons" ? "&store=morrisons" : ""}`).catch(() => null);
    if (!r || r.error) { box.innerHTML = `<p class="danger-text">${esc(r?.error || OFFLINE_MSG)}</p>`; return; }
    if (variant && !r.results.length && store === "aldi" && /^\d+$/.test(document.getElementById("aldiQ").value) && vname && vname !== document.getElementById("aldiQ").value) {
      document.getElementById("aldiQ").value = vname;  // not an Aldi code (or retired): fall back to the till text
      miss = true;
      return run();
    }
    box.innerHTML = (miss ? `<p class="hint">Aldi's site doesn't list product ${esc(variant)} (often seasonal, a special buy, or sold out), so this is a text search on the till wording and may be well off.</p>` : "") + r.results.map((p, n) => `<div class="aldi-row">
        <span><strong>${esc(p.name)}</strong> <span class="hint" style="display:inline">${esc(p.brand)} · ${esc(p.size)} · ${esc(p.category)}</span></span>
        <span class="aldi-price">£${p.price.toFixed(2)}</span>
        <button class="aldiAdd ${added.has(p.sku) ? "" : "primary"}" data-n="${n}" ${added.has(p.sku) ? "disabled" : ""}>${added.has(p.sku) ? "Added ✓" : "Add"}</button>
      </div>`).join("") || `<p class="hint">No results — try a shorter search.</p>`;
    document.querySelectorAll(".aldiAdd").forEach((btn) => (btn.onclick = busy(btn, async () => {
      const p = r.results[+btn.dataset.n];
      const res = await api.post("/api/pricing/link", { actor_id: S.meId, key, product: p, variant });
      if (res.error) return toast(res.error, "bad");
      added.add(p.sku); btn.textContent = "Added ✓"; btn.disabled = true; btn.classList.remove("primary");
    })));
  };
  document.getElementById("aldiGo").onclick = run;
  document.querySelectorAll(".storeTab").forEach((t) => (t.onclick = () => {
    store = t.dataset.s;
    document.querySelectorAll(".storeTab").forEach((x) => x.classList.toggle("on", x === t));
    run();
  }));
  document.getElementById("aldiQ").onkeydown = (e) => { if (e.key === "Enter") run(); };
  run();
  const obs = new MutationObserver(() => {
    if (document.getElementById("modal").classList.contains("hidden")) { obs.disconnect(); if (location.hash === "#/pricing") viewPricing(); }
  });
  obs.observe(document.getElementById("modal"), { attributes: true, attributeFilter: ["class"] });
}

/* ------------------------------------------------------ install to home screen */
// Browsers only offer a real install prompt on HTTPS; this app runs on plain
// http on the LAN, so Android gets the prompt only if the browser offers it,
// otherwise both platforms get the short manual steps.
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; });
const isInstalled = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
async function showInstall() {
  if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; return; }
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  openModal("Add to your home screen", ios ? `
    <ol class="install-steps">
      <li>Open this page in <strong>Safari</strong>.</li>
      <li>Tap the <strong>Share</strong> button <span aria-hidden="true">⬆︎</span> at the bottom.</li>
      <li>Scroll down, tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
    </ol>` : `
    <ol class="install-steps">
      <li>Open this page in <strong>Chrome</strong>.</li>
      <li>Tap the <strong>⋮</strong> menu at the top right.</li>
      <li>Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong>), then <strong>Add</strong>.</li>
    </ol>`);
}
function installBannerHTML() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("mealplan-install-dismissed") === "1"; } catch { /* ignore */ }
  if (isInstalled() || !isPhone() || dismissed) return "";
  return `<div class="notice small install-banner no-print">📲 Use it like an app — add it to your home screen.
    <button id="installBtn" class="primary">Add</button><button id="installNo" class="ghost">Not now</button></div>`;
}
function wireInstallBanner() {
  const b = document.getElementById("installBtn"), n = document.getElementById("installNo");
  if (b) b.onclick = showInstall;
  if (n) n.onclick = () => { try { localStorage.setItem("mealplan-install-dismissed", "1"); } catch { /* ignore */ } n.closest(".install-banner").remove(); };
}

/* ---- Prices: likely duplicates + per-item quantities/merge ---- */
const UNITS = ["g", "ml", "unit", "pack", "tin", "jar", "bottle", "bag", "tub", "loaf"];
function dupNorm(k) {
  return k.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}
// Words that don't change what you'd actually buy ("Chicken Breast Fillets" = "Chicken Breast").
const FILLER = ["fillet", "fresh", "frozen", "british", "large", "small", "pack", "loose", "whole", "free", "range", "plain", "semi", "skimmed"];
function findDupes(items) {
  const skip = lsGet("mealplan-dup-skip") || [];
  const out = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = dupNorm(items[i].key), b = dupNorm(items[j].key);
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    const same = a.join(" ") === b.join(" ");
    const extra = l.filter((w) => !s.includes(w));
    const near = s.length && s.every((w) => l.includes(w)) && extra.length === 1 && FILLER.includes(extra[0]);
    const pair = [items[i].key, items[j].key].sort().join("|");
    if ((same || near) && !skip.includes(pair)) out.push([items[i], items[j], pair]);
  }
  return out;
}
function dupesHTML(items) {
  const d = findDupes(items);
  if (!d.length) return "";
  const used = (i) => `${i.uses.length} meal${i.uses.length === 1 ? "" : "s"}${i.meals.includes("Extras") ? " + extras" : ""}`;
  return `<div class="card pad dupes"><h3>🔁 Possible duplicates (${d.length})</h3>
    <p class="hint">Combine them so the shopping list adds them up as one line.</p>
    ${d.map(([x, y, pair]) => `<div class="dup-row">
      <span class="dup-names"><strong>${esc(x.key)}</strong> <span class="hint" style="display:inline">${used(x)}</span> ⇄ <strong>${esc(y.key)}</strong> <span class="hint" style="display:inline">${used(y)}</span></span>
      <span class="dup-acts">
        <button class="dupMerge" data-from="${esc(y.key)}" data-to="${esc(x.key)}">Keep “${esc(x.key)}”</button>
        <button class="dupMerge" data-from="${esc(x.key)}" data-to="${esc(y.key)}">Keep “${esc(y.key)}”</button>
        <button class="dupSkip ghost" data-pair="${esc(pair)}">Not the same</button>
      </span></div>`).join("")}</div>`;
}
function itemEditor(item, items) {
  if (!item) return;
  openModal(item.key, `
    ${item.uses.length ? `<h4>Amount per meal</h4>
    <div class="use-list">${item.uses.map((u) => `<div class="use-row">
      <span class="use-meal">${esc(u.meal)}</span>
      <input class="useAmt" data-id="${u.id}" type="number" step="any" min="0" value="${u.amount}">
      <select class="useUnit" data-id="${u.id}">${UNITS.map((x) => `<option ${x === u.unit ? "selected" : ""}>${x}</option>`).join("")}</select>
      <button class="useSave" data-id="${u.id}">Save</button></div>`).join("")}</div>` : `<p class="hint">Only used as an extra.</p>`}
    <h4>Combine with another item</h4>
    <div class="pricing-bar"><select id="mergeInto"><option value="">— choose the name to keep —</option>
      ${items.filter((i) => i.key !== item.key).map((i) => `<option>${esc(i.key)}</option>`).join("")}</select>
      <button id="mergeGo" class="primary">Combine</button></div>
    <p class="hint">“${esc(item.key)}” is renamed to the chosen item in every meal and extra, and its Aldi links move across.</p>`);
  document.querySelectorAll(".useSave").forEach((b) => (b.onclick = busy(b, async () => {
    const id = b.dataset.id;
    const r = await api.post("/api/pricing/ingredient", { actor_id: S.meId, id: +id,
      amount: +document.querySelector(`.useAmt[data-id="${id}"]`).value,
      unit: document.querySelector(`.useUnit[data-id="${id}"]`).value });
    if (r.error) return toast(r.error, "bad");
    b.textContent = "Saved ✓"; S.meals = [];
  })));
  const go = document.getElementById("mergeGo");
  go.onclick = busy(go, async () => {
    const to = document.getElementById("mergeInto").value;
    if (!to) return toast("Pick which name to keep.", "bad");
    if (!(await confirmDialog(`Rename every “${item.key}” to “${to}”? This can't be undone automatically.`, { title: "Combine items?", okLabel: "Combine" }))) return;
    const r = await api.post("/api/pricing/merge", { actor_id: S.meId, from: item.key, to });
    if (r.error) return toast(r.error, "bad");
    closeModal(); toast(`Combined into “${to}”.`, "good"); S.meals = []; viewPricing();
  });
}

/* ------------------------------------------------ shared item picker ---- */
// One dropdown for every "type an item" box: your existing items first (stops
// duplicates), then Aldi products underneath (priced). Our own list, not the
// browser's <datalist>, because iPhone shows that as keyboard suggestions.
const itemKey = (s) => s.trim().split(/\s+/).join(" ").toLowerCase().replace(/(^|[^a-z'])([a-z])/g, (m, p, c) => p + c.toUpperCase());
const ALDI_AISLE = { "Fresh Food": "Fresh Produce", "Chilled Food": "Dairy & Chilled", "Frozen Food": "Frozen",
  "Food Cupboard": "Cupboard", "Bakery": "Bakery", "Home Essentials": "Household", "Drinks": "Drinks" };
async function linkAldi(name, json) {
  S.pickerItems = null;
  if (!isParent()) return;
  try { await api.post("/api/pricing/link", { actor_id: S.meId, key: itemKey(name), product: JSON.parse(json) }); } catch { /* price can be linked later on Prices */ }
}
async function pickerData() {
  if (!S.pickerItems) {
    const [{ names = [], aisleFor = {} }, pr] = await Promise.all([
      api.get("/api/ingredient-names"), api.get("/api/pricing/items").catch(() => ({ items: [] }))]);
    const range = {}; (pr.items || []).forEach((i) => { if (i.low != null) range[i.key] = [i.low, i.high]; });
    S.pickerItems = [...new Set(names.concat((pr.items || []).map((i) => i.key)))].map((n) => ({ name: n, aisle: aisleFor[itemKey(n)] || aisleFor[n], range: range[itemKey(n)] }));
  }
  return S.pickerItems;
}
function attachPicker(input, onPick) {
  if (input.dataset.picker) return;
  input.dataset.picker = "1";
  const pop = document.createElement("div"); pop.className = "picker-pop"; pop.hidden = true;
  input.insertAdjacentElement("afterend", pop);
  let timer = null, seq = 0;
  const money = (r) => r ? ` <span class="pk-price">£${r[0].toFixed(2)}${r[1] > r[0] ? `–${r[1].toFixed(2)}` : ""}</span>` : "";
  const render = async () => {
    const q = input.value.trim().toLowerCase(); const mine = ++seq;
    if (q.length < 2) { pop.hidden = true; return; }
    const own = (await pickerData()).filter((i) => i.name.toLowerCase().includes(q)).slice(0, 6);
    const draw = (aldi) => {
      if (mine !== seq) return;
      pop.innerHTML = (own.length ? `<div class="pk-head">Your items</div>` + own.map((i, n) =>
        `<button type="button" class="pk-row" data-own="${n}">${esc(i.name)}${money(i.range)}</button>`).join("") : "")
        + (aldi === null ? `<div class="pk-head">From Aldi…</div>` : aldi.length ? `<div class="pk-head">From Aldi</div>` + aldi.map((p, n) =>
          `<button type="button" class="pk-row" data-aldi="${n}">${esc(p.name)} <span class="pk-sub">${esc(p.size)}</span> <span class="pk-price">£${p.price.toFixed(2)}</span></button>`).join("") : "");
      pop.hidden = !pop.innerHTML;
      pop.querySelectorAll(".pk-row").forEach((b) => (b.onpointerdown = (e) => e.preventDefault()));
      pop.querySelectorAll("[data-own]").forEach((b) => (b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation(); const it = own[+b.dataset.own];
        input.value = it.name; delete input.dataset.aldi; pop.hidden = true; onPick?.(it);
      }));
      pop.querySelectorAll("[data-aldi]").forEach((b) => (b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation(); const p = aldi[+b.dataset.aldi];
        const exists = S.pickerItems?.find((i) => i.name.toLowerCase() === p.name.toLowerCase());
        input.value = exists ? exists.name : p.name; input.dataset.aldi = JSON.stringify(p); pop.hidden = true;
        onPick?.({ name: input.value, aisle: ALDI_AISLE[(p.category || "").split(" › ")[0]] });
        input.focus(); input.setSelectionRange(0, input.value.length);
      }));
    };
    draw(q.length >= 3 ? null : []);
    if (q.length >= 3) {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const r = await api.get(`/api/pricing/search?q=${encodeURIComponent(q)}`).catch(() => null);
        draw(r && !r.error ? r.results.slice(0, 6) : []);
      }, 400);
    }
  };
  input.addEventListener("input", () => { delete input.dataset.aldi; render(); });
  input.addEventListener("focus", render);
  input.addEventListener("blur", () => setTimeout(() => { pop.hidden = true; }, 300));
}

function manualFind(aldiSku, item, done) {
  openModal(`Find “${item}” at Morrisons`, `
    <div class="pricing-bar"><input id="mfQ" value="${esc(item)}"><button id="mfGo" class="primary">Search</button></div>
    <p class="hint">Search however you would on the Morrisons site — the words you use are saved to help the automatic matching learn.</p>
    <div id="mfOut" class="aldi-results"></div>`);
  const go = async () => {
    const q = document.getElementById("mfQ").value.trim(), out = document.getElementById("mfOut");
    if (!q) return;
    out.innerHTML = `<p class="hint">Searching Morrisons…</p>`;
    const r = await api.get(`/api/pricing/search?store=morrisons&q=${encodeURIComponent(q)}`).catch((e) => ({ error: e.message }));
    if (r.error) { out.innerHTML = `<p class="danger-text">${esc(r.error)}</p>`; return; }
    out.innerHTML = r.results.map((p, n) => `<div class="aldi-row"><span><strong>${esc(p.name)}</strong> <span class="hint" style="display:inline">${esc(p.size)} · ${esc(p.category)}</span></span>
      <span class="aldi-price">£${p.price.toFixed(2)}</span><button class="mfPick primary" data-n="${n}">This one</button></div>`).join("") || `<p class="hint">Nothing found — try fewer words.</p>`;
    out.querySelectorAll(".mfPick").forEach((b) => (b.onclick = busy(b, async () => {
      const p = r.results[+b.dataset.n];
      const res = await api.post("/api/compare/pick", { actor_id: S.meId, aldi_sku: aldiSku, sku: p.sku, product: p, query: q });
      if (res.error) return toast(res.error, "bad");
      closeModal(); toast("Saved as the Morrisons match.", "good"); done?.();
    })));
  };
  document.getElementById("mfGo").onclick = go;
  document.getElementById("mfQ").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

/* ---------------------------------------------------------------- compare */
// Desktop page: every saved Aldi→Morrisons match, always loaded from the
// database. Running a comparison adds new matches; nothing disappears on reload.
async function viewCompare() {
  const view = document.getElementById("view");
  if (!isParent()) { view.innerHTML = `<p class="empty">Compare is for parents.</p>`; return; }
  if (!S.morrisonsEnabled) {
    view.innerHTML = `<header class="block-head"><h1>Compare</h1></header>
      <p class="notice small">Switch on <strong>Morrisons prices (beta)</strong> in Settings → Household to compare stores.</p>`;
    return;
  }
  const { rows: raw, total } = await api.get("/api/compare/list");
  raw.forEach((x) => { x.best = sameAmount(x.aldi, x.matches); x.score = x.matches[0].picked ? 1 : (x.matches[0].score ?? 1); });
  let sortBy = "az"; try { sortBy = localStorage.getItem("mealplan-compare-sort") || "az"; } catch { /* ignore */ }
  const absd = (x) => (x.best ? Math.abs(x.best.diff) : -1);
  const SORTS = {
    az: [(x, y) => x.item.localeCompare(y.item), "A–Z (default)"],
    wrong: [(x, y) => absd(y) * (1.2 - y.score) - absd(x) * (1.2 - x.score), "Most likely wrong first"],
    score: [(x, y) => x.score - y.score, "Lowest score first"],
    diff: [(x, y) => absd(y) - absd(x), "Biggest price difference first"],
  };
  const saved = [...raw].sort((SORTS[sortBy] || SORTS.az)[0]);
  const comp = raw.filter((x) => x.best);
  const tot = comp.reduce((s, x) => s + x.best.diff, 0);
  const aldiTot = comp.reduce((s, x) => s + x.aldi.price, 0), morTot = comp.reduce((s, x) => s + x.best.cost, 0);
  const aldiWins = comp.filter((x) => x.best.diff > 0.05).length, morWins = comp.filter((x) => x.best.diff < -0.05).length;
  const up = (u, of) => (u == null ? "" : `£${u.toFixed(2)}/${of}`);
  const pickedN = saved.filter((x) => x.matches[0]?.picked).length;
  view.innerHTML = `
    <header class="block-head"><h1>Compare</h1>
      <span class="week-range">${saved.length} of ${total} items matched · ${pickedN} checked by hand</span></header>
    <div class="card pad compare-card">
      <div class="pricing-bar" style="max-width:440px"><input id="compareN" type="number" min="1" max="30" value="5">
        <button id="compareRun" class="primary">Compare more</button></div>
      <label class="inline"><input type="checkbox" id="compareNew" checked> Only items not compared yet</label>
      <label class="inline"><input type="checkbox" id="compareFresh"> Re-match from scratch</label>
      <div id="compareOut"></div>
    </div>
    ${comp.length ? `<div class="notice compare-total">Across <strong>${comp.length}</strong> comparable items, the same shop costs
      <strong>${tot >= 0 ? `£${tot.toFixed(2)} more at Morrisons` : `£${(-tot).toFixed(2)} more at Aldi`}</strong>
      <span class="hint" style="display:inline">· Aldi cheaper on ${aldiWins}, Morrisons cheaper on ${morWins}, ${comp.length - aldiWins - morWins} about the same</span></div>` : ""}
    <div class="pricing-bar" style="max-width:360px"><label class="inline">Sort <select id="compareSort">${Object.entries(SORTS).map(([k, [, l]]) =>
      `<option value="${k}" ${k === sortBy ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <div class="card pricing-table-wrap"><table class="pricing-table">
      <tr><th>Item</th><th>Aldi${comp.length ? ` <span class="hint" style="display:inline">£${aldiTot.toFixed(2)}</span>${tot < 0 ? ` <span class="danger-text">(+£${(-tot).toFixed(2)})</span>` : ""}` : ""}</th>
        <th>Morrisons${comp.length ? ` <span class="hint" style="display:inline">£${morTot.toFixed(2)}</span>${tot > 0 ? ` <span class="danger-text">(+£${tot.toFixed(2)})</span>` : ""}` : ""}</th><th>Score</th><th>Compared</th></tr>
      ${saved.map((x) => { const m = x.matches[0]; const a = x.aldi;
        const cheaper = m && m.unit != null && a.unit != null && m.unit !== a.unit ? (m.unit < a.unit ? "Morrisons" : "Aldi") : "";
        return `<tr><td class="pt-item">${esc(x.item)}</td>
          <td>${esc(a.name)} <span class="hint" style="display:inline">${esc(a.size)}</span> <strong>£${a.price.toFixed(2)}</strong></td>
          <td>${esc(dropSize(m.name, soldSize(m)))} <span class="hint" style="display:inline">${esc(soldSize(m) || "")}</span> <strong>£${(m.price || 0).toFixed(2)}</strong>
            ${m.picked ? ` <span class="good-text">✓ picked</span>` : `<button class="cmpGood link-btn" data-a="${esc(a.sku)}" data-s="${esc(m.sku)}" data-score="${m.score ?? ""}">👍 good match</button>`}
            <button class="cmpFind link-btn" data-a="${esc(a.sku)}" data-item="${esc(x.item)}">🔍 find it myself</button>
            ${x.matches.slice(1, 3).map((o) => `<div class="hint alt-row">${o.score ?? "–"} · ${esc(dropSize(o.name, o.size))} ${esc(o.size || "")} £${(o.price || 0).toFixed(2)}
              <button class="cmpPick link-btn" data-a="${esc(a.sku)}" data-s="${esc(o.sku)}">use this</button></div>`).join("")}</td>
          <td>${m.picked ? `<span class="good-text">✓</span>` : m.score == null ? "" : `<span class="${m.score >= 0.8 ? "good-text" : m.score >= 0.6 ? "" : "danger-text"}">${m.score.toFixed(2)}</span>`}</td>
          <td>${sameAmountVerdict(a, x.matches)}</td></tr>`; }).join("") || `<tr><td colspan="5" class="empty">Nothing compared yet — press Compare more.</td></tr>`}
    </table></div>`;

  document.getElementById("compareSort").onchange = (e) => { try { localStorage.setItem("mealplan-compare-sort", e.target.value); } catch { /* ignore */ } viewCompare(); };
  document.querySelectorAll(".cmpFind").forEach((f) => (f.onclick = () => manualFind(f.dataset.a, f.dataset.item, viewCompare)));
  document.querySelectorAll(".cmpGood").forEach((g) => (g.onclick = busy(g, async () => {
    const res = await api.post("/api/compare/pick", { actor_id: S.meId, aldi_sku: g.dataset.a, sku: g.dataset.s,
      query: `(confirmed auto match, score ${g.dataset.score})` });
    if (res.error) return toast(res.error, "bad");
    viewCompare();
  })));
  document.querySelectorAll(".cmpPick").forEach((p) => (p.onclick = busy(p, async () => {
    const res = await api.post("/api/compare/pick", { actor_id: S.meId, aldi_sku: p.dataset.a, sku: p.dataset.s });
    if (res.error) return toast(res.error, "bad");
    viewCompare();
  })));
  const cmp = document.getElementById("compareRun");
  cmp.onclick = busy(cmp, async () => {
    const box = document.getElementById("compareOut");
    const n = +document.getElementById("compareN").value || 5;
    const fresh = document.getElementById("compareFresh").checked ? 1 : 0;
    const onlyNew = document.getElementById("compareNew").checked ? 1 : 0;
    let done = 0, last = "";
    S.pauseSync = true;  // our own saves would otherwise redraw the page and wipe the progress bar
    try {
    for (let k = 0; k < n; k++) {
      box.innerHTML = `<div class="cmp-progress"><div class="cmp-bar" style="width:${Math.round(k / n * 100)}%"></div></div>
        <p class="hint">Comparing ${k + 1} of ${n}${last ? ` — last: ${esc(last)}` : ""}…</p>`;
      const one = await api.post("/api/compare/run", { actor_id: S.meId, limit: 1, offset: onlyNew ? 0 : k, fresh, only_new: onlyNew }).catch((e) => ({ error: e.message }));
      if (one.error) { box.innerHTML = `<p class="danger-text">${esc(one.error)}</p>`; return; }
      if (!one.rows.length) break;
      done++; last = one.rows[0].item;
      const err = one.rows.find((x) => x.error);
      if (err && /refusing/.test(err.error)) { toast(err.error, "bad"); break; }
    }
    } finally { S.pauseSync = false; }
    toast(done ? `Compared ${done} item${done === 1 ? "" : "s"}.` : "Nothing new to compare.", "good");
    viewCompare();
  });
}

// "Morrisons 1.5× more (+£0.45)": same amount as the Aldi pack, per-unit prices.
function priceVerdict(a, m) {
  if (a.unit == null || m.unit == null || !a.unit || a.unitOf !== m.unitOf) return `<span class="hint">can't compare sizes</span>`;
  const r = m.unit / a.unit, diff = (m.unit - a.unit) * (a.price / a.unit);
  if (Math.abs(r - 1) < 0.03) return "About the same";
  const who = r > 1 ? "Morrisons" : "Aldi", x = r > 1 ? r : 1 / r;
  return `<strong>${who}</strong> ${x.toFixed(1)}× more <span class="hint" style="display:inline">(+£${Math.abs(diff).toFixed(2)})</span>`;
}

// Morrisons repeats the size in the name ("BBQ Sauce 450g" + "450g"); show it once.
function dropSize(name, size) {
  if (!size) return name;
  const esc2 = size.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return name.replace(new RegExp(`\\s*\\(?${esc2}\\)?\\s*$`, "i"), "").trim() || name;
}
// "1kg" / "0.5 KG" / "4 x 220g" / "2 Pint" / "6 Each" -> [amount in g|ml|each, kind]
// Prefer the sold weight written in the name over a separate size field.
function soldSize(m) {
  const hit = String(m.name || "").match(/(\d+\s*x\s*)?\d+(?:\.\d+)?\s*(?:kg|g|ml|l|cl|pints?)\b\)?\s*$/i);
  return hit ? hit[0].replace(/[()]/g, "").trim() : m.size;
}
function sizeBase(size) {
  let t = String(size || "").toLowerCase(), mult = 1;
  const mp = t.match(/(\d+)\s*x\s*([\d.]+)/); if (mp) { mult = +mp[1]; t = t.slice(t.indexOf(mp[2])); }
  const m = t.match(/([\d.]+)\s*(kg|g|l|ml|cl|pints?|each|pk)?/); if (!m) return [null, null];
  const n = +m[1] * mult, u = m[2] || "each";
  return u === "kg" ? [n * 1000, "g"] : u === "g" ? [n, "g"] : u === "l" ? [n * 1000, "ml"] : u === "cl" ? [n * 10, "ml"]
    : u === "ml" ? [n, "ml"] : /pint/.test(u) ? [n * 568, "ml"] : [n, "each"];
}
// Rule: buy roughly what you'd buy at Aldi — never under 90%, never over 150% —
// using whole packs of one product; cheapest way in that band wins.
const BAND = [0.9, 1.5];
function sameAmount(a, matches) {
  const [ref, kind] = sizeBase(a.size);
  if (!ref) return null;
  // The match on show always counts (it's the one you're looking at); other
  // runners-up only if they're a decent match.
  const pool = matches.some((m) => m.picked) ? matches.filter((m) => m.picked)
    : matches.filter((m, i) => i === 0 || (m.score ?? 1) >= 0.6);
  let best = null;
  for (const m of pool) {
    const [sz, k] = sizeBase(soldSize(m)); if (!sz || k !== kind) continue;
    const packs = Math.max(1, Math.round(ref / sz)), got = packs * sz;
    if (got / ref < BAND[0] || got / ref > BAND[1]) continue;
    const cost = packs * m.price;
    if (!best || cost < best.cost) best = { m, packs, cost };
  }
  return best ? { ...best, diff: best.cost - a.price } : null;
}
function sameAmountVerdict(a, matches) {
  if (!sizeBase(a.size)[0]) return `<span class="hint">no size on the Aldi item</span>`;
  const best = sameAmount(a, matches);
  if (!best) return `<span class="hint">no similar size at Morrisons</span>`;
  const diff = best.diff, how = best.packs > 1 ? ` <span class="hint" style="display:inline">(${best.packs} × ${esc(best.m.size)})</span>` : "";
  if (Math.abs(diff) < 0.05) return `About the same${how}`;
  return `<strong>${diff > 0 ? "Morrisons" : "Aldi"}</strong> +£${Math.abs(diff).toFixed(2)} for the same amount${how}`;
}

/* --------------------------------------------------------- receipt scanner */
// Text comes from the phone's own Live Text (photo → select text → copy), so
// no OCR library and the photo never leaves the phone. Lines are matched by
// Aldi's product code; anything not on this week's list starts as a treat.
function receiptFlow() {
  // A receipt belongs to the shop just done, which is usually NEXT week's (you shop
  // Friday for the week starting Saturday), not the week on screen. Default to the
  // newest week whose shop is marked done; let the parent change it.
  const wk = (id) => S.weeks.find((w) => w.id === id) || {};
  const choices = [S.nextWeekId, S.thisWeekId].filter(Boolean);
  const def = choices.find((id) => wk(id).shop_closed) || S.weekId;
  openModal("Scan receipt", `
    <label class="field"><span>Which shop is this?</span>
      <select id="rcWeek">${choices.map((id) => `<option value="${id}" ${id === def ? "selected" : ""}>${esc(fmtWeekRange(wk(id).start_date || ""))} (${weekWords(id)})</option>`).join("")}</select></label>
    <ol class="install-steps" style="font-size:.9rem;margin-top:0">
      <li>Open the <strong>Camera</strong> and point it at the receipt (or take a photo).</li>
      <li>Tap the <strong>text icon</strong> ▤ in the corner, then <strong>Select All → Copy</strong>.</li>
      <li>Paste it below.</li></ol>
    <textarea id="rcText" rows="8" placeholder="Paste receipt text here" style="width:100%;font-family:ui-monospace,monospace;font-size:16px"></textarea>
    <button id="rcRead" class="plan-done-btn" style="position:static;margin-top:10px">Read receipt</button>`);
  const go = document.getElementById("rcRead");
  go.onclick = busy(go, async () => {
    const weekId = +document.getElementById("rcWeek").value;
    const r = await api.post("/api/receipt/parse", { actor_id: S.meId, week_id: weekId, text: document.getElementById("rcText").value })
      .catch((e) => ({ error: e.message }));
    if (r.error) return toast(r.error, "bad");
    receiptReview(weekId, r);
  });
}
function receiptReview(weekId, r) {
  const L = r.lines, items = r.listItems || [];
  const KIND = { meal: "🍽️ Meal", extra: "🛒 Extra", treat: "🍭 Treat", oneoff: "↩️ One-off", regular: "🔁 Regular" };
  const kindOf = (key) => (items.find((x) => x.key === key) || {}).kind || "extra";
  // "Counts as": a substitute (different product code) standing in for a list item.
  const countAs = (l, key) => {
    if (!key) { Object.assign(l, { item_key: null, name: l.text, kind: "treat", decided: false, matched: false, once: false }); return; }
    Object.assign(l, { item_key: key, name: key, kind: kindOf(key), decided: true, matched: true });
  };
  const draw = () => {
    const sum = (k) => L.filter((l) => l.kind === k || (k === "extra" && l.kind === "regular")).reduce((s, l) => s + l.amount, 0);
    const open = L.filter((l) => l.undecided && !l.decided);
    const off = r.total != null && Math.abs(r.total - r.sum) > 0.01;
    const linked = L.filter((l) => l.item_key).length;
    document.getElementById("modalBody").innerHTML = `
      <div class="notice small ${off ? "warn" : "good"}">${off
        ? `⚠️ Lines add up to £${r.sum.toFixed(2)} but the receipt says £${r.total.toFixed(2)} — a line may have been misread.`
        : `✓ ${r.items} items, £${(r.total ?? r.sum).toFixed(2)} — all lines read.`}</div>
      <div class="rc-summary">🍽️ £${sum("meal").toFixed(2)} · 🛒 £${sum("extra").toFixed(2)} · 🍭 £${sum("treat").toFixed(2)}${sum("oneoff") ? ` · ↩️ £${sum("oneoff").toFixed(2)}` : ""}
        <span class="hint" style="display:block">${linked} of ${L.length} lines matched to your list</span></div>
      ${open.length ? `<h4>Not matched (${open.length}): a substitute for something on your list, or extra?</h4>` : ""}
      <div class="rc-lines">${L.map((l, i) => {
        const unmatched = (!l.item_key || l.matched) && !l.deposit;
        return `<div class="rc-line ${l.undecided && !l.decided ? "open" : ""}">
        <span class="rc-name">${l.qty > 1 ? `${l.qty} × ` : ""}${esc(l.matched ? l.text : l.name)}${l.remembered ? ` <span class="hint" style="display:inline">(remembered)</span>` : ""}
          ${l.matched ? `<span class="rc-as">= <strong>${esc(l.item_key)}</strong>
            <label class="hint" style="display:inline"><input type="checkbox" class="rcOnce" data-i="${i}" ${l.once ? "checked" : ""}> just this once</label>
            <button class="rcUndo link-toggle" data-i="${i}">change</button></span>` : ""}</span>
        <span class="rc-amt">£${l.amount.toFixed(2)}</span>
        ${unmatched && !l.matched ? `<span class="rc-choices">
          ${l.suggest ? `<button class="rcSuggest" data-i="${i}">= ${esc(l.suggest)}?</button>` : ""}
          <select class="rcAs" data-i="${i}"><option value="">Counts as…</option>${items.map((x) =>
            `<option value="${esc(x.key)}" data-label="${esc(x.label || x.key)}">${esc(x.label || x.key)}</option>`).join("")}</select>
          ${["regular", "treat", "meal", "oneoff"].map((k) =>
            `<button class="rcPick ${l.kind === k && l.decided ? "on" : ""}" data-i="${i}" data-k="${k}">${KIND[k]}</button>`).join("")}</span>`
          : l.matched ? "" : `<span class="rc-kind">${KIND[l.kind] || ""}</span>`}
      </div>`; }).join("")}</div>
      <button id="rcSave" class="plan-done-btn" style="position:static;margin-top:12px">Save receipt${open.length ? ` (${open.length} left as treats)` : ""}</button>`;
    document.querySelectorAll(".rcPick").forEach((b) => (b.onclick = () => {
      const l = L[+b.dataset.i]; l.kind = b.dataset.k; l.decided = true; draw();
    }));
    document.querySelectorAll(".rcSuggest").forEach((b) => (b.onclick = () => { const l = L[+b.dataset.i]; countAs(l, l.suggest); draw(); }));
    document.querySelectorAll(".rcAs").forEach((sel) => (sel.onchange = () => {
      const l = L[+sel.dataset.i]; countAs(l, sel.value);
      const lab = sel.selectedOptions[0]?.dataset.label; if (sel.value && lab) l.name = lab;  // "Breakfast — Crêpes"
      draw();
    }));
    document.querySelectorAll(".rcUndo").forEach((b) => (b.onclick = () => { countAs(L[+b.dataset.i], null); draw(); }));
    document.querySelectorAll(".rcOnce").forEach((c) => (c.onchange = () => { L[+c.dataset.i].once = c.checked; }));
    const save = document.getElementById("rcSave");
    save.onclick = busy(save, async () => {
      const res = await api.post("/api/receipt/save", { actor_id: S.meId, week_id: weekId, lines: L, total: r.total ?? r.sum });
      if (res.error) return toast(res.error, "bad");
      closeModal(); toast("Receipt saved.", "good"); await boot();
    });
  };
  draw();
}
if ("serviceWorker" in navigator && isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  // A tapped notification on an already-open app: the service worker asks us to go there.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open") openFromNotification(e.data.url);
  });
}

// Notification taps arrive as "/?req=12#/extras": go to the page, and for a
// child's request show an Approve / Say no box straight away.
function openFromNotification(url) {
  const u = new URL(url, location.origin);
  if (u.hash && u.hash !== location.hash) location.hash = u.hash;
  const req = +u.searchParams.get("req");
  if (req && isParent()) showRequestBox(req);
}
async function showRequestBox(id) {
  let r;
  try { r = (await api.get(`/api/extra-request?id=${id}`)).request; } catch { return; }
  if (!r) return;
  if (r.status !== "pending") return toast(`${r.person}'s ${r.item} was already ${r.status}.`);
  openModal(`${r.person} asked for`, `
    <p style="font-size:1.3rem;font-weight:700;margin:4px 0 16px">${esc(r.item)}${r.amount > 1 ? ` × ${r0(r.amount)}` : ""}</p>
    <div class="modal-actions"><button id="reqNo" class="ghost">Say no</button><button id="reqYes" class="primary">Approve</button></div>`);
  const go = (decision) => async () => {
    try {
      await api.post("/api/extra-request/resolve", { id, decision, resolver_id: S.meId });
      closeModal(); toast(decision === "approve" ? `Added ${r.item} to the list.` : `Said no to ${r.item}.`, "good");
      route();
    } catch (e) { toast(e.message, "bad"); }
  };
  document.getElementById("reqYes").onclick = go("approve");
  document.getElementById("reqNo").onclick = go("deny");
}

// ---- Push notifications (per device, per person) ----
function b64uToBytes(s) {
  const b = atob((s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function currentSub() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !isSecureContext) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
// Ask permission, subscribe this browser, register it for the signed-in person.
async function enablePushHere() {
  try {
    if (!("serviceWorker" in navigator && "PushManager" in window && isSecureContext))
      throw new Error("this browser can't. On iPhone, open the app from your home screen");
    if (await Notification.requestPermission() !== "granted") throw new Error("permission wasn't given");
    const { key } = await api.get(`/api/push/state?person_id=${S.meId}`);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    await api.post("/api/push/subscribe", { person_id: S.meId, sub: sub.toJSON() });
    toast("Notifications on", "good");
    return true;
  } catch (e) { toast("Couldn't turn on notifications: " + e.message, "bad"); return false; }
}

async function renderPushCard(p) {
  const card = document.getElementById("pushCard");
  if (!card) return;
  const st = await api.get(`/api/push/state?person_id=${p.id}`);
  if (!st.enabled) { card.innerHTML = `<p class="empty">Not available on this server.</p>`; return; }
  const supported = "serviceWorker" in navigator && "PushManager" in window && isSecureContext;
  const sub = supported ? await currentSub() : null;
  const denied = supported && Notification.permission === "denied";
  const kinds = Object.entries(st.kinds).filter(([, k]) => !k.parents_only || p.role === "parent");
  // Device-specific: this browser on/off. Person-wide: what to get, and a test
  // that goes to every device they've switched on (e.g. test your phone from a laptop).
  const here = !supported
    ? (isSecureContext ? "can't do notifications in this browser (on iPhone, use the home-screen app)" : "needs the https:// address")
    : denied ? "blocked — allow notifications for this app in the browser or phone settings" : sub ? "on" : "off";
  card.innerHTML = `
    <div class="row"><span class="row-label">This device<span class="when">${here}</span></span>
      ${!supported || denied ? "" : sub ? `<button id="pushOff" class="ghost">Turn off</button>` : `<button id="pushOn">Turn on</button>`}</div>
    ${st.devices ? `<p class="hint">On for you on ${st.devices} device${st.devices === 1 ? "" : "s"}.</p>`
      + kinds.map(([k, v]) => `<label class="row"><span class="row-label">${esc(v.label)}</span>
      <input type="checkbox" class="pushKind" data-k="${k}" ${st.off.includes(k) ? "" : "checked"}></label>`).join("")
      + `<div class="add-extra"><button id="pushTest" class="ghost">Send a test to my devices</button></div>` : ""}
    ${isAdmin() ? `<label class="row"><span class="row-label">Voting reminder time<span class="when">for everyone: children who haven't voted after a day get one nudge</span></span>
      <select id="pushHour"><option value="-1" ${st.reminderHour < 0 ? "selected" : ""}>Off</option>${Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}" ${st.reminderHour === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select></label>` : ""}`;
  const ph = document.getElementById("pushHour");
  if (ph) ph.onchange = async () => {
    try { await api.post("/api/config", { admin_id: p.id, push_reminder_hour: +ph.value }); toast("Reminder time saved.", "good"); }
    catch (e) { toast(e.message, "bad"); }
  };
  const on = document.getElementById("pushOn");
  if (on) on.onclick = async () => { await enablePushHere(); renderPushCard(p); };
  const off = document.getElementById("pushOff");
  if (off) off.onclick = async () => {
    const s = await currentSub();
    if (s) { await api.post("/api/push/unsubscribe", { endpoint: s.endpoint }); await s.unsubscribe(); }
    renderPushCard(p);
  };
  card.querySelectorAll(".pushKind").forEach((c) => c.onchange = () =>
    api.post("/api/push/prefs", { person_id: p.id,
      off: [...card.querySelectorAll(".pushKind")].filter((x) => !x.checked).map((x) => x.dataset.k) }));
  const test = document.getElementById("pushTest");
  if (test) test.onclick = async () => {
    const r = await api.post("/api/push/test", { person_id: p.id });
    toast(r.devices ? "Sent — should arrive in a few seconds" : "No devices on for you yet");
  };
}
