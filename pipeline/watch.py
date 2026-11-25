"""
watch.py — the watch list, checked automatically.

The watch list is the short set of things that could change how well the signal works.
update.py calls build_watch() on every run; the result is saved as data/watch.json and
shown on the Watch page (watch.html).

Each check answers one plain question and gets one of three lights:
  good = nothing to do      warn = worth knowing      bad = a "revisit the plan" trigger is hit

Most checks use FRED data that update.py already downloads. Two also use other websites
(the S&P 500's top-10 share and the Shiller PE ratio). Those can break when a site changes
its layout or blocks the request, so each check is wrapped: if one fails, the page keeps the
last good reading, marks it "not updated", and every other check still runs. The Shiller PE
check goes one step further: it stores the slow-moving earnings figure and recomputes the
ratio from today's price, so it stays current even when its source can't be reached.
"""
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

import rules

DATA_DIR = Path(__file__).parent.parent / "data"
SCHEMA = 4                      # same layout version as the other data files (the pages check it)

# ---- the lines that turn a light amber or red (from the watch list document) ----
CURVE_CLOSE = 0.5               # yield curve under +0.5 points = getting close to inverting
ZERO_RATE = 0.5                 # Fed rate at or under 0.5% = the yield curve can't warn; use the backup
ZERO_RATE_NEAR = 1.0
TOP10_TRIGGER = 50.0            # top-10 share of the S&P 500, percent
TOP10_HIGH = 35.0               # well above the 18-23% that was normal from 1990 to 2015
NDX_LAG_TRIGGER = 2.0           # Nasdaq-100 trailing the S&P 500 by this many points a year over 5 years
SALE_COST_TRIGGER = 10.0        # one sale costing more than this share of the account
FALSE_ALARMS_TRIGGER = 3        # this many losing sales within two years
BOND_STRESS_RISE = 0.15         # Baa-minus-Aaa gap rising this much in 6 months
INFLATION_FALLBACK = 2.5        # used only if the market's inflation estimate can't be downloaded

# What the fixed history should show on every run (same targets as update.py's self-check).
SELF_CHECK = {"spcore": {"start": "1968-01", "end": "2025-11", "cagr": 11.9, "worst": -30.0},
              "plan7030": {"start": "1987-01", "end": "2025-11", "cagr": 14.6, "worst": -31.0}}
SELF_CHECK_TOLERANCE = 0.3      # points a year

# The S&P 500's 10-year average earnings (inflation-adjusted, in index points), as implied by a known reading:
# S&P 500 at 7,201 on Nov 24, 2026 with a Shiller PE of about 41.1. Used until the source can be reached.
EARNINGS_BASE_SEED = {"e10": 175.4, "as_of": "2026-11-24", "from": "seed"}
EARNINGS_BASE_MAX_AGE_DAYS = 365

# Starting values for the two website checks, used only until their first successful download.
SEED = {
    "concentration": {"value": 43.0, "as_of": "2026-11", "source": "InvestmentNews, Nov 2026"},
    "returns": {"cape": None, "as_of": "2026-11", "source": "Vanguard 10-year outlook, 4.8% to 6.8% a year"},
}

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; retirement-signal watch list; +https://github.com/atb209/retirement-signal)"}
SPY_HOLDINGS_URL = ("https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/"
                    "holdings-daily-us-en-spy.xlsx")
IVV_HOLDINGS_URL = ("https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax"
                    "?fileType=csv&fileName=IVV_holdings&dataType=fund")
SHILLER_PE_URLS = ("https://www.multpl.com/shiller-pe", "https://www.multpl.com/shiller-pe/atom")


# ---------- small helpers ----------

def r2(x, digits=2):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), digits)


def pct(x, digits=1, signed=False):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "n/a"
    s = f"{x:+.{digits}f}" if signed else f"{x:.{digits}f}"
    return s.replace("-", "−") + "%"


def month_label(m):
    return pd.Period(m, "M").strftime("%b %Y")


def item(key, group, question, kind, answer, text, kv, as_of, source, trigger=None):
    """One row of the watch list. trigger = the 'revisit the plan' rule this check stands for (or None)."""
    return {"key": key, "group": group, "question": question, "kind": kind, "answer": answer, "text": text,
            "kv": [[k, v] for k, v in kv], "as_of": as_of, "source": source,
            "trigger": trigger, "trigger_hit": bool(trigger) and kind == "bad", "stale": False, "error": None}


