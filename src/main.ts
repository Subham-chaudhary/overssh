import { mount } from "svelte";
import "./app.css";
import { loadSettings } from "./lib/settings.svelte";

// Load persisted settings (theme included) before the first paint so there's
// no flash of the fallback theme in src/app.css's :root.
await loadSettings();

// The same bundle serves two windows (docs/GUIDE.md §14.4.W): the detached
// terminal window is opened with `?window=terminals` and mounts its own root.
const isTerminalWindow = new URLSearchParams(window.location.search).get("window") === "terminals";

const Root = isTerminalWindow
  ? (await import("./terminal-window/TerminalWindow.svelte")).default
  : (await import("./App.svelte")).default;

const app = mount(Root, { target: document.getElementById("app")! });

export default app;
