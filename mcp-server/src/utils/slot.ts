/**
 * Slot ID encoding/decoding.
 *
 * Format (colon-delimited, matches ^[A-Za-z0-9._:-]+$, max 128 chars):
 *   emr:{date}:{HHmm}:{facility_id}:{provider_id}:{catid}:{dur_secs}
 *
 * Example: emr:2026-03-25:0900:1:5:5:900
 */

export interface SlotParts {
  date: string;        // YYYY-MM-DD
  startHHmm: string;  // HH:MM
  facilityId: number;
  providerId: number;  // 0 = any provider
  catId: number;
  durationSecs: number;
}

export function encodeSlotId(parts: SlotParts): string {
  const hhmm = parts.startHHmm.replace(':', '');
  const id = `emr:${parts.date}:${hhmm}:${parts.facilityId}:${parts.providerId}:${parts.catId}:${parts.durationSecs}`;
  if (id.length > 128) throw new Error(`slot_id too long: ${id}`);
  return id;
}

export function decodeSlotId(slotId: string): SlotParts | null {
  const parts = slotId.split(':');
  // emr : date(2026-03-25) : HHmm : facilityId : providerId : catId : durSecs
  // The date itself contains dashes so overall split has 10 segments:
  // ['emr','2026','03','25','0900','1','5','5','900'] -- No!
  // With format emr:2026-03-25:0900:1:5:5:900 split(':') gives:
  // ['emr', '2026-03-25', '0900', '1', '5', '5', '900']
  if (parts.length !== 7 || parts[0] !== 'emr') return null;

  const [, date, rawHHmm, facilityStr, providerStr, catStr, durStr] = parts;

  const hh = rawHHmm.slice(0, 2);
  const mm = rawHHmm.slice(2, 4);

  return {
    date,
    startHHmm: `${hh}:${mm}`,
    facilityId: parseInt(facilityStr, 10),
    providerId: parseInt(providerStr, 10),
    catId: parseInt(catStr, 10),
    durationSecs: parseInt(durStr, 10),
  };
}

/** Encode a booking reference from an OpenEMR appointment pc_eid. */
export function encodeBookingRef(eid: string | number): string {
  return `emr:appt:${eid}`;
}

/** Decode pc_eid from a booking reference. Returns null if invalid. */
export function decodeBookingRef(ref: string): string | null {
  const m = ref.match(/^emr:appt:(\w+)$/);
  return m ? m[1] : null;
}
