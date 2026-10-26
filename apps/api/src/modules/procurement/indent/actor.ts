import type { MyPermissions } from '@procure/schema';
import { tenantPrincipal } from '../../../core/request-context';
import type { DocActor } from '../../documents';

const NO_PERMS: MyPermissions = { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };

/** The calling tenant user as a documents-core actor. */
export function procActor(perms: MyPermissions | undefined): DocActor {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? NO_PERMS };
}
