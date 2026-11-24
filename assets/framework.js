/* ==========================================================================
   framework.js — the two data charts on the How it works page:
     1. the yield curve since 1968, with official US recessions shaded
     2. the 2008 walkthrough: chart + month-by-month story, written from the data
   ========================================================================== */

Site.pages.framework = async function () {
  const bt = await Site.loadJSON("data/backtest.json");
  Site.runSteps([
    ["the yield-curve chart", () => renderCurve(bt)],
    ["the 2008 walkthrough", () => renderStory(bt)],
  ]);
};

/* ---------- 1. yield curve vs. recessions ---------- */

function renderCurve(bt) {
  const s = bt.signals;
  const start = Math.max(0, s.months.indexOf("1968-01"));
  const months = s.months.slice(start), spread = s.spread.slice(start);
  const inRecession = (m) => bt.recessions.some(([a, b]) => m >= a && m <= b);
  const flags = months.map((m) => (inRecession(m) ? 1 : 0));

  const o = Site.baseOptions();
  o.scales.x.ticks.callback = Site.yearTicks(months, Math.max(5, Site.yearStep(months.length, "curve-chart")));
  o.scales.y.ticks.callback = (v) => `${v > 0 ? "+" : ""}${v}`;
  o.scales.y.grid.color = (ctx) => (ctx.tick.value === 0 ? Site.css("--c-ink-3") : Site.css("--c-grid"));
  o.plugins.bands = { flags, color: Site.css("--c-band") };
  o.plugins.tooltip.usePointStyle = false;
  o.plugins.tooltip.displayColors = false;
  o.plugins.tooltip.callbacks = {
    title: (items) => Site.monthLabel(months[items[0].dataIndex]) + (flags[items[0].dataIndex] ? "  (recession)" : ""),
    label: (item) => `${item.raw > 0 ? "+" : ""}${item.raw.toFixed(2)} points  ${item.raw < 0 ? "inverted" : "normal"}`,
  };
  const ds = Site.line("10-year minus 3-month", spread, "--c-ink-2", {
    borderWidth: 1.25, endLabel: false,
    fill: { target: "origin", above: Site.alpha(Site.css("--c-plan"), 0.28), below: Site.alpha(Site.css("--c-neg"), 0.6) },
  });
  Site.draw("curve-chart", "line", { labels: months, datasets: [ds] }, o);
}

/* ---------- 2. the 2008 walkthrough ---------- */

function findMonth(from, to, test) {
  for (let i = Math.max(1, from); i <= to; i++) if (test(i)) return i;
  return -1;
}

