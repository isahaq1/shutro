/**
 * Field widgets by kind: a display for lists and cards, an editor for forms. Values stay as the API sends them
 * (decimals and money as exact strings).
 */
import { Badge, Combobox, cx, Input, Select, Switch, Textarea } from '@shutro/ui';
import { useCallback } from 'react';
import { api, type FieldMeta, type Ref } from '../api.js';
import { display, isMoney, numeric, stateTone } from '../format.js';
import { useMeta } from '../session.js';

/** Read-only rendering (lists, cards, read-only form fields). */
export function FieldValue({
  value,
  field,
}: {
  readonly value: unknown;
  readonly field: FieldMeta | undefined;
}) {
  const { user } = useMeta();
  if (value === null || value === undefined || value === '')
    return <span className="text-faint">—</span>;
  if (field?.kind === 'state' || field?.kind === 'selection') {
    const text = display(value, field, user.lang, user.tz);
    return field.kind === 'state' ? (
      <Badge tone={stateTone(String(value))} dot>
        {text}
      </Badge>
    ) : (
      <span>{text}</span>
    );
  }
  if (field?.kind === 'boolean')
    return value === true ? (
      <Badge tone="success">Yes</Badge>
    ) : (
      <span className="text-faint">No</span>
    );
  return (
    <span className={cx(numeric(field) && 'tabular', isMoney(value) && 'font-medium')}>
      {display(value, field, user.lang, user.tz)}
    </span>
  );
}

/** The editor of one field. `onChange` receives the API value (`{ id, name }` for many2one). */
export function FieldInput({
  name,
  field,
  value,
  onChange,
  invalid,
  disabled,
}: {
  readonly name: string;
  readonly field: FieldMeta;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly invalid: boolean;
  readonly disabled: boolean;
}) {
  const id = `field-${name}`;
  const target = field.target;
  const search = useCallback(
    (text: string) => (target === undefined ? Promise.resolve([]) : api.names(target, text)),
    [target],
  );
  const common = { id, 'aria-invalid': invalid, disabled };
  switch (field.kind) {
    case 'many2one':
      return (
        <Combobox
          id={id}
          value={(value as Ref | null) ?? null}
          onChange={onChange}
          search={search}
          invalid={invalid}
          disabled={disabled}
          placeholder={`Select ${field.label.toLowerCase()}…`}
        />
      );
    case 'boolean':
      return (
        <div className="flex h-8.5 items-center">
          <Switch
            id={id}
            checked={value === true}
            onCheckedChange={onChange}
            disabled={disabled}
            label={field.label}
          />
        </div>
      );
    case 'selection':
    case 'state':
      return (
        <Select
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          {field.required ? null : <option value="">—</option>}
          {(field.selection ?? []).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
      );
    case 'text':
    case 'html':
      return (
        <Textarea
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return (
        <Input
          {...common}
          type="date"
          value={typeof value === 'string' ? value.slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      );
    case 'datetime':
      return (
        <Input
          {...common}
          type="datetime-local"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          onChange={(e) =>
            onChange(e.target.value === '' ? null : new Date(e.target.value).toISOString())
          }
        />
      );
    case 'integer':
      return (
        <Input
          {...common}
          inputMode="numeric"
          className="tabular text-right"
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) =>
            onChange(e.target.value === '' ? null : Number.parseInt(e.target.value, 10))
          }
        />
      );
    case 'decimal':
    case 'quantity':
    case 'monetary': {
      const text = isMoney(value)
        ? value.amount
        : value === null || value === undefined
          ? ''
          : String(value);
      return (
        <div className="relative">
          <Input
            {...common}
            inputMode="decimal"
            className={cx('tabular text-right', isMoney(value) && 'pr-12')}
            value={text}
            // Decimal strings: never parsed into a JavaScript number.
            onChange={(e) => onChange(e.target.value.replace(/[^\d.-]/g, '') || null)}
          />
          {isMoney(value) ? (
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-faint">
              {value.currency}
            </span>
          ) : null}
        </div>
      );
    }
    default:
      return (
        <Input
          {...common}
          maxLength={field.size}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** API value → what create / write expect. */
export function toInput(field: FieldMeta | undefined, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (field?.kind === 'many2one') return value === null ? null : (value as Ref).id;
  if (isMoney(value)) return value.amount;
  return value;
}
