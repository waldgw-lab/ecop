export interface FinancialSocialPost {
  id: string;
  text: string;
  author: string;
  handle: string | null;
  platform: "Bluesky" | "X" | "Other";
  url: string;
  publishedAt: string;
  collectedAt: string;
  via: "Public Bluesky" | "Dataminr";
  impact: number;
  topic: string;
  verification: "Publisher account" | "Unconfirmed signal";
}
export interface FinancialSocialFeed {
  posts: FinancialSocialPost[];
  updatedAt: string | null;
  refreshing: boolean;
  sources: { name: string; status: "healthy" | "error" | "unavailable"; message: string }[];
  meltwater: { configured: boolean; status: string; message: string };
}

export const PUBLIC_SOCIAL_ACCOUNTS = [
  { handle: "financialtimes.com", name: "Financial Times" },
  { handle: "bloomberg.com", name: "Bloomberg" },
  { handle: "economist.com", name: "The Economist" },
] as const;

export type SocialAccountSelection = string[] | null; // null follows all accounts, including new ones
export const socialAccountId = (p: Pick<FinancialSocialPost, "platform" | "handle" | "author">) =>
  `${p.platform}:${(p.handle || p.author).replace(/^@/, "").toLowerCase()}`;

interface SocialAccountOption {
  id: string;
  name: string;
  handle: string;
  platform: FinancialSocialPost["platform"];
  count: number;
}

export function socialAccountOptions(posts: FinancialSocialPost[]) {
  const options = new Map<string, SocialAccountOption>(PUBLIC_SOCIAL_ACCOUNTS.map(a => [
    `Bluesky:${a.handle}`,
    { id: `Bluesky:${a.handle}`, name: a.name, handle: a.handle, platform: "Bluesky", count: 0 },
  ]));
  for (const p of posts) {
    const id = socialAccountId(p);
    const option = options.get(id) ?? {
      id, name: p.via === "Dataminr" && p.handle ? `@${p.handle}` : p.author,
      handle: p.handle ?? "", platform: p.platform, count: 0,
    };
    option.count++;
    options.set(id, option);
  }
  return [...options.values()];
}

export function parseSocialSelection(raw: string | null): SocialAccountSelection {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    return Array.isArray(value) && value.every(x => typeof x === "string")
      ? [...new Set(value)] : null;
  } catch { return null; }
}

export function filterSocialPosts(posts: FinancialSocialPost[], selection: SocialAccountSelection) {
  if (selection === null) return posts;
  const selected = new Set(selection);
  return posts.filter(p => selected.has(socialAccountId(p)));
}

export function toggleSocialAccount(selection: SocialAccountSelection, availableIds: string[], id: string, checked: boolean) {
  const selected = new Set(selection ?? availableIds);
  if (checked) selected.add(id);
  else selected.delete(id);
  return [...selected];
}
