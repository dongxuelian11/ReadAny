import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { READBOX_REF, backendDir, ensureReadBoxSource } from "./readbox-source.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fakeLlmResponse(body) {
  const prompt = (body.messages || []).map((message) => message.content || "").join("\n");
  if (prompt.includes("相关章节原文") && prompt.includes("用户问题")) {
    return "根据本章，“ReadAny 原文是唯一权威来源。”因此派生缓存不能反向成为权威。[来源: 当前章]";
  }
  if (prompt.includes("用户的答案") && prompt.includes("请评判")) {
    return '{"correct":true,"explanation":"答案与章节原文一致"}';
  }
  if (prompt.includes("请基于以上内容生成") && prompt.includes("测验题")) {
    return '[{"type":"short_answer","question":"哪一方保留原文权威？","answer":"ReadAny","explanation":"ReadAny 是 canonical source authority"}]';
  }
  if (prompt.includes("关键概念") || prompt.includes("术语")) {
    return '[{"term":"可重建缓存","explanation":"Read-Box 数据可由 ReadAny 原文重新生成"}]';
  }
  if (prompt.includes("金句") || prompt.includes("摘录")) {
    return '[{"quote":"ReadAny 原文是唯一权威来源。","reason":"验证引用映射"}]';
  }
  return "本章说明 ReadAny 原文是唯一权威来源，Read-Box 仅保存可重建派生缓存。";
}

async function waitForHealth(url, child, getSpawnError, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null)
      throw new Error(`Read-Box exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the real pinned Read-Box backend health endpoint");
}

async function json(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return JSON.parse(text);
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

ensureReadBoxSource();
const cacheDir = mkdtempSync(path.join(os.tmpdir(), "readany-readbox-real-"));
let worker;
let fakeServer;
let workerSpawnError;
const workerOutput = [];
const uvBin = process.env.READBOX_UV_BIN || "uv";

try {
  fakeServer = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: fakeLlmResponse(body) } }] }));
    });
  });
  const fakePort = await listen(fakeServer);
  const workerPort = await freePort();
  const workerUrl = `http://127.0.0.1:${workerPort}`;

  worker = spawn(
    uvBin,
    [
      "run",
      "--frozen",
      "--project",
      backendDir,
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(workerPort),
    ],
    {
      cwd: cacheDir,
      env: {
        ...process.env,
        PYTHONPATH: backendDir,
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "integration-test-only",
        LLM_API_BASE: `http://127.0.0.1:${fakePort}/v1`,
        LLM_MODEL: "deterministic-readbox-test",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  worker.once("error", (error) => {
    workerSpawnError = error;
  });
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.on("data", (chunk) => {
      workerOutput.push(String(chunk).replaceAll("integration-test-only", "[REDACTED]"));
      if (workerOutput.join("").length > 20_000) workerOutput.shift();
    });
  }

  await waitForHealth(workerUrl, worker, () => workerSpawnError);
  const health = await json(`${workerUrl}/api/health`);
  assert(health.status === "ok", "Read-Box /api/health did not return ok");

  const form = new FormData();
  form.append(
    "file",
    new Blob(["ReadAny 原文是唯一权威来源。 Read-Box 只保存可重建派生缓存。"], {
      type: "text/plain",
    }),
    "readany-derived-chapter.txt",
  );
  const imported = await json(`${workerUrl}/api/books/import`, { method: "POST", body: form });
  const chapters = await json(`${workerUrl}/api/books/${imported.book_id}/chapters`);
  assert(chapters.length === 1, `Expected one derived chapter, received ${chapters.length}`);
  const chapterId = chapters[0].id;

  const digestStart = await json(
    `${workerUrl}/api/digest/${imported.book_id}/chapters/${chapterId}`,
    { method: "POST" },
  );
  assert(digestStart.status === "completed", `Digest status was ${digestStart.status}`);
  const digest = await json(`${workerUrl}/api/digest/${imported.book_id}/chapters/${chapterId}`);
  assert(
    digest.summary && digest.concepts.length === 1 && digest.quotes.length === 1,
    "Digest contract was incomplete",
  );

  const qaResponse = await fetch(`${workerUrl}/api/qa/${imported.book_id}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "原文权威属于谁？" }),
  });
  const qaSse = await qaResponse.text();
  const qaTokens = qaSse
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()).t);
  const qaDone = qaTokens.includes("[DONE]");
  const qaText = qaTokens.filter((token) => token !== "[DONE]").join("");
  assert(
    qaResponse.ok && qaDone && qaText.includes("ReadAny"),
    `QA SSE contract failed: ${qaText.slice(0, 800)}`,
  );

  const quiz = await json(`${workerUrl}/api/quiz/${imported.book_id}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chapter_id: chapterId, count: 1, mode: "chapter" }),
  });
  assert(quiz.questions.length === 1, "Quiz start contract returned no question");
  const judgement = await json(`${workerUrl}/api/quiz/${imported.book_id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: quiz.questions[0], answer: "ReadAny" }),
  });
  assert(judgement.correct === true && judgement.explanation, "Quiz judgement contract failed");
  const next = await json(`${workerUrl}/api/quiz/${imported.book_id}/next`);
  assert(next.question || next.done === true, "Quiz next contract failed");

  process.stdout.write(
    `${JSON.stringify(
      {
        pinnedRef: READBOX_REF,
        backendHealth: "PASS",
        nativeImportAndMapping: "PASS",
        digest: "PASS",
        qaSse: "PASS",
        quizStartAnswerNext: "PASS",
        provider: "LOCAL_DETERMINISTIC_OPENAI_COMPATIBLE",
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (workerOutput.length) process.stderr.write(workerOutput.join("").slice(-12_000));
  process.exitCode = 1;
} finally {
  stopChild(worker);
  if (fakeServer) await new Promise((resolve) => fakeServer.close(resolve));
  rmSync(cacheDir, { recursive: true, force: true });
}
