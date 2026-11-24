"""
make_history.py — ONE-TIME script. You don't need to run this again.

It shrinks two big source files into one small monthly file the site uses:
  - us_market_data.csv  (daily S&P 500 + T-bill data back to 1885, ~5 MB)
  - ndx_monthly.csv     (Nasdaq-100 month-end closes since 1985)

Output: history/monthly_history.csv, one row per month:
  month      e.g. 1987-01
  sp_close   S&P 500 month-end price (scaled index; update.py converts it to real S&P points)
  sp_tr      S&P 500 total return that month (price + dividends), e.g. 0.0132 = +1.32%
  tbill_r    T-bill return that month
  tbill_rate T-bill yield that month (monthly average, %), used only as a backup for TB3MS
  ndx_close  Nasdaq-100 month-end close (blank before Oct 1985)

Usage: python make_history.py path/to/us_market_data.csv path/to/ndx_monthly.csv
"""
import sys
from pathlib import Path

import pandas as pd


def main(daily_path, ndx_path):
    d = pd.read_csv(daily_path, parse_dates=["Date"]).set_index("Date").sort_index()
    month = d.index.to_period("M")
    g = d.groupby(month)

    out = pd.DataFrame({
        "sp_close": g["Close"].last(),
        "sp_tr": g["Adjusted Close"].last().pct_change(),
        "tbill_r": g["Risk Free Return"].last().pct_change(),
        "tbill_rate": g["Risk Free Rate"].mean(),
    })

    # The daily file stops partway through its last month, so drop that partial month.
    last_day = d.index.max()
    if (last_day + pd.offsets.BDay(1)).month == last_day.month:
        out = out.iloc[:-1]

    n = pd.read_csv(ndx_path)
    n.index = pd.PeriodIndex(n["month"], freq="M")
    out = out.join(n["close"].rename("ndx_close"), how="outer").sort_index()

    out = out[out.index >= pd.Period("1950-01", "M")]   # older data isn't needed
    out.index = out.index.astype(str)
    out.index.name = "month"

    dest = Path(__file__).parent / "history" / "monthly_history.csv"
    dest.parent.mkdir(exist_ok=True)
    out.to_csv(dest, float_format="%.8g")
    print(f"Wrote {dest} ({len(out)} months, {out.index[0]} to {out.index[-1]})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
