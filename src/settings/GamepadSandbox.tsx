import React from "react";
import { Gamepad2 } from "lucide-react";
import {
  getCachedGamepadMeta,
  readLiveGamepad,
  rescanGamepads,
  subscribeGamepadCache,
} from "../gamepad-cache";
import { cx } from "../ui/cx";
import s from "./GamepadSandbox.module.css";

const DEADZONE = 0.08;

export interface GamepadSnapshot {
  connected: boolean;
  id: string | null;
  mapping: string;
  buttons: boolean[];
  buttonValues: number[];
  axes: [number, number, number, number];
}

const EMPTY_SNAPSHOT: GamepadSnapshot = {
  connected: false,
  id: null,
  mapping: "",
  buttons: [],
  buttonValues: [],
  axes: [0, 0, 0, 0],
};

function applyDeadzone(value: number): number {
  return Math.abs(value) < DEADZONE ? 0 : value;
}

function formatPadName(id: string): string {
  const paren = id.indexOf(" (");
  return paren > 0 ? id.slice(0, paren).trim() : id.trim();
}

function snapshotFromPad(pad: Gamepad): GamepadSnapshot {
  const buttons = pad.buttons.map((b) => b.pressed);
  const buttonValues = pad.buttons.map((b) => b.value ?? (b.pressed ? 1 : 0));
  const raw = pad.axes ?? [];

  return {
    connected: true,
    id: pad.id || "Gamepad",
    mapping: pad.mapping || "standard",
    buttons,
    buttonValues,
    axes: [
      applyDeadzone(raw[0] ?? 0),
      applyDeadzone(raw[1] ?? 0),
      applyDeadzone(raw[2] ?? 0),
      applyDeadzone(raw[3] ?? 0),
    ],
  };
}

function buildSnapshot(): GamepadSnapshot {
  const live = readLiveGamepad();
  if (live) return snapshotFromPad(live);

  const cached = getCachedGamepadMeta();
  if (cached) {
    return {
      connected: true,
      id: cached.id,
      mapping: cached.mapping,
      buttons: [],
      buttonValues: [],
      axes: [0, 0, 0, 0],
    };
  }

  return EMPTY_SNAPSHOT;
}

function useGamepadSnapshot(active: boolean): GamepadSnapshot {
  const [snapshot, setSnapshot] = React.useState<GamepadSnapshot>(EMPTY_SNAPSHOT);

  React.useEffect(() => {
    if (!active) return;

    const sync = () => setSnapshot(buildSnapshot());

    let rafId = 0;
    const poll = () => {
      rescanGamepads();
      sync();
      rafId = requestAnimationFrame(poll);
    };

    rescanGamepads();
    sync();
    const unsub = subscribeGamepadCache(sync);
    rafId = requestAnimationFrame(poll);

    return () => {
      cancelAnimationFrame(rafId);
      unsub();
    };
  }, [active]);

  return snapshot;
}

function PadButton({
  label,
  pressed,
  shape = "round",
  extraClass,
}: {
  label: string;
  pressed: boolean;
  shape?: "round" | "wide" | "dpad";
  extraClass?: string;
}): React.ReactElement {
  const shapeClass = shape === "wide" ? "gp-btn--wide" : shape === "dpad" ? "gp-btn--dpad" : null;
  return (
    <span
      className={cx(s, "gp-btn", shapeClass, pressed && "is-pressed", extraClass)}
      aria-pressed={pressed}
    >
      {label}
    </span>
  );
}

