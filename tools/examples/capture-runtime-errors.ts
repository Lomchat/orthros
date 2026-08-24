import { connect } from "../cdp-core";

const { session } = await connect();
const events: unknown[] = [];
const record = (kind: string, params: any, child?: string) => {
  const entry = { at: new Date().toISOString(), kind, child, params };
  events.push(entry);
  console.log(JSON.stringify(entry));
};

session.on("Target.attachedToTarget", async (params) => {
  record("attached", { type: params.targetInfo?.type, url: params.targetInfo?.url }, params.sessionId);
  try { await session.send("Runtime.enable", {}, params.sessionId); } catch {}
  try { await session.send("Log.enable", {}, params.sessionId); } catch {}
});
session.on("Runtime.exceptionThrown", (params, child) => record("exception", params, child));
session.on("Runtime.consoleAPICalled", (params, child) => {
  if (params.type === "error" || params.type === "warning") record("console", params, child);
});
session.on("Log.entryAdded", (params, child) => {
  if (params.entry?.level === "error" || params.entry?.level === "warning") record("log", params, child);
});

await session.send("Runtime.enable");
await session.send("Log.enable");
await session.send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
});
await Bun.sleep(60_000);
console.log(JSON.stringify({ done: true, count: events.length }));
session.close();
