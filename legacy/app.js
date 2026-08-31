const STORAGE_KEY = "mealplan-v2";

let checks = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(checks));
}

function isChecked(id, defaultVal) {
  return checks[id] === undefined ? defaultVal : checks[id];
}

/* ---------- protein maths ---------- */

// Every line on a day, in the order you'd eat it, with whether it's ticked.
function dayRows(d) {
  const training = isChecked(`${d.day}-training`, false);
  const rows = [];

  Object.values(ROUTINE).forEach((r) => {
    if (r.trainingOnly && !training) return;
    if (r.key === "shake1" || r.key === "shake2") return; // appended last
    rows.push({ id: `${d.day}-${r.key}`, label: r.label, when: r.when, protein: r.protein, defaultOn: r.defaultOn });
  });

  d.plate.forEach((p, i) => {
    rows.push({ id: `${d.day}-plate${i}`, label: p.label, when: d.meal, protein: p.protein, defaultOn: true });
  });

  rows.push({ id: `${d.day}-boost`, label: d.boost.label, when: "boost", protein: d.boost.protein, defaultOn: true });

  ["shake1", "shake2"].forEach((k) => {
    const r = ROUTINE[k];
    rows.push({ id: `${d.day}-${k}`, label: r.label, when: r.when, protein: r.protein, defaultOn: false });
  });

  return { training, rows };
}

function dayTotals(d) {
  const { training, rows } = dayRows(d);
  let eaten = 0;
  let available = 0;
  rows.forEach((r) => {
    if (isChecked(r.id, r.defaultOn)) eaten += r.protein;
    else available += r.protein;
  });
  return { training, rows, eaten, available, ceiling: eaten + available };
}

/* ---------- shopping list ---------- */

function formatQty(amount, unit) {
  if (unit === "g") return amount >= 1000 ? `${+(amount / 1000).toFixed(1)}kg` : `${amount}g`;
  if (unit === "unit") return `× ${amount}`;
  const plural = amount === 1 ? unit : unit + "s";
  return `${amount} ${plural}`;
}

// Items the plan needs that aren't tied to one dinner: eggs, shakes, puddings.
// Counts follow whatever you've actually ticked, so they stay honest.
function routineShopping() {
  let eggs = 0;
  let puddings = 0;
  let shakes = 0;
  let tomatoes = 0;
  let trainingDays = 0;

  WEEK.forEach((d) => {
    const { training, rows } = dayRows(d);
    if (training) trainingDays++;
    rows.forEach((r) => {
      if (!isChecked(r.id, r.defaultOn)) return;
      if (r.id.endsWith("-omelette")) { eggs += 3; tomatoes += 1; }
      if (r.id.endsWith("-preGym")) eggs += 2;
      if (r.id.endsWith("-postGym") || r.id.endsWith("-shake1") || r.id.endsWith("-shake2")) shakes++;
    });
    // plate eggs (Sunday's boiled eggs) come from the plate rows
    d.plate.forEach((p, i) => {
      if (/\begg/i.test(p.label) && isChecked(`${d.day}-plate${i}`, true)) {
        eggs += parseInt(p.label, 10) || 0;
      }
    });
    if (isChecked(`${d.day}-boost`, true) && d.boost.buy === "Protein pudding") puddings++;
  });

  const list = [
    { item: "Eggs", amount: eggs, unit: "unit", forYou: true },
    { item: "Tomatoes", amount: tomatoes, unit: "unit", forYou: true },
  ];
  if (puddings) list.push({ item: "Protein pudding", amount: puddings, unit: "unit", forYou: true });
  if (shakes) list.push({ item: "Whey protein", amount: 1, unit: "tub", forYou: true, note: `${shakes} shakes this week` });
  if (trainingDays) list.push({ item: "Sliced bread", amount: 1, unit: "loaf", forYou: true, note: "for egg-in-a-basket" });

  // Boosts that are a bought item rather than a bigger portion
  const boostBuys = {};
  WEEK.forEach((d) => {
    if (!isChecked(`${d.day}-boost`, true)) return;
    if (!d.boost.buy || d.boost.buy === "Protein pudding") return;
    boostBuys[d.boost.buy] = (boostBuys[d.boost.buy] || 0) + 1;
  });
  Object.entries(boostBuys).forEach(([item, n]) => {
    list.push({ item, amount: n, unit: "tin", forYou: true });
  });

  return list;
}

function buildShopping() {
  const totals = {}; // item -> { amount, unit, forYou, note }

  const add = (entry) => {
    const key = entry.item;
    if (!totals[key]) {
      totals[key] = { amount: 0, unit: entry.unit, forYou: !!entry.forYou, note: entry.note };
    }
    totals[key].amount += entry.amount;
    if (entry.forYou) totals[key].forYou = true;
    if (entry.note) totals[key].note = entry.note;
  };

  WEEK.forEach((d) => d.shopping.forEach(add));
  routineShopping().forEach(add);

  // Group by aisle, in walk-the-store order
  const byAisle = {};
  Object.entries(totals).forEach(([item, t]) => {
    if (t.amount <= 0) return;
    const aisle = AISLE_OF[item] || "Cupboard";
    (byAisle[aisle] = byAisle[aisle] || []).push({ item, ...t });
  });
  Object.values(byAisle).forEach((arr) => arr.sort((a, b) => a.item.localeCompare(b.item)));

  return AISLES.filter((a) => byAisle[a]).map((a) => ({ aisle: a, items: byAisle[a] }));
}

