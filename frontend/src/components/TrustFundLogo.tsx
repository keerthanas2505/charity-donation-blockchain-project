interface TrustFundLogoProps {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  className?: string;
}

export function TrustFundLogo({
  size = "md",
  showWordmark = true,
  className = "",
}: TrustFundLogoProps) {
  const pixelSizes = {
    sm: 24,
    md: 32,
    lg: 40,
  };

  const px = pixelSizes[size];

  return (
    <div className={`trustfund-logo-container ${className}`} style={{ display: "inline-flex", alignItems: "center", gap: size === "sm" ? "8px" : "12px", cursor: "pointer" }}>
      <svg
        width={px}
        height={px}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="trustfund-brand-mark"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`tf-grad-${size}`} x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#10b981" />
            <stop offset="50%" stopColor="#0d9488" />
            <stop offset="100%" stopColor="#0284c7" />
          </linearGradient>
          <linearGradient id={`tf-glow-${size}`} x1="16" y1="12" x2="32" y2="36" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        {/* Outer Shield / Hexagonal Vault */}
        <path
          d="M24 4L39 10.5V23C39 32.5 32.6 41.2 24 44C15.4 41.2 9 32.5 9 23V10.5L24 4Z"
          stroke={`url(#tf-grad-${size})`}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="brand-shield-bg"
        />
        {/* Inner Interlocking Architectural Node */}
        <path
          d="M24 14L32 19V29L24 34L16 29V19L24 14Z"
          stroke={`url(#tf-grad-${size})`}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={`url(#tf-glow-${size})`}
        />
        {/* Central Impact Core */}
        <circle cx="24" cy="24" r="3.5" fill="#10b981" />
        <path
          d="M24 14V20.5M24 27.5V34M16 19L21 22M27 26L32 29M32 19L27 22M21 26L16 29"
          stroke={`url(#tf-grad-${size})`}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>

      {showWordmark && (
        <div className="trustfund-wordmark" style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span
            style={{
              fontSize: size === "sm" ? "1.1rem" : size === "md" ? "1.35rem" : "1.65rem",
              fontWeight: 700,
              letterSpacing: "-0.025em",
              color: "var(--color-text)",
              fontFamily: "var(--font-sans)",
            }}
          >
            Trust<span style={{ color: "var(--color-primary)" }}>Fund</span>
          </span>
          {size !== "sm" && (
            <span
              style={{
                fontSize: "0.65rem",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--color-text-dim)",
                fontWeight: 600,
              }}
            >
              Protocol
            </span>
          )}
        </div>
      )}
    </div>
  );
}
