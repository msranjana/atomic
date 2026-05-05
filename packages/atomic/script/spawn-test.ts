const proc = Bun.spawn([
  "C:\\repos\\atomic\\packages\\atomic\\dist\\windows-x64\\bin\\atomic.exe",
  "--version",
], {
  stdout: "pipe",
  stderr: "pipe",
});

await proc.exited;
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
console.log("exitCode:", proc.exitCode);
console.log("stdout:", JSON.stringify(stdout));
console.log("stderr:", JSON.stringify(stderr));