# ---------- 1. the recession warning ----------

def check_curve(signal):
    o, pv = signal["official"], signal.get("provisional")
    cur = pv or o
    spread, warning = cur.get("spread"), bool(cur.get("warning"))
    if spread is None:
        spread = o["spread"]
    kv = [(f"Yield curve, {o['month_label']} (official)", f"{o['spread']:+.2f} pts".replace("-", "−"))]
    if pv and pv.get("spread") is not None:
        kv.append((f"So far in {pv['month_label'].split()[0]}", f"{pv['spread']:+.2f} pts".replace("-", "−")))
    if warning:
        left = max(0, cur["clock_months"] - cur["clock_month"]) if "clock_months" in cur else max(0, rules.CLOCK_MONTHS - cur["clock_month"])
        kv += [("Inversion began", cur["inversion_started_label"]), ("Warning runs through", cur["warning_lapses_after_label"])]
        trend = "The S&P 500 is also below its 10-month average, so both signs are on." if cur.get("trend_broken") else \
                "The S&P 500 is still above its 10-month average, so nothing is sold yet."
        return item("curve", "The signal's own inputs", "Is the recession warning on?", "bad", "On",
                    f"The yield curve inverted in {cur['inversion_started_label']}, so the warning is on with about {left} "
                    f"month{'s' if left != 1 else ''} left on its 24-month clock. {trend} Any month-end close below the average "
                    "while it runs means sell.", kv, cur.get("as_of") or o["month"], "FRED: GS10 minus TB3MS",
                    trigger="The curve inverts again and the warning switches back on")
    kv.append(("Gets close under", f"+{CURVE_CLOSE:.2f} pts"))
    if spread < CURVE_CLOSE:
        return item("curve", "The signal's own inputs", "Is the recession warning on?", "warn", "Off, but close",
                    f"The 10-year rate is only {spread:.2f} points above the 3-month rate. If it drops below zero, a new "
                    "24-month warning starts that month.", kv, cur.get("as_of") or o["month"], "FRED: GS10 minus TB3MS",
                    trigger="The curve inverts again and the warning switches back on")
    return item("curve", "The signal's own inputs", "Is the recession warning on?", "good", "Off",
                f"The 10-year rate is {spread:.2f} points above the 3-month rate. No sale can trigger until that gap drops "
                "below zero.", kv, cur.get("as_of") or o["month"], "FRED: GS10 minus TB3MS",
                trigger="The curve inverts again and the warning switches back on")


# ---------- 2. can the yield curve still warn? ----------

def check_zero_rates(fed_upper):
    rate, day = float(fed_upper.iloc[-1]), fed_upper.index[-1]
    kv = [("Fed's target rate, upper end", pct(rate, 2)), ("Backup switches on at", f"{ZERO_RATE:.1f}% or less")]
    q, src = "Are interest rates too low for the yield curve to work?", "FRED: DFEDTARU"
    trig = "The Fed cuts rates to about 0.5% or less"
    if rate <= ZERO_RATE:
        return item("zero_rates", "The signal's own inputs", q, "bad", "Yes",
                    "With short-term rates near zero the yield curve can't invert, so the signal can't warn. This is the cue to "
                    "use the unemployment backup below in place of the yield curve until rates rise again.", kv,
                    day.strftime("%Y-%m-%d"), src, trigger=trig)
    if rate <= ZERO_RATE_NEAR:
        return item("zero_rates", "The signal's own inputs", q, "warn", "Getting close",
                    "Rates are low but not yet near zero. If the Fed cuts to about 0.5% or less, the yield curve stops working "
                    "as a warning and the backup takes over.", kv, day.strftime("%Y-%m-%d"), src, trigger=trig)
    return item("zero_rates", "The signal's own inputs", q, "good", "No",
                "Short-term rates are well above zero, so the yield curve can still invert and warn.", kv,
                day.strftime("%Y-%m-%d"), src, trigger=trig)


# ---------- 3 and 4. the two backup signals ----------

