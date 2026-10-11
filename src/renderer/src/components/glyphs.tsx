import type { ProviderId } from '../../../shared/types.ts'

// Small original marks, one per provider, drawn to read at 14–18px. They are stand-ins that tell
// the four apart at a glance, not the vendors' logos.

const RAYS = Array.from({ length: 8 }, (_, index) => index * 45)

export function ProviderGlyph({ provider, size = 16 }: { provider: ProviderId; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (provider) {
    case 'claude':
      return (
        <svg {...common}>
          {RAYS.map((angle) => (
            <line key={angle} x1="12" y1="3" x2="12" y2="8.5" transform={`rotate(${angle} 12 12)`} />
          ))}
        </svg>
      )
    case 'codex':
      return (
        <svg {...common}>
          <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
          <path d="M9.5 10l-2 2 2 2M14.5 10l2 2-2 2" />
        </svg>
      )
    case 'cursor':
      return (
        <svg {...common}>
          <path d="M5 4l14 7.2-6.1 1.7L11.2 19z" />
        </svg>
      )
    case 'antigravity':
      return (
        <svg {...common}>
          <path d="M4.5 19.5C7 9 9.5 4.5 12 4.5s5 4.500 7.5 15" />
          <path d="M8.5 14.5h7" />
        </svg>
      )
  }
}
