const dotenv = require("dotenv");
dotenv.config();

const https = require("https");
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { epoxyPath } = require("@mercuryworkshop/epoxy-transport");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const cheerio = require("cheerio");
const fastify = require("fastify");
const path = require("path");

const server = fastify({ logger: false });

const { createWorker } = require("tesseract.js");

// -------------------- FIX: safeFetch (MISSING IN YOUR CODE) --------------------
const fetch = global.fetch || ((...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args))
);

async function safeFetch(url, options = {}) {
  return fetch(url, options);
}

// -------------------- TLS BYPASS (unchanged) --------------------
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
https.globalAgent.options.rejectUnauthorized = false;

// -------------------- JSON PARSER --------------------
server.addContentTypeParser(
  "application/json",
  { parseAs: "string", bodyLimit: 4 * 1024 * 1024 },
  function (req, body, done) {
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  }
);

// -------------------- STATIC FILES --------------------
server.register(require("@fastify/static"), {
  root: path.join(__dirname, "/public/"),
  prefix: "/"
});

server.register(require("@fastify/static"), { root: scramjetPath, prefix: "/educational_vr/", decorateReply: false });
server.register(require("@fastify/static"), { root: epoxyPath, prefix: "/epoxy/", decorateReply: false });
server.register(require("@fastify/static"), { root: baremuxPath, prefix: "/baremux/", decorateReply: false });

// -------------------- RATE LIMIT --------------------
server.register(require("@fastify/rate-limit"), {
  max: 1000,
  timeWindow: "1m"
});

server.register(require("@fastify/rate-limit"), {
  max: 20,
  timeWindow: "1m",
  keyGenerator: (req) => req.ip
}, { routeSpecific: true });

// -------------------- CHAT ROUTE --------------------
server.post("/chat", async function (req, res) {
  const { message, history = [], images = [] } = req.body;

  if (!message && images.length === 0) {
    return res.code(400).send({ error: "Message required" });
  }

  let imageText = "";

  if (images.length > 0) {
    try {
      const worker = await createWorker("eng");

      const limitedImages = images.slice(0, 3);

      for (const imgData of limitedImages) {
        const base64Data = imgData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");

        const { data: { text } } = await worker.recognize(buffer);

        if (text.trim()) {
          imageText += `\n[Image text]: ${text.trim()}\n`;
        }
      }

      await worker.terminate();
    } catch (err) {
      console.error("OCR error:", err);
      imageText = "\n[Warning: OCR failed]\n";
    }
  }

  const userContent = imageText
    ? `${message || "Analyze image:"}\n${imageText}`
    : message;

  const messages = [
    {
      role: "system",
      content: "You are Axiom AI, a helpful assistant."
    },
    ...history,
    {
      role: "user",
      content: userContent
    }
  ];

  try {
    const modelMap = {
      "0": "llama-3.1-8b-instant",
      "1": "openai/gpt-oss-120b"
    };

    const modelToUse = modelMap[req.body.model] || modelMap["0"];

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: modelToUse,
        messages,
        max_tokens: 4096,
        temperature: 0.7
      })
    });

    const data = await response.json();

    return res.send({
      response: data.choices?.[0]?.message?.content || "No response"
    });

  } catch (error) {
    console.error(error);
    return res.code(500).send({ error: error.message });
  }
});

// -------------------- SW --------------------
server.get("/educational_sl/sw.js", (req, res) => {
  res.header("Service-Worker-Allowed", "/");
  res.sendFile("educational_sl/sw.js");
});

// -------------------- WISP --------------------
server.server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());

  if (req.url.startsWith("/edu/")) {
    try {
      wisp.routeRequest(req, socket, head);
    } catch {
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

// -------------------- SEARCH --------------------
server.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.code(400).send({ error: "Query required" });

  try {
    const response = await safeFetch(
      `https://lite.duckduckgo.com/lite/search?q=${encodeURIComponent(q)}`
    );

    const html = await response.text();
    res.send(getDuckDuckGoLiteUrls(html));

  } catch (error) {
    res.code(500).send({ error: error.message });
  }
});

// -------------------- HTML PARSER --------------------
function getDuckDuckGoLiteUrls(html) {
  const $ = cheerio.load(html);
  const results = [];

  $("a.result-link").each((i, el) => {
    const $link = $(el);
    const url = $link.attr("href");
    if (!url) return;

    let actualUrl = url;

    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      actualUrl = decodeURIComponent(uddgMatch[1]);
    }

    results.push({
      url: actualUrl,
      title: $link.text().trim() || "Unknown"
    });
  });

  return results;
}

// -------------------- GOOGLE AUTOCOMPLETE --------------------
server.get("/search_complete/*", async (req, res) => {
  const query = req.params["*"];
  if (!query) return res.code(400).send("Missing query");

  try {
    const response = await safeFetch(
      `https://google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`
    );

    res.send(await response.json());
  } catch (e) {
    res.code(500).send("Error: " + e.message);
  }
});

// -------------------- PREMIUM KEYS --------------------
let premium_keys = ["stya"];

try {
  const keys = process.env.PREMIUM_KEYS;
  if (keys) premium_keys = keys.split(",");
} catch {}

server.get("/api/check-premium", async (req, res) => {
  res.send({ success: premium_keys.includes(req.headers.key) });
});

// -------------------- START SERVER (FIXED FOR RENDER) --------------------
const PORT = process.env.PORT || 8080;

server.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log("Axiom started!");
  console.log(`Running on port ${PORT}`);
}).catch((e) => {
  console.log("Failed to start server: " + e);
});