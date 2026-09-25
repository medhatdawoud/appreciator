/**
 * The button's click sounds, synthesised with the Web Audio API: no audio
 * file to fetch, so nothing for a host page's Content-Security-Policy to
 * refuse, and nothing to load before the first click.
 *
 * Every sound is short and quiet. Browsers only let a page start audio from a
 * user gesture, which a click is, so the shared context is created (or
 * resumed) on the first sound. Where Web Audio is missing, or refuses,
 * nothing plays and nothing breaks.
 */

type AudioContextClass = typeof AudioContext;

/** Older Safari names it `webkitAudioContext`; some environments have neither. */
interface AudioWindow {
  AudioContext?: AudioContextClass;
  webkitAudioContext?: AudioContextClass;
}

let context: AudioContext | null | undefined;

function audio(): AudioContext | null {
  if (context !== undefined) return context;
  const scope = typeof window === 'undefined' ? {} : (window as unknown as AudioWindow);
  const Class = scope.AudioContext ?? scope.webkitAudioContext;
  let created: AudioContext | null;
  try {
    created = Class === undefined ? null : new Class();
  } catch {
    created = null;
  }
  context = created;
  return created;
}

/** Forgets the shared context, so tests can swap the Web Audio implementation. */
export function resetSound(): void {
  context = undefined;
}

interface Note {
  /** Seconds after now. */
  at: number;
  /** Hz at the start, and where it glides to over `length`. */
  from: number;
  to: number;
  /** Seconds, from the start to silence. */
  length: number;
  /** Peak gain, 0–1. */
  volume: number;
  type: OscillatorType;
}

function play(notes: readonly Note[]): void {
  const ctx = audio();
  if (ctx === null) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    for (const note of notes) {
      const start = now + note.at;
      const end = start + note.length;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = note.type;
      oscillator.frequency.setValueAtTime(note.from, start);
      oscillator.frequency.exponentialRampToValueAtTime(note.to, start + note.length * 0.5);
      // A 5 ms attack avoids a click at the start; the exponential tail
      // fades it out rather than cutting it off.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.volume, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  } catch {
    // A sound is a nicety; a failure to play one must never break a click.
  }
}

/** Lowest pitch of the counted-click pop, and how far it climbs by the last click. */
const POP_BASE_HZ = 520;
const POP_CLIMB_HZ = 360;

/**
 * A counted click: a short, soft pop that climbs a little in pitch as the
 * allowance fills, `progress` going from 0 to 1.
 */
export function playPop(progress: number): void {
  const from = POP_BASE_HZ + POP_CLIMB_HZ * Math.min(1, Math.max(0, progress));
  play([{ at: 0, from, to: from * 1.5, length: 0.09, volume: 0.12, type: 'triangle' }]);
}

/** The click that fills the button: two quick rising notes, a fifth apart. */
export function playChime(): void {
  const root = POP_BASE_HZ + POP_CLIMB_HZ;
  play([
    { at: 0, from: root, to: root, length: 0.16, volume: 0.1, type: 'sine' },
    { at: 0.07, from: root * 1.5, to: root * 1.5, length: 0.22, volume: 0.1, type: 'sine' },
  ]);
}

/** A click once the allowance is spent: a quieter, lower pop, still an answer. */
export function playSpent(): void {
  play([
    {
      at: 0,
      from: POP_BASE_HZ * 0.75,
      to: POP_BASE_HZ,
      length: 0.07,
      volume: 0.06,
      type: 'triangle',
    },
  ]);
}
