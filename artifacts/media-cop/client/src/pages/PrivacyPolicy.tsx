import { Link } from "wouter";
import { ArrowLeft, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-8">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-home">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Dashboard
            </Button>
          </Link>
        </div>

        <div className="flex items-center gap-3 mb-2">
          <Shield className="w-6 h-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground" data-testid="text-privacy-title">
            Privacy Policy
          </h1>
        </div>
        <p className="text-sm text-muted-foreground mb-10">
          Last updated: March 30, 2026
        </p>

        <div className="space-y-8 text-sm leading-relaxed text-foreground/90">
          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">1. Overview</h2>
            <p>
              The Media Common Operating Picture (MCOP) is committed to protecting the privacy of its users.
              This Privacy Policy outlines the types of information collected, how it is used, and the measures
              taken to safeguard it.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">2. Information We Do Not Collect</h2>
            <p>
              MCOP does not store personal information on its users. We do not collect, retain, or process
              personally identifiable information (PII) such as names, email addresses, browsing history,
              or device information beyond what is necessary for authentication through the Replit platform.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">3. SMS Alert Subscription</h2>
            <p>
              If a user elects to subscribe to SMS alerts for POTUS Truth Social posts, the only personal
              information stored is the <strong>phone number</strong> provided by the subscriber. This phone number
              is used solely for the purpose of delivering SMS alert notifications and is not shared with
              any third parties beyond the messaging service provider (Twilio) required to transmit the messages.
            </p>
            <p className="mt-2">
              Subscribers may unsubscribe at any time, at which point their phone number will be deactivated
              and can be removed from the system upon request.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">4. Authentication</h2>
            <p>
              MCOP uses Replit's authentication system for user access. Authentication data is managed
              by Replit and is subject to Replit's own privacy policy. MCOP does not independently store
              user credentials or authentication tokens.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">5. Cookies &amp; Tracking</h2>
            <p>
              MCOP does not use cookies, analytics trackers, or any third-party tracking technologies
              to monitor user behavior or collect usage data.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">6. Data Security</h2>
            <p>
              All data transmitted between users and MCOP is encrypted in transit using HTTPS/TLS.
              Access to the application is restricted to authorized personnel through authentication controls.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">7. Third-Party Services</h2>
            <p>
              MCOP integrates with the following third-party services, each governed by their respective
              privacy policies:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1 text-foreground/80">
              <li>Twilio &mdash; SMS message delivery</li>
              <li>Replit &mdash; Hosting and authentication</li>
              <li>OpenAI &mdash; AI-powered content analysis</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">8. Changes to This Policy</h2>
            <p>
              This Privacy Policy may be updated from time to time. Any changes will be reflected on this page
              with an updated revision date.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">9. Contact</h2>
            <p>
              For questions or concerns regarding this Privacy Policy, please contact the MCOP administration team.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted-foreground text-center">
            Media Common Operating Picture (MCOP) &mdash; Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
}
