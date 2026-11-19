import { memo, useCallback, useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUpDown,
  BellRing,
  Car,
  Check,
  CircleDot,
  CircleX,
  CloudRain,
  CornerDownRight,
  Flag,
  FlagTriangleRight,
  Fuel,
  Gavel,
  Hourglass,
  Info,
  Play,
  Radio,
  Route,
  Scissors,
  Thermometer,
  Timer,
  TimerOff,
  TriangleAlert,
  Users,
  Wind,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type { RadioConsoleProps } from './contracts';
import type { CarId, FlagStatus, RaceEvent, RaceEventType, RadioCategory, RadioMessage, RadioQuickReply, Severity } from '../simulation/types';
import { formatRaceClock } from '../lib/format';
import { indexSession } from '../lib/session';
import { DriverTag, Panel, Segmented } from './ui';
import type { SegmentedOption } from './ui';
import { StatusWord, Tag, useLatest, useStickToBottom } from './controls/shared';
import type { Tone } from './controls/shared';
import { chosenReply, flagKindOf, matchesEventFilter, matchesRadioFilters, replyState, tail } from './controls/radioModel';
import type { CarFilter, EventFilter, FlagKind, ReplyState, SeverityFilter } from './controls/radioModel';

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string; 'aria-hidden'?: boolean }>;
type View = 'RADIO' | 'CONTROL';

/** Snapshots (≈10 Hz) a sent reply waits for its echo before its buttons are released again. */
const REPLY_ECHO_SNAPSHOTS = 40;

const SEVERITY_TONE: Record<Severity, Tone> = { INFO: 'neutral', WARN: 'warn', CRITICAL: 'crit' };
const SEVERITY_LABEL: Record<Severity, string> = { INFO: 'Info', WARN: 'Warn', CRITICAL: 'Critical' };
const SEVERITY_EDGE: Record<Severity, string> = {
  INFO: 'border-l-transparent',
  WARN: 'border-l-warn',
  CRITICAL: 'border-l-crit bg-crit/5',
};

const CATEGORY: Record<RadioCategory, { label: string; icon: IconType }> = {
  TYRES: { label: 'Tyres', icon: CircleDot },
  STRATEGY: { label: 'Strategy', icon: Route },
  UNDERCUT: { label: 'Undercut', icon: Scissors },
  WEATHER: { label: 'Weather', icon: CloudRain },
  TEMPS: { label: 'Temps', icon: Thermometer },
  FUEL: { label: 'Fuel', icon: Fuel },
  ERS: { label: 'ERS', icon: Zap },
  TRAFFIC: { label: 'Traffic', icon: Car },
  INCIDENT: { label: 'Incident', icon: TriangleAlert },
  PIT: { label: 'Pit', icon: Wrench },
  TEAM_ORDER: { label: 'Team order', icon: Users },
  INFO: { label: 'Info', icon: Info },
};

const EVENT_TYPE: Record<RaceEventType, { label: string; icon: IconType }> = {
  START: { label: 'Start', icon: Play },
  FLAG: { label: 'Flag', icon: Flag },
  INCIDENT: { label: 'Incident', icon: TriangleAlert },
  RETIREMENT: { label: 'Retired', icon: CircleX },
  PIT: { label: 'Pit', icon: Wrench },
  OVERTAKE: { label: 'Overtake', icon: ArrowUpDown },
  FASTEST_LAP: { label: 'Fastest', icon: Timer },
  WEATHER: { label: 'Weather', icon: CloudRain },
  DRS: { label: 'DRS', icon: Wind },
  TEAM_ORDER: { label: 'Orders', icon: Users },
  PENALTY: { label: 'Penalty', icon: Gavel },
  FINISH: { label: 'Finish', icon: FlagTriangleRight },
};

