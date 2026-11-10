import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  filterSocialPosts, parseSocialSelection, socialAccountOptions, toggleSocialAccount,
  type FinancialSocialPost, type SocialAccountSelection,
} from "@shared/financeSocial";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const STORAGE_KEY = "fsw-social-account-selection";
const NO_POSTS: FinancialSocialPost[] = [];

export function useSocialAccountSelection(posts = NO_POSTS) {
  const [selection, setSelection] = useState<SocialAccountSelection>(() => {
    try { return parseSocialSelection(localStorage.getItem(STORAGE_KEY)); }
    catch { return null; }
  });
  const [saveError, setSaveError] = useState(false);
  const options = useMemo(() => socialAccountOptions(posts), [posts]);
  const visiblePosts = useMemo(() => filterSocialPosts(posts, selection), [posts, selection]);
  const onChange = (next: SocialAccountSelection) => {
    setSelection(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaveError(false);
    } catch { setSaveError(true); }
  };
  return { selection, options, visiblePosts, onChange, saveError };
}

export function SocialAccountSelector({ selection, options, onChange, saveError }: ReturnType<typeof useSocialAccountSelection>) {
  const selectedCount = options.filter(o => selection === null || selection.includes(o.id)).length;
  return (
    <div className="mt-2 space-y-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="fsw-chip w-full flex items-center justify-between gap-1 text-left" data-testid="button-social-accounts" aria-label="Select social media accounts">
            <span>{selection === null ? "All accounts" : `${selectedCount} of ${options.length} accounts`}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-24px)]" data-testid="menu-social-accounts">
          <DropdownMenuLabel>Accounts to display</DropdownMenuLabel>
          <DropdownMenuItem onSelect={e => { e.preventDefault(); onChange(null); }} data-testid="button-social-select-all">Show all accounts</DropdownMenuItem>
          <DropdownMenuItem onSelect={e => { e.preventDefault(); onChange([]); }} data-testid="button-social-clear">Clear selection</DropdownMenuItem>
          <DropdownMenuSeparator />
          {options.map(o => (
            <DropdownMenuCheckboxItem key={o.id} checked={selection === null || selection.includes(o.id)}
              onSelect={e => e.preventDefault()}
              onCheckedChange={checked => onChange(toggleSocialAccount(selection, options.map(a => a.id), o.id, checked === true))}
              data-testid={`option-social-${o.id}`}>
              <span className="min-w-0 flex-1">
                <span className="block">{o.name} <span className="text-muted-foreground">({o.count})</span></span>
                <span className="block text-[11px] text-muted-foreground truncate">{o.platform}{o.handle ? ` · @${o.handle.replace(/^@/, "")}` : ""}</span>
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-[11px] text-muted-foreground">Counts show currently available financial posts. Saved in this browser; collection is unchanged.</p>
        </DropdownMenuContent>
      </DropdownMenu>
      {saveError && <p role="status" className="text-[10.5px] text-[hsl(var(--fsw-coral))]">Selection applies for this visit; this browser could not save it.</p>}
    </div>
  );
}
