export type ShareRole = "owner" | "admin" | "full" | "readonly";
export const canManageShares = (role: ShareRole) => role !== "readonly";
export const canRevealSharePassword = (role: ShareRole) => role === "owner" || role === "admin";

export function descendantFolderPaths(folders: Array<{ id: string; parentId: string | null; name: string }>, rootId: string): Map<string, string> {
  const paths = new Map([[rootId, ""]]);
  const children = new Map<string, typeof folders>();
  for (const folder of folders) {
    if (folder.parentId) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
  }
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (paths.has(child.id)) continue;
      paths.set(child.id, `${paths.get(queue[i])}${child.name}/`);
      queue.push(child.id);
    }
  }
  return paths;
}
