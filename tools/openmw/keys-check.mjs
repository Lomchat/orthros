// The keyboard layout of an OpenMW port in its engine (src/ports/openmw/input-keys.js, orthros-r9.patch): a new character
// in an exterior (?start=<cell>), then Space held, then E held, each time the engine's own reading of its actions
// (the player's Lua console, `luap`: input.isActionPressed for Jump and Activate, sampled 50 times over 2.5 s of game
// time, and how high the player rose) reported back through the engine's log. Expected: Space jumps (and rises), E
// activates. --seed-old: first a saved bindings file holding Morrowind's old pair (Activate on Space, Jump on E) written
// into the page's persistent user files, the page loaded again — the swap before the engine reads them, then the same
// probes. Not a gameplay check. Always through tools/with-browser-slot.sh:
//   tools/with-browser-slot.sh node tools/openmw/keys-check.mjs <manifest> --url <origin> [--start -2,-9] [--seed-old]
//     [--draw] [--query name=value[&...]] [--out <dir>]   (--draw: the pictures drawn — slower; by default rasterizer
//     discard, as perf.mjs --discard; --query: added to the engine page's address, e.g. omwenv=OPENMW_ORTHROS_DRAWTHREAD=1)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../port-perf.mjs';
import { INPUT_FILE, MARK_FILE, ACTIVATE, JUMP, SPACE, E } from '../../src/ports/openmw/input-keys.js';

const args = process.argv.slice(2), id = args[0], arg = (k, d = null) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
if (!id) throw new Error('Expected a manifest id');
const base = arg('--url', 'http://localhost:8080'), start = arg('--start', '-2,-9'), seedOld = args.includes('--seed-old');
const dir = arg('--out', `/tmp/orthros-scratch/openmw-keys-${id}`);
fs.mkdirSync(dir, { recursive: true }); process.env.TMPDIR = dir;

// (a control as the engine's ICS writes it: OpenMW's actions are auto-reversing, unbounded steps. ICS finds a control
// by its position in the file — the engine writes all of them in their actions' order, 0 to A_Last - 1 (52) —; those
// without a binder get the engine's defaults at its start)
const control = (action, key) => `    <Control name="${action}" autoChangeDirectionOnLimitsAfterStop="false" autoReverseToInitialValue="true" initialValue="0" stepSize="MAX" stepsPerSeconds="MAX">\n`
  + (key === undefined ? '' : `        <KeyBinder key="${key}" direction="INCREASE" />\n`) + `        <Channel number="${action}" direction="DIRECT" percentage="1" />\n    </Control>\n`;
const OLD = `<Controller>\n${Array.from({ length: 52 }, (_, a) => control(a, a === ACTIVATE ? SPACE : a === JUMP ? E : undefined)).join('')}</Controller>\n`;
// (one line of the player's Lua console: a sample each frame for 4 s of real time — the two actions and the player's height)
const LUA = "local t0, z0, r = core.getRealTime(), self.position.z, {j = false, a = false, top = 0, n = 0}; local function look() r.n = r.n + 1; "
  + 'if input.isActionPressed(input.ACTION.Jump) then r.j = true end; if input.isActionPressed(input.ACTION.Activate) then r.a = true end; '
  + 'local d = self.position.z - z0; if d > r.top then r.top = d end; '
  + "if core.getRealTime() - t0 < 4 then async:newUnsavableSimulationTimer(0.02, look) else "
  + "error(string.format('ORTHROS-KEYS jump=%s activate=%s rise=%.0f samples=%d', tostring(r.j), tostring(r.a), r.top, r.n)) end end; look()";

