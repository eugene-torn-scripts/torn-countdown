// ==UserScript==
// @name         Torn Countdown
// @namespace    https://github.com/eugene-torn-scripts
// @version      1.0.0
// @description  Adds configurable countdown rows to Torn's TCT clock popup. Count down to any calendar event or a manual TCT date, with an optional preparation window that ends the countdown early.
// @author       eugene_s [4192025]
// @match        https://www.torn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    "use strict";

    const VERSION = "1.0.0";
    const STORE_KEY = "tcd_settings_v1";
    const CAL_TTL_MS = 6 * 60 * 60 * 1000;
    const BG_REFRESH_MS = 30 * 60 * 1000;
    const HTTP_TIMEOUT_MS = 20000;
    const IS_PDA = typeof PDA_httpGet === "function";

    const DEFAULTS = {
        version: 1,
        apiKey: "",
        entries: [],
        calendar: { fetchedAt: 0, competitions: [], events: [] },
        personal: { fetchedAt: 0, startTime: null }
    };

    let state = loadState();
    let clockOffsetMs = 0;
    let clockOffsetKnown = false;
    let tickTimer = null;
    let refreshing = false;

    function loadState() {
        let raw = null;
        try {
            raw = GM_getValue(STORE_KEY, null);
        } catch (e) {
            raw = localStorage.getItem(STORE_KEY);
        }
        if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
        try {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), parsed);
        } catch (e) {
            return JSON.parse(JSON.stringify(DEFAULTS));
        }
    }

    function saveState() {
        const raw = JSON.stringify(state);
        try {
            GM_setValue(STORE_KEY, raw);
        } catch (e) {
            localStorage.setItem(STORE_KEY, raw);
        }
    }

    function uid() {
        return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function httpGetJson(url) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const watchdog = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error("timeout"));
            }, HTTP_TIMEOUT_MS);

            const done = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                fn(arg);
            };

            const parse = (text) => {
                let data;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    done(reject, new Error("bad JSON"));
                    return;
                }
                if (data && data.error) {
                    done(reject, new Error("Torn API error " + data.error.code + ": " + data.error.error));
                    return;
                }
                done(resolve, data);
            };

            if (IS_PDA) {
                try {
                    Promise.resolve(PDA_httpGet(url)).then((res) => {
                        const text = res && typeof res === "object" ? (res.responseText || res.response || "") : String(res || "");
                        parse(text);
                    }, (err) => done(reject, err));
                } catch (e) {
                    done(reject, e);
                }
                return;
            }

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: { "User-Agent": "torn-countdown/" + VERSION },
                timeout: HTTP_TIMEOUT_MS,
                onload: (res) => parse(res.responseText || ""),
                onerror: () => done(reject, new Error("network error")),
                ontimeout: () => done(reject, new Error("timeout"))
            });
        });
    }

    function readServerClock() {
        const span = document.querySelector(".tc-clock-tooltip .server-date-time");
        if (!span) return null;
        const m = /(\d{2}):(\d{2}):(\d{2})\s*-\s*(\d{2})\/(\d{2})\/(\d{2})/.exec(span.textContent || "");
        if (!m) return null;
        const epoch = Date.UTC(2000 + Number(m[6]), Number(m[5]) - 1, Number(m[4]), Number(m[1]), Number(m[2]), Number(m[3]));
        if (!isFinite(epoch)) return null;
        return epoch;
    }

    function syncClockOffset() {
        const serverMs = readServerClock();
        if (serverMs == null) return;
        const diff = serverMs - Date.now();
        if (Math.abs(diff) > 2000) {
            clockOffsetMs = diff;
        } else {
            clockOffsetMs = 0;
        }
        clockOffsetKnown = true;
    }

    function nowSec() {
        return Math.floor((Date.now() + clockOffsetMs) / 1000);
    }

    function parsePersonalMinutes(startTime) {
        if (!startTime) return null;
        const m = /(\d{1,2}):(\d{2})/.exec(String(startTime));
        if (!m) return null;
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h > 23 || min > 59) return null;
        return h * 60 + min;
    }

    function windowOf(ev) {
        return {
            earliest: typeof ev.earliest_start === "number" ? ev.earliest_start : ev.start,
            latest: typeof ev.latest_end === "number" ? ev.latest_end : ev.end
        };
    }

    function clampToWindow(candidate, ev) {
        const w = windowOf(ev);
        return Math.min(Math.max(candidate, w.earliest), w.latest);
    }

    function personalizedStart(ev, personalMinutes) {
        if (personalMinutes == null) return ev.start;
        const dayStart = Math.floor(ev.start / 86400) * 86400;
        return clampToWindow(dayStart - 86400 + personalMinutes * 60, ev);
    }

    function personalizedEnd(ev, personalMinutes) {
        if (personalMinutes == null) return ev.end;
        const dayStart = Math.floor(ev.end / 86400) * 86400;
        return clampToWindow(dayStart + 86400 + personalMinutes * 60, ev);
    }

    function allCalendarItems() {
        const out = [];
        (state.calendar.competitions || []).forEach((c) => out.push(Object.assign({ kind: "competitions" }, c)));
        (state.calendar.events || []).forEach((e) => out.push(Object.assign({ kind: "events" }, e)));
        return out;
    }

    function eventKeyOf(item) {
        return item.kind + "|" + item.title;
    }

    function findEvent(key) {
        if (!key) return null;
        return allCalendarItems().find((item) => eventKeyOf(item) === key) || null;
    }

    function startOfItem(item) {
        if (item.fixed_start_time === false) {
            return personalizedStart(item, parsePersonalMinutes(state.personal.startTime));
        }
        return item.start;
    }

    function endOfItem(item) {
        if (typeof item.end !== "number") return null;
        if (item.fixed_start_time === false) {
            return personalizedEnd(item, parsePersonalMinutes(state.personal.startTime));
        }
        return item.end;
    }

    function resolvedStart(entry) {
        if (entry.source === "manual") {
            return typeof entry.manualStart === "number" ? entry.manualStart : null;
        }
        const ev = findEvent(entry.eventKey);
        if (!ev) return null;
        return startOfItem(ev);
    }

    function resolvedEnd(entry) {
        if (entry.source === "manual") return null;
        const ev = findEvent(entry.eventKey);
        if (!ev) return null;
        return endOfItem(ev);
    }

    function prepSeconds(entry) {
        const h = Number(entry.prepHours);
        if (!isFinite(h) || h <= 0) return 0;
        return Math.round(h * 3600);
    }

    function formatDuration(sec) {
        if (sec < 0) sec = 0;
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = (n) => String(n).padStart(2, "0");
        if (d > 0) return d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s);
        return pad(h) + ":" + pad(m) + ":" + pad(s);
    }

    function formatTct(epochSec) {
        if (epochSec == null) return "—";
        const dt = new Date(epochSec * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        return pad(dt.getUTCDate()) + "/" + pad(dt.getUTCMonth() + 1) + "/" + String(dt.getUTCFullYear()).slice(2) +
            " " + pad(dt.getUTCHours()) + ":" + pad(dt.getUTCMinutes()) + " TCT";
    }

    function rowStateFor(entry) {
        const start = resolvedStart(entry);
        if (start == null) {
            return { mode: "unknown", text: "no date", title: "This entry has no resolved start time." };
        }
        const now = nowSec();
        const prep = prepSeconds(entry);
        const prepTarget = start - prep;
        const end = resolvedEnd(entry);
        const wantPrep = prep > 0 && entry.view !== "start";

        if (prep > 0 && now < prepTarget && wantPrep) {
            return {
                mode: "prep",
                text: formatDuration(prepTarget - now),
                title: "Preparation deadline " + formatTct(prepTarget) + " (" + entry.prepHours + "h before start " + formatTct(start) + ")"
            };
        }
        if (now < start) {
            return {
                mode: "start",
                text: formatDuration(start - now),
                title: "Starts " + formatTct(start) + (prep > 0 ? " · prep deadline " + formatTct(prepTarget) + " passed" : "")
            };
        }
        if (end != null && now < end) {
            return { mode: "live", text: formatDuration(end - now), title: "Running now. Ends " + formatTct(end) };
        }
        return { mode: "ended", text: "ended", title: "Started " + formatTct(start) };
    }

    function injectStyles() {
        if (document.getElementById("tcd-styles")) return;
        const css = `
.tc-clock-tooltip.tcd-host { width: auto !important; max-width: none !important; white-space: nowrap; }
.tcd-rows { border-top: 1px solid rgba(255,255,255,.18); margin-top: 4px; padding-top: 3px; }
.tcd-row { display: flex; align-items: center; gap: 10px; justify-content: space-between;
    font-size: 11px; line-height: 16px; padding: 1px 0; }
.tcd-row.tcd-click { cursor: pointer; }
.tcd-row.tcd-click:hover .tcd-label { text-decoration: underline; }
.tcd-label { overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.tcd-time { font-variant-numeric: tabular-nums; font-family: monospace; }
.tcd-mode-prep .tcd-time { color: #ff9f43; }
.tcd-mode-start .tcd-time { color: #78d278; }
.tcd-mode-live .tcd-time { color: #5ea9ff; }
.tcd-mode-ended .tcd-time, .tcd-mode-unknown .tcd-time { color: #999; }
.tcd-settings-row { border-top: 1px solid rgba(255,255,255,.18); margin-top: 3px; padding-top: 3px;
    font-size: 11px; cursor: pointer; opacity: .8; }
.tcd-settings-row:hover { opacity: 1; text-decoration: underline; }
.tcd-empty { font-size: 11px; opacity: .7; }

.tcd-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 2147483000;
    display: flex; align-items: flex-start; justify-content: center; padding: 40px 12px; overflow: auto; }
.tcd-modal { background: #1c1c1c; color: #ddd; border: 1px solid #000; border-radius: 5px;
    width: 640px; max-width: 100%; box-shadow: 0 6px 24px rgba(0,0,0,.6);
    font-family: Arial, Helvetica, sans-serif; }
.tcd-modal h2 { margin: 0; padding: 10px 12px; font-size: 14px; background: #333; border-radius: 5px 5px 0 0;
    display: flex; align-items: center; flex-wrap: wrap; }
.tcd-modal .tcd-close { margin-left: auto; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px; }
.tcd-body { padding: 12px; }
.tcd-section { margin-bottom: 14px; }
.tcd-section > label { display: block; font-size: 12px; margin-bottom: 4px; color: #aaa; }
.tcd-modal input[type=text], .tcd-modal input[type=number], .tcd-modal input[type=password],
.tcd-modal input[type=datetime-local], .tcd-modal select {
    background: #2b2b2b; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 4px 6px; font-size: 12px; }
.tcd-modal button { background: #3a3a3a; color: #ddd; border: 1px solid #555; border-radius: 3px;
    padding: 4px 10px; font-size: 12px; cursor: pointer; }
.tcd-modal button:hover { background: #474747; }
.tcd-modal button.tcd-primary { background: #2f6b2f; border-color: #3f8b3f; }
.tcd-modal button.tcd-danger { background: #6b2f2f; border-color: #8b3f3f; }
.tcd-entry { border: 1px solid #383838; border-radius: 4px; padding: 8px; margin-bottom: 8px; background: #222; }
.tcd-entry-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 8px; align-items: center; font-size: 12px; }
.tcd-entry-grid > span { color: #aaa; }
.tcd-entry-grid input[type=text], .tcd-entry-grid select, .tcd-entry-grid input[type=datetime-local] { width: 100%; }
.tcd-entry-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; }
.tcd-entry-foot .tcd-preview { margin-left: auto; color: #888; font-family: monospace; }
.tcd-note { font-size: 11px; color: #888; margin-top: 6px; }
.tcd-status { font-size: 11px; margin-left: 8px; }
.tcd-status.tcd-ok { color: #78d278; }
.tcd-status.tcd-err { color: #e06c6c; }
`;
        const style = document.createElement("style");
        style.id = "tcd-styles";
        style.textContent = css;
        document.head.appendChild(style);
    }

    function renderRows(tooltip) {
        let host = tooltip.querySelector(".tcd-rows");
        if (!host) {
            host = document.createElement("div");
            host.className = "tcd-rows";
            tooltip.appendChild(host);
        }
        let footer = tooltip.querySelector(".tcd-settings-row");
        if (!footer) {
            footer = document.createElement("div");
            footer.className = "tcd-settings-row";
            footer.textContent = "⚙ Countdowns";
            footer.addEventListener("click", (ev) => {
                ev.stopPropagation();
                openSettings();
            });
            tooltip.appendChild(footer);
        }
        tooltip.classList.add("tcd-host");

        const entries = (state.entries || []).filter((e) => e.enabled !== false);
        if (!entries.length) {
            host.innerHTML = '<div class="tcd-empty">No countdowns yet.</div>';
            return;
        }

        const wanted = entries.map((e) => e.id).join(",");
        if (host.dataset.ids !== wanted) {
            host.dataset.ids = wanted;
            host.innerHTML = "";
            entries.forEach((entry) => {
                const row = document.createElement("div");
                row.className = "tcd-row";
                row.dataset.id = entry.id;
                const label = document.createElement("span");
                label.className = "tcd-label";
                const time = document.createElement("span");
                time.className = "tcd-time";
                row.appendChild(label);
                row.appendChild(time);
                row.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    const target = state.entries.find((x) => x.id === entry.id);
                    if (!target || prepSeconds(target) <= 0) return;
                    target.view = target.view === "start" ? "prep" : "start";
                    saveState();
                    updateRows();
                });
                host.appendChild(row);
            });
        }
        updateRows();
    }

    function updateRows() {
        const host = document.querySelector(".tc-clock-tooltip .tcd-rows");
        if (!host) return;
        host.querySelectorAll(".tcd-row").forEach((row) => {
            const entry = (state.entries || []).find((e) => e.id === row.dataset.id);
            if (!entry) return;
            const info = rowStateFor(entry);
            const hasPrep = prepSeconds(entry) > 0;
            row.className = "tcd-row tcd-mode-" + info.mode + (hasPrep ? " tcd-click" : "");
            row.title = info.title + (hasPrep ? "\nClick to switch between the preparation deadline and the start." : "");
            const label = row.querySelector(".tcd-label");
            label.textContent = entry.label || "(unnamed)";
            row.querySelector(".tcd-time").textContent = info.text;
        });
    }

    function onTooltipPresent(tooltip) {
        injectStyles();
        syncClockOffset();
        renderRows(tooltip);
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = setInterval(() => {
            if (!document.body.contains(tooltip)) {
                clearInterval(tickTimer);
                tickTimer = null;
                return;
            }
            updateRows();
        }, 1000);
    }

    function watchClock() {
        let watchedLi = null;
        let liObserver = null;
        let throttled = false;

        const check = () => {
            const tooltip = document.querySelector(".tc-clock-tooltip");
            if (tooltip && !tooltip.querySelector(".tcd-rows")) onTooltipPresent(tooltip);
        };

        const attach = () => {
            const li = document.querySelector("li.tc-clock");
            if (!li || li === watchedLi) return;
            if (liObserver) liObserver.disconnect();
            watchedLi = li;
            liObserver = new MutationObserver(check);
            liObserver.observe(li, { childList: true, subtree: true });
            check();
        };

        attach();

        const bodyObserver = new MutationObserver(() => {
            if (throttled) return;
            throttled = true;
            setTimeout(() => {
                throttled = false;
                if (!watchedLi || !document.contains(watchedLi)) attach();
            }, 500);
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    async function refreshCalendar(force) {
        if (refreshing) return;
        if (!state.apiKey) return;
        const stale = Date.now() - (state.calendar.fetchedAt || 0) > CAL_TTL_MS;
        if (!force && !stale) return;
        refreshing = true;
        try {
            const cal = await httpGetJson("https://api.torn.com/v2/torn/calendar?key=" + encodeURIComponent(state.apiKey));
            if (cal && cal.calendar) {
                state.calendar = {
                    fetchedAt: Date.now(),
                    competitions: cal.calendar.competitions || [],
                    events: cal.calendar.events || []
                };
            }
            try {
                const me = await httpGetJson("https://api.torn.com/v2/user/calendar?key=" + encodeURIComponent(state.apiKey));
                if (me && me.calendar) {
                    state.personal = { fetchedAt: Date.now(), startTime: me.calendar.start_time || null };
                }
            } catch (e) {
                state.personal = { fetchedAt: Date.now(), startTime: state.personal.startTime };
            }
            saveState();
            updateRows();
        } finally {
            refreshing = false;
        }
    }

    function futureItems() {
        const now = nowSec();
        return allCalendarItems()
            .filter((item) => (endOfItem(item) != null ? endOfItem(item) : startOfItem(item)) >= now)
            .sort((a, b) => startOfItem(a) - startOfItem(b));
    }

    function toLocalInputValue(epochSec) {
        if (epochSec == null) return "";
        const dt = new Date(epochSec * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate()) +
            "T" + pad(dt.getUTCHours()) + ":" + pad(dt.getUTCMinutes());
    }

    function fromLocalInputValue(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
        if (!m) return null;
        return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 1000);
    }

    function closeSettings() {
        const node = document.getElementById("tcd-overlay");
        if (node) node.remove();
    }

    function openSettings() {
        closeSettings();
        injectStyles();

        const overlay = document.createElement("div");
        overlay.className = "tcd-overlay";
        overlay.id = "tcd-overlay";
        overlay.addEventListener("click", (ev) => {
            if (ev.target === overlay) closeSettings();
        });

        const modal = document.createElement("div");
        modal.className = "tcd-modal";
        modal.innerHTML = `
<h2>Torn Countdown <span style="color:#888;font-size:11px;font-weight:400;margin-left:6px">v${VERSION}</span>
<span style="color:#888;font-size:11px;font-weight:400;margin-left:10px">
    Like the script? Send a Xanax to
    <a href="https://www.torn.com/profiles.php?XID=4192025" target="_blank"
       style="color:#cc3333;text-decoration:none">eugene_s [4192025]</a>
</span>
<span class="tcd-close" title="Close">&times;</span></h2>
<div class="tcd-body">
    <div class="tcd-section">
        <label>Torn API key (Minimal access)</label>
        <input type="password" id="tcd-key" style="width:260px" placeholder="paste key" />
        <button id="tcd-save-key">Save</button>
        <button id="tcd-refresh">Refresh calendar</button>
        <span class="tcd-status" id="tcd-key-status"></span>
        <div class="tcd-note" id="tcd-cal-note"></div>
    </div>
    <div class="tcd-section">
        <label>Countdowns</label>
        <div id="tcd-entries"></div>
        <button id="tcd-add" class="tcd-primary">+ Add countdown</button>
    </div>
</div>`;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector(".tcd-close").addEventListener("click", closeSettings);
        const keyInput = modal.querySelector("#tcd-key");
        keyInput.value = state.apiKey || "";

        const status = modal.querySelector("#tcd-key-status");
        const setStatus = (text, ok) => {
            status.textContent = text;
            status.className = "tcd-status " + (ok ? "tcd-ok" : "tcd-err");
        };

        const note = modal.querySelector("#tcd-cal-note");
        const paintNote = () => {
            const count = allCalendarItems().length;
            const when = state.calendar.fetchedAt ? new Date(state.calendar.fetchedAt).toLocaleString() : "never";
            const personal = state.personal.startTime || "unknown";
            note.textContent = count + " calendar entries · last refresh " + when + " · your personal event time: " + personal;
        };
        paintNote();

        modal.querySelector("#tcd-save-key").addEventListener("click", async () => {
            state.apiKey = keyInput.value.trim();
            saveState();
            setStatus("saved, checking…", true);
            try {
                await refreshCalendar(true);
                setStatus("key works", true);
                paintNote();
                paintEntries();
            } catch (e) {
                setStatus(String(e.message || e), false);
            }
        });

        modal.querySelector("#tcd-refresh").addEventListener("click", async () => {
            setStatus("refreshing…", true);
            try {
                await refreshCalendar(true);
                setStatus("refreshed", true);
                paintNote();
                paintEntries();
            } catch (e) {
                setStatus(String(e.message || e), false);
            }
        });

        modal.querySelector("#tcd-add").addEventListener("click", () => {
            state.entries.push({
                id: uid(),
                label: "",
                source: "event",
                eventKey: "",
                manualStart: null,
                prepHours: 0,
                view: "prep",
                enabled: true
            });
            saveState();
            paintEntries();
        });

        const list = modal.querySelector("#tcd-entries");

        function paintEntries() {
            list.innerHTML = "";
            if (!state.entries.length) {
                list.innerHTML = '<div class="tcd-note">No countdowns yet. Add one below.</div>';
                return;
            }
            const items = futureItems();
            state.entries.forEach((entry) => {
                const box = document.createElement("div");
                box.className = "tcd-entry";

                const options = items.map((item) => {
                    const key = eventKeyOf(item);
                    const sel = key === entry.eventKey ? " selected" : "";
                    const kind = item.kind === "competitions" ? "Competition" : "Event";
                    return '<option value="' + escAttr(key) + '"' + sel + '>' +
                        escHtml(kind + " · " + item.title + " · " + formatTct(startOfItem(item))) + "</option>";
                }).join("");

                const missing = entry.source === "event" && entry.eventKey && !findEvent(entry.eventKey)
                    ? '<option value="' + escAttr(entry.eventKey) + '" selected>' +
                      escHtml(entry.eventKey.split("|")[1] + " (not in calendar now)") + "</option>"
                    : "";

                box.innerHTML = `
<div class="tcd-entry-grid">
    <span>Name</span>
    <input type="text" class="tcd-f-label" placeholder="shown in the clock popup" />
    <span>Target</span>
    <select class="tcd-f-source">
        <option value="event">Calendar event</option>
        <option value="manual">Manual date and time</option>
    </select>
    <span class="tcd-row-event">Event</span>
    <select class="tcd-f-event tcd-row-event">
        <option value="">— pick an event —</option>
        ${missing}${options}
    </select>
    <span class="tcd-row-manual">Start (TCT)</span>
    <input type="datetime-local" class="tcd-f-manual tcd-row-manual" />
    <span>Prep window</span>
    <span><input type="number" class="tcd-f-prep" min="0" step="0.5" style="width:80px" /> hours earlier
        <span class="tcd-note" style="display:inline">0 = count down to the start itself</span></span>
</div>
<div class="tcd-entry-foot">
    <label><input type="checkbox" class="tcd-f-enabled" /> show in clock</label>
    <button class="tcd-danger tcd-f-delete">Delete</button>
    <span class="tcd-preview"></span>
</div>`;

                const f = (cls) => box.querySelector("." + cls);
                f("tcd-f-label").value = entry.label || "";
                f("tcd-f-source").value = entry.source || "event";
                f("tcd-f-event").value = entry.eventKey || "";
                f("tcd-f-manual").value = toLocalInputValue(entry.manualStart);
                f("tcd-f-prep").value = entry.prepHours || 0;
                f("tcd-f-enabled").checked = entry.enabled !== false;

                const applyMode = () => {
                    const isEvent = f("tcd-f-source").value === "event";
                    box.querySelectorAll(".tcd-row-event").forEach((n) => { n.style.display = isEvent ? "" : "none"; });
                    box.querySelectorAll(".tcd-row-manual").forEach((n) => { n.style.display = isEvent ? "none" : ""; });
                };
                const paintPreview = () => {
                    const start = resolvedStart(entry);
                    const prep = prepSeconds(entry);
                    if (start == null) {
                        f("tcd-preview").textContent = "no date yet";
                        return;
                    }
                    f("tcd-preview").textContent = prep > 0
                        ? "prep " + formatTct(start - prep) + "  ·  start " + formatTct(start)
                        : "start " + formatTct(start);
                };
                const commit = () => {
                    entry.label = f("tcd-f-label").value.trim();
                    entry.source = f("tcd-f-source").value;
                    entry.eventKey = f("tcd-f-event").value;
                    entry.manualStart = fromLocalInputValue(f("tcd-f-manual").value);
                    const prep = Number(f("tcd-f-prep").value);
                    entry.prepHours = isFinite(prep) && prep > 0 ? prep : 0;
                    entry.enabled = f("tcd-f-enabled").checked;
                    if (!entry.label && entry.source === "event" && entry.eventKey) {
                        entry.label = entry.eventKey.split("|")[1];
                        f("tcd-f-label").value = entry.label;
                    }
                    saveState();
                    applyMode();
                    paintPreview();
                    updateRows();
                };

                box.querySelectorAll("input, select").forEach((el) => {
                    el.addEventListener("change", commit);
                    el.addEventListener("input", commit);
                });
                f("tcd-f-delete").addEventListener("click", () => {
                    state.entries = state.entries.filter((x) => x.id !== entry.id);
                    saveState();
                    paintEntries();
                    const host = document.querySelector(".tc-clock-tooltip .tcd-rows");
                    if (host) host.dataset.ids = "";
                    const tooltip = document.querySelector(".tc-clock-tooltip");
                    if (tooltip) renderRows(tooltip);
                });

                applyMode();
                paintPreview();
                list.appendChild(box);
            });
        }

        paintEntries();

        if (state.apiKey) {
            refreshCalendar(false).then(() => {
                paintNote();
                paintEntries();
            }).catch(() => {});
        }
    }

    function escHtml(s) {
        return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    function escAttr(s) {
        return escHtml(s).replace(/'/g, "&#39;");
    }

    function start() {
        injectStyles();
        watchClock();
        refreshCalendar(false).catch(() => {});
        setInterval(() => { refreshCalendar(true).catch(() => {}); }, BG_REFRESH_MS);
        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        W.tornCountdownOpenSettings = openSettings;
        if (location.hostname !== "www.torn.com") {
            W.__tcdTest = {
                formatDuration, formatTct, personalizedStart, personalizedEnd, parsePersonalMinutes,
                resolvedStart, resolvedEnd, rowStateFor, prepSeconds,
                fromLocalInputValue, toLocalInputValue, readServerClock, nowSec,
                getState: () => state,
                setState: (next) => { state = next; saveState(); },
                setClockOffset: (ms) => { clockOffsetMs = ms; }
            };
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
