import type { ThreadItem, Turn } from './protocol';

/** Clear superseded Resume actions while visiting each history item once. */
export function replayHistory(turns: Turn[], visit: (item: ThreadItem, turn: Turn) => void) {
 for (let index = 0; index < turns.length; index++) {
  const turn = turns[index];
  for (const item of turn.items ?? []) {
   if (!item.id) continue;
   const note = item as ThreadItem & { resumeAvailable?: boolean };
   visit(index < turns.length - 1 && note.type === 'localNote' && note.resumeAvailable
    ? { ...note, resumeAvailable: false } : item, turn);
  }
 }
}
