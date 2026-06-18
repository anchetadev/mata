// End-to-end smoke test: spawn the built server over stdio and exercise tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/server.js"] });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const est = await client.callTool({
  name: "estimate_impact",
  arguments: { model: "claude-opus-4-5", input_tokens: 5000, output_tokens: 1500, scenario: "midpoint" },
});
console.log("\nestimate_impact:\n" + (est.content as any)[0].text);

await client.callTool({
  name: "log_usage",
  arguments: { model: "gpt-4o", input_tokens: 2000, output_tokens: 800, source: "smoke-test" },
});

const rep = await client.callTool({ name: "report", arguments: { period: "all" } });
console.log("\nreport:\n" + (rep.content as any)[0].text);

const eff = await client.callTool({
  name: "efficiency_score",
  arguments: {
    turns: [
      { role: "user", text: "make a thing" },
      { role: "assistant", text: "Could you clarify what kind of thing and the constraints?" },
      { role: "user", text: "no, actually I meant a CLI tool in python" },
      { role: "assistant", text: "Done." },
    ],
  },
});
console.log("\nefficiency_score:\n" + (eff.content as any)[0].text);

await client.close();
console.log("\n✅ smoke test complete");
