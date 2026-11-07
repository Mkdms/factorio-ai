import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { paintSavedTheme } from "./useTheme.ts";
import "./index.css";

paintSavedTheme();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