function renderStory(bt) {
  const s = bt.signals;
  const idx = (m) => s.months.indexOf(m);
  const a = idx("2006-07"), b = idx("2010-06");
  if (a < 0 || b < 0) return;

  // Find the events in the data instead of typing them in
  const sale = findMonth(idx("2007-06"), idx("2009-06"), (i) => s.invested[i - 1] === 1 && s.invested[i] === 0);
  const back = sale < 0 ? -1 : findMonth(sale + 1, b, (i) => s.invested[i - 1] === 0 && s.invested[i] === 1);
  const firstInv = findMonth(idx("2005-01"), sale < 0 ? b : sale, (i) => s.spread[i] < 0);
  let peak = a;
  for (let i = a; i <= (sale < 0 ? b : sale); i++) if (s.close[i] > s.close[peak]) peak = i;
  let low = sale < 0 ? a : sale;
  for (let i = low; i <= (back < 0 ? b : back); i++) if (s.close[i] < s.close[low]) low = i;

  // Chart: the close, its average, shading while stepped aside, and a dot on the sale and the buy-back
  const months = s.months.slice(a, b + 1);
  const held = months.map((_, k) => (s.invested[a + k - 1] === 0 ? 1 : 0));
  const marks = months.map((_, k) => ([sale, back].includes(a + k) ? s.close[a + k] : null));
  const markColors = months.map((_, k) => (a + k === sale ? Site.css("--bad") : Site.css("--good")));
  const o = Site.baseOptions();
  o.scales.x.ticks.callback = (i) => (months[i].endsWith("-01") ? months[i].slice(0, 4) : "");
  o.scales.y.ticks.callback = (v) => Site.num(v);
  o.plugins.bands = { flags: held, color: Site.css("--c-band") };
  o.plugins.tooltip.filter = (item) => item.datasetIndex !== 2;
  o.plugins.tooltip.callbacks = {
    title: (items) => (items.length ? Site.monthLabel(months[items[0].dataIndex]) : ""),
    label: (item) => `${Site.num(item.raw)}  ${item.dataset.label}`,
  };
  Site.draw("story-chart", "line", {
    labels: months,
    datasets: [
      Site.line("S&P 500 close", s.close.slice(a, b + 1), "--c-plan", { endLabel: false, borderWidth: 2.5 }),
      Site.line("10-month average", s.sma10.slice(a, b + 1), "--c-sp", { endLabel: false, borderDash: [6, 5] }),
      { label: "event", data: marks, showLine: false, pointRadius: 7, pointHoverRadius: 7, pointBackgroundColor: markColors,
        pointBorderColor: Site.css("--c-surface"), pointBorderWidth: 2, endLabel: false },
    ],
  }, o);

  // Timeline, written from the data
  const m = (i) => Site.monthLabel(s.months[i], true);
  const steps = [];
  if (firstInv >= 0) steps.push(["warn", m(firstInv), "The yield curve inverted (the 3-month rate rose above the 10-year). The recession warning switched on. It runs for 24 months, counted from this first inverted month."]);
  steps.push(["", m(peak), `The S&P 500 reached its month-end high of ${Site.num(s.close[peak])}. Still above its 10-month average, so the signal said stay invested.`]);
  if (sale >= 0) steps.push(["stop", m(sale), `The S&P 500 closed at ${Site.num(s.close[sale])}, below its 10-month average of ${Site.num(s.sma10[sale])}, with the warning still on. Both signs agreed: a sell signal. Each option sold its set amount.`]);
  steps.push(["", m(low), `The S&P 500 hit bottom at ${Site.num(s.close[low])}, ${Math.abs((s.close[low] / s.close[peak] - 1) * 100).toFixed(0)}% below its high.`]);
  if (back >= 0) steps.push(["go", m(back), `The S&P 500 closed at ${Site.num(s.close[back])}, back above its average of ${Site.num(s.sma10[back])}. Buy signal: every option went back to fully invested while the news was still grim.`]);
  const ol = Site.el("story");
  ol.replaceChildren();
  for (const [cls, when, text] of steps) {
    const li = Site.make("li", cls);
    li.append(Site.make("div", "when", when), Site.make("p", "", text));
    ol.appendChild(li);
  }

  // Result: peak to bottom for each option, from the home page's histories
  const res = Site.el("story-result");
  if (!res) return;
  const fell = (x, arr) => {
    const pi = x.months.indexOf(s.months[peak]), lo = x.months.indexOf(s.months[low]);
    return pi < 0 || lo < 0 ? null : `${Math.abs((arr[lo] / arr[pi] - 1) * 100).toFixed(0)}%`;
  };
  const list = Object.values(bt.views), base = list.find((x) => x.nasdaq) || list[0];
  const parts = list.map((x) => [x.name, fell(x, x.plan)]).filter((p) => p[1]).map(([name, pct]) => `${name}, ${pct}`);
  res.textContent = `The result: from ${Site.monthLabel(s.months[peak])} to ${Site.monthLabel(s.months[low])}, the S&P 500 fell ${fell(base, base.benchmark)}` +
    (base.nasdaq ? ` and the Nasdaq-100 fell ${fell(base, base.nasdaq)}` : "") + `, dividends included. With the signal, the options fell: ${parts.join("; ")}.`;
}
