import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { WalletProvider } from "./lib/WalletProvider";
import { ToastProvider } from "./lib/ToastContext";
import { ThemeProvider } from "./lib/ThemeContext";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <WalletProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </WalletProvider>
    </ThemeProvider>
  </StrictMode>,
);