const FLAG_STYLE: Record<FlagKind, { label: string; frame: string; ink: string }> = {
  GREEN: { label: 'Green', frame: 'border-flag-green/60 bg-flag-green/15', ink: 'text-flag-green' },
  YELLOW: { label: 'Yellow', frame: 'border-flag-yellow/60 bg-flag-yellow/15', ink: 'text-flag-yellow' },
  RED: { label: 'Red flag', frame: 'border-flag-red/60 bg-flag-red/15', ink: 'text-flag-red' },
  SC: { label: 'Safety car', frame: 'border-flag-sc/60 bg-flag-sc/15', ink: 'text-flag-sc' },
  VSC: { label: 'VSC', frame: 'border-flag-sc/60 bg-flag-sc/15', ink: 'text-flag-sc' },
  BLUE: { label: 'Blue', frame: 'border-flag-blue/60 bg-flag-blue/15', ink: 'text-flag-blue' },
  CHEQUERED: { label: 'Chequered', frame: 'border-ink-300/60 bg-ink-100/10', ink: 'text-ink-100' },
};

const TRACK_STATUS: Record<FlagStatus, FlagKind> = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  VSC: 'VSC',
  SC: 'SC',
  RED: 'RED',
  CHEQUERED: 'CHEQUERED',
};

const SPEAKER_LABEL: Record<Exclude<RadioMessage['from'], 'DRIVER'>, string> = {
  ENGINEER: 'Eng',
  STRATEGY: 'Strat',
  PIT_WALL: 'Pit wall',
};

const SEGMENTED_SMALL = '[&>button]:px-1.5 [&>button]:py-1';

const VIEW_SEVERITY_OPTIONS: readonly SegmentedOption<SeverityFilter>[] = [
  { value: 'ALL', label: 'All', title: 'Every message' },
  { value: 'WARN', label: 'Warn+', title: 'Warnings and critical messages only' },
];

const EVENT_FILTER_OPTIONS: readonly SegmentedOption<EventFilter>[] = [
  { value: 'ALL', label: 'All', title: 'Every race-control entry' },
  { value: 'KEY', label: 'Key', title: 'Flags, incidents, retirements, weather and penalties' },
  { value: 'TEAM', label: 'Team', title: 'Entries involving our cars' },
];

interface CarTag {
  code: string;
  color: string;
  carNumber: 1 | 2;
}

// ───────────────────────────────────────────────────────────── shared bits ──

function Stamp({ lap, raceTime }: { lap: number; raceTime: number }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-[10px] leading-3 tabular">
      <span className="text-ink-300">L{lap}</span>
      <span className="text-ink-500">{formatRaceClock(raceTime)}</span>
    </span>
  );
}

function Speaker({ message, tag }: { message: RadioMessage; tag: CarTag | null }) {
  if (message.from === 'DRIVER') {
    return tag ? <DriverTag code={tag.code} color={tag.color} carNumber={tag.carNumber} strong /> : <Tag>Driver</Tag>;
  }
  const own = message.from === 'PIT_WALL';
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Tag className={own ? 'border-ink-300 text-ink-50' : ''}>{SPEAKER_LABEL[message.from]}</Tag>
      {tag ? (
        <>
          <span aria-hidden className="text-[10px] leading-none text-ink-500">
            {own ? '→' : '·'}
          </span>
          <DriverTag code={tag.code} color={tag.color} />
        </>
      ) : null}
    </span>
  );
}

function CategoryMark({ category }: { category: RadioCategory }) {
  const { label, icon: Icon } = CATEGORY[category];
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Icon size={10} strokeWidth={1.75} aria-hidden className="text-ink-500" />
      <span className="pw-label">{label}</span>
    </span>
  );
}

function ReplyButton({ reply, disabled, sending, onClick }: { reply: RadioQuickReply; disabled: boolean; sending: boolean; onClick: () => void }) {
  const confirm = reply.tone === 'CONFIRM';
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={sending}
      onClick={onClick}
      className={
        confirm
          ? `inline-flex items-center gap-1 rounded-[2px] border border-ink-100 bg-ink-100 px-1.5 py-1 font-display text-2xs font-bold uppercase leading-none tracking-[0.08em] text-carbon-950 transition-colors hover:border-ink-50 hover:bg-ink-50 disabled:opacity-50`
          : 'pw-btn px-1.5 py-1 tracking-[0.08em]'
      }
    >
      {confirm ? (
        <Check size={11} strokeWidth={2} aria-hidden />
      ) : reply.tone === 'DENY' ? (
        <X size={11} strokeWidth={1.75} aria-hidden />
      ) : null}
      <span className="whitespace-nowrap">{reply.label}</span>
    </button>
  );
}

