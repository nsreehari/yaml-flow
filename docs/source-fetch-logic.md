Source of truth — source fetch lifecycle:

queueRequestedAt is the only field ever set to now. lastRequestedAt and lastFetchedAt are never set to now.
queueRequestedAt, lastRequestedAt, lastFetchedAt are never cleared once set.
The three fields always advance monotonically: queueRequestedAt ≥ lastRequestedAt ≥ lastFetchedAt.
On task not-started / retriggered (non-update path):

Unconditionally write queueRequestedAt = now.
If lastRequestedAt < queueRequestedAt AND lastFetchedAt == lastRequestedAt (i.e. not in-flight): set lastRequestedAt = queueRequestedAt, dispatch with rqt = lastRequestedAt.
If in-flight (lastFetchedAt < lastRequestedAt): do nothing — a queued queueRequestedAt is already recorded.
On task-progress (callback / update path):

If incoming rqt <= lastFetchedAt: ignore (stale callback, already superseded).
Otherwise: commit the fetched file, set lastFetchedAt = rqt.
Then if queueRequestedAt > lastFetchedAt: set lastRequestedAt = queueRequestedAt, dispatch with rqt = lastRequestedAt.
Two confirmed deviations in current c