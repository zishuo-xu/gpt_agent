import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionApp } from "./SessionApp";
import { MemoryApp } from "./MemoryApp";
import "./styles/base.css";
import "./styles/settings.css";
import "./styles/chat.css";
import "./styles/memory.css";

function Router() {
  const [route, setRoute] = useState(window.location.hash.slice(1));
  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  if (route === "settings") return <App />;
  if (route === "memory") return <MemoryApp />;
  return <SessionApp />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
