import type { ITheme } from "@xterm/xterm";

/**
 * Build the xterm theme from the AgentCloud semantic color tokens at runtime
 * (DESIGN.md: no raw colors in components). Custom properties are resolved via
 * computed style, then normalized through a 1px canvas so xterm receives plain
 * rgb/rgba strings even for color-mix() tokens.
 */
function normalizer(): (value: string) => string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !context) return undefined;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = trimmed;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };
}

export function terminalThemeFromTokens(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const toColor = normalizer();
  const token = (name: string) => toColor(styles.getPropertyValue(name));
  return {
    background: token("--color-bg"),
    foreground: token("--color-text"),
    cursor: token("--color-accent"),
    cursorAccent: token("--color-bg"),
    selectionBackground: token("--color-accent-soft"),
    black: token("--color-surface-raised"),
    red: token("--color-danger"),
    green: token("--color-success"),
    yellow: token("--color-warning"),
    blue: token("--color-accent"),
    magenta: token("--color-pink"),
    cyan: token("--color-accent"),
    white: token("--color-secondary"),
    brightBlack: token("--color-muted"),
    brightRed: token("--color-danger"),
    brightGreen: token("--color-success"),
    brightYellow: token("--color-warning"),
    brightBlue: token("--color-accent-hover"),
    brightMagenta: token("--color-pink"),
    brightCyan: token("--color-accent-hover"),
    brightWhite: token("--color-text"),
  };
}

/** Font family and pixel size from the terminal surface's computed style. */
export function terminalFontFrom(element: HTMLElement): {
  fontFamily: string;
  fontSize: number;
} {
  const styles = getComputedStyle(element);
  const size = Number.parseFloat(styles.fontSize);
  return {
    fontFamily: styles.fontFamily,
    fontSize: Number.isFinite(size) && size > 0 ? size : 12,
  };
}

/** Strip Electron's "Error invoking remote method …: Error:" wrapper. */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "").trim();
  return cleaned || fallback;
}
