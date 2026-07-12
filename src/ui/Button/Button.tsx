import React from "react";
import { cx } from "../cx";
import s from "./Button.module.css";

type ButtonVariant = "default" | "primary" | "ghost" | "danger";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  className?: string;
}

export function Button({
  variant = "default",
  className,
  children,
  ...rest
}: ButtonProps): React.ReactElement {
  return (
    <button
      className={cx(s, "btn", variant !== "default" && `btn--${variant}`, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