const browser = await chromium.launch(launchOptions({ gl: 'swiftshader', channel: arg('--channel', 'chromium') }));
const draw = args.includes('--draw');
// (rasterizer discard with the engine drawing on its own thread: the init script below only reaches the page's contexts —
// the draw thread's is the engine's own "discard" value)
const query = draw ? arg('--query', '') : arg('--query', '').replace(/(OPENMW_ORTHROS_DRAWTHREAD=)1(?=$|[,&])/, '$1discard');
const faults = [], lines = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => faults.push(e.message));
  // (rasterizer discard, as perf.mjs --discard: SwiftShader draws nothing, the engine runs its frames many times faster —
  // its logic and input as they are; --draw keeps the pictures, for the screenshots)
  if (!draw) await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype, RD = 0x8C89, enable = proto.enable, disable = proto.disable, getContext = HTMLCanvasElement.prototype.getContext;
    proto.disable = function (cap) { if (cap === RD) return; return disable.call(this, cap); };
    HTMLCanvasElement.prototype.getContext = function (...a) { const gl = getContext.apply(this, a); if (gl && gl instanceof WebGL2RenderingContext) enable.call(gl, RD); return gl; };
  });
  page.on('console', (m) => { if (/ORTHROS-KEYS|\[orthros\] saved bindings/.test(m.text())) lines.push(m.text()); });
  // (a check: nothing reported to the server — its learned order, telemetry and the gateway's client log stay clean)
  await page.route((u) => /\/clientlog$|\/api\/(telemetry|prefetch|profile-seed|programs|regions)(\/|$)/.test(u.pathname), (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204, body: '' }));
  const url = `${base}/ports/openmw/${encodeURIComponent(id)}/app/index.html?src=hosted&start=${encodeURIComponent(start)}${query ? '&' + query : ''}`;
  const inWorld = async () => {
    await page.waitForFunction(() => window.omw?.state?.['orthros.view'] !== undefined, null, { timeout: 600000, polling: 500 });
    await page.mouse.click(640, 400);
    await page.waitForTimeout(3000);
  };
  const logText = () => page.evaluate(() => document.querySelector('#log')?.textContent ?? '');
  let seeded = null;
  await page.goto(url);
  await inWorld();
  if (seedOld) {
    // (the old pair saved, no marker: as a player who closed the Options window before the layout changed)
    await page.evaluate(async ({ file, mark, xml }) => {
      const FS = window.FS ?? window.Module.FS;
      FS.writeFile(file, xml);
      if (FS.analyzePath(mark).exists) FS.unlink(mark);
      await new Promise((resolve, reject) => FS.syncfs(false, (e) => (e ? reject(e) : resolve())));
    }, { file: INPUT_FILE, mark: MARK_FILE, xml: OLD });
    await page.reload();
    await inWorld();
    seeded = await page.evaluate(({ file, mark }) => {
      const FS = window.FS ?? window.Module.FS, read = (p) => (FS.analyzePath(p).exists ? FS.readFile(p, { encoding: 'utf8' }) : null);
      return { file: read(file), mark: read(mark) };
    }, { file: INPUT_FILE, mark: MARK_FILE });
  }
  // (the reports so far: the page's console and the engine page's log, where the engine's errors land)
  const reports = async () => [...lines, ...(await logText()).split('\n')].filter((l) => l.includes('ORTHROS-KEYS'));
  const probe = async (key) => {
    const before = (await reports()).length;
    await page.keyboard.press('Backquote'); await page.waitForTimeout(800);
    await page.keyboard.type('luap'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
    await page.keyboard.type(LUA); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    await page.keyboard.press('Backquote'); await page.waitForTimeout(300);
    await page.keyboard.down(key); await page.waitForTimeout(1200); await page.keyboard.up(key);
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const all = await reports(), m = all.length > before ? /jump=(\w+) activate=(\w+) rise=(-?\d+) samples=(\d+)/.exec(all.at(-1)) : null;
      if (m) return { jump: m[1] === 'true', activate: m[2] === 'true', rise: Number(m[3]), samples: Number(m[4]) };
      await page.waitForTimeout(250);
    }
    await page.screenshot({ path: path.join(dir, `probe-${key}.png`) });
    return null;
  };
  const space = await probe('Space');
  await page.waitForTimeout(1500); // (landed)
  const e = await probe('KeyE');
  const ok = !!space && space.jump && !space.activate && space.rise > 10 && !!e && e.activate && !e.jump
    && (!seedOld || (/"result":"swapped"/.test(seeded.mark ?? '') && seeded.file?.includes(`<KeyBinder key="${E}" direction="INCREASE" />\n        <Channel number="${ACTIVATE}"`)));
  await page.screenshot({ path: path.join(dir, 'keys.png') });
  console.log(JSON.stringify({ manifest: id, url: base, seedOld, seeded: seeded && { mark: seeded.mark && JSON.parse(seeded.mark) }, space, e, ok, faults }));
  process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); }
