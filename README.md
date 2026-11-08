# Torn Countdown

Adds countdown rows to Torn's TCT clock popup in the header. Each row counts
down to a calendar event or to a date you type. Each row can have a
**preparation window**, so the countdown ends a number of hours *before* the
event starts.

```
Sun 10:26:50 - 08/11/26
──────────────────────────────
Diabetes Day        4d 17:48:10
Anniversary         6d 13:33:10
Custom date         2d 17:33:10
──────────────────────────────
⚙ Countdowns
```

## What a row shows

- **Orange** — time left to the preparation deadline (start minus your window).
- **Green** — time left to the start itself.
- **Blue** — the event runs now. The value is the time left to the end.
- **Grey** — the event ended, or the entry has no date.

A row with a preparation window shows the **preparation deadline** by default.
**Click the row** to switch it to the start, and click again to switch back.
The choice is saved per row. A row without a preparation window always shows
the start.

Hover a row to see the exact TCT dates.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open the raw file — the manager offers to install it:
   <https://github.com/eugene-torn-scripts/torn-countdown/raw/main/torn-countdown.user.js>
3. Open any Torn page. Click the clock button in the header. Click
   **⚙ Countdowns**.

## Settings

Open the clock popup, then click **⚙ Countdowns**.

| Field | Means |
|---|---|
| Torn API key | A **Minimal** access key. Needed only for calendar events. |
| Name | The text shown in the clock popup. |
| Target | `Calendar event` or `Manual date and time`. |
| Event | Any event or competition that has not ended yet. |
| Start (TCT) | The date and time for a manual entry. Always TCT. |
| Prep window | Hours. The countdown ends this many hours before the start. `0` turns it off. |
| Show in clock | Hide a row without deleting it. |

## Events and the personal event time

The event list comes from the Torn API:

- `GET /v2/torn/calendar` — all events and competitions of the running year.
  Needs a **Public** key.
- `GET /v2/user/calendar` — your personal event start time, for example
  `10:15 TCT`. Needs a **Minimal** key.

Torn marks some events with `fixed_start_time: false`. Those events follow
**your** personal event time. For those events:

- **Start** = the day before the published start, at your personal time.
- **End** = the day after the published end, at your personal time.

Example with a personal time of `10:15 TCT`: World Diabetes Day is published
for 14/11. For you it runs from **13/11 10:15** to **15/11 10:15** — 48 hours.
This rule matches the `earliest_start` and `latest_end` values that the API
returns.

Events with `fixed_start_time: true`, such as Torn Anniversary and Black
Friday, always use the published time. Torn Anniversary runs from 15/11 00:00
to 16/11 00:00 for every player.

If you change your event time in the in-game calendar, or Torn moves an event,
the script follows. It re-reads both endpoints every 30 minutes, and also when
you open the settings. **Refresh calendar** forces a re-read at once. An entry
points at an event by name, not by date, so a new date is picked up
automatically.

## Clock accuracy

The script does not trust your computer clock. It reads Torn's own clock text
from the popup and corrects the difference. The countdowns stay in step with
the game even if your machine clock is wrong.

## Tests

The mock reproduces the real clock markup, a fake Torn API and a fake
userscript manager. No Torn account and no API key are needed.

```bash
node mock/run-tests.js            # 72 assertions, headless Chrome
```

Open `mock/index.html` through a local web server to work on the layout by
hand:

```bash
python3 -m http.server 8799       # then open /mock/index.html
```

Buttons on the mock page: seed example countdowns, simulate a React re-render
of the popup, run the tests, reset storage.

## Notes

- The script only reads data and shows times. It does not act in the game.
- Desktop and Torn PDA both work. The script uses `GM_xmlhttpRequest` on
  desktop and `PDA_httpGet` on PDA.
- Torn rebuilds the clock popup every time you open it. The script watches for
  that and puts the rows back.
