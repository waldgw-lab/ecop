import { parse } from "csv-parse/sync";

/** Bounded downloads, including RSS bodies; don't let a source wedge the polling loop. */
export async function downloadPublicText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "FinancialStabilityWatch/1.0 (internal research)", Accept: "text/csv, application/rss+xml, application/xml, text/xml, */*" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Source returned no body");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5_000_000) throw new Error("Source exceeded the 5 MB response limit");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString("utf8");
}
export function csvPoints(text: string, dateKey: string, valueKey: string, lookbackDays = 370) {
  const records = parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
  if (!records.length || !(dateKey in records[0]) || !(valueKey in records[0])) throw new Error("Source CSV columns did not match the documented series");
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const byDate = new Map<string, number | null>();
  for (const record of records) {
    const date = record[dateKey];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoff || date > today) continue;
    const raw = record[valueKey]?.trim();
    const value = raw && raw !== "." ? Number(raw) : NaN;
    byDate.set(date, Number.isFinite(value) ? value : null);
  }
  const points = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  if (!points.some(p => p.value !== null)) throw new Error("Source had no numeric observations in the historical window");
  return points;
}
