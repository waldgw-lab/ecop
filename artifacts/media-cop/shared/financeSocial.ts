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
