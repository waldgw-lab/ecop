import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Phone, Plus, Trash2, Send, Loader2, Smartphone, Cloud, ShieldCheck, ShieldAlert, MessageSquarePlus } from "lucide-react";

interface SmsSubscriber {
  id: string;
  phoneNumber: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

interface SmsBridgeStatus {
  activeDevice: "primary" | "backup";
  override: "auto" | "primary" | "backup";
  primaryLastSeen: string | null;
  backupLastSeen: string | null;
  primaryAlive: boolean;
  backupAlive: boolean;
  primaryConsecutiveFailures: number;
  lastSwitchAt: string | null;
  recentEvents: { fromDevice: string; toDevice: string; reason: string; createdAt: string }[];
}

interface SmsHealth {
  color: "green" | "amber" | "red";
  reasons: string[];
}

interface SmsStatus {
  configured: boolean;
  twilioConfigured: boolean;
  mode: "twilio" | "termux";
  termuxQueuePending: number;
  bridge?: SmsBridgeStatus;
  health?: SmsHealth;
}

function agoLabel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface SmsAlertsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SmsAlertsDialog({ open, onOpenChange }: SmsAlertsDialogProps) {
  const { toast } = useToast();
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [sendToAll, setSendToAll] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const statusQuery = useQuery<SmsStatus>({
    queryKey: ["/api/sms-alerts/status"],
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  const subscribersQuery = useQuery<SmsSubscriber[]>({
    queryKey: ["/api/sms-subscribers"],
    enabled: open,
  });

  const addMutation = useMutation({
    mutationFn: async (data: { name: string; phoneNumber: string }) => {
      const res = await apiRequest("POST", "/api/sms-subscribers", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sms-subscribers"] });
      setNewName("");
      setNewPhone("");
      toast({ title: "Subscriber added" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to add subscriber", description: error.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/sms-subscribers/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sms-subscribers"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/sms-subscribers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sms-subscribers"] });
      toast({ title: "Subscriber removed" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (phoneNumber: string) => {
      const res = await apiRequest("POST", "/api/sms-subscribers/test", { phoneNumber });
      return res.json();
    },
    onSuccess: (data) => {
      setTestingId(null);
      if (data.success) {
        toast({ title: data.note || "Test SMS sent" });
      } else {
        toast({ title: "Test failed", description: data.error, variant: "destructive" });
      }
    },
    onError: (error: any) => {
      setTestingId(null);
      toast({ title: "Test failed", description: error.message, variant: "destructive" });
    },
  });

  const customSendMutation = useMutation({
    mutationFn: async (data: { message: string; recipientIds?: string[] }) => {
      const res = await apiRequest("POST", "/api/sms-alerts/custom-message", data);
      return res.json();
    },
    onSuccess: (data) => {
      setConfirming(false);
      const parts: string[] = [];
      if (data.sent > 0) parts.push(`${data.sent} sent`);
      if (data.queued > 0) parts.push(`${data.queued} queued`);
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      const failures = (data.results ?? []).filter((r: any) => !r.success);
      const description =
        data.mode === "termux" && data.queued > 0
          ? `Queued for delivery via phone bridge.${failures.length > 0 ? " Failed: " + failures.map((f: any) => f.name).join(", ") : ""}`
          : failures.length > 0
          ? `Failed: ${failures.map((f: any) => f.name).join(", ")}`
          : undefined;
      toast({
        title: `Custom message: ${parts.join(", ") || "no recipients"}`,
        description,
        variant: data.failed > 0 && data.sent === 0 && data.queued === 0 ? "destructive" : undefined,
      });
      if (data.failed === 0) {
        setComposeText("");
        setSendToAll(true);
        setSelectedIds(new Set());
        setComposeOpen(false);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/sms-alerts/status"] });
    },
    onError: (error: any) => {
      setConfirming(false);
      toast({ title: "Failed to send custom message", description: error.message, variant: "destructive" });
    },
  });

  const modeMutation = useMutation({
    mutationFn: async (mode: "twilio" | "termux") => {
      const res = await apiRequest("POST", "/api/sms-alerts/mode", { mode });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sms-alerts/status"] });
      toast({ title: `SMS mode: ${data.mode === "termux" ? "Termux (Burner Phone)" : "Twilio"}` });
    },
  });

  const overrideMutation = useMutation({
    mutationFn: async (mode: "auto" | "primary" | "backup") => {
      const res = await apiRequest("POST", "/api/sms-alerts/bridge-override", { mode });
      return res.json();
    },
    onSuccess: (_data, mode) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sms-alerts/status"] });
      toast({ title: mode === "auto" ? "Failover set to automatic" : `Forcing ${mode} phone` });
    },
    onError: (error: any) => {
      toast({ title: "Failed to change failover mode", description: error.message, variant: "destructive" });
    },
  });

  const status = statusQuery.data;
  const currentMode = status?.mode ?? "twilio";
  const isConfigured = status?.configured ?? false;
  const subscribers = subscribersQuery.data ?? [];
  const bridge = status?.bridge;

  const activeSubscribers = subscribers.filter((s) => s.isActive);
  const recipients = sendToAll
    ? activeSubscribers
    : activeSubscribers.filter((s) => selectedIds.has(s.id));
  const trimmedCompose = composeText.trim();
  // Server prefixes "MCOP Alert: " (12 chars) before sending.
  const fullLength = trimmedCompose.length > 0 ? trimmedCompose.length + 12 : 0;
  const segments = fullLength === 0 ? 0 : fullLength <= 160 ? 1 : Math.ceil(fullLength / 153);
  const canSend = trimmedCompose.length > 0 && trimmedCompose.length <= 1200 && recipients.length > 0;

  const toggleRecipient = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const doSend = () => {
    customSendMutation.mutate({
      message: trimmedCompose,
      ...(sendToAll ? {} : { recipientIds: recipients.map((r) => r.id) }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px] h-[85vh] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="sms-alerts-dialog-title">
            <Phone className="h-5 w-5" />
            SMS Alerts — POTUS Truth Social
            {status?.health && (
              <span
                className={`ml-1 inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
                  status.health.color === 'red'
                    ? 'bg-red-500'
                    : status.health.color === 'amber'
                    ? 'bg-amber-400'
                    : 'bg-green-500'
                }`}
                title={
                  status.health.color === 'green'
                    ? 'Sending normally'
                    : status.health.reasons.join('; ')
                }
                data-testid="status-sms-health-dialog"
              />
            )}
          </DialogTitle>
          {status?.health && status.health.color !== 'green' && (
            <p className={`text-xs mt-0.5 ${status.health.color === 'red' ? 'text-red-500' : 'text-amber-500'}`}>
              {status.health.reasons[0]}
              {status.health.reasons.length > 1 && ` (+${status.health.reasons.length - 1} more)`}
            </p>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          <div className="flex items-center gap-3 p-3 rounded-md border">
            <div className="flex-1 flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {currentMode === "termux" ? (
                  <Smartphone className="h-4 w-4 text-green-500" />
                ) : (
                  <Cloud className="h-4 w-4 text-blue-500" />
                )}
                <span>
                  {currentMode === "termux" ? "Termux (Burner Phone)" : "Twilio"}
                </span>
                <div
                  className={`w-2 h-2 rounded-full ${isConfigured ? "bg-green-500" : "bg-red-500"}`}
                  data-testid="status-sms-configured"
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {currentMode === "termux" ? (
                  <>
                    Sending via burner phone.
                    {(status?.termuxQueuePending ?? 0) > 0 && (
                      <span className="ml-1 text-amber-500 font-medium">
                        {status?.termuxQueuePending} message{(status?.termuxQueuePending ?? 0) !== 1 ? "s" : ""} queued
                      </span>
                    )}
                  </>
                ) : (
                  status?.twilioConfigured
                    ? "Twilio is configured and ready"
                    : "Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER"
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => modeMutation.mutate(currentMode === "twilio" ? "termux" : "twilio")}
              disabled={modeMutation.isPending}
              data-testid="button-toggle-sms-mode"
            >
              {modeMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : currentMode === "twilio" ? (
                <>
                  <Smartphone className="w-4 h-4 mr-1" />
                  Use Termux
                </>
              ) : (
                <>
                  <Cloud className="w-4 h-4 mr-1" />
                  Use Twilio
                </>
              )}
            </Button>
          </div>

          <div className="p-3 rounded-md border flex flex-col gap-2" data-testid="panel-custom-message">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 text-sm font-medium">
                <MessageSquarePlus className="h-4 w-4" />
                <span>Send custom message</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setComposeOpen((v) => !v);
                  setConfirming(false);
                }}
                data-testid="button-toggle-compose"
              >
                {composeOpen ? "Close" : "Compose"}
              </Button>
            </div>
            {composeOpen && (
              <div className="flex flex-col gap-2">
                <Textarea
                  placeholder="Type your message to subscribers..."
                  value={composeText}
                  onChange={(e) => {
                    setComposeText(e.target.value);
                    setConfirming(false);
                  }}
                  rows={3}
                  maxLength={1200}
                  data-testid="input-custom-message"
                />
                <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-muted-foreground">
                  <span data-testid="text-char-counter">
                    {trimmedCompose.length}/1200 characters
                    {segments > 1 && (
                      <span className="ml-1 text-amber-500 font-medium" data-testid="text-segment-warning">
                        — will be split into {segments} SMS segments
                      </span>
                    )}
                  </span>
                  <span>Sent with the "MCOP Alert:" prefix</span>
                </div>
                {trimmedCompose.length === 0 && (
                  <p className="text-xs text-destructive" data-testid="text-empty-message-error">
                    Message cannot be empty.
                  </p>
                )}
                <div className="flex items-center gap-4 flex-wrap text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={sendToAll}
                      onCheckedChange={(checked) => {
                        setSendToAll(checked === true);
                        setConfirming(false);
                      }}
                      data-testid="checkbox-send-to-all"
                    />
                    <span>All active subscribers ({activeSubscribers.length})</span>
                  </label>
                </div>
                {!sendToAll && (
                  <div className="flex flex-col gap-1 max-h-32 overflow-y-auto border rounded-md p-2" data-testid="list-recipient-picker">
                    {activeSubscribers.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No active subscribers.</p>
                    ) : (
                      activeSubscribers.map((sub) => (
                        <label key={sub.id} className="flex items-center gap-2 text-sm cursor-pointer py-0.5">
                          <Checkbox
                            checked={selectedIds.has(sub.id)}
                            onCheckedChange={(checked) => {
                              toggleRecipient(sub.id, checked === true);
                              setConfirming(false);
                            }}
                            data-testid={`checkbox-recipient-${sub.id}`}
                          />
                          <span className="truncate">{sub.name}</span>
                          <span className="text-xs text-muted-foreground">{sub.phoneNumber}</span>
                        </label>
                      ))
                    )}
                  </div>
                )}
                {recipients.length === 0 && (
                  <p className="text-xs text-destructive" data-testid="text-no-recipients-error">
                    {sendToAll ? "No active subscribers to send to." : "Select at least one recipient."}
                  </p>
                )}
                {!confirming ? (
                  <Button
                    size="sm"
                    onClick={() => setConfirming(true)}
                    disabled={!canSend || !isConfigured}
                    data-testid="button-review-send"
                  >
                    <Send className="w-4 h-4 mr-1" />
                    Review &amp; send
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2 p-2 rounded-md border" data-testid="panel-send-confirm">
                    <p className="text-sm">
                      Send this message to <strong>{recipients.length}</strong> recipient{recipients.length !== 1 ? "s" : ""}?
                      {currentMode === "termux" && " It will be queued for delivery via the phone bridge."}
                      {" "}This cannot be undone.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={doSend}
                        disabled={customSendMutation.isPending}
                        data-testid="button-confirm-send"
                      >
                        {customSendMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4 mr-1" />
                        )}
                        Confirm send
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirming(false)}
                        disabled={customSendMutation.isPending}
                        data-testid="button-cancel-send"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {currentMode === "termux" && bridge && (
            <div className="p-3 rounded-md border flex flex-col gap-2" data-testid="panel-sms-bridge">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {bridge.primaryAlive || bridge.backupAlive ? (
                    <ShieldCheck className="h-4 w-4 text-green-500" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-red-500" />
                  )}
                  <span>Phone Failover</span>
                </div>
                <div className="flex items-center gap-1">
                  {(["auto", "primary", "backup"] as const).map((m) => (
                    <Button
                      key={m}
                      variant="outline"
                      size="sm"
                      className={bridge.override === m ? "toggle-elevate toggle-elevated" : "toggle-elevate"}
                      onClick={() => overrideMutation.mutate(m)}
                      disabled={overrideMutation.isPending || bridge.override === m}
                      data-testid={`button-bridge-override-${m}`}
                    >
                      {m === "auto" ? "Auto" : m === "primary" ? "Force Primary" : "Force Backup"}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {(["primary", "backup"] as const).map((role) => {
                  const alive = role === "primary" ? bridge.primaryAlive : bridge.backupAlive;
                  const lastSeen = role === "primary" ? bridge.primaryLastSeen : bridge.backupLastSeen;
                  const isActive = bridge.activeDevice === role;
                  return (
                    <div key={role} className="flex items-center gap-2 p-2 rounded-md border" data-testid={`status-bridge-${role}`}>
                      <div className={`w-2 h-2 rounded-full shrink-0 ${alive ? "bg-green-500" : "bg-red-500"}`} />
                      <div className="min-w-0">
                        <div className="font-medium flex items-center gap-1 flex-wrap">
                          <span className="capitalize">{role} phone</span>
                          {isActive && (
                            <Badge variant="secondary" className="text-[10px]" data-testid={`badge-bridge-active-${role}`}>ACTIVE</Badge>
                          )}
                        </div>
                        <div className="text-muted-foreground">
                          {alive ? "checking in" : "not checking in"} · {agoLabel(lastSeen)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {bridge.override !== "auto" && (
                <div className="text-xs text-amber-500" data-testid="text-bridge-override-note">
                  Manual override active — the {bridge.override} phone is forced even if it looks down. Set back to Auto for automatic failover.
                </div>
              )}
              {bridge.recentEvents.length > 0 && (
                <div className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-muted-foreground">Recent switches</div>
                  {bridge.recentEvents.slice(0, 5).map((ev, i) => (
                    <div key={`${ev.createdAt}-${i}`} className="text-xs text-muted-foreground" data-testid={`row-bridge-event-${i}`}>
                      {agoLabel(ev.createdAt)}: {ev.fromDevice} → {ev.toDevice} ({ev.reason})
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Input
              placeholder="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1 min-w-[120px]"
              data-testid="input-subscriber-name"
            />
            <Input
              placeholder="Phone (e.g. 5551234567)"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              className="flex-1 min-w-[150px]"
              data-testid="input-subscriber-phone"
            />
            <Button
              size="sm"
              onClick={() => {
                if (newName.trim() && newPhone.trim()) {
                  addMutation.mutate({ name: newName.trim(), phoneNumber: newPhone.trim() });
                }
              }}
              disabled={!newName.trim() || !newPhone.trim() || addMutation.isPending}
              data-testid="button-add-subscriber"
            >
              {addMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
              Add
            </Button>
          </div>

          <p className="text-xs text-muted-foreground" data-testid="text-sms-consent">
            By adding your number, you agree to receive automated POTUS Truth Social alerts from MCOP.
            Message frequency varies. Msg &amp; data rates may apply. Reply <strong>STOP</strong> to opt out, <strong>HELP</strong> for help.
            See our <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline">Privacy Policy</a> and <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline">Terms &amp; Conditions</a>.
          </p>

          <div className="flex-1 min-h-0 overflow-y-auto pr-2 -mr-2">
            {subscribersQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : subscribers.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                No subscribers yet. Add a phone number above to start receiving POTUS Truth Social alerts via SMS.
              </div>
            ) : (
              <div className="space-y-2">
                {subscribers.map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-center gap-3 p-3 rounded-md border"
                    data-testid={`subscriber-row-${sub.id}`}
                  >
                    <Switch
                      checked={sub.isActive}
                      onCheckedChange={(checked) => toggleMutation.mutate({ id: sub.id, isActive: checked })}
                      data-testid={`toggle-subscriber-${sub.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{sub.name}</div>
                      <div className="text-xs text-muted-foreground">{sub.phoneNumber}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setTestingId(sub.id);
                        testMutation.mutate(sub.phoneNumber);
                      }}
                      disabled={!isConfigured || testMutation.isPending}
                      title={currentMode === "termux" ? "Queue test SMS for Termux" : "Send test SMS"}
                      data-testid={`button-test-sms-${sub.id}`}
                    >
                      {testMutation.isPending && testingId === sub.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMutation.mutate(sub.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-subscriber-${sub.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Subscribers receive an SMS whenever POTUS posts on Truth Social. Posts are filtered by AI to exclude non-substantive content (bare links, standalone images). US phone numbers can be entered without the country code.
            {currentMode === "termux" && " Subscribers can also text questions to the burner phone to ask MCOP Bot."}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
