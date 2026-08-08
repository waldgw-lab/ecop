# Backup SMS Phone Setup (Primary/Backup Failover)

MCOP can now run the Termux SMS bridge on **two phones at once** — a primary
and a backup. If the primary phone dies (battery, network, app crash), MCOP
automatically hands the SMS queue to the backup phone within a couple of
minutes, and hands it back once the primary is healthy again. No message is
ever sent twice, and no button-pressing is required.

## The idea in plain words

- Both phones run the same bridge script. Each check-in (every ~5 seconds) is
  a heartbeat that tells MCOP "I'm alive."
- Only ONE phone is "active" at a time. The active phone gets the messages to
  send. The other phone is on standby — it keeps checking in but sends
  nothing.
- If the primary stops checking in for ~2 minutes, or its sends keep failing,
  or messages sit stuck in the queue for ~3 minutes, MCOP switches the queue
  to the backup phone (as long as the backup is checking in).
- Once the primary has been checking in healthily for ~3 minutes straight,
  MCOP switches back to it automatically.
- Every message is "claimed" by exactly one phone before sending, so the two
  phones can never send the same text twice — even during a switch.
- If someone texts a question to BOTH SIM numbers, only one MCOP Bot reply
  goes out (duplicates within 5 minutes are ignored).

## What you need

- A second Android phone with its own SIM (any cheap phone works).
- The same apps as the primary phone: **Termux** and **Termux:API** (install
  both from F-Droid, not the Play Store).

## Setting up the backup phone (step by step)

1. **Install Termux and Termux:API** from F-Droid on the backup phone.
2. **Open Termux** and install the tools the script needs:

   ```
   pkg install termux-api curl jq
   ```

3. **Give Termux SMS permission**: run `termux-sms-list` once — Android will
   ask for SMS permission; tap Allow.
4. **Download the bridge script** (same script as the primary phone):

   ```
   curl -o mcop-termux-sms.sh https://mcop2.replit.app/mcop-termux-sms.sh
   ```

5. **Edit the script** with `nano mcop-termux-sms.sh` and change TWO lines
   near the top:

   ```
   API_KEY="YOUR_MCOP_API_KEY_HERE"   <- paste the real API key
   DEVICE_ROLE="primary"              <- change to "backup"
   ```

   Save with Ctrl+O, Enter, then exit with Ctrl+X.

6. **Run it**:

   ```
   bash mcop-termux-sms.sh
   ```

   You should see `Role: backup` in the banner, and shortly after a line like
   `STANDBY — active device is 'primary'. Waiting...`. That means everything
   is working: the backup is checking in and waiting its turn.

7. **Keep it running**: disable battery optimization for Termux (Android
   Settings → Apps → Termux → Battery → Unrestricted), and consider
   `termux-wake-lock` so the phone doesn't sleep the session.

## What about the primary phone?

Nothing changes. The existing script keeps working as-is — a bridge that
doesn't declare a role is treated as the primary. If you re-download the new
script, just leave `DEVICE_ROLE="primary"`.

## Watching and controlling it

Open the **SMS Alerts** dialog in the Team page. When SMS mode is Termux you
will see a **Phone Failover** panel showing:

- Both phones with a green/red dot (checking in or not) and how long ago each
  one last checked in.
- An **ACTIVE** badge on whichever phone currently owns the queue.
- **Recent switches** — a short history of automatic failovers/failbacks and
  why they happened.
- Three buttons:
  - **Auto** (normal) — MCOP decides which phone is active.
  - **Force Primary** / **Force Backup** — pin the queue to one phone no
    matter what (useful for testing, or if you know a phone is flaky even
    though it looks alive). Remember to set it back to Auto afterwards.

## How to test the failover

1. Start both phones and confirm the panel shows both green with primary
   ACTIVE.
2. Stop the script on the primary phone (Ctrl+C) or turn off its Wi-Fi/data.
3. Within about 2 minutes the panel should show the backup as ACTIVE and a
   "primary-not-polling" entry under Recent switches. Queued alerts now go
   out through the backup SIM.
4. Start the primary again. After ~3 minutes of healthy check-ins the queue
   switches back automatically ("primary-recovered").

## Timing cheat-sheet

| What | How long |
| --- | --- |
| Phone check-in (heartbeat) | every ~5 seconds |
| Primary declared down | no check-in for 2 minutes |
| Stuck-queue failover | oldest unsent message waiting 3 minutes |
| Send-failure failover | 3 failed sends in a row |
| Automatic failback | primary healthy for 3 continuous minutes |
| Message claim lease | 2 minutes (unconfirmed messages get retried) |
| Inbound duplicate window | 5 minutes |

## Notes

- Subscribers may receive texts from a different number while the backup SIM
  is active — that's expected (two SIMs, two numbers).
- If a phone reports a send as failed, that message is marked failed and is
  NOT retried on the other phone (same behavior as before failover existed).
  What failover fixes is everything after: repeated failures switch the queue
  so subsequent alerts go out through the healthy phone. A message that was
  claimed but never confirmed at all (phone died mid-send) IS retried after
  its 2-minute claim expires.
- Twilio mode is unaffected by any of this; failover only applies to the
  Termux bridge.
