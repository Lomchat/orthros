import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { CloudSaveProvider } from "./cloud/CloudSaveProvider";
import "./styles/tokens.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <React.StrictMode>
    <CloudSaveProvider>
      <App />
    </CloudSaveProvider>
  </React.StrictMode>
);
