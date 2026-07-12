import React from "react";
import { cx } from "../cx";
import s from "./Toggle.module.css";

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}

export function Toggle({ checked, disabled = false, onChange }: ToggleProps): React.ReactElement {
  return (
    <div
      className={cx(s, "toggle", checked && "on")}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      style={disabled ? { opacity: 0.4, pointerEvents: "none" } : undefined}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onChange(!checked);
        }
      }}
    />
  );
}
