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
}

interface ServerContext extends Required<ServeOptions> {
  log: (msg: string) => void;
}

class H3ServerRequest extends Request {
  ip?: string;
}

const AllowedMethods: HTTPMethod[] = ["CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"];
const encoder = new TextEncoder();

const checkEnding = (buf: Uint8Array, size: number) => {
  if (size < 4) return false;
  return buf[size - 4] === 13 && buf[size - 3] === 10 && buf[size - 2] === 13 && buf[size - 1] === 10;
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

const createResponse = (code: number, msg: unknown)=> {
  return encoder.encode(`HTTP/1.1 ${code}\r\nConnection: closed\r\n\r\n` + msg);
}

const handleRequest = async (conn: tjs.Connection, handler: RequestHandler, ctx: ServerContext) => {
  try {
    const headerBuf = new Uint8Array(ctx.maxHeaderSize);
    const decoder = new TextDecoder();
    let readSize = 0;
    while (true) {
      if (readSize >= ctx.maxHeaderSize) {
        throw new Error("Exceeded max header size " + ctx.maxHeaderSize);
      }
      const value = new Uint8Array(1)
      const count = await conn.read(value);
      headerBuf.set(value, readSize);
      readSize += 1;
      if (readSize === 8) {
        const method = decoder.decode(headerBuf);
        if (!AllowedMethods.some(m => {
          return method.startsWith(m + " ");
        })) {
          throw new Error("Method is not allowed or is not a HTTP request");
        }
      }
      let isDone = false;
      if (value[0] === 10) {
        isDone = checkEnding(headerBuf, readSize);
      }
      if (!isDone && count === 0) {
        throw new Error("Connection closed before body received.");
      }
      if (isDone) {
        break;
      }
    }
    const info = HttpHeaders(decoder.decode(headerBuf)) as RequestData;
    let reqBody: undefined | string | ReadableStream = void 0;
    if (!["GET", "HEAD"].includes(info.method)) {
      if (
        typeof info.headers["content-type"] === "string"
        && [
         "application/json", 
         "application/x-www-form-urlencode",
         "text/plain"
        ].some(t => info.headers["content-type"]!.startsWith(t))
      ) {
        let length = ctx.maxBodySize;
        const maybeLength = info.headers["content-length"]
        if (typeof maybeLength === "string" && parseInt(maybeLength, 10).toString() === maybeLength) {
          length = parseInt(maybeLength, 10);
          if (length > ctx.maxBodySize) {
            throw new Error("Exceeded max body size " + ctx.maxBodySize);
          }
        }
        const bodyBuf = new Uint8Array(length);
        await conn.read(bodyBuf);
        reqBody = decoder.decode(bodyBuf);
      } else {
        reqBody = conn.readable;
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
    } else {
      const blob = await resp.blob();
      resp.headers.set("Content-Length", blob.size.toString());
      respStream = blob.stream();
    }
    await conn.write(encoder.encode(`HTTP/1.1 ${resp.status} ${resp.statusText}\n${buildHeader(resp.headers)}\r\n`));
    await respStream.pipeTo(conn.writable);
    ctx.log(`${req.method} ${req.url} -> ${resp.status}`);
  } catch (e) {
    console.error(e);
    try {
      await conn.write(createResponse(500, e));
    } catch (e) { }
  } finally {
    conn.close();
  }
}

export const serve = async (app: H3, _options?: ServeOptions) => {
  const ctx: ServerContext = {
    maxBodySize: DEFAULT_MAX_BODY_SIZE,
    maxHeaderSize: DEFAULT_MAX_HEADER_SIZE,
    host: "127.0.0.1",
    port: 3000,
    enableLog: false,
    ..._options,
    log(msg: string) {
      if (!ctx.enableLog) return;
      console.log("! " + msg);
    }
  };
  const socket = await tjs.listen("tcp", ctx.host, ctx.port) as tjs.Listener;
  ctx.log(`Server start at http://${ctx.host}:${ctx.port}`);
  while (true) {
    const conn = await socket.accept();
    ctx.log("Accept from " + conn.remoteAddress.ip + ":" + conn.remoteAddress.port);
    void handleRequest(conn, app.fetch, ctx);
  }
}
