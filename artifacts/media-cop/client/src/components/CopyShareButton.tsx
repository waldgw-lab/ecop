import { Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { copyRichText } from "@/lib/richCopy";

// Small, muted copy control used across the Curated view to copy a clean,
// formatted version of an item to the clipboard (rich text + plain-text
// fallback). Sized and coloured to sit inline with the existing "open in new
// tab" (ExternalLink) shortcut it lives next to. `buildHtml` is invoked lazily
// on click so the payload reflects the item's state at copy time. Click is
// stopped from propagating so it never triggers the surrounding card/dialog's
// click-through to the article. Rendered as a real <button> so it stays
// keyboard-focusable and activates on Enter/Space.
export default function CopyShareButton({
  buildHtml,
  label = "Copy to clipboard",
  testId,
}: {
  buildHtml: () => string;
  label?: string;
  testId: string;
}) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      className="inline-flex items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copyRichText(buildHtml(), toast);
      }}
    >
      <Copy className="h-3 w-3" />
    </button>
  );
}
