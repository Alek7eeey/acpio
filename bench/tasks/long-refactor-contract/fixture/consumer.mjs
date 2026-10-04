// A consumer of the public entry — must keep working untouched.
import { createClient } from "./src/index.mjs";

const client = createClient({ retries: 1, fetchImpl: async () => ({ status: 200, text: async () => '{"ok":true}' }), sleep: async () => {} });
const res = await client.get("/ping");
console.log(JSON.stringify(res));
