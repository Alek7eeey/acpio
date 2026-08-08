/** Theme-aware ACProcess auth illustration (no baked background). */
export function AuthHero({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 360 360"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id="authHeroPanel" x1="64" y1="72" x2="250" y2="280" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--auth-hero-panel-a)" />
          <stop offset="1" stopColor="var(--auth-hero-panel-b)" />
        </linearGradient>
        <linearGradient id="authHeroAccent" x1="180" y1="40" x2="300" y2="220" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-hover)" />
        </linearGradient>
        <filter id="authHeroSoft" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="var(--auth-hero-shadow)" floodOpacity="1" />
        </filter>
      </defs>

      {/* floating chat panel */}
      <g filter="url(#authHeroSoft)">
        <rect x="52" y="78" width="196" height="168" rx="28" fill="url(#authHeroPanel)" stroke="var(--border)" strokeWidth="1.5" />
        <rect x="74" y="108" width="92" height="18" rx="9" fill="var(--auth-hero-chip)" />
        <rect x="74" y="140" width="148" height="12" rx="6" fill="var(--auth-hero-line)" />
        <rect x="74" y="162" width="128" height="12" rx="6" fill="var(--auth-hero-line)" />
        <rect x="74" y="184" width="108" height="12" rx="6" fill="var(--auth-hero-line)" />
        <rect x="118" y="214" width="106" height="16" rx="8" fill="var(--accent-soft)" />
      </g>

      {/* agent node */}
      <g filter="url(#authHeroSoft)">
        <circle cx="268" cy="126" r="42" fill="url(#authHeroAccent)" />
        <circle cx="268" cy="126" r="18" fill="var(--auth-hero-core)" />
        <path
          d="M248 126h-28M288 126h28M268 106V78M268 146v28"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.55"
        />
        <circle cx="214" cy="126" r="6" fill="var(--accent)" />
        <circle cx="322" cy="126" r="6" fill="var(--accent)" />
        <circle cx="268" cy="72" r="6" fill="var(--accent)" />
        <circle cx="268" cy="180" r="6" fill="var(--accent)" />
      </g>

      {/* lock / access badge */}
      <g filter="url(#authHeroSoft)">
        <rect x="214" y="214" width="88" height="72" rx="20" fill="var(--surface)" stroke="var(--border)" strokeWidth="1.5" />
        <path
          d="M240 238v-10a18 18 0 0 1 36 0v10"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <rect x="236" y="238" width="44" height="34" rx="10" fill="var(--accent)" />
        <circle cx="258" cy="252" r="4" fill="var(--auth-hero-core)" />
        <path d="M258 256v8" stroke="var(--auth-hero-core)" strokeWidth="3" strokeLinecap="round" />
      </g>
    </svg>
  );
}
