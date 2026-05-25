import "@xterm/xterm/css/xterm.css";
import "./styles/armillary.css";
import "./styles/app.css";
import "./styles/overrides.css";

import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(<App />);
