import { useEffect, useState } from "react";
import { offsetFromDateHeader, requestMidpoint } from "../lib/serverClock";

/**
 * How far the device clock is from the server's, in milliseconds — add it to `Date.now()`.
 *
 * Measured once when the component mounts. 0 until the answer arrives and 0 if it never does, so
 * a timer starts on the device clock and silently corrects itself a moment later rather than
 * waiting on the network to show anything at all.
 */
export function useServerClockOffset(): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const sentAt = Date.now();

    // HEAD on our own origin: no payload, no new dependency, and the reply carries the server's
    // clock in its `Date` header.
    fetch(window.location.origin, { method: "HEAD", cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        const device = requestMidpoint(sentAt, Date.now());
        setOffset(offsetFromDateHeader(res.headers.get("date"), device));
      })
      .catch(() => {
        // Offline, or the header is not exposed. The device clock is the best there is.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return offset;
}
