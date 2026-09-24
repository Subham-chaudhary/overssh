import type { ThemeId } from './themes';
import { THEMES } from './themes';

/**
 * Apply the window/taskbar icon based on the current theme.
 *
 * Renders the OverSSH logo (^_ mark) as an SVG using theme colors (and the
 * optional accent override),
 * converts to bitmap, and applies via Tauri's setIcon API.
 *
 * Note: Only the window + taskbar icon can change at runtime.
 * The Task Manager icon and .exe icon are embedded in the executable
 * and cannot be changed dynamically.
 *
 * No-op outside Tauri. Never throws.
 */
export async function applyWindowIcon(themeId: ThemeId, accent: string | null = null): Promise<void> {
  // Silent no-op if not running in Tauri
  if (!('__TAURI_INTERNALS__' in window)) {
    return;
  }

  try {
    // Import Tauri APIs
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { Image } = await import('@tauri-apps/api/image');

    // Get theme colors from THEMES config
    const theme = THEMES[themeId];

    // Extract colors: use xterm colors for dark themes, monaco colors for light
    // For background, use the darker sidebar color
    let sidebarColor: string;
    let primaryColor: string;
    let successColor: string;

    if (theme.isDark) {
      // For dark themes, find the appropriate sidebar/background color
      // Check xterm background first
      sidebarColor = theme.xterm.background ?? '#21252b';
      primaryColor = theme.xterm.blue ?? theme.xterm.cursor ?? '#61afef';
      successColor = theme.xterm.green ?? '#98c379';
    } else {
      // For light themes, use lighter colors
      // Attempt to get from computed styles as fallback, but mainly use theme colors
      sidebarColor = theme.xterm.background ?? '#ffffff';
      primaryColor = theme.xterm.blue ?? '#0969da';
      successColor = theme.xterm.green ?? '#1a7f37';
    }

    // A custom accent (settings.appearance.accent) replaces the mark colour.
    if (accent) primaryColor = accent;

    // Build SVG string using theme colors
    const iconSize = 256; // Use 256x256 for better quality
    const svgString = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
        <rect x="64" y="64" width="896" height="896" rx="200" fill="${sidebarColor}"/>
        <rect x="64" y="64" width="896" height="896" rx="200" fill="none" stroke="${primaryColor}" stroke-width="40"/>
        <path d="M242 590 L372 410 L502 590" fill="none" stroke="${primaryColor}" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M562 632 H782" stroke="${successColor}" stroke-width="72" stroke-linecap="round"/>
      </svg>
    `;

    // Create canvas and draw SVG
    const canvas = new OffscreenCanvas(iconSize, iconSize);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('Failed to get 2D context from OffscreenCanvas');
      return;
    }

    // Create image from SVG
    // A data: URL, not blob: - the CSP only allows `img-src 'self' data:`.
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    const img = new window.Image();

    // Promise wrapper for image load
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        // Draw SVG onto canvas
        ctx.drawImage(img, 0, 0, iconSize, iconSize);
        resolve();
      };
      img.onerror = () => {
        reject(new Error('Failed to load SVG image'));
      };
      img.src = url;
    });

    // Get RGBA data from canvas
    const imageData = ctx.getImageData(0, 0, iconSize, iconSize);
    // Convert Uint8ClampedArray to Uint8Array for compatibility
    const rgba = new Uint8Array(imageData.data);

    // Create Tauri Image and apply to window
    const tauriImg = await Image.new(rgba, iconSize, iconSize);
    const window_obj = getCurrentWindow();
    await window_obj.setIcon(tauriImg);
  } catch (error) {
    // Silently fail - icon change is non-critical
    console.warn('Failed to apply window icon:', error);
  }
}
