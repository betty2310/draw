import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Toasty>
        <App />
      </Toasty>
    </TooltipProvider>
  </StrictMode>,
);
