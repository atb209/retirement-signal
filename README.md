# Retirement Signal

A small website for a rules-based retirement signal with four options (100% Nasdaq-100, 100% S&P 500, a 70/30 mix, and S&P 500 selling half). Each option steps aside (into Treasuries and T-bills) when the S&P 500's trend breaks after a yield-curve recession warning, and buys back when the trend recovers.

Five pages, written for readers without a finance background:

- **Home** (`index.html`): the growth chart vs. S&P 500 and Nasdaq-100 buy-and-hold, with zoom, hover and play; headline numbers; a what-if calculator; every sale
- **How it works** (`framework.html`): the two warning signs with pictures, and 2008 month by month
- **Signal now** (`signal.html`): where the signal stands this month, in plain words
- **Watch list** (`watch.html`): the conditions that could change how well the signal works, checked automatically every weekday
- **Learn** (`learn.html`): common questions and a glossary

## How it fits together

```
FRED (free data)  ->  pipeline/update.py  ->  data/*.json  ->  the pages
                      (GitHub runs this every weekday morning)
```

| File | What it does |
| --- | --- |
| `pipeline/fred.py` | Downloads data from FRED using your API key |
| `pipeline/rules.py` | The signal's rules and the backtest math |
| `pipeline/update.py` | Runs everything and writes `data/backtest.json`, `data/signal.json` and `data/watch.json` |
| `pipeline/watch.py` | The watch-list checks: each one answers a plain question and sets a green, amber or red light |
| `pipeline/history/monthly_history.csv` | Frozen monthly history (S&P 500 since 1950, Nasdaq-100 since 1985) |
| `data/test-1920-1967.json` | A one-time test of the signal on 1920–1967, shown at the bottom of the home page. The daily update never changes it |
| `assets/style.css` | The whole look: colors, fonts, layout. The settings are the `--names` at the top |
| `assets/common.js` | Helpers shared by every page (loading data, formatting, chart extras) |
| `assets/home.js`, `framework.js`, `signal.js`, `watch.js`, `learn.js` | Fill in each page from the JSON files |
| `assets/vendor/chart.umd.js` | Chart.js 4.4.1, the charting library (MIT license) |
| `preview.py` | Shows the site on your own computer, always with your latest edits |
| `.github/workflows/update.yml` | The schedule: update the data, then publish the site |

## Run it on your own computer

```
cd pipeline
pip install -r requirements.txt
$env:FRED_API_KEY = "your_key_here"      (Windows PowerShell)
python update.py
cd ..
python preview.py
```

Then open http://localhost:8000.

Use `python preview.py` rather than `python -m http.server`: it tells the browser not to keep old copies of files, so a normal refresh always shows your latest changes.

## Notes

- Month-end closes, dividends included. S&P 500 dividends after the history file ends are estimated at 1.2% a year and Nasdaq-100 dividends at 0.7% a year. Trading cost is 0.1% per trade.
- The official signal locks only once the month's final close and FRED's monthly GS10 and TB3MS figures are all posted.
- Each stylesheet and script link carries a `?v=` version stamp. The publish step replaces it with the commit id, so visitors never see a mix of old and new files.
- The watch list uses two sources besides FRED: a fund company's daily S&P 500 holdings file (State Street's SPY, with iShares' IVV as a fallback) and multpl.com for the Shiller PE ratio. multpl.com refuses connections from GitHub's servers, so the return estimate is computed in `watch.py` from the live S&P 500 price and a stored 10-year earnings figure (`EARNINGS_BASE_SEED`), which refreshes itself whenever the source can be reached. If the card says the earnings figure is over a year old, update that one number. If either can't be reached, that check keeps its last reading and is marked "not updated"; nothing else is affected.
- Educational illustration of a personal project. Not investment advice.
