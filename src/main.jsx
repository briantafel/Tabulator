import React from "react";
import { createRoot } from "react-dom/client";
import Tabulator from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Tabulator />
  </React.StrictMode>
);