def check_unemployment(unrate, in_use):
    u = unrate.dropna()
    now, avg = float(u.iloc[-1]), float(u.iloc[-12:].mean())
    above = now > avg
    kv = [("Unemployment rate", pct(now)), ("Its 12-month average", pct(avg, 2))]
    role = "It is the signal's stand-in for the yield curve right now." if in_use else \
           "It only matters if rates fall near zero; until then the yield curve is the warning."
    return item("unemployment", "Backups, if the yield curve stops working", "Backup 1: is unemployment rising?",
                "warn" if above else "good", "Yes" if above else "No",
                f"Unemployment is {'above' if above else 'at or below'} its 12-month average. {role}", kv,
                u.index[-1].strftime("%Y-%m"), "FRED: UNRATE")


def check_bond_stress(baa, aaa):
    gap = (baa - aaa).dropna()
    now, then = float(gap.iloc[-1]), float(gap.iloc[-7])
    rise = now - then
    on = rise >= BOND_STRESS_RISE
    kv = [("Gap between riskier and safest company bonds", f"{now:.2f} pts"), ("Change over 6 months", f"{rise:+.2f} pts".replace("-", "−")),
          ("Counts as stress at", f"+{BOND_STRESS_RISE:.2f} pts")]
    return item("bond_stress", "Backups, if the yield curve stops working", "Backup 2: are company bonds under stress?",
                "warn" if on else "good", "Yes" if on else "No",
                ("Lenders are asking noticeably more to hold riskier company bonds than six months ago. " if on else
                 "Lenders aren't asking much more to hold riskier company bonds than six months ago. ") +
                "This is the second backup, for a long stretch of near-zero rates. It gave false alarms in 2010-2016, so it is watched, not acted on.",
                kv, gap.index[-1].strftime("%Y-%m"), "FRED: BAA minus AAA")


# ---------- 5. Nasdaq-100 against the S&P 500 ----------

def check_nasdaq(m):
    t = m[["sp_close", "ndx_close"]].dropna()
    last, back = t.iloc[-1], t.iloc[-61]
    sp = ((last["sp_close"] / back["sp_close"]) ** (1 / 5) - 1) * 100
    nd = ((last["ndx_close"] / back["ndx_close"]) ** (1 / 5) - 1) * 100
    diff = nd - sp
    kv = [("Nasdaq-100, last 5 years", pct(nd) + " a year"), ("S&P 500, last 5 years", pct(sp) + " a year"),
          ("Difference", pct(diff, 1, True) + " a year"), ("Trigger", f"trailing by more than {NDX_LAG_TRIGGER:.0f} points")]
    q, src = "Is the Nasdaq-100 slice still pulling its weight?", "FRED: NASDAQ100 and SP500 (prices, before dividends)"
    trig = "The Nasdaq trails the S&P by more than 2% a year over 5 years"
    if diff < -NDX_LAG_TRIGGER:
        return item("nasdaq", "What you hold", q, "bad", "No",
                    "The Nasdaq-100 has trailed the S&P 500 by more than 2 points a year for five years. The reason for holding "
                    "the slice is its extra return, so this is a cue to re-test the 70/30 mix.", kv, t.index[-1], src, trigger=trig)
    if diff < 0:
        return item("nasdaq", "What you hold", q, "warn", "Trailing a little",
                    "The Nasdaq-100 is behind the S&P 500 over five years, but by less than the 2-point trigger.", kv, t.index[-1], src, trigger=trig)
    return item("nasdaq", "What you hold", q, "good", "Yes",
                "The Nasdaq-100 is ahead of the S&P 500 over the last five years.", kv, t.index[-1], src, trigger=trig)


# ---------- 6. top-10 concentration (from a fund's published holdings) ----------

def _top10(names, weights):
    """Sum the ten largest companies. Share classes of one company (Alphabet A and C) count as one."""
    df = pd.DataFrame({"name": list(names), "w": pd.to_numeric(pd.Series(list(weights)), errors="coerce")}).dropna()
    df = df[df["w"] > 0]
    df["company"] = (df["name"].astype(str).str.upper()
                     .str.replace(r"\b(CLASS|CL)\s+[A-C]\b", "", regex=True)
                     .str.replace(r"[^A-Z0-9 ]", " ", regex=True).str.split().str[:2].str.join(" "))
    by_company = df.groupby("company")["w"].sum().sort_values(ascending=False)
    if len(df) < 400 or not 95 <= df["w"].sum() <= 101:
        raise ValueError(f"holdings file looks wrong: {len(df)} rows adding to {df['w'].sum():.1f}%")
    top = by_company.head(10)
    return float(top.sum()), [n.title() for n in top.index[:3]]


