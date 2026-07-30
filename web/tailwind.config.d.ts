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
      // Named so the known tokens resolve as plain `string` (not
      // `string | undefined`) under `noUncheckedIndexedAccess` — this file
      // both dot-accesses specific tokens (`palette.background`) and looks
      // arbitrary ones up dynamically (`palette[name]`), and the index
      // signature keeps the latter honestly `string | undefined`.
      colors: {
        background: string;
        foreground: string;
        muted: string;
        border: string;
        accent: string;
        'accent-hover': string;
        'accent-text': string;
        [key: string]: string;
      };
      [key: string]: unknown;
    };
  };
  plugins: unknown[];
};

export default config;
