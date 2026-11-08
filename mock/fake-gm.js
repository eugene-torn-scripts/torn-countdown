(function () {
    const store = {};

    window.GM_getValue = function (key, fallback) {
        const raw = localStorage.getItem("mock_" + key);
        if (raw === null) return (key in store) ? store[key] : fallback;
        return raw;
    };

    window.GM_setValue = function (key, value) {
        store[key] = value;
        localStorage.setItem("mock_" + key, value);
    };

    window.GM_xmlhttpRequest = function (opts) {
        const url = opts.url || "";
        window.TCD_CALLS = (window.TCD_CALLS || []).concat([url.replace(/key=[^&]*/, "key=REDACTED")]);
        let body = null;
        if (url.indexOf("/v2/torn/calendar") !== -1) body = window.TCD_FIXTURES.tornCalendar;
        else if (url.indexOf("/v2/user/calendar") !== -1) body = window.TCD_FIXTURES.userCalendar;
        else body = { error: { code: 6, error: "Incorrect ID" } };

        if (window.TCD_FORCE_ERROR) body = { error: { code: 2, error: "Incorrect key" } };

        setTimeout(function () {
            opts.onload({ status: 200, responseText: JSON.stringify(body) });
        }, 10);
    };
})();
