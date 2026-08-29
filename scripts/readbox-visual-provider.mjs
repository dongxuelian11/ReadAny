// Test-only deterministic OpenAI-compatible endpoint for real Read-Box UI evidence.
// It does not replace or mock the pinned Read-Box backend, agents, routers, or derived cache.
import http from "node:http";

const port = Number(process.env.READBOX_VISUAL_PROVIDER_PORT || 18765);

function responseFor(body) {
  const prompt = (body.messages || []).map((message) => message.content || "").join("\n");
  if (prompt.includes("相关章节原文") && prompt.includes("用户问题")) {
    return "根据本章，“ReadAny 原文是唯一权威来源。”因此 Read-Box 派生缓存可以重建，不能反向成为权威。[来源: 当前章]";
  }
  if (prompt.includes("用户的答案") && prompt.includes("请评判")) {
    return '{"correct":true,"explanation":"回答与当前章节原文一致：ReadAny 保留原文权威。"}';
  }
  if (prompt.includes("请基于以上内容生成") && prompt.includes("测验题")) {
    return '[{"type":"short_answer","question":"本章中，哪一方保留原文权威？","answer":"ReadAny","explanation":"ReadAny 是 canonical source authority。"}]';
  }
  if (prompt.includes("关键概念") || prompt.includes("术语")) {
    return '[{"term":"可重建派生缓存","explanation":"Read-Box 工作数据可以从 ReadAny 当前章原文重新生成。"}]';
  }
  if (prompt.includes("金句") || prompt.includes("摘录")) {
    return '[{"quote":"ReadAny 原文是唯一权威来源。","reason":"它明确界定了 canonical source authority。"}]';
  }
  return "本章说明 ReadAny 原文是唯一权威来源；Read-Box 只保存可重建的派生缓存，并提供提炼、问答和小测能力。";
}

const server = http.createServer((request, response) => {
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: responseFor(body) } }] }));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `${JSON.stringify({ status: "READY", endpoint: `http://127.0.0.1:${port}/v1`, testOnly: true })}\n`,
  );
});
