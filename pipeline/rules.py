"""
rules.py — the retirement plan's rules, written as plain functions.

Everything here works on monthly data (one row per month, month-end values).
Nothing here downloads anything or writes files; update.py does that.

THE RULES (checked once a month, at the month-end close):
  Sell half the S&P and all of the Nasdaq-100 when BOTH are true:
    1. Trend broken:      the S&P 500 closes below its average of the last 10 month-end closes
    2. Recession warning: the yield curve (10-year minus 3-month T-bill, GS10 - TB3MS) dropped
                          below zero ("inverted"), and that inversion STARTED no more than
                          24 months ago. The clock runs from the first inverted month, however
                          long the inversion lasts. A new clock starts only when the curve
                          inverts again after at least 6 normal months.
  Buy back to 70/30 when the S&P closes a month back above its 10-month average.
"""
import numpy as np
import pandas as pd

SMA_MONTHS = 10        # trend line: average of the last 10 month-end closes
CLOCK_MONTHS = 24      # the recession warning runs for 24 months, counted from the month an inversion starts
RESTART_GAP = 6        # a new inversion (and a new clock) needs the curve to have been normal this many months
COST = 0.001           # 0.1% trading cost per 100% of the portfolio traded

# Portfolio weights: (S&P 500, Nasdaq-100, Treasuries, T-bills)
WEIGHTS = {
    "plan7030": {"normal": (0.70, 0.30, 0.0, 0.0), "trimmed": (0.35, 0.0, 0.325, 0.325)},
    "spcore":   {"normal": (1.00, 0.00, 0.0, 0.0), "trimmed": (0.50, 0.0, 0.25, 0.25)},
    "ndx100":   {"normal": (0.00, 1.00, 0.0, 0.0), "trimmed": (0.00, 0.0, 0.50, 0.50)},   # all Nasdaq-100, sells all of it
    "sp100":    {"normal": (1.00, 0.00, 0.0, 0.0), "trimmed": (0.00, 0.0, 0.50, 0.50)},   # all S&P 500, sells all of it
}


def warning_clock(inverted):
    """The recession-warning clock.

    inverted: one True/False per month (True = the yield curve was inverted that month).
    Returns two lists, one entry per month:
      start: position of the first month of the latest inversion (None before any inversion)
      on:    True while the warning is on (within CLOCK_MONTHS of that start)
    """
    start, normal_run, starts, on = None, RESTART_GAP, [], []
    for i, inv in enumerate(inverted):
        if inv:
            if normal_run >= RESTART_GAP:      # a fresh inversion: restart the clock here
                start = i
            normal_run = 0
        else:
            normal_run += 1
        starts.append(start)
        on.append(start is not None and i - start <= CLOCK_MONTHS)
    return starts, on


def check_signals(close, spread):
    """Apply the rules month by month.

    close:  S&P 500 month-end closes
    spread: GS10 minus TB3MS for each month (negative = inverted)
    Returns a table with one row per month, including `invested`:
      1 = fully invested after that month's check, 0 = trimmed after that month's check.
    """
    df = pd.DataFrame({"close": close, "spread": spread}).dropna()
    df["sma10"] = df["close"].rolling(SMA_MONTHS).mean()
    df["inverted"] = df["spread"] < 0
    starts, on = warning_clock(df["inverted"])
    df["inv_start"] = [df.index[i] if i is not None else None for i in starts]   # month the latest inversion began
    df["clock_month"] = [k - i if i is not None else None for k, i in enumerate(starts)]  # months since it began
    df["warning"] = on

    invested, action = [], []
    state = 1
    for row in df.itertuples():
        act = ""
        if not np.isnan(row.sma10):
            if state == 1 and row.close < row.sma10 and row.warning:
                state, act = 0, "sell"
            elif state == 0 and row.close > row.sma10:
                state, act = 1, "buy back"
        invested.append(state)
        action.append(act)
    df["invested"] = invested
    df["action"] = action
    return df


