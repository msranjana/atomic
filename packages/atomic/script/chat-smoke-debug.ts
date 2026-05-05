import { spawn as ptySpawn } from "bun-pty";

const atomicBin = process.argv[2];
const args = process.argv.slice(3);

console.log(`bin: ${atomicBin}`);
console.log(`args: ${JSON.stringify(args)}`);

const proc = ptySpawn(atomicBin, args, {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

console.log(`pid: ${proc.pid}`);

const chunks: string[] = [];
proc.onData((data) => {
  chunks.push(data);
});

const TIMEOUT_MS = 15000;
const killTimer = setTimeout(() => {
  console.log("TIMEOUT, killing");
  try { proc.kill(); } catch {}
}, TIMEOUT_MS);

await new Promise<void>((resolve) => {
  proc.onExit((info) => {
    clearTimeout(killTimer);
    console.log(`exit info: ${JSON.stringify(info)}`);
    resolve();
  });
});

const captured = chunks.join("");
console.log("--- captured ---");
console.log(JSON.stringify(captured));
console.log("--- raw ---");
console.log(captured);
