// Evaluate an expression in the game page of a running bench Chrome through a second CDP
// connection (page target only, so the bench session keeps its own). Reads state from a
// session whose guest process already exited — e.g. the failed graphics HRESULT ring —
// without waiting for the next reproduction.
//
//   bun tools/examples/cdp-eval.ts 9552 '__BS__.harness.__runSteps([{ cmd: "report", args: [] }]).then(r => JSON.stringify((r?.steps?.[0]?.result ?? r).graphicsHresultFailures.slice(-12)))'

const port = Number(process.argv[2] ?? "9552");
const expr = process.argv[3] ?? "1+1";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
const page = list.find((t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"));
if (!page) { console.log(JSON.stringify({ error: "no page target", targets: list.map((t) => [t.type, t.url]) })); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
const reply = new Promise<string>((res) => { ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 1) res(JSON.stringify(d.result?.result?.value ?? d.result ?? d.error)); }; });
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
const out = await Promise.race([reply, new Promise<string>((res) => setTimeout(() => res('"timeout"'), 60000))]);
console.log(out.slice(0, 6000));
ws.close();
