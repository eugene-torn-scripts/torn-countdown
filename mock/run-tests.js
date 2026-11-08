const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8799);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const CHROME = process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
            const file = path.resolve(ROOT, rel);
            if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404).end("not found");
                return;
            }
            res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "text/plain" });
            res.end(fs.readFileSync(file));
        });
        server.listen(PORT, "127.0.0.1", () => resolve(server));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
    for (let i = 0; i < 100; i++) {
        try {
            const res = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version");
            if (res.ok) return (await res.json()).webSocketDebuggerUrl;
        } catch (e) { /* not up yet */ }
        await sleep(100);
    }
    throw new Error("Chrome did not expose the DevTools port");
}

function cdp(url) {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    const ready = new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", (e) => reject(new Error("websocket error")));
    });
    ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
    });
    return {
        ready,
        send(method, params, sessionId) {
            const id = nextId++;
            const payload = { id, method, params: params || {} };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        },
        close() { ws.close(); }
    };
}

async function main() {
    const server = await serve();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tcd-chrome-"));
    const chrome = spawn(CHROME, [
        "--headless=new",
        "--remote-debugging-port=" + CDP_PORT,
        "--user-data-dir=" + profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "about:blank"
    ], { stdio: "ignore" });

    let code = 1;
    let client = null;
    try {
        const browserWs = await waitForDevtools();
        client = cdp(browserWs);
        await client.ready;

        const { targetId } = await client.send("Target.createTarget", {
            url: "http://127.0.0.1:" + PORT + "/mock/index.html"
        });
        const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
        await client.send("Runtime.enable", {}, sessionId);
        await sleep(1200);

        const errors = await client.send("Runtime.evaluate", {
            expression: "JSON.stringify(window.__tcdBootError || null)",
            returnByValue: true
        }, sessionId);
        if (errors.result.value && errors.result.value !== "null") {
            throw new Error("boot error: " + errors.result.value);
        }

        await client.send("Runtime.evaluate", {
            expression: "document.getElementById('btn-tests').click()"
        }, sessionId);

        let result = null;
        for (let i = 0; i < 150; i++) {
            await sleep(200);
            const res = await client.send("Runtime.evaluate", {
                expression: "JSON.stringify(window.TCD_RESULT || null)",
                returnByValue: true
            }, sessionId);
            if (res.result.value && res.result.value !== "null") {
                result = JSON.parse(res.result.value);
                break;
            }
            const out = await client.send("Runtime.evaluate", {
                expression: "document.getElementById('tcd-test-out').textContent",
                returnByValue: true
            }, sessionId);
            if (/^ERROR/.test(out.result.value || "")) throw new Error(out.result.value);
        }

        if (!result) throw new Error("the test run did not finish");
        console.log(result.lines.join("\n"));
        code = result.fail === 0 ? 0 : 1;

        if (process.env.SHOT) {
            await client.send("Runtime.evaluate", {
                expression: "document.getElementById('btn-seed').click()"
            }, sessionId);
            await sleep(400);
            const shot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
            fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, "base64"));
            console.log("screenshot written to " + process.env.SHOT);

            if (process.env.SHOT_SETTINGS) {
                await client.send("Runtime.evaluate", {
                    expression: "document.querySelector('.tc-clock-tooltip .tcd-settings-row').click()"
                }, sessionId);
                await sleep(600);
                const shot2 = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
                fs.writeFileSync(process.env.SHOT_SETTINGS, Buffer.from(shot2.data, "base64"));
                console.log("screenshot written to " + process.env.SHOT_SETTINGS);
            }
        }
    } catch (e) {
        console.error("RUNNER ERROR:", e.message);
    } finally {
        if (client) client.close();
        chrome.kill();
        server.close();
        await sleep(500);
        try {
            fs.rmSync(profile, { recursive: true, force: true });
        } catch (e) { /* Chrome may still be flushing its profile */ }
    }
    process.exit(code);
}

main();
