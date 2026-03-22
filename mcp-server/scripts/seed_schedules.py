#!/usr/bin/env python3
"""
seed_schedules.py — Seeds one year of appointments for Dr. Chen and Dr. Webb
via the OpenEMR Health MCP server.

Usage:
    python3 scripts/seed_schedules.py [--mcp-url http://localhost:3100/mcp]

Options:
    --mcp-url   MCP server base URL (default: http://localhost:3100/mcp)
    --chen-id   Dr. Chen's OpenEMR provider user ID (default: 2)
    --webb-id   Dr. Webb's OpenEMR provider user ID (default: 3)
    --patient1  First test patient ID (default: 1)
    --patient2  Second test patient ID (default: 2)
    --facility  Facility ID (default: 1)
    --cat-id    Appointment category ID for Office Visit (default: 0)
    --weeks     Number of weeks to seed (default: 52)
    --dry-run   Print what would be booked without making calls

Adjust --chen-id, --webb-id, and --cat-id to match your OpenEMR database.
Find the category ID by calling health_get_procedure_catalog and checking
the 'id' field for the "Office Visit" entry.

Schedule pattern seeded:
  Dr. Chen (Mon/Wed/Fri):
    Monday     09:00 — Office Visit, patient 1
    Wednesday  10:30 — Follow-up,    patient 2
    Friday     14:00 — Office Visit, patient 1
    Friday     15:30 — Follow-up,    patient 2

  Dr. Webb (Tue/Thu):
    Tuesday    09:30 — New Patient Consultation, patient 2
    Tuesday    14:00 — Office Visit,             patient 1
    Thursday   09:00 — Office Visit,             patient 1
    Thursday   13:00 — Follow-up,                patient 2
"""

import argparse
import datetime
import json
import sys
import urllib.request
import urllib.error


def parse_args():
    p = argparse.ArgumentParser(description="Seed provider schedules via MCP")
    p.add_argument("--mcp-url", default="http://localhost:3100/mcp")
    p.add_argument("--chen-id", default="2", help="Dr. Chen's provider ID")
    p.add_argument("--webb-id", default="3", help="Dr. Webb's provider ID")
    p.add_argument("--patient1", default="1", help="First patient ID")
    p.add_argument("--patient2", default="2", help="Second patient ID")
    p.add_argument("--facility", default="1", help="Facility ID")
    p.add_argument("--cat-id", default="0", help="Appointment category ID")
    p.add_argument("--weeks", type=int, default=52, help="Weeks to seed")
    p.add_argument("--dry-run", action="store_true", help="Print without booking")
    return p.parse_args()


def slot_id(date: str, hhmm: str, provider: str, facility: str, cat: str, dur: int = 1800) -> str:
    """Encode a slot ID in the MCP canonical format: emr:{date}:{HHmm}:{fac}:{prov}:{cat}:{dur}"""
    hhmm_compact = hhmm.replace(":", "")
    return f"emr:{date}:{hhmm_compact}:{facility}:{provider}:{cat}:{dur}"


def call_mcp(url: str, tool: str, arguments: dict) -> dict:
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        raw = urllib.request.urlopen(req, timeout=15).read().decode()
    except urllib.error.URLError as e:
        return {"ok": False, "error": str(e)}

    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                return json.loads(line[5:])
            except json.JSONDecodeError:
                pass
    return {"ok": False, "error": "no data line in response"}


def book(
    url: str,
    slot: str,
    patient: str,
    idem: str,
    reason: str,
    dry_run: bool,
) -> bool:
    if dry_run:
        print(f"  DRY-RUN  {slot}  patient={patient}  reason={reason}")
        return True

    result = call_mcp(url, "health_book_slot", {
        "slot_id": slot,
        "patient_id": patient,
        "verification_level": "contact",
        "reason": reason,
        "idempotency_key": idem,
    })

    inner = result.get("result", result)
    ok = inner.get("ok", False)
    if ok:
        booking_ref = inner.get("result", {}).get("booking_ref", "?")
        print(f"  ✓  {slot[:50]}  → {booking_ref}")
    else:
        err = inner.get("result", {}).get("error", {})
        code = err.get("code", "?")
        msg = err.get("message", str(inner))[:80]
        if code == "conflict":
            print(f"  ⟳  already booked  {slot[:50]}")
            return True  # idempotent — treat as success
        print(f"  ✗  {code}: {msg}")
    return ok


