import React from "react";
import { cx } from "../cx";
import s from "./Chip.module.css";

interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  mount?: boolean;
  className?: string;
}

export function Chip({ mount, className, children, ...rest }: ChipProps): React.ReactElement {
  return (
    <button className={cx(s, "chip", mount && "chip--mount", className)} {...rest}>
      {children}
    </button>
  );
}