def bond_returns(gs10):
    """Monthly return of a 10-year Treasury, rebuilt from the monthly 10-year yield.

    Each month: buy a new 10-year bond paying last month's yield, then price it at this
    month's yield one month later. Return = interest earned + price change.
    """
    y = gs10 / 100
    prev = y.shift(1)
    n = 2 * (10 - 1 / 12)                     # semiannual payments left after one month
    disc = (1 + y / 2) ** (-n)
    price = (prev / y) * (1 - disc) + disc    # price of last month's bond at today's yield
    return price - 1 + prev / 12


def portfolio_returns(m, invested, view, start):
    """Monthly returns for a plan (or for buy-and-hold if invested is always 1).

    m: monthly table with returns sp_tr, ndx_tr, bond_r, bill_r
    The decision made at the end of month t applies to month t+1.
    """
    held = invested.shift(1)                  # the state you hold during each month
    w = WEIGHTS[view]
    normal, trimmed = np.array(w["normal"]), np.array(w["trimmed"])
    rets = m[["sp_tr", "ndx_tr", "bond_r", "bill_r"]]
    if view in ("spcore", "sp100"):          # options with no Nasdaq-100 can start before its data does
        rets = rets.assign(ndx_tr=0.0)
    df = pd.concat([rets, held.rename("held")], axis=1).dropna()
    df = df[df.index >= start]

    W = np.where(df["held"].to_numpy()[:, None] == 1, normal, trimmed)
    gross = (W * df[["sp_tr", "ndx_tr", "bond_r", "bill_r"]].to_numpy()).sum(axis=1)
    turnover = np.r_[0, np.abs(np.diff(W, axis=0)).sum(axis=1) / 2]
    return pd.Series(gross - COST * turnover, index=df.index), df["held"]


def growth(r, start_value=10_000):
    """Turn monthly returns into a dollar value path, starting the month before the first return."""
    first = (pd.Period(r.index[0], "M") - 1).strftime("%Y-%m")
    v = start_value * (1 + r).cumprod()
    return pd.concat([pd.Series({first: float(start_value)}), v])


def stats(value):
    """Headline numbers for a dollar value path."""
    months = len(value) - 1
    cagr = (value.iloc[-1] / value.iloc[0]) ** (12 / months) - 1
    dd = value / value.cummax() - 1
    r12 = value / value.shift(12) - 1
    return {
        "cagr": round(cagr * 100, 2),
        "max_drawdown": round(dd.min() * 100, 1),
        "worst_12m": round(r12.min() * 100, 1),
        "end_value": round(float(value.iloc[-1])),
    }


def episodes(invested, plan_r, hold_r, start):
    """Every sale and buy-back in the period, with how the sale worked out vs. just holding."""
    inv = invested[invested.index >= (pd.Period(start, "M") - 1).strftime("%Y-%m")]
    months = list(inv.index)
    rows, sold = [], None
    for prev, cur in zip(months, months[1:]):
        if inv[prev] == 1 and inv[cur] == 0:
            sold = cur
        elif inv[prev] == 0 and inv[cur] == 1 and sold:
            rows.append(_episode(sold, cur, plan_r, hold_r))
            sold = None
    if sold:
        rows.append(_episode(sold, None, plan_r, hold_r))
    return rows[::-1]                        # newest first


def _episode(sold, back, plan_r, hold_r):
    span = plan_r.index[(plan_r.index > sold) & ((plan_r.index <= back) if back else True)]
    plan_g = (1 + plan_r[span]).prod()
    hold_g = (1 + hold_r[span]).prod()
    return {
        "sold": sold,
        "bought_back": back,                 # None = still trimmed
        "months": len(span),
        "stocks_while_out": round((hold_g - 1) * 100, 1),
        "vs_holding": round((plan_g - hold_g) * 100, 1),
    }
