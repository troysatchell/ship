/**
 * Type surface for `tailwind.config.js` so TypeScript code (notably the contrast
 * regression specs added for TRO-217 / A11Y-3) can import the palette instead of
 * duplicating its hex values. Tailwind itself still loads the `.js` file; this
 * declaration only exists so `tsc --noEmit` can resolve the import.
 */
declare const config: {
  content: string[];
  theme: {
    extend: {
      colors: Record<string, string>;
      [key: string]: unknown;
    };
  };
  plugins: unknown[];
};

export default config;
