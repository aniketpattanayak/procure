import { Injectable, Logger } from '@nestjs/common';
import { DeliveryStatusService } from './platform/delivery-status.service';
import { ProviderStore } from './platform/providers.store';
import { safeEqualHex, verifyMetaSignature } from './util/signature';
import { CertFetcher, httpCertFetcher, isSnsUrl, SnsMessage, verifySnsMessage } from './util/sns';

interface MetaStatus { id?: string; status?: string; timestamp?: string; errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[] }

/**
 * Inbound provider webhooks (public routes). Meta: GET verify (hub.verify_token) + POST statuses signed with the app
 * secret (X-Hub-Signature-256 over the raw body). SES: SNS notifications (signature verified against the AWS
 * certificate; SubscriptionConfirmation auto-confirmed). Both update outbound_message delivery status.
 */
@Injectable()
export class HooksService {
  private readonly log = new Logger('Notify');
  /** Test seams. */
  certFetcher: CertFetcher = httpCertFetcher;
  confirmSubscription: (url: string) => Promise<void> = async url => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!res.ok) throw new Error(`SNS subscription confirmation failed (${res.status})`);
  };

  constructor(private readonly providers: ProviderStore, private readonly status: DeliveryStatusService) {}

  async metaVerify(mode: string | undefined, token: string | undefined, challenge: string | undefined): Promise<string | null> {
    if (mode !== 'subscribe' || !token || !challenge) return null;
    const secrets = await this.providers.metaSecrets();
    return secrets.some(s => s.verifyToken && safeEqualHex(s.verifyToken, token)) ? challenge : null;
  }

  /** Returns false when the signature does not match any configured Meta app secret (→ 401). */
  async metaNotify(raw: Buffer | undefined, signature: string | undefined): Promise<{ ok: boolean; updated: number }> {
    if (!raw || !raw.length) return { ok: false, updated: 0 };
    const secrets = await this.providers.metaSecrets();
    if (!secrets.some(s => verifyMetaSignature(raw, signature, s.appSecret))) return { ok: false, updated: 0 };
    let body: { entry?: { changes?: { value?: { statuses?: MetaStatus[] } }[] }[] };
    try { body = JSON.parse(raw.toString('utf8')); } catch { return { ok: true, updated: 0 }; }
    let updated = 0;
    for (const e of body.entry ?? []) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
      const ev = s.status === 'sent' || s.status === 'delivered' || s.status === 'read' || s.status === 'failed' ? s.status : null;
      if (!ev || !s.id) continue;
      const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
      const err = s.errors?.[0];
      updated += await this.status.apply('meta', s.id, ev, at, err ? `${err.code ?? ''} ${err.title ?? err.message ?? ''} ${err.error_data?.details ?? ''}`.trim() : null);
    }
    return { ok: true, updated };
  }

  /** Returns false for an unverifiable message (→ 401). */
  async sesNotify(raw: Buffer): Promise<{ ok: boolean; updated: number; confirmed?: boolean }> {
    let m: SnsMessage;
    try { m = JSON.parse(raw.toString('utf8')) as SnsMessage; } catch { return { ok: false, updated: 0 }; }
    if (!(await verifySnsMessage(m, this.certFetcher))) return { ok: false, updated: 0 };
    const topics = await this.providers.sesTopics();
    if (topics.length && !topics.includes(m.TopicArn)) return { ok: false, updated: 0 };
    if (m.Type === 'SubscriptionConfirmation') {
      if (!isSnsUrl(m.SubscribeURL)) return { ok: false, updated: 0 };
      await this.confirmSubscription(m.SubscribeURL!);
      return { ok: true, updated: 0, confirmed: true };
    }
    if (m.Type !== 'Notification') return { ok: true, updated: 0 };
    let n: { eventType?: string; notificationType?: string; mail?: { messageId?: string; timestamp?: string }; delivery?: { timestamp?: string };
      bounce?: { bounceType?: string; bouncedRecipients?: { diagnosticCode?: string; emailAddress?: string }[]; timestamp?: string };
      open?: { timestamp?: string }; reject?: { reason?: string }; failure?: { errorMessage?: string } };
    try { n = JSON.parse(m.Message); } catch { return { ok: true, updated: 0 }; }
    const id = n.mail?.messageId;
    if (!id) return { ok: true, updated: 0 };
    const kind = n.eventType ?? n.notificationType;
    const at = (t?: string) => (t && !Number.isNaN(Date.parse(t)) ? new Date(t) : new Date());
    let updated = 0;
    switch (kind) {
      case 'Delivery': updated = await this.status.apply('ses', id, 'delivered', at(n.delivery?.timestamp)); break;
      case 'Open': updated = await this.status.apply('ses', id, 'read', at(n.open?.timestamp)); break;
      case 'Bounce':
        if (n.bounce?.bounceType === 'Permanent') {
          const r = n.bounce.bouncedRecipients?.[0];
          updated = await this.status.apply('ses', id, 'failed', at(n.bounce.timestamp), `Bounced: ${r?.diagnosticCode ?? r?.emailAddress ?? 'permanent bounce'}`);
        }
        break;
      case 'Reject': updated = await this.status.apply('ses', id, 'failed', new Date(), `Rejected: ${n.reject?.reason ?? ''}`.trim()); break;
      case 'Rendering Failure': updated = await this.status.apply('ses', id, 'failed', new Date(), `Rendering failure: ${n.failure?.errorMessage ?? ''}`.trim()); break;
      default: break;
    }
    return { ok: true, updated };
  }
}
