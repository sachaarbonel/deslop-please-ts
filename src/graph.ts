/** Iterative SCC traversal, adapted from deslop-please's MIT-licensed graph
 * algorithm. Copyright (c) 2026 Deterministic Machines, Inc. See LICENSE. */
export function components(edges: readonly (readonly number[])[]): number[][] {
  const indexes = new Int32Array(edges.length).fill(-1);
  const low = new Int32Array(edges.length);
  const active = new Uint8Array(edges.length);
  const stack: number[] = [];
  const found: number[][] = [];
  let next = 0;
  for (let start = 0; start < edges.length; start++) {
    if (indexes[start] !== -1) continue;
    const work = [{ node: start, edge: 0 }];
    indexes[start] = low[start] = next++;
    active[start] = 1;
    stack.push(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (!frame) break;
      const to = edges[frame.node]?.[frame.edge];
      if (to !== undefined) {
        frame.edge++;
        if (indexes[to] === -1) {
          indexes[to] = low[to] = next++;
          stack.push(to);
          active[to] = 1;
          work.push({ node: to, edge: 0 });
        } else if (active[to]) {
          low[frame.node] = Math.min(low[frame.node] ?? 0, indexes[to] ?? 0);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low[parent.node] = Math.min(low[parent.node] ?? 0, low[frame.node] ?? 0);
      if (low[frame.node] !== indexes[frame.node]) continue;
      const members: number[] = [];
      let member: number | undefined;
      do {
        member = stack.pop();
        if (member === undefined) throw new Error("invalid component stack");
        active[member] = 0;
        members.push(member);
      } while (member !== frame.node);
      if (members.length > 1) found.push(members.sort((a, b) => a - b));
    }
  }
  return found.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}
