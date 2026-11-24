/* ==========================================================================
   common.js — helpers every page uses. Loaded first on each page; the page's
   own script (home.js, framework.js, signal.js, learn.js) loads after it.

   Everything hangs off one object called `Site`.
   Colors and fonts are NOT set here: they are read from style.css
   (the --names at the top of that file), so the look lives in one place.
   ========================================================================== */

const Site = {
  SCHEMA: 4,                                // the data-file version these pages expect
  pages: {},                                // each page script adds its start function here

  /* Download one of the JSON files the Python pipeline writes.
     The ?v=... part makes the browser fetch a fresh copy every time. */
  async loadJSON(path) {
    let res;
    try {
      res = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
    } catch (e) {
      throw new Error(`Could not reach ${path}. If you opened the page by double-clicking the file, start it with "python preview.py" instead.`);
    }
    if (!res.ok) throw new Error(`${path} is missing (HTTP ${res.status}). Run "python update.py" in the pipeline folder to create it.`);
    const data = await res.json();
    if ((data.schema || 0) < Site.SCHEMA) {
      throw new Error(`${path} was made by an older version of the site. Run "python update.py" in the pipeline folder to rebuild it.`);
    }
    return data;
  },

  /* Read a value defined in style.css, e.g. Site.css("--c-plan"). */
  css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },
  cssNum(name, fallback = 0) {
    const v = parseFloat(Site.css(name));
    return Number.isFinite(v) ? v : fallback;
  },
  /* "#2a78d6" + 0.3 -> "rgba(42,120,214,0.3)" (a see-through version of a color) */
  alpha(hex, a) {
    const h = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  },

  /* ---------- number and date formatting ---------- */
  money(x) {
    if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
    if (x >= 1e4) return `$${Math.round(x / 1e3)}K`;
    return `$${Math.round(x).toLocaleString("en-US")}`;
  },
  moneyFull(x) { return `$${Math.round(x).toLocaleString("en-US")}`; },
  pct(x, digits = 1, signed = false) {
    if (x === null || x === undefined || Number.isNaN(x)) return "–";
    return `${signed && x > 0 ? "+" : ""}${x.toFixed(digits).replace("-", "−")}%`;
  },
  num(x, digits = 0) {
    if (x === null || x === undefined) return "–";
    return x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  monthLabel(m, long = false) {             // "2026-10" -> "Oct 2026"
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleString("en-US", { month: long ? "long" : "short", year: "numeric" });
  },
  yearSpan(a, b) {                          // "2000-09", "2003-03" -> "2000–03"
    const y1 = a.slice(0, 4), y2 = b.slice(0, 4);
    return y1 === y2 ? y1 : `${y1}–${y2.slice(2)}`;
  },

  /* Group 0/1 flags into periods [{i, j}], treating gaps of up to `maxGap` months as one period. */
  periods(flags, maxGap = 2) {
    const out = [];
    let i = 0;
    while (i < flags.length) {
      if (!flags[i]) { i++; continue; }
      let j = i;
      while (j + 1 < flags.length && flags[j + 1]) j++;
      const prev = out.at(-1);
      if (prev && i - prev.j - 1 <= maxGap) prev.j = j; else out.push({ i, j });
      i = j + 1;
    }
    return out;
  },

  /* ---------- small DOM helpers ---------- */
  el(id) { return document.getElementById(id); },
  setText(id, text) { const e = Site.el(id); if (e) e.textContent = text; },
  /* Create an element: Site.make("span", "pill good", "Hold") */
  make(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  },
  icon(kind) {
    const paths = {
      check: '<path d="M5 12l5 5 9-10" />',
      alert: '<path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" />',
      down: '<path d="M12 5v14M6 13l6 6 6-6" />',
      up: '<path d="M12 19V5M6 11l6-6 6 6" />',
      shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />',
      play: '<path d="M8 5l11 7-11 7z" />',
      pause: '<path d="M9 5v14M15 5v14" />',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
  },
  /* Build a table body from rows of cell values (text only, so data can never inject HTML). */
  fillTable(tbody, rows) {
    tbody.replaceChildren();
    for (const cells of rows) {
      const tr = document.createElement("tr");
      for (const c of cells) {
        const cell = typeof c === "object" && c !== null ? c : { text: c };
        const td = Site.make("td", cell.cls || "", cell.text);
        if (cell.sub) td.appendChild(Site.make("small", "cell-sub", cell.sub));       // an optional second, smaller line
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  },
  /* The two warning lamps (used on the home page and the signal page).
     state: true = warning on, false = off. */
  setLamp(id, on, text) {
    const e = Site.el(id);
    if (!e) return;
    e.dataset.state = on ? "on" : "off";
    const t = e.querySelector(".lamp-state");
    if (t) t.textContent = text;
  },

  /* Turn the signal data into one plain-English status. Used by the home page and the signal page.
     Returns { kind: "good" | "warn" | "bad", icon, title, means }. */
  status(sig) {
    const o = sig.official, pv = sig.provisional, cur = pv || o, month = o.month_label;
    if (o.action === "sell") return { kind: "bad", icon: "down", title: "Sell signal: step aside",
      means: `At the ${month} check both warning signs were on. On the next trading day each option sells its set amount and moves that money into Treasuries and T-bills.` };
    if (o.action === "buy back") return { kind: "good", icon: "up", title: "Buy signal: get back in",
      means: `At the ${month} check the S&P 500 closed back above its 10-month average. On the next trading day every option goes back to fully invested.` };
    if (o.invested === 1) {
      if (pv && pv.would_be === "sell") return { kind: "bad", icon: "alert", title: "A sell signal is building",
        means: "Both warning signs are on so far this month. If the month ended today, the signal would say step aside. Nothing happens until the month-end check." };
      if (cur.trend_broken || cur.warning) {
        const which = cur.trend_broken ? "The stock market's trend is down" : "The recession warning is on";
        const other = cur.trend_broken ? "the recession warning" : "a broken trend";
        return { kind: "warn", icon: "alert", title: "Stay invested: one warning sign is on",
          means: `${which}, but it takes both signs before anything is sold. Nothing to do unless ${other} shows up too.` };
      }
      return { kind: "good", icon: "check", title: "All clear: stay fully invested",
        means: "Neither warning sign is on. Every option stays fully invested." };
    }
    if (pv && pv.would_be === "buy back") return { kind: "good", icon: "up", title: "Recovery building: a buy-back is likely",
      means: "The S&P 500 is back above its 10-month average so far this month. If it stays there through month-end, every option goes back to fully invested." };
    return { kind: "warn", icon: "shield", title: "Stepped aside: waiting for the trend to recover",
      means: "Each option holds its stepped-aside mix until the S&P 500 closes a month back above its 10-month average." };
  },
  /* Where things stand right now, in a few words. kind: "good" = green, "warn" = amber. */
  position(sig) {
    const o = sig.official, pv = sig.provisional, cur = pv || o;
    const on = (cur.trend_broken ? 1 : 0) + (cur.warning ? 1 : 0);
    const count = `${on} of 2 warning signs ${on === 1 ? "is" : "are"} on`;
    if (o.invested === 1) {
      if (on === 2) return { kind: "warn", state: "Fully invested", detail: `${count} so far this month.`, note: "A sale happens only if both hold at the month-end check." };
      return { kind: "good", state: "Fully invested", detail: `${count}.`, note: "It takes both to sell." };
    }
    if (pv && pv.would_be === "buy back") return { kind: "warn", state: "Stepped aside", detail: "The S&P 500 is back above its 10-month average so far this month.", note: "A buy-back happens if that holds at month-end." };
    return { kind: "warn", state: "Stepped aside", detail: "Waiting for the S&P 500 to close a month above its 10-month average.", note: "" };
  },
  /* Fill in the strip under the menu. It stays hidden if the signal file can't be read. */
  setStatusBar(sig) {
    const bar = Site.el("statusbar");
    if (!bar || !sig || !sig.official) return;
    const p = Site.position(sig);
    bar.classList.add(p.kind);
    Site.setText("sb-state", p.state);
    Site.setText("sb-detail", p.detail);
    Site.setText("sb-note", p.note);
    bar.hidden = false;
  },
  /* Light the two warning lamps from the freshest reading. */
  setLamps(sig) {
    const cur = sig.provisional || sig.official;
    Site.setLamp("lamp-trend", cur.trend_broken, cur.trend_broken ? "Yes" : "No");
    Site.setLamp("lamp-curve", cur.warning, cur.warning ? "Yes" : "No");
  },

  /* Show a readable message at the top of the page when something fails. */
  showError(err) {
    const box = Site.make("div", "error");
    box.setAttribute("role", "alert");
    box.textContent = `This page couldn't finish loading. ${err.message || err}`;
    (document.querySelector("main") || document.body).prepend(box);
    console.error(err);
  },
  /* Run a list of [name, function] steps. One failing step doesn't stop the others. */
  runSteps(steps) {
    const failed = [];
    for (const [name, fn] of steps) {
      try { fn(); } catch (e) { failed.push(name); console.error(`Step "${name}" failed:`, e); }
    }
    if (failed.length) Site.showError(new Error(`These parts hit a problem: ${failed.join(", ")}. Try a hard refresh (Ctrl+F5). If it keeps happening, run "python update.py" again.`));
  },

  /* ---------- charts ---------- */

  /* Shades the months when the plan stepped aside. options.plugins.bands:
       flags = 0/1 per point, color = fill color,
       months = month labels (optional; with it, long periods get a year label like "2000–03") */
  bandPlugin: {
    id: "bands",
    beforeDatasetsDraw(chart, _args, opts) {
      const flags = opts.flags;
      if (!flags || !flags.length) return;
      const { ctx, chartArea: area, scales: { x } } = chart;
      const half = (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2;
      ctx.save();
      ctx.fillStyle = opts.color;
      for (const p of Site.periods(flags, 0)) {
        const left = Math.max(area.left, x.getPixelForValue(p.i) - half);
        const right = Math.min(area.right, x.getPixelForValue(p.j) + half);
        ctx.fillRect(left, area.top, Math.max(right - left, 1.5), area.bottom - area.top);
      }
      if (opts.months) {
        ctx.fillStyle = Site.css("--c-ink-2");
        ctx.font = `600 11px ${Site.css("--font-ui")}`;
        ctx.textAlign = "center";
        let lastRight = -1e9;
        for (const p of Site.periods(flags)) {
          if (p.j - p.i + 1 < 6) continue;
          const text = Site.yearSpan(opts.months[p.i], opts.months[p.j]);
          const mid = (x.getPixelForValue(p.i) + x.getPixelForValue(p.j)) / 2;
          const w = ctx.measureText(text).width;
          if (mid - w / 2 < lastRight + 6) continue;          // never let two labels touch
          ctx.fillText(text, mid, area.top - 7);
          lastRight = mid + w / 2;
        }
      }
      ctx.restore();
    },
  },

  /* Vertical hairline at the month you're pointing at. */
  crosshairPlugin: {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const active = chart.getActiveElements();
      if (!active.length) return;
      const { ctx, chartArea: area } = chart;
      const x = active[0].element.x;
      ctx.save();
      ctx.strokeStyle = Site.css("--c-ink-3");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      ctx.restore();
    },
  },

  /* A dot at the end of each line with its latest value beside it. Labels that would overlap are nudged apart. */
  endLabelPlugin: {
    id: "endLabels",
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts.format) return;
      const { ctx, chartArea: area } = chart;
      const labels = [];
      chart.data.datasets.forEach((ds, i) => {
        if (ds.endLabel === false || !chart.isDatasetVisible(i)) return;
        const n = ds.data.length;
        const pt = chart.getDatasetMeta(i).data[n - 1];
        if (!pt || n === 0) return;
        labels.push({ x: pt.x, y: pt.y, dotY: pt.y, color: ds.borderColor, text: opts.format(ds.data[n - 1]) });
      });
      labels.sort((a, b) => a.y - b.y);
      for (let k = 1; k < labels.length; k++) {
        if (labels[k].y - labels[k - 1].y < 15) labels[k].y = labels[k - 1].y + 15;
      }
      ctx.save();
      for (const l of labels) {
        ctx.beginPath();
        ctx.arc(l.x, l.dotY, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = l.color;
        ctx.strokeStyle = Site.css("--c-surface");
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        if (l.x + 12 > area.right + 70) continue;
        ctx.fillStyle = Site.css("--c-ink");
        ctx.font = `600 12px ${Site.css("--font-num")}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(l.text, l.x + 9, l.y);
      }
      ctx.restore();
    },
  },

  /* Settings shared by every chart: fonts, gridlines, tooltip look. */
  baseOptions() {
    const ink2 = Site.css("--c-ink-2"), ink3 = Site.css("--c-ink-3");
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { right: 8, top: 4 } },
      plugins: {
        legend: { display: false },          // each page draws its own legend in HTML
        tooltip: {
          backgroundColor: Site.css("--c-tip"),
          titleColor: ink2,
          bodyColor: Site.css("--c-ink"),
          borderColor: Site.css("--c-axis"),
          borderWidth: 1,
          padding: 10,
          cornerRadius: Site.cssNum("--tip-radius", 8),
          usePointStyle: true,
          boxWidth: 14,
          boxHeight: 3,
          titleFont: { weight: "normal", family: Site.css("--font-ui") },
          bodyFont: { weight: "600", family: Site.css("--font-num") },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: Site.css("--c-axis") },
          ticks: { color: ink3, autoSkip: false, maxRotation: 0, font: { family: Site.css("--font-num"), size: 11 } },
        },
        y: {
          grid: { color: Site.css("--c-grid") },
          border: { display: false },
          ticks: { color: ink3, font: { family: Site.css("--font-num"), size: 11 } },
        },
      },
    };
  },

  /* x-axis labels: show just the year on each January, every `step` years. */
  yearTicks(months, step) {
    return (value) => {
      const m = months[value];
      if (!m || !m.endsWith("-01")) return "";
      const y = Number(m.slice(0, 4));
      return y % step === 0 ? String(y) : "";
    };
  },
  /* How many years between x-axis labels, so they never crowd: based on how much history is shown
     and how wide the chart is on this screen. */
  yearStep(count, canvasId) {
    const box = canvasId && Site.el(canvasId) ? Site.el(canvasId).parentElement : null;   // the chart's box is already laid out; the canvas itself isn't sized yet
    const width = Math.max(160, (box ? box.clientWidth : 900) - 130);
    const years = count / 12, room = Math.max(2, Math.floor(width / 40));
    return [1, 2, 3, 5, 10, 20].find((step) => years / step <= room) || 25;
  },

  /* A line in one of the style.css colors. */
  line(label, values, colorVar, extra = {}) {
    const color = Site.css(colorVar);
    return Object.assign({
      label, data: values,
      borderColor: color, backgroundColor: color,
      pointBackgroundColor: color, pointHoverBackgroundColor: color,
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointStyle: "line",
      pointHoverBorderColor: Site.css("--c-surface"), pointHoverBorderWidth: 2,
      borderJoinStyle: "round", borderCapStyle: "round",
    }, extra);
  },

  /* Keeps one Chart.js chart per canvas: redrawing replaces the old one. */
  charts: {},
  draw(id, type, data, options) {
    if (Site.charts[id]) Site.charts[id].destroy();
    Site.charts[id] = new Chart(Site.el(id), { type, data, options });
    return Site.charts[id];
  },

  markActiveNav() {
    const here = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".nav a.link").forEach((a) => {
      if (a.getAttribute("href") === here) a.setAttribute("aria-current", "page");
    });
  },

  /* Runs once the page's HTML is ready: starts the script for this page. */
  async start() {
    Site.markActiveNav();
    Site.loadJSON("data/signal.json").then(Site.setStatusBar).catch(() => {});      // the strip is a bonus: never block the page on it
    const page = document.body.dataset.page;
    const init = Site.pages[page];
    if (!init) return;
    try {
      if (document.body.dataset.charts === "yes") {
        if (!window.Chart) throw new Error("The chart library didn't load. Check your internet connection, then refresh.");
        Chart.register(Site.bandPlugin, Site.crosshairPlugin, Site.endLabelPlugin);
        Chart.defaults.font.family = Site.css("--font-ui");
        if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
      }
      await init();
    } catch (err) {
      Site.showError(err);
    }
  },
};

document.addEventListener("DOMContentLoaded", () => Site.start());
