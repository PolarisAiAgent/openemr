/**
 * In-memory slot hold store for the health_hold_slot / health_confirm_booking flow.
 *
 * A hold reserves a slot for a short TTL (SLOT_HOLD_TTL_SECONDS, default 300 s = 5 min)
 * without writing to OpenEMR. health_confirm_booking commits the hold into a real appointment.
 *
 * Per-slot lock: prevents two simultaneous health_confirm_booking calls from
 * double-booking the same slot on a single server instance. For multi-instance
 * deployments, replace with a distributed lock (Redis SETNX, etc.).
 */
import { randomUUID } from 'node:crypto';
import type { SlotParts } from '../utils/slot.js';

export interface SlotHold {
  hold_id: string;
  slot_id: string;
  pid: string;
  slot_parts: SlotParts;
  reason?: string;
  visit_type?: string;
  duration_minutes?: number;
  created_at: number;
  expires_at: number;
}

function holdTtlMs(): number {
  const v = parseInt(process.env['SLOT_HOLD_TTL_SECONDS'] ?? '', 10);
  return (Number.isFinite(v) && v > 0 ? v : 300) * 1000;
}

const holds = new Map<string, SlotHold>();
const slotLocks = new Set<string>(); // slotKey locked during confirm

function cleanup(): void {
  const now = Date.now();
  for (const [id, h] of holds) {
    if (h.expires_at <= now) {
      slotLocks.delete(h.slot_id); // release stale lock if any
      holds.delete(id);
    }
  }
}

export function createHold(
  slot_id: string,
  pid: string,
  slot_parts: SlotParts,
  opts: { reason?: string; visit_type?: string; duration_minutes?: number },
): SlotHold {
  cleanup();
  const now = Date.now();
  const hold: SlotHold = {
    hold_id: randomUUID(),
    slot_id,
    pid,
    slot_parts,
    reason: opts.reason,
    visit_type: opts.visit_type,
    duration_minutes: opts.duration_minutes,
    created_at: now,
    expires_at: now + holdTtlMs(),
  };
  holds.set(hold.hold_id, hold);
  return hold;
}

export function getHold(hold_id: string): SlotHold | null {
  cleanup();
  const h = holds.get(hold_id);
  if (!h) return null;
  if (h.expires_at <= Date.now()) {
    holds.delete(hold_id);
    return null;
  }
  return h;
}

export function releaseHold(hold_id: string): void {
  const h = holds.get(hold_id);
  if (h) slotLocks.delete(h.slot_id);
  holds.delete(hold_id);
}

/**
 * Acquire a per-slot lock before committing a booking.
 * Returns true if the lock was acquired, false if the slot is already being committed.
 */
export function tryLockSlot(slot_id: string): boolean {
  if (slotLocks.has(slot_id)) return false;
  slotLocks.add(slot_id);
  return true;
}

export function unlockSlot(slot_id: string): void {
  slotLocks.delete(slot_id);
}
