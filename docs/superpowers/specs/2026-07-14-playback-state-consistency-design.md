# Playback State Consistency Design

## Outcome

When the user removes the audible song, clears the queue, selects another song,
or pauses while a stream is loading, the audio they just rejected stops
immediately and cannot return after a late network response. The title, seek
position, duration, play/pause control, queue, and audible source describe the
same song throughout each transition.

## Confirmed root causes

1. Removing the current queue item changes the visible current item and starts
   loading its replacement, but the old audio is not paused first. A streamed
   replacement can take seconds to resolve, so the removed song remains audible.
2. Song loads have no freshness check. An earlier stream lookup can finish after
   a later selection or after queue clearing and play its stale source.
3. Auto-play top-ups have no queue-session check. A related-song lookup that was
   already running can append into a replacement queue, or repopulate a queue the
   user cleared.
4. Resume is asynchronous but play/pause state is only updated after it resolves.
   A fast second click sees the old state and issues another resume instead of a
   pause.
5. Crossfade audio can keep playing a target that is removed during the overlap,
   because queue removal does not cancel the active overlap.
6. Position and duration are not reset when selection changes, so the new title
   temporarily appears with the previous song's timeline.

## Approaches considered

### A. Pause only in the remove handler

This stops the reported song immediately, but a previously-started load or
auto-play request can still restart it later. It treats one symptom and leaves
the shared cause active.

### B. Freshness tokens plus immediate transition reset (selected)

Playback loads and transport commands receive a monotonically increasing token.
Queue/auto-play sessions receive a separate token. Async completion may change
audio or state only while its token and target item still match. Selection
changes pause audio and reset the visible timeline before awaiting any source.

This is localized to the existing stores and audio controller, preserves the
current queue/crossfade design, and directly covers every confirmed race.

### C. Replace the player with an explicit finite-state machine

This could make every transition formal, but it would rewrite the largest
unfinished file and overlap heavily with the current auto-play work. The extra
risk is not justified for the confirmed defects.

## State boundaries

- **Playback command token:** invalidated by a new load, pause, clear, or other
  command that makes an older completion stale.
- **Loaded item identity:** distinguishes a real paused track that can resume at
  its current position from a selected track whose source is still unresolved.
- **Auto-play session token:** invalidated when the queue is replaced/cleared or
  auto-play is toggled. Old recommendation results cannot append afterward.
- **Crossfade target identity:** records the audible incoming item so removing it
  can cancel the overlap immediately.

## Observable transition rules

- Removing the current item pauses both physical audio elements synchronously,
  clears the old timeline, then loads the replacement if one exists.
- Clearing the queue cancels crossfade, pending playback completion, pending
  auto-play retry, and permission for an in-flight top-up to append.
- Selecting B after A means only B may become audible, even if A resolves last.
- Clicking Play and immediately Pause ends paused; a late `play()` resolution
  cannot flip the control back.
- Removing the incoming crossfade item silences it and restores the outgoing
  track instead of finishing the overlap into a deleted target.
- Switching crossfade off during an overlap cancels that overlap immediately.

## Verification

The regression suite loads the real Zustand player store and real two-element
audio controller through Vite. Only the desktop/network boundary is replaced by
controllable promises. Tests cover removal during a slow replacement, clear
during load, out-of-order selection completion, clear during auto-play top-up,
rapid play/pause, timeline reset, and crossfade-target removal.

