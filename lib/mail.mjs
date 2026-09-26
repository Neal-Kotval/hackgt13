import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import nodemailer from "nodemailer";

export function mailMode() {
  const mode = process.env.AGENTCLOUD_MAIL_MODE || "local";
  const host = new URL(process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000").hostname;
  if (mode === "local" && !["localhost", "127.0.0.1", "[::1]"].includes(host))
    throw new Error("Local email capture requires a loopback application URL. Configure SMTP for remote users.");
  if (!["local", "smtp"].includes(mode)) throw new Error("Unknown email delivery mode");
  return mode;
}
export async function sendAuthMail({ to, subject, text }) {
  const mode = mailMode();
  if (mode === "local") {
    const directory = path.resolve(process.env.AGENTCLOUD_DATA_DIR || ".agentcloud", "mail");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Authentication links belong in the private message, never application logs.
    await writeFile(path.join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ to, subject, text, capturedAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: "wx" });
    return "captured";
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error("SMTP is not configured");
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    requireTLS: port !== 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  try {
    const result = await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
    if (!result.accepted?.length) throw new Error("Email submission failed");
    return "submitted";
  } catch { throw new Error("Email submission failed. Check server SMTP configuration and retry."); }
  finally { transport.close(); }
}