def fetch_top10():
    """Try State Street's SPY holdings spreadsheet, then iShares' IVV holdings file."""
    errors = []
    try:
        resp = requests.get(SPY_HOLDINGS_URL, headers=HEADERS, timeout=40)
        resp.raise_for_status()
        raw = pd.read_excel(io.BytesIO(resp.content), header=None, engine="openpyxl")
        head = next(i for i, row in raw.iterrows() if "Weight" in [str(c).strip() for c in row])
        cols = [str(c).strip() for c in raw.iloc[head]]
        body = raw.iloc[head + 1:]
        body.columns = cols
        value, names = _top10(body["Name"], body["Weight"])
        return value, names, "State Street: SPY daily holdings"
    except Exception as e:                                   # noqa: BLE001 - any failure means "try the next source"
        errors.append(f"SPY: {e}")
    try:
        resp = requests.get(IVV_HOLDINGS_URL, headers=HEADERS, timeout=40)
        resp.raise_for_status()
        text = resp.content.decode("utf-8-sig", errors="replace")
        start = next(i for i, line in enumerate(text.splitlines()) if line.startswith("Ticker,"))
        body = pd.read_csv(io.StringIO("\n".join(text.splitlines()[start:])), thousands=",")
        body = body[body["Asset Class"] == "Equity"]
        value, names = _top10(body["Name"], body["Weight (%)"])
        return value, names, "iShares: IVV daily holdings"
    except Exception as e:                                   # noqa: BLE001
        errors.append(f"IVV: {e}")
    raise RuntimeError("; ".join(errors))


def check_concentration(fetch=fetch_top10):
    value, names, source = fetch()
    kv = [("Ten largest companies' share of the S&P 500", pct(value)), ("Normal from 1990 to 2015", "18% to 23%"),
          ("Trigger", f"over {TOP10_TRIGGER:.0f}%")]
    q, trig = "How much of the S&P 500 is its ten biggest companies?", "Top-10 concentration passes 50% of the S&P 500"
    lead = f"The three largest are {names[0]}, {names[1]} and {names[2]}. " if len(names) >= 3 else ""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if value > TOP10_TRIGGER:
        return item("concentration", "What you hold", q, "bad", pct(value, 0),
                    lead + "More than half the index is ten companies, and the Nasdaq-100 fund holds many of the same ones. "
                    "This is the cue to re-test the mix; holding 20% Nasdaq instead of 30% is the dial to turn.", kv, today, source, trigger=trig)
    if value >= TOP10_HIGH:
        return item("concentration", "What you hold", q, "warn", pct(value, 0),
                    lead + "That is far above the historical norm, and the Nasdaq-100 fund holds many of the same companies at "
                    "higher weights. Selling the whole Nasdaq slice on a signal is the protection.", kv, today, source, trigger=trig)
    return item("concentration", "What you hold", q, "good", pct(value, 0),
                lead + "The index is less top-heavy than it has been in recent years.", kv, today, source, trigger=trig)


# ---------- 7. the safe side: Treasuries against T-bills ----------

def check_safe_side(m):
    t = m[["bond_r", "bill_r", "gs10"]].dropna()
    bond = ((1 + t["bond_r"].iloc[-12:]).prod() - 1) * 100
    bill = ((1 + t["bill_r"].iloc[-12:]).prod() - 1) * 100
    rate_change = float(t["gs10"].iloc[-1] - t["gs10"].iloc[-13])
    kv = [("10-year Treasury, last 12 months (estimate)", pct(bond, 1, True)), ("T-bills, last 12 months", pct(bill, 1, True)),
          ("10-year rate, change over 12 months", f"{rate_change:+.2f} pts".replace("-", "−"))]
    q, src = "Would the safe side hold up if a sale happened now?", "FRED: GS10 and TB3MS (Treasury return rebuilt from yields)"
    if bond < -10:
        return item("safe_side", "What you hold", q, "bad", "Treasuries are falling",
                    "Rising rates have cut Treasury prices sharply over the last year, as in 2022. The stepped-aside money is split "
                    "half Treasuries, half T-bills for exactly this case: the T-bill half keeps earning.", kv, t.index[-1], src)
    if bond < 0:
        return item("safe_side", "What you hold", q, "warn", "Treasuries are down",
                    "Treasuries lost a little over the last year as rates rose, while T-bills kept earning. The half-and-half split "
                    "limits the damage.", kv, t.index[-1], src)
    return item("safe_side", "What you hold", q, "good", "Yes",
                "Both halves of the safe side made money over the last year.", kv, t.index[-1], src)


