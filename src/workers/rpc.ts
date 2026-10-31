/**
 * Minimal typed RPC over any `postMessage` endpoint (Worker, DedicatedWorkerGlobalScope,
 * MessagePort). No dependencies, so it bundles unchanged into the static Next.js export.
 *
 * The API is described once as a type (`{ method(args): result }`); the client mirrors it
 * as promise-returning methods, and the server checks its handlers against the same type.
 */

export interface RpcRequest {
  readonly kind: 'rpc-request';
  readonly id: number;
  readonly method: string;
  readonly args: unknown[];
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** Own enumerable string/number/boolean props (e.g. error codes) carried across the boundary. */
  props?: Record<string, string | number | boolean>;
}

export type RpcResponse =
  | { readonly kind: 'rpc-response'; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly kind: 'rpc-response'; readonly id: number; readonly ok: false; readonly error: SerializedError };

export type RpcMessage = RpcRequest | RpcResponse;

/** Structural subset of Worker / MessagePort / worker global scope. */
export interface RpcEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Constraint for an API type: every member is a function (interfaces qualify, no index signature needed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RpcApi<Api> = { [M in keyof Api]: (...args: any[]) => any };

export type RpcClient<Api extends RpcApi<Api>> = {
  [M in keyof Api]: (...args: Parameters<Api[M]>) => Promise<Awaited<ReturnType<Api[M]>>>;
};

/** Raised on the client when the transport (not the remote handler) fails. */
export class RpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcTransportError';
  }
}

const TRANSFER_BOX = Symbol.for('bloom.rpc.transfer');

interface TransferBox<T> {
  readonly [TRANSFER_BOX]: true;
  readonly value: T;
  readonly transfer: Transferable[];
}

/**
 * Mark a result (or argument) so its buffers are moved, not copied, across the boundary.
 * Only transfer buffers the sender no longer needs.
 */
export function withTransfer<T>(value: T, transfer: Transferable[]): T {
  return { [TRANSFER_BOX]: true, value, transfer } as unknown as T;
}

function isTransferBox(v: unknown): v is TransferBox<unknown> {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[TRANSFER_BOX] === true;
}

function unbox(value: unknown, transfer: Transferable[]): unknown {
  if (isTransferBox(value)) {
    transfer.push(...value.transfer);
    return value.value;
  }
  return value;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const props: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(err)) {
      const v = (err as unknown as Record<string, unknown>)[key];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') props[key] = v;
    }
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      props: Object.keys(props).length > 0 ? props : undefined,
    };
  }
  return { name: 'Error', message: typeof err === 'string' ? err : String(err) };
}

export function deserializeError(s: SerializedError): Error {
  const err = new Error(s.message);
  err.name = s.name;
  if (s.stack) err.stack = s.stack;
  if (s.props) Object.assign(err, s.props);
  return err;
}

/** Serve `api` on `endpoint`. Returns a function that stops serving. */
export function exposeRpc<Api extends RpcApi<Api>>(api: Api, endpoint: RpcEndpoint): () => void {
  const listener = (event: MessageEvent) => {
    const msg = event.data as RpcMessage | undefined;
    if (!msg || msg.kind !== 'rpc-request') return;
    void handle(msg);
  };

  async function handle(req: RpcRequest) {
    const transfer: Transferable[] = [];
    try {
      const fn = Object.prototype.hasOwnProperty.call(api, req.method)
        ? (api as Record<string, unknown>)[req.method]
        : undefined;
      if (typeof fn !== 'function') throw new Error(`Unknown RPC method: ${req.method}`);
      const result = unbox(await (fn as (...a: unknown[]) => unknown)(...req.args), transfer);
      const res: RpcResponse = { kind: 'rpc-response', id: req.id, ok: true, result };
      endpoint.postMessage(res, transfer);
    } catch (err) {
      const res: RpcResponse = { kind: 'rpc-response', id: req.id, ok: false, error: serializeError(err) };
      endpoint.postMessage(res, []);
    }
  }

  endpoint.addEventListener('message', listener);
  return () => endpoint.removeEventListener('message', listener);
}

export interface RpcClientHandle<Api extends RpcApi<Api>> {
  api: RpcClient<Api>;
  /** Reject all in-flight calls with a transport error and refuse new ones. */
  fail(reason: string): void;
  dispose(): void;
}

export function createRpcClient<Api extends RpcApi<Api>>(endpoint: RpcEndpoint): RpcClientHandle<Api> {
  let nextId = 1;
  let failure: RpcTransportError | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const listener = (event: MessageEvent) => {
    const msg = event.data as RpcMessage | undefined;
    if (!msg || msg.kind !== 'rpc-response') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(deserializeError(msg.error));
  };
  endpoint.addEventListener('message', listener);

  function call(method: string, args: unknown[]): Promise<unknown> {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const transfer: Transferable[] = [];
    const wireArgs = args.map((a) => unbox(a, transfer));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const req: RpcRequest = { kind: 'rpc-request', id, method, args: wireArgs };
      try {
        endpoint.postMessage(req, transfer);
      } catch (err) {
        pending.delete(id);
        reject(new RpcTransportError(err instanceof Error ? err.message : String(err)));
      }
    });
  }

  const api = new Proxy({} as RpcClient<Api>, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => call(prop, args);
    },
  });

  const fail = (reason: string) => {
    failure = new RpcTransportError(reason);
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  };

  return {
    api,
    fail,
    dispose() {
      endpoint.removeEventListener('message', listener);
      fail('RPC client disposed');
    },
  };
}