def main():
    args = parse_args()
    url = args.mcp_url
    chen = args.chen_id
    webb = args.webb_id
    p1 = args.patient1
    p2 = args.patient2
    fac = args.facility
    cat = args.cat_id
    weeks = args.weeks
    dry_run = args.dry_run

    # Duration: 30 min = 1800 seconds
    dur_office = 1800
    # Duration: 60 min = 3600 seconds (New Patient Consultation)
    dur_new_pt = 3600
    # Duration: 15 min = 900 seconds (Follow-up)
    dur_followup = 900

    # Provider schedules — (day_offset_from_monday, HH:MM, patient, reason, duration_secs)
    # day_offset: 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri
    chen_schedule = [
        (0, "09:00", p1, "Annual check-up",        dur_office),
        (2, "10:30", p2, "Follow-up visit",         dur_followup),
        (4, "14:00", p1, "Office visit",            dur_office),
        (4, "15:30", p2, "Follow-up visit",         dur_followup),
    ]

    webb_schedule = [
        (1, "09:30", p2, "New patient consultation", dur_new_pt),
        (1, "14:00", p1, "Office visit",             dur_office),
        (3, "09:00", p1, "Office visit",             dur_office),
        (3, "13:00", p2, "Follow-up visit",          dur_followup),
    ]

    today = datetime.date.today()
    # Find next Monday (or today if it's Monday)
    days_until_monday = (7 - today.weekday()) % 7
    first_monday = today + datetime.timedelta(days=days_until_monday if days_until_monday else 0)

    total = weeks * (len(chen_schedule) + len(webb_schedule))
    print(f"Seeding {total} appointments across {weeks} weeks")
    print(f"  Dr. Chen (ID {chen}): {len(chen_schedule)} appts/week on Mon/Wed/Fri")
    print(f"  Dr. Webb (ID {webb}): {len(webb_schedule)} appts/week on Tue/Thu")
    print(f"  Starting from: {first_monday}")
    if dry_run:
        print("  DRY RUN — no bookings will be made\n")
    else:
        print()

    ok_count = 0
    fail_count = 0

    for week in range(weeks):
        monday = first_monday + datetime.timedelta(weeks=week)
        year_end = today + datetime.timedelta(days=366)
        if monday > year_end:
            break

        print(f"Week {week + 1:3d}  ({monday})")

        for day_offset, hhmm, patient, reason, dur in chen_schedule:
            appt_date = (monday + datetime.timedelta(days=day_offset)).isoformat()
            sid = slot_id(appt_date, hhmm, chen, fac, cat, dur)
            idem = f"seed-chen-{appt_date}-{hhmm.replace(':','')}"
            if book(url, sid, patient, idem, reason, dry_run):
                ok_count += 1
            else:
                fail_count += 1

        for day_offset, hhmm, patient, reason, dur in webb_schedule:
            appt_date = (monday + datetime.timedelta(days=day_offset)).isoformat()
            sid = slot_id(appt_date, hhmm, webb, fac, cat, dur)
            idem = f"seed-webb-{appt_date}-{hhmm.replace(':','')}"
            if book(url, sid, patient, idem, reason, dry_run):
                ok_count += 1
            else:
                fail_count += 1

    print(f"\n{'DRY RUN complete' if dry_run else 'Done'}.")
    print(f"  Booked / already-existed: {ok_count}")
    print(f"  Failed:                   {fail_count}")
    if fail_count > 0:
        print("\n  Check --cat-id matches the 'Office Visit' category ID in OpenEMR.")
        print("  Run: curl -s ... health_get_procedure_catalog to find the correct ID.")
        sys.exit(1)


if __name__ == "__main__":
    main()
