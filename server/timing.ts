/**
 * The waits and periods this provider works to. They are values of the plugin, not of agy, and each
 * one is a trade between reacting quickly and asking agy's files too often; a caller that needs
 * others (the tests, which cannot wait seconds) passes them to `createProvider`.
 */
export interface Timing {
  /**
   * How long a tool may stay ACTIVE before the conversation transcript is consulted. A command agy
   * moved to the background holds every later stream line until it ends (see `backfill.ts`).
   */
  backfillDelayMs: number;
  /** Poll period of the transcript while a stream is stuck, or while a conversation may carry on. */
  transcriptPollMs: number;
  /**
   * How long an error at the end of a stream-held turn's transcript has to stay the last word
   * before the turn is failed. agy retries a failed model call (`attempt 1` … `attempt 8`, seconds
   * apart), so the first error is not the end.
   */
  failureQuietMs: number;
  /** How long a CLI asked to stop may take to flush its conversation and exit before it is killed. */
  terminateGraceMs: number;
  /** How long the exit of a CLI waits for its output to end, which something it started can hold open. */
  drainGraceMs: number;
  /**
   * How long the attachments and schema file of a session that is not open are kept after they were
   * last touched. A session that closed because the plugin reloaded comes back, and may still point
   * the model at an image it attached before.
   */
  orphanRetentionMs: number;
}

export const DEFAULT_TIMING: Timing = {
  backfillDelayMs: 5_000,
  transcriptPollMs: 1_000,
  failureQuietMs: 30_000,
  terminateGraceMs: 3_000,
  drainGraceMs: 2_000,
  orphanRetentionMs: 7 * 24 * 60 * 60 * 1000,
};
