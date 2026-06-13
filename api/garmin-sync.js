#!/usr/bin/env python3
"""
Garmin → Supabase daily sync
Run manually or schedule with cron: 0 7 * * * /usr/bin/python3 /path/to/garmin_sync.py
"""

import json, os, sys, requests
from datetime import datetime, timedelta
from pathlib import Path

# ── CONFIG ────────────────────────────────────────────────────────────────────
SUPABASE_URL = "https://qghuysyxvjukiwapbijh.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnaHV5c3l4dmp1a2l3YXBiaWpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3NjAzODgsImV4cCI6MjA5NTMzNjM4OH0.dMmv4TzmVXU-eKRTuoKdFG8D2v1Psb9rqyVHuRLkfdo"
DAYS_BACK_DAILY = 7
DAYS_BACK_ACTIVITIES = 30

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates",
}

# ── SUPABASE ──────────────────────────────────────────────────────────────────
def supa_upsert(table, records):
    if not records:
        return 0
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=HEADERS,
        json=records if isinstance(records, list) else [records]
    )
    if r.status_code not in (200, 201):
        print(f"  ⚠ Supabase error {r.status_code}: {r.text[:200]}")
        return 0
    return len(records) if isinstance(records, list) else 1

# ── GARMIN ────────────────────────────────────────────────────────────────────
def get_garmin_client():
    try:
        from garminconnect import Garmin
        # Use saved OAuth tokens from garmin-mcp-auth
        # Try garmin-mcp token locations
        token_paths = [
            Path.home() / ".garminconnect",
            Path.home() / ".garminconnect_base64",
        ]
        for token_path in token_paths:
            if token_path.exists():
                try:
                    client = Garmin()
                    client.garth.load(str(token_path))
                    client.display_name = None
                    return client
                except Exception:
                    continue
        # Try garth token directory
        garth_path = Path.home() / ".garth"
        if garth_path.exists():
            try:
                import garth
                garth.resume(str(garth_path))
                client = Garmin()
                client.garth = garth
                return client
            except Exception:
                pass
        else:
            # Fall back to email/password from env
            email = os.environ.get("GARMIN_EMAIL")
            password = os.environ.get("GARMIN_PASSWORD")
            if not email or not password:
                print("❌ No Garmin credentials found.")
                print("   Run: uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth")
                sys.exit(1)
            client = Garmin(email, password)
            client.login()
            return client
    except ImportError:
        print("❌ garminconnect not installed.")
        print("   Run: pip3 install garminconnect --break-system-packages")
        sys.exit(1)

