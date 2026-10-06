// Entry point served at /tests/ui/harness.html by the dev-mode Vite server
// started from tests/ui/run.ts. Installs the fake Tauri backend (mockBackend)
// *before* importing the real app, then mounts it exactly like src/main.ts.
import "./mockBackend";

await import("/src/main.ts");

// Lets scenarios drive the git store directly (docs/GUIDE.md §14): `window.__gitStore`.
const gitModule = await import("/src/lib/git/git.svelte.ts");
(window as unknown as { __gitStore: unknown }).__gitStore = gitModule.gitStore;
