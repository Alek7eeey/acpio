export async function runPool(items, limit, worker) {
  let next = 0;
  let active = 0;
  let done = 0;
  let failed = false;
  const results = new Array(items.length);
  return await new Promise((resolve, reject) => {
    const launch = () => {
      while (active <= limit && next < items.length && !failed) {
        const index = next++;
        active++;
        Promise.resolve(worker(items[index], index))
          .then((value) => {
            results[index] = value;
          })
          .catch((err) => {
            failed = true;
            reject(err);
          })
          .finally(() => {
            active--;
            done++;
            if (done === items.length) resolve(results);
            else launch();
          });
      }
    };
    if (items.length === 0) {
      resolve(results);
      return;
    }
    launch();
  });
}
