'use client';
/**
 * Phase 6 additions to every document detail page (registered through features/documents/extensions.ts):
 * "Print / PDF" and "Send" header actions, and a "Messages" tab with delivery status.
 */
import type { DocumentRow } from '@procure/schema';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@procure/ui';
import { ChevronDown, Mail, MessageCircle, Printer, Send } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { registerDocAction, registerDocTab, type DocExtensionProps } from '@/features/documents/extensions';
import { t } from '@/i18n';
import { usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import type { MessageChannel } from './api';

const PrintDialog = dynamic(() => import('./print-dialog').then(m => m.PrintDialog), { ssr: false });
const SendDialog = dynamic(() => import('./send-dialog').then(m => m.SendDialog), { ssr: false });
const DocMessages = dynamic(() => import('@/features/messages/doc-messages').then(m => m.DocMessages), { ssr: false });

/** Drafts have no number and nothing to print or send yet. */
const sendable = (doc: DocumentRow) => !!doc.submittedAt || !!doc.number;

function PrintAction({ docType, doc }: DocExtensionProps) {
  const p = usePermissions();
  const [open, setOpen] = useState(false);
  if (!p.has(`doc.${docType.key}:action.print`) || !sendable(doc)) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="print-button"><Printer aria-hidden />{t('print.button')}</Button>
      {open && <PrintDialog docType={docType} doc={doc} onClose={() => setOpen(false)} />}
    </>
  );
}

function SendAction({ docType, doc }: DocExtensionProps) {
  const p = usePermissions();
  const { features } = useSession();
  const [channel, setChannel] = useState<MessageChannel | null>(null);
  const channels: MessageChannel[] = [];
  if (features.has('email') && p.has(`doc.${docType.key}:action.send_email`)) channels.push('email');
  if (features.has('whatsapp') && p.has(`doc.${docType.key}:action.send_whatsapp`)) channels.push('whatsapp');
  if (!channels.length || !sendable(doc)) return null;
  return (
    <>
      {channels.length === 1 ? (
        <Button variant="secondary" onClick={() => setChannel(channels[0]!)} data-testid="send-button">
          {channels[0] === 'email' ? <Mail aria-hidden /> : <MessageCircle aria-hidden />}{t(channels[0] === 'email' ? 'send.byEmail' : 'send.byWhatsApp')}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="secondary" data-testid="send-button"><Send aria-hidden />{t('send.button')}<ChevronDown className="-mr-1" aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setChannel('email')} data-testid="send-menu-email"><Mail className="size-4" aria-hidden />{t('send.byEmail')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setChannel('whatsapp')} data-testid="send-menu-whatsapp"><MessageCircle className="size-4" aria-hidden />{t('send.byWhatsApp')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {channel && <SendDialog docType={docType} doc={doc} channels={channels} initialChannel={channel} onClose={() => setChannel(null)} />}
    </>
  );
}

registerDocAction({ key: 'notify.print', order: 10, Component: PrintAction });
registerDocAction({ key: 'notify.send', order: 11, Component: SendAction });
registerDocTab({ key: 'messages', order: 60, label: () => t('msg.tab'), Component: ({ docType, doc }) => <DocMessages type={docType.key} doc={doc} /> });
