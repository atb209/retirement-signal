"""
update.py — the script GitHub runs on a schedule. It:
  1. loads the frozen history file (history/monthly_history.csv)
  2. downloads fresh data from FRED (S&P 500, Nasdaq-100, 10-year and 3-month T-bill yields)
  3. joins them into one monthly table
  4. runs the plan's rules (rules.py) and the historical backtest
  5. writes two files the website reads: data/backtest.json and data/signal.json

Usage (from the pipeline folder):  python update.py
Needs the FRED_API_KEY environment variable (see README).
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import fred
import rules

HERE = Path(__file__).parent
DATA_DIR = HERE.parent / "data"

SCHEMA = 4        # version of the data files' layout; the web pages check it so old data can't be shown by mistake
DIV_SP = 0.012    # estimated S&P 500 dividend yield, used only for months after the history file ends
DIV_NDX = 0.007   # estimated Nasdaq-100 dividend yield (same assumption as the original backtest)

# The four options. Each follows the same signal on the same dates; they differ in which funds
# they hold and in how much they sell when the signal says to step aside.
#   invested / aside: what the option holds, in plain words      stocks_aside: % still in stocks after a sell signal
VIEWS = {
    "ndx100":   {"name": "100% Nasdaq-100", "start": "1987-01", "hold_name": "Nasdaq-100", "stocks_aside": 0,
                 "invested": "100% Nasdaq-100", "aside": "0% stocks. Sells all of it."},
    "sp100":    {"name": "100% S&P 500", "start": "1968-01", "hold_name": "S&P 500", "stocks_aside": 0,
                 "invested": "100% S&P 500", "aside": "0% stocks. Sells all of it."},
    "plan7030": {"name": "70/30 mix", "start": "1987-01", "hold_name": "70/30 mix", "stocks_aside": 35,
                 "invested": "70% S&P 500, 30% Nasdaq-100", "aside": "35% S&P 500. Sells all the Nasdaq-100 and half the S&P 500."},
    "spcore":   {"name": "S&P 500, sells half", "start": "1968-01", "hold_name": "S&P 500", "stocks_aside": 50,
                 "invested": "100% S&P 500", "aside": "50% S&P 500. Sells half."},
}


# ---------- small helpers ----------

def to_months(s):
    """Re-label a date-indexed series by month ('2026-10'), keeping the last value in each month."""
    s = s.dropna()
    out = s.groupby(s.index.to_period("M")).last()
    out.index = out.index.strftime("%Y-%m")
    return out


def last_weekday(period):
    d = period.end_time.normalize()
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def last_closed_month(daily_with_blanks):
    """The latest month whose final trading day is in FRED's data.

    FRED adds a row for every weekday, with "." on market holidays, so once a row
    exists for the month's last weekday, that month's closing price is final.
    """
    last_row = daily_with_blanks.index.max()
    p = last_row.to_period("M")
    return p if last_row >= last_weekday(p) else p - 1


def clean(x, digits=2):
    """Make numbers JSON-friendly: round them and turn NaN into null."""
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return None
    return round(float(x), digits)


def fmt_month(m):
    return pd.Period(m, "M").strftime("%b %Y")


# ---------- step 1-3: build the monthly table ----------

def build_monthly(hist, sp_daily, ndx_daily, gs10, tb3):
    closed = last_closed_month(sp_daily).strftime("%Y-%m")
    sp_me = to_months(sp_daily)
    sp_me = sp_me[sp_me.index <= closed]

    # S&P 500: the history file uses a scaled index, so convert it to real S&P points
    # using the months where both sources overlap.
    hist_sp = hist["sp_close"].dropna()
    hist_end = hist_sp.index[-1]
    overlap = hist_sp.index.intersection(sp_me.index)
    ratio = sp_me[overlap] / hist_sp[overlap]
    scale = ratio.median()
    mismatch = (ratio / scale - 1).abs().max() * 100
    print(f"  S&P history vs FRED: {len(overlap)} overlapping months, largest gap {mismatch:.2f}%")

    later = sp_me.index[sp_me.index > hist_end]
    sp_close = pd.concat([hist_sp * scale, sp_me[later]])
    sp_tr = pd.concat([hist["sp_tr"][hist["sp_tr"].index <= hist_end],
                       (sp_me.pct_change() + DIV_SP / 12)[later]])

    # Nasdaq-100: history file first, then FRED for months after it ends
    hist_ndx = hist["ndx_close"].dropna()
    ndx_me = to_months(ndx_daily)
    ndx_me = ndx_me[ndx_me.index <= closed]
    ndx_close = pd.concat([hist_ndx, ndx_me[ndx_me.index > hist_ndx.index[-1]]])
    both = hist_ndx.index.intersection(ndx_me.index)
    if len(both):
        gap = ((ndx_me[both] / hist_ndx[both]) - 1).abs().max() * 100
        print(f"  Nasdaq-100 history vs FRED: largest gap {gap:.2f}% over {len(both)} months")

    gs10_m, tb3_m = to_months(gs10), to_months(tb3)
    bill_r = pd.concat([hist["tbill_r"][hist["tbill_r"].index <= hist_end],
                        (tb3_m / 1200)[tb3_m.index > hist_end]])

    m = pd.DataFrame({
        "sp_close": sp_close, "sp_tr": sp_tr,
        "ndx_close": ndx_close, "ndx_tr": ndx_close.pct_change() + DIV_NDX / 12,
        "gs10": gs10_m, "tb3": tb3_m,
        "bond_r": rules.bond_returns(gs10_m), "bill_r": bill_r,
    }).sort_index()
    m["spread"] = m["gs10"] - m["tb3"]
    return m[m.index <= closed], closed


# ---------- step 4: backtest ----------

def build_backtest(m, sig, official):
    out = {"as_of_month": official, "views": {}}
    for key, v in VIEWS.items():
        plan_r, held = rules.portfolio_returns(m, sig["invested"], key, v["start"])
        hold_r, _ = rules.portfolio_returns(m, sig["invested"] * 0 + 1, key, v["start"])
        bench_r = m["sp_tr"].reindex(plan_r.index)

        plan_v, bench_v = rules.growth(plan_r), rules.growth(bench_r)
        trimmed = [0] + [int(h == 0) for h in held]
        trades = rules.episodes(sig["invested"], plan_r, hold_r, v["start"])
        out["views"][key] = {
            "name": v["name"],
            "invested": v["invested"],
            "aside": v["aside"],
            "stocks_aside": v["stocks_aside"],
            "hold_name": v["hold_name"],
            "months": list(plan_v.index),
            "plan": [round(x, 2) for x in plan_v],
            "benchmark": [round(x, 2) for x in bench_v],
            "plan_dd": [round(x * 100, 2) for x in plan_v / plan_v.cummax() - 1],
            "bench_dd": [round(x * 100, 2) for x in bench_v / bench_v.cummax() - 1],
            "trimmed": trimmed,
            "stats": {
                "plan": rules.stats(plan_v),
                "benchmark": rules.stats(bench_v),
                "sales": len(trades),
                "pct_months_trimmed": round(100 * sum(trimmed) / (len(trimmed) - 1), 1),
            },
            "trades": trades,
        }
        if key in ("plan7030", "ndx100"):   # Nasdaq-100 buy and hold, for comparison (its data starts in 1985)
            ndx_v = rules.growth(m["ndx_tr"].reindex(plan_r.index))
            view = out["views"][key]
            view["nasdaq"] = [round(x, 2) for x in ndx_v]
            view["nasdaq_dd"] = [round(x * 100, 2) for x in ndx_v / ndx_v.cummax() - 1]
            view["stats"]["nasdaq"] = rules.stats(ndx_v)

    # Monthly history of both signals, for the explainer charts and the 2008 walkthrough
    h = sig[sig.index >= "1967-01"]
    out["signals"] = {
        "months": list(h.index),
        "close": [round(float(x), 1) for x in h["close"]],
        "sma10": [None if np.isnan(x) else round(float(x), 1) for x in h["sma10"]],
        "spread": [round(float(x), 2) for x in h["spread"]],
        "warning": [int(x) for x in h["warning"]],
        "invested": [int(x) for x in h["invested"]],
    }
    return out


def recession_spans(usrec):
    """Turn FRED's monthly recession flag (1 = in recession) into [start, end] month pairs."""
    flags = to_months(usrec)
    flags = flags[flags.index >= "1960-01"]
    spans, start = [], None
    for month, flag in flags.items():
        if flag == 1 and start is None:
            start = month
        elif flag == 0 and start is not None:
            spans.append([start, prev])
            start = None
        prev = month
    if start is not None:
        spans.append([start, prev])
    return spans