def sync_daily(client, days=7):
    print(f"\n📅 Syncing daily summaries + sleep (last {days} days)...")
    records = []
    today = datetime.now().date()

    for i in range(days):
        date = today - timedelta(days=i)
        date_str = date.strftime("%Y-%m-%d")
        try:
            stats  = client.get_stats(date_str)
            bb     = client.get_body_battery(date_str)
            stress = client.get_stress_data(date_str)

            # Body battery
            bb_high = bb_low = bb_current = None
            if isinstance(bb, list) and bb:
                values = [x.get("bodyBatteryLevel") for x in bb if x.get("bodyBatteryLevel") is not None]
                if values:
                    bb_high = max(values)
                    bb_low  = min(values)
                    bb_current = values[-1]
            elif isinstance(bb, dict):
                bb_high    = bb.get("maxBodyBatteryLevel")
                bb_low     = bb.get("minBodyBatteryLevel")
                bb_current = bb.get("endBodyBatteryLevel")

            # Stress
            stress_avg = stress_max = stress_qual = None
            if isinstance(stress, dict):
                stress_avg  = stress.get("avgStressLevel") or stress.get("averageStressLevel")
                stress_max  = stress.get("maxStressLevel")
                stress_qual = stress.get("stressQualifier")

            # Sleep
            sleep_score = sleep_hrs = deep_hrs = rem_hrs = light_hrs = None
            avg_spo2 = avg_resp = avg_hr_sleep = sleep_feedback = None
            try:
                sleep_data = client.get_sleep_data(date_str)
                dto = None
                if isinstance(sleep_data, dict):
                    dto = sleep_data.get("dailySleepDTO") or sleep_data
                elif isinstance(sleep_data, list) and sleep_data:
                    dto = sleep_data[0]
                if dto and dto.get("sleepWindowConfirmed"):
                    secs = dto.get("sleepTimeSeconds") or 0
                    sleep_hrs   = round(secs / 3600, 2) if secs else None
                    deep_hrs    = round((dto.get("deepSleepSeconds") or 0) / 3600, 2) or None
                    rem_hrs     = round((dto.get("remSleepSeconds") or 0) / 3600, 2) or None
                    light_hrs   = round((dto.get("lightSleepSeconds") or 0) / 3600, 2) or None
                    avg_spo2    = dto.get("averageSpO2Value")
                    avg_resp    = dto.get("averageRespirationValue")
                    avg_hr_sleep= dto.get("averageSpO2HRSleep") or dto.get("avgHeartRate")
                    sleep_feedback = dto.get("sleepScoreFeedback")
                    # Bedtime and wake timestamps
                    sleep_start = dto.get("sleepStartTimestampLocal") or dto.get("sleepStartTimestampGMT")
                    sleep_end   = dto.get("sleepEndTimestampLocal")   or dto.get("sleepEndTimestampGMT")
                    # Convert epoch ms to ISO string
                    if sleep_start and sleep_start > 1e10:
                        from datetime import timezone
                        sleep_start = datetime.fromtimestamp(sleep_start/1000).isoformat()
                    if sleep_end and sleep_end > 1e10:
                        sleep_end = datetime.fromtimestamp(sleep_end/1000).isoformat()
                    # Overall sleep score — stored in a separate structure
                    scores = sleep_data.get("sleepScores") if isinstance(sleep_data, dict) else None
                    if scores:
                        sleep_score = scores.get("overall", {}).get("value") if isinstance(scores.get("overall"), dict) else scores.get("overall")
                    if not sleep_score:
                        sleep_score = dto.get("sleepScore") or dto.get("overallSleepScore")
            except Exception as se:
                pass  # Sleep data not available for this day

            record = {
                "id":                  f"daily_{date_str}",
                "date":                date_str,
                "steps":               stats.get("totalSteps"),
                "goal_steps":          stats.get("dailyStepGoal"),
                "total_calories":      stats.get("totalKilocalories"),
                "active_calories":     stats.get("activeKilocalories"),
                "body_battery_current":bb_current,
                "body_battery_high":   bb_high,
                "body_battery_low":    bb_low,
                "stress_avg":          stress_avg,
                "stress_max":          stress_max,
                "stress_qualifier":    stress_qual,
                "resting_hr":          stats.get("restingHeartRate"),
                "sleep_score":         sleep_score,
                "sleep_hrs":           sleep_hrs,
                "sleep_start":         sleep_start if 'sleep_start' in dir() else None,
                "sleep_end":           sleep_end if 'sleep_end' in dir() else None,
                "deep_hrs":            deep_hrs,
                "rem_hrs":             rem_hrs,
                "light_hrs":           light_hrs,
                "avg_spo2":            avg_spo2,
                "avg_respiration":     avg_resp,
                "avg_hr_sleep":        avg_hr_sleep,
                "sleep_feedback":      sleep_feedback,
                "updated_at":          datetime.now().isoformat(),
            }
            records.append(record)
            sleep_str = f", sleep {sleep_hrs}h (D:{deep_hrs} R:{rem_hrs})" if sleep_hrs else ""
            print(f"  ✓ {date_str}: {record['steps']} steps, stress {stress_avg}{sleep_str}")
        except Exception as e:
            print(f"  ⚠ {date_str}: {e}")

    n = supa_upsert("health_daily", records)
    print(f"  → {n} daily records saved to Supabase")
    return n

def sync_activities(client, days=30):
    print(f"\n🏃 Syncing activities (last {days} days)...")
    today = datetime.now().date()
    start = (today - timedelta(days=days)).strftime("%Y-%m-%d")
    end = today.strftime("%Y-%m-%d")
    
    try:
        activities = client.get_activities_by_date(start, end)
    except Exception as e:
        print(f"  ⚠ Could not fetch activities: {e}")
        return 0
    
    records = []
    for act in activities:
        act_id = str(act.get("activityId", ""))
        start_time = act.get("startTimeLocal") or act.get("startTimeGMT", "")
        date_str = start_time[:10] if start_time else end
        
        # Pace calculation
        pace = None
        duration = act.get("duration", 0)
        distance = act.get("distance", 0)
        if duration and distance and distance > 0:
            pace = (duration / 60) / (distance / 1000)  # min/km

        record = {
            "id": f"act_{act_id}",
            "date": date_str,
            "activity_type": act.get("activityType", {}).get("typeKey") if isinstance(act.get("activityType"), dict) else act.get("activityType"),
            "name": act.get("activityName"),
            "start_time": start_time,
            "duration_seconds": int(duration) if duration else None,
            "distance_meters": distance or None,
            "calories": act.get("calories"),
            "avg_hr": act.get("averageHR"),
            "max_hr": act.get("maxHR"),
            "avg_pace_min_per_km": round(pace, 2) if pace else None,
            "elevation_gain": act.get("elevationGain"),
            "steps": act.get("steps"),
            "raw": json.dumps({k: act[k] for k in ["activityId","activityName","activityType"] if k in act}),
        }
        records.append(record)
        duration_min = int(duration/60) if duration else 0
        print(f"  ✓ {date_str}: {record['activity_type']} — {duration_min}min, {round((distance or 0)/1000, 1)}km")
    
    n = supa_upsert("health_activities", records)
    print(f"  → {n} activities saved to Supabase")
    return n

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("🔄 Garmin → Supabase sync starting...")
    print(f"   {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
    
    client = get_garmin_client()
    print("✅ Connected to Garmin")
    
    d = sync_daily(client, DAYS_BACK_DAILY)
    a = sync_activities(client, DAYS_BACK_ACTIVITIES)
    
    print(f"\n✅ Sync complete: {d} daily + {a} activities")
