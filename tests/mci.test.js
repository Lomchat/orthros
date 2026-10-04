// MCI digital video (src/win32/mci.js) driven by a Win32 program (tools/pe/mci.c): mciSendString — open with a type
// and an alias, window, put / where, play notify (MM_MCINOTIFY), status, seek, play wait, frames, from / to, close,
// errors — and mciSendCommand (open by element, play wait, status, close), over the same playback engine as DirectShow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { makeAvi } from './media-avi-writer.js';
import { mciWords } from '../src/win32/mci.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const MOVIE = new URL('./fixtures/media/movie.mpg', import.meta.url).pathname;
const skip = !fs.existsSync(PE_DIR + 'mci.exe') && 'build/pe/mci.exe missing (make pe-tests)';

test('MCI command strings: words and quoted names', () => {
  assert.deepEqual(mciWords('open "C:\\Movies\\My Intro.avi" type avivideo alias intro'), ['open', 'C:\\Movies\\My Intro.avi', 'type', 'avivideo', 'alias', 'intro']);
  assert.deepEqual(mciWords('  play   intro  from 0 to 100 notify '), ['play', 'intro', 'from', '0', 'to', '100', 'notify']);
});

test('mci.exe: MPEG movie through mciSendString, AVI through mciSendCommand', { skip }, () => {
  const vfs = new Vfs(), dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open('mci.exe', { create: true }).write(0, fs.readFileSync(PE_DIR + 'mci.exe'));
  dir.open('movie.mpg', { create: true }).write(0, fs.readFileSync(MOVIE));
  dir.open('clip.avi', { create: true }).write(0, makeAvi(96, 64, 12, 10).bytes);
  const clock = new VirtualClock();
  const host = new HeadlessHost({ clock, width: 800, height: 600 });
  const shown = []; let hidden = 0;
  host.display.presentVideo = (rgba, w, h, rect) => shown.push({ at: clock.now(), w, h, rect: { ...rect } });
  host.display.hideVideo = () => { hidden++; };
  const vm = new Vm({ vfs, clock, host, logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\mci.exe' });
  assert.equal(vm.run(), 0);
  const res = Object.fromEntries(vm.stdout.join('').trim().split('\n').map((l) => l.split('=')));
  assert.equal(res.missing, '275', 'MCIERR_FILE_NOT_FOUND');
  assert.equal(res.cdaudio, '257', 'other device types: as before');
  assert.equal(res['unknown name'], '263', 'MCIERR_INVALID_DEVICE_NAME');
  assert.equal(res.open, '0'); assert.equal(res['open id'], '1'); assert.equal(res['device id'], '1');
  assert.ok(Math.abs(Number(res.length) - 1200) < 60, `length ${res.length}`);
  assert.equal(res.mode, 'stopped');
  assert.equal(res.window, '0'); assert.equal(res.put, '0'); assert.equal(res.where, '8 6 128 96');
  assert.equal(res.play, '0'); assert.equal(res['mode playing'], 'playing');
  const e = Number(res['elapsed ms']);
  assert.ok(e >= 1150 && e <= 1350, `played in ${e} ms`);
  assert.equal(res.notified, '1'); assert.equal(res['notify flag'], '1', 'MCI_NOTIFY_SUCCESSFUL'); assert.equal(res['notify id'], '1');
  assert.equal(res['mode after'], 'stopped');
  assert.ok(Math.abs(Number(res.position) - 1200) < 60, `position ${res.position}`);
  assert.equal(res.seek, '0'); assert.equal(res['play wait'], '0');
  const w = Number(res['elapsed wait ms']);
  assert.ok(w >= 1150 && w <= 1350, `play wait returned after ${w} ms`);
  assert.equal(res.frames, '0'); assert.ok(['29', '30'].includes(res['length frames']), `length ${res['length frames']} frames`); // (an MPEG stream's length: from its last time stamps)
  const part = Number(res['part ms']);
  assert.ok(part >= 380 && part <= 480, `from frame 10 to 20 in ${part} ms`);
  assert.equal(res.close, '0'); assert.equal(res['closed name'], '263');
  // the pictures: in the given window's client area at the destination rectangle
  const owner = [...vm.wm.windows.values()].find((x) => x.title === 'mci');
  const firstAvi = shown.findIndex((x) => x.rect.w === 96 && x.rect.h === 64), mpeg = shown.slice(0, firstAvi);
  assert.ok(mpeg.length >= 50, `${mpeg.length} pictures of the MPEG movie`);
  for (const s of mpeg) assert.deepEqual(s.rect, { x: owner.client.l + 8, y: owner.client.t + 6, w: 128, h: 96 });
  // the AVI through mciSendCommand: its own window (centered, natural size), played to the end, closed
  assert.equal(res['cmd open'], '0'); assert.equal(res['cmd play wait'], '0');
  const ce = Number(res['cmd elapsed ms']);
  assert.ok(ce >= 1150 && ce <= 1350, `AVI played in ${ce} ms`);
  assert.equal(res['cmd mode'], '525', 'MCI_MODE_STOP'); assert.equal(res['cmd length'], '12', 'AVIVideo: frames by default');
  assert.equal(res['cmd close'], '0');
  const avi = shown.filter((s) => s.rect.w === 96 && s.rect.h === 64);
  assert.ok(avi.length >= 10, `${avi.length} pictures of the AVI`);
  assert.deepEqual(avi[0].rect, { x: (800 - 96) >> 1, y: (600 - 64) >> 1, w: 96, h: 64 });
  assert.ok(hidden >= 2, 'the layer hidden at each close');
});
