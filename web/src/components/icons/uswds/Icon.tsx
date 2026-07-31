import { type ComponentType, type SVGProps } from 'react';
import { type IconName, isValidIconName } from './types';
import { iconComponents } from './usedIcons.generated';

export interface IconProps {
  /** The name of the USWDS icon to render */
  name: IconName;
  /** CSS class names for styling (use Tailwind classes like "h-4 w-4") */
  className?: string;
  /** Accessible title for the icon. If provided, the icon will be accessible to screen readers. */
  title?: string;
}

type SvgComponent = ComponentType<SVGProps<SVGSVGElement>>;

// `iconComponents` (usedIcons.generated.ts) is a static, eager import map
// covering only the icon names actually passed to `<Icon name="...">`
// somewhere in web/src — narrowed from a whole-directory `import.meta.glob`
// that emitted a lazy chunk for all 245 USWDS icons regardless of use
// (TRO-201 / BUN-5). Referencing a new icon requires re-running
// `pnpm generate:icon-types` — see CHANGES.md's TRO-201 entry.
function getIcon(name: string): SvgComponent | undefined {
  return iconComponents[name];
}

/**
 * USWDS Icon Component
 *
 * Renders icons from the U.S. Web Design System icon library.
 * Icons use `currentColor` for fill, so they inherit the text color of their parent.
 *
 * @example
 * // Basic usage with Tailwind sizing
 * <Icon name="check" className="h-4 w-4" />
 *
 * @example
 * // With accessible title
 * <Icon name="warning" className="h-5 w-5 text-yellow-500" title="Warning" />
 *
 * @example
 * // Inheriting text color
 * <span className="text-blue-600">
 *   <Icon name="info" className="h-4 w-4" />
 * </span>
 */
export function Icon({
  name,
  className,
  title,
}: IconProps): JSX.Element | null {
  // Validate icon name at runtime
  if (!isValidIconName(name)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `Icon: Invalid icon name "${name}". Check available icons in types.ts.`,
      );
    }

    return null;
  }

  const SvgIcon = getIcon(name);

  // Handle case where the name is a valid USWDS icon but isn't in the eager
  // map yet — a new <Icon name="..."> call that hasn't had
  // `pnpm generate:icon-types` run since it was added. See CHANGES.md's
  // TRO-201 entry.
  if (!SvgIcon) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `Icon: "${name}" is a valid USWDS icon but is not eagerly loaded. ` +
          `Run "pnpm --filter @ship/web generate:icon-types" after adding a new <Icon name="${name}"> usage.`,
      );
    }

    return null;
  }

  // Accessibility attributes following USWDS patterns
  // Note: SVGR-generated components don't forward children, so we use
  // aria-label instead of aria-labelledby + <title> child element.
  const accessibilityProps = title
    ? {
        role: 'img' as const,
        'aria-label': title,
      }
    : {
        'aria-hidden': true as const,
        focusable: false as const,
        role: 'img' as const,
      };

  return (
    <SvgIcon
      className={className}
      fill="currentColor"
      {...accessibilityProps}
    />
  );
}

export default Icon;
