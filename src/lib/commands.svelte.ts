// Command palette registry (docs/GUIDE.md §11 "Settings" / Ctrl+Shift+P).
// A small, dependency-free registry so any module — including P3/P5's editor
// and terminal code — can contribute palette entries without CommandPalette.svelte
// needing to know about them up front.
//
// API:
//   import { registerCommand, commandRegistry, type Command } from "./commands.svelte";
//
//   registerCommand({
//     id: "view.toggleTerminal",       // unique; re-registering the same id replaces it
//     title: "Toggle Terminal",
//     category: "View",                 // optional, shown as a palette group
//     keybinding: "Ctrl+`",             // optional, display-only hint (shadcn Kbd)
//     run: () => { ... },
//   });
//   // -> returns an unregister function; call it if the command's owner unmounts.
//
// `commandRegistry` is the live, reactive list — CommandPalette.svelte reads it
// directly (grouped by `category`, filtered by the search input).

export interface Command {
  id: string;
  title: string;
  category?: string;
  keybinding?: string;
  run: () => void;
}

export const commandRegistry = $state<Command[]>([]);

/** Registers (or replaces, by `id`) a command. Returns a function that
 * unregisters it — call it from the owning component's cleanup if the
 * command shouldn't outlive it (most of the app's own commands are global
 * and never unregister). */
export function registerCommand(command: Command): () => void {
  const idx = commandRegistry.findIndex((c) => c.id === command.id);
  if (idx === -1) commandRegistry.push(command);
  else commandRegistry.splice(idx, 1, command);
  return () => unregisterCommand(command.id);
}

export function unregisterCommand(id: string): void {
  const idx = commandRegistry.findIndex((c) => c.id === id);
  if (idx !== -1) commandRegistry.splice(idx, 1);
}