def verification_report(m, sig):
    """A self-check on the fixed history: these numbers should not move from run to run."""
    print("\n  Self-check on the history through Nov 2025 (should be close to these):")
    for key, start, end, target in (("spcore", "1968-01", "2025-11", "S&P plan ~11.9%/yr, worst ~-30%"),
                                    ("plan7030", "1987-01", "2025-11", "70/30 plan ~14.6%/yr")):
        r, _ = rules.portfolio_returns(m, sig["invested"], key, start)
        r = r[r.index <= end]
        s = rules.stats(rules.growth(r))
        b = rules.stats(rules.growth(m["sp_tr"].reindex(r.index)))
        print(f"   {start[:4]}-{end[:4]} {key:9s} plan {s['cagr']:5.2f}%/yr worst {s['max_drawdown']:6.1f}% | "
              f"S&P buy-and-hold {b['cagr']:5.2f}%/yr worst {b['max_drawdown']:6.1f}%   (expected: {target})")


# ---------- step 4b: the current signal ----------

def clock_dates(start):
    """The month an inversion began, and the last month its 24-month warning is on."""
    if start is None or (isinstance(start, float) and np.isnan(start)):
        return None, None
    return start, (pd.Period(start, "M") + rules.CLOCK_MONTHS).strftime("%Y-%m")


