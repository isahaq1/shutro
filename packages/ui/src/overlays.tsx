/**
 * Overlays and interactive components on Radix primitives (focus traps, keyboard support, ARIA): dialog, popover,
 * menu, tooltip, tabs, switch, toasts, the command palette, the searchable combobox and the workflow status bar.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import * as RadixPopover from '@radix-ui/react-popover';
import * as RadixSwitch from '@radix-ui/react-switch';
import * as RadixTabs from '@radix-ui/react-tabs';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { Command } from 'cmdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AlertIcon, CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from './icons.js';
import { cx, Kbd, Spinner } from './primitives.js';

const POP = 'z-50 animate-in rounded-lg border border-line bg-raised shadow-pop';

// ------------------------------------------------------------------------------------------------ dialog

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly wide?: boolean;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade bg-black/40 backdrop-blur-[2px]" />
        <RadixDialog.Content
          className={cx(
            POP,
            'fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col',
            wide ? 'max-w-3xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <RadixDialog.Title className="text-base font-semibold text-ink">
                {title}
              </RadixDialog.Title>
              {description !== undefined ? (
                <RadixDialog.Description className="mt-1 text-sm text-muted">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close
              className="rounded-md p-1 text-faint hover:bg-sunken hover:text-ink"
              aria-label="Close"
            >
              <XIcon />
            </RadixDialog.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer !== undefined ? (
            <div className="flex justify-end gap-2 border-t border-line bg-sunken/50 px-5 py-3">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ------------------------------------------------------------------------------------------------ popover, menu, tooltip

export function Popover({
  trigger,
  children,
  align = 'start',
  open,
  onOpenChange,
  className,
}: {
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly align?: 'start' | 'center' | 'end';
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
}) {
  return (
    <RadixPopover.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align={align} sideOffset={6} className={cx(POP, 'p-2', className)}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export interface MenuItem {
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly shortcut?: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

export function Menu({
  trigger,
  items,
  label,
  align = 'end',
}: {
  readonly trigger: ReactNode;
  readonly items: readonly (MenuItem | 'separator')[];
  readonly label?: ReactNode;
  readonly align?: 'start' | 'end';
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content align={align} sideOffset={6} className={cx(POP, 'min-w-52 p-1')}>
          {label !== undefined ? (
            <RadixMenu.Label className="px-2.5 py-1.5 text-xs font-medium text-faint">
              {label}
            </RadixMenu.Label>
          ) : null}
          {items.map((item, i) =>
            item === 'separator' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
              <RadixMenu.Separator key={`sep-${i}`} className="my-1 h-px bg-line" />
            ) : (
              <RadixMenu.Item
                // biome-ignore lint/suspicious/noArrayIndexKey: menu items are static per render
                key={i}
                onSelect={item.onSelect}
                className={cx(
                  'flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-sunken',
                  item.danger === true ? 'text-danger' : 'text-ink',
                )}
              >
                <span className="text-muted">{item.icon}</span>
                <span className="flex-1">{item.label}</span>
                {item.shortcut !== undefined ? <Kbd>{item.shortcut}</Kbd> : null}
              </RadixMenu.Item>
            ),
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export function Tooltip({
  content,
  children,
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <RadixTooltip.Provider delayDuration={350}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            sideOffset={6}
            className="z-50 animate-fade rounded-md bg-ink px-2 py-1 text-xs font-medium text-canvas shadow-pop"
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

// ------------------------------------------------------------------------------------------------ tabs, switch

export function Tabs({
  tabs,
  defaultValue,
  value,
  onValueChange,
}: {
  readonly tabs: readonly {
    readonly value: string;
    readonly label: ReactNode;
    readonly content: ReactNode;
  }[];
  readonly defaultValue?: string;
  /** Controlled mode: the open tab. */
  readonly value?: string;
  readonly onValueChange?: (value: string) => void;
}) {
  return (
    <RadixTabs.Root
      {...(value === undefined ? { defaultValue: defaultValue ?? tabs[0]?.value } : { value })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
    >
      <RadixTabs.List className="flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <RadixTabs.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink"
          >
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((t) => (
        <RadixTabs.Content key={t.value} value={t.value} className="pt-4 outline-none">
          {t.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  label,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly label?: string;
}) {
  return (
    <RadixSwitch.Root
      {...(id === undefined ? {} : { id })}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled === true}
      aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors duration-150 data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <RadixSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-xs transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  );
}

// ------------------------------------------------------------------------------------------------ toasts

export interface Toast {
  readonly id: number;
  readonly tone: 'success' | 'danger' | 'info';
  readonly title: ReactNode;
  readonly description?: ReactNode;
}

const ToastContext = createContext<(toast: Omit<Toast, 'id'>) => void>(() => {});

/** `const toast = useToast(); toast({ tone: 'success', title: 'Saved' })`. */
export function useToast(): (toast: Omit<Toast, 'id'>) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = next.current++;
    setToasts((all) => [...all.slice(-3), { ...toast, id }]);
    setTimeout(
      () => setToasts((all) => all.filter((t) => t.id !== id)),
      toast.tone === 'danger' ? 7000 : 3500,
    );
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div key={t.id} role="status" className={cx(POP, 'pointer-events-auto flex gap-3 p-3.5')}>
            <span
              className={cx(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                t.tone === 'success' && 'bg-success-soft text-success',
                t.tone === 'danger' && 'bg-danger-soft text-danger',
                t.tone === 'info' && 'bg-info-soft text-info',
              )}
            >
              {t.tone === 'danger' ? <AlertIcon size={12} /> : <CheckIcon size={12} />}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{t.title}</p>
              {t.description !== undefined ? (
                <p className="mt-0.5 text-[13px] text-muted">{t.description}</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ------------------------------------------------------------------------------------------------ command palette

export interface CommandItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
  readonly run: () => void;
}

/**
 * Every typed word must appear in the item (no scattered-letter matches: "acme" never finds "Account Payment
 * Term"); a word that starts a word of the label ranks first.
 */
export function paletteFilter(value: string, search: string): number {
  const text = value.toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  if (!words.every((w) => text.includes(w))) return 0;
  return words.every((w) =>
    new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text),
  )
    ? 1
    : 0.5;
}

/** ⌘K / Ctrl+K: go anywhere, run anything. `onSearch` adds async results (records) for the typed text. */
export function CommandPalette({
  items,
  open,
  onOpenChange,
  onSearch,
}: {
  readonly items: readonly CommandItem[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSearch?: (text: string) => Promise<readonly CommandItem[]>;
}) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<readonly CommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) setText('');
  }, [open]);
  useEffect(() => {
    if (onSearch === undefined || text.trim().length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      onSearch(text.trim())
        .then((r) => live && setFound(r))
        .finally(() => live && setLoading(false));
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, onSearch]);
  const groups = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of [...found, ...items])
      map.set(item.group, [...(map.get(item.group) ?? []), item]);
    return [...map];
  }, [items, found]);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade bg-black/30 backdrop-blur-[2px]" />
        <RadixDialog.Content
          className={cx(
            POP,
            'fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden',
          )}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <Command label="Command palette" loop filter={paletteFilter}>
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <SearchIcon className="text-faint" />
              <Command.Input
                value={text}
                onValueChange={setText}
                placeholder="Search apps, records and actions…"
                className="h-12 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
              />
              {loading ? <Spinner size={14} className="text-faint" /> : <Kbd>Esc</Kbd>}
            </div>
            <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-4 py-8 text-center text-sm text-muted">
                Nothing matches.
              </Command.Empty>
              {groups.map(([group, list]) => (
                <Command.Group
                  key={group}
                  heading={group}
                  className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
                >
                  {list.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={`${item.label} ${item.hint ?? ''} ${(item.keywords ?? []).join(' ')} ${item.id}`}
                      onSelect={() => {
                        onOpenChange(false);
                        item.run();
                      }}
                      className="flex cursor-default items-center gap-3 rounded-md px-2.5 py-2 text-sm text-ink data-[selected=true]:bg-accent-soft"
                    >
                      <span className="flex h-6 w-6 items-center justify-center text-muted">
                        {item.icon}
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.hint !== undefined ? (
                        <span className="truncate text-xs text-faint">{item.hint}</span>
                      ) : null}
                      {item.shortcut !== undefined ? <Kbd>{item.shortcut}</Kbd> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ------------------------------------------------------------------------------------------------ combobox

export interface Option {
  readonly id: number;
  readonly name: string;
}

/** A searchable picker (many2one): type to search, ↑/↓ and Enter to pick. */
export function Combobox({
  value,
  onChange,
  search,
  placeholder = 'Select…',
  disabled = false,
  invalid = false,
  id,
}: {
  readonly value: Option | null;
  readonly onChange: (value: Option | null) => void;
  readonly search: (text: string) => Promise<readonly Option[]>;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [options, setOptions] = useState<readonly Option[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      search(text)
        .then((r) => live && setOptions(r))
        .finally(() => live && setLoading(false));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, text, search]);
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild disabled={disabled}>
        <button
          {...(id === undefined ? {} : { id })}
          type="button"
          aria-invalid={invalid}
          className={cx(
            'flex h-8.5 w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 text-left text-sm shadow-xs transition-[border-color] duration-150 hover:border-line-strong focus:border-accent focus:outline-none disabled:bg-sunken disabled:text-muted aria-[invalid=true]:border-danger',
          )}
        >
          <span className={cx('truncate', value === null && 'text-faint')}>
            {value?.name ?? placeholder}
          </span>
          <ChevronDownIcon className="shrink-0 text-faint" />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align="start"
          sideOffset={4}
          className={cx(POP, 'w-[var(--radix-popover-trigger-width)] min-w-56 overflow-hidden p-0')}
        >
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <SearchIcon size={14} className="text-faint" />
              <Command.Input
                value={text}
                onValueChange={setText}
                placeholder="Search…"
                className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
              />
              {loading ? <Spinner size={12} className="text-faint" /> : null}
            </div>
            <Command.List className="max-h-64 overflow-y-auto p-1">
              {!loading && options.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-muted">No match.</div>
              ) : null}
              {value !== null ? (
                <Command.Item
                  value="__clear__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted data-[selected=true]:bg-sunken"
                >
                  <XIcon size={14} /> Clear
                </Command.Item>
              ) : null}
              {options.map((o) => (
                <Command.Item
                  key={o.id}
                  value={String(o.id)}
                  onSelect={() => {
                    onChange(o);
                    setOpen(false);
                  }}
                  className="flex cursor-default items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink data-[selected=true]:bg-accent-soft"
                >
                  <span className="truncate">{o.name}</span>
                  {value?.id === o.id ? <CheckIcon size={14} className="text-accent" /> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

// ------------------------------------------------------------------------------------------------ status bar

/** The workflow's states as chevrons, the current one highlighted (form headers). */
export function Statusbar({
  states,
  current,
}: {
  readonly states: readonly (readonly [string, string])[];
  readonly current: string | null;
}) {
  return (
    <ol
      className="flex overflow-hidden rounded-md border border-line text-xs font-medium"
      aria-label="Status"
    >
      {states.map(([key, label], i) => {
        const active = key === current;
        return (
          <li
            key={key}
            aria-current={active ? 'step' : undefined}
            className={cx(
              'relative flex items-center px-3 py-1.5 whitespace-nowrap',
              i > 0 && 'border-l border-line',
              active ? 'bg-accent text-accent-ink' : 'bg-surface text-muted',
            )}
          >
            {label}
          </li>
        );
      })}
    </ol>
  );
}
