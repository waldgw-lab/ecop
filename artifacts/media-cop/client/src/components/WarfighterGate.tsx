import { useState, useEffect } from "react";
import { Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const GATED_SLUGS = new Set(["warfighter", "cyber"]);

interface WarfighterGateProps {
  slug: string | undefined;
  mode: "viewer" | "admin";
  storageKey: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

export function WarfighterGate({ slug, mode, storageKey, title, subtitle, children }: WarfighterGateProps) {
  const isGated = !!slug && GATED_SLUGS.has(slug);
  const [unlocked, setUnlocked] = useState(false);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isGated) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/custom-mcops/${slug}/gate-status`, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          const ok = mode === "admin" ? !!data.adminUnlocked : !!data.viewerUnlocked;
          if (!cancelled && ok) {
            setUnlocked(true);
            try { sessionStorage.setItem(storageKey, "1"); } catch {}
          }
        }
      } catch {}
      if (!cancelled) setChecked(true);
    })();
    return () => { cancelled = true; };
  }, [isGated, slug, storageKey, mode]);

  if (!isGated) return <>{children}</>;
  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }
  if (unlocked) return <>{children}</>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const url = mode === "admin"
        ? `/api/custom-mcops/${slug}/gate-admin`
        : `/api/custom-mcops/${slug}/gate-viewer`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        try { sessionStorage.setItem(storageKey, "1"); } catch {}
        setUnlocked(true);
      } else {
        let msg = "Incorrect password.";
        try { const d = await res.json(); if (d?.error) msg = d.error; } catch {}
        setError(msg);
      }
    } catch (err: any) {
      setError("Could not reach server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
      <Card className="w-full max-w-sm bg-slate-800 border-slate-700">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center mb-2">
            <Lock className="w-5 h-5 text-slate-300" />
          </div>
          <CardTitle className="text-white text-base">{title}</CardTitle>
          <p className="text-xs text-slate-400">{subtitle}</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <Input
              type="password"
              value={pw}
              onChange={(e) => { setPw(e.target.value); if (error) setError(null); }}
              placeholder="Password"
              autoFocus
              disabled={submitting}
              className="bg-slate-700 border-slate-600 text-white"
              data-testid="input-warfighter-password"
            />
            {error && (
              <p className="text-xs text-red-400" data-testid="text-warfighter-password-error">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={!pw || submitting} data-testid="button-warfighter-password-submit">
              {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Lock className="w-4 h-4 mr-2" />}
              {submitting ? "Checking..." : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