def build_signal(m, sig, official, sp_daily, dgs10, dtb3):
    o = sig.loc[official]
    last_inv = sig.index[sig["inverted"]][-1] if sig["inverted"].any() else None
    start, lapse = clock_dates(o["inv_start"])

    official_block = {
        "month": official,
        "month_label": fmt_month(official),
        "invested": int(o["invested"]),
        "action": o["action"] or "none",
        "sp_close": clean(o["close"]),
        "sma10": clean(o["sma10"]),
        "pct_vs_sma": clean((o["close"] / o["sma10"] - 1) * 100),
        "trend_broken": bool(o["close"] < o["sma10"]),
        "spread": clean(o["spread"]),
        "warning": bool(o["warning"]),
        "last_inverted": last_inv,
        "last_inverted_label": fmt_month(last_inv) if last_inv else None,
        "inversion_started": start,
        "inversion_started_label": fmt_month(start) if start else None,
        "clock_month": None if start is None else int(o["clock_month"]),
        "clock_months": rules.CLOCK_MONTHS,
        "warning_lapses_after": lapse,
        "warning_lapses_after_label": fmt_month(lapse) if lapse else None,
    }

    # ----- provisional: "if the month ended today" -----
    p = (pd.Period(official, "M") + 1)
    pm = p.strftime("%Y-%m")
    in_p = sp_daily.dropna()
    in_p = in_p[in_p.index.to_period("M") == p]
    provisional = None
    if len(in_p):
        price, as_of = float(in_p.iloc[-1]), in_p.index[-1]
        month_closed = pm in m.index
        if month_closed and not np.isnan(m.loc[pm, "spread"]):
            spread_p, spread_src = float(m.loc[pm, "spread"]), "monthly"
        else:
            d10 = dgs10[dgs10.index.to_period("M") == p]
            db3 = dtb3[dtb3.index.to_period("M") == p]
            spread_p = float(d10.mean() - db3.mean()) if len(d10) and len(db3) else float("nan")
            spread_src = "month-to-date daily average"
        prior = sig["close"].iloc[-(rules.SMA_MONTHS - 1):]          # the 9 months before p
        sma_p = (prior.sum() + price) / rules.SMA_MONTHS
        level = prior.mean()                                          # close above this = above the average
        inverted_p = bool(not np.isnan(spread_p) and spread_p < 0)
        months_p = list(sig.index) + [pm]
        starts_p, on_p = rules.warning_clock(list(sig["inverted"]) + [inverted_p])   # the clock, with this month added
        warning_p = on_p[-1]
        start_p, lapse_p = clock_dates(months_p[starts_p[-1]] if starts_p[-1] is not None else None)
        if o["invested"] == 1:
            would = "sell" if (price < sma_p and warning_p) else "hold"
        else:
            would = "buy back" if price > sma_p else "stay trimmed"
        provisional = {
            "month": pm,
            "month_label": p.strftime("%B %Y"),
            "as_of": as_of.strftime("%Y-%m-%d"),
            "as_of_label": as_of.strftime("%b %d, %Y").replace(" 0", " "),
            "month_closed": month_closed,
            "sp_close": clean(price),
            "sma10": clean(sma_p),
            "level_to_beat": clean(level),
            "pct_vs_sma": clean((price / sma_p - 1) * 100),
            "trend_broken": bool(price < sma_p),
            "spread": clean(spread_p),
            "spread_source": spread_src,
            "warning": bool(warning_p),
            "inversion_started": start_p,
            "inversion_started_label": fmt_month(start_p) if start_p else None,
            "clock_month": None if start_p is None else len(months_p) - 1 - starts_p[-1],
            "warning_lapses_after": lapse_p,
            "warning_lapses_after_label": fmt_month(lapse_p) if lapse_p else None,
            "would_be": would,
            "check_date_label": last_weekday(p).strftime("%b %d, %Y").replace(" 0", " "),
        }

    recent = sig.iloc[-36:]
    held_trim = (sig["invested"].shift(1) == 0).iloc[-36:]   # trimmed during that month
    return {
        "official": official_block,
        "provisional": provisional,
        "history": {
            "months": list(recent.index),
            "close": [clean(x) for x in recent["close"]],
            "sma10": [clean(x) for x in recent["sma10"]],
            "spread": [clean(x) for x in recent["spread"]],
            "trimmed": [int(x) for x in held_trim],
        },
    }


