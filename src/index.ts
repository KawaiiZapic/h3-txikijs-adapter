import { H3, type HTTPMethod } from "h3";
import HttpHeaders, { type RequestData } from "http-headers";

const DEFAULT_MAX_HEADER_SIZE = 1024 * 16;
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024 * 1;

export type RequestHandler = (req: H3ServerRequest) => Response | Promise<Response> | undefined;

export interface ServeOptions {
  port?: number; // Listen port
  host?: string; // Binding address
  maxBodySize?: number; // Max body size can received from client, throw an error if size is exceeded.
  maxHeaderSize?: number; // Max headers size can received from client, throw an error if size is exceeded.
  enableLog?: boolean; // Enable a simple logging for debug.
  enableTiming?: boolean; // Enable respose timing in log.
  signal?: AbortSignal; // A signal to stop server
  encode?: TextEncoder["encode"]; // TextEncoder.prototype.encode implementation
  decode?: TextDecoder["decode"]; // TextDecoder.prototype.decode implementation
}

interface ServerContext extends Required<Omit<ServeOptions, "signal" | "encode" | "decode">> {
  log: (msg: string) => void;
  signal?: AbortSignal;
  encode: TextEncoder["encode"];
  decode: TextDecoder["decode"];
}

class H3ServerRequest extends Request {
  ip?: string;
}

const AllowedMethods: HTTPMethod[] = ["CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"];

const rCode = '\r'.charCodeAt(0);
const nCode = '\n'.charCodeAt(0);

const checkEnding = (buf: Uint8Array, size: number) => {
  if (size < 4) return -1;
  for (let i = size; i > 0; i--) {
    if (buf[i - 4] === rCode && buf[i - 3] === nCode && buf[i - 2] === rCode && buf[i - 1] === nCode) {
      return i;
    }
  }
  return -1;
}

const buildHeader = (headers: Headers): string => {
  let result = "";
  headers.forEach((v, k) => {
    if (k.toLowerCase().startsWith("connection")) return;
    result += `${k}: ${v}\r\n`;
  });
  result += "connection: close\r\n";
  return result;
}

const handleRequest = async (conn: tjs.Connection, handler: RequestHandler, ctx: ServerContext) => {
  const startTimeMs = ctx.enableTiming ? new Date().getTime() : 0;  // save some gc and time by skipping this
  try {
    const headerBuf = new Uint8Array(ctx.maxHeaderSize);
    let readSize = 0;
    let hasCheckMethod = false;
    let headerEndPosition = -1;
    while (true) {
      if (readSize >= ctx.maxHeaderSize) {
        throw new Error("Exceeded max header size " + ctx.maxHeaderSize);
      }
      const value = new Uint8Array(4096);
      const count = await conn.read(value) ?? 0;
      headerBuf.set(value, readSize);
      readSize += count;
      if (!hasCheckMethod && readSize >= 8) {
        const method = ctx.decode(headerBuf);
        if (!AllowedMethods.some(m => {
          return method.startsWith(m + " ");
        })) {
          throw new Error("Method is not allowed or is not a HTTP request");
        }
        hasCheckMethod = true;
      }
      headerEndPosition = checkEnding(headerBuf, readSize);
      if (headerEndPosition === -1 && count === 0) {
        throw new Error("Connection closed before body received.");
      }
      if (headerEndPosition >= 0) {
        break;
      }
    }
    const info = HttpHeaders(ctx.decode(headerBuf)) as RequestData;
    let reqBody: undefined | string | ReadableStream = void 0;
    if (!["GET", "HEAD"].includes(info.method)) {
      if (
        typeof info.headers["content-type"] === "string"
        && [
          "application/json",
          "application/x-www-form-urlencode",
          "text/plain"
        ].some(t => info.headers["content-type"]!.startsWith(t))) {
        let length = ctx.maxBodySize;
        const maybeLength = info.headers["content-length"];
        if (typeof maybeLength === "string" && parseInt(maybeLength, 10).toString() === maybeLength) {
          length = parseInt(maybeLength, 10);
          if (length > ctx.maxBodySize) {
            throw new Error("Exceeded max body size " + ctx.maxBodySize);
          }
        }
        const readInHeader = headerBuf.subarray(headerEndPosition, readSize);
        const bodyBuf = new Uint8Array(Math.max(length, readInHeader.length));

        bodyBuf.set(readInHeader);
        let bufOffset = readInHeader.length;
        while (bufOffset < length) {
          const bodyReadBuf = new Uint8Array(length);
          const readSize = await conn.read(bodyReadBuf) ?? 0;
          if (readSize === 0) {
            break;
          }
          bodyBuf.set(bodyReadBuf.subarray(0, Math.min(readSize, length - bufOffset)), bufOffset);
          bufOffset += readSize;
        }
        reqBody = ctx.decode(bodyBuf.subarray(0, length));
      } else {
        reqBody = undefined;
      }
    }
    const req = new H3ServerRequest(new URL(info.url, "http://" + (info.headers?.host || `${ctx.host}:${ctx.port}`)), {
      body: reqBody,
      keepalive: false,
      method: info.method,
      headers: info.headers as HeadersInit
    });
    req.ip = conn.localAddress.ip;
    const resp = (await handler(req)) ?? new Response(null, { status: 200 });
    let respStream: ReadableStream;
    // @ts-expect-error
    if (resp._bodyInit instanceof ReadableStream) {
      // @ts-expect-error
      respStream = resp._bodyInit;
    } else if (resp.body instanceof ReadableStream) {
      respStream = resp.body;
    } else {
      const blob = await resp.blob();
      resp.headers.set("Content-Length", blob.size.toString());
      respStream = blob.stream();
    }
    await conn.write(ctx.encode(`HTTP/1.1 ${resp.status} ${resp.statusText}\r\n${buildHeader(resp.headers)}\r\n`));
    await respStream.pipeTo(conn.writable);
    ctx.log(`${req.method} ${req.url} -> ${resp.status}${ctx.enableTiming ? ` (${new Date().getTime() - startTimeMs}ms)` : ''}`);
  } catch (e) {
    console.error(e);
    try {
      await conn.write(
        ctx.encode(`HTTP/1.1 500\r\nConnection: closed\r\n\r\n${e}`)
      );
    } catch { }
  } finally {
    conn.close();
  }
}

export const serve = async (app: H3, _options?: ServeOptions) => {
  const ctx: ServerContext = {
    maxBodySize: DEFAULT_MAX_BODY_SIZE,
    maxHeaderSize: DEFAULT_MAX_HEADER_SIZE,
    host: "0.0.0.0",
    port: 3000,
    enableLog: false,
    enableTiming: false,
    encode: TextEncoder.prototype.encode.bind(new TextEncoder()),
    decode: TextDecoder.prototype.decode.bind(new TextDecoder()),
    ..._options,
    log(msg: string) {
      if (!ctx.enableLog) return;
      console.log("! " + msg);
    }
  };
  const socket = await tjs.listen("tcp", ctx.host, ctx.port) as tjs.Listener;
  ctx.log(`Server start at http://${ctx.host}:${ctx.port}`);
  ctx.signal?.addEventListener("abort", () => {
    socket.close();
    ctx.log("Server closed");
  });
  while (!ctx.signal?.aborted) {
    const conn = await socket.accept();
    if (typeof conn === "undefined") continue;
    ctx.log("Accept from " + conn.remoteAddress.ip + ":" + conn.remoteAddress.port);
    void handleRequest(conn, app.fetch, ctx);
  }
}
