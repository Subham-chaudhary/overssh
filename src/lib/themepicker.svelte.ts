// Colour-theme quick picker state (docs/GUIDE.md §14.4.Z). Opened by
// Ctrl+Alt+T (App.svelte) or the "Preferences: Color Theme" palette entry /
// the Settings dialog; rendered by components/ThemePicker.svelte, which also
// does the live preview (and the revert on Esc).

export const themePicker = $state({ open: false });

export function openThemePicker(): void {
  themePicker.open = true;
}

export function closeThemePicker(): void {
  themePicker.open = false;
}
