import express from "express";
import crypto from "node:crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL =
  process.env.BEDROCK_MODEL_ID || "twelvelabs.marengo-embed-3-0-v1:0";
const TOKEN = process.env.AWS_BEARER_TOKEN_BEDROCK;
const DAILY_SECRET = process.env.DAILY_SECRET;

if (!TOKEN || !DAILY_SECRET) {
  throw new Error("Set AWS_BEARER_TOKEN_BEDROCK and DAILY_SECRET in .env.");
}

const WORDS = [
  {
    word: "lighthouse",
    theme: "nature",
    category: "Coastal structures",
    clue: "A guiding light for travelers at sea."
  },
  {
    word: "glacier",
    theme: "nature",
    category: "Frozen landscapes",
    clue: "A slow-moving river that is not liquid."
  },
  {
    word: "mushroom",
    theme: "nature",
    category: "Living things",
    clue: "A forest umbrella that is not a plant."
  },
  {
    word: "volcano",
    theme: "nature",
    category: "Geological features",
    clue: "A mountain with something fiery underneath."
  },
  {
    word: "orchard",
    theme: "nature",
    category: "Cultivated landscapes",
    clue: "A place where fruit grows in rows."
  },
  {
    word: "cinnamon",
    theme: "food",
    category: "Spices",
    clue: "A fragrant bark often paired with apples."
  },
  {
    word: "sourdough",
    theme: "food",
    category: "Baked goods",
    clue: "This bread begins with a living starter."
  },
  {
    word: "popcorn",
    theme: "food",
    category: "Snacks",
    clue: "Heat turns these kernels into a movie companion."
  },
  {
    word: "honey",
    theme: "food",
    category: "Sweet ingredients",
    clue: "A golden product of very busy pollinators."
  },
  {
    word: "noodle",
    theme: "food",
    category: "Staple foods",
    clue: "A long strand that might be swimming in broth."
  },
  {
    word: "satellite",
    theme: "technology",
    category: "Space technology",
    clue: "It circles a world while relaying information."
  },
  {
    word: "keyboard",
    theme: "technology",
    category: "Input devices",
    clue: "A collection of keys that opens no doors."
  },
  {
    word: "firewall",
    theme: "technology",
    category: "Digital security",
    clue: "A traffic barrier that protects a network."
  },
  {
    word: "battery",
    theme: "technology",
    category: "Energy storage",
    clue: "It holds power for later."
  },
  {
    word: "robot",
    theme: "technology",
    category: "Machines",
    clue: "A programmable helper that can act in the physical world."
  }
];

const PAIRS = [
  ["music", "ocean"],
  ["forest", "internet"],
  ["memory", "building"],
  ["time", "river"],
  ["cooking", "chemistry"],
  ["winter", "silence"],
  ["garden", "city"],
  ["light", "knowledge"]
];

const sessions = new Map();
const cache = new Map();
const MAX_CACHE = 5000;
const DAY_MS = 86400000;

const normalize = value =>
  value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

function randomItem(items) {
  return items[crypto.randomInt(items.length)];
}

function dailyTarget(day) {
  const hash = crypto
    .createHmac("sha256", DAILY_SECRET)
    .update(day)
    .digest();
  return WORDS[hash.readUInt32BE(0) % WORDS.length];
}

function newHunt(play, theme, day) {
  const candidates =
    theme === "all" ? WORDS : WORDS.filter(w => w.theme === theme);

  return {
    mode: "hunt",
    play,
    theme,
    day,
    target: play === "daily" ? dailyTarget(day) : randomItem(candidates),
    guesses: [],
    hints: 0,
    solved: false
  };
}

function newTightrope() {
  return {
    mode: "tightrope",
    anchors: randomItem(PAIRS),
    guesses: [],
    hints: 0,
    solved: false
  };
}

function finished(game) {
  return game.mode === "hunt" ? game.solved : game.guesses.length >= 8;
}

function points(game) {
  if (game.mode !== "hunt") return null;
  return Math.max(0, 1000 - game.guesses.length * 20 - game.hints * 150);
}