function shoppingAsText() {
  return buildShopping()
    .map(({ aisle, items }) => {
      const lines = items.map((i) => `  ${formatQty(i.amount, i.unit)}  ${i.item}`);
      return `${aisle.toUpperCase()}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/* ---------- rendering ---------- */

function renderShopping() {
  const groups = buildShopping();
  document.getElementById("shoppingList").innerHTML = groups
    .map(
      ({ aisle, items }) => `
      <div class="aisle">
        <h3>${aisle}</h3>
        ${items
          .map((i) => {
            const id = `shop-${i.item}`;
            const hint = PACK_HINT[i.item] ? `<span class="hint">${PACK_HINT[i.item]}</span>` : "";
            const note = i.note ? `<span class="hint">${i.note}</span>` : "";
            return `
            <label class="row shop-row">
              <input type="checkbox" data-id="${id}" ${checks[id] ? "checked" : ""}>
              <span class="qty">${formatQty(i.amount, i.unit)}</span>
              <span class="shop-item">${i.item}${i.forYou ? '<span class="tag">protein</span>' : ""}${hint}${note}</span>
            </label>`;
          })
          .join("")}
      </div>`
    )
    .join("");
}

function renderSummary() {
  document.getElementById("weekSummary").innerHTML = WEEK.map((d) => {
    const { eaten, training } = dayTotals(d);
    const cls = eaten < CONFIG.targetMin ? "pill-under" : eaten > CONFIG.targetMax ? "pill-over" : "pill-good";
    return `<a class="pill ${cls}" href="#day-${d.short}">
      <span class="pill-day">${d.short}${training ? " ●" : ""}</span>
      <span class="pill-g">${eaten}g</span>
    </a>`;
  }).join("");
}

function renderDays() {
  document.getElementById("days").innerHTML = WEEK.map((d) => {
    const { training, rows, eaten, available, ceiling } = dayTotals(d);
    const target = CONFIG.targetMin;

    const eatenPct = Math.min(100, (eaten / target) * 100);
    const availPct = Math.min(100 - eatenPct, (available / target) * 100);

    let status, statusClass;
    if (eaten < CONFIG.targetMin) {
      const short = CONFIG.targetMin - eaten;
      status =
        ceiling >= CONFIG.targetMin
          ? `${short}g short — ${available}g still on the plan today`
          : `${short}g short, and only ${available}g left available`;
      statusClass = ceiling >= CONFIG.targetMin ? "status-under" : "status-bad";
    } else if (eaten > CONFIG.targetMax) {
      status = `${eaten - CONFIG.targetMax}g over — drop a shake`;
      statusClass = "status-over";
    } else {
      status = "on target";
      statusClass = "status-good";
    }

    const rowHtml = rows
      .map(
        (r) => `
      <label class="row">
        <input type="checkbox" data-id="${r.id}" ${isChecked(r.id, r.defaultOn) ? "checked" : ""}>
        <span class="row-label">${r.label}<span class="when">${r.when}</span></span>
        <span class="grams">${r.protein}g</span>
      </label>`
      )
      .join("");

    return `
    <section class="day" id="day-${d.short}">
      <div class="day-header">
        <h2>${d.day} <span class="meal">${d.meal}</span></h2>
        <span class="carb-flag ${d.carb === "swap" ? "flag-swap" : "flag-ok"}">
          ${d.carb === "swap" ? "swap the carb" : "carb ok"}
        </span>
      </div>
      <p class="carb-note">${d.carbNote}</p>

      <label class="row training-row">
        <input type="checkbox" data-id="${d.day}-training" ${training ? "checked" : ""}>
        <span class="row-label">Training day</span>
        <span class="grams">+39g</span>
      </label>

      ${rowHtml}

      <div class="total-bar">
        <div class="bar-eaten" style="width:${eatenPct}%"></div>
        <div class="bar-avail" style="width:${availPct}%"></div>
      </div>
      <div class="total-line">
        <span class="total-text">${eaten}g eaten<span class="sep">·</span>${available}g left<span class="sep">·</span>max ${ceiling}g</span>
        <span class="status-text ${statusClass}">${status}</span>
      </div>
    </section>`;
  }).join("");
}

function render() {
  renderShopping();
  renderSummary();
  renderDays();

  document.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      checks[e.target.dataset.id] = e.target.checked;
      save();
      render();
    });
  });
}

/* ---------- actions ---------- */

document.getElementById("copyBtn").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(shoppingAsText());
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy list"), 1500);
});

document.getElementById("newWeekBtn").addEventListener("click", () => {
  if (confirm("Start a new week? This clears all ticks, including the shopping list.")) {
    checks = {};
    save();
    render();
  }
});

render();
