import React from "react";
import { cx } from "../cx";
import s from "./IconButton.module.css";

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "md" | "sm";
  danger?: boolean;
  className?: string;
}

export function IconButton({
  size = "md",
  danger,
  className,
  children,
  ...rest
}: IconButtonProps): React.ReactElement {
  if (size === "sm") {
    return (
      <button
        className={cx(s, "iconbtn-sm", danger && "iconbtn-sm--danger", className)}
        {...rest}
      >
        {children}
      </button>
    );
  }
  return (
    <button className={cx(s, "iconbtn", className)} {...rest}>
      {children}
    </button>
  );
}
