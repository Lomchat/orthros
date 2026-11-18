// tools/check/hidden-tab/check.mjs's extension: drives the check from inside the browser — no automation attached to
// the page (Playwright's focus emulation keeps a background page "visible") — the page's tab shown, hidden behind a new
// tab, shown again; Chrome's own `audible` of the tab posted to the page's server at each step.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run() {
  let tab = null;
  for (let i = 0; i < 80 && !tab; i++) { tab = (await chrome.tabs.query({})).find((t) => /\/check\.html/.test(t.url ?? '') && t.status === 'complete'); if (!tab) await sleep(250); }
  if (!tab) return;
  const origin = new URL(tab.url).origin;
  const log = async (phase) => { const t = await chrome.tabs.get(tab.id); await fetch(origin + '/log', { method: 'POST', body: JSON.stringify({ t: Date.now(), phase, audible: t.audible }) }).catch(() => {}); };
  await sleep(3000); await log('visible');
  const other = await chrome.tabs.create({ windowId: tab.windowId, url: 'about:blank', active: true });
  for (let i = 0; i < 3; i++) { await sleep(2500); await log('hidden'); }
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(4000); await log('shown'); // (the fade out, then Chrome holds the audible state 2 s)
  await chrome.tabs.remove(other.id);
  await fetch(origin + '/done', { method: 'POST' }).catch(() => {});
}
run();
