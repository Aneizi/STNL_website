import { useEffect, useState } from "react";

/**
 * The resend cooldown shared by every form that sends a one-time code: the
 * seconds left until a code may be requested again, ticking once a second.
 * `startCooldown()` is called right after a code was sent.
 */
export function useResendCooldown(cooldownMs = 60_000) {
  const [resendAt, setResendAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!resendAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  return { secondsLeft, startCooldown: () => setResendAt(Date.now() + cooldownMs) };
}
