import React from "react";
import { cx } from "../ui/cx";
import s from "./InputStatusOverlay.module.css";

/**
 * Live input-device status shown in the corner of the emulator canvas.
 *
 * Two independent signals drive it (see App.tsx pollGamepad + the worker's
 * InputManager.noteGuestGamepadRead):
 *   - padConnected: a gamepad is plugged into the BROWSER (navigator.getGamepads).
 *   - guestActive:  the GAME is actually reading the joystick/gamepad API
 *                   (DInput Acquire/GetDeviceState or winmm joyGetPosEx) right now.
 *
 * The distinction is the whole point: a pad can be plugged in while the title
 * never touches it (keyboard-only game, or it just hasn't acquired the device).
 */
export interface InputStatus {
  padConnected: boolean;
  padLabel: string | null;
  guestActive: boolean;
}

const GamepadGlyph: React.FC = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
    <path
      fill="currentColor"
      d="M7.5 7h9a4.5 4.5 0 0 1 4.46 3.9l.74 5.2A2.4 2.4 0 0 1 19.3 19c-.8 0-1.53-.4-1.97-1.06L16.1 16H7.9l-1.23 1.94A2.36 2.36 0 0 1 4.7 19a2.4 2.4 0 0 1-2.4-2.9l.74-5.2A4.5 4.5 0 0 1 7.5 7Zm-.25 3a.75.75 0 0 0-.75.75V12H5.25a.75.75 0 0 0 0 1.5H6.5v1.25a.75.75 0 0 0 1.5 0V13.5h1.25a.75.75 0 0 0 0-1.5H8v-1.25A.75.75 0 0 0 7.25 10Zm8.25.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm2 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"
    />
  </svg>
);

export const InputStatusOverlay: React.FC<{ status: InputStatus }> = ({ status }) => {
  const { padConnected, padLabel, guestActive } = status;

  if (!padConnected && !guestActive) return null;

  const state = guestActive ? "active" : padConnected ? "connected" : "idle";
  const title = guestActive
    ? `${padLabel ?? "Gamepad"} — in use by the game`
    : `${padLabel ?? "Gamepad"} — connected (game not using it)`;

  return (
    <div className={s["input-status"]} role="status" aria-label={title} title={title}>
      <span className={cx(s, "input-status__chip", `input-status__chip--${state}`)}>
        <GamepadGlyph />
      </span>
    </div>
  );
};
