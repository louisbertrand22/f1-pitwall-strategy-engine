/**
 * Engineer ↔ driver radio: phrase book, message factory and cooldowns. The race engine decides WHEN
 * something is worth saying; this module decides how it is worded and avoids repeating itself.
 */
import type { CarId, RadioCategory, RadioMessage, RadioQuickReply, RandomSource, Severity } from './types';

type Vars = Record<string, string | number>;

const PHRASES = {
  start: ['Lights out! P{pos} off the line.', 'And we are racing. P{pos} into turn one.'],
  tyresFading: [
    'Tyre deg is ramping up. About {laps} laps to the cliff on this set.',
    'Rear wear is climbing. We see roughly {laps} laps of life left.',
  ],
  tyresGone: [
    'These tyres are gone, I have nothing left on the rears!',
    'The fronts are finished, I cannot turn the car in.',
    'I am losing the rear everywhere, the tyres are done.',
  ],
  tyresCritical: [
    'We need to box, I am a passenger out here!',
    'I cannot hold it any more, these tyres are dead!',
  ],
  coldTyres: ['New {compound}s on. They need a lap or two to come in, careful on the out-lap.'],
  undercutOpen: [
    'Undercut window is open on {target}: gap {gap} s, we gain about {gain} s a lap on new {compound}s.',
  ],
  threat: ['{rival} is {gap} s behind and inside undercut range.'],
  rivalPitted: ['{rival} has boxed from {gap} s behind. Do we cover?'],
  aheadPitted: ['{rival} ahead has pitted. Clear air now — push for the overcut?'],
  strategyCall: ['Strategy call: {rationale}'],
  safetyCar: ['Safety car, safety car. Keep the delta positive. A stop now costs {loss} s instead of {green} s. {call}'],
  vsc: ['Virtual safety car. Keep the delta positive. A stop now costs about {loss} s instead of {green} s. {call}'],
  stackAvoided: ['Staying out one more lap: we do not want to stack behind {mate}.'],
  scEnding: ['Safety car in this lap. Get heat into the tyres. No overtaking before the line.'],
  greenFlag: ['Green flag, green flag. Track is clear.'],
  redFlag: ['Red flag, red flag. Back to the pit lane. Free tyre change — tell us what you want fitted for the restart.'],
  yellow: ['Yellow in sector {sector}. No overtaking, lift through the incident.'],
  rainSoon: ['Radar shows {intensity} rain arriving in about {laps} laps.'],
  rainNow: ['It is starting to spit with rain.', 'Drops on the visor, it is getting slippery.'],
  crossInter: ['Track wetness {wet}%. We are at the crossover for inters. Box for intermediates?'],
  crossInterDrying: ['The standing water is going: {wet}% and falling. Intermediates are the tyre now. Box for inters?'],
  holdForRain: ['Holding the planned stop: rain is about to hit, we will go straight to the right tyre.'],
  crossWet: ['Standing water, {wet}%. Full wets are the faster tyre now. Box for wets?'],
  crossSlick: ['Track is drying: {wet}% and falling. Slicks are faster by our model. Box for {compound}s?'],
  undriveable: ['It is undriveable on these tyres, I am coming in!'],
  engineHot: ['Engine temps are high, {temp} degrees. Find clean air or lift and coast.'],
  engineCritical: ['Engine critical, {temp} degrees! Back off now or we lose the power unit.'],
  brakesHot: ['Brake temps are high, {temp} degrees. Lift earlier into the big stops.'],
  brakesCritical: ['Brakes critical, {temp} degrees! Back out of it.'],
  fuelShort: ['We are {laps} laps short on fuel. We will need some lift and coast.'],
  fuelCritical: ['Fuel is critical. Lift and coast now or we do not see the flag.'],
  fuelForced: ['I am saving fuel on my own here, the numbers do not add up.'],
  batteryEmpty: ['Battery is flat, overtake mode gives you nothing. Go to harvest.'],
  batteryFull: ['Battery is full. You are free to deploy.'],
  boxPlanned: ['Box this lap, box, box. Plan {plan}: {compound}s.'],
  boxEmergency: ['Box this lap, box, box: {why}. Fitting {compound}s.'],
  boxAck: ['Copy, box this lap.', 'Understood, boxing.'],
  boxNextLap: ['Copy. Pit entry is already behind me, I will box next time round.'],
  boxCancelled: ['Stay out, stay out. The stop is cancelled.'],
  noSet: ['We have no {compound} set left. Pick the tyres manually.'],
  pitGood: ['Good stop, {time}. You rejoin P{pos}.', 'Clean stop, {time}. P{pos} on exit.'],
  pitSlow: ['Slow stop, {time} — problem on the {corner}. You rejoin P{pos}.'],
  pitQueue: ['Stacked behind your team-mate: {time} s lost waiting.'],
  positionGain: ['Great move, that is P{pos}.', 'Nicely done. P{pos}.'],
  positionLost: ['{rival} is through. P{pos} now.'],
  fastestLap: ['That is the fastest lap of the race, {time}.'],
  drsTrain: ['You are stuck in a DRS train. Look after the tyres, we will clear them in the stops.'],
  puncture: ['Puncture, puncture! I have a puncture!'],
  spin: ['Sorry, I lost the rear. Car seems OK.', 'Locked up and went off. Everything feels alright.'],
  retire: ['Stop the car, stop the car. We have a {failure} problem. Sorry.'],
  crash: ['I am in the wall. Sorry guys. I am OK.'],
  swapYield: ['Copy. I will let him by on the next straight.'],
  swapDone: ['Swap complete. Thank you both.'],
  swapNo: ['Negative on the swap: the gap between the cars is {gap} s.'],
  holdAck: ['Understood, holding position.'],
  freeAck: ['You are free to race. Keep it clean.'],
  defendAck: ['Copy, covering the inside.'],
  planSwitch: ['Switching to plan {plan}: {summary}.'],
  lastLap: ['Last lap, last lap. Bring it home.'],
  finish: ['Chequered flag. P{pos}. {comment}'],
  penalty: ['We did not run two dry compounds: that is a {seconds} s penalty.'],
} as const;

