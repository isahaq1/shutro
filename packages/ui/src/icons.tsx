/**
 * Line icons (24×24, 1.75 stroke, `currentColor`): the few the business screens need, inline so there is no icon
 * dependency.
 */
import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

const make = (body: readonly string[], name: string) => {
  const Icon = ({ size = 16, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {body.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
};

export const SearchIcon = make(
  ['M21 21l-4.3-4.3', 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z'],
  'SearchIcon',
);
export const PlusIcon = make(['M12 5v14', 'M5 12h14'], 'PlusIcon');
export const CheckIcon = make(['M20 6 9 17l-5-5'], 'CheckIcon');
export const XIcon = make(['M18 6 6 18', 'M6 6l12 12'], 'XIcon');
export const ChevronDownIcon = make(['m6 9 6 6 6-6'], 'ChevronDownIcon');
export const ChevronRightIcon = make(['m9 18 6-6-6-6'], 'ChevronRightIcon');
export const ChevronLeftIcon = make(['m15 18-6-6 6-6'], 'ChevronLeftIcon');
export const ArrowUpIcon = make(['m5 12 7-7 7 7', 'M12 19V5'], 'ArrowUpIcon');
export const ArrowDownIcon = make(['M12 5v14', 'm19 12-7 7-7-7'], 'ArrowDownIcon');
export const ListIcon = make(
  ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  'ListIcon',
);
export const KanbanIcon = make(['M6 5v11', 'M12 5v6', 'M18 5v14'], 'KanbanIcon');
export const GridIcon = make(
  ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M14 14h7v7h-7z', 'M3 14h7v7H3z'],
  'GridIcon',
);
export const SunIcon = make(
  [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M12 2v2',
    'M12 20v2',
    'm4.9 4.9 1.4 1.4',
    'm17.7 17.7 1.4 1.4',
    'M2 12h2',
    'M20 12h2',
    'm6.3 17.7-1.4 1.4',
    'm19.1 4.9-1.4 1.4',
  ],
  'SunIcon',
);
export const MoonIcon = make(['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'], 'MoonIcon');
export const MonitorIcon = make(['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'], 'MonitorIcon');
export const LogOutIcon = make(
  ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  'LogOutIcon',
);
export const BuildingIcon = make(
  [
    'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18',
    'M6 12H4a2 2 0 0 0-2 2v8h20v-8a2 2 0 0 0-2-2h-2',
    'M10 6h4',
    'M10 10h4',
    'M10 14h4',
    'M10 18h4',
  ],
  'BuildingIcon',
);
export const HistoryIcon = make(
  ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  'HistoryIcon',
);
export const TrashIcon = make(['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'], 'TrashIcon');
export const FilterIcon = make(['M22 3H2l8 9.5V19l4 2v-8.5z'], 'FilterIcon');
export const ColumnsIcon = make(['M3 3h18v18H3z', 'M9 3v18', 'M15 3v18'], 'ColumnsIcon');
export const SaveIcon = make(
  ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', 'M17 21v-8H7v8', 'M7 3v5h8'],
  'SaveIcon',
);
export const StoreIcon = make(
  ['M3 9l1.5-5h15L21 9', 'M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z', 'M5 12v8h14v-8'],
  'StoreIcon',
);
export const SparkIcon = make(
  [
    'M12 3v4',
    'M12 17v4',
    'M3 12h4',
    'M17 12h4',
    'm5.6 5.6 2.8 2.8',
    'm15.6 15.6 2.8 2.8',
    'm5.6 18.4 2.8-2.8',
    'm15.6 8.4 2.8-2.8',
  ],
  'SparkIcon',
);
export const CommandIcon = make(
  ['M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z'],
  'CommandIcon',
);
export const AlertIcon = make(
  [
    'M12 9v4',
    'M12 17h.01',
    'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  ],
  'AlertIcon',
);
export const MoreIcon = make(['M12 12h.01', 'M19 12h.01', 'M5 12h.01'], 'MoreIcon');
export const LockIcon = make(['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'], 'LockIcon');
