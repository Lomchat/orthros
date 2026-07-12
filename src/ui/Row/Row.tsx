import React from "react";
import { cx } from "../cx";
import s from "./Row.module.css";

export function SettingsRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={s["setrow"]}>
      <div className={s["setrow__txt"]}>
        <div className={s["setrow__t"]}>{title}</div>
        {hint && <div className={s["setrow__h"]}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function SettingsSection({
  children,
  active = true,
}: {
  children: React.ReactNode;
  active?: boolean;
}): React.ReactElement {
  return (
    <section className={cx(s, "spane", active && "is-active")}>{children}</section>
  );
}
