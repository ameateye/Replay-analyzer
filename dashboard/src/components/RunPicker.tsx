import { useEffect, useRef, useState } from 'react';
import { runMetas, type RunMeta } from '../data';

// Run names encode the run time, e.g. "DS-2_01_47" → 2:01:47. Parse the
// trailing H_MM_SS into total seconds so the picker can list runs in
// leaderboard order (fastest first). Names that don't match sort last.
function runTimeSeconds(name: string): number {
  const m = name.match(/(\d+)_(\d+)_(\d+)\s*$/);
  if (!m) return Number.POSITIVE_INFINITY;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Sorted once at module load — the manifest is static for the session.
const sortedMetas: RunMeta[] = [...runMetas].sort(
  (a, b) => runTimeSeconds(a.name) - runTimeSeconds(b.name),
);

type Props = {
  value: string;
  onChange: (name: string) => void;
};

// Compact dropdown replacement for the old horizontal tab strip, which
// overflowed the header past ~8 runs. Scales to any number of runs while
// keeping the Factorio-styled chrome.
export function RunPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (runMetas.length <= 1) return null;

  return (
    <div className={open ? 'run-picker run-picker--open' : 'run-picker'} ref={ref}>
      <button
        type="button"
        className="run-picker__toggle"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select run"
        onClick={() => setOpen(o => !o)}
      >
        <span className="run-picker__current">{value}</span>
        <span className="run-picker__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="run-picker__menu" role="listbox" aria-label="Select run">
          {sortedMetas.map(m => {
            const active = m.name === value;
            return (
              <li key={m.name} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={active ? 'run-picker__option run-picker__option--active' : 'run-picker__option'}
                  onClick={() => {
                    onChange(m.name);
                    setOpen(false);
                  }}
                >
                  <span className="run-picker__check" aria-hidden="true">
                    {active ? '✓' : ''}
                  </span>
                  {m.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
