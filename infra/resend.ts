import { Resend } from "resend";
import { config } from "../src/config.js";

export async function sendReportEmail(
  markdownContent: string,
  _mdPath: string,
  dateStr: string
): Promise<void> {
  if (!config.RESEND_API_KEY || !config.REPORT_EMAIL_TO) {
    console.log("  Resend not configured, skipping email");
    return;
  }

  const resend = new Resend(config.RESEND_API_KEY);

  // Use onboarding@resend.dev for testing, or your verified domain in prod
  const from = config.REPORT_EMAIL_FROM ?? "onboarding@resend.dev";

  const htmlBody = `
    <h2>Review Analytics Report — ${dateStr}</h2>
    <p>Your Amazon product review analytics report is ready.</p>
    <p>The full Markdown report is attached.</p>
    <hr/>
    <pre style="font-size:12px;background:#f4f4f4;padding:1rem;border-radius:4px;overflow:auto;white-space:pre-wrap;">${
      markdownContent.slice(0, 3000)
    }${markdownContent.length > 3000 ? "\n\n... (see attachment for full report)" : ""}</pre>
  `;

  await resend.emails.send({
    from,
    to: config.REPORT_EMAIL_TO,
    subject: `Review Analytics Report — ${dateStr}`,
    html: htmlBody,
    attachments: [
      {
        content: Buffer.from(markdownContent).toString("base64"),
        filename: `report-${dateStr}.md`,
      },
    ],
  });
}
