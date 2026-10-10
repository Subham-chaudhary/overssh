// UI flags for the workspace profile overlays (docs/GUIDE.md §15.3.P). Kept apart from the
// store so the store can open them without importing any component.

export const profileUi = $state({
  /** Quick picker ("Profiles: Open…"). */
  pickerOpen: false,
  /** Manage dialog. */
  manageOpen: false,
  /** Save dialog; `saveFor` = profile id to update from the running app, or null for a new profile. */
  saveOpen: false,
  saveFor: null as string | null,
});
