import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/components/ThemeProvider";
import mcopLogoWhite from "@assets/Logo5_WHITE_1782606805634.png";
import mcopLogoBlack from "@assets/Logo5_BLACK_1782606794585.png";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface LoginProps {
  onLoginSuccess: () => void;
  productName?: string;
}

export default function Login({ onLoginSuccess, productName }: LoginProps) {
  const { theme } = useTheme();
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showRequestDialog, setShowRequestDialog] = useState(false);
  const [requestForm, setRequestForm] = useState({ name: "", email: "", message: "" });
  const [isSubmittingRequest, setIsSubmittingRequest] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        toast({
          title: "Access Granted",
          description: productName ? `Welcome to ${productName}` : "Welcome to Media Common Operating Picture v3.0",
        });
        onLoginSuccess();
      } else {
        const data = await response.json();
        toast({
          title: "Access Denied",
          description: data.message || "Invalid password",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to authenticate",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setPassword("");
    }
  };

  const handleRequestAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingRequest(true);

    try {
      const response = await fetch("/api/auth/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestForm),
      });

      if (response.ok) {
        toast({
          title: "Request Sent",
          description: "Your access request has been submitted successfully.",
        });
        setShowRequestDialog(false);
        setRequestForm({ name: "", email: "", message: "" });
      } else {
        const data = await response.json();
        toast({
          title: "Error",
          description: data.error || "Failed to send request",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send access request",
        variant: "destructive",
      });
    } finally {
      setIsSubmittingRequest(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md flex flex-col gap-4">
        <Card className="p-8">
          <div className="flex flex-col items-center mb-6">
            {productName ? <div className="text-center"><p className="text-xs uppercase tracking-widest text-muted-foreground mb-3">Restricted internal monitoring</p><h1 className="text-2xl font-semibold">{productName}</h1><p className="text-sm text-muted-foreground mt-3">Financial developments with domestic and global stability implications.</p></div> : <img
              src={theme === "dark" ? mcopLogoWhite : mcopLogoBlack}
              alt="MOOP"
              className="h-24 w-auto"
              data-testid="img-login-logo"
            />}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                type="password"
                aria-label="Team access code"
                autoComplete="current-password"
                placeholder="Enter access code"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                autoFocus
                data-testid="input-password"
                className="text-center font-mono"
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading || !password}
              data-testid="button-login"
            >
              {isLoading ? "Authenticating..." : "Access System"}
            </Button>
          </form>

          <div className="mt-6 text-xs text-center text-muted-foreground space-y-2">
            <p>{productName ? "Authorized team members only · Existing team access code" : "M.C.O.P. v3.0"}</p>
          </div>
        </Card>
      </div>

      <Dialog open={showRequestDialog} onOpenChange={setShowRequestDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Access</DialogTitle>
            <DialogDescription>
              Fill out this form to request access to Media Common Operating Picture v2.0.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRequestAccess}>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={requestForm.name}
                  onChange={(e) => setRequestForm({ ...requestForm, name: e.target.value })}
                  required
                  disabled={isSubmittingRequest}
                  data-testid="input-request-name"
                />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={requestForm.email}
                  onChange={(e) => setRequestForm({ ...requestForm, email: e.target.value })}
                  required
                  disabled={isSubmittingRequest}
                  data-testid="input-request-email"
                />
              </div>
              <div>
                <Label htmlFor="message">Message</Label>
                <Textarea
                  id="message"
                  value={requestForm.message}
                  onChange={(e) => setRequestForm({ ...requestForm, message: e.target.value })}
                  required
                  disabled={isSubmittingRequest}
                  placeholder="Why do you need access?"
                  rows={4}
                  data-testid="input-request-message"
                />
              </div>
            </div>
            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowRequestDialog(false)}
                disabled={isSubmittingRequest}
                data-testid="button-cancel-request"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSubmittingRequest}
                data-testid="button-submit-request"
              >
                {isSubmittingRequest ? "Sending..." : "Send Request"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
