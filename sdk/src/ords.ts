/**
 * Browse and search return full station ORDs ("local:|station:|slot:/Drivers/…"), while point,
 * history and schedule operations take "slot:/…". This keeps the slot part; other ORDs
 * (hierarchy:, history:) are returned unchanged.
 */
export function toSlotOrd(ord: string): string {
  const match = /(?:^|\|)(slot:\/.*)$/.exec(ord);
  return match ? match[1] : ord;
}
