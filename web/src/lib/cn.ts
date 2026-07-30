import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Returns a contrast-safe text color (black or white) for a given background color.
 * Uses WCAG relative luminance formula to ensure 4.5:1 contrast ratio.
 */
export function getContrastTextColor(hexColor: string): string {
  // Parse hex color (supports #rgb, #rrggbb, rgb(), and named colors)
  let r: number, g: number, b: number;

  if (hexColor.startsWith('#')) {
    const hex = hexColor.slice(1);
    if (hex.length === 3) {
      const r0 = hex[0];
      const g0 = hex[1];
      const b0 = hex[2];
      if (r0 === undefined || g0 === undefined || b0 === undefined) {
        return '#000000';
      }
      r = parseInt(r0 + r0, 16);
      g = parseInt(g0 + g0, 16);
      b = parseInt(b0 + b0, 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else if (hexColor.startsWith('rgb')) {
    const match = hexColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    const [, rStr, gStr, bStr] = match ?? [];
    if (rStr === undefined || gStr === undefined || bStr === undefined) {
      return '#000000'; // Default to black for unparseable colors
    }
    r = parseInt(rStr, 10);
    g = parseInt(gStr, 10);
    b = parseInt(bStr, 10);
  } else {
    return '#000000'; // Default to black for named colors
  }

  // Calculate relative luminance (WCAG formula)
  const linearize = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);

  // Use black text on light backgrounds, white on dark
  // Threshold ~0.179 ensures 4.5:1 contrast ratio for WCAG AA
  return luminance > 0.179 ? '#000000' : '#ffffff';
}
