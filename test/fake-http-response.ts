import { EventEmitter } from "node:events";

/** A minimal `http.ServerResponse` double for exercising `streamResponse`
 *  (server/stream-response.ts) without a real socket. `write` reports
 *  `acceptWrites` as Node's own backpressure signal, and a caller that wants
 *  a blocked write to unblock emits "drain" the same way a real socket does. */
export class FakeResponse extends EventEmitter {
  destroyed = false;
  closed = false;
  writableEnded = false;
  headersWritten = 0;
  writes = 0;
  ends = 0;
  output = "";
  acceptWrites = true;
  writeHead(): this { this.headersWritten += 1; return this; }
  write(value: unknown): boolean {
    this.writes += 1;
    this.output += String(value);
    return this.acceptWrites;
  }
  end(): this { this.writableEnded = true; this.ends += 1; return this; }
}
