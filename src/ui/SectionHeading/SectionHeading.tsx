import React from "react";
import s from "./SectionHeading.module.css";

interface SectionHeadingProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function SectionHeading({ children, className, style }: SectionHeadingProps): React.ReactElement {
  return (
    <h3 className={`${s["sect-h"]}${className ? ` ${className}` : ""}`} style={style}>{children}</h3>
  );
}
