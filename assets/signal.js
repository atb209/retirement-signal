/* ==========================================================================
   signal.js — the Signal now page (signal.html), filled from data/signal.json.

   Two kinds of reading:
     official    = the last completed month-end check. This is the real signal.
     provisional = "if the month ended today", refreshed every weekday.
   The page leads with the freshest reading, in plain words.
   ========================================================================== */

Site.pages.signal = async function () {
  const sig = await Site.loadJSON("data/signal.json");
  Site.runSteps([
    ["the status", () => renderStatus(sig)],
    ["the two warning signs", () => renderChecks(sig)],
    ["the charts", () => renderCharts(sig)],
    ["the four options", () => renderOptions(sig)],
    ["the update note", () => renderFooter(sig)],
  ]);
};

/* What each of the four options holds at the moment, and what it would switch to on the next signal. */
function renderOptions(sig) {
  const body = Site.el("options-now");
  if (!body || !sig.options) return;
  const invested = sig.official.invested === 1;
  Site.setText("options-intro", invested
    ? "The signal says stay invested, so every option is fully invested. They only differ in what they would do on a sell signal."
    : "The signal says step aside, so each option is holding its own stepped-aside mix until the buy-back signal.");
  Site.setText("options-th-next", invested ? "On a sell signal it would hold" : "On the buy-back signal it would hold");
  Site.fillTable(body, sig.options.map((x) => [x.name, invested ? x.invested : x.aside, invested ? x.aside : x.invested]));
}

function setPill(el, kind, icon, text) {
  if (!el) return;
  el.className = `pill ${kind}`;
  el.innerHTML = Site.icon(icon) + "<span></span>";
  el.querySelector("span").textContent = text;
}

/* ---------- the big status at the top ---------- */

