import { useEffect, useState } from "react";
import { resolveOutletLogo } from "@/lib/outletLogos";

type OutletLogoIdentity = Parameters<typeof resolveOutletLogo>[0];

const SOURCE_STOPWORDS = new Set([
  "the", "of", "and", "for", "a", "an", "de", "on", "at", "to",
]);

export function sourceInitials(source: string): string {
  const raw = (source || "").trim();
  if (!raw) return "?";
  const tokens = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return raw.slice(0, 2).toUpperCase();
  const acronym = tokens.find((token) => /^[A-Z]{2,5}$/.test(token));
  if (acronym) return acronym;
  const words = tokens.filter((token) => !SOURCE_STOPWORDS.has(token.toLowerCase()));
  const pick = words.length ? words : tokens;
  if (pick.length === 1) return pick[0].slice(0, 2).toUpperCase();
  return (pick[0][0] + pick[1][0]).toUpperCase();
}

interface OutletLogoProps {
  outlet?: OutletLogoIdentity;
  source: string;
  className?: string;
  sizeClass?: string;
  textClass?: string;
  shapeClass?: string;
  fallbackText?: string;
  imageAlt?: string;
}

export default function OutletLogo({
  outlet,
  source,
  className = "",
  sizeClass = "h-8 w-8",
  textClass = "text-[10px]",
  shapeClass = "rounded-md",
  fallbackText,
  imageAlt,
}: OutletLogoProps) {
  const iconUrl = resolveOutletLogo(outlet);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [iconUrl]);

  if (iconUrl && !imageFailed) {
    const fit = outlet?.logoObjectFit === "cover" ? "object-cover" : "object-contain";
    return (
      <img
        src={iconUrl}
        alt={imageAlt ?? source}
        className={`${sizeClass} ${shapeClass} ${fit} shrink-0 shadow-sm shadow-black/40 ${className}`}
        style={{ backgroundColor: outlet?.logoBrandColor ?? "#ffffff" }}
        onError={() => setImageFailed(true)}
        data-testid="img-source-icon"
      />
    );
  }

  return (
    <div
      className={`${sizeClass} ${shapeClass} bg-muted text-muted-foreground flex items-center justify-center ${textClass} font-bold leading-none shrink-0 ${className}`}
      title={source}
      aria-label={`${source} identity image unavailable`}
      role="img"
      data-testid="text-source-initials"
    >
      {fallbackText ?? sourceInitials(source)}
    </div>
  );
}