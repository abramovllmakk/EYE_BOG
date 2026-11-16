import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
  className: `size-[18px] shrink-0 ${p.className ?? ''}`,
});

/** Brand mark: an eye whose iris is a small schema graph. */
export function EyeMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none">
      <path
        d="M2.5 16C6.4 9.4 10.9 6.5 16 6.5S25.6 9.4 29.5 16c-3.9 6.6-8.4 9.5-13.5 9.5S6.4 22.6 2.5 16Z"
        stroke="var(--ink)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="6.6" stroke="var(--covered)" strokeWidth="1.8" />
      <path
        d="M13.2 14.4 18.6 13.4M13.2 14.4 15.8 18.8M18.6 13.4 15.8 18.8"
        stroke="var(--covered)"
        strokeWidth="1.2"
      />
      <circle cx="13.2" cy="14.4" r="1.5" fill="var(--covered)" />
      <circle cx="18.6" cy="13.4" r="1.5" fill="var(--partial)" />
      <circle cx="15.8" cy="18.8" r="1.5" fill="var(--uncovered)" />
    </svg>
  );
}

export const Icon = {
  runs: (p: P) => (
    <svg {...base(p)}>
      <path d="M3 5h14M3 10h14M3 15h9" />
      <circle cx="15.5" cy="15" r="1.5" />
    </svg>
  ),
  map: (p: P) => (
    <svg {...base(p)}>
      <rect x="2.5" y="3" width="5" height="4" rx="1" />
      <rect x="12.5" y="3" width="5" height="4" rx="1" />
      <rect x="7.5" y="13" width="5" height="4" rx="1" />
      <path d="M7.5 5h5M5 7v3.5c0 1 .8 1.5 1.5 1.5H10v1M15 7v3.5c0 1-.8 1.5-1.5 1.5H10" />
    </svg>
  ),
  table: (p: P) => (
    <svg {...base(p)}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
      <path d="M2.5 8h15M2.5 12.25h15M7.5 8v8.5" />
    </svg>
  ),
  plan: (p: P) => (
    <svg {...base(p)}>
      <path d="M3 16.5h14" />
      <path d="M4 14l3.5-3.5 3 2.5L16 6.5" />
      <path d="M12.5 6.5H16V10" />
    </svg>
  ),
  tests: (p: P) => (
    <svg {...base(p)}>
      <path d="M4 5.5l1.5 1.5L8 4.5M4 11.5l1.5 1.5L8 10.5" />
      <path d="M10.5 6h6M10.5 12h6M4.5 16.5h12" />
    </svg>
  ),
  heat: (p: P) => (
    <svg {...base(p)}>
      <rect
        x="3"
        y="3"
        width="4"
        height="4"
        rx=".8"
        fill="currentColor"
        stroke="none"
        opacity=".9"
      />
      <rect
        x="8"
        y="3"
        width="4"
        height="4"
        rx=".8"
        fill="currentColor"
        stroke="none"
        opacity=".45"
      />
      <rect x="13" y="3" width="4" height="4" rx=".8" />
      <rect
        x="3"
        y="8"
        width="4"
        height="4"
        rx=".8"
        fill="currentColor"
        stroke="none"
        opacity=".45"
      />
      <rect x="8" y="8" width="4" height="4" rx=".8" />
      <rect
        x="13"
        y="8"
        width="4"
        height="4"
        rx=".8"
        fill="currentColor"
        stroke="none"
        opacity=".9"
      />
      <rect x="3" y="13" width="4" height="4" rx=".8" />
      <rect
        x="8"
        y="13"
        width="4"
        height="4"
        rx=".8"
        fill="currentColor"
        stroke="none"
        opacity=".9"
      />
      <rect
        x="13"
        y="13"
        width="4"
        height="4"
        rx=".8"
        fill="currentColor"
        stroke="none"
        opacity=".45"
      />
    </svg>
  ),
  requests: (p: P) => (
    <svg {...base(p)}>
      <path d="M7 5.5 3 10l4 4.5M13 5.5l4 4.5-4 4.5M11.2 4 8.8 16" />
    </svg>
  ),
  compare: (p: P) => (
    <svg {...base(p)}>
      <path d="M6 3v14M14 3v14M3 7l3-3 3 3M11 13l3 3 3-3" />
    </svg>
  ),
  timeline: (p: P) => (
    <svg {...base(p)}>
      <path d="M2.5 15.5 7 10l3.5 3L17.5 5" />
      <circle cx="7" cy="10" r="1" fill="currentColor" />
      <circle cx="10.5" cy="13" r="1" fill="currentColor" />
    </svg>
  ),
  teams: (p: P) => (
    <svg {...base(p)}>
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="14" cy="8" r="2" />
      <path d="M2.5 16c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4M12 12.4c.6-.3 1.3-.4 2-.4 1.8 0 3 1.1 3.5 3.5" />
    </svg>
  ),
  sun: (p: P) => (
    <svg {...base(p)}>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7 6 6M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" />
    </svg>
  ),
  moon: (p: P) => (
    <svg {...base(p)}>
      <path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2Z" />
    </svg>
  ),
  docs: (p: P) => (
    <svg {...base(p)}>
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
    </svg>
  ),
  plug: (p: P) => (
    <svg {...base(p)}>
      <path d="M7 2.5v4M13 2.5v4M5 6.5h10v3a5 5 0 0 1-10 0z" />
      <path d="M10 14.5v3" />
    </svg>
  ),
  search: (p: P) => (
    <svg {...base(p)}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.2 13.2 3.8 3.8" />
    </svg>
  ),
  menu: (p: P) => (
    <svg {...base(p)}>
      <path d="M3 6h14M3 10h14M3 14h14" />
    </svg>
  ),
  close: (p: P) => (
    <svg {...base(p)}>
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  ),
};
