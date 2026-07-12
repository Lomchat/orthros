import React from "react";
import { cx } from "../cx";
import s from "./ActionButton.module.css";

type ActionButtonVariant = "default" | "primary" | "secondary";
type ActionButtonSize = "default" | "small";

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionButtonVariant;
  size?: ActionButtonSize;
  active?: boolean;
  toggledOff?: boolean;
  className?: string;
}

export function ActionButton({
  variant = "default",
  size = "default",
  active,
  toggledOff,
  className,
  children,
  ...rest
}: ActionButtonProps): React.ReactElement {
  return (
    <button
      className={cx(
        s,
        "action-btn",
        variant !== "default" && variant,
        active && "active",
        size === "small" && "small",
        toggledOff && "toggled-off",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
