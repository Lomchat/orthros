import React from "react";
import s from "./Hint.module.css";

interface HintProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Hint({ children, className, style }: HintProps): React.ReactElement {
  return (
    <p className={`${s["hint"]}${className ? ` ${className}` : ""}`} style={style}>{children}</p>
  );
}
