/**
 * winmm joystick handlers (joyGetNumDevs / joyGetDevCaps / joyGetPos / joyGetPosEx /
 * joyGetThreshold / joySetThreshold / joySetCapture / joyReleaseCapture). No
 * joystick device is emulated — report "no devices / unplugged".
 */
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { System } from '../core/system';

const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALPARAM = 11;
const JOYERR_NOERROR = 0;
const JOYERR_UNPLUGGED = 167;

export function registerWinmmJoystickExports(exports: Record<string, ThunkImplementation>): void {
        exports["joyGetNumDevs"] = () => {
            return 1;
        };

        exports["joyGetDevCapsA"] = (ctx, mem, args) => {
            const uJoyID = args[0];
            const pjc = args[1];
            const cbjc = args[2];
            if (!pjc || cbjc < 64 || pjc + cbjc > mem.length) {
                return MMSYSERR_INVALPARAM;
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(pjc + 0, 0xFFFF, true); // wMid
            view.setUint16(pjc + 2, 0x0001, true); // wPid
            // szPname (32 bytes)
            const name = "Emulated Gamepad\0";
            for (let i = 0; i < 32; i++) {
                mem[pjc + 4 + i] = i < name.length ? name.charCodeAt(i) : 0;
            }
            // Fill minimal caps
            view.setUint32(pjc + 36, 2, true); // wNumAxes
            view.setUint32(pjc + 40, 8, true); // wNumButtons
            view.setUint32(pjc + 44, 0, true); // wPeriodMin
            view.setUint32(pjc + 48, 1000, true); // wPeriodMax
            return MMSYSERR_NOERROR;
        };

        exports["joyGetPosEx"] = (ctx, mem, args) => {
            const uJoyID = args[0];
            const pji = args[1];
            if (!pji || pji + 52 > mem.length) {
                return MMSYSERR_INVALPARAM;
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const size = view.getUint32(pji, true);
            if (size < 52) {
                return MMSYSERR_INVALPARAM;
            }

            const inputManager = System.getInstance().inputManager;
            inputManager.noteGuestGamepadRead();
            const input = inputManager.getGamepadState();
            if (!input.connected) {
                return JOYERR_UNPLUGGED;
            }

            const clampAxis = (v: number) => {
                const mapped = (v | 0) + 32768;
                return Math.max(0, Math.min(65535, mapped));
            };

            const [ax0, ax1, ax2, ax3] = input.axes;
            const buttons = input.buttons >>> 0;
            const buttonCount = buttons ? buttons.toString(2).replace(/0/g, '').length : 0;

            view.setUint32(pji + 8, clampAxis(ax0), true);  // dwXpos
            view.setUint32(pji + 12, clampAxis(ax1), true); // dwYpos
            view.setUint32(pji + 16, clampAxis(ax2), true); // dwZpos
            view.setUint32(pji + 20, clampAxis(ax3), true); // dwRpos
            view.setUint32(pji + 24, 0, true); // dwUpos
            view.setUint32(pji + 28, 0, true); // dwVpos
            view.setUint32(pji + 32, buttons, true); // dwButtons
            view.setUint32(pji + 36, buttonCount, true); // dwButtonNumber
            view.setUint32(pji + 40, 0xFFFF, true); // dwPOV (centered)
            view.setUint32(pji + 44, 0, true); // dwReserved1
            view.setUint32(pji + 48, 0, true); // dwReserved2

            return JOYERR_NOERROR;
        };
}