function Trigger({ label, value }: { label: string; value: number }): React.ReactElement {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const active = pct > 4;
  return (
    <div className={cx(s, "gp-trigger", active && "is-active")}>
      <span className={s["gp-trigger__label"]}>{label}</span>
      <div className={s["gp-trigger__track"]} aria-hidden>
        <div className={s["gp-trigger__fill"]} style={{ height: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stick({ x, y }: { x: number; y: number }): React.ReactElement {
  return (
    <div className={s["gp-stick"]} aria-hidden>
      <div className={s["gp-stick__well"]}>
        <span className={s["gp-stick__ring"]} />
        <span
          className={s["gp-stick__knob"]}
          style={{ transform: `translate(calc(-50% + ${x * 28}px), calc(-50% + ${y * 28}px))` }}
        />
      </div>
    </div>
  );
}

function ControllerGhost(): React.ReactElement {
  return (
    <div className={s["gp-ghost"]} aria-hidden>
      <div className={s["gp-ghost__body"]}>
        <span className={cx(s, "gp-ghost__bump", "gp-ghost__bump--l")} />
        <span className={cx(s, "gp-ghost__bump", "gp-ghost__bump--r")} />
        <span className={cx(s, "gp-ghost__stick", "gp-ghost__stick--l")} />
        <span className={cx(s, "gp-ghost__stick", "gp-ghost__stick--r")} />
        <span className={s["gp-ghost__dpad"]} />
        <span className={s["gp-ghost__face"]} />
      </div>
      <p className={s["gp-ghost__hint"]}>Connect a USB or Bluetooth controller.</p>
    </div>
  );
}

function ControllerLive({ pad }: { pad: GamepadSnapshot }): React.ReactElement {
  const btn = (idx: number) => !!pad.buttons[idx];
  const val = (idx: number) => pad.buttonValues[idx] ?? 0;

  return (
    <div className={s["gp-controller"]} aria-label="Gamepad test area">
      <div className={s["gp-controller__shoulders"]}>
        <div className={s["gp-controller__shoulder-side"]}>
          <PadButton label="LB" pressed={btn(4)} shape="wide" />
          <Trigger label="LT" value={val(6)} />
        </div>
        <div className={cx(s, "gp-controller__shoulder-side", "gp-controller__shoulder-side--right")}>
          <Trigger label="RT" value={val(7)} />
          <PadButton label="RB" pressed={btn(5)} shape="wide" />
        </div>
      </div>

      <div className={s["gp-controller__main"]}>
        <div className={s["gp-controller__stick-slot"]}>
          <Stick x={pad.axes[0]} y={pad.axes[1]} />
        </div>

        <div className={s["gp-controller__dpad"]} aria-label="D-pad">
          <PadButton label="↑" pressed={btn(12)} shape="dpad" extraClass={s["gp-dpad__up"]} />
          <PadButton label="←" pressed={btn(14)} shape="dpad" extraClass={s["gp-dpad__left"]} />
          <PadButton label="→" pressed={btn(15)} shape="dpad" extraClass={s["gp-dpad__right"]} />
          <PadButton label="↓" pressed={btn(13)} shape="dpad" extraClass={s["gp-dpad__down"]} />
        </div>

        <div className={s["gp-controller__face"]} aria-label="Face buttons">
          <PadButton label="Y" pressed={btn(3)} extraClass={s["gp-face__y"]} />
          <PadButton label="X" pressed={btn(2)} extraClass={s["gp-face__x"]} />
          <PadButton label="B" pressed={btn(1)} extraClass={s["gp-face__b"]} />
          <PadButton label="A" pressed={btn(0)} extraClass={s["gp-face__a"]} />
        </div>

        <div className={s["gp-controller__stick-slot"]}>
          <Stick x={pad.axes[2]} y={pad.axes[3]} />
        </div>
      </div>

      <div className={s["gp-controller__menu"]}>
        <PadButton label="Back" pressed={btn(8)} shape="wide" />
        <PadButton label="L3" pressed={btn(10)} shape="wide" />
        <PadButton label="R3" pressed={btn(11)} shape="wide" />
        <PadButton label="Start" pressed={btn(9)} shape="wide" />
      </div>
    </div>
  );
}

export default function GamepadSandbox({ active }: { active: boolean }): React.ReactElement {
  const pad = useGamepadSnapshot(active);
  const displayName = pad.id ? formatPadName(pad.id) : "Gamepad";

  return (
    <div className={cx(s, "gp-sandbox", pad.connected && "is-live")}>
      <header className={s["gp-sandbox__head"]}>
        <span className={s["gp-sandbox__icon"]} aria-hidden>
          <Gamepad2 size={17} strokeWidth={1.7} />
        </span>
        <div className={s["gp-sandbox__meta"]}>
          <div className={s["gp-sandbox__title-row"]}>
            <span className={s["gp-sandbox__name"]}>{pad.connected ? displayName : "No gamepad"}</span>
            {pad.connected && <span className={s["gp-sandbox__badge"]}>Live</span>}
          </div>
          {pad.connected && (
            <>
              <div className={s["gp-sandbox__raw"]} title={pad.id ?? undefined}>
                {pad.id}
              </div>
              <div className={s["gp-sandbox__sub"]}>
                <span className={s["gp-sandbox__chip"]}>{pad.mapping}</span>
                <span className={s["gp-sandbox__axes"]}>
                  L {Math.round(pad.axes[0] * 100)},{Math.round(pad.axes[1] * 100)} · R{" "}
                  {Math.round(pad.axes[2] * 100)},{Math.round(pad.axes[3] * 100)}
                </span>
              </div>
            </>
          )}
        </div>
        <span className={cx(s, "gp-sandbox__pulse", pad.connected && "is-on")} aria-hidden />
      </header>

      {pad.connected ? <ControllerLive pad={pad} /> : <ControllerGhost />}
    </div>
  );
}