function publicGame(game) {
  const best = game.guesses.length
    ? Math.max(...game.guesses.map(g => g.score))
    : null;

  return {
    mode: game.mode,
    play: game.play,
    theme: game.theme,
    day: game.day,
    anchors: game.anchors,
    guesses: game.guesses,
    best,
    done: finished(game),
    solved: game.solved,
    points: points(game),
    hintsUsed: game.hints,
    category: game.hints >= 1 ? game.target?.category : undefined,
    clue: game.hints >= 2 ? game.target?.clue : undefined,
    answer: game.solved ? game.target.word : undefined,
    remaining: game.mode === "tightrope" ? 8 - game.guesses.length : null
  };
}

// Only API calls create sessions.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");

  // Block cross-origin browser requests to these stateful endpoints.
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) {
        return res.status(403).json({ error: "Cross-origin request blocked." });
      }
    } catch {
      return res.status(403).json({ error: "Invalid origin." });
    }
  }

  const id = req.headers.cookie?.match(/(?:^|;\s*)mh_session=([a-f0-9]{48})/)?.[1];
  let session = id && sessions.get(id);

  if (!session) {
    const newId = crypto.randomBytes(24).toString("hex");
    session = { game: null, daily: null, busy: false, calls: [] };
    sessions.set(newId, session);

    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `mh_session=${newId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`
    );
  }

  session.seen = Date.now();
  req.session = session;
  next();
});

setInterval(() => {
  const cutoff = Date.now() - DAY_MS;
  for (const [id, session] of sessions) {
    if (session.seen < cutoff && !session.busy) sessions.delete(id);
  }
}, 60000).unref();

/*
 * Marengo provider adapter.
 *
 * The default uses a text input envelope for Marengo 3.0.
 * Check it against the "Inference Parameters and Responses" documentation
 * for your specific Bedrock deployment.
 *
 * If the documented envelope differs, configure BEDROCK_TEXT_TEMPLATE
 * as JSON with "__TEXT__" wherever the input text belongs.
 *
 * This adapter never substitutes mock embeddings after a failed call.
 */
function textPayload(text) {
  const template = process.env.BEDROCK_TEXT_TEMPLATE;
  if (!template) {
    return {
      inputType: "text",
      text: { inputText: text }
    };
  }

  function substitute(value) {
    if (value === "__TEXT__") return text;
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [key, substitute(val)])
      );
    }
    return value;
  }

  return substitute(JSON.parse(template));
}

function extractEmbedding(body) {
  const candidates = [
    body?.embedding,
    body?.data?.[0]?.embedding,
    body?.embeddings?.[0]?.embedding,
    body?.embeddings?.[0],
    body?.embeddings
  ];

  const vector = candidates.find(
    v =>
      Array.isArray(v) &&
      v.length === 512 &&
      v.every(n => typeof n === "number" && Number.isFinite(n))
  );

  if (!vector || !vector.some(n => n !== 0)) {
    throw new Error(
      "Unexpected Bedrock response: no valid 512-dimensional embedding. " +
      "Check the Marengo response schema in the provider adapter."
    );
  }

  return vector;
}

async function embedding(text) {
  const key = normalize(text);
  if (cache.has(key)) return cache.get(key);

  // Cache promises as well as results to deduplicate concurrent requests.
  const pending = (async () => {
    const url =
      `https://bedrock-runtime.${REGION}.amazonaws.com/model/` +
      `${encodeURIComponent(MODEL)}/invoke`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(textPayload(key)),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      // Do not forward provider responses or credential details to clients.
      console.error(`Bedrock invocation failed: HTTP ${response.status}`);

      if ([401, 403].includes(response.status)) {
        throw new Error(
          "Bedrock authorization failed. Check the server key, expiry, and model access."
        );
      }
      if (response.status === 429) {
        throw new Error("Bedrock is rate-limiting requests. Try again shortly.");
      }
      if (response.status === 400) {
        throw new Error(
          "Bedrock rejected the request. Verify the Marengo text request schema and model configuration."
        );
      }

      throw new Error(`Bedrock request failed (HTTP ${response.status}).`);
    }

    return extractEmbedding(await response.json());
  })();

  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, pending);

  try {
    return await pending;
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
}

function cosine(a, b) {
  if (a.length !== b.length) throw new Error("Embedding dimension mismatch.");

  let dot = 0;
  let aa = 0;
  let bb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }

  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}

// A game scale, NOT a probability or calibrated percentile.
const gameScore = similarity =>
  Math.round(Math.max(0, similarity) * 1000) / 10;

function temperature(score) {
  if (score >= 80) return "🔥 Blazing";
  if (score >= 65) return "🌶️ Hot";
  if (score >= 50) return "☀️ Warm";
  if (score >= 35) return "🌤️ Warming up";
  if (score >= 20) return "❄️ Cool";
  return "🧊 Cold";
}

