// DirectShow playback (src/win32/quartz.js) driven by a Win32 program through the COM ABI (tools/pe/quartz.c): the
// filter graph renders a movie (an MPEG-1 system stream, then an AVI), plays it over the VM clock, shows its pictures on
// the host's video layer in the video window's rectangle, mixes its sound through DirectSound, and reports the end as
// games expect it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { makeAvi } from './media-avi-writer.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const MOVIE = new URL('./fixtures/media/movie.mpg', import.meta.url).pathname;
const skip = !fs.existsSync(PE_DIR + 'quartz.exe') && 'build/pe/quartz.exe missing (make pe-tests)';

/** quartz.exe with `movie` as C:\Test\movie.mpg (DirectShow tells files by their content): its output, what was shown and heard */
function play(movie) {
  const vfs = new Vfs(), dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open('quartz.exe', { create: true }).write(0, fs.readFileSync(PE_DIR + 'quartz.exe'));
  dir.open('movie.mpg', { create: true }).write(0, movie);
  dir.open('notmedia.bin', { create: true }).write(0, new TextEncoder().encode('RIFF....this is not a movie'));
  const clock = new VirtualClock();
  const host = new HeadlessHost({ clock, width: 800, height: 600 });
  const shown = [];
  let hidden = 0; host.display.hideVideo = () => { hidden++; };
  const vm = new Vm({ vfs, clock, host, logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\quartz.exe' });
  // the sound: what the mixer renders while the pictures are shown
  let peak = 0, mixed = 0;
  const out = new Float32Array(2 * 256);
  host.display.presentVideo = (rgba, w, h, rect) => {
    const c = ((h >> 1) * w + (w >> 1)) * 4;
    shown.push({ at: clock.now(), w, h, rect: { ...rect }, center: Array.from(rgba.subarray(c, c + 3)) });
    if (vm.audio) { vm.audio.render(out, 256, 44100); mixed++; for (const v of out) peak = Math.max(peak, Math.abs(v)); }
  };
  const code = vm.run();
  const res = Object.fromEntries(vm.stdout.join('').trim().split('\n').map((l) => l.split('=')));
  return { vm, code, res, shown, hidden, peak, mixed };
}

function checkPlayback({ vm, code, res, shown, hidden, peak, mixed }, { fps, w, h, peakRange }) {
  assert.equal(code, 0);
  assert.equal(res.create, '0x00000000');
  assert.equal(res['render missing'], '0x80070002');
  assert.equal(res['render other'], '0x80040240', 'VFW_E_UNKNOWN_FILE_TYPE');
  assert.equal(res['empty run event'], '0x00000000'); assert.equal(res['empty run code'], '1', 'an empty graph run: EC_COMPLETE at once');
  assert.equal(res.render, '0x00000000');
  assert.equal(res['render again'], '0x80040204', 'VFW_E_ALREADY_CONNECTED');
  assert.equal(res.interfaces, '6');
  assert.equal(res.width, String(w)); assert.equal(res.height, String(h));
  assert.ok(Math.abs(Number(res['duration ms']) - 1200) < 60, `duration ${res['duration ms']}`);
  assert.equal(res.volume, '0x00000000');
  assert.equal(res.position, '0x00000000');
  assert.equal(res.run, '0x00000000');
  assert.equal(res.state, '2');
  // the end, signaled after the movie's duration (the clock runs while the program waits)
  const elapsed = Number(res['elapsed ms']);
  assert.ok(elapsed >= 1100 && elapsed <= 1350, `played in ${elapsed} ms`);
  assert.equal(res.event, '0x00000000'); assert.equal(res['event code'], '1', 'EC_COMPLETE');
  assert.equal(res['next event'], '0x80004004', 'E_ABORT: queue empty');
  assert.equal(res['signaled after'], '258', 'event handle reset once the queue is empty (WAIT_TIMEOUT)');
  assert.equal(res.notified, '1', 'WM_GRAPHNOTIFY posted to the notify window');
  assert.ok(Math.abs(Number(res['position ms']) - Number(res['duration ms'])) < 60, `position at the end ${res['position ms']}`);
  assert.equal(res.rewind, '0x00000000'); assert.equal(res['rewound ms'], '0');
  assert.equal(res.wait, '0x00000000'); assert.equal(res['wait code'], '1');
  const elapsed2 = Number(res['elapsed 2 ms']);
  assert.ok(elapsed2 >= 1100 && elapsed2 <= 1350, `played again in ${elapsed2} ms`);
  assert.equal(res['short wait'], '0x80004004', 'WaitForCompletion timing out: E_ABORT');
  assert.equal(res['last release'], '0');
  // pictures: about one per frame for each of the plays, in the child window's rectangle (owner client + 8,6)
  const n = Math.round(1.2 * fps);
  assert.ok(shown.length >= 2 * (n - 2), `${shown.length} pictures shown`);
  const owner = [...vm.wm.windows.values()].find((x) => x.title === 'movie');
  for (const s of shown) {
    assert.equal(s.w, w); assert.equal(s.h, h);
    assert.deepEqual(s.rect, { x: owner.client.l + 8, y: owner.client.t + 6, w: 128, h: 96 });
  }
  const gaps = shown.slice(1, n - 2).map((s, i) => s.at - shown[i].at), period = 1000 / fps;
  assert.ok(Math.max(...gaps) <= period + 5 && Math.min(...gaps) >= period - 5, `picture intervals ${gaps.join(' ')}`);
  assert.ok(shown.some((s) => s.center.some((v) => v > 40)), 'pictures are not black');
  assert.ok(hidden >= 1, 'the video layer hidden when the graph is released');
  // sound: a stream voice of the DirectSound mixer, stopped at the end
  assert.ok(vm.audio, 'mixer created');
  assert.equal([...vm.audio.buffers].filter((b) => b.playing).length, 0);
  assert.ok(mixed > 10 && peak > peakRange[0] && peak < peakRange[1], `sound mixed: peak ${peak}`);
}

test('quartz.exe, an MPEG-1 movie: RenderFile, Run, video window, EC_COMPLETE (event handle, message, GetEvent, WaitForCompletion), seeking', { skip }, () => {
  // (the movie's sound: a 440 Hz tone of amplitude 1/8, played at -6 dB by IBasicAudio::put_Volume)
  checkPlayback(play(fs.readFileSync(MOVIE)), { fps: 25, w: 96, h: 64, peakRange: [0.055, 0.07] });
});

test('quartz.exe, an AVI (paletted frames, PCM): the same', { skip }, () => {
  // (sound: a saw wave between -1000 and +999 / 32768, at -6 dB)
  checkPlayback(play(makeAvi(96, 64, 12, 10).bytes), { fps: 10, w: 96, h: 64, peakRange: [0.012, 0.018] });
});
