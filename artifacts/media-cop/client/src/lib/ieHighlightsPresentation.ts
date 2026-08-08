const IE_AREA_LABELS: Record<string, string> = {
  WHEM: "Western Hemisphere",
  CENTCOM: "Middle East",
  PACOM: "Indo-Pacific",
  INDOPACOM: "Indo-Pacific",
  EUCOM: "Europe",
  AFRICOM: "Africa",
};

/**
 * Translate an operational-area label only when it is used as the narrative's
 * leading colon-delimited prefix. This is presentation-only: callers retain the
 * original parsed narrative and the complete suffix is preserved byte-for-byte.
 */
export function formatIeNarrativeLabel(narrative: string): string {
  return narrative.replace(
    /^(\s*)(WHEM|CENTCOM|INDOPACOM|PACOM|EUCOM|AFRICOM)(\s*:)/i,
    (_match, leading: string, area: string, delimiter: string) =>
      `${leading}${IE_AREA_LABELS[area.toUpperCase()]}${delimiter}`,
  );
}

/**
 * Format the compact IE preview context while retaining the browser's local-time
 * interpretation of the report timestamp.
 */
export function formatIeHighlightsIntro(asOfDate: Date): string {
  if (Number.isNaN(asOfDate.getTime())) {
    return "Major narratives as of — included:";
  }

  const day = String(asOfDate.getDate()).padStart(2, "0");
  const month = asOfDate.toLocaleString("en-US", { month: "short" });
  const hour24 = asOfDate.getHours();
  const hour12 = hour24 % 12 || 12;
  const minute = String(asOfDate.getMinutes()).padStart(2, "0");
  const meridiem = hour24 < 12 ? "AM" : "PM";

  return `Major narratives as of ${day} ${month}, ${String(hour12).padStart(2, "0")}:${minute} ${meridiem} included:`;
}