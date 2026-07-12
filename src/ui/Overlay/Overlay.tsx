import React from "react";
import { cx } from "../cx";
import s from "./Overlay.module.css";

interface OverlayProps {
  isOpen: boolean;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

export function Overlay({
  isOpen,
  children,
  className,
  style,
  onClick,
}: OverlayProps): React.ReactElement {
  return (
    <div
      className={cx(s, "overlay", isOpen && "is-open", className)}
      style={style}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
