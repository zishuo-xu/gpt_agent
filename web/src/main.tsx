import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionApp } from "./SessionApp";
import { MemoryApp } from "./MemoryApp";
import { PluginApp } from "./PluginApp";
import { ScheduledApp } from "./ScheduledApp";
import { StatsApp } from "./StatsApp";
import "./styles/base.css";
import "./styles/settings.css";
import "./styles/chat.css";
import "./styles/memory.css";
import "./styles/plugins.css";
import "./styles/scheduler.css";
import "./styles/flight-recorder.css";

function Router() {
  const [route, setRoute] = useState(window.location.hash.slice(1));
  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  if (route === "settings") return <App />;
  if (route === "memory") return <MemoryApp />;
  if (route === "plugins") return <PluginApp />;
  if (route === "scheduled") return <ScheduledApp />;
  if (route === "stats") return <StatsApp />;
  // 记忆面板「打开会话」直达：#sessions/<id>
  if (route.startsWith("sessions/")) {
    return (
      <SessionApp
        initialSessionId={route.slice("sessions/".length)}
      />
    );
  }
  return <SessionApp />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