function renderStatus(sig) {
  const o = sig.official, pv = sig.provisional;
  const st = Site.status(sig);
  Site.el("status-card").dataset.kind = st.kind;
  Site.el("status-icon").innerHTML = Site.icon(st.icon);
  let label = `From the ${o.month_label} month-end check`;              // a fresh buy/sell signal, or no newer data
  if (pv && o.action === "none") {
    label = pv.month_closed
      ? `${pv.month_label} has closed (final close ${pv.as_of_label}). Expected result of the check:`
      : `As of the ${pv.as_of_label} close`;
  }
  Site.setText("status-label", label);
  Site.setText("status-title", st.title);
  Site.setText("status-means", st.means);

  const holding = o.invested === 1 ? "fully invested" : "stepped aside";
  const [y, mo] = o.month.split("-").map(Number);
  const nextMonth = new Date(y, mo, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const next = pv ? `the ${pv.check_date_label} close` : `the last trading day of ${nextMonth}`;
  Site.setText("status-next", `Official signal from the ${o.month_label} check: ${holding}. Next check: ${next}. ` +
    "It becomes official once FRED posts that month's interest rates, usually the next business day.");

  if (sig.pending) {
    const b = Site.el("pending");
    b.textContent = `${sig.pending.month_label} has closed. The official check is waiting for FRED to post: ` +
      `${sig.pending.waiting_for.join(" and ")}. The reading above already uses the final ${sig.pending.month_label} close.`;
    b.hidden = false;
  }
  Site.setLamps(sig);
}

/* ---------- the two warning signs ---------- */

function fillKV(id, pairs) {
  const dl = Site.el(id);
  if (!dl) return;
  dl.replaceChildren();
  for (const [k, v] of pairs) dl.append(Site.make("dt", "", k), Site.make("dd", "", v));
}

function renderChecks(sig) {
  const o = sig.official, pv = sig.provisional, cur = pv || o;
  const mon = pv ? pv.month_label.split(" ")[0] : o.month_label;

  // Warning sign 1: the trend
  setPill(Site.el("trend-pill"), cur.trend_broken ? "warn" : "good", cur.trend_broken ? "down" : "check",
    cur.trend_broken ? "Yes, the trend is down" : "No, the trend is up");
  const gap = pv ? (pv.sp_close / pv.level_to_beat - 1) * 100 : o.pct_vs_sma;
  const trend = [];
  if (pv) {
    Site.setText("trend-text", `The S&P 500 is at ${Site.num(pv.sp_close)}, ${Math.abs(gap).toFixed(1)}% ${gap < 0 ? "below" : "above"} the level that matters. ` +
      `To finish the month above its 10-month average, ${mon} needs to close above ${Site.num(pv.level_to_beat)}.`);
    trend.push([`S&P 500 (${pv.as_of_label})`, Site.num(pv.sp_close)]);
    trend.push([`${mon} close needed`, Site.num(pv.level_to_beat)]);
  } else {
    Site.setText("trend-text", `At the ${o.month_label} check the S&P 500 closed ${Math.abs(gap).toFixed(1)}% ${o.trend_broken ? "below" : "above"} its 10-month average.`);
  }
  trend.push([`${o.month_label} check`, `${Site.num(o.sp_close)} vs. ${Site.num(o.sma10)} average`]);
  fillKV("trend-kv", trend);
  const dot = document.querySelector("#trend-meter .meter-dot");
  if (dot) {                                   // the marker sits left of centre when below the line, right when above (±10% fills the track)
    dot.style.left = `${Math.max(2, Math.min(98, 50 + gap * 5))}%`;
    dot.dataset.side = gap < 0 ? "below" : "above";
  }

  // Warning sign 2: the yield curve
  setPill(Site.el("curve-pill"), cur.warning ? "warn" : "good", cur.warning ? "alert" : "check",
    cur.warning ? "Yes, the warning is on" : "No warning");
  const curve = [];
  const now = pv && pv.spread !== null ? pv.spread : o.spread;
  let text = now >= 0
    ? `Right now the 10-year rate is ${now.toFixed(2)} points above the 3-month rate, which is normal.`
    : `Right now the 3-month rate is ${Math.abs(now).toFixed(2)} points above the 10-year rate. The curve is inverted.`;
  const src = pv && pv.inversion_started ? pv : o;      // the clock as of the freshest reading
  if (src.inversion_started) {
    text += cur.warning
      ? ` The warning switched on when the curve inverted in ${src.inversion_started_label}. It runs for 24 months from that start, through the ${src.warning_lapses_after_label} check.`
      : ` The last inversion began in ${src.inversion_started_label}. The warning runs for 24 months from the start of an inversion, so it switched off after the ${src.warning_lapses_after_label} check. It turns back on when a new inversion begins.`;
    curve.push(["Last inversion began", src.inversion_started_label]);
    curve.push([cur.warning ? "Warning on through" : "Warning switched off after", `the ${src.warning_lapses_after_label} check`]);
  }
  Site.setText("curve-text", text);
  if (pv && pv.spread !== null) curve.push([pv.spread_source === "monthly" ? `${mon} (official)` : `${mon} so far`, `${pv.spread > 0 ? "+" : ""}${pv.spread.toFixed(2)} pts`]);
  curve.push([`${o.month_label} (official)`, `${o.spread > 0 ? "+" : ""}${o.spread.toFixed(2)} pts`]);
  fillKV("curve-kv", curve);

  // The warning clock: one dot per month of the 24-month clock, filled = months already used
  const dots = Site.el("curve-dots");
  if (dots) {
    dots.replaceChildren();
    const total = o.clock_months || 24;
    const used = src.inversion_started ? Math.min(src.clock_month, total) : 0;
    for (let i = 1; i <= total; i++) {
      const d = Site.make("i", i <= used ? "mdot inv" : "mdot");
      d.title = `Month ${i} of ${total}`;
      dots.appendChild(d);
    }
    dots.classList.toggle("spent", Boolean(src.inversion_started) && !cur.warning);
    Site.setText("curve-dots-note", !src.inversion_started ? `The ${total}-month warning clock has not started.`
      : !cur.warning ? `Warning clock: all ${total} months have run out. A new inversion starts a new clock.`
      : used === 0 ? `Warning clock: started this month, ${total} months to run.`
      : `Warning clock: ${used} of ${total} months used (filled).`);
  }
}

/* ---------- charts ---------- */

function renderCharts(sig) {
  const h = sig.history, pv = sig.provisional;
  const months = [...h.months], close = [...h.close], sma = [...h.sma10], spread = [...h.spread], trimmed = [...h.trimmed];
  if (pv && !months.includes(pv.month)) {      // add this month's reading as the last point
    months.push(pv.month);
    close.push(pv.sp_close);
    sma.push(pv.sma10);
    spread.push(pv.spread);
    trimmed.push(sig.official.invested === 0 ? 1 : 0);
  }
  const lastIsProvisional = Boolean(pv && !pv.month_closed);
  const labels = months.map((m, i) => Site.monthLabel(m) + (lastIsProvisional && i === months.length - 1 ? " (so far)" : ""));
  const xTicks = (i) => (months[i].endsWith("-01") || i === months.length - 1 ? labels[i].replace(" (so far)", "*") : "");
  const dashLast = lastIsProvisional ? { segment: { borderDash: (c) => (c.p1DataIndex === months.length - 1 ? [4, 4] : undefined) } } : {};

  const o = Site.baseOptions();
  o.scales.x.ticks.callback = xTicks;
  o.scales.y.ticks.callback = (v) => Site.num(v);
  o.layout.padding.right = 56;
  o.plugins.bands = { flags: trimmed, color: Site.css("--c-band") };
  o.plugins.endLabels = { format: (x) => Site.num(x) };
  o.plugins.tooltip.callbacks = {
    title: (items) => labels[items[0].dataIndex],
    label: (item) => `${Site.num(item.raw)}  ${item.dataset.label}`,
  };
  Site.draw("trend-chart", "line", {
    labels,
    datasets: [
      Site.line("S&P 500 close", close, "--c-plan", { borderWidth: 2.5, ...dashLast }),
      Site.line("10-month average", sma, "--c-sp", { endLabel: false, borderDash: [6, 5] }),
    ],
  }, o);
  Site.setText("trend-note", (lastIsProvisional ? `* The last point is the ${pv.as_of_label} close, not a month-end close. ` : "") +
    "Shading marks months the signal said to step aside.");

  const c = Site.baseOptions();
  c.scales.x.ticks.callback = xTicks;
  c.scales.y.ticks.callback = (v) => `${v > 0 ? "+" : ""}${v}`;
  c.scales.y.grid.color = (ctx) => (ctx.tick.value === 0 ? Site.css("--c-ink-3") : Site.css("--c-grid"));
  c.plugins.tooltip.usePointStyle = false;
  c.plugins.tooltip.displayColors = false;
  c.plugins.tooltip.callbacks = {
    title: (items) => labels[items[0].dataIndex],
    label: (item) => `${item.raw > 0 ? "+" : ""}${item.raw.toFixed(2)} points  ${item.raw < 0 ? "inverted" : "normal"}`,
  };
  const pos = Site.css("--c-plan"), neg = Site.css("--c-neg");
  Site.draw("curve-chart", "bar", {
    labels,
    datasets: [{
      label: "Yield curve", data: spread, endLabel: false, borderRadius: 3, maxBarThickness: 14,
      backgroundColor: spread.map((v, i) => Site.alpha(v < 0 ? neg : pos, lastIsProvisional && i === spread.length - 1 ? 0.5 : 1)),
    }],
  }, c);
}

function renderFooter(sig) {
  const t = new Date(sig.generated_utc), d = sig.data_through;
  const sp = new Date(d.sp500 + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  let text = `Last updated ${t.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. Prices through ${sp}; monthly interest rates through ${Site.monthLabel(d.gs10)}.`;
  const ageDays = (Date.now() - t.getTime()) / 86400000;
  if (ageDays > 4) text += ` Note: this data is ${Math.floor(ageDays)} days old. The automatic update may have stopped.`;
  Site.setText("data-status", text);
}
