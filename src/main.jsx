import React from "react";
import { createRoot } from "react-dom/client";
import Tabulator from "./App.jsx";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "./styles.css";

/* Register the network-first worker. https only: that skips the smoke
   test's http server, and GitHub Pages — the only place this actually
   matters — is https. A failure here must never stop the app rendering,
   which is why nothing awaits it and the catch is silent. */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {});
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Tabulator />
  </React.StrictMode>
);
