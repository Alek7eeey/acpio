/**
 * Agent → ACP client RPC: the `fs/*`, `terminal/*` and permission methods the
 * host serves for us. Correlation lives here so the transport only has to
 * move JSON-RPC frames.
 */
export interface HostClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface HostRpc extends HostClient {
  /** Feed a JSON-RPC frame that came from the client. True when it was a reply. */
  receive(msg: Record<string, unknown>): boolean;
  /** Reject everything still in flight (the client went away). */
  failAll(err: Error): void;
}

export function createHostRpc(send: (frame: Record<string, unknown>) => void): HostRpc {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const request = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  const receive = (msg: Record<string, unknown>): boolean => {
    // A reply to a request we sent: numeric id, no method.
    const id = typeof msg.id === "number" && msg.method === undefined ? msg.id : undefined;
    if (id === undefined) return false;
    const waiter = pending.get(id);
    if (!waiter) return false;
    pending.delete(id);
    const error = msg.error as { message?: string; code?: number } | undefined;
    if (error) {
      waiter.reject(new Error(error.message ?? `rpc error ${error.code ?? -1}`));
    } else {
      waiter.resolve(msg.result);
    }
    return true;
  };

  const failAll = (err: Error) => {
    for (const [, waiter] of pending) waiter.reject(err);
    pending.clear();
  };

  return { request, receive, failAll };
}
