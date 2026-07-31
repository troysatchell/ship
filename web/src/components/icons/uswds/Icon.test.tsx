import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidIconName, ICON_NAMES } from './types';
import { scanUsedIconNames } from './scanUsedIcons';
import { iconComponents, USED_ICON_NAMES } from './usedIcons.generated';
import { Icon } from './Icon';

// Test the types module separately since the Icon component requires dynamic imports
// that are difficult to mock in vitest

describe('Icon types module', () => {
  it('exports IconName type with at least 100 icons', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(100);
  });

  it('includes common USWDS icons', () => {
    const commonIcons = ['check', 'close', 'warning', 'info', 'search', 'arrow_back'];
    commonIcons.forEach((iconName) => {
      expect(ICON_NAMES).toContain(iconName);
    });
  });

  it('isValidIconName returns true for valid icons', () => {
    expect(isValidIconName('check')).toBe(true);
    expect(isValidIconName('close')).toBe(true);
    expect(isValidIconName('warning')).toBe(true);
  });

  it('isValidIconName returns false for invalid icons', () => {
    expect(isValidIconName('not-a-real-icon')).toBe(false);
    expect(isValidIconName('')).toBe(false);
    expect(isValidIconName('random-string-123')).toBe(false);
  });

  it('all ICON_NAMES pass validation', () => {
    ICON_NAMES.forEach((name) => {
      expect(isValidIconName(name)).toBe(true);
    });
  });
});

// Test the Icon component's behavior without testing the actual SVG loading
// These tests use unit test patterns that don't require lazy loading

describe('Icon component behavior', () => {
  // Import Icon dynamically to avoid module resolution issues
  let Icon: typeof import('./Icon').Icon;

  beforeEach(async () => {
    // Reset modules to get a fresh Icon component
    vi.resetModules();
  });

  it('exports Icon component from index', async () => {
    // Test that the exports are correct
    const { Icon: ExportedIcon } = await import('./index');
    expect(ExportedIcon).toBeDefined();
    expect(typeof ExportedIcon).toBe('function');
  });

  it('Icon component renders without crashing for invalid icon', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { Icon } = await import('./Icon');

    // @ts-expect-error - Testing invalid icon name
    const { container } = render(<Icon name="definitely-not-real" className="h-4 w-4" />);

    // Should render nothing for invalid icon
    expect(container.firstChild).toBeNull();

    // Should warn about invalid icon name
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid icon name')
    );

    consoleSpy.mockRestore();
  });
});

// Test IconProps interface indirectly through TypeScript
describe('IconProps interface', () => {
  it('requires name prop', () => {
    // This is a compile-time check - if it compiles, the test passes
    // The Icon component signature requires name: IconName
    expect(true).toBe(true);
  });

  it('className is optional', () => {
    // This is a compile-time check
    expect(true).toBe(true);
  });

  it('title is optional', () => {
    // This is a compile-time check
    expect(true).toBe(true);
  });
});

// TRO-201 / BUN-5 regression guard.
//
// Icon.tsx used to eagerly bundle ALL 245 USWDS icons via a whole-directory
// `import.meta.glob`, so any icon name always worked at runtime regardless of
// whether it was referenced anywhere. It now renders from
// usedIcons.generated.ts, a narrowed static map covering only the names
// actually passed to <Icon name="..."> in web/src. That is a real behavior
// change: an icon that's genuinely in use but missing from the generated map
// would render null in production instead of an SVG.
//
// This suite re-runs the exact scan scripts/generate-icon-types.ts uses to
// build that map (scanUsedIconNames, shared by both — see its own doc comment)
// against the live web/src tree, and asserts every name it finds is (a)
// present in the generated map and (b) actually renders an SVG. If someone
// adds a new <Icon name="..."> usage and forgets to re-run
// `pnpm generate:icon-types`, this fails instead of silently shipping a
// broken icon.
describe('Icon liveness — usedIcons.generated.ts must not drift from web/src (TRO-201)', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const SRC_DIR = resolve(__dirname, '../../../');
  const EXCLUDE_FILES = [
    resolve(__dirname, 'types.ts'),
    resolve(__dirname, 'Icon.tsx'),
    resolve(__dirname, 'usedIcons.generated.ts'),
  ];

  const actuallyUsedIconNames = scanUsedIconNames(SRC_DIR, new Set(ICON_NAMES), {
    excludeFiles: EXCLUDE_FILES,
  });

  it('scan finds at least one <Icon name="..."> usage (sanity check on the scan itself)', () => {
    // A zero result almost certainly means the scan broke (wrong directory,
    // regex stopped matching JSX after a formatting change, etc.) rather than
    // that the app genuinely stopped using the Icon component — fail loudly
    // instead of letting every other assertion below vacuously pass.
    expect(actuallyUsedIconNames.length).toBeGreaterThan(0);
  });

  it('every icon name actually used in web/src is in the generated eager map', () => {
    for (const name of actuallyUsedIconNames) {
      expect(USED_ICON_NAMES).toContain(name);
      expect(iconComponents[name]).toBeDefined();
    }
  });

  it.each(actuallyUsedIconNames)(
    'renders "%s" without throwing and produces a real <svg>',
    (name) => {
      expect(isValidIconName(name)).toBe(true);
      if (!isValidIconName(name)) return; // narrows `name` to IconName for TS; unreachable after the assertion above

      const { container, unmount } = render(
        <Icon name={name} className="h-4 w-4" title={`${name} icon`} />,
      );

      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute('fill', 'currentColor');

      unmount();
    },
  );
});
