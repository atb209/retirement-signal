/* ==========================================================================
   watch.js — the Watch list page (watch.html), filled from data/watch.json.

   The Python pipeline (pipeline/watch.py) runs every check and decides each
   light. This script only displays what the file says:
     good = nothing to do, warn = worth knowing, bad = a trigger is hit.
   ========================================================================== */

Site.pages.watch = async function () {
  const w = await Site.loadJSON("data/watch.json");
  Site.runSteps([
    ["the overall reading", () => renderSummary(w)],
    ["the checks", () => renderGroups(w)],
    ["the triggers", () => renderTriggers(w)],
    ["the update note", () => renderWatchFooter(w)],
  ]);
};

const WATCH_ICON = { good: "check", warn: "alert", bad: "alert" };

/* A colored pill with an icon and words, so the color is never the only clue. */
function watchPill(kind, text) {
  const p = Site.make("span", `pill ${kind}`);
  p.innerHTML = Site.icon(WATCH_ICON[kind] || "alert") + "<span></span>";
  p.querySelector("span").textContent = text;
  return p;
}

/* "2026-11-24" -> "Nov 24, 2026"; "2026-10" -> "Oct 2026" */
function watchDate(s) {
  if (!s) return "";
  if (s.length === 7) return Site.monthLabel(s);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function renderSummary(w) {
  const s = w.summary;
  Site.el("watch-status").dataset.kind = s.kind;
  Site.el("watch-icon").innerHTML = Site.icon(s.kind === "good" ? "check" : s.kind === "bad" ? "alert" : "shield");
  Site.setText("watch-label", "Watch list");
  Site.setText("watch-title", s.title);
  Site.setText("watch-means", s.text);
  const parts = [`${s.green} clear`, `${s.amber} worth knowing`, `${s.triggers_hit} trigger${s.triggers_hit === 1 ? "" : "s"} hit`];
  if (s.not_updated) parts.push(`${s.not_updated} not updated today`);
  Site.setText("watch-counts", parts.join(" · "));
  for (const [id, kind, text] of [["key-good", "good", "Green"], ["key-warn", "warn", "Amber"], ["key-bad", "bad", "Red"]]) {
    Site.el(id).replaceWith(watchPill(kind, text));
  }
}

/* One section per group, one panel per check. */
function renderGroups(w) {
  const host = Site.el("watch-groups");
  host.replaceChildren();
  const groups = [];
  for (const it of w.items) {
    let g = groups.find((x) => x.name === it.group);
    if (!g) groups.push(g = { name: it.group, items: [] });
    g.items.push(it);
  }
  for (const g of groups) {
    const section = Site.make("section", "section");
    const wrap = Site.make("div", "wrap");
    const head = Site.make("header", "section-head");
    head.appendChild(Site.make("h2", "", g.name));
    const grid = Site.make("div", "checks");
    for (const it of g.items) grid.appendChild(watchCard(it));
    wrap.append(head, grid);
    section.appendChild(wrap);
    host.appendChild(section);
  }
}

function watchCard(it) {
  const card = Site.make("div", "panel check watch-item");
  const top = Site.make("p");
  top.appendChild(watchPill(it.kind, it.answer));
  card.appendChild(top);
  card.appendChild(Site.make("h3", "", it.question));
  card.appendChild(Site.make("p", "", it.text));
  if (it.kv && it.kv.length) {
    const dl = Site.make("dl", "kv");
    for (const [k, v] of it.kv) dl.append(Site.make("dt", "", k), Site.make("dd", "", v));
    card.appendChild(dl);
  }
  if (it.stale) card.appendChild(Site.make("p", "fine stale", "Not updated today: the source couldn't be reached, so this is the last good reading."));
  const bits = [];
  if (it.as_of) bits.push(`As of ${watchDate(it.as_of)}`);
  if (it.source) bits.push(it.source);
  if (bits.length) card.appendChild(Site.make("p", "fine", bits.join(" · ")));
  return card;
}

/* The "revisit the rules" lines, with where each one stands. */
function renderTriggers(w) {
  const rows = w.items.filter((it) => it.trigger).map((it) => [
    it.trigger,
    it.now || it.answer,
    it.trigger_hit ? { text: "Hit", cls: "down" } : { text: "Not hit", cls: "up" },
  ]);
  Site.fillTable(Site.el("watch-triggers"), rows);
}

function renderWatchFooter(w) {
  const t = new Date(w.generated_utc);
  const when = Number.isNaN(t.getTime()) ? w.generated_utc : t.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  Site.setText("data-status", `Checks last run ${when}.`);
}
