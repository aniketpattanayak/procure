import {
  Banknote, Building2, ClipboardList, FileText, Hammer, Package, Receipt, ShoppingCart, Truck, Wrench, type LucideIcon,
} from 'lucide-react';

/** Icons a document type can use in the sidebar (stored as `settings.icon`). */
export const DOC_TYPE_ICONS: Record<string, LucideIcon> = {
  'file-text': FileText,
  'clipboard-list': ClipboardList,
  receipt: Receipt,
  banknote: Banknote,
  'shopping-cart': ShoppingCart,
  package: Package,
  truck: Truck,
  wrench: Wrench,
  hammer: Hammer,
  building: Building2,
};

export function DocTypeIcon({ name, className }: { name: string | undefined; className?: string }) {
  const I = (name && DOC_TYPE_ICONS[name]) || FileText;
  return <I className={className} aria-hidden />;
}