export type PhraseKey = keyof typeof PHRASES;

export interface RadioDraft {
  carId: CarId | null;
  from: RadioMessage['from'];
  category: RadioCategory;
  severity: Severity;
  phrase: PhraseKey;
  vars?: Vars;
  quickReplies?: RadioQuickReply[];
  /** Seconds of race time during which the quick replies remain valid. */
  ttl?: number;
}

export class RadioDirector {
  private nextId = 1;
  private readonly cooldowns = new Map<string, number>();
  private readonly rng: RandomSource;

  constructor(rng: RandomSource) {
    this.rng = rng;
  }

  /** True when `key` is off cooldown; arms it for `cooldown` seconds of race time. */
  ready(key: string, raceTime: number, cooldown: number): boolean {
    const until = this.cooldowns.get(key);
    if (until !== undefined && raceTime < until) return false;
    this.cooldowns.set(key, raceTime + cooldown);
    return true;
  }

  /** Clears a cooldown so the condition can be announced again the next time it arises. */
  rearm(key: string): void {
    this.cooldowns.delete(key);
  }

  private render(phrase: PhraseKey, vars: Vars = {}): string {
    const template = this.rng.pick(PHRASES[phrase]);
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
  }

  compose(draft: RadioDraft, raceTime: number, lap: number): RadioMessage {
    const replies = draft.quickReplies ?? [];
    return {
      id: this.nextId++,
      raceTime,
      lap,
      carId: draft.carId,
      from: draft.from,
      category: draft.category,
      severity: draft.severity,
      text: this.render(draft.phrase, draft.vars),
      quickReplies: replies,
      repliedWith: null,
      expiresAt: replies.length > 0 ? raceTime + (draft.ttl ?? 150) : null,
    };
  }
}
