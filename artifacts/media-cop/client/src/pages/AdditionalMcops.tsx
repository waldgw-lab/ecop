import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Plus, ArrowLeft, Shield, ExternalLink, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { CustomMcop } from "@shared/schema";

export default function AdditionalMcops() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');

  const { data: mcops = [], isLoading } = useQuery<CustomMcop[]>({
    queryKey: ['/api/custom-mcops'],
  });

  const createMutation = useMutation({
    mutationFn: async ({ name, password }: { name: string; password: string }) => {
      const res = await apiRequest('POST', '/api/custom-mcops', { name, password });
      return await res.json();
    },
    onSuccess: (created: CustomMcop) => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops'] });
      setCreateOpen(false);
      setNewName('');
      setNewPassword('');
      setNewPasswordConfirm('');
      toast({ title: 'Custom MCOP created', description: 'Save the admin password — you will need it next time.' });
      navigate(`/mcop/${created.slug}/admin`);
    },
    onError: (err: any) => toast({ title: 'Failed to create', description: err?.message || '', variant: 'destructive' }),
  });

  const handleCreate = () => {
    const name = newName.trim();
    const pw = newPassword;
    if (!name) return;
    if (pw.length < 4) {
      toast({ title: 'Password too short', description: 'Use at least 4 characters.', variant: 'destructive' });
      return;
    }
    if (pw !== newPasswordConfirm) {
      toast({ title: 'Passwords do not match', variant: 'destructive' });
      return;
    }
    createMutation.mutate({ name, password: pw });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-blue-500" />
            <h1 className="text-lg font-semibold">Additional MCOPs</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/team">
              <Button variant="outline" size="sm" data-testid="link-back-team">
                <ArrowLeft className="w-4 h-4 mr-1" /> Back to Team
              </Button>
            </Link>
            <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-new-mcop">
              <Plus className="w-4 h-4 mr-1" /> New MCOP
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : mcops.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <p className="text-sm">No custom MCOPs yet. Create one to get a War-style dashboard ranked by your own priorities.</p>
              <Button className="mt-4" onClick={() => setCreateOpen(true)} data-testid="button-new-mcop-empty">
                <Plus className="w-4 h-4 mr-1" /> Create First Custom MCOP
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {mcops.map(m => (
              <Card key={m.id} data-testid={`card-mcop-${m.slug}`} className="hover-elevate">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="truncate">{m.name}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                    {m.lookForNow?.trim() || m.generalPrompt?.slice(0, 120) || 'No focus set yet.'}
                  </p>
                  <div className="flex items-center gap-2">
                    <Link href={`/mcop/${m.slug}`}>
                      <Button size="sm" data-testid={`button-open-mcop-${m.slug}`}>
                        <ExternalLink className="w-3.5 h-3.5 mr-1" /> Open Dashboard
                      </Button>
                    </Link>
                    <Link href={`/mcop/${m.slug}/admin`}>
                      <Button size="sm" variant="outline" data-testid={`button-edit-mcop-${m.slug}`}>
                        Edit Priorities
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Custom MCOP</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mcop-name">Name</Label>
              <Input
                id="mcop-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Indo-Pacific Watch"
                autoFocus
                data-testid="input-new-mcop-name"
              />
              <p className="text-xs text-muted-foreground">
                We'll seed this with the main MCOP's priority prompt — you can customize it next.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcop-password">Admin Password</Label>
              <Input
                id="mcop-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 4 characters"
                data-testid="input-new-mcop-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcop-password-confirm">Confirm Password</Label>
              <Input
                id="mcop-password-confirm"
                type="password"
                value={newPasswordConfirm}
                onChange={(e) => setNewPasswordConfirm(e.target.value)}
                placeholder="Re-enter password"
                data-testid="input-new-mcop-password-confirm"
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              />
              <p className="text-xs text-muted-foreground">
                Required to access this MCOP's admin page (priorities, manual stories, social posts).
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} data-testid="button-cancel-create-mcop">Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || !newPassword || createMutation.isPending}
              data-testid="button-confirm-create-mcop"
            >
              {createMutation.isPending ? 'Creating...' : 'Create & Edit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
