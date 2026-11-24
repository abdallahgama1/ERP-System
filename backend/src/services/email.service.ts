import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config.ts";
import { createModuleLogger } from "../logging/logger.ts";

const log = createModuleLogger("email");

export interface EmailAttachmentInput {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface SendEmailInput {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachmentInput[];
}

export interface SendEmailResult {
  sent: boolean;
  messageId?: string;
  skippedReason?: string;
}

export interface EmailTransportLike {
  sendMail(mailOptions: {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: EmailAttachmentInput[];
  }): Promise<{ messageId?: string } | void>;
}

let cachedTransporter: Transporter | null = null;
let testTransportOverride: EmailTransportLike | null = null;

export function setEmailTransportForTests(transport: EmailTransportLike | null): void {
  testTransportOverride = transport;
}

export function isEmailConfigured(): boolean {
  return Boolean(testTransportOverride || env.SMTP_HOST);
}

function getTransporter(): EmailTransportLike | null {
  if (testTransportOverride) return testTransportOverride;
  if (!env.SMTP_HOST) return null;
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER
        ? {
            auth: {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS,
            },
          }
        : {}),
    });
  }
  return cachedTransporter;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((e) => e.trim())
    .filter(Boolean);
  const ccRecipients = (input.cc ? (Array.isArray(input.cc) ? input.cc : [input.cc]) : [])
    .map((e) => e.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    return { sent: false, skippedReason: "no_recipients" };
  }

  if (!testTransportOverride && env.NODE_ENV === "test") {
    return { sent: false, skippedReason: "test_environment" };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return { sent: false, skippedReason: "smtp_not_configured" };
  }

  try {
    const info = await transporter.sendMail({
      from: env.SMTP_FROM,
      to: recipients.join(", "),
      ...(ccRecipients.length > 0 ? { cc: ccRecipients.join(", ") } : {}),
      subject: input.subject,
      text: input.text,
      html: input.html,
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    });
    const messageId =
      info && typeof info === "object" && "messageId" in info && typeof info.messageId === "string"
        ? info.messageId
        : undefined;
    return { sent: true, messageId };
  } catch (err) {
    log.warn({ err }, "Failed to send SMTP email");
    return { sent: false, skippedReason: "smtp_error" };
  }
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<SendEmailResult> {
  const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;
  return sendEmail({
    to,
    subject: "Reset your ERP password",
    text: `A password reset was requested for your account.\n\nOpen the link below within 60 minutes to choose a new password:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`,
    html: `<p>A password reset was requested for your account.</p><p><a href="${resetUrl}">Reset Password</a> (valid for 60 minutes)</p><p>If you did not request this, you can safely ignore this email.</p>`,
  });
}

export async function sendApprovalRequestEmail(
  toList: string[],
  details: { entityType: string; entityNumber: string; amount: number; requestedByName: string }
): Promise<SendEmailResult> {
  const approvalsUrl = `${env.APP_BASE_URL}/approvals`;
  return sendEmail({
    to: toList,
    subject: `Approval Required: ${details.entityNumber}`,
    text: `${details.requestedByName} submitted ${details.entityType} ${details.entityNumber} (amount ${details.amount.toFixed(2)}) for approval.\n\nReview in ERP: ${approvalsUrl}`,
    html: `<p><strong>${details.requestedByName}</strong> submitted <strong>${details.entityNumber}</strong> (${details.entityType}) for approval (amount: ${details.amount.toFixed(2)}).</p><p><a href="${approvalsUrl}">Open Approvals Queue</a></p>`,
  });
}

export async function sendOverdueDigestEmail(
  toList: string[],
  summary: {
    overdueInvoicesMarked: number;
    overdueBillsMarked: number;
    expiringLotsAlerted: number;
    expiredLotsAlerted: number;
  }
): Promise<SendEmailResult> {
  const notificationsUrl = `${env.APP_BASE_URL}/notifications`;
  return sendEmail({
    to: toList,
    subject: "ERP Daily Overdue & Expiry Digest",
    text:
      `Overdue & Expiry Sweep Summary:\n` +
      `- Newly Overdue Sales Invoices: ${summary.overdueInvoicesMarked}\n` +
      `- Newly Overdue Vendor Bills: ${summary.overdueBillsMarked}\n` +
      `- Expired Stock Lots: ${summary.expiredLotsAlerted}\n` +
      `- Lots Expiring Within 30 Days: ${summary.expiringLotsAlerted}\n\n` +
      `View Alerts: ${notificationsUrl}`,
  });
}
