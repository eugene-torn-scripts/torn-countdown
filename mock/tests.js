(function () {
    const out = document.getElementById("tcd-test-out");
    const lines = [];
    let pass = 0;
    let fail = 0;

    function ok(name, cond, extra) {
        if (cond) { pass++; lines.push("PASS  " + name); }
        else { fail++; lines.push("FAIL  " + name + (extra ? "  → " + extra : "")); }
    }

    function eq(name, actual, expected) {
        ok(name, actual === expected, "got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected));
    }

    function near(name, actualText, expectedSec, tol) {
        const T = window.__tcdTest;
        const candidates = [];
        for (let d = -(tol || 2); d <= (tol || 2); d++) candidates.push(T.formatDuration(expectedSec + d));
        ok(name, candidates.indexOf(actualText) !== -1, "got " + actualText + ", want ~" + T.formatDuration(expectedSec));
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const DIABETES_START = 1794614400;
    const DIABETES_PERSONAL = 1794564900;
    const DIABETES_PERSONAL_END = 1794737700;
    const DIABETES_EARLIEST = 1794564000;
    const CHRISTMAS_PERSONAL = 1797588900;
    const CHRISTMAS_PERSONAL_END = 1798798500;
    const ANNIVERSARY_START = 1794700800;

    function baseState() {
        const F = window.TCD_FIXTURES;
        return {
            version: 1,
            apiKey: "MOCKKEY",
            entries: [],
            calendar: {
                fetchedAt: Date.now(),
                competitions: F.tornCalendar.calendar.competitions,
                events: F.tornCalendar.calendar.events
            },
            personal: { fetchedAt: Date.now(), startTime: "10:15 TCT" }
        };
    }

    function entry(over) {
        return Object.assign({
            id: "t" + Math.random().toString(36).slice(2, 7),
            label: "Test",
            source: "event",
            eventKey: "events|World Diabetes Day",
            manualStart: null,
            prepHours: 0,
            view: "prep",
            enabled: true
        }, over || {});
    }

    async function run() {
        const T = window.__tcdTest;
        if (!T) { out.textContent = "FAIL — the userscript did not expose __tcdTest"; return; }

        T.setState(baseState());

        eq("formatDuration zero", T.formatDuration(0), "00:00:00");
        eq("formatDuration negative clamps", T.formatDuration(-99), "00:00:00");
        eq("formatDuration seconds", T.formatDuration(59), "00:00:59");
        eq("formatDuration hour", T.formatDuration(3661), "01:01:01");
        eq("formatDuration one day", T.formatDuration(90000), "1d 01:00:00");
        eq("formatDuration many days", T.formatDuration(409693), "4d 17:48:13");

        eq("parsePersonalMinutes TCT string", T.parsePersonalMinutes("10:15 TCT"), 615);
        eq("parsePersonalMinutes midnight", T.parsePersonalMinutes("00:00 TCT"), 0);
        eq("parsePersonalMinutes null", T.parsePersonalMinutes(null), null);
        eq("parsePersonalMinutes garbage", T.parsePersonalMinutes("soon"), null);
        eq("parsePersonalMinutes out of range", T.parsePersonalMinutes("99:99"), null);

        const diabetes = window.TCD_FIXTURES.tornCalendar.calendar.events[0];
        eq("personal start is the day before at 10:15 (13/11 10:15)", T.personalizedStart(diabetes, 615), DIABETES_PERSONAL);
        eq("personal end is the day after at 10:15 (15/11 10:15)", T.personalizedEnd(diabetes, 615), DIABETES_PERSONAL_END);
        eq("personal window of a 1-day event lasts 48 hours",
            T.personalizedEnd(diabetes, 615) - T.personalizedStart(diabetes, 615), 172800);
        eq("personal start at 10:00 equals earliest_start", T.personalizedStart(diabetes, 600), diabetes.earliest_start);
        eq("personal end at 23:59 stays inside latest_end",
            T.personalizedEnd(diabetes, 1439) <= diabetes.latest_end, true);
        eq("personal time below the window clamps to earliest_start", T.personalizedStart(diabetes, 0), DIABETES_EARLIEST);
        eq("personalizedStart without personal time", T.personalizedStart(diabetes, null), DIABETES_START);
        eq("personalizedEnd without personal time", T.personalizedEnd(diabetes, null), diabetes.end);

        const christmas = window.TCD_FIXTURES.tornCalendar.calendar.events[3];
        eq("multi-day event start (18/12 10:15)", T.personalizedStart(christmas, 615), CHRISTMAS_PERSONAL);
        eq("multi-day event end (01/01 10:15)", T.personalizedEnd(christmas, 615), CHRISTMAS_PERSONAL_END);

        eq("fixed event ignores personal time",
            T.resolvedStart(entry({ eventKey: "events|Torn Anniversary" })), ANNIVERSARY_START);
        eq("non fixed event uses personal time",
            T.resolvedStart(entry({})), DIABETES_PERSONAL);
        eq("non fixed event end uses personal time",
            T.resolvedEnd(entry({})), DIABETES_PERSONAL_END);
        eq("fixed event end ignores personal time (Anniversary 15/11 00:00 to 16/11 00:00)",
            T.resolvedEnd(entry({ eventKey: "events|Torn Anniversary" })), 1794787199);
        eq("manual entry uses its own date",
            T.resolvedStart(entry({ source: "manual", manualStart: 1794391200 })), 1794391200);
        eq("unknown event resolves to null",
            T.resolvedStart(entry({ eventKey: "events|Does Not Exist" })), null);
        eq("manual entry without a date resolves to null",
            T.resolvedStart(entry({ source: "manual", manualStart: null })), null);

        eq("prepSeconds zero", T.prepSeconds(entry({ prepHours: 0 })), 0);
        eq("prepSeconds hours", T.prepSeconds(entry({ prepHours: 30 })), 108000);
        eq("prepSeconds fractional", T.prepSeconds(entry({ prepHours: 1.5 })), 5400);
        eq("prepSeconds rejects negative", T.prepSeconds(entry({ prepHours: -5 })), 0);

        eq("input value round trip", T.fromLocalInputValue("2026-11-11T10:00"), 1794391200);
        eq("input value renders TCT", T.toLocalInputValue(1794391200), "2026-11-11T10:00");
        eq("input value rejects junk", T.fromLocalInputValue("not a date"), null);
        eq("formatTct renders TCT", T.formatTct(1794391200), "11/11/26 10:00 TCT");

        const withPrep = entry({ prepHours: 30 });
        let now = T.nowSec();
        let st = T.rowStateFor(withPrep);
        eq("prep window shows the prep mode", st.mode, "prep");
        near("prep countdown value", st.text, DIABETES_PERSONAL - 108000 - now);

        withPrep.view = "start";
        now = T.nowSec();
        st = T.rowStateFor(withPrep);
        eq("click switches to the start mode", st.mode, "start");
        near("start countdown value", st.text, DIABETES_PERSONAL - now);

        const noPrep = entry({ prepHours: 0, view: "prep" });
        eq("no prep window always shows the start", T.rowStateFor(noPrep).mode, "start");

        const passedPrep = entry({ source: "manual", manualStart: T.nowSec() + 60, prepHours: 30 });
        eq("after the prep deadline it falls back to the start", T.rowStateFor(passedPrep).mode, "start");

        const liveState = baseState();
        liveState.entries = [];
        T.setState(liveState);
        const live = entry({ source: "event", eventKey: "events|Torn Anniversary" });
        T.setClockOffset((ANNIVERSARY_START + 600) * 1000 - Date.now());
        eq("a running event shows the live mode", T.rowStateFor(live).mode, "live");
        T.setClockOffset((1794787199 + 600) * 1000 - Date.now());
        eq("a finished event shows ended", T.rowStateFor(live).text, "ended");
        const diabetesEntry = entry({});
        T.setState(baseState());
        T.setClockOffset((1794700800 + 600) * 1000 - Date.now());
        eq("a personal-time event is still live on 15/11 at 00:10", T.rowStateFor(diabetesEntry).mode, "live");
        T.setClockOffset((DIABETES_PERSONAL_END + 60) * 1000 - Date.now());
        eq("a personal-time event ends at 15/11 10:15", T.rowStateFor(diabetesEntry).text, "ended");
        T.setClockOffset(0);

        eq("entry with no date shows no date", T.rowStateFor(entry({ eventKey: "" })).text, "no date");

        const domState = baseState();
        domState.entries = [
            entry({ id: "d1", label: "Diabetes prep", prepHours: 30 }),
            entry({ id: "d2", label: "Anniversary", eventKey: "events|Torn Anniversary", prepHours: 0 }),
            entry({ id: "d3", label: "Hidden", enabled: false })
        ];
        T.setState(domState);

        window.MOCK.closeClock();
        await sleep(50);
        window.MOCK.openClock();
        await sleep(150);

        const rows = document.querySelectorAll(".tc-clock-tooltip .tcd-row");
        eq("only enabled entries render", rows.length, 2);
        eq("first row label", rows[0].querySelector(".tcd-label").textContent, "Diabetes prep");
        ok("the clock line is still there", !!document.querySelector(".tc-clock-tooltip .server-date-time"));
        ok("the settings row is there", !!document.querySelector(".tc-clock-tooltip .tcd-settings-row"));
        ok("a prep row is clickable", rows[0].classList.contains("tcd-click"));
        ok("a row without a prep window is not clickable", !rows[1].classList.contains("tcd-click"));

        rows[0].click();
        await sleep(30);
        const afterClick = document.querySelectorAll(".tc-clock-tooltip .tcd-row")[0];
        ok("a click switches the row to the start mode", afterClick.classList.contains("tcd-mode-start"));
        afterClick.click();
        await sleep(30);
        ok("a second click switches back to the prep mode",
            document.querySelectorAll(".tc-clock-tooltip .tcd-row")[0].classList.contains("tcd-mode-prep"));

        document.getElementById("btn-rerender").click();
        await sleep(200);
        eq("rows come back after a React re-render",
            document.querySelectorAll(".tc-clock-tooltip .tcd-row").length, 2);

        const before = document.querySelector(".tc-clock-tooltip .tcd-row .tcd-time").textContent;
        await sleep(1200);
        const after = document.querySelector(".tc-clock-tooltip .tcd-row .tcd-time").textContent;
        ok("the countdown ticks every second", before !== after, before + " vs " + after);

        document.querySelector(".tc-clock-tooltip .tcd-settings-row").click();
        await sleep(300);
        ok("the settings modal opens", !!document.getElementById("tcd-overlay"));
        const options = document.querySelectorAll("#tcd-overlay .tcd-f-event option");
        const texts = Array.prototype.map.call(options, (o) => o.textContent);
        ok("past competitions are not offered", texts.join("|").indexOf("Elimination") === -1, texts.join("|"));
        ok("future events are offered", texts.join("|").indexOf("Black Friday") !== -1);
        ok("the dropdown shows the personalised start",
            texts.join("|").indexOf("World Diabetes Day · 13/11/26 10:15 TCT") !== -1, texts.join("|"));
        ok("the dropdown shows a fixed start unchanged",
            texts.join("|").indexOf("Torn Anniversary · 15/11/26 00:00 TCT") !== -1, texts.join("|"));
        eq("three entries are listed", document.querySelectorAll("#tcd-overlay .tcd-entry").length, 3);
        document.querySelector("#tcd-overlay .tcd-close").click();
        await sleep(50);
        ok("the settings modal closes", !document.getElementById("tcd-overlay"));

        lines.unshift(fail === 0 ? "ALL GREEN — " + pass + " passed" : fail + " FAILED, " + pass + " passed");
        out.textContent = lines.join("\n");
        window.TCD_RESULT = { pass: pass, fail: fail, lines: lines };
    }

    document.getElementById("btn-tests").addEventListener("click", function () {
        out.textContent = "running…";
        lines.length = 0;
        pass = 0;
        fail = 0;
        run().catch(function (e) {
            out.textContent = "ERROR " + (e && e.stack ? e.stack : e);
        });
    });

    document.getElementById("btn-seed").addEventListener("click", function () {
        const T = window.__tcdTest;
        const s = baseState();
        s.entries = [
            entry({ id: "s1", label: "Diabetes Day", prepHours: 30 }),
            entry({ id: "s2", label: "Anniversary", eventKey: "events|Torn Anniversary", prepHours: 0 }),
            entry({ id: "s3", label: "Custom date", source: "manual", manualStart: 1794391200, prepHours: 6 })
        ];
        T.setState(s);
        window.MOCK.closeClock();
        window.MOCK.openClock();
    });
})();
