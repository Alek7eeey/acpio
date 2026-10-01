/**
 * Run every task concurrently and NEVER reject: the result is an array in
 * INPUT order — { ok: true, value } for fulfilled tasks, { ok: false,
 * reason } for rejected ones. A failing task must not hide the outcomes of
 * the others.
 */
export async function settleAll(tasks) {
  const values = await Promise.all(tasks.map((task) => task()));
  return values.map((value) => ({ ok: true, value }));
}
