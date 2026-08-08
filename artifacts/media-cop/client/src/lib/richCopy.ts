// Shared rich-copy helper for the Curated view's copy-to-share shortcuts.
//
// Writes BOTH a `text/html` flavor (bold + clickable links survive in rich chat
// clients like Teams/Slack) and a derived `text/plain` flavor (readable, with
// link URLs inlined) so the copy degrades gracefully into plain editors. Mirrors
// the existing Team chat copy handler (navigator.clipboard.write with a
// ClipboardItem of text/html + text/plain), falling back to writeText when
// ClipboardItem isn't available. This is the single place all three Curated
// surfaces call, and it triggers the success/failure toast.

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}) => void;

// Escape user/article text before interpolating it into an HTML payload.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Derive a readable plain-text version from an HTML payload: block-level tags
// become newlines, and each link's URL is appended in parentheses so the URL
// survives in plain editors that can't render the anchor.
function htmlToPlainText(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
  tmp.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const txt = a.textContent || "";
    if (href && !txt.includes(href)) a.textContent = `${txt} (${href})`;
  });
  const text = tmp.textContent || tmp.innerText || "";
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function copyRichText(html: string, toast: ToastFn): Promise<void> {
  const plain = htmlToPlainText(html);
  try {
    const htmlBlob = new Blob([html], { type: "text/html" });
    const textBlob = new Blob([plain], { type: "text/plain" });
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": htmlBlob,
        "text/plain": textBlob,
      }),
    ]);
    toast({ title: "Copied to clipboard" });
  } catch {
    try {
      await navigator.clipboard.writeText(plain);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  }
}