# ---------- 8. what stocks are likely to return ----------

def fetch_shiller_pe():
    errors = []
    for url in SHILLER_PE_URLS:
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            text = re.sub(r"&lt;.*?&gt;|<[^>]+>", " ", resp.text)          # drop HTML tags (plain or escaped)
            found = re.search(r"Shiller\s+PE\s+Ratio\s*:?\s*([0-9]{1,3}\.[0-9]+)", text)
            if found and 3 < float(found.group(1)) < 100:
                return float(found.group(1)), "multpl.com (Robert Shiller's data)"
            errors.append(f"{url}: number not found")
        except Exception as e:                               # noqa: BLE001
            errors.append(f"{url}: {e}")
    raise RuntimeError("; ".join(errors))


def check_returns(sp_price, previous_base=None, inflation_expected=None, fetch=fetch_shiller_pe):
    """The Shiller PE = today's S&P 500 price divided by its average earnings over the last 10 years.

    The price moves every day; the 10-year earnings average barely moves in a month. So this check keeps a
    stored earnings figure and divides today's price (from FRED) by it. Whenever the outside source can be
    reached, the stored figure is refreshed from it. If the source is down or blocks the request, the ratio
    is still current to within a point or two, because only the slow-moving half is waiting for a refresh.
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    base = previous_base or EARNINGS_BASE_SEED
    try:
        cape, where = fetch()
        base = {"e10": round(sp_price / cape, 2), "as_of": today, "from": where}
    except Exception as e:                                   # noqa: BLE001 - fall back to the stored earnings figure
        print(f"  watch: Shiller PE source not reachable ({str(e)[:120]}); using the stored earnings figure from {base['as_of']}")
        cape = sp_price / base["e10"]
    base_age = (pd.Timestamp(today) - pd.Timestamp(base["as_of"])).days
    infl = INFLATION_FALLBACK if inflation_expected is None else float(inflation_expected)
    real = 100 / cape
    nominal = real + infl
    kv = [("Shiller PE (price vs. 10 years of earnings)", f"{cape:.1f}"), ("Its long-run average", "about 17"),
          ("Implied return above inflation", pct(real) + " a year"), ("Expected inflation", pct(infl) + " a year"),
          ("Implied return before inflation", pct(nominal) + " a year"),
          ("10-year earnings figure last refreshed", pd.Timestamp(base["as_of"]).strftime("%b %Y"))]
    q = "What are stocks priced to return over the next decade?"
    text = (f"At today's prices, a standard rule of thumb (earnings divided by price) points to about {nominal:.0f}% a year "
            "before inflation, against roughly 10% a year historically. It is a rough guide, not a forecast, and it says nothing "
            "about timing. Plan around the low and middle projections, not the backtest.")
    old = base_age > EARNINGS_BASE_MAX_AGE_DAYS
    if old:
        text += " The stored earnings figure is more than a year old, so this reading is rougher than usual until it is refreshed."
    kind = "warn" if nominal < 7 or old else "good"
    it = item("returns", "Expectations", q, kind, f"About {nominal:.0f}% a year", text, kv, today,
              "S&P 500 price from FRED; 10-year earnings from Robert Shiller's data (via multpl.com)")
    it["base"] = base                                         # carried forward to the next run
    return it


# ---------- 9. how recent sales worked out ----------

def check_sales(backtest, official_month):
    trades = backtest["views"]["plan7030"]["trades"]                  # newest first
    cutoff = (pd.Period(official_month, "M") - 24).strftime("%Y-%m")
    recent = [t for t in trades if t["sold"] >= cutoff]
    false_alarms = [t for t in recent if t["bought_back"] and t["vs_holding"] < 0]
    costly = [t for t in recent if t["vs_holding"] <= -SALE_COST_TRIGGER]
    last = trades[0] if trades else None
    kv = [("Sales in the last two years", str(len(recent))), ("Of those, false alarms", str(len(false_alarms)))]
    if last:
        kv.append(("Most recent sale", f"{month_label(last['sold'])}: {pct(last['vs_holding'], 1, True)} of the account"))
    q, src = "Have recent sales been costing money?", "This site's backtest of the 70/30 option"
    trig = "One sale costs more than 10% of the account, or three false alarms happen within two years"
    if costly or len(false_alarms) >= FALSE_ALARMS_TRIGGER:
        why = (f"A sale cost more than {SALE_COST_TRIGGER:.0f}% of the account" if costly
               else f"{len(false_alarms)} sales in two years were false alarms")
        return item("sales", "Is the signal still working?", q, "bad", "Yes",
                    f"{why}. That is more than the insurance should cost, so it is a cue to re-test the rules.", kv, official_month, src, trigger=trig)
    if false_alarms:
        return item("sales", "Is the signal still working?", q, "warn", "A little",
                    f"{len(false_alarms)} sale{'s' if len(false_alarms) != 1 else ''} in the last two years was a false alarm: stocks were "
                    "higher at the buy-back. One or two of these is the normal cost of the insurance.", kv, official_month, src, trigger=trig)
    return item("sales", "Is the signal still working?", q, "good", "No",
                "No false alarms in the last two years.", kv, official_month, src, trigger=trig)


# ---------- 10. the tests, rerun on every update ----------

def check_self_test(m, sig, data_through):
    rows, worst_gap = [], 0.0
    for key, t in SELF_CHECK.items():
        r, _ = rules.portfolio_returns(m, sig["invested"], key, t["start"])
        s = rules.stats(rules.growth(r[r.index <= t["end"]]))
        gap = abs(s["cagr"] - t["cagr"])
        worst_gap = max(worst_gap, gap)
        name = "70/30 option" if key == "plan7030" else "S&P 500, sells half"
        rows.append((f"{name}, {t['start'][:4]}-{t['end'][:4]}", f"{s['cagr']:.2f}% a year (expected about {t['cagr']}%)"))
    age = (pd.Timestamp(datetime.now(timezone.utc).date()) - pd.Timestamp(data_through)).days
    rows.append(("Latest S&P 500 price in the data", pd.Timestamp(data_through).strftime("%b %d, %Y").replace(" 0", " ")))
    q, src = "Do the historical tests still give the same answers?", "Rerun on every update from pipeline/rules.py"
    trig = "The historical tests stop matching their expected results"
    if worst_gap > SELF_CHECK_TOLERANCE:
        return item("self_test", "Is the signal still working?", q, "bad", "No",
                    "The backtest on the fixed history no longer matches its expected result. Something in the data or the code "
                    "changed, so treat the numbers on this site with caution until it is found.", rows, data_through, src, trigger=trig)
    if age > 6:
        return item("self_test", "Is the signal still working?", q, "warn", "Yes, but the data is old",
                    f"The tests match, but the newest price is {age} days old. The daily update may have stopped.", rows, data_through, src, trigger=trig)
    return item("self_test", "Is the signal still working?", q, "good", "Yes",
                "Every update reruns the backtest on the fixed history and compares it with the expected result. They match.",
                rows, data_through, src, trigger=trig)


# ---------- putting it together ----------

def trigger_now(i):
    """Where a trigger stands right now, in a few words (shown in the triggers table)."""
    try:
        kv = dict(i["kv"])
        if i["key"] == "curve":
            gap = i["kv"][1][1] if len(i["kv"]) > 1 and "pts" in i["kv"][1][1] else i["kv"][0][1]
            return f"Curve at {gap}; warning {'on' if i['kind'] == 'bad' else 'off'}"
        if i["key"] == "zero_rates":
            return f"Fed rate {kv["Fed's target rate, upper end"]}"
        if i["key"] == "concentration":
            return f"Top 10 are {i['answer']} of the index"
        if i["key"] == "nasdaq":
            return f"Nasdaq {kv['Difference']} vs. the S&P 500"
        if i["key"] == "sales":
            n = kv["Of those, false alarms"]
            return f"{n} false alarm{'' if n == '1' else 's'} in two years"
        if i["key"] == "self_test":
            return "Tests match" if i["kind"] != "bad" else "Tests don't match"
    except Exception:                                        # noqa: BLE001 - fall back to the plain answer
        pass
    return i["answer"]


def latest_sp_price(signal):
    """The newest S&P 500 close the site has: this month so far if available, else the last full month."""
    pv = signal.get("provisional") or {}
    return float(pv.get("sp_close") or signal["official"]["sp_close"])


def load_previous():
    try:
        return {i["key"]: i for i in json.loads((DATA_DIR / "watch.json").read_text()).get("items", [])}
    except Exception:                                        # noqa: BLE001 - first run, or an unreadable file
        return {}


def seed_item(key):
    if key == "concentration":
        s = SEED[key]
        it = item(key, "What you hold", "How much of the S&P 500 is its ten biggest companies?", "warn", pct(s["value"], 0),
                  "Far above the historical norm. The Nasdaq-100 fund holds many of the same companies at higher weights.",
                  [("Ten largest companies' share of the S&P 500", pct(s["value"], 0)), ("Normal from 1990 to 2015", "18% to 23%"),
                   ("Trigger", f"over {TOP10_TRIGGER:.0f}%")], s["as_of"], s["source"],
                  trigger="Top-10 concentration passes 50% of the S&P 500")
        return it
    if key == "returns":
        s = SEED[key]
        return item(key, "Expectations", "What are stocks priced to return over the next decade?", "warn", "About 5% to 7% a year",
                    "Published 10-year outlooks are well below the roughly 10% a year stocks returned historically. Plan around the "
                    "low and middle projections, not the backtest.", [("Published outlook", "4.8% to 6.8% a year")], s["as_of"], s["source"])
    return None


def build_watch(m, sig, signal, backtest, official, series, fetchers=None):
    """Run every check. `series` holds the extra FRED downloads; a missing or failing one only affects its own check.

    fetchers: optional {"top10": function, "shiller_pe": function}, used by tests to avoid the internet.
    """
    f = fetchers or {}
    previous = load_previous()
    zero_now = False
    try:
        zero_now = float(series["fed_upper"].iloc[-1]) <= ZERO_RATE
    except Exception:                                        # noqa: BLE001
        pass
    infl = None
    try:
        infl = float(series["breakeven"].dropna().iloc[-1])
    except Exception:                                        # noqa: BLE001
        pass

    checks = [
        ("curve", lambda: check_curve(signal)),
        ("zero_rates", lambda: check_zero_rates(series["fed_upper"])),
        ("unemployment", lambda: check_unemployment(series["unrate"], zero_now)),
        ("bond_stress", lambda: check_bond_stress(series["baa"], series["aaa"])),
        ("concentration", lambda: check_concentration(f.get("top10", fetch_top10))),
        ("nasdaq", lambda: check_nasdaq(m)),
        ("safe_side", lambda: check_safe_side(m)),
        ("sales", lambda: check_sales(backtest, official)),
        ("self_test", lambda: check_self_test(m, sig, signal["data_through"]["sp500"])),
        ("returns", lambda: check_returns(latest_sp_price(signal), (previous.get("returns") or {}).get("base"), infl,
                                          f.get("shiller_pe", fetch_shiller_pe))),
    ]
    items = []
    for key, run in checks:
        try:
            items.append(run())
        except Exception as e:                               # noqa: BLE001 - one broken check must not stop the rest
            print(f"  watch: '{key}' could not update ({e}); keeping the last reading")
            old = previous.get(key) or seed_item(key)
            if old is None:
                old = item(key, "Not available", key.replace("_", " ").capitalize(), "warn", "No reading yet",
                           "This check has not been able to download its data yet.", [], None, None)
            old = dict(old, stale=True, error=str(e)[:300])
            items.append(old)

    for i in items:                                          # a few words for the triggers table: where each one stands
        i["now"] = trigger_now(i)

    hit = [i for i in items if i["trigger_hit"]]
    amber = [i for i in items if i["kind"] in ("warn", "bad") and not i["trigger_hit"]]
    stale = [i for i in items if i["stale"]]
    if hit:
        summary = {"kind": "bad", "title": f"{len(hit)} trigger{'s' if len(hit) != 1 else ''} hit: time to revisit the plan",
                   "text": "A line the plan said to watch for has been crossed. The rules don't change by themselves; this is the cue to re-test them."}
    elif amber:
        summary = {"kind": "warn", "title": "No triggers hit. A few things worth knowing",
                   "text": "Nothing here calls for action. The amber items are background to be aware of."}
    else:
        summary = {"kind": "good", "title": "All quiet", "text": "Nothing on the watch list needs attention."}
    summary.update(triggers_hit=len(hit), amber=len(amber), green=sum(i["kind"] == "good" for i in items), not_updated=len(stale))

    return {"schema": SCHEMA, "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "summary": summary, "items": items}
