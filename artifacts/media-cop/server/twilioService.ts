import { neon } from "@neondatabase/serverless";
import { shouldSendAlert } from "./truthSocialFilter";
import { htmlToSmsText } from "./lib/htmlToSmsText";

interface TruthSocialPostData {
  content: string;
  postedAt: Date | string;
  truthSocialUrl: string;
  imageUrl?: string | null;
  extractedImageText?: string | null;
  isReblog?: boolean;
  rebloggedFrom?: string | null;
}

let smsMode: "twilio" | "termux" = "termux";

export function getSmsMode(): "twilio" | "termux" {
  return smsMode;
}

export function setSmsMode(mode: "twilio" | "termux"): void {
  smsMode = mode;
  console.log(`[SMS] Mode switched to: ${mode}`);
}

function formatMilitaryDateTime(date: Date): string {
  const eastern = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hours = eastern.getHours().toString().padStart(2, "0");
  const minutes = eastern.getMinutes().toString().padStart(2, "0");
  const day = eastern.getDate().toString().padStart(2, "0");
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const month = months[eastern.getMonth()];
  const year = eastern.getFullYear();
  return `${hours}${minutes} ${day}${month}${year}`;
}

function formatSmsMessage(post: TruthSocialPostData): string {
  const postDate = typeof post.postedAt === "string" ? new Date(post.postedAt) : post.postedAt;
  const dateStr = formatMilitaryDateTime(postDate);

  let content = htmlToSmsText(post.content);
  content = content.replace(/\s+/g, " ").trim();

  const prefix = `MCOP Alert: At ${dateStr}, POTUS posted on Truth Social: `;
  const suffix = ` ${post.truthSocialUrl}`;
  const maxContentLength = 1500 - prefix.length - suffix.length;

  if (content.length > maxContentLength) {
    content = content.substring(0, maxContentLength - 3) + "...";
  }

  return `${prefix}${content}${suffix}`;
}

async function getActiveSubscribers(): Promise<Array<{ id: string; phoneNumber: string; name: string }>> {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = await sql`SELECT id, phone_number as "phoneNumber", name FROM sms_alert_subscribers WHERE is_active = true`;
  return rows as any[];
}

async function queueSms(toNumber: string, body: string, direction: string = "outbound"): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);
  await sql`INSERT INTO sms_queue (to_number, body, status, direction) VALUES (${toNumber}, ${body}, 'pending', ${direction})`;
}

async function sendViaTwilio(toNumber: string, body: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Twilio not configured");
  }

  const twilio = await import("twilio");
  const client = twilio.default(accountSid, authToken);
  await client.messages.create({ body, from: fromNumber, to: toNumber });
}

async function sendSmsToNumber(toNumber: string, body: string): Promise<void> {
  if (smsMode === "termux") {
    await queueSms(toNumber, body, "outbound");
    console.log(`[SMS] Queued for Termux: ${toNumber} (${body.length} chars)`);
  } else {
    await sendViaTwilio(toNumber, body);
  }
}

export async function sendPOTUSAlert(post: TruthSocialPostData, bypassFilter: boolean = false): Promise<void> {
  if (smsMode === "twilio") {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid || !authToken || !fromNumber) return;
  }

  if (!bypassFilter) {
    const filterResult = await shouldSendAlert(post);
    if (!filterResult.include) {
      console.log(`[SMS] Filtered out post: ${filterResult.reason} — "${post.content?.substring(0, 60)}..."`);
      return;
    }
    console.log(`[SMS] Post passed filter: ${filterResult.reason}`);
  }

  try {
    const subscribers = await getActiveSubscribers();
    if (subscribers.length === 0) {
      console.log("[SMS] No active subscribers, skipping SMS send");
      return;
    }

    const message = formatSmsMessage(post);
    console.log(`[SMS] Sending alert to ${subscribers.length} subscriber(s) via ${smsMode}...`);

    for (const subscriber of subscribers) {
      try {
        await sendSmsToNumber(subscriber.phoneNumber, message);
        console.log(`[SMS] ${smsMode === "termux" ? "Queued" : "Sent"} to ${subscriber.name} (${subscriber.phoneNumber})`);
      } catch (error: any) {
        console.error(`[SMS] Failed for ${subscriber.name} (${subscriber.phoneNumber}):`, error?.message || error);
      }
    }
  } catch (error) {
    console.error("[SMS] Error in sendPOTUSAlert:", error);
  }
}

// Operational/system alert (Task #1020) — sends a raw message to every active
// SMS subscriber via the existing send path (Termux queue or Twilio). Unlike
// sendPOTUSAlert this never runs the content filter: it is for MCOP system
// alerts (e.g. relay-outage escalation), not POTUS post notifications.
export async function sendOpsAlert(body: string): Promise<void> {
  const subscribers = await getActiveSubscribers();
  if (subscribers.length === 0) {
    console.log("[SMS] No active subscribers, skipping ops alert");
    return;
  }
  console.log(`[SMS] Sending ops alert to ${subscribers.length} subscriber(s) via ${smsMode}...`);
  for (const subscriber of subscribers) {
    try {
      await sendSmsToNumber(subscriber.phoneNumber, body);
      console.log(`[SMS] Ops alert ${smsMode === "termux" ? "queued" : "sent"} to ${subscriber.name} (${subscriber.phoneNumber})`);
    } catch (error: any) {
      console.error(`[SMS] Ops alert failed for ${subscriber.name} (${subscriber.phoneNumber}):`, error?.message || error);
    }
  }
}

