import type { Amenity } from "../api";
import { AMENITY_LABELS, activeFilterCount, type Filters } from "../lib/filters";

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  /** Floors present in the fleet, so we never offer an empty filter. */
  floors: number[];
  capacities: number[];
  matched: number;
  total: number;
}

const DURATIONS = [
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
  { label: "2h", value: 120 },
];

export function FilterBar({ filters, onChange, floors, capacities, matched, total }: Props) {
  const active = activeFilterCount(filters);
  const amenities = Object.keys(AMENITY_LABELS) as Amenity[];

  const toggleAmenity = (a: Amenity) =>
    onChange({
      ...filters,
      amenities: filters.amenities.includes(a)
        ? filters.amenities.filter((x) => x !== a)
        : [...filters.amenities, a],
    });

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <Group label="Seats">
        <Chip
          active={filters.minCapacity === 0}
          onClick={() => onChange({ ...filters, minCapacity: 0 })}
        >
          any
        </Chip>
        {capacities.map((c) => (
          <Chip
            key={c}
            active={filters.minCapacity === c}
            onClick={() => onChange({ ...filters, minCapacity: c })}
            title={`Rooms seating at least ${c}`}
          >
            {c}+
          </Chip>
        ))}
      </Group>

      <Group label="Has">
        {amenities.map((a) => (
          <Chip key={a} active={filters.amenities.includes(a)} onClick={() => toggleAmenity(a)}>
            {AMENITY_LABELS[a]}
          </Chip>
        ))}
      </Group>

      {floors.length > 1 && (
        <Group label="Floor">
          <Chip active={filters.floor === null} onClick={() => onChange({ ...filters, floor: null })}>
            any
          </Chip>
          {floors.map((f) => (
            <Chip
              key={f}
              active={filters.floor === f}
              onClick={() => onChange({ ...filters, floor: f })}
            >
              {f}
            </Chip>
          ))}
        </Group>
      )}

      <Group label="Free for">
        <Chip
          active={filters.minFreeMinutes === 0}
          onClick={() => onChange({ ...filters, minFreeMinutes: 0 })}
        >
          any
        </Chip>
        {DURATIONS.map((d) => (
          <Chip
            key={d.value}
            active={filters.minFreeMinutes === d.value}
            onClick={() => onChange({ ...filters, minFreeMinutes: d.value })}
            title={`Rooms with an unbroken free gap of at least ${d.label}`}
          >
            {d.label}
          </Chip>
        ))}
      </Group>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-slate-500 tabular-nums dark:text-slate-400">
          {matched === total ? `${total} rooms` : `${matched} of ${total} rooms`}
        </span>
        {active > 0 && (
          <button
            type="button"
            onClick={() => onChange({ minCapacity: 0, amenities: [], floor: null, minFreeMinutes: 0 })}
            className="rounded px-1.5 py-0.5 font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-0.5 text-slate-400 dark:text-slate-500">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={
        "rounded-full px-2 py-0.5 font-medium transition-colors " +
        (active
          ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700")
      }
    >
      {children}
    </button>
  );
}
