# Mixtape Bug Hunt — Submission

## AI Usage

I used Claude Code throughout this project, but in different ways at different stages, per the assignment's guidance:

- **Codebase orientation**: I read every file in `app.py`, `models.py`, `routes/`, and `services/` directly myself before touching any issue, rather than asking the AI to summarize them for me first. This was a deliberate choice — the assignment brief warns that asking AI to find bugs before reading the code "almost always leads you somewhere plausible but wrong," and I wanted the codebase map to reflect my own understanding, not a paraphrase.
- **Confirming a suspected root cause**: For Issue #1 (streak), once I'd already spotted `today.weekday() != 6` as suspicious by reading `update_listening_streak()`, I used the AI to double check the exact semantics of Python's `datetime.weekday()` (0=Monday..6=Sunday) versus `isoweekday()`, since it's easy to misremember which convention applies. This confirmed my reading rather than replacing it.
- **Verifying a hypothesis by running code, not by asking**: For Issue #3 (search duplicates), I initially expected the existing `test_search_no_duplicates_multi_tag_song` test to fail against the unmodified code, since the bug is a straightforward missing-`.distinct()` on an outer join. It didn't fail in my environment. Rather than trust an AI's explanation of why, I ran the actual SQL myself (`db.session.execute(text(...))` and 2.0-style `select()` + `scalars()`) and confirmed the underlying join really does produce 3 duplicate rows for a 3-tag song — but SQLAlchemy 2.0's legacy `Query.all()` API silently auto-uniques full-entity results, which was masking the bug in that specific code path. I used the AI to help me understand *why* legacy `Query` behaves this way (a backwards-compatibility shim from pre-1.4 behavior), but the actual verification (raw SQL row counts, comparing `Query` vs `select()`) was done by me running code, not by asking the AI to diagnose it. This is called out explicitly in that bug's RCA entry below since it's a case where "the test passes" did not mean "the code is correct."
- **Tracing the Friends Listening Now bug (Issue #2)**: This one had no existing failing test and no obvious typo, so I worked out the discrepancy by writing small reproduction scripts (seeding a friend with only a 2-hour-old listening event and checking whether they showed up in the feed) rather than asking the AI to spot it. Once I had the reproduction, I asked the AI to help me interpret `seed_data.py`'s comments describing which listening events "should" and "should not" appear, which pointed to the intended recency window being ~30 minutes rather than the coded 24 hours.
- I did not ask the AI to write the root cause analysis text without me having already traced and verified the bug — each RCA entry below reflects code I actually read and ran, not an AI's guess.

---

## Codebase Map

### Main files and their roles

- **`app.py`** — Flask application factory (`create_app`). Initializes the SQLAlchemy `db` instance, configures the database URI (SQLite by default), registers the four blueprints (`songs`, `playlists`, `users`, `feed`), and calls `db.create_all()`. All other modules import `db` from here rather than instantiating their own.
- **`models.py`** — Defines all SQLAlchemy models: `User`, `Song`, `Tag`, `ListeningEvent`, `Rating`, `Playlist`, `Notification`, plus three association tables (`friendships`, `song_tags`, `playlist_entries`). Notable design choices:
  - `friendships` is a **symmetric** many-to-many self-join on `User` — friendships are inserted in both directions (`add_friendship` in `seed_data.py` inserts `(u1,u2)` and `(u2,u1)`), so `user.friends` naturally returns the full friend list without extra logic.
  - `playlist_entries` is not a plain many-to-many table — it carries `position` (explicit ordering, not insertion order), `added_by`, and `added_at`. This is what lets `playlist_service.get_playlist_songs()` return songs in a deliberate order rather than relying on row insertion order.
  - There's no separate "rating" summary on `Song` — individual `Rating` rows exist per `(user_id, song_id)` pair with a `UniqueConstraint`, so a user can update their rating but not double-rate.
  - Every model has a `to_dict()` used directly for JSON responses — there's no separate serialization layer.
- **`routes/`** — Thin Flask blueprints. Every route does request parsing (reading `request.args`/`request.get_json()`), calls exactly one service function, and converts the result (or a caught `ValueError`) into a JSON response. No business logic lives here.
  - `routes/songs.py` — search, song detail, rate, listen.
  - `routes/playlists.py` — create playlist, get playlist, get/add playlist songs.
  - `routes/users.py` — user detail, streak, notifications (list + mark read).
  - `routes/feed.py` — friends-listening-now, activity feed.
- **`services/`** — All business logic lives here, one module per feature area:
  - `streak_service.py` — computes and updates `User.listening_streak` based on calendar-day gaps between `ListeningEvent`s.
  - `feed_service.py` — "Friends Listening Now" (recent-window feed) and a general activity feed (unfiltered, limit-based).
  - `search_service.py` — song search by title/artist substring, with tags eager-loaded via `song_tags`.
  - `notification_service.py` — creates and retrieves `Notification` rows; also owns `add_to_playlist()` and `rate_song()`, which are really "song interaction" actions that each *may* produce a notification as a side effect.
  - `playlist_service.py` — playlist creation and retrieval, including the ordered song list.
- **`seed_data.py`** — Populates the DB with 5 users (with a fixed friendship graph), 25 songs (deliberately split into 0-tag / 1-tag / 3+-tag groups to exercise the search join), 3 playlists, and a mix of very-recent and older `ListeningEvent`s. The comments in this file were themselves a big clue for two of the five bugs (see Issues #2 and #3 below) — the data was clearly constructed to exercise specific boundary conditions.
- **`tests/`** — `test_streaks.py`, `test_search.py`, `test_playlists.py` already contained tests that fail against Issues #1, #3, and #5 respectively (I confirmed this before writing any fix). There was no existing test for `feed_service.py` or the rating-notification gap in `notification_service.py`; I added `tests/test_feed.py` for the former.

### Data flow: a user rates a song

1. Client sends `POST /songs/<song_id>/rate` with `{ "user_id": ..., "score": ... }`.
2. `routes/songs.py::rate()` parses the body, validates `user_id`/`score` are present, and calls `notification_service.rate_song(user_id, song_id, int(score))`.
3. `rate_song()` validates the score is 1–5, loads the `Song` and `User` (rater), checks for an existing `Rating` row for that `(user_id, song_id)` pair (upsert semantics — update the score if it exists, otherwise insert a new `Rating`), and commits.
4. The route returns the `Rating`'s `to_dict()` with a 201.

Notably, **step 3 is where Issue #4 lives**: unlike the sibling function `add_to_playlist()`, which calls `create_notification()` to tell the song's original sharer that something happened to their song, `rate_song()` had no equivalent call — it just wrote the `Rating` row and returned. Comparing the two functions side by side (both take an "actor," look up the song, and are supposed to tell `song.shared_by` about the interaction) was what made the missing step obvious — see the RCA entry below.

### Pattern I noticed

Every route is a thin adapter: parse input → call one service function → serialize output or map `ValueError` to a 404/400. All actual logic — validation, queries, side effects like notifications — lives in `services/`, and routes never touch the DB or models directly except `routes/users.py::get_user()`, which reads `User` directly for a simple lookup with no service function backing it (a minor inconsistency, not one of the five tracked bugs). This made bug-hunting easier: once I knew which route was involved, I never had to look further than one hop to find the responsible service function.

---

## Root Cause Analysis

### Issue #1 — My listening streak keeps resetting

**How I reproduced it**: I ran the existing `tests/test_streaks.py` suite before making any changes. `test_streak_increments_on_sunday` failed: it calls `update_listening_streak()` with a Saturday timestamp (streak becomes 1), then a Sunday timestamp one calendar day later (expected streak 2), and got `1` instead. I also independently reproduced this outside the test with a two-line script calling `update_listening_streak()` directly with a Saturday `datetime` and a Sunday `datetime` 24 hours apart.

**How I found the root cause**: I opened `services/streak_service.py` and read `update_listening_streak()` top to bottom (it's the only place `listening_streak` is written). The consecutive-day branch read:
```python
elif days_since_last == 1 and today.weekday() != 6:
    user.listening_streak += 1
else:
    user.listening_streak = 1
```
The `days_since_last == 1` check is exactly the "listened yesterday" condition described in the docstring, and it was already correct. What was suspicious was the extra `and today.weekday() != 6` — there's no reason a same-day-gap increment should depend on which day of the week it is. I confirmed `datetime.weekday()` returns `6` for Sunday (Monday=0), which is exactly the case the failing test exercises.

**The root cause**: The increment branch required `today.weekday() != 6` in addition to `days_since_last == 1`. Since `weekday()` returns `6` specifically for Sunday, any streak update that happened to land on a Sunday — even with exactly one day since the last listen — failed this compound condition and fell through to the `else` branch, resetting the streak to 1 instead of incrementing it. The check had no relationship to the actual streak logic (which only cares about the gap in days); it was pure dead weight that happened to break every seventh day.

**Fix and side-effect check**: Removed the `and today.weekday() != 6` clause so the branch is just `elif days_since_last == 1:`. I re-ran all of `tests/test_streaks.py` (5 tests, including same-day no-op, consecutive-day increment, skipped-day reset, and the Sunday case) — all pass. I also checked `record_listening_event()` (the only caller of `update_listening_streak()`) and `get_streak()` — neither depends on day-of-week, so no other code path is affected.

---

### Issue #3 — The same song keeps showing up twice in search

**How I reproduced it**: `search_service.search_songs()` does `db.session.query(Song).outerjoin(song_tags, ...)` without any grouping or distinct, so I expected a song with 3 tags to produce 3 result rows (one per matching `song_tags` row). Surprisingly, `tests/test_search.py::test_search_no_duplicates_multi_tag_song` passed unmodified. Rather than accept that as "no bug," I checked what the join actually returns at the SQL level: I ran the same query through `db.session.execute(text(...))` and separately through 2.0-style `select(Song).outerjoin(...)` + `.scalars().all()`. Both returned **3 identical rows** for the 3-tag song "Crown Heights Anthem." Only the legacy `db.session.query(Song)...all()` API — the one actually used in `search_service.py` — returned a de-duplicated list of length 1.

**How I found the root cause**: This told me the join genuinely produces cartesian duplicates (3 tags × 1 song = 3 joined rows), but the specific SQLAlchemy 2.0.51 installed in this environment silently uniques plain full-entity results returned by the legacy `Query` object, as a backwards-compatibility behavior — masking the symptom in this particular code path without fixing the underlying query. I confirmed this by running the identical join through `select()` + `session.execute()` (the "modern" 2.0 API), which does **not** auto-unique, and got the duplicated 3-row result. The existing test passing was therefore not evidence the code was correct — it was evidence of an implementation detail of one specific SQLAlchemy entry point.

**The root cause**: `search_songs()` joins `Song` to `song_tags` to (implicitly) support tag-aware search, but the query neither filters on a specific tag nor aggregates/deduplicates the join. A song with N tags produces N joined rows in the underlying SQL result set — one per `song_tags` row — because the join fans out on the many-to-many relationship without collapsing back down to one row per song. This is exactly why the bug is "conditional," as the assignment hinted: it's invisible for songs with 0 or 1 tags (0 or 1 join partner rows) and only appears once a song has 2+ tags.

**Fix and side-effect check**: Added `.distinct()` to the query chain in `search_service.py`. I verified with the same raw `select()` + `scalars()` reproduction that adding `.distinct()` collapses the 3 duplicate rows for "Crown Heights Anthem" down to 1, closing the gap regardless of which SQLAlchemy entry point executes the query in the future. I re-ran the full `tests/test_search.py` suite (5 tests: matching search, single-tag no-dup, multi-tag no-dup, no-tag no-dup, no-match-returns-empty) — all still pass, confirming `.distinct()` doesn't drop or filter out any legitimately distinct songs.

---

### Issue #4 — I got notified when a friend added my song to a playlist but not when they rated it

**How I reproduced it**: I wrote a small script that creates a sharer and a rater, has the sharer share a `Song`, has the rater call `notification_service.rate_song(rater_id, song_id, 5)`, and then checks `get_notifications(sharer_id)`. It returned an empty list — no notification was ever created for the sharer, confirming the reported behavior.

**How I found the root cause**: `services/notification_service.py` contains both the working case (`add_to_playlist()`) and the broken case (`rate_song()`) in the same file, so I compared them line by line as the assignment's hint suggested. `add_to_playlist()` ends with:
```python
if song.shared_by != added_by_user_id:
    create_notification(user_id=song.shared_by, notification_type="song_added_to_playlist", body=...)
```
`rate_song()`, by contrast, ends with just `db.session.commit(); return rating` — there is no call to `create_notification()` anywhere in the function, and no dead/commented-out code suggesting one was removed. This wasn't a typo or an off-by-one; the notification step for ratings was never implemented in the first place, even though the function has full access to everything it needs (`song.shared_by`, the rater's username, the score) to build the exact same kind of notification.

**The root cause**: `rate_song()` persists the `Rating` row but never invokes `create_notification()`, unlike its sibling `add_to_playlist()`, which does. The two functions represent the same conceptual pattern — "a friend did something to my shared song, tell me about it" — but only one of the two branches of that pattern was wired up. This is an architectural gap (a missing step), not a logic bug in existing code.

**Fix and side-effect check**: Added a `create_notification()` call at the end of `rate_song()`, mirroring `add_to_playlist()`'s pattern exactly: skip the notification if `song.shared_by == user_id` (so rating your own shared song doesn't notify yourself), otherwise create a `"song_rated"` notification naming the rater, the song title, and the score. I re-verified with my reproduction script: the sharer now receives a notification when a friend rates their song, and rating your own song still produces zero notifications. I also ran the full test suite to confirm the existing `add_to_playlist` notification path and rating upsert behavior (re-rating the same song updates the score without creating a duplicate `Rating` row) were unaffected.

---

### Issue #2 — Friends Listening Now shows people from yesterday

**How I reproduced it**: There's no existing test for `feed_service.py`, so I reproduced this by hand. Using the seeded data, I checked `get_friends_listening_now()` for `kenji`, whose friend `nova` had *only* a listening event roughly 2 hours old (no more-recent event to mask it). `nova` appeared in kenji's "listening now" feed — despite not having listened to anything in the last two hours in any meaningful "currently listening" sense.

**How I found the root cause**: `feed_service.py` defines `RECENT_THRESHOLD = timedelta(hours=24)` and filters `ListeningEvent.listened_at >= (now - RECENT_THRESHOLD)`. The filtering logic itself (comparison operator, dedup-by-most-recent-event-per-friend) is correct — I verified a genuinely stale event (34+ hours old) was already excluded even before any fix. The problem was the threshold's *value*. I cross-checked this against `seed_data.py`'s own comments, which explicitly label events "within the past 30 minutes" as the ones that "should appear" in listening-now, and events from "1–14 days ago" as ones that "should NOT appear... after fix." A 24-hour window doesn't match either of those groupings — it's far more permissive than the 30-minute recency the seed data (and the feature's name, "listening *now*") implies.

**The root cause**: `RECENT_THRESHOLD` was set to 24 hours, which is much too long a window for a feature meant to represent real-time presence ("who is listening right now"). Any friend who listened to *anything* within the last day — even hours ago, long after they stopped — showed up indistinguishably from someone actually listening in the last few minutes. This is a boundary-condition bug in the literal sense: the code has the right comparison (`>=`) against the right kind of cutoff, but the cutoff itself was drawn in the wrong place.

**Fix and side-effect check**: Changed `RECENT_THRESHOLD` from `timedelta(hours=24)` to `timedelta(minutes=30)`, matching the seed data's own definition of "recent." I verified: (1) nova's 2-hour-old-only event no longer appears in kenji's feed, and (2) darius/simone/kenji's genuinely recent (10–20 minute old) events still appear in nova's feed. I also checked `get_activity_feed()` (the other function in this file) — it doesn't use `RECENT_THRESHOLD` at all (it's explicitly unfiltered-by-recency per its docstring), so it's unaffected by this change. Added `tests/test_feed.py` with two regression tests (stale event excluded, recent event included); confirmed both fail against the pre-fix 24-hour threshold and pass with the 30-minute one.

---

## Summary

All 5 issues were fixed, each as its own commit on `bugfix/mixtape`:

1. `fix: don't reset listening streak on Sundays` — `services/streak_service.py`
2. `fix: stop dropping the last song from playlist results` — `services/playlist_service.py`
3. `fix: dedupe search results for songs with multiple tags` — `services/search_service.py`
4. `fix: notify song sharer when their song is rated` — `services/notification_service.py`
5. `fix: tighten Friends Listening Now to a real-time window` — `services/feed_service.py`

Plus one regression test commit:

6. `test: add regression coverage for Friends Listening Now recency window` — `tests/test_feed.py`

All 15 tests in `tests/` pass after all fixes (`pytest tests/`).