app.get("/api/state", (req, res) => {
  res.json(req.session.game ? publicGame(req.session.game) : null);
});

app.post("/api/start", (req, res) => {
  const session = req.session;
  if (session.busy) {
    return res.status(409).json({ error: "Wait for your current guess." });
  }

  const { mode, play = "daily", theme = "all" } = req.body;
  if (!["hunt", "tightrope"].includes(mode)) {
    return res.status(400).json({ error: "Choose a valid game." });
  }

  if (mode === "tightrope") {
    session.game = newTightrope();
  } else {
    if (
      !["daily", "free"].includes(play) ||
      !["all", "nature", "food", "technology"].includes(theme)
    ) {
      return res.status(400).json({ error: "Invalid round settings." });
    }

    const day = new Date().toISOString().slice(0, 10);

    if (play === "daily") {
      if (!session.daily || session.daily.day !== day) {
        session.daily = newHunt("daily", "all", day);
      }
      session.game = session.daily;
    } else {
      session.game = newHunt("free", theme, day);
    }
  }

  res.json(publicGame(session.game));
});

app.post("/api/hint", (req, res) => {
  const game = req.session.game;
  if (req.session.busy) {
    return res.status(409).json({ error: "Wait for your current guess." });
  }
  if (!game || game.mode !== "hunt" || finished(game) || game.hints >= 2) {
    return res.status(400).json({ error: "No hint available." });
  }

  game.hints++;
  res.json(publicGame(game));
});

app.post("/api/guess", async (req, res) => {
  const session = req.session;
  const game = session.game;

  if (!game || finished(game)) {
    return res.status(400).json({ error: "Start a new round first." });
  }
  if (session.busy) {
    return res.status(409).json({ error: "A guess is already being scored." });
  }
  if (typeof req.body.word !== "string") {
    return res.status(400).json({ error: "Enter a word or short phrase." });
  }

  const word = normalize(req.body.word);
  if (
    !word ||
    word.length > 64 ||
    word.split(" ").length > 5 ||
    !/^[\p{L}\p{M}\p{N} '’-]+$/u.test(word)
  ) {
    return res.status(400).json({
      error: "Use a word or short phrase: up to 5 words and 64 characters."
    });
  }
  if (game.guesses.some(g => g.word === word)) {
    return res.status(400).json({ error: "You already tried that guess." });
  }
  if (game.mode === "tightrope" && game.anchors.includes(word)) {
    return res.status(400).json({
      error: "Find a connecting idea instead of repeating an anchor."
    });
  }

  const now = Date.now();
  session.calls = session.calls.filter(t => now - t < 60000);
  if (session.calls.length >= 12) {
    return res.status(429).json({ error: "Take a breath—12 guesses per minute." });
  }
  session.calls.push(now);
  session.busy = true;

  try {
    const guessVector = await embedding(word);
    let guess;

    if (game.mode === "hunt") {
      const targetVector = await embedding(game.target.word);
      const similarity = cosine(guessVector, targetVector);
      const solved = word === normalize(game.target.word);

      guess = {
        word,
        score: gameScore(similarity),
        similarity,
        label: solved ? "🎉 Found it!" : temperature(gameScore(similarity))
      };
      game.solved = solved;
    } else {
      const vectors = await Promise.all(game.anchors.map(embedding));
      const similarities = vectors.map(v => cosine(guessVector, v));
      const score = gameScore(Math.min(...similarities));

      guess = {
        word,
        score,
        similarities,
        sides: similarities.map(gameScore),
        label:
          Math.abs(similarities[0] - similarities[1]) < 0.1
            ? "⚖️ Balanced"
            : "↔️ Leaning to one side"
      };
    }

    const previous = game.guesses.length
      ? Math.max(...game.guesses.map(g => g.score))
      : -1;

    guess.personalBest = guess.score > previous;
    guess.number = game.guesses.length + 1;
    game.guesses.push(guess);

    res.json(publicGame(game));
  } catch (error) {
    res.status(502).json({
      error:
        error.name === "TimeoutError"
          ? "Bedrock took too long. Try again; your attempt was not used."
          : error.message
    });
  } finally {
    session.busy = false;
  }
});

app.listen(PORT, () => {
  console.log(`Meaning Games is running at http://localhost:${PORT}`);
});
