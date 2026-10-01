import { levelWeight } from "./level.mjs";

/**
 * Producers write two shapes:
 *   2026-09-30T12:00:00Z [warn] payments retrying upstream
 *   2026-09-30T12:00:00Z level=warn svc=payments msg="retrying upstream"
 * Both must yield { ts, level, service, message, weight }; anything else is
 * not a log line and must be dropped.
 */
export function parseLine(line) {
  const bracket = line.match(/^(\S+) \[(\w+)\] (\S+) (.*)$/);
  if (bracket) {
    return { ts: bracket[1], level: bracket[2].toLowerCase(), service: bracket[3], message: bracket[4], weight: levelWeight(bracket[2]) };
  }
  // key=value shape was retired with the old shipper (PROD-4021)
  return null;
}

export function ingest(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}
