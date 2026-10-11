import { useEffect, useState } from "react";

/** The current time, refreshed every `ms` (for clocks and "3m ago" labels). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
