/* ==========================================================================
   home.js — the home page (index.html).

   The big chart at the top is the centre of the page:
     - hover (or drag a finger) to read any month in the numbers above it
     - the chips zoom into famous stretches, restarting every line at $10,000
     - the legend buttons show or hide a line
     - "Play the history" draws the lines year by year
   Below it: headline numbers, the declines chart, a what-if calculator
   and the list of every sale.
   ========================================================================== */

const Home = {
  bt: null,              // data/backtest.json
  view: "ndx100",        // which option is showing (a key of "views" in backtest.json)
  range: "all",          // which stretch of years the big chart shows
  hidden: {},            // lines switched off in the legend
  cur: null,             // the series currently drawn (after range + rebasing)
  playing: false,
};

/* Stretches the chips can zoom to: [id, label, first month, last month or null for "to today"] */
const RANGES = [
  ["all", "All years", null, null],
  ["seventies", "1970s inflation", "1972-12", "1982-12"],
  ["dotcom", "Dot-com crash", "1999-12", "2003-12"],
  ["crisis", "2008 crisis", "2007-06", "2010-12"],
  ["recent", "Since 2020", "2019-12", null],
];
/* The four options the toggle switches between. Each follows the same signal. */
const VIEW_HASH = { ndx100: "#nasdaq", sp100: "#sp500", plan7030: "#70-30", spcore: "#sp500-half" };
const WITH_SIGNAL = "With the signal";          // the name of the chosen option's own line on the charts
const SERIES = [
  ["plan", WITH_SIGNAL, "--c-plan", "plan"],
  ["sp", "S&P 500", "--c-sp", "benchmark"],
  ["ndx", "Nasdaq-100", "--c-ndx", "nasdaq"],
];

Site.pages.home = async function () {
  const [bt, sig, early] = await Promise.all([
    Site.loadJSON("data/backtest.json"),
    Site.loadJSON("data/signal.json").catch(() => null),      // the page still works without it
    Site.loadJSON("data/test-1920-1967.json").catch(() => null),   // the one-time 1920-1967 test; its section stays hidden without it
  ]);
  Home.bt = bt;
  Home.view = Object.keys(VIEW_HASH).find((k) => VIEW_HASH[k] === location.hash && bt.views[k]) || Home.view;

  document.querySelectorAll("#view-toggle button").forEach((btn) =>
    btn.addEventListener("click", () => {
      Home.view = btn.dataset.view;
      Home.range = "all";
      Home.hidden = {};
      history.replaceState(null, "", VIEW_HASH[Home.view] || location.pathname);
      renderView();
    }));
  const play = Site.el("play");
  if (play) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) play.hidden = true;
    play.addEventListener("click", togglePlay);
  }

  const steps = [["the main chart", renderView], ["the calculator", setupCalculator]];
  if (sig) steps.unshift(["this month's signal", () => showSignal(sig)]);
  if (early) steps.push(["the 1920 test", () => renderEarly(early)]);
  Site.runSteps(steps);
  Site.setText("updated", `Data through ${Site.monthLabel(bt.as_of_month)}. Updated ${new Date(bt.generated_utc).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`);
};

function showSignal(sig) {
  const st = Site.status(sig);
  const pill = Site.el("status-pill");
  if (pill) {
    pill.className = `pill ${st.kind}`;
    pill.innerHTML = `${Site.icon(st.icon)}<span></span>`;
    pill.querySelector("span").textContent = `This month: ${st.title.charAt(0).toLowerCase()}${st.title.slice(1)}`;
    pill.hidden = false;
  }
  Site.setLamps(sig);
}

