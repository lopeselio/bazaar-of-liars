import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../style.css";
import { VerifyPage } from "./VerifyPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VerifyPage />
  </StrictMode>,
);