# ---------- main ----------

def main():
    print("Loading history file")
    hist = pd.read_csv(HERE / "history" / "monthly_history.csv", index_col="month", dtype={"month": str})

    print("Downloading from FRED")
    ten_years_ago = (datetime.now() - timedelta(days=3650)).strftime("%Y-%m-%d")
    recent_start = (datetime.now() - timedelta(days=100)).strftime("%Y-%m-%d")
    sp_daily = fred.get_series("SP500", ten_years_ago, keep_blanks=True)
    ndx_daily = fred.get_series("NASDAQ100", "2020-01-01")
    gs10 = fred.get_series("GS10", "1953-01-01")
    tb3 = fred.get_series("TB3MS", "1950-01-01")
    dgs10 = fred.get_series("DGS10", recent_start)
    dtb3 = fred.get_series("DTB3", recent_start)
    usrec = fred.get_series("USREC", "1960-01-01")     # official US recession months (NBER), for the charts

    print("Building the monthly table")
    m, closed = build_monthly(hist, sp_daily, ndx_daily, gs10, tb3)

    # The official check uses the latest month where the close AND both monthly yields are posted.
    ready = m.dropna(subset=["sp_close", "gs10", "tb3"])
    official = ready.index[-1]
    waiting = [] if official == closed else [
        name for name, col in (("10-year yield (GS10)", "gs10"), ("3-month T-bill (TB3MS)", "tb3"))
        if np.isnan(m.loc[closed, col])
    ]
    print(f"  Official check: {fmt_month(official)}" +
          (f"  ({fmt_month(closed)} has closed; waiting on {', '.join(waiting)})" if waiting else ""))

    sig = rules.check_signals(ready["sp_close"], ready["spread"])

    backtest = build_backtest(ready, sig, official)
    backtest["recessions"] = recession_spans(usrec)
    signal = build_signal(m, sig, official, sp_daily, dgs10, dtb3)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    signal["generated_utc"] = backtest["generated_utc"] = stamp
    signal["schema"] = backtest["schema"] = SCHEMA
    signal["options"] = [{"key": k, "name": v["name"], "invested": v["invested"], "aside": v["aside"]} for k, v in VIEWS.items()]
    signal["pending"] = {"month": closed, "month_label": fmt_month(closed), "waiting_for": waiting} if waiting else None
    signal["data_through"] = {
        "sp500": sp_daily.dropna().index[-1].strftime("%Y-%m-%d"),
        "gs10": to_months(gs10).index[-1],
        "tb3ms": to_months(tb3).index[-1],
    }

    DATA_DIR.mkdir(exist_ok=True)
    for name, obj in (("backtest.json", backtest), ("signal.json", signal)):
        (DATA_DIR / name).write_text(json.dumps(obj, separators=(",", ":")))
        print(f"  Wrote data/{name}")

    o, pv = signal["official"], signal["provisional"]
    print(f"\n  Official ({o['month_label']}): {'INVESTED' if o['invested'] else 'TRIMMED'}, action: {o['action']}")
    if pv:
        print(f"  Provisional ({pv['as_of_label']}): would be '{pv['would_be']}'; "
              f"S&P {pv['sp_close']:,.0f} vs needed {pv['level_to_beat']:,.0f}")
    verification_report(ready, sig)


if __name__ == "__main__":
    main()
