import { Resend } from 'resend';

export async function getUncachableResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'MCOP <noreply@resend.dev>';
  
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured. Please add your Resend API key in the Secrets tab.');
  }
  
  return {
    client: new Resend(apiKey),
    fromEmail: fromEmail
  };
}
