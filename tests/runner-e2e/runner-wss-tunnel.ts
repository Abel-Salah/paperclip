import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

/** The public tunnel can reach only authenticated PRP upgrades, never board APIs. */
export function allowsRunnerUpgrade(method: string | undefined, url: string | undefined): boolean {
  return method === "GET" && /^\/api\/runner\/v1\/connect\/[A-Za-z0-9_-]+$/.test(url ?? "");
}

export async function startRunnerWssTunnel(binary: string, targetPort: number) {
  const sockets = new Set<net.Socket>();
  const proxy = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  proxy.on("upgrade", (request, socket, head) => {
    if (!allowsRunnerUpgrade(request.method, request.url)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return;
    }
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(upstream);
    upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("connect", () => {
      const headers = Object.entries(request.headers).filter(([name]) => name !== "host")
        .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined).map((v) => `${name}: ${v}`));
      upstream.write(`GET ${request.url} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address() as net.AddressInfo;
  const child = spawn(binary, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${address.port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const close = async () => {
    child.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  };
  try {
    const publicUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Runner-only tunnel did not start in 60 seconds")), 60000);
      const read = (data: Buffer) => {
        const match = data.toString().match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
        if (match) { clearTimeout(timeout); resolve(`wss://${match[1]}`); }
      };
      child.stdout.on("data", read); child.stderr.on("data", read);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Runner-only tunnel exited during startup")); });
    });
    return { publicUrl, close };
  } catch (error) { await close(); throw error; }
}
