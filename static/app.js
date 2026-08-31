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
  meId: +(localStorage.getItem("mealplan-me") || 0) || null,
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
  ["plan", "Plan"], ["shopping", "Shopping"], ["meals", "Meals"],
  ["vote", "Vote"], ["rewards", "Rewards"], ["history", "History"], ["settings", "Settings"],
];
// null/unset allowed_tabs = everyone, unchanged from before this feature
// existed. Admins always keep Settings regardless of what's configured —
// otherwise an admin could lock themselves out of the one place that fixes it.
function allowedTabsFor(p) {
  if (!p) return TAB_KEYS.map(([k]) => k);
  if (!p.allowed_tabs) return TAB_KEYS.map(([k]) => k);
  const set = new Set(p.allowed_tabs.split(","));
  if (p.is_admin) set.add("settings");
  return [...set];
}
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
function applyTheme() {
  const p = me();
  document.documentElement.dataset.funTheme = p?.theme === "fun" ? "1" : "0";
  const root = document.documentElement.style;
  if (p?.color) {
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
  if (!res.ok || body.error) throw new Error(body.error || `${path} → HTTP ${res.status}`);
  return body;
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

// A real numeric keypad, not a raw text field — used for every PIN entry in
// the app (login, switch-person, set/change PIN) so it's one consistent,
// touch-sized interaction instead of three different half-native ones.
// `validate`, if given, is awaited once 4 digits are in; on failure it shows
// the message inline and clears input rather than closing, so a wrong PIN is
// a retry, not a dead end. Resolves {digits, extra} on success, null on cancel.
function pinPad(opts = {}) {
  const { title = "Enter PIN", validate = async () => ({ ok: true }) } = opts;
  return new Promise((resolve) => {
    let digits = "";
    const body = document.getElementById("modalBody");
    const render = (errorMsg, shake) => {
      body.innerHTML = `
        <p class="subtitle" style="margin:0 0 14px">${esc(title)}</p>
        <div class="pin-dots ${shake ? "shake" : ""}">${[0, 1, 2, 3]
          .map((i) => `<span class="pin-dot ${i < digits.length ? "filled" : ""}"></span>`).join("")}</div>
        <p class="pin-error ${errorMsg ? "show" : ""}">${esc(errorMsg || "")}</p>
        <div class="pin-keys">
          ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k) => k === ""
            ? `<span></span>`
            : `<button type="button" class="pin-key" data-k="${k}">${k}</button>`).join("")}
        </div>
        <div class="modal-actions" style="justify-content:flex-end">
          <button id="pinCancel" class="ghost">Cancel</button>
        </div>`;
      document.getElementById("pinCancel").onclick = () => finish(null);
      body.querySelectorAll(".pin-key").forEach((b) => (b.onclick = () => onKey(b.dataset.k)));
    };
    const restore = withCloseGuard(() => finish(null));
    const finish = (val) => { restore(); document.removeEventListener("keydown", onPhysicalKey); closeModal(); resolve(val); };
    const onKey = async (k) => {
      if (k === "⌫") { digits = digits.slice(0, -1); return render(); }
      if (digits.length >= 4) return;
      digits += k;
      render();
      if (digits.length === 4) {
        const result = await validate(digits);
        if (result.ok) return finish({ digits, extra: result.extra });
        digits = "";
        // CSS animations play once and stop on their own — no need to
        // schedule anything to "undo" the shake. The message stays on
        // screen until the next digit is pressed (onKey's own render()
        // call then clears it), which is exactly when it should go.
        render(result.message || "Wrong PIN — try again.", true);
      }
    };
    const onPhysicalKey = (e) => {
      if (/^[0-9]$/.test(e.key)) onKey(e.key);
      else if (e.key === "Backspace") onKey("⌫");
      else if (e.key === "Escape") finish(null);
    };
    openModal(title, "");
    render();
    document.addEventListener("keydown", onPhysicalKey);
  });
}

function showError(e) {
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
const weekBannerHTML = (startISO) =>
  startISO ? `<span class="week-range">${esc(fmtWeekRange(startISO))}</span>` : "";

const advanceWeekHTML = () =>
  `<div class="notice small good no-print">
    ✅ <strong>This week's shop is done.</strong>
    <button id="advanceWeekBtn" class="ghost" style="margin-left:6px">Start next week →</button>
    <span class="hint" style="display:block;margin-top:2px">New "anything else?" requests will land on the week after this one instead.</span>
  </div>`;

function wireAdvanceWeek(afterHash) {
  const btn = document.getElementById("advanceWeekBtn");
  if (!btn) return;
  btn.onclick = busy(btn, async () => {
    if (!(await confirmDialog('Start next week? "This Week" and "Next Week" will both shift forward.'))) return;
    // Always S.nextWeekId, not S.weekId. The banner now shows while standing
    // on THIS week (that's the natural moment), but "advance" always means
    // "next week becomes the new this week" — sending S.weekId here pins the
    // app to the week it's already on, a silent no-op. Bit me the moment this
    // moved off the old "viewing Next Week" gate; hardcoding the target
    // instead of reading it off wherever the button happens to be shown.
    const res = await api.post("/api/week/advance", { week_id: S.nextWeekId, actor_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    S.weekId = null;
    await boot();
    location.hash = afterHash;
    route();
  });
}

// A suggested meal starts as just a name — no ingredients, so it can't go on
// the shopping list yet. Checked live against S.meals (not the `draft` flag)
// so it stays accurate even for an older meal that was never marked draft.
const mealNeedsIngredients = (mealId) => {
  const m = S.meals.find((x) => x.id === mealId);
  // Takeaway/eating-out is deliberately empty — that's not a meal someone
  // forgot to finish writing, it's correctly never going to have ingredients.
  return !!m && !mealHasType(m, "takeaway") && (!m.ingredients || !m.ingredients.length);
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

// Shared by the who-picker dropdown and the login gate below — checks the
// PIN if the target has one, nags about a still-default PIN, and only sets
// S.meId once that's all actually passed. Returns false on cancel/wrong PIN
// so the caller can bail out without changing who's "logged in".
async function selectPerson(targetId) {
  const target = S.people.find((p) => p.id === targetId);
  if (target?.has_pin) {
    const result = await pinPad({
      title: `Enter ${target.name}'s PIN`,
      validate: async (digits) => {
        try {
          const { ok, pin_default } = await api.post("/api/person/verify-pin", { id: targetId, pin: digits });
          return ok ? { ok: true, extra: { pin_default } } : { ok: false, message: "Wrong PIN — try again." };
        } catch (err) {
          return { ok: false, message: OFFLINE_MSG };
        }
      },
    });
    if (!result) return false; // cancelled
    // Still on the day+month-of-birth default — nag every login until they
    // actually pick their own, but never force it (they can just skip).
    if (result.extra?.pin_default) {
      const wantsChange = await confirmDialog(
        `${target.name}, you're still using your starter PIN. Set your own now?`,
        { okLabel: "Set a new PIN", cancelLabel: "Skip for now" });
      if (wantsChange) {
        const newPin = await pinPad({ title: "Choose a new 4-digit PIN" });
        if (newPin) {
          try {
            const res = await api.post("/api/person/set-pin", { id: targetId, by: targetId, pin: newPin.digits });
            if (res.error) toast(res.error, "bad");
          } catch (err) { toast(OFFLINE_MSG, "bad"); }
        } else {
          toast("Skipped — you'll be asked again next time.");
        }
      }
    }
  }
  S.meId = targetId;
  localStorage.setItem("mealplan-me", S.meId);
  // Ratings are per-viewer (my_rating comes back scoped to whoever asked) —
  // a cached S.meals from before the switch would show the PREVIOUS person's
  // ratings as if they were the new person's, on a shared device.
  S.meals = [];
  applyTheme();
  await celebrateNewPoints(targetId);
  return true;
}

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
  // A magic vote link: ?t=<token>#/vote — the token IS the credential (same
  // trust level as this app's PINs), so this logs straight in as whoever it
  // belongs to with no PIN prompt, then drops them on Vote. Only handled once
  // per page load, and the token is stripped from the URL immediately after
  // resolving so it doesn't linger in browser history or a screenshot.
  const linkToken = new URLSearchParams(location.search).get("t");
  // Stripped from the URL straight away so it can't linger in history or a
  // screenshot. Acting on it waits until the people list is loaded, below.
  if (linkToken) history.replaceState(null, "", location.pathname + (location.hash || "#/vote"));

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
  S.weeks = b.weeks;
  S.people = b.people;
  S.aisles = b.aisles;
  S.tags = b.tags || [];
  applyTheme();

  // A magic vote link says WHO you are, and stops there. It used to sign you
  // straight in, which meant holding someone else's link walked past their
  // PIN entirely — so a kid with a sibling's link simply became that sibling.
  // Now it skips the "who's this?" list and goes straight to their PIN.
  if (linkToken && !me()) {
    try {
      const who = await api.get(`/api/person/by-token?t=${encodeURIComponent(linkToken)}`);
      if (!who.error && await selectPerson(who.id)) {
        if (!location.hash || location.hash === "#/") location.hash = "#/vote";
      }
    } catch (err) { /* offline or bad link — fall through to the normal gate */ }
  }

  // A brand-new install: nothing but the "Family" placeholder exists. Only
  // the chicken-and-egg case (the very first real person, with nobody yet
  // around to authorise adding them) needs a dedicated screen — everyone
  // after that is just the normal, already-working Settings > Family flow,
  // reached the moment this first person is signed in.
  if (S.needsSetup) {
    document.querySelector(".tabs").style.display = "none";
    document.getElementById("voteFab")?.classList.add("hidden");
    document.getElementById("view").innerHTML = `
      <div class="login-gate">
        <h1>Welcome</h1>
        <p class="subtitle">Let's get your household started. What's your name? You'll be able to
          add everyone else, and set PINs, from Settings once you're in.</p>
        <div class="card pad" style="max-width:340px;margin:0 auto">
          <label class="field"><span>Your name</span>
            <input id="setupName" placeholder="e.g. Martin" maxlength="30" autocomplete="off"></label>
          <label class="field"><span>Role</span>
            <select id="setupRole">
              <option value="parent">Parent</option>
              <option value="child">Child</option>
            </select></label>
          <button id="setupGo" class="primary" style="width:100%">Get started →</button>
        </div>
      </div>`;
    const nameInput = document.getElementById("setupName");
    nameInput.focus();
    const go = document.getElementById("setupGo");
    const submit = busy(go, async () => {
      const name = nameInput.value.trim();
      if (!name) return toast("Enter a name first.", "bad");
      const res = await api.post("/api/person", { name, role: document.getElementById("setupRole").value })
        .catch(() => null);
      if (!res || res.error) return toast(res?.error || OFFLINE_MSG, "bad");
      S.meId = res.person.id;
      localStorage.setItem("mealplan-me", S.meId);
      document.querySelector(".tabs").style.display = "";
      boot();
    });
    go.onclick = submit;
    nameInput.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    return;
  }

  // No valid remembered identity (fresh browser, cleared storage, someone
  // else's device) — don't guess. Nothing else renders until a person's
  // actually picked, PIN checked if they have one.
  if (!me()) {
    document.querySelector(".tabs").style.display = "none";
    document.getElementById("voteFab")?.classList.add("hidden");
    document.getElementById("view").innerHTML = `
      <div class="login-gate">
        <h1>Who's this?</h1>
        <p class="subtitle">Pick yourself to continue. You'll be asked for your PIN if you have one set.</p>
        <div class="gate-people">
          ${S.people.filter((p) => !p.is_placeholder).map((p) => `<button class="gate-person" data-id="${p.id}">${esc(p.name)}${p.has_pin ? " 🔒" : ""}</button>`).join("")}
        </div>
      </div>`;
    document.querySelectorAll(".gate-person").forEach((btn) => {
      btn.onclick = busy(btn, async () => {
        if (await selectPerson(+btn.dataset.id)) {
          document.querySelector(".tabs").style.display = "";
          boot();
        }
      });
    });
    return;
  }

  const who = document.getElementById("whoPicker");
  who.innerHTML = S.people
    .filter((p) => !p.is_placeholder)
    .map((p) => `<option value="${p.id}" ${p.id === S.meId ? "selected" : ""}>${esc(p.name)}${p.has_pin ? " 🔒" : ""}</option>`)
    .join("");
  who.dataset.prev = S.meId || "";
  who.onchange = busy(who, async (e) => {
    const targetId = +e.target.value;
    if (!(await selectPerson(targetId))) { who.value = who.dataset.prev; return; }
    who.dataset.prev = targetId;
    route();
  });

  S.thisWeekId = b.thisWeekId;
  S.nextWeekId = b.nextWeekId;
  S.voteWeekId = b.voteWeekId;
  S.votingOpen = b.votingOpen;
  S.weekStartDow = b.weekStartDow ?? 5;
  S.mealsTargetDefault = b.mealsTargetDefault ?? 7;
  S.protectedWeeks = b.protectedWeekIds || [];
  S.allowHistoricEdits = !!b.allowHistoricEdits;
  S.shopDone = !!b.shopDone;
  S.needsSetup = !!b.needsSetup;
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
  const view = {
    plan: viewPlan, meals: viewMeals,
    // Sub-pages reached FROM a tab but without their own nav entry — same
    // trick #/meals/new already uses to open the editor directly.
    // #/vote/extras and #/shopping/regulars are the same page — kept as two
    // URLs only so each flow can link "onward" without a tab-permission bounce.
    vote: location.hash === "#/vote/extras" ? viewRegulars : viewVote,
    shopping: location.hash === "#/shopping/regulars" ? viewRegulars : viewShopping,
    rewards: viewRewards, history: viewHistory, settings: viewSettings,
  }[tab] || viewPlan;
  Promise.resolve()
    .then(() => (S.weeks.length ? view() : boot()))
    .catch(showError);
  updateVoteFab(tab);
}

// A floating "vote now" CTA — the tab bar alone gets lost in a mobile swipe,
// so anything outstanding gets a hard-to-miss nudge instead.
async function updateVoteFab(currentTab) {
  const fab = document.getElementById("voteFab");
  // Never on Shopping: you're standing in a shop with the phone in one hand,
  // and a floating pill parked over the aisle list hides the items you're
  // trying to read. The nudge can wait until you're back on another page.
  if (!fab || !S.meId || currentTab === "vote" || currentTab === "shopping" || !S.votingOpen) {
    fab?.classList.add("hidden"); return;
  }
  try {
    // /api/poll, not the old /api/votes — that read the superseded per-day
    // `vote` table, which nothing writes to any more, so the tally came back
    // empty forever and "have I voted?" was permanently false. The nudge
    // never went away no matter how much you'd voted.
    const { tally } = await api.get(`/api/poll?id=${S.voteWeekId}&person=${S.meId}`);
    const iHaveVoted = tally.some((t) => t.mine);
    fab.classList.toggle("hidden", iHaveVoted);
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
  const canEdit = (dow) => parent && (!isPast(dow) || S.allowHistoricEdits);

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

  const dayOpts = (sel) => `<option value="">— pick a day —</option>` +
    data.days.map((d) => `<option value="${d.dow}" ${d.dow === sel ? "selected" : ""}>${esc(DAYS[d.dow])}</option>`).join("");

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
      ${weekBannerHTML(data.week.start_date)}
      <div class="actions">${parent ? `<a href="#/meals/new" class="btn-link" aria-label="Add meal" title="Add meal"><span aria-hidden="true">+</span><span class="btn-label">Add meal</span></a>` : ""}</div></header>
    ${parent ? cycleStripHTML("plan") : ""}
    ${parent ? "" : `<p class="subtitle">What's for dinner, ${esc(me()?.name || "")}. Head to <a href="#/vote">Vote</a> to ask for something.</p>`}

    ${today ? `
      <div class="today-card ${today.meal ? "" : "empty"}">
        <div class="today-when">Today · ${esc(DAYS[todayDow])} ${esc(dayNum(todayDow))}</div>
        ${today.meal
          ? `<button class="today-meal meal-peek" data-id="${today.meal.id}" title="See what's in it">${esc(today.meal.name)}</button>`
          : `<div class="today-meal none">Nothing planned yet</div>`}
        ${today.meal ? todayIngredientsHTML(today.meal.id) : ""}
        ${today.lunch ? `<div class="today-lunch">Lunch · <button class="meal-peek" data-id="${today.lunch.id}">${esc(today.lunch.name)}</button></div>
        ${todayIngredientsHTML(today.lunch.id, true)}` : ""}
      </div>` : ""}

    ${parent && S.weekId === S.thisWeekId && S.shopDone ? advanceWeekHTML() : ""}

    ${parent && pool.pool.length ? `
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
        <li class="tl-day ${d.dow === todayDow ? "is-today" : ""} ${d.meal ? "" : "is-empty"} ${isPast(d.dow) ? "is-past" : ""}" id="day-${d.dow}">
          <span class="tl-badge" data-kind="${badgeKind(d.meal)}">${dayDate(d.dow)}</span>
          <div class="tl-body">
            <p class="tl-meta">${esc(DAYS[d.dow])}${d.dow === todayDow ? ` · <span class="tl-today">Today</span>` : ""}</p>
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
                        <button class="openChange ghost" data-dow="${d.dow}" title="Change this day's meal" aria-label="Change this day's meal">🔁</button>
                        <button class="openSwap ghost" data-dow="${d.dow}" title="Move this meal to another day" aria-label="Move to another day">⇅</button>
                        <button class="unassign ghost" data-dow="${d.dow}" title="Clear this day" aria-label="Clear this day">✕</button>`
                     // An empty day can take anything from the library, not just
                     // what won the poll — "we've got a pizza in the freezer" is a
                     // perfectly good plan and used to have nowhere to go.
                     : `<select class="dayMealSelect" data-dow="${d.dow}">
                          <option value="">— nothing assigned —</option>
                          ${poolOpts}
                          ${libraryOpts}
                        </select>`}`
                : `${d.meal ? `<button class="simple-meal meal-peek" data-id="${d.meal.id}" title="See what's in it">${esc(d.meal.name)}</button>` : `<span class="simple-meal none">Not decided yet</span>`}
                     ${d.lunch ? `<span class="tl-lunch">Lunch · <button class="meal-peek" data-id="${d.lunch.id}">${esc(d.lunch.name)}</button></span>` : ""}`}
            </div>
            ${canEdit(d.dow) ? `<div class="tl-extras">
              <!-- swap picker (parents, on demand), then lunch -->
              ${canEdit(d.dow) && d.meal && S.changeOpen.has(d.dow) ? `<label class="tl-ctl"><span>Change to</span>
                 <select class="changeMealSelect" data-dow="${d.dow}">${mealChangeOpts(d.meal.id)}</select></label>` : ""}
              ${canEdit(d.dow) && d.meal && S.swapOpen.has(d.dow) ? `<label class="tl-ctl"><span>Move to</span>
                 <select class="swapDaySelect" data-dow="${d.dow}">${swapOpts(d.dow)}</select></label>` : ""}
              ${canEdit(d.dow)
                ? (d.lunch || S.lunchOpen.has(d.dow)
                    ? `<label class="tl-ctl"><span>Lunch</span>
                     <select class="kidsLunchSelect" data-dow="${d.dow}">
                       <option value="">— none —</option>
                       ${pool.kidsLunch.map((m) => `<option value="${m.id}" ${m.id === d.lunch?.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
                     </select></label>`
                    : `<button class="addLunch ghost" data-dow="${d.dow}">+ Lunch</button>`)
                : ""}
            </div>` : ""}
          </div>
        </li>`).join("")}
    </ol>

    ${parent && !pool.pool.length && data.days.some((d) => d.meal) ? `
      <a href="#/shopping" class="notice small next-step">
        ✅ <strong>Every chosen meal has a day.</strong> The shopping list is ready →
      </a>` : ""}`;

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
      await api.post("/api/week/day", {
        week_id: S.weekId, dow: +sel.value, meal_id: +sel.dataset.id, person_id: S.meId,
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
  wireAdvanceWeek("#/plan");
}

// Read-only "what's actually in this?" glance from the Plan page — the common
// question is "what do I need to get out of the freezer", not "let me edit it".
// Straight into the Today card, no tap needed — the whole point of opening
// this page is usually "what do I need out for tonight", and making that a
// second step (peek modal) was exactly the friction being removed here.
function todayIngredientsHTML(mealId, sub = false) {
  const m = S.meals.find((x) => x.id === mealId);
  const ings = m?.ingredients || [];
  // Lunch is the secondary meal on the card — if it has nothing recorded, say
  // nothing rather than repeating an empty-state under the dinner's list.
  if (!ings.length) return sub ? "" : `<p class="today-ings-empty">No ingredients recorded yet.</p>`;
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
      <label class="mini"><span>Who's it for</span>
        <select id="exEditPerson">${personOpts}</select></label>
      <label class="inline"><input type="checkbox" id="exEditRec" ${extra.recurring ? "checked" : ""}> every week</label>
    </div>
    <div class="modal-actions"><button id="exEditSave" class="primary">Save</button></div>
  `);
  const exEditSaveBtn = document.getElementById("exEditSave");
  exEditSaveBtn.onclick = busy(exEditSaveBtn, async () => {
    const item = document.getElementById("exEditItem").value.trim();
    if (!item) return toast("Needs a name.", "bad");
    await api.post("/api/extra", {
      id: extra.id, item,
      amount: +document.getElementById("exEditAmt").value,
      unit: document.getElementById("exEditUnit").value,
      aisle: document.getElementById("exEditAisle").value,
      person_id: document.getElementById("exEditPerson").value || null,
      recurring: document.getElementById("exEditRec").checked ? 1 : 0,
    });
    closeModal();
    viewRegulars();
  });
}

async function viewShopping() {
  if (!S.stores) S.stores = (await api.get("/api/stores")).stores;
  if (!S.storeId || !S.stores.some((s) => s.id === S.storeId)) {
    S.storeId = +(localStorage.getItem("mealplan-store") || 0) || S.stores[0]?.id || null;
  }
  const [{ groups: rawGroups, phase }, { extras, requests }] = await Promise.all([
    api.get(`/api/shopping?id=${S.weekId}${S.storeId ? `&store_id=${S.storeId}` : ""}`),
    api.get(`/api/extras?week_id=${S.weekId}`),
  ]);
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
        <h1>Shopping List</h1>
        ${weekBannerHTML(S.weeks.find((w) => w.id === S.weekId)?.start_date || "")}</header>
      ${cycleStripHTML("shop")}
      <div class="notice small good no-print">
        🧺 <strong>Check the cupboards</strong> — mark off what you've already got.
        Come back to this any time before you go.
        <button id="headingOutBtn" class="ghost" style="margin-left:6px">Heading to the shop →</button>
      </div>
      <div class="card">
        ${groups.map((g) => `
          <div class="aisle" style="--dot:hsl(${hue(g.aisle)} 52% 58%)">
            <h3><span class="aisle-dot"></span>${esc(g.aisle)}</h3>
            <div class="aisle-items">${g.items.map((i) => `
              <label class="row shop-row" data-key="${esc(i.key)}">
                <input type="checkbox" class="pantryCb" data-item="${esc(i.key)}" ${i.pantryChecked ? "checked" : ""}>
                <span class="qty">${esc(i.qty)}</span>
                <span class="shop-item"><span class="shop-name">${esc(i.item)}</span></span>
              </label>`).join("")}</div>
          </div>`).join("")}
      </div>`;
    document.querySelectorAll(".pantryCb").forEach((cb) => (cb.onchange = busy(cb, async () => {
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
      ...i.tags.map((t) => `<span class="tag ${t === "protein" ? "tag-protein" : ""}">${esc(t)}</span>`),
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
        <span class="shop-name">${esc(i.item)}</span>
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
      <h1>Shopping List</h1>
      ${weekBannerHTML(S.weeks.find((w) => w.id === S.weekId)?.start_date || "")}
      <div class="actions no-print">
        <button id="copyBtn" aria-label="Copy list" title="Copy list"><span aria-hidden="true">📋</span><span class="btn-label">Copy</span></button>
        ${navigator.share ? `<button id="shareBtn" aria-label="Export list" title="Export list"><span aria-hidden="true">📤</span><span class="btn-label">Export…</span></button>` : ""}
        <button onclick="window.print()" aria-label="Print list" title="Print list"><span aria-hidden="true">🖨️</span><span class="btn-label">Print</span></button>
      </div></header>
    ${cycleStripHTML("shop")}

    <button id="backToPantryBtn" class="link-toggle no-print" style="margin-bottom:8px">← Back to cupboard check</button>

    ${parent && S.weekId === S.thisWeekId && S.shopDone ? advanceWeekHTML() : ""}

    ${S.stores.length > 1 ? `<div class="notice small no-print">
        Shopping at <select id="storeSel">${S.stores.map((s) => `<option value="${s.id}" ${s.id === S.storeId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>` : ""}

    ${parent && requests.length ? `
    <section class="block no-print">
      <h2 class="sec-title">⏳ ${requests.length} request${requests.length === 1 ? "" : "s"} waiting for your OK</h2>
      <p class="subtitle">Sent from the Vote page. Approve now and it lands on the list below — before you set off.</p>
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

    <a href="#/shopping/regulars" class="notice small no-print regulars-link">
      🗂 <strong>Extras</strong> — ${extras.filter((e) => e.active).length} of ${extras.length} on this week's list · add more →
    </a>


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
        box.checked = !wanted;
        toast(OFFLINE_MSG, "bad");
        return;
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

  wireAdvanceWeek("#/shopping");
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
  const personOpts = `<option value="">Everyone</option>` +
    S.people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const aisleOpts = S.aisles.map((a) => `<option ${a === "Household" ? "selected" : ""}>${esc(a)}</option>`).join("");
  return `
    <div class="card add-extra-top no-print">
      <div class="add-quick">
        <input id="exItem" placeholder="Add an item…" list="extraNames" autocomplete="off">
        <datalist id="extraNames"></datalist>
        <button id="exAdd" class="primary">Add</button>
      </div>
      <div class="add-quick-foot">
        <span id="exAisleHint" class="aisle-hint"></span>
      </div>
      <div class="add-options" id="exOptions">
        <label class="mini"><span>How many</span>
          <input id="exAmt" type="number" value="1" min="0" step="1"></label>
        <label class="mini"><span>Sold as</span>
          <select id="exUnit"><option>unit</option><option>pack</option><option>bottle</option><option>g</option></select></label>
        <label class="mini"><span>Aisle in shop</span>
          <select id="exAisle">${aisleOpts}</select></label>
        <label class="mini"><span>Who's it for</span>
          <select id="exPerson">${personOpts}</select></label>
        <label class="inline"><input type="checkbox" id="exRec"> every week</label>
      </div>
    </div>`;
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
    exAisleHint.textContent = exItem.value.trim() ? `→ ${exAisle.value}` : "";
  };
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

    if (!isParent()) {
      if (!S.meId) return toast("Pick who you are first (top right).", "bad");
      const sent = await api.post("/api/extra-request", {
        person_id: S.meId, item, amount, unit, aisle, week_id: weekId,
      }).catch(() => null);
      if (!sent) return toast(OFFLINE_MSG, "bad");
      document.getElementById("exItem").value = "";
      return toast(`Asked for ${item} — a grown-up will add it.`, "good");
    }

    item = await confirmNewName(item);
    const added = await api.post("/api/extra", {
      item, amount, unit, aisle,
      person_id: document.getElementById("exPerson").value || null,
      recurring: document.getElementById("exRec").checked ? 1 : 0,
      week_id: weekId,
    }).catch(() => null);
    if (!added) return toast(OFFLINE_MSG, "bad");
    if (added.alreadyOnList) toast(`${item} is already on this list.`, "bad");
    onDone();
  });
}

async function viewRegulars() {
  const weekId = S.weekId;
  const parent = isParent();
  const { extras } = await api.get(`/api/extras?week_id=${weekId}`);

  document.getElementById("view").innerHTML = `
    <header class="block-head">
      <h1>Extras</h1>
      ${weekBannerHTML(S.weeks.find((w) => w.id === weekId)?.start_date || "")}</header>
    ${cycleStripHTML("shop")}

    ${addExtraHTML()}

    <div class="card">
      ${extras.map((e) => {
        const qty = e.active ? (e.qty || 1) : 0;
        return `
        <div class="row extra-row ${e.active ? "on" : ""}">
          <div class="extra-stepper">
            <button class="stepBtn stepMinus" data-id="${e.id}" data-qty="${qty - 1}"
              title="${qty <= 1 ? "Remove from this week" : "One fewer"}">−</button>
            <span class="extra-qty-val">${qty || "0"}</span>
            <button class="stepBtn stepPlus" data-id="${e.id}" data-qty="${qty + 1}" title="One more">+</button>
          </div>
          <span class="qty">${e.amount} ${esc(e.unit)} each</span>
          <span class="shop-item">${esc(e.item)}
            <span class="tag">${esc(e.person || "everyone")}</span>
            ${e.recurring ? `<span class="tag tag-protein">every week</span>` : ""}
            <span class="hint">${esc(e.aisle)}</span></span>
          ${parent ? `<span class="extra-actions">
            <button class="editExtra ghost" data-id="${e.id}" aria-label="Edit name, amount, aisle">✏️ Edit</button>
            <button class="del" data-id="${e.id}" aria-label="Delete forever from your household list">🗑 Delete</button>
          </span>` : ""}
        </div>`;
      }).join("") || `<p class="empty">Nothing yet — add your first item above.</p>`}
    </div>

    <div class="modal-actions" style="justify-content:center;margin-top:18px">
      <a href="#/shopping" class="btn-link">← Back to the shopping list</a>
    </div>`;

  // Re-rendering after every tap is the simple, always-correct option, but it
  // reflows the page. Rather than hand-patching the DOM (and risking it drift
  // out of step with the server), put the button you just pressed back exactly
  // where your finger left it. Works no matter what changed above it.
  wireAddExtra(viewRegulars, weekId);

  const keepUnderFinger = (selector, fn) =>
    document.querySelectorAll(selector).forEach((b) => (b.onclick = busy(b, async () => {
      const before = b.getBoundingClientRect().top;
      const id = b.dataset.id, cls = b.className;
      if ((await fn(b)) === false) return;
      await viewRegulars();
      const again = [...document.querySelectorAll(selector)]
        .find((x) => x.dataset.id === id && x.className === cls);
      if (again) window.scrollBy(0, Math.round(again.getBoundingClientRect().top - before));
    })));

  keepUnderFinger(".stepBtn", async (b) => {
    try {
      await api.post("/api/extra/set-qty", { week_id: S.weekId, id: +b.dataset.id, qty: +b.dataset.qty });
    } catch (err) { toast(OFFLINE_MSG, "bad"); return false; }
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
}

/* ---------------------------------------------------------------- meals */

async function viewMeals() {
  S.meals = (await api.get(`/api/meals?person=${S.meId || ""}`)).meals;
  const { tag, q, type } = S.mealFilter;
  const shown = S.meals.filter((m) =>
    (!type || mealHasType(m, type)) &&
    (!tag || (m.tags || "").split(",").includes(tag)) &&
    (!q || m.name.toLowerCase().includes(q.toLowerCase())));

  const parent = isParent();
  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Meal Library</h1>
      <div class="actions">${parent ? `<button id="newMeal" aria-label="New meal" title="New meal"><span aria-hidden="true">+</span><span class="btn-label">New meal</span></button>` : ""}</div></header>
    <p class="subtitle">${parent
      ? "Every meal the family can pick from. Add one once and it's reusable forever."
      : "Every meal the family can pick from. Only a parent can add, edit, or delete one — keeps the points system honest."}</p>

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

    <div class="meal-grid">
      ${shown.map((m) => `
        <div class="meal-card" data-id="${m.id}">
          <div class="meal-card-main">
            <div class="meal-card-head">
              <h3>${esc(m.name)}</h3>
              ${MEAL_TYPES.filter(([val]) => mealHasType(m, val))
                .map(([val, label]) => `<span class="tag ${val === "light" ? "tag-protein" : ""}">${esc(label)}</span>`).join("")}
              ${(m.tags || "").split(",").filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
              ${m.recurring ? `<span class="tag tag-protein">🔁 ${esc(S.people.find((p) => p.id === m.person_id)?.name || "Everyone")}</span>` : ""}
            </div>
            <div class="meal-card-stats">
              <span class="hint ing-preview">${m.ingredients.length
                ? esc(m.ingredients.map((i) => i.item).join(", "))
                : "no ingredients yet"}</span>
            </div>
            ${mealRatingHTML(m)}
          </div>
          <div class="meal-card-actions">
            ${parent ? `
            <button class="edit" data-id="${m.id}">Edit</button>
            <button class="del" data-id="${m.id}">Delete</button>` : ""}
          </div>
        </div>`).join("") || `<p class="empty">Nothing matches that filter.</p>`}
    </div>`;

  document.querySelectorAll(".meal-rating").forEach((el) =>
    wireMealRating(el, +el.dataset.id, viewMeals));

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
      <input class="i-item" placeholder="Ingredient" value="${esc(i.item || "")}" list="ingNames" autocomplete="off">
      <input class="i-amt" type="number" step="any" placeholder="Qty" value="${i.amount ?? ""}">
      <select class="i-unit">${["g", "ml", "unit", "pack", "tin", "jar", "bottle", "bag", "tub", "loaf"]
        .map((u) => `<option ${u === i.unit ? "selected" : ""}>${u}</option>`).join("")}</select>
      <select class="i-aisle">${aisleOpts(i.aisle)}</select>
      <button class="rm" aria-label="Remove this ingredient">✕</button>
    </div>`;

  openModal(meal ? "Edit meal" : "New meal", `
    <label class="field"><span>Meal name</span><input id="mName" value="${esc(m.name)}"></label>
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

    <div class="modal-actions"><button id="saveMeal" class="primary">Save meal</button></div>
  `);
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
  document.getElementById("addIng").onclick = () => {
    document.getElementById("ings").appendChild(el(ingRow())); wire();
  };
  document.getElementById("mRecurring").onchange = (e) => {
    document.getElementById("mRecurringForWrap").style.display = e.target.checked ? "" : "none";
  };

  const saveMealBtn = document.getElementById("saveMeal");
  saveMealBtn.onclick = busy(saveMealBtn, async () => {
    const name = document.getElementById("mName").value.trim();
    if (!name) return toast("Give the meal a name.", "bad");
    // Pull every field out to plain values before any await — confirmNewName
    // below can open its own modal per near-duplicate ingredient, which would
    // otherwise wipe out this form's DOM (and any not-yet-read rows) mid-loop.
    const rawIngredients = [...document.querySelectorAll("#ings .ing")].map((r) => ({
      item: r.querySelector(".i-item").value.trim(),
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
    });
    if (res.error) return toast(res.error, "bad");
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
  const { tally, my_veto, target } = await api.get(`/api/poll?id=${voteWeekId}&person=${S.meId || ""}`);
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
      <h1>Vote</h1>
      ${weekBannerHTML((S.weeks.find((w) => w.id === voteWeekId) || {}).start_date || "")}</header>
    ${cycleStripHTML("vote")}
    ${parent ? `<button id="voteTargetToggle" class="link-toggle" style="margin-bottom:8px" aria-expanded="false">Voting on the wrong week?</button>
    <div class="add-options hidden" id="voteTargetOptions">
      <label class="mini"><span>Vote on</span>
        <select id="voteTargetSel">${S.weeks
          .slice().sort((a, b) => a.start_date.localeCompare(b.start_date))
          .map((w) => `<option value="${w.id}" ${w.id === voteWeekId ? "selected" : ""}>${esc(fmtWeekRange(w.start_date))}${w.confirmed ? " — already decided" : ""}</option>`).join("")}
      </select></label>
      <button id="voteTargetSet" class="primary">Set</button>
      <button id="voteTargetClear" class="ghost">Back to automatic</button>
    </div>` : ""}
    <div class="notice small ${atCap ? "at-cap" : ""}">Voting as <strong>${esc(me()?.name || "nobody")}</strong>${parent ? " (parent)" : ""}. Change who you are top-right.
      <strong>${likedCount} of ${target}</strong> picks used${chosenCount ? ` · ${chosenCount} already on this week's shortlist` : ""}.
      ${atCap ? " Untick one to free up a slot." : ""}</div>
    ${S.meId ? `<a href="#/vote/extras" class="notice small extras-cta">🛒 Anything else? →</a>` : ""}
    ${!S.votingOpen ? `<div class="notice small warn">
        Voting is closed — the list for this week has been finalised.
        ${parent ? `<button id="reopenVoting" class="ghost" style="margin-left:8px">Reopen voting</button>` : ""}
      </div>` : ""}
    ${missingIngredientsAlertHTML(tally)}

    ${parent ? `<button id="voteFinalizeToggle" class="ghost overview-toggle">
      ${S.voteFinalizeOpen ? "▾ Hide finalise-the-week panel" : "▸ Finalise this week's meals"}
    </button>` : ""}
    ${parent && S.voteFinalizeOpen ? renderFinalizePanel(tally, target) : ""}

    <div class="tag-filters vote-type-filter">
      <button class="tagf ${!typeFilter ? "on" : ""}" data-typef="">All meals</button>
      ${MEAL_TYPES.filter(([val]) => val !== "kids_lunch" && val !== "takeaway").map(([val, label, plural]) => `
        <button class="tagf ${typeFilter === val ? "on" : ""}" data-typef="${val}">${esc(plural)}</button>`).join("")}
    </div>

    <div class="vote-grid">
      ${ranked.map((m, i) => {
        const isMyVeto = my_veto === m.id;
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
            <span class="vote-body">
              <span class="vote-meta">${standing}</span>
              <span class="vote-name">${esc(m.name)}</span>
              <span class="vote-tags">${m.draft ? `<span class="tag">new</span>` : ""}${m.v.chosen ? `<span class="tag tag-chosen">on shortlist</span>` : ""}${(m.tags || "").split(",").filter(Boolean)
                .map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>
            </span>
          </button>
          ${!my_veto || isMyVeto ? `<button class="veto-btn ${isMyVeto ? "on" : ""}" data-veto="${m.id}"
            title="${isMyVeto ? "Undo your veto" : "Veto — you get one"}">${isMyVeto ? "↺ undo" : "veto"}</button>` : ""}
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

  const vtToggle = document.getElementById("voteTargetToggle");
  const vtOptions = document.getElementById("voteTargetOptions");
  if (vtToggle) vtToggle.onclick = () => {
    const open = vtOptions.classList.toggle("hidden") === false;
    vtToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const vtSet = document.getElementById("voteTargetSet");
  if (vtSet) vtSet.onclick = busy(vtSet, async () => {
    const week_id = +document.getElementById("voteTargetSel").value;
    const res = await api.post("/api/week/vote-target", { week_id, actor_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewVote();
  });
  const vtClear = document.getElementById("voteTargetClear");
  if (vtClear) vtClear.onclick = busy(vtClear, async () => {
    const res = await api.post("/api/week/vote-target", { week_id: null, actor_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewVote();
  });

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
      <h3>This week's results</h3>
      <p class="hint">Tick which meals make the cut — ${target} needed this week, but that's a guide, not a hard rule.</p>
      <label class="field" style="max-width:160px"><span>Meals needed this week</span>
        <input id="mealsTargetInput" type="number" min="1" value="${target}"></label>
      <div class="overview-days"><div class="overview-day">
        ${ranked.filter((t) => t.total > 0 || t.chosen).map((t) => `
          <label class="overview-row ${t.chosen ? "applied" : ""}">
            <input type="checkbox" class="finalizeCb" data-id="${t.id}" ${t.chosen ? "checked" : ""}>
            <span class="ov-body">
              <span class="ov-meta">${t.total} vote${t.total === 1 ? "" : "s"}${t.voters ? ` · ${esc(t.voters)}` : ""}</span>
              <span class="ov-name">${esc(t.name)} ${ingredientsWarningHTML(mealNeedsIngredients(t.id))}</span>
            </span>
          </label>`).join("") || `<p class="empty">No votes yet.</p>`}
      </div></div>
      <button id="finalizeBtn" class="primary">Finalise this week's list →</button>
    </div>`;
}

function wireFinalizePanel(voteWeekId) {
  const btn = document.getElementById("finalizeBtn");
  if (!btn) return;
  btn.onclick = busy(btn, async () => {
    const meal_ids = [...document.querySelectorAll(".finalizeCb:checked")].map((c) => +c.dataset.id);
    const meals_target = +document.getElementById("mealsTargetInput").value || undefined;
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

    <h2 class="sec-title">Look &amp; feel</h2>
    <p class="subtitle">This only affects your own view.</p>
    <div class="card pad">
      ${p ? `
      <label class="row"><input type="checkbox" id="funToggle" ${p.theme === "fun" ? "checked" : ""}>
        <span class="row-label">Fun colours<span class="when">brighter, playful look instead of the plain one</span></span></label>
      <div class="row" style="align-items:flex-start">
        <span class="row-label">My colour<span class="when">picks the app's accent colour whenever you're the one signed in</span></span>
        <div class="color-swatches">
          ${KID_COLORS.map((c) => `<button class="swatch ${p.color === c ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}
          <button class="swatch swatch-clear ${!p.color ? "on" : ""}" data-color="">✕</button>
        </div>
      </div>
      ` : `<p class="empty">Pick who you are, top right.</p>`}
    </div>

    <h2 class="sec-title">My PIN</h2>
    <p class="subtitle">Stops anyone else switching to your name and voting or vetoing as you.
      Not real security — just enough to stop siblings messing about.</p>
    <div class="card pad">
      ${p ? `
      <div class="add-extra">
        <button id="pinSet">${p.has_pin ? "Change PIN" : "Set PIN"}</button>
        ${p.has_pin && isAdmin() ? `<button id="pinClear" class="ghost">Remove PIN</button>` : ""}
      </div>` : ""}
    </div>

    <h2 class="sec-title">Family</h2>
    <p class="subtitle">Parents' votes outrank children's. Anyone can be switched at any time${isAdmin() ? " — you're the household admin, so you can also promote others." : "."}</p>
    <div class="card pad">
      ${S.people.filter((x) => !x.is_placeholder).map((x) => `
        <div class="person-row-full">
          <div class="row person-row">
            <span class="row-label">${esc(x.name)}${x.is_admin ? ` <span class="tag">admin</span>` : ""}${x.pin_default ? ` <span class="tag" style="color:var(--low)">default PIN</span>` : ""}</span>
            <select class="roleSel" data-id="${x.id}" ${isAdmin() ? "" : "disabled"}>
              <option value="parent" ${x.role === "parent" ? "selected" : ""}>Parent</option>
              <option value="child"  ${x.role === "child" ? "selected" : ""}>Child</option>
            </select>
            ${isParent() ? `<button class="voteLinkBtn ghost" data-id="${x.id}" data-name="${esc(x.name)}" title="Share a link that logs straight in as ${esc(x.name)}, no PIN">🔗 Vote link</button>
              <button class="voteLinkRegen ghost" data-id="${x.id}" data-name="${esc(x.name)}" title="Kill the old link and make a new one">♻</button>
              <button class="resetVotesBtn ghost" data-id="${x.id}" data-name="${esc(x.name)}" title="Clear ${esc(x.name)}'s likes and veto for this week">↺ Reset this week's votes</button>` : ""}
            ${isAdmin() ? `<button class="adminToggle" data-id="${x.id}" data-on="${x.is_admin ? 1 : 0}">${x.is_admin ? "Remove admin" : "Make admin"}</button>` : ""}
            ${isAdmin() ? `<button class="delPerson" data-id="${x.id}" aria-label="Remove ${esc(x.name)}">✕ Delete</button>` : ""}
          </div>
          ${isAdmin() ? `<div class="color-swatches admin-color-swatches" data-id="${x.id}">
            ${KID_COLORS.map((c) => `<button class="swatch adminSwatch ${x.color === c ? "on" : ""}" data-id="${x.id}" data-color="${c}" style="background:${c}"></button>`).join("")}
            <button class="swatch swatch-clear adminSwatch ${!x.color ? "on" : ""}" data-id="${x.id}" data-color="">✕</button>
          </div>` : ""}
        </div>`).join("")}
      ${isAdmin() ? `<div class="add-extra">
        <input id="newPerson" placeholder="Add someone">
        <select id="newRole"><option value="child">Child</option><option value="parent">Parent</option></select>
        <button id="addPerson">Add</button>
      </div>` : `<p class="hint">Only the household admin can add, remove, or change roles.</p>`}
    </div>

    ${isAdmin() ? `
    <h2 class="sec-title">Household</h2>
    <p class="subtitle">Admin only. Affects everyone.</p>
    <div class="card pad">
      <label class="field"><span>Week starts on</span>
        <select id="weekStartSel">
          ${WEEKDAY_NAMES.map((n, i) => `<option value="${i}" ${i === S.weekStartDow ? "selected" : ""}>${n}</option>`).join("")}
        </select></label>
      <label class="field"><span>Meals needed per week (default)</span>
        <input id="mealsTargetSel" type="number" min="1" value="${S.mealsTargetDefault}"></label>
      <p class="hint">Can still be bumped up for one busy or holiday week from the Vote page.</p>
      <label class="field field-check"><span>Allow historic edits</span>
        <input id="historicEditsChk" type="checkbox" ${S.allowHistoricEdits ? "checked" : ""}></label>
      <p class="hint">Off by default: days that have already been and gone show as read-only history
        on the Plan. Turn on to correct something after the fact.</p>
    </div>

    <h2 class="sec-title">Shopping Stores</h2>
    <p class="subtitle">Admin only. Each store keeps its own aisle order — reorder them by dragging section
      headings on the Shopping page once you've picked a store there.</p>
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
    <p class="subtitle">Admin only. Choose which pages each person sees — for anyone, including yourself.
      Leave everything ticked for "no restriction" (the default for everyone right now).</p>
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
      <p class="subtitle">You've chosen not to run backups. An export is still worth taking
        occasionally — drop it on the Samba share and it costs nothing.</p>
      <a class="btn-link" href="/api/export" download>Download full export (JSON)</a>
    </div>`;

  if (!p) return;

  document.querySelectorAll(".roleSel").forEach((sel) => (sel.onchange = busy(sel, async () => {
    const person = S.people.find((x) => x.id === +sel.dataset.id);
    const res = await api.post("/api/person", { id: person.id, name: person.name, role: sel.value, admin_id: S.meId });
    if (res.error) return toast(res.error, "bad");
    await boot(); viewSettings();
  })));
  document.querySelectorAll(".voteLinkBtn").forEach((b) => (b.onclick = busy(b, async () => {
    const res = await api.get(`/api/person/link?id=${b.dataset.id}&admin_id=${S.meId}`);
    if (res.error) return toast(res.error, "bad");
    const url = `${location.origin}${location.pathname}?t=${res.token}#/vote`;
    const forThem = S.people.find((p) => p.id === +b.dataset.id);
    const note = forThem?.has_pin
      ? `Opens straight to ${b.dataset.name}'s own login — they still need their PIN, so it's fine even if someone else gets hold of it.`
      : `Opens straight in as ${b.dataset.name} — they don't have a PIN set, so anyone with this link does too.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Vote now", text: `Vote now for next week: ${url}` });
        return;
      } catch { /* dismissed, or not allowed — show the link instead */ }
    }
    shareLinkDialog(`${b.dataset.name}'s vote link`, url, note);
  })));
  document.querySelectorAll(".voteLinkRegen").forEach((b) => (b.onclick = busy(b, async () => {
    if (!(await confirmDialog(
        `Any link already sent to ${b.dataset.name} stops working. Only do this if the old one leaked or went to the wrong person.`,
        { title: `Replace ${b.dataset.name}'s vote link?`, danger: true, okLabel: "Replace it" }))) return;
    const r = await api.post("/api/person/link/regenerate", { id: +b.dataset.id, admin_id: S.meId });
    if (r.error) return toast(r.error, "bad");
    toast(`Done — tap 🔗 Vote link to get ${b.dataset.name}'s new one.`, "good");
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
    if (S.meId === +b.dataset.id) { S.meId = null; localStorage.removeItem("mealplan-me"); }
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

  const funToggle = document.getElementById("funToggle");
  if (funToggle) funToggle.onchange = busy(funToggle, async () => {
    await api.post("/api/person", { id: p.id, actor_id: S.meId, theme: funToggle.checked ? "fun" : "classic" });
    await boot(); applyTheme(); viewSettings();
  });
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

  const pinSet = document.getElementById("pinSet");
  if (pinSet) pinSet.onclick = busy(pinSet, async () => {
    const entry = await pinPad({ title: p.has_pin ? "Choose a new 4-digit PIN" : "Choose a 4-digit PIN" });
    if (!entry) return;
    try {
      const res = await api.post("/api/person/set-pin", { id: p.id, by: p.id, pin: entry.digits });
      if (res.error) return toast(res.error, "bad");
    } catch (err) { return toast(OFFLINE_MSG, "bad"); }
    await boot(); viewSettings();
  });
  const pinClear = document.getElementById("pinClear");
  if (pinClear) pinClear.onclick = busy(pinClear, async () => {
    if (!(await confirmDialog(`Remove ${p.name}'s PIN? Anyone will be able to switch to them with no PIN check.`,
        { danger: true, okLabel: "Remove PIN" }))) return;
    try { await api.post("/api/person/clear-pin", { id: p.id, admin_id: p.id }); }
    catch (err) { return toast(OFFLINE_MSG, "bad"); }
    await boot(); viewSettings();
  });

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

}

/* ---------------------------------------------------------------- rewards */

async function viewRewards() {
  const { balances, catalog, requests, myBalance, healthyTags } =
    await api.get(`/api/rewards?person=${S.meId || ""}`);
  const parent = isParent();
  const nameOf = (id) => S.people.find((p) => p.id === id)?.name || "?";
  const pending = requests.filter((r) => r.status === "pending");

  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Rewards</h1></header>
    <p class="subtitle">A point for every vote that lands on a healthy-tagged meal.
      Bank enough and cash them in for a treat a parent approves.</p>

    <div class="reward-balance-card">
      <div class="reward-balance-big">${myBalance}</div>
      <div class="hint">points banked for ${esc(me()?.name || "you")}</div>
    </div>

    <h2 class="sec-title">Redeem</h2>
    <div class="reward-grid">
      ${catalog.map((r) => `
        <div class="reward-card ${myBalance >= r.points_cost ? "" : "locked"}">
          <div class="reward-name">${esc(r.name)}</div>
          <div class="reward-cost">${r.points_cost} pts</div>
          ${r.suggested_budget_gbp ? `<div class="hint">up to ~£${r.suggested_budget_gbp} suggested</div>` : ""}
          <button class="redeemBtn" data-id="${r.id}" ${myBalance >= r.points_cost ? "" : "disabled"}>
            ${myBalance >= r.points_cost ? "Request this" : `Need ${r.points_cost - myBalance} more`}
          </button>
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
        <div class="row"><span class="row-label">${esc(p.name)}</span><span class="grams">${balances[p.id] || 0} pts</span></div>`).join("")}
    </div>

    ${isAdmin() ? `
    <h2 class="sec-title">What counts as healthy?</h2>
    <p class="subtitle">Admin only. Points are earned for votes that win on a meal carrying any of these tags.</p>
    <div class="card pad">
      <div class="tag-picker">
        ${S.tags.map((t) => `<label class="inline tag-opt">
          <input type="checkbox" class="healthyTagCb" value="${esc(t)}" ${healthyTags.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")}
      </div>
    </div>

    <h2 class="sec-title">Reward catalog</h2>
    <p class="subtitle">Admin only. The point costs and a suggested (not enforced) budget.</p>
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
  const { weeks } = await api.get("/api/history");
  const admin = isAdmin();
  document.getElementById("view").innerHTML = `
    <header class="block-head"><h1>Past Weeks</h1></header>
    <p class="subtitle">Every week you've planned. Reuse one as the starting point for a new week.
      ${admin ? "As admin, you can also delete a week — useful for cleaning up ones left mismatched after changing the week-start day." : ""}</p>
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
