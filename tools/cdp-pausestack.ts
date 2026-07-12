// Pause the emulator worker via CDP and dump its JS call stack.
//
// USE WHEN the worker is HARD-pinned: harness RPC (`state`/`sleep`) times out and
// even `dbg snapshot` never streams back, so no in-band probe can see inside. This
// attaches to the page's CDP session, auto-attaches to the worker target (flatten),
// then Debugger.enable + Debugger.pause and prints the paused JS call stack — which
// reveals exactly which JS function is spinning (e.g. an infinite parent-chain walk
// in getAbsoluteWindowPosition reached via an io_port_write32 hypercall).
//
// If it canNOT pause within the timeout, the worker is spinning inside v86 WASM
// (a guest cycle loop), not JS.
//
//   bun tools/harness.ts up           # ensure Chrome+page are attached on :9333
//   bun tools/cdp-pausestack.ts       # while the worker is pinned
//
// Flags: --port <n> (default 9333), --top <n> stack frames (default 30).
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = Number(arg("--port", "9333"));
const TOP = Number(arg("--top", "30"));
const T = <X>(p: Promise<X>, ms: number, t: string) =>
  Promise.race([p, new Promise<X>((_, j) => setTimeout(() => j(new Error("timeout:" + t)), ms))]);

try {
  const list: any[] = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && String(t.url).includes("game=dev"));
  if (!page) { console.log("no game=dev page (run `bun tools/harness.ts up`)"); process.exit(1); }
  console.log("page: " + page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<number, (v: any) => void>();
  const events: any[] = [];
  const send = (m: string, p: any = {}, sid?: string) => {
    const id = nextId++;
    const msg: any = { id, method: m, params: p };
    if (sid) msg.sessionId = sid;
    ws.send(JSON.stringify(msg));
    return new Promise<any>((r) => pending.set(id, r));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  await T(new Promise((r) => { ws.onopen = r as any; }), 5000, "open");

  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await Bun.sleep(500);
  let att = events.filter((e) => e.method === "Target.attachedToTarget").map((e) => e.params).filter((p) => p.targetInfo.type === "worker");
  if (!att.length) {
    await send("Target.setDiscoverTargets", { discover: true });
    await Bun.sleep(300);
    const tgts = events.filter((e) => e.method === "Target.targetCreated").map((e) => e.params.targetInfo).filter((t) => t.type === "worker");
    for (const tg of tgts) await send("Target.attachToTarget", { targetId: tg.targetId, flatten: true });
    await Bun.sleep(400);
    att = events.filter((e) => e.method === "Target.attachedToTarget").map((e) => e.params).filter((p) => p.targetInfo.type === "worker");
  }
  if (!att.length) { console.log("no worker session"); process.exit(2); }
  const sid = att[0].sessionId;
  console.log("worker: " + att[0].targetInfo.url);

  await T(send("Debugger.enable", {}, sid), 4000, "enable").catch((e) => console.log("enable: " + e.message));
  send("Debugger.pause", {}, sid);
  const pausedP = new Promise<any>((res) => {
    const iv = setInterval(() => {
      const e = events.find((e) => e.method === "Debugger.paused" && e.sessionId === sid);
      if (e) { clearInterval(iv); res(e); }
    }, 50);
  });
  const paused = await T(pausedP, 6000, "pause").catch(() => null);
  if (!paused) { console.log("DID NOT PAUSE -> worker spinning in v86 WASM (guest cycle loop), not JS"); process.exit(0); }

  const frames = paused.params.callFrames || [];
  console.log(`\n=== WORKER JS STACK (${frames.length} frames) reason=${paused.params.reason} ===`);
  for (let i = 0; i < Math.min(frames.length, TOP); i++) {
    const f = frames[i];
    const url = (f.url || "").split("/").slice(-2).join("/");
    console.log(`#${i} ${f.functionName || "(anon)"} @ ${url}:${f.location.lineNumber + 1}`);
  }
  await send("Debugger.resume", {}, sid).catch(() => {});
} catch (e) {
  console.log("ERR: " + (e as Error).message);
}
process.exit(0);
