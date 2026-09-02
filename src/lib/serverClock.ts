/**
 * Whose clock the shop floor timer runs on.
 *
 * The cutting timer counts between `cuttingStartedAt`, which Firestore stamps from the SERVER, and
 * "now", which was being read off the device. A workshop phone with its clock ten minutes out
 * therefore showed a job as ten minutes further along — or ten minutes late before it had begun.
 * The two ends have to come from the same clock.
 *
 * The correction is the offset between the server and the device, measured once per session from
 * the `Date` response header of a HEAD request to our own origin. That header is the server's
 * clock, it costs one header fetch, and it needs no new dependency, no rules change and no write.
 * Its resolution is one second, which is finer than anything a minutes-long timer can show.
 */

/**
 * Server time minus device time, in milliseconds.
 *
 * Returns 0 — "trust the device" — for a missing or unparseable header, because a timer running on
 * a possibly-skewed clock is still far better than one that refuses to run.
 */
export function offsetFromDateHeader(header: string | null | undefined, deviceNowMs: number): number {
  if (!header) return 0;
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return 0;
  return serverMs - deviceNowMs;
}

/**
 * The device time the server's answer describes.
 *
 * The header is stamped somewhere between sending the request and receiving the reply, so the
 * midpoint of the two device readings is the closest device instant to compare it against. On a
 * fast connection this changes little; on a slow one it halves the error instead of charging the
 * whole round trip to the offset.
 */
export function requestMidpoint(sentAtMs: number, receivedAtMs: number): number {
  return sentAtMs + (receivedAtMs - sentAtMs) / 2;
}
