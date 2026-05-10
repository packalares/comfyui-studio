import { useCallback, useEffect, useRef, useState } from 'react';

export function useTransientFlag(
  durationMs: number = 2000,
): [boolean, () => void, () => void] {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const trigger = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setActive(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setActive(false);
    }, durationMs);
  }, [durationMs]);

  const reset = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setActive(false);
  }, []);

  return [active, trigger, reset];
}
