const WEIGHTS = { debug: 10, info: 20, warn: 30, error: 40 };

export function levelWeight(level) {
  return WEIGHTS[String(level).toLowerCase()] ?? 0;
}