// Custom ad-hoc message from the SMS Alerts panel (Task #1073). Sends a
// team-composed message to a selection of active subscribers through the
// existing per-number send path (inherits Twilio/Termux mode + queueing).
// Returns per-recipient outcomes so the UI can report partial failures.
export interface CustomSmsRecipientResult {
  id: string;
  name: string;
  phoneNumber: string;
  success: boolean;
  queued: boolean;
  error?: string;
}

export async function sendCustomSms(
  body: string,
  recipients: Array<{ id: string; name: string; phoneNumber: string }>,
): Promise<CustomSmsRecipientResult[]> {
  const message = `MCOP Alert: ${body}`;
  console.log(`[SMS] Sending custom message to ${recipients.length} recipient(s) via ${smsMode} (${message.length} chars)`);
  const results: CustomSmsRecipientResult[] = [];
  for (const r of recipients) {
    try {
      await sendSmsToNumber(r.phoneNumber, message);
      console.log(`[SMS] Custom message ${smsMode === "termux" ? "queued" : "sent"} to ${r.name} (${r.phoneNumber})`);
      results.push({ id: r.id, name: r.name, phoneNumber: r.phoneNumber, success: true, queued: smsMode === "termux" });
    } catch (error: any) {
      console.error(`[SMS] Custom message failed for ${r.name} (${r.phoneNumber}):`, error?.message || error);
      results.push({ id: r.id, name: r.name, phoneNumber: r.phoneNumber, success: false, queued: false, error: error?.message || "Unknown error" });
    }
  }
  return results;
}

export async function sendTestSms(phoneNumber: string): Promise<{ success: boolean; error?: string }> {
  const testBody = "MCOP Alert Test: This is a test message from the MCOP system. If you received this, SMS alerts are working correctly.";

  try {
    if (smsMode === "termux") {
      await queueSms(phoneNumber, testBody, "outbound");
      return { success: true };
    }

    await sendViaTwilio(phoneNumber, testBody);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || "Unknown error sending test SMS" };
  }
}

export function isTwilioConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
}

export function isSmsConfigured(): boolean {
  if (smsMode === "termux") return true;
  return isTwilioConfigured();
}

export async function handleInboundSms(fromNumber: string, body: string): Promise<string> {
  const question = body.trim();

  if (!question || question.length < 3) {
    return "MCOP Bot: Please send a question with at least 3 characters. Example: \"What are the latest developments in the Middle East?\"";
  }

  if (question.length > 500) {
    return "MCOP Bot: Please keep your question under 500 characters.";
  }

  const subscribers = await getActiveSubscribers();
  const normalized = fromNumber.replace(/\D/g, "");
  const isSubscriber = subscribers.some(s => s.phoneNumber.replace(/\D/g, "") === normalized);

  if (!isSubscriber) {
    return "MCOP Bot: Your number is not registered for MCOP alerts. Subscribe at the MCOP Team page to use this feature.";
  }

  try {
    console.log(`[SMS-Bot] Question from ${fromNumber}: "${question.substring(0, 80)}..."`);
    const { answerQuestion } = await import("./newsbot");
    const answer = await answerQuestion(question);

    let cleaned = answer
      .replace(/#{1,4}\s/g, "")
      .replace(/\*\*/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^[-*]\s/gm, "- ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const prefix = "MCOP Bot:\n";
    const maxLen = 1600 - prefix.length;

    if (cleaned.length > maxLen) {
      cleaned = cleaned.substring(0, maxLen - 30) + "\n\n[Response truncated for SMS]";
    }

    console.log(`[SMS-Bot] Response to ${fromNumber}: ${cleaned.length} chars`);
    return prefix + cleaned;
  } catch (error: any) {
    console.error(`[SMS-Bot] Error processing question from ${fromNumber}:`, error?.message || error);
    return "MCOP Bot: Sorry, I encountered an error processing your question. Please try again.";
  }
}

export async function sendSmsReply(toNumber: string, message: string): Promise<void> {
  const segments: string[] = [];
  if (message.length <= 1600) {
    segments.push(message);
  } else {
    let remaining = message;
    let part = 1;
    while (remaining.length > 0) {
      const chunkSize = 1550;
      let chunk = remaining.substring(0, chunkSize);
      if (remaining.length > chunkSize) {
        const lastNewline = chunk.lastIndexOf("\n");
        if (lastNewline > chunkSize * 0.5) {
          chunk = chunk.substring(0, lastNewline);
        }
      }
      segments.push(chunk);
      remaining = remaining.substring(chunk.length).trim();
      part++;
      if (part > 3) {
        segments.push("[Response continues — ask a more specific question for shorter answers]");
        break;
      }
    }
  }

  for (const segment of segments) {
    try {
      await sendSmsToNumber(toNumber, segment);
    } catch (error: any) {
      console.error(`[SMS-Bot] Failed to send reply to ${toNumber}:`, error?.message || error);
    }
  }
}
