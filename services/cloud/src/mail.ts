/**
 * Outgoing mail for email magic links. Transports:
 * - `log`: prints the link to stdout (development only — the link is a credential).
 * - `webhook`: POSTs `{ to, subject, text, link, kind }` JSON to `GH_CLOUD_MAIL_WEBHOOK`, which the
 *   operator bridges to their mail provider.
 */
import type { CloudConfig } from './config.ts';
import type { FetchLike } from './context.ts';

export interface MailMessage {
  kind: 'magic-link';
  to: string;
  subject: string;
  text: string;
  link: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function createMailer(config: CloudConfig, fetchImpl: FetchLike): Mailer {
  if (config.mailTransport === 'webhook' && config.mailWebhook) {
    const url = config.mailWebhook;
    return {
      async send(message) {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'githappens-cloud' },
          body: JSON.stringify(message),
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`mail webhook returned HTTP ${res.status}`);
      },
    };
  }
  return {
    async send(message) {
      // Deliberately outside the JSON logger: dev-only transport that must show the link.
      process.stdout.write(`\n[githappens-cloud] magic link for ${message.to}:\n  ${message.link}\n\n`);
    },
  };
}
