import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ViewKey = "classic" | "visual" | "curated" | "team";

interface ViewSwitcherProps {
  current: ViewKey;
  hasCuratedAccess?: boolean;
  tone?: "default" | "dark" | "curated";
  showLabel?: boolean;
  className?: string;
  testIds?: Partial<Record<ViewKey, string>>;
  labelTestId?: string;
}

const FEED_VIEWS: { key: ViewKey; href: string; label: string }[] = [
  { key: "classic", href: "/", label: "Classic" },
  { key: "visual", href: "/stream", label: "Visual" },
  { key: "curated", href: "/curated", label: "Curated" },
];

// Each view is highlighted in an accent drawn from the page it leads to, so the
// active button reads as an outlined highlight (never a solid fill).
const VIEW_ACCENTS: Record<ViewKey, string> = {
  classic: "#2563EB", // app brand blue (Classic / main feed)
  visual: "#60A5FA", // Stream's blue-400 headline/bullet accent
  curated: "#5FA8C4", // curated lane's light-blue (auto-refresh) accent
  team: "#10B981", // Team's emerald active/online accent
};

const DEFAULT_TEST_IDS: Record<ViewKey, string> = {
  classic: "link-classic",
  visual: "link-visual",
  curated: "link-curated",
  team: "link-team",
};

export default function ViewSwitcher({
  current,
  hasCuratedAccess = false,
  tone = "default",
  showLabel = true,
  className,
  testIds,
  labelTestId = "label-switch-view",
}: ViewSwitcherProps) {
  const ids = { ...DEFAULT_TEST_IDS, ...testIds };

  const toneShadow = tone === "curated" ? "shadow-md shadow-black/30" : "";
  const inactiveClass =
    tone === "dark"
      ? "border-slate-600 text-slate-200"
      : tone === "curated"
        ? "[border-color:hsl(var(--input))]"
        : "";

  const renderButton = (key: ViewKey, href: string, label: string) => {
    const active = current === key;
    const accent = VIEW_ACCENTS[key];
    return (
      <Button
        key={key}
        asChild
        size="sm"
        variant="outline"
        className={cn("min-h-7 px-2.5", toneShadow, !active && inactiveClass)}
        style={
          active
            ? {
                color: accent,
                borderColor: accent,
                backgroundColor: `${accent}29`,
              }
            : undefined
        }
        data-testid={ids[key]}
        aria-current={active ? "page" : undefined}
      >
        <Link href={href}>{label}</Link>
      </Button>
    );
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {showLabel && (
        <span
          className={cn(
            "text-xs font-medium",
            tone === "dark" ? "text-slate-400" : "text-muted-foreground",
          )}
          data-testid={labelTestId}
        >
          Switch View:
        </span>
      )}
      {FEED_VIEWS.map((v) => {
        if (v.key === "curated" && !hasCuratedAccess) return null;
        return renderButton(v.key, v.href, v.label);
      })}
      <div
        className={cn(
          "ml-1.5 pl-1.5 border-l",
          tone === "dark" ? "border-slate-600" : "border-border",
        )}
      >
        {renderButton("team", "/team", "Team")}
      </div>
    </div>
  );
}
