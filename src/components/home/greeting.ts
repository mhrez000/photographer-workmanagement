/** "Good morning" / "Good afternoon" / "Good evening" in the organisation's clock. */
export function greetingAt(now: Date, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-AU", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** The first name, for a friendly greeting ("Mo"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
