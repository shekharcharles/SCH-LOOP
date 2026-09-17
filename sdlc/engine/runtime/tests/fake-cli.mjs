// A stand-in for `claude -p --output-format stream-json`. FAKE_MODE: ok | loop | silent | fail | ratelimit
const mode = process.env.FAKE_MODE || "ok";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => input += d);
process.stdin.on("end", async () => {
  const line = o => process.stdout.write(JSON.stringify(o) + "\n");
  line({ type: "system", subtype: "init", session_id: "fake-session", cwd: process.cwd() });
  const tool = (name, inp) => line({ type: "assistant", message: { model: "fake-1", content: [{ type: "tool_use", name, input: inp }] } });
  if (mode === "loop") { for (let i = 0; i < 20; i++) { tool("Read", { f: "a" }); tool("Grep", { q: "x" }); tool("Read", { f: "b" }); tool("Bash", { c: "npm test" }); } }
  // Long enough that the process never ends on its own during a test run: a 60s sleep meant a starved
  // silence timer could be overtaken by the fake simply exiting. It must be a real pending TIMER, not a
  // promise that can never settle — Node exits immediately when the only thing outstanding is the
  // latter, which made this fake die in 92ms and report FAILED instead of going quiet.
  else if (mode === "silent") { tool("Read", { f: "a" }); await new Promise(r => setTimeout(r, 3_600_000)); }
  else if (mode === "fail") { process.stderr.write("boom\n"); process.exit(3); }
  else if (mode === "ratelimit") { process.stderr.write("Error: rate limit reached, retry later\n"); process.exit(1); }
  else { tool("Read", { f: "a" }); tool("Edit", { f: "a" }); }
  const reply = process.env.FAKE_REPLY || `echo:${input.length}`;
  line({ type: "assistant", message: { model: "fake-1", content: [{ type: "text", text: reply }] } });
  line({ type: "result", result: reply, session_id: "fake-session", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 } });
});
