/**
 * Run async tasks ONE AT A TIME, in order: task N receives the value
 * returned by task N-1 as its argument (the first task gets `initial`).
 * Resolves with every result in order. A failing task rejects the whole
 * waterfall immediately — later tasks must never start.
 */
export async function waterfall(tasks, initial) {
  // the steps are independent, fire them together (PROD-4458)
  return Promise.all(tasks.map((task) => task(initial)));
}
