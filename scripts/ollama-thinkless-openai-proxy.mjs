#!/usr/bin/env node
import http from "node:http";

const listenHost = process.env.OLLAMA_PROXY_HOST || "0.0.0.0";
const listenPort = Number.parseInt(process.env.OLLAMA_PROXY_PORT || "11435", 10);
const upstream = (process.env.OLLAMA_PROXY_UPSTREAM || "http://172.18.16.1:11434").replace(/\/+$/, "");
const numCtx = Number.parseInt(process.env.OLLAMA_PROXY_NUM_CTX || "8192", 10);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return body.trim() ? JSON.parse(body) : {};
}

function normalizeMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => ({
        role: String(message?.role || "user"),
        content: Array.isArray(message?.content)
          ? message.content.map((part) => part?.text || "").join("\n")
          : String(message?.content ?? ""),
      }))
    : [];
}

function finishReason(doneReason) {
  if (doneReason === "stop") return "stop";
  if (doneReason === "length") return "length";
  return doneReason || "stop";
}

function sendSse(res, payloads) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function proxyModels(res) {
  const response = await fetch(`${upstream}/v1/models`);
  const text = await response.text();
  res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
  res.end(text);
}

async function proxyStreamingChat(res, model, nativeBody) {
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  const response = await fetch(`${upstream}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...nativeBody, stream: true }),
  });

  if (!response.ok) {
    const text = await response.text();
    writeSse(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: "" },
          finish_reason: "stop",
        },
      ],
      error: {
        message: text || `Ollama upstream returned ${response.status}`,
        type: "upstream_error",
      },
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finish = "stop";
  let sentContent = false;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const payload = JSON.parse(line);
      const content = String(payload?.message?.content ?? payload?.response ?? "");
      if (content) {
        sentContent = true;
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        });
      }
      if (payload?.done) finish = finishReason(payload?.done_reason);
    }
  }

  if (buffer.trim()) {
    const payload = JSON.parse(buffer);
    const content = String(payload?.message?.content ?? payload?.response ?? "");
    if (content) {
      sentContent = true;
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
    }
    if (payload?.done) finish = finishReason(payload?.done_reason);
  }

  if (!sentContent) {
    writeSse(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: "" }, finish_reason: null }],
    });
  }
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function proxyChat(req, res) {
  const body = await readJson(req);
  const model = String(body.model || process.env.OLLAMA_PROXY_MODEL || "qwen3.5:27b");
  const nativeBody = {
    model,
    messages: normalizeMessages(body.messages),
    stream: false,
    think: false,
    options: {
      temperature: body.temperature ?? 0,
      num_predict: body.max_tokens ?? body.max_completion_tokens ?? 512,
      ...(Number.isFinite(numCtx) && numCtx > 0 ? { num_ctx: numCtx } : {}),
    },
  };

  if (body.stream === true) {
    await proxyStreamingChat(res, model, nativeBody);
    return;
  }

  const response = await fetch(`${upstream}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nativeBody),
  });
  const payload = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) {
    sendJson(res, response.status, {
      error: {
        message: payload?.error || `Ollama upstream returned ${response.status}`,
        type: "upstream_error",
      },
    });
    return;
  }
  const content = String(payload?.message?.content ?? payload?.response ?? "");
  const completion = {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_ollama_native_think_false",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason(payload?.done_reason),
      },
    ],
    usage: {
      prompt_tokens: payload?.prompt_eval_count ?? 0,
      completion_tokens: payload?.eval_count ?? 0,
      total_tokens: (payload?.prompt_eval_count ?? 0) + (payload?.eval_count ?? 0),
    },
  };
  if (body.stream === true) {
    const id = completion.id;
    const created = completion.created;
    sendSse(res, [
      {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      },
      {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: completion.choices[0].finish_reason }],
      },
    ]);
    return;
  }
  sendJson(res, 200, completion);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  Promise.resolve()
    .then(async () => {
      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        await proxyModels(res);
        return;
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        await proxyChat(req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, upstream });
        return;
      }
      sendJson(res, 404, { error: { message: "not found", type: "not_found" } });
    })
    .catch((error) => {
      sendJson(res, 500, { error: { message: error?.message || String(error), type: "proxy_error" } });
    });
});

server.listen(listenPort, listenHost, () => {
  console.log(`Ollama thinkless OpenAI proxy listening on http://${listenHost}:${listenPort}/v1 -> ${upstream}`);
});