/* Everything that changes when the view toggle is clicked. */
function renderView() {
  stopPlay();
  const v = Home.bt.views[Home.view];
  const hasNdx = Boolean(v.nasdaq);
  document.querySelectorAll("#view-toggle button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.view === Home.view)));
  document.querySelectorAll(".ndx-only").forEach((el) => (el.style.display = hasNdx ? "" : "none"));
  ["lg-plan2", "th-plan-yr"].forEach((id) => Site.setText(id, WITH_SIGNAL));
  Site.setText("th-stocks", `${v.hold_name} did meanwhile`);
  Site.setText("option-name", v.name);              // the line under the buttons: what this option holds, in and out
  Site.setText("option-in", v.invested);
  Site.setText("option-out", v.aside);

  Site.runSteps([
    ["the growth chart", renderHero],
    ["the headline numbers", () => renderStats(v, hasNdx)],
    ["the side-by-side table", renderCompare],
    ["the chart notes", () => renderReading(v, hasNdx)],
    ["the declines chart", () => renderDrawdown(v, hasNdx)],
    ["the list of sales", () => renderSales(v)],
    ["the year-by-year table", () => renderYears(v, hasNdx)],
    ["the calculator", refreshCalculator],
  ]);
}

/* ---------- the big chart ---------- */

/* Work out what the chart should show for the chosen view + range. */
function prepare() {
  const v = Home.bt.views[Home.view];
  const r = RANGES.find((x) => x[0] === Home.range) || RANGES[0];
  let a = 0, b = v.months.length - 1;
  if (r[2]) { a = v.months.indexOf(r[2]); if (r[3]) b = v.months.indexOf(r[3]); }
  if (a < 0 || b < 0) { a = 0; b = v.months.length - 1; Home.range = "all"; }
  const series = SERIES.filter((s) => v[s[3]]).map(([key, label, colorVar, field]) => ({
    key, label, colorVar,
    values: v[field].slice(a, b + 1).map((x) => (x / v[field][a]) * 10000),   // every line restarts at $10,000
  }));
  Home.cur = { months: v.months.slice(a, b + 1), flags: v.trimmed.slice(a, b + 1).map((f, k) => (k === 0 ? 0 : f)), series };
}

function visibleSeries() {
  return Home.cur.series.filter((s) => !Home.hidden[s.key]);
}

/* Log-scale ticks at 1, 2 and 5 times each power of ten ($10K, $20K, $50K, $100K ...). */
function logTicks(scale) {
  const ticks = [];
  for (let p = Math.floor(Math.log10(scale.min)); p <= Math.ceil(Math.log10(scale.max)); p++) {
    for (const m of [1, 2, 5]) {
      const val = m * 10 ** p;
      if (val >= scale.min && val <= scale.max) ticks.push({ value: val });
    }
  }
  scale.ticks = ticks;
}
function axisMoney(val) {
  return val >= 1e6 ? `$${+(val / 1e6).toFixed(2)}M` : Site.money(val);
}

function renderHero() {
  prepare();
  const cur = Home.cur, vis = visibleSeries();
  const all = vis.flatMap((s) => s.values);
  const lo = Math.min(...all), hi = Math.max(...all);
  const useLog = hi / lo >= 8;                 // long histories need a log scale; short stretches read better in plain dollars
  Home.cur.useLog = useLog; Home.cur.lo = lo; Home.cur.hi = hi;

  const o = Site.baseOptions();
  o.scales.x.ticks.callback = Site.yearTicks(cur.months, Site.yearStep(cur.months.length, "growth"));
  if (useLog) { o.scales.y.type = "logarithmic"; o.scales.y.afterBuildTicks = logTicks; } else { o.scales.y.ticks.maxTicksLimit = 6; }
  o.scales.y.ticks.callback = axisMoney;
  o.scales.y.afterFit = (scale) => { scale.width = 58; };
  o.layout.padding = { right: 70, top: 22, left: 0, bottom: 0 };
  o.plugins.bands = { flags: cur.flags, color: Site.css("--c-band"), months: cur.months };
  o.plugins.endLabels = { format: (x) => Site.money(x) };
  o.plugins.tooltip.enabled = false;          // the numbers above the chart do this job
  o.onHover = (_evt, active) => { if (!Home.playing) updateReadout(active.length ? active[0].index : cur.months.length - 1); };

  const area = Site.cssNum("--chart-area", 0);
  const datasets = vis.map((s) => {
    const isPlan = s.key === "plan";
    const ds = Site.line(s.label, s.values, s.colorVar, { borderWidth: isPlan ? Site.cssNum("--chart-plan-width", 2.5) : 1.75, order: isPlan ? 0 : 1 });
    if (isPlan && area > 0) {
      ds.fill = "start";
      ds.backgroundColor = (ctx) => {
        const ca = ctx.chart.chartArea;
        if (!ca) return "transparent";
        const g = ctx.chart.ctx.createLinearGradient(0, ca.top, 0, ca.bottom);
        g.addColorStop(0, Site.alpha(Site.css("--c-plan"), area));
        g.addColorStop(1, Site.alpha(Site.css("--c-plan"), 0));
        return g;
      };
    }
    return ds;
  });
  const chart = Site.draw("growth", "line", { labels: cur.months, datasets }, o);
  chart.canvas.onmouseleave = () => { if (!Home.playing) updateReadout(cur.months.length - 1); };

  renderChips();
  buildReadout();
  updateReadout(cur.months.length - 1);
}

/* The range chips and the legend buttons. */
function renderChips() {
  const v = Home.bt.views[Home.view];
  const ranges = Site.el("ranges");
  if (ranges) {
    ranges.replaceChildren();
    for (const [id, label, start, end] of RANGES) {
      if (start && (v.months.indexOf(start) < 0 || (end && v.months.indexOf(end) < 0))) continue;
      const b = Site.make("button", "chip", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(id === Home.range));
      b.addEventListener("click", () => { stopPlay(); Home.range = id; renderHero(); });
      ranges.appendChild(b);
    }
  }
  const legend = Site.el("legend");
  if (legend) {
    legend.replaceChildren();
    for (const s of Home.cur.series) {
      const b = Site.make("button", "chip series");
      b.type = "button";
      b.setAttribute("aria-pressed", String(!Home.hidden[s.key]));
      b.title = "Show or hide this line";
      const key = Site.make("i", "key-line");
      key.style.background = `var(${s.colorVar})`;
      b.append(key, document.createTextNode(s.key === "plan" ? s.label : `${s.label}, buy and hold`));
      b.addEventListener("click", () => {
        const visibleCount = Home.cur.series.filter((x) => !Home.hidden[x.key]).length;
        if (!Home.hidden[s.key] && visibleCount === 1) return;      // always keep one line on screen
        stopPlay();
        Home.hidden[s.key] = !Home.hidden[s.key];
        renderHero();
      });
      legend.appendChild(b);
    }
    const band = Site.make("span", "chip-key");
    band.append(Site.make("i", "key-box"), document.createTextNode("Plan stepped aside"));
    legend.appendChild(band);
  }
}

/* The live numbers above the chart. */
function buildReadout() {
  const box = Site.el("ro-items");
  if (!box) return;
  box.replaceChildren();
  for (const s of visibleSeries()) {
    const item = Site.make("div", `ro ro-${s.key}`);
    const name = Site.make("span", "ro-name");
    const dot = Site.make("i", "dot");
    dot.style.background = `var(${s.colorVar})`;
    name.append(dot, document.createTextNode(s.label));
    const val = Site.make("b", "ro-val");
    val.dataset.key = s.key;
    item.append(name, val);
    box.appendChild(item);
  }
}
function updateReadout(i) {
  const cur = Home.cur;
  if (!cur) return;
  const last = cur.months.length - 1;
  i = Math.max(0, Math.min(last, i));
  const vis = visibleSeries();
  // one format for the whole row: short ($1.97M, $693K) once anything passes $1M, full dollars before that
  const fmt = Math.max(...vis.map((s) => s.values[i])) >= 1e6 ? Site.money : Site.moneyFull;
  for (const s of vis) {
    const el = document.querySelector(`.ro-val[data-key="${s.key}"]`);
    if (el) el.textContent = fmt(s.values[i]);
  }
  const atRest = i === last && !Home.playing;
  Site.setText("ro-date", atRest
    ? `$10,000 invested in ${Site.monthLabel(cur.months[0])}, as of ${Site.monthLabel(cur.months[last])}`
    : `${Site.monthLabel(cur.months[i], true)}${cur.flags[i] ? " · stepped aside" : ""}`);
}

/* ---------- "Play the history" ---------- */

function setPlayLabel(text, icon) {
  const play = Site.el("play");
  if (!play) return;
  play.innerHTML = `${Site.icon(icon)}<span></span>`;
  play.querySelector("span").textContent = text;
}
function stopPlay() {
  if (!Home.playing) return;
  Home.playing = false;
  setPlayLabel("Play the history", "play");
}
function togglePlay() {
  if (Home.playing) {                         // pause: put the full chart back
    stopPlay();
    renderHero();
    return;
  }
  const chart = Site.charts.growth, cur = Home.cur;
  if (!chart || !cur) return;
  const vis = visibleSeries(), n = cur.months.length;
  Home.playing = true;
  setPlayLabel("Pause", "pause");
  // hold the vertical scale still so the lines grow into place
  chart.options.scales.y.min = cur.useLog ? cur.lo * 0.8 : cur.lo - (cur.hi - cur.lo) * 0.05;
  chart.options.scales.y.max = cur.useLog ? cur.hi * 1.25 : cur.hi + (cur.hi - cur.lo) * 0.05;
  const duration = Math.min(9000, Math.max(3500, n * 14));
  let t0 = null;
  const frame = (now) => {
    if (!Home.playing || Site.charts.growth !== chart) return;
    if (t0 === null) t0 = now;
    const k = Math.min(n, Math.max(2, Math.round(((now - t0) / duration) * n)));
    chart.data.datasets.forEach((ds, j) => { ds.data = vis[j].values.slice(0, k); });
    chart.options.plugins.bands.flags = cur.flags.slice(0, k);
    chart.update("none");
    updateReadout(k - 1);
    if (k < n) requestAnimationFrame(frame);
    else { Home.playing = false; setPlayLabel("Play again", "play"); renderHero(); }
  };
  requestAnimationFrame(frame);
}

/* ---------- headline numbers ---------- */

/* One "compare" line under a number: a colored dot + words per fund. */
function compareLine(id, items) {
  const el = Site.el(id);
  if (!el) return;
  el.replaceChildren();
  for (const [colorVar, text] of items) {
    const span = document.createElement("span");
    const dot = Site.make("i", "dot");
    dot.style.background = `var(${colorVar})`;
    span.append(dot, document.createTextNode(text));
    el.appendChild(span);
  }
}
function renderStats(v, hasNdx) {
  const p = v.stats.plan, b = v.stats.benchmark, n = v.stats.nasdaq;
  const both = (fmt, key) => [["--c-sp", `S&P 500 ${fmt(b[key])}`], ...(hasNdx ? [["--c-ndx", `Nasdaq-100 ${fmt(n[key])}`]] : [])];
  Site.setText("s-cagr", Site.pct(p.cagr));
  compareLine("s-cagr-b", both((x) => Site.pct(x), "cagr"));
  Site.setText("s-dd", Site.pct(p.max_drawdown, 0));
  compareLine("s-dd-b", both((x) => Site.pct(x, 0), "max_drawdown"));
  Site.setText("s-w12", Site.pct(p.worst_12m, 0));
  compareLine("s-w12-b", both((x) => Site.pct(x, 0), "worst_12m"));
  Site.setText("s-end-label", `$10,000 since ${v.months[1].slice(0, 4)} grew to`);      // each view has its own start year
  Site.setText("s-end", Site.money(p.end_value));
  compareLine("s-end-b", both((x) => Site.money(x), "end_value"));
  Site.setText("s-end-x", `${Site.monthLabel(v.months[0])} to ${Site.monthLabel(v.months.at(-1))}. Dividends included, before taxes.`);
}

/* ---------- the four options side by side, measured over the years they share ---------- */
function renderCompare() {
  const body = Site.el("compare-body");
  if (!body) return;
  const views = Home.bt.views, list = Object.values(views);
  const start = list.map((x) => x.months[0]).sort().at(-1);                // the first month every option has
  const measure = (months, values) => {
    const s = values.slice(months.indexOf(start));
    let peak = s[0], worst = 0;
    for (const x of s) { peak = Math.max(peak, x); worst = Math.min(worst, x / peak - 1); }
    return { growth: (Math.pow(s.at(-1) / s[0], 12 / (s.length - 1)) - 1) * 100, worst: worst * 100, end: (10000 * s.at(-1)) / s[0] };
  };
  const lines = list.map((x) => [x.name, `Invested: ${x.invested}. Stepped aside: ${x.aside}`, measure(x.months, x.plan), ""]);
  const withNdx = list.find((x) => x.nasdaq);
  if (withNdx) lines.push(["Nasdaq-100, never selling", "Always 100% Nasdaq-100.", measure(withNdx.months, withNdx.nasdaq), "muted"]);
  lines.push(["S&P 500, never selling", "Always 100% S&P 500.", measure(list[0].months, list[0].benchmark), "muted"]);
  Site.fillTable(body, lines.map(([name, sub, m, cls]) => [
    { text: name, sub, cls },
    { text: Site.pct(m.growth), cls: `num ${cls}` },
    { text: Site.pct(m.worst, 0), cls: `num ${cls}` },
    { text: Site.money(m.end), cls: `num ${cls}` },
  ]));
  const any = list[0];
  Site.setText("cmp-end-th", `$10,000 since ${any.months[any.months.indexOf(start) + 1].slice(0, 4)} became`);
  Site.setText("compare-intro", `All four follow the same signal on the same dates. They differ in what they hold and in how much they sell when the signal says to step aside. Every row covers the same years, ${Site.monthLabel(start)} to ${Site.monthLabel(any.months.at(-1))}.`);
  const longer = list.filter((x) => x.months[0] < start);
  Site.setText("compare-note", longer.length ? `The S&P 500 options can be tested further back. From ${Site.monthLabel(longer[0].months[0])}, ` +
    joinWords(longer.map((x) => `"${x.name}" averaged ${Site.pct(x.stats.plan.cagr)} a year`)) + ". Their bigger dollar figures on the chart come from those extra years." : "");
}

/* How long the worst decline lasted, from the peak before it to getting back to that peak. */
function recovery(dd, months) {
  let low = 0;
  dd.forEach((x, i) => { if (x < dd[low]) low = i; });
  let peak = low;
  while (peak > 0 && dd[peak] < 0) peak--;
  let back = low;
  while (back < dd.length && dd[back] < -0.05) back++;
  return { years: Math.round((back - peak) / 12), recovered: back < dd.length, peakYear: months[peak].slice(0, 4) };
}
function joinWords(list) {
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}
function renderReading(v, hasNdx) {
  const el = Site.el("reading");
  if (!el) return;
  const longs = Site.periods(v.trimmed).filter((p) => p.j - p.i + 1 >= 6).map((p) => Site.yearSpan(v.months[p.i], v.months[p.j]));
  const p = v.stats.plan, b = v.stats.benchmark;
  let text = "Each shaded band is a stretch when the signal said to step aside. " +
    (longs.length ? `Most were short false alarms. The long ones were ${joinWords(longs)}. ` : "");
  if (hasNdx) {
    const n = v.stats.nasdaq, r = recovery(v.nasdaq_dd, v.months);
    text += `Held with no signal, the Nasdaq-100 fell ${Math.abs(n.max_drawdown).toFixed(0)}% from its ${r.peakYear} peak and ` +
      (r.recovered ? `took about ${r.years} years to get back. ` : "still hasn't fully recovered. ");
  } else {
    text += `Held with no signal, the S&P 500's worst drop was ${Math.abs(b.max_drawdown).toFixed(0)}%. `;
  }
  text += `This option's worst drop was ${Math.abs(p.max_drawdown).toFixed(0)}%.`;
  if (Home.view === "ndx100") text += " Its test only goes back to 1987, and it relies on the Nasdaq-100 continuing to outgrow the S&P 500.";
  el.textContent = text;
}

/* ---------- declines chart ---------- */

function renderDrawdown(v, hasNdx) {
  if (!Site.el("drawdown")) return;
  const o = Site.baseOptions();
  o.scales.x.ticks.callback = Site.yearTicks(v.months, Site.yearStep(v.months.length, "drawdown"));
  o.scales.y.max = 0;
  o.scales.y.ticks.callback = (val) => `${val}%`;
  o.scales.y.afterFit = (scale) => { scale.width = 58; };
  o.layout.padding = { right: 70, top: 6, left: 0, bottom: 0 };   // same edges as the big chart so the years line up
  o.plugins.bands = { flags: v.trimmed, color: Site.css("--c-band") };
  o.plugins.tooltip.callbacks = {
    title: (items) => Site.monthLabel(v.months[items[0].dataIndex]),
    label: (item) => `${Site.pct(item.raw)}  ${item.dataset.label}`,
  };
  const datasets = [
    Site.line(WITH_SIGNAL, v.plan_dd, "--c-plan", { endLabel: false, borderWidth: 2.25, order: 0 }),
    Site.line("S&P 500", v.bench_dd, "--c-sp", { endLabel: false, borderWidth: 1.5, order: 1 }),
  ];
  if (hasNdx) datasets.push(Site.line("Nasdaq-100", v.nasdaq_dd, "--c-ndx", { endLabel: false, borderWidth: 1.5, order: 1 }));
  Site.draw("drawdown", "line", { labels: v.months, datasets }, o);
}

/* ---------- tables ---------- */

function renderSales(v) {
  const s = v.stats;
  Site.setText("sales-intro",
    `${s.sales} sell signals since ${v.months[1].slice(0, 4)}. This option spent ${s.pct_months_trimmed}% of all months stepped aside, ` +
    `about one month in ${Math.round(100 / s.pct_months_trimmed)}, and was fully invested the rest of the time.`);
  if (Site.el("sales")) Site.fillTable(Site.el("sales"), saleRows(v.trades));
}
/* One table row per sale: when, how long, what stocks did meanwhile, and how the sale worked out. */
function saleRows(trades) {
  return trades.map((t) => [
    Site.monthLabel(t.sold),
    t.bought_back ? Site.monthLabel(t.bought_back) : "Still stepped aside",
    { text: String(t.months), cls: "num" },
    { text: t.months ? Site.pct(t.stocks_while_out, 1, true) : "–", cls: "num" },                 // a sale made this month has no result yet
    { text: t.months ? Site.pct(t.vs_holding, 1, true) : "–", cls: `num ${t.months ? (t.vs_holding > 0 ? "up" : "down") : ""}` },
  ]);
}

/* Year by year: the value at each December compared with the December before. */
function renderYears(v, hasNdx) {
  if (!Site.el("years")) return;
  const rows = [];
  let prev = 0;
  v.months.forEach((m, i) => {
    const last = i === v.months.length - 1;
    if (i === 0 || (!m.endsWith("-12") && !last)) return;
    const g = (arr) => (arr[i] / arr[prev] - 1) * 100;
    const p = g(v.plan), b = g(v.benchmark);
    const label = m.endsWith("-12") ? m.slice(0, 4) : `${m.slice(0, 4)} (to ${Site.monthLabel(m).split(" ")[0]})`;
    const row = [label, { text: Site.pct(p), cls: "num" }, { text: Site.pct(b), cls: "num" }];
    if (hasNdx) row.push({ text: Site.pct(g(v.nasdaq)), cls: "num" });
    row.push({ text: Site.pct(p - b, 1, true), cls: `num ${p - b >= 0 ? "up" : "down"}` });
    rows.push(row);
    prev = i;
  });
  Site.fillTable(Site.el("years"), rows.reverse());
}

/* ---------- the 1920-1967 test (its own data file; it does not follow the option buttons) ---------- */

function renderEarly(e) {
  const section = Site.el("since-1920");
  if (!section) return;
  section.hidden = false;
  if (Site.el("early-link")) Site.el("early-link").hidden = false;

  const p = e.stats.plan, b = e.stats.benchmark;
  const never = (text) => [["--c-sp", `Never selling ${text}`]];
  Site.setText("e-crash", Site.pct(e.crash_1929.plan, 0));
  compareLine("e-crash-b", never(Site.pct(e.crash_1929.hold, 0)));
  Site.setText("e-cagr", Site.pct(p.cagr));
  compareLine("e-cagr-b", never(Site.pct(b.cagr)));
  Site.setText("e-sales", String(e.stats.sales));
  Site.setText("e-dd", Site.pct(p.max_drawdown, 0));
  compareLine("e-dd-b", never(Site.pct(b.max_drawdown, 0)));
  Site.setText("e-end", Site.money(p.end_value));
  compareLine("e-end-b", never(Site.money(b.end_value)));
  Site.setText("e-late", Site.pct(e.stats.late_cagr));

  const o = Site.baseOptions();
  o.scales.x.ticks.callback = Site.yearTicks(e.months, Site.yearStep(e.months.length, "early-growth"));
  o.scales.y.type = "logarithmic";
  o.scales.y.afterBuildTicks = logTicks;
  o.scales.y.ticks.callback = axisMoney;
  o.scales.y.afterFit = (scale) => { scale.width = 58; };
  o.layout.padding = { right: 70, top: 22, left: 0, bottom: 0 };   // same edges as the other charts
  o.plugins.bands = { flags: e.trimmed, color: Site.css("--c-band"), months: e.months, labelMin: 20 };   // label only the long 1929–32 band, so it always fits on a phone
  o.plugins.endLabels = { format: (x) => Site.money(x) };
  o.plugins.tooltip.callbacks = {
    title: (items) => `${Site.monthLabel(e.months[items[0].dataIndex], true)}${e.trimmed[items[0].dataIndex] ? " · stepped aside" : ""}`,
    label: (item) => `${Site.moneyFull(item.raw)}  ${item.dataset.label}`,
  };
  Site.draw("early-growth", "line", {
    labels: e.months,
    datasets: [
      Site.line(WITH_SIGNAL, e.plan, "--c-plan", { borderWidth: 2.25, order: 0 }),
      Site.line("US stocks, never selling", e.benchmark, "--c-sp", { borderWidth: 1.5, order: 1 }),
    ],
  }, o);

  if (Site.el("early-sales")) Site.fillTable(Site.el("early-sales"), saleRows(e.trades));
}

/* ---------- calculator (follows the option chosen above the chart) ---------- */

function setupCalculator() {
  if (!Site.el("c-year")) return;
  ["c-amount", "c-monthly", "c-year"].forEach((id) => Site.el(id).addEventListener("input", runCalculator));
  Site.el("calc").addEventListener("submit", (e) => e.preventDefault());
}
/* The starting years on offer depend on how far back the chosen option's history goes. */
function refreshCalculator() {
  const yearSel = Site.el("c-year");
  if (!yearSel) return;
  const v = Home.bt.views[Home.view];
  const firstYear = Number(v.months[1].slice(0, 4)), lastYear = Number(v.months.at(-1).slice(0, 4)) - 1;
  const keep = Number(yearSel.value) || 2000;
  yearSel.replaceChildren();
  for (let y = firstYear; y <= lastYear; y++) {
    const opt = Site.make("option", "", String(y));
    opt.value = y;
    yearSel.appendChild(opt);
  }
  yearSel.value = Math.min(lastYear, Math.max(firstYear, keep));
  runCalculator();
}
function readMoney(id, errId) {
  const raw = Site.el(id).value.trim();
  const val = raw === "" ? 0 : Number(raw);
  const bad = !Number.isFinite(val) || val < 0;
  Site.setText(errId, bad ? "Enter an amount of 0 or more" : "");
  return bad ? null : val;
}
function runCalculator() {
  const amount = readMoney("c-amount", "e-amount");
  const monthly = readMoney("c-monthly", "e-monthly");
  const out = Site.el("calc-results");
  out.classList.add("stale");                 // fade old results while the inputs aren't valid
  if (amount === null || monthly === null) return;
  if (amount === 0 && monthly === 0) {
    Site.setText("e-amount", "Enter a starting amount or a monthly amount");
    return;
  }
  out.classList.remove("stale");
  const v = Home.bt.views[Home.view];
  const year = Number(Site.el("c-year").value);
  const start = Math.max(0, v.months.indexOf(`${year - 1}-12`));
  const funds = [["plan", `${v.name}, with the signal`, v.plan], ["sp", "S&P 500, buy and hold", v.benchmark]];
  if (v.nasdaq) funds.push(["ndx", "Nasdaq-100, buy and hold", v.nasdaq]);
  const months = v.months.length - 1 - start;
  const putIn = amount + monthly * months;
  const results = funds.map(([cls, name, values]) => {
    let bal = amount, peak = values[start], worst = 0;
    for (let i = start + 1; i < values.length; i++) {
      bal = bal * (values[i] / values[i - 1]) + monthly;
      peak = Math.max(peak, values[i]);
      worst = Math.min(worst, values[i] / peak - 1);
    }
    return { cls, name, bal, worst };
  });
  const top = Math.max(...results.map((r) => r.bal));
  out.replaceChildren();
  for (const r of results) {
    const card = Site.make("div", `result ${r.cls}`);
    card.append(Site.make("div", "result-name", r.name), Site.make("div", "result-value", Site.moneyFull(r.bal)));
    const bar = Site.make("div", "result-bar");
    const fill = Site.make("i");
    fill.style.width = `${Math.max(2, (r.bal / top) * 100)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
    for (const [k, val] of [["You put in", Site.moneyFull(putIn)], ["Gain", Site.moneyFull(r.bal - putIn)], ["Worst drop along the way", Site.pct(r.worst * 100, 0)]]) {
      const row = Site.make("div", "result-row");
      row.append(Site.make("span", "", k), Site.make("b", "", val));
      card.appendChild(row);
    }
    out.appendChild(card);
  }
  Site.setText("calc-note",
    `From the start of ${year} to ${Site.monthLabel(v.months.at(-1))} (${(months / 12).toFixed(1)} years). ` +
    `Option: ${v.name}. Monthly additions go in at the end of each month and follow whatever the option holds at the time. Before taxes.`);
}
