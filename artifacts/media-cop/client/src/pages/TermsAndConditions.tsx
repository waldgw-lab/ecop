import { Link } from "wouter";
import { ArrowLeft, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function TermsAndConditions() {
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
          <FileText className="w-6 h-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground" data-testid="text-terms-title">
            Terms &amp; Conditions
          </h1>
        </div>
        <p className="text-sm text-muted-foreground mb-10">
          Last updated: March 30, 2026
        </p>

        <div className="space-y-8 text-sm leading-relaxed text-foreground/90">
          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">1. Acceptance of Terms</h2>
            <p>
              By accessing and using the Media Common Operating Picture (MCOP), you acknowledge that you have
              read, understood, and agree to be bound by these Terms &amp; Conditions. If you do not agree to
              these terms, you should not access or use the application.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">2. Description of Service</h2>
            <p>
              MCOP is a real-time news aggregation and intelligence monitoring application designed for
              defense-related situational awareness. The service aggregates publicly available news content
              from various sources and presents it in a consolidated format to support informed decision-making.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">3. Authorized Use</h2>
            <p>
              Access to MCOP is restricted to authorized users. You agree to use the application solely for
              its intended purpose of monitoring and analyzing publicly available defense-related news and
              information. You shall not use the service for any unlawful or unauthorized purpose.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">4. Content &amp; Information</h2>
            <p>
              All news content displayed within MCOP is sourced from publicly available third-party outlets.
              MCOP does not create, endorse, or verify the accuracy of the news content it aggregates.
              Content is provided on an "as-is" basis for informational purposes only and should not be
              construed as official policy, intelligence assessments, or operational guidance.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">5. AI-Generated Analysis</h2>
            <p>
              MCOP utilizes artificial intelligence for content categorization, priority scoring, and
              analytical summaries. AI-generated outputs are automated assessments and may contain
              inaccuracies. Users should exercise independent judgment and not rely solely on AI-generated
              content for decision-making.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">6. SMS Alert Service</h2>
            <p>
              By subscribing to the SMS alert service, you consent to receiving automated text message
              notifications regarding POTUS Truth Social posts. Message frequency varies based on
              posting activity (typically 0&ndash;10 messages per day). Message and data rates may apply.
            </p>
            <p className="mt-2">
              You may opt out of SMS alerts at any time by replying <strong>STOP</strong> to any message
              or by deactivating your subscription through the application interface. Reply <strong>HELP</strong> to
              any message for assistance. The SMS service is provided on a best-effort basis and delivery
              of messages is not guaranteed. Messages are sent by MCOP via Twilio. For support,
              contact the MCOP administrator through the application.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">7. Intellectual Property</h2>
            <p>
              The MCOP application, its design, layout, and original functionality are the property of the
              MCOP development team. Third-party news content remains the intellectual property of its
              respective publishers and is displayed under fair use for informational purposes.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">8. Limitation of Liability</h2>
            <p>
              MCOP is provided "as is" without warranties of any kind, either express or implied. The
              developers and operators of MCOP shall not be liable for any direct, indirect, incidental,
              consequential, or punitive damages arising from the use of or inability to use the service,
              including but not limited to reliance on any information obtained through the application.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">9. Service Availability</h2>
            <p>
              MCOP strives to maintain continuous availability but does not guarantee uninterrupted access.
              The service may be temporarily unavailable due to maintenance, updates, or circumstances
              beyond our control. We reserve the right to modify, suspend, or discontinue the service
              at any time without prior notice.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">10. Modifications to Terms</h2>
            <p>
              These Terms &amp; Conditions may be updated at any time. Continued use of the application
              following any changes constitutes acceptance of the revised terms. Users are encouraged to
              review these terms periodically.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground mb-2">11. Contact</h2>
            <p>
              For questions regarding these Terms &amp; Conditions, please contact the MCOP administration team.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted-foreground text-center">
            Media Common Operating Picture (MCOP) &mdash; Terms &amp; Conditions
          </p>
        </div>
      </div>
    </div>
  );
}
