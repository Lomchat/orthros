import React from "react";
import s from "./CloseButton.module.css";

interface CloseButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
}

export function CloseButton({
  children,
  ...rest
}: CloseButtonProps): React.ReactElement {
  return (
    <button className={s["x"]} {...rest}>
      {children}
    </button>
  );
}
