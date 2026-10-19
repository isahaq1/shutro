/**
 * Primitives: buttons, inputs, badges, cards, keyboard hints, skeletons, avatars, app icons and empty states.
 */
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

/** Joins class names, skipping falsy ones. */
export function cx(...classes: readonly (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------------------------------------ button

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'bg-accent text-accent-ink shadow-xs hover:brightness-110 active:brightness-95 disabled:opacity-50',
  secondary:
    'bg-surface text-ink border border-line shadow-xs hover:bg-sunken hover:border-line-strong disabled:opacity-50',
  ghost: 'text-muted hover:text-ink hover:bg-sunken disabled:opacity-40',
  subtle: 'bg-accent-soft text-accent hover:brightness-105 disabled:opacity-50',
  danger: 'bg-danger text-white shadow-xs hover:brightness-110 disabled:opacity-50',
};
const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-sm',
  md: 'h-8.5 px-3.5 text-sm gap-2 rounded-md',
  lg: 'h-10 px-5 text-sm gap-2 rounded-md',
  icon: 'h-8 w-8 rounded-md justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  readonly loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      className={cx(
        'inline-flex shrink-0 select-none items-center font-medium whitespace-nowrap transition-[background,filter,border-color,color] duration-150 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner size={14} /> : null}
      {children}
    </button>
  );
});

// ------------------------------------------------------------------------------------------------ inputs

const FIELD =
  'w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-faint shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft disabled:bg-sunken disabled:text-muted aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger-soft';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cx(FIELD, 'h-8.5', className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(FIELD, 'min-h-24 py-2 leading-relaxed', className)}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cx(FIELD, 'h-8.5 appearance-none pr-8', className)} {...props}>
        {children}
      </select>
    );
  },
);

/** A labelled form field with help and error text. */
export function FieldRow({
  label,
  htmlFor,
  required,
  help,
  error,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly htmlFor?: string;
  readonly required?: boolean;
  readonly help?: ReactNode;
  readonly error?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx('grid gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-muted">
        {label}
        {required === true ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>
      {children}
      {error !== undefined && error !== null ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : help !== undefined && help !== null ? (
        <p className="text-xs text-faint">{help}</p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ display

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Readonly<Record<Tone, string>> = {
  neutral: 'bg-sunken text-muted ring-line',
  accent: 'bg-accent-soft text-accent ring-accent/20',
  success: 'bg-success-soft text-success ring-success/20',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-danger/20',
  info: 'bg-info-soft text-info ring-info/20',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { readonly tone?: Tone; readonly dot?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex h-5.5 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cx('rounded-lg border border-line bg-surface shadow-card', className)}
      {...props}
    />
  );
}

export function Kbd({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <kbd
      className={cx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-sunken px-1 font-sans text-[11px] font-medium text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({
  size = 16,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx('animate-spin', className)}
      aria-label="Loading"
      role="img"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Skeleton({ className }: { readonly className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        'animate-shimmer rounded bg-[linear-gradient(90deg,var(--sh-sunken)_25%,var(--sh-line)_50%,var(--sh-sunken)_75%)] bg-[length:200%_100%]',
        className,
      )}
    />
  );
}

/** Initials in a colored circle; the color is stable per name. */
export function Avatar({
  name,
  size = 28,
  className,
}: {
  readonly name: string;
  readonly size?: number;
  readonly className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(135deg, oklch(0.62 0.16 ${hash}), oklch(0.52 0.18 ${(hash + 40) % 360}))`,
      }}
      aria-hidden="true"
    >
      {initials || '?'}
    </span>
  );
}

/**
 * An app's SVG icon on its colored tile. The SVG is shown through a data URL in an <img>, never injected as markup, so
 * an icon can never run script.
 */
export function AppIcon({
  svg,
  glyph,
  hue,
  size = 40,
  className,
}: {
  readonly svg?: string | undefined;
  readonly glyph?: string | undefined;
  /** Tile hue (0–360). */
  readonly hue: number;
  readonly size?: number;
  readonly className?: string;
}) {
  const white = svg?.replace('stroke="currentColor"', 'stroke="white"');
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-[28%] shadow-xs',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, oklch(0.68 0.17 ${hue}), oklch(0.52 0.2 ${(hue + 25) % 360}))`,
      }}
    >
      {white !== undefined ? (
        <img
          alt=""
          width={size * 0.55}
          height={size * 0.55}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(white)}`}
        />
      ) : (
        <span style={{ fontSize: size * 0.5 }}>{glyph ?? '•'}</span>
      )}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex animate-fade flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon !== undefined ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
          {icon}
        </div>
      ) : null}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {children !== undefined ? <p className="max-w-sm text-sm text-muted">{children}</p> : null}
      {action}
    </div>
  );
}
