import type { LocationNode } from '@procure/schema';

export interface TreeNode {
  id: string;
  node: LocationNode;
  children: TreeNode[];
  parent: TreeNode | null;
}

export interface LocationTree {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
}

const byOrder = (a: TreeNode, b: TreeNode) => a.node.sortOrder - b.node.sortOrder || a.node.name.localeCompare(b.node.name);

/** Builds the tree from the flat, path-ordered list returned by /locations/tree. Orphans (parent filtered out) become roots. */
export function buildTree(nodes: readonly LocationNode[]): LocationTree {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { id: n.id, node: n, children: [], parent: null });
  const roots: TreeNode[] = [];
  for (const tn of byId.values()) {
    const p = tn.node.parentId ? byId.get(tn.node.parentId) : undefined;
    if (p) { tn.parent = p; p.children.push(tn); } else roots.push(tn);
  }
  for (const tn of byId.values()) tn.children.sort(byOrder);
  roots.sort(byOrder);
  return { roots, byId };
}

export function descendantIds(tn: TreeNode, out = new Set<string>()): Set<string> {
  for (const c of tn.children) { out.add(c.id); descendantIds(c, out); }
  return out;
}

export function ancestorIds(tn: TreeNode): string[] {
  const out: string[] = [];
  for (let p = tn.parent; p; p = p.parent) out.push(p.id);
  return out;
}

/** Ids to show for a search: every match plus its ancestors. Returns null when there's no query. */
export function searchVisible(tree: LocationTree, q: string): { visible: Set<string>; matches: Set<string> } | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const visible = new Set<string>();
  const matches = new Set<string>();
  for (const tn of tree.byId.values()) {
    if (tn.node.name.toLowerCase().includes(needle) || tn.node.code.toLowerCase().includes(needle)) {
      matches.add(tn.id);
      visible.add(tn.id);
      for (const a of ancestorIds(tn)) visible.add(a);
    }
  }
  return { visible, matches };
}

/** Level name for a depth (1-based) from the `labels.location_levels` setting; deeper levels reuse the last. */
export function levelName(levels: readonly string[] | undefined, depth: number, fallback: string): string {
  if (!levels?.length) return fallback;
  return levels[Math.min(depth, levels.length) - 1] ?? fallback;
}

/** Names from the root down to and including this node (`pathNames` may or may not include the node itself). */
export function fullPath(n: LocationNode): string[] {
  return n.pathNames.at(-1) === n.name && n.pathNames.length === n.depth ? n.pathNames : [...n.pathNames, n.name];
}
/** Names of the ancestors only. */
export function ancestorPath(n: LocationNode): string[] {
  return fullPath(n).slice(0, -1);
}
