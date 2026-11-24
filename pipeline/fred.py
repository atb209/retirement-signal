"""
fred.py — downloads data series from FRED (the St. Louis Fed's free data service).

How it works:
  - Your FRED API key is read from an environment variable called FRED_API_KEY.
    It is never written in the code, so the code can be public while the key stays private.
  - Each download is also saved to pipeline/cache/ so you can re-run offline while testing.
    The cache folder is listed in .gitignore, so it never gets uploaded to GitHub.
"""
import json
import os
import time
from pathlib import Path

import pandas as pd
import requests

API_URL = "https://api.stlouisfed.org/fred/series/observations"
CACHE_DIR = Path(__file__).parent / "cache"


def get_series(series_id, start="1900-01-01", keep_blanks=False):
    """Return one FRED series as a pandas Series indexed by date.

    FRED lists market holidays with the value "." (no number). Those become NaN.
    keep_blanks=True keeps those rows; update.py uses them to tell that a month is over.
    """
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        rows = _download(series_id, start, key)
        CACHE_DIR.mkdir(exist_ok=True)
        (CACHE_DIR / f"{series_id}.json").write_text(json.dumps(rows))
    else:
        cached = CACHE_DIR / f"{series_id}.json"
        if not cached.exists():
            raise SystemExit(
                f"No FRED_API_KEY set and no cached copy of {series_id}.\n"
                "Set the key first (see the README), then run this again."
            )
        rows = json.loads(cached.read_text())

    values = {
        pd.Timestamp(r["date"]): (float(r["value"]) if r["value"] not in (".", "") else float("nan"))
        for r in rows
    }
    s = pd.Series(values, dtype=float).sort_index()
    s = s[s.index >= pd.Timestamp(start)]
    s.name = series_id
    return s if keep_blanks else s.dropna()


def _download(series_id, start, key, attempts=4):
    params = {"series_id": series_id, "api_key": key, "file_type": "json", "observation_start": start}
    for attempt in range(1, attempts + 1):
        try:
            resp = requests.get(API_URL, params=params, timeout=30)
            if resp.status_code == 200:
                return resp.json()["observations"]
            if resp.status_code == 400:
                # FRED explains bad requests (most often a wrong API key) in the response
                msg = resp.json().get("error_message", resp.text)
                raise SystemExit(f"FRED rejected the request for {series_id}: {msg}")
            problem = f"HTTP {resp.status_code}"
        except requests.RequestException as e:
            problem = str(e)
        if attempt < attempts:
            wait = 5 * attempt
            print(f"  {series_id}: {problem}; retrying in {wait}s")
            time.sleep(wait)
    raise SystemExit(f"Could not download {series_id} from FRED after {attempts} tries ({problem}).")
