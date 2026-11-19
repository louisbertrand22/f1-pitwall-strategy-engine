/** Pure helpers of the radio console: reply life-cycle, filters and race-control flag classification. */
import type { CarId, RaceEvent, RadioMessage, RadioQuickReply } from '../../simulation/types';

/** Most entries a log keeps in the DOM; older ones stay in the data but are not rendered. */
export const LOG_DOM_LIMIT = 150;

/** NONE: no answer expected · OPEN: waiting for the pit wall · ANSWERED · EXPIRED: the window closed unanswered. */
export type ReplyState = 'NONE' | 'OPEN' | 'ANSWERED' | 'EXPIRED';

export function replyState(message: RadioMessage, raceTime: number): ReplyState {
  if (message.quickReplies.length === 0) return 'NONE';
  if (message.repliedWith !== null) return 'ANSWERED';
  if (message.expiresAt !== null && message.expiresAt <= raceTime) return 'EXPIRED';
  return 'OPEN';
}

export function chosenReply(message: RadioMessage): RadioQuickReply | null {
  if (message.repliedWith === null) return null;
  return message.quickReplies.find((reply) => reply.id === message.repliedWith) ?? null;
}

export type CarFilter = 'ALL' | 'CAR1' | 'CAR2';
export type SeverityFilter = 'ALL' | 'WARN';

/** Team-wide messages (no car) pass every car filter. */
export function matchesRadioFilters(
  message: RadioMessage,
  carFilter: CarFilter,
  severityFilter: SeverityFilter,
  playerCarIds: readonly [CarId, CarId],
): boolean {
  if (severityFilter === 'WARN' && message.severity === 'INFO') return false;
  if (carFilter === 'ALL' || message.carId === null) return true;
  return message.carId === (carFilter === 'CAR1' ? playerCarIds[0] : playerCarIds[1]);
}

/** Last `limit` items of a list plus how many were left out. */
export function tail<T>(items: readonly T[], limit: number = LOG_DOM_LIMIT): { visible: readonly T[]; hidden: number } {
  if (items.length <= limit) return { visible: items, hidden: 0 };
  return { visible: items.slice(items.length - limit), hidden: items.length - limit };
}

export type FlagKind = 'GREEN' | 'YELLOW' | 'RED' | 'SC' | 'VSC' | 'BLUE' | 'CHEQUERED';

/**
 * Flag shown by a race-control message. `RaceEvent` carries no structured flag, so it is read from the
 * wording; returns null when the message names none.
 */
export function flagKindOf(message: string): FlagKind | null {
  const text = message.toUpperCase();
  if (/RED FLAG|RACE SUSPENDED|SESSION SUSPENDED/.test(text)) return 'RED';
  if (/CHEQUERED|CHECKERED/.test(text)) return 'CHEQUERED';
  if (/GREEN FLAG|TRACK CLEAR|TRACK IS CLEAR/.test(text)) return 'GREEN';
  if (/VIRTUAL SAFETY CAR|\bVSC\b/.test(text)) return 'VSC';
  if (/SAFETY CAR|\bSC\b/.test(text)) return 'SC';
  if (/YELLOW/.test(text)) return 'YELLOW';
  if (/BLUE FLAG/.test(text)) return 'BLUE';
  if (/\bGREEN\b|RESTART|RESUM/.test(text)) return 'GREEN';
  return null;
}

export type EventFilter = 'ALL' | 'KEY' | 'TEAM';

const KEY_EVENT_TYPES: ReadonlySet<RaceEvent['type']> = new Set<RaceEvent['type']>([
  'START',
  'FLAG',
  'INCIDENT',
  'RETIREMENT',
  'WEATHER',
  'PENALTY',
  'FINISH',
]);

/** KEY keeps what changes the race (flags, incidents, retirements, weather, penalties); TEAM what involves our cars. */
export function matchesEventFilter(event: RaceEvent, filter: EventFilter, playerCarIds: readonly [CarId, CarId]): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'TEAM') return event.carIds.some((id) => id === playerCarIds[0] || id === playerCarIds[1]);
  return KEY_EVENT_TYPES.has(event.type) || event.severity !== 'INFO';
}