function Replies({
  message,
  state,
  sendingReplyId,
  onReply,
}: {
  message: RadioMessage;
  state: ReplyState;
  sendingReplyId: string | null;
  onReply: (messageId: number, replyId: string) => void;
}) {
  if (state === 'NONE') return null;
  if (state === 'ANSWERED') {
    const reply = chosenReply(message);
    return (
      <div className="mt-1 flex items-center gap-1.5">
        <Check size={11} strokeWidth={2} aria-hidden className="shrink-0 text-ink-300" />
        <span className="pw-label">Sent</span>
        <span className="font-display text-2xs font-semibold uppercase leading-none tracking-[0.08em] text-ink-100">
          {reply ? reply.label : message.repliedWith}
        </span>
      </div>
    );
  }
  if (state === 'EXPIRED') {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1.5 opacity-60">
        <span className="flex items-center gap-1">
          <TimerOff size={11} strokeWidth={1.75} aria-hidden className="text-ink-500" />
          <span className="pw-label text-ink-300">No reply</span>
        </span>
        {message.quickReplies.map((reply) => (
          <span key={reply.id} className="rounded-[2px] border border-carbon-700 px-1.5 py-0.5 font-display text-[10px] font-semibold uppercase leading-3 tracking-[0.08em] text-ink-500">
            {reply.label}
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {message.quickReplies.map((reply) => (
        <ReplyButton
          key={reply.id}
          reply={reply}
          disabled={sendingReplyId !== null}
          sending={sendingReplyId === reply.id}
          onClick={() => onReply(message.id, reply.id)}
        />
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── log view ──

interface LogViewProps<T extends { id: number }> {
  items: readonly T[];
  /** Entries older than the DOM cap. */
  hidden: number;
  label: string;
  emptyText: string;
  renderRow: (item: T) => ReactNode;
}

/** Scrolling log pinned to its newest entry, with a jump chip once the user has scrolled up. */
function LogView<T extends { id: number }>({ items, hidden, label, emptyText, renderRow }: LogViewProps<T>) {
  const { viewportRef, contentRef, onScroll, detached, jumpToLatest } = useStickToBottom();
  const lastItem = items.length > 0 ? items[items.length - 1] : undefined;
  const lastId = lastItem ? lastItem.id : null;

  // Remember the newest entry at the moment the user scrolls away, to count what arrives after it.
  const [anchorId, setAnchorId] = useState<number | null>(null);
  if (detached && anchorId === null && lastId !== null) setAnchorId(lastId);
  if (!detached && anchorId !== null) setAnchorId(null);

  let unseen = 0;
  if (detached && anchorId !== null) {
    const anchorIndex = items.findIndex((item) => item.id === anchorId);
    unseen = anchorIndex < 0 ? items.length : items.length - 1 - anchorIndex;
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        onScroll={onScroll}
        role="log"
        aria-label={label}
        tabIndex={0}
        className="h-full overflow-y-auto focus-visible:-outline-offset-1"
      >
        <div ref={contentRef}>
          {hidden > 0 ? (
            <p className="border-b border-carbon-700 px-1.5 py-1 text-center font-mono text-[10px] leading-3 text-ink-600">
              {hidden} earlier {hidden === 1 ? 'entry' : 'entries'} not shown
            </p>
          ) : null}
          {items.length === 0 ? <p className="px-2 py-3 text-center text-2xs text-ink-500">{emptyText}</p> : items.map(renderRow)}
        </div>
      </div>
      {detached ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-[2px] border border-ink-100 bg-ink-100 px-2 py-1 font-display text-2xs font-bold uppercase leading-none tracking-[0.1em] text-carbon-950 hover:bg-ink-50"
        >
          <ArrowDown size={11} strokeWidth={2} aria-hidden />
          {unseen > 0 ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}` : 'Latest'}
        </button>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── radio rows ──

interface RadioRowProps {
  message: RadioMessage;
  state: ReplyState;
  sendingReplyId: string | null;
  tag: CarTag | null;
  onReply: (messageId: number, replyId: string) => void;
}

const RadioRow = memo(function RadioRow({ message, state, sendingReplyId, tag, onReply }: RadioRowProps) {
  const fromDriver = message.from === 'DRIVER';
  const own = message.from === 'PIT_WALL';
  return (
    <article className={`border-b border-l-2 border-b-carbon-700/70 px-1.5 py-1 ${SEVERITY_EDGE[message.severity]}`}>
      <header className="flex items-center gap-2">
        <Stamp lap={message.lap} raceTime={message.raceTime} />
        <Speaker message={message} tag={tag} />
        <CategoryMark category={message.category} />
        <span className="ml-auto">
          <StatusWord tone={SEVERITY_TONE[message.severity]}>{SEVERITY_LABEL[message.severity]}</StatusWord>
        </span>
      </header>
      <p
        className={`mt-0.5 flex gap-1 text-[13px] leading-4 ${
          fromDriver ? 'font-medium text-ink-50' : own ? 'text-ink-300' : 'text-ink-100'
        }`}
      >
        {own ? <CornerDownRight size={11} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-ink-500" /> : null}
        <span className="min-w-0 [overflow-wrap:anywhere]">{fromDriver ? `“${message.text}”` : message.text}</span>
      </p>
      <Replies message={message} state={state} sendingReplyId={sendingReplyId} onReply={onReply} />
    </article>
  );
});

function PendingCall({
  message,
  tag,
  raceTime,
  sendingReplyId,
  onReply,
}: {
  message: RadioMessage;
  tag: CarTag | null;
  raceTime: number;
  sendingReplyId: string | null;
  onReply: (messageId: number, replyId: string) => void;
}) {
  const remaining = message.expiresAt === null ? null : Math.max(0, Math.ceil(message.expiresAt - raceTime));
  const urgent = remaining !== null && remaining <= 10;
  return (
    <li className="border-t border-carbon-700 px-1.5 py-1">
      <div className="flex items-center gap-2">
        <Speaker message={message} tag={tag} />
        <CategoryMark category={message.category} />
        <span className="min-w-0 flex-1 truncate text-xs leading-4 text-ink-100" title={message.text}>
          {message.from === 'DRIVER' ? `“${message.text}”` : message.text}
        </span>
        {remaining !== null ? (
          <span className="flex shrink-0 items-center gap-1" title="Time left to answer">
            <Hourglass size={10} strokeWidth={1.75} aria-hidden className={urgent ? 'text-warn' : 'text-ink-500'} />
            <span className={`font-mono text-[10px] font-medium leading-3 tabular ${urgent ? 'text-warn' : 'text-ink-300'}`}>{remaining} s</span>
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {message.quickReplies.map((reply) => (
          <ReplyButton
            key={reply.id}
            reply={reply}
            disabled={sendingReplyId !== null}
            sending={sendingReplyId === reply.id}
            onClick={() => onReply(message.id, reply.id)}
          />
        ))}
      </div>
    </li>
  );
}

// ────────────────────────────────────────────────────── race control rows ──

function FlagTag({ kind, icon: Icon = Flag, label }: { kind: FlagKind; icon?: IconType; label?: string }) {
  const style = FLAG_STYLE[kind];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[2px] border px-1 font-display text-[10px] font-semibold uppercase leading-[14px] tracking-[0.08em] text-ink-50 ${style.frame}`}
    >
      <Icon size={10} strokeWidth={2} aria-hidden className={style.ink} />
      {label ?? style.label}
    </span>
  );
}

const EventRow = memo(function EventRow({ event, ours }: { event: RaceEvent; ours: boolean }) {
  const { label, icon: Icon } = EVENT_TYPE[event.type];
  const flag = event.type === 'FLAG' ? flagKindOf(event.message) : null;
  const emphasised = event.type === 'FLAG' || event.type === 'INCIDENT' || event.severity !== 'INFO';
  return (
    <div
      className={`grid grid-cols-[auto_84px_minmax(0,1fr)] items-start gap-x-2 border-b border-l-2 border-b-carbon-700/70 px-1.5 py-1 ${
        ours ? 'border-l-team' : 'border-l-transparent'
      }`}
    >
      <span className="pt-px">
        <Stamp lap={event.lap} raceTime={event.raceTime} />
      </span>
      <span className="flex min-w-0 items-center">
        {flag ? (
          <FlagTag kind={flag} />
        ) : event.type === 'INCIDENT' ? (
          <FlagTag kind="YELLOW" icon={TriangleAlert} label="Incident" />
        ) : (
          <span className="flex items-center gap-1">
            <Icon
              size={11}
              strokeWidth={1.75}
              aria-hidden
              className={event.type === 'FASTEST_LAP' ? 'text-timing-purple' : 'text-ink-500'}
            />
            <span className="pw-label leading-[14px]">{label}</span>
          </span>
        )}
      </span>
      <span className={`text-xs leading-4 [overflow-wrap:anywhere] ${emphasised ? 'font-medium text-ink-50' : 'text-ink-100'}`}>
        {event.message}
      </span>
    </div>
  );
});

// ──────────────────────────────────────────────────────────────────── root ──

/**
 * Engineer ↔ driver radio feed with quick replies, and the race-control log. Unanswered calls are
 * pinned on top of the feed until they are answered or their window closes.
 */
export function RadioConsole({ session, snapshot, messages, events, actions, className = '' }: RadioConsoleProps) {
  const [view, setView] = useState<View>('RADIO');
  const [carFilter, setCarFilter] = useState<CarFilter>('ALL');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [eventFilter, setEventFilter] = useState<EventFilter>('ALL');
  /** Replies sent and not yet echoed back by the engine, by message id. */
  const [sent, setSent] = useState<Record<number, { replyId: string; seq: number }>>({});

  const playerCarIds = session.playerCarIds;
  const raceTime = snapshot.raceTime;
  const seq = snapshot.seq;

  const carTags = useMemo(() => {
    const index = indexSession(session);
    const tags: Record<CarId, CarTag> = {};
    for (const carId of session.playerCarIds) {
      const driver = index.driver(carId);
      tags[carId] = { code: driver.code, color: index.color(carId), carNumber: driver.carNumber };
    }
    return tags;
  }, [session]);

  const latest = useLatest({ actions, seq });
  const onReply = useCallback(
    (messageId: number, replyId: string) => {
      latest.current.actions.replyRadio(messageId, replyId);
      setSent((prev) => ({ ...prev, [messageId]: { replyId, seq: latest.current.seq } }));
    },
    [latest],
  );
  const sendingFor = (messageId: number): string | null => {
    const entry = sent[messageId];
    return entry && seq - entry.seq < REPLY_ECHO_SNAPSHOTS ? entry.replyId : null;
  };

  const pending = messages.filter((message) => replyState(message, raceTime) === 'OPEN');

  const radioLog = useMemo(
    () => tail(messages.filter((message) => matchesRadioFilters(message, carFilter, severityFilter, playerCarIds))),
    [messages, carFilter, severityFilter, playerCarIds],
  );
  const eventLog = useMemo(
    () => tail(events.filter((event) => matchesEventFilter(event, eventFilter, playerCarIds))),
    [events, eventFilter, playerCarIds],
  );

  const viewOptions: SegmentedOption<View>[] = [
    { value: 'RADIO', label: pending.length > 0 ? `Team radio · ${pending.length}` : 'Team radio', title: 'Engineer and driver radio' },
    { value: 'CONTROL', label: 'Race control', title: 'Race-control log' },
  ];
  const carOptions: SegmentedOption<CarFilter>[] = [
    { value: 'ALL', label: 'All', title: 'Both cars' },
    { value: 'CAR1', label: `#1 ${carTags[playerCarIds[0]]?.code ?? ''}`, title: 'Car #1 and team-wide messages' },
    { value: 'CAR2', label: `#2 ${carTags[playerCarIds[1]]?.code ?? ''}`, title: 'Car #2 and team-wide messages' },
  ];

  const tagOf = (carId: CarId | null): CarTag | null => (carId === null ? null : (carTags[carId] ?? null));
  const trackStatus = TRACK_STATUS[snapshot.raceControl.flag];

  return (
    <Panel
      title="Radio"
      icon={<Radio size={14} strokeWidth={1.75} aria-hidden />}
      actions={<Segmented options={viewOptions} value={view} onChange={setView} ariaLabel="Radio console view" fill={false} className={SEGMENTED_SMALL} />}
      className={`h-full ${className}`}
      bodyClassName="flex flex-col"
    >
      {view === 'RADIO' ? (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-carbon-700 px-1.5 py-1">
            <span className="pw-label">Car</span>
            <Segmented options={carOptions} value={carFilter} onChange={setCarFilter} ariaLabel="Filter by car" fill={false} className={SEGMENTED_SMALL} />
            <span className="pw-label ml-1.5">Level</span>
            <Segmented
              options={VIEW_SEVERITY_OPTIONS}
              value={severityFilter}
              onChange={setSeverityFilter}
              ariaLabel="Filter by severity"
              fill={false}
              className={SEGMENTED_SMALL}
            />
            <span className="ml-auto whitespace-nowrap font-mono text-[10px] tabular text-ink-500">
              {radioLog.visible.length + radioLog.hidden} msg
            </span>
          </div>

          {pending.length > 0 ? (
            <section aria-label="Awaiting your call" className="max-h-[46%] shrink-0 overflow-y-auto border-b border-carbon-600 bg-carbon-850">
              <h3 className="flex items-center gap-1.5 px-1.5 py-1">
                <BellRing size={11} strokeWidth={1.75} aria-hidden className="pw-blink text-warn" />
                <span className="font-display text-[10px] font-bold uppercase leading-3 tracking-[0.14em] text-ink-50">Awaiting your call</span>
                <span className="font-mono text-[10px] leading-3 tabular text-ink-300">{pending.length}</span>
              </h3>
              <ul>
                {pending.map((message) => (
                  <PendingCall
                    key={message.id}
                    message={message}
                    tag={tagOf(message.carId)}
                    raceTime={raceTime}
                    sendingReplyId={sendingFor(message.id)}
                    onReply={onReply}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          <LogView
            items={radioLog.visible}
            hidden={radioLog.hidden}
            label="Team radio"
            emptyText="No radio traffic"
            renderRow={(message) => (
              <RadioRow
                key={message.id}
                message={message}
                state={replyState(message, raceTime)}
                sendingReplyId={sendingFor(message.id)}
                tag={tagOf(message.carId)}
                onReply={onReply}
              />
            )}
          />
        </>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-carbon-700 px-1.5 py-1">
            <span className="pw-label">Show</span>
            <Segmented options={EVENT_FILTER_OPTIONS} value={eventFilter} onChange={setEventFilter} ariaLabel="Filter the race-control log" fill={false} className={SEGMENTED_SMALL} />
            <span className="ml-auto flex min-w-0 items-center gap-1.5">
              <span className="truncate text-2xs leading-3 text-ink-300" title={snapshot.raceControl.message}>
                {snapshot.raceControl.message}
              </span>
              <FlagTag kind={trackStatus} />
            </span>
          </div>
          <LogView
            items={eventLog.visible}
            hidden={eventLog.hidden}
            label="Race control"
            emptyText="No race-control message"
            renderRow={(event) => (
              <EventRow
                key={event.id}
                event={event}
                ours={event.carIds.some((id) => id === playerCarIds[0] || id === playerCarIds[1])}
              />
            )}
          />
        </>
      )}
    </Panel>
  );
}
