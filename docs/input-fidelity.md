# Input fidelity: clicks at low frame rates, text fields under the key remap (2026-11-10)

Both found in Age of the Ring's menus (French, software rendering, 2-15 fps) and fixed in the window manager
(`src/win32/user32.js`), for every game.

## A press right after a move is held one frame

Symptom: a check box in Options ignored a quick click (the harness pushes a move and a 100 ms click at once); the same
click on a button, a tab or a slider worked, and a click with the pointer already resting on the box worked.

Trace (`dbg:ORTHROS_TRACE_API=1`): the game reads the mouse only through window messages (no DirectInput, no
`GetAsyncKeyState`): WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP are all dispatched, in order, nothing lost. The widget
learns that it is hovered in its per-frame update, and only a hovered check box accepts a press. A move and a press
delivered in the same frame interval reach the game before that update. On Windows at 60 fps the move always comes a
frame earlier; at 2-5 fps a person moving and clicking within 200 ms produces the same sequence.

Fix: `WindowManager.pump` keeps a `mousedown` queued (events behind it too, order kept) until a Direct3D frame has been
presented since the last `mousemove`, at most 250 ms: the mirror of the existing rule for `mouseup` (a release waits for
a frame since its press). Only with a rendering Direct3D device (the frame count to watch). Messages keep their order;
DirectInput buffered data and `GetAsyncKeyState`'s "pressed since the last call" bit (already there) see the same events.

## Text fields without an input context

The manifest key remap (WASD to the arrows, D111) is suspended while the game awaits text. The rule was: the focused
window has an input context of its own (`ImmAssociateContext`), the SAGE IME manager's sign of a focused field. Age of
the Ring's Create-a-Captain name field calls no `Imm*` function, creates no caret and no edit control; the API trace
around focusing and typing shows nothing but the message loop. Its only sign is the cursor: the game sets an I-beam
(`Beam.ani`, a cursor loaded from a file) while the pointer is over the field. So `a`, `w`, `s`, `d` were remapped to
arrows ("Aranel" gave "rnel").

Rule now (`WindowManager.textInput`): text is awaited when
1. the cursor shown is an I-beam (`IDC_IBEAM`, or a cursor file named like the I-beam ones: `beam` in its file name), or
2. the last click was made while such a cursor was shown (`textClick`; the pointer may leave the field while typing),
   until another click or Enter / Escape ends the edit, or
3. the former rule (an input context of the window's own, or an IME turned off elsewhere).

Gameplay is unchanged: no I-beam cursor there, so WASD still scroll (BFME 2.22, RotWK, AotR skirmish).

Tests: `tests/mouse-input.test.js` (key remap: I-beam cursor, click into the field, Enter).
