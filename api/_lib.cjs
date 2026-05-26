const fsSync = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
loadLocalEnv(path.join(root, ".env.local"));
const resumeDir = path.join(root, "resume-bases");
const outputDir = path.join(root, "outputs");
const port = Number(process.env.PORT || 4173);
const mlbBaseUrl = "https://statsapi.mlb.com";
const oddsApiKey = process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || "";
const oddsApiBaseUrl = (process.env.ODDS_API_BASE_URL || "https://api.theoddsapi.com").replace(/\/+$/, "");
const BACKTEST_MAX_DAYS = 10;
const SNAPSHOT_SCHEMA_VERSION = 1;
const BLOB_SNAPSHOT_PREFIX = "snapshots/mlb/";
const SAMFORD_MAX_STAT_EDGE = 15;
const PITCHER_PQS_BASELINE = 11.5;
const PITCHER_PQS_SLOPE = 0.34;
const CALIBRATION_LOOKBACK_DAYS = 30;
const MIN_CALIBRATION_OVERALL_PICKS = 30;
const MIN_CALIBRATION_BUCKET_PICKS = 20;
const WEIGHTED_SIGMOID_K = 2.5;

const samfordArticleTopTen = [
  { id: "RD", label: "1 RD", weightRank: 10, direction: "higher", articleName: "Run differential" },
  { id: "ERA", label: "2 ERA", weightRank: 9, direction: "lower", articleName: "Earned run average" },
  { id: "FIP", label: "3 FIP", weightRank: 8, direction: "lower", articleName: "Fielding independent pitching" },
  { id: "LOB_pct", label: "4 LOB%", weightRank: 7, direction: "higher", articleName: "Left on base percentage" },
  { id: "pWAR", label: "5 pWAR", weightRank: 6, direction: "higher", articleName: "Pitching WAR" },
  { id: "WHIP", label: "6 WHIP", weightRank: 5, direction: "lower", articleName: "Walks plus hits per inning pitched" },
  { id: "H9", label: "7 H/9", weightRank: 4, direction: "lower", articleName: "Hits allowed per 9 innings" },
  { id: "BAA", label: "8 BAA", weightRank: 3, direction: "lower", articleName: "Batting average against" },
  { id: "oWAR", label: "9 oWAR", weightRank: 2, direction: "higher", articleName: "Offensive WAR" },
  { id: "SV", label: "10 SV", weightRank: 1, direction: "higher", articleName: "Saves" },
];
const samfordArticleTotalWeight = samfordArticleTopTen.reduce((sum, item) => sum + item.weightRank, 0);

const oddsBookmakers = [
  { key: "fanduel", label: "FanDuel", aliases: ["fanduel", "fan duel"] },
  { key: "draftkings", label: "DraftKings", aliases: ["draftkings", "draft kings"] },
];

const teamAliases = {
  "arizona d backs": "arizona diamondbacks",
  "arizona dbacks": "arizona diamondbacks",
  "athletics": "athletics",
  "oakland athletics": "athletics",
  "sacramento athletics": "athletics",
  "la angels": "los angeles angels",
  "la dodgers": "los angeles dodgers",
  "ny mets": "new york mets",
  "ny yankees": "new york yankees",
  "sf giants": "san francisco giants",
  "sd padres": "san diego padres",
  "tb rays": "tampa bay rays",
  "chicago whitesox": "chicago white sox",
};

const sports = [
  { id: "mlb", name: "MLB", enabled: true },
];

const mlbModels = [
  {
    id: "core5",
    sport: "mlb",
    name: "1 - Core five-factor predictor",
    shortName: "1 Core 5",
    description: "Original five-factor MLB model.",
    components: [
      { id: "spFip", label: "Starter FIP", weight: 0.30 },
      { id: "pyth", label: "Pythagorean W%", weight: 0.25 },
      { id: "bullpenEra", label: "Bullpen 15-day ERA", weight: 0.20 },
      { id: "lineupWrc", label: "Lineup wRC+", weight: 0.18 },
      { id: "homeField", label: "Home field", weight: 0.07 },
    ],
  },
  {
    id: "expanded10",
    sport: "mlb",
    name: "2 - Expanded ten-factor predictor",
    shortName: "2 Expanded 10",
    description: "Ten-factor MLB model using pitching command, matchup offense, team strength, bullpen workload, bullpen skill, run environment, and defense.",
    components: [
      { id: "spKbb", label: "SP K-BB%", weight: 0.17 },
      { id: "spFip", label: "SP FIP", weight: 0.15 },
      { id: "lineupWrc", label: "Lineup wRC+", weight: 0.14 },
      { id: "pyth", label: "Pythagorean W%", weight: 0.12 },
      { id: "bullpenAvailability", label: "Bullpen availability", weight: 0.10 },
      { id: "bullpenSkill", label: "Bullpen skill", weight: 0.09 },
      { id: "lineupQuality", label: "Lineup quality", weight: 0.08 },
      { id: "spContact", label: "SP contact allowed", weight: 0.06 },
      { id: "park", label: "Park fit", weight: 0.05 },
      { id: "defense", label: "Defense proxy", weight: 0.04 },
    ],
  },
  {
    id: "pitchingContext18",
    sport: "mlb",
    name: "3 - Pitching context predictor",
    shortName: "3 Pitching Context",
    description: "Pitching-heavy model using HR-normalized starter skill, platoon splits, starter workload, bullpen exposure, offense quality, park context, and neutral fallbacks for unavailable weather, umpire, and framing inputs.",
    scaleFactor: 2.5,
    components: [
      { id: "pitcherContext", label: "Starter xFIP context", weight: 0.30 },
      { id: "bullpenContext", label: "Bullpen exposure", weight: 0.25 },
      { id: "offenseContext", label: "Offense quality", weight: 0.20 },
      { id: "gameContext", label: "Game context", weight: 0.25 },
    ],
  },
  {
    id: "starterPqs",
    sport: "mlb",
    name: "4 - Starter pitcher quality predictor",
    shortName: "4 Starter PQS",
    description: "Starting-pitcher-only quality report using SIERA-style skill, K-BB%, whiff/contact proxies, recent command form, rest, pitch budget, times-through-order, platoon matchup, and run-environment adjustments.",
    components: [
      { id: "baseQuality", label: "Base quality", weight: 0.55 },
      { id: "recentForm", label: "Recent form", weight: 0.15 },
      { id: "matchup", label: "Matchup", weight: 0.15 },
      { id: "projection", label: "PQS projection", weight: 0.15 },
    ],
  },
  {
    id: "samfordTop10",
    sport: "mlb",
    name: "5 - Samford top-10 win indicators",
    shortName: "5 Samford Top 10",
    description: "Two-team rules engine based on the Samford 2022 correlation ranking: run differential, ERA, FIP, strand rate, pitching WAR, WHIP, H/9, batting average against, offensive WAR, and saves.",
    components: samfordArticleTopTen.map((item) => ({
      id: item.id,
      label: item.label,
      weight: item.weightRank / samfordArticleTotalWeight,
    })),
  },
  {
    id: "weightedSigmoid",
    sport: "mlb",
    name: "6 - Normalized weighted sigmoid predictor",
    shortName: "6 Sigmoid",
    description: "Normalizes pitcher, bullpen, offense, environment, and umpire/framing metrics to 0-1, applies the requested weights, and converts the score gap to win probability with a tuned sigmoid.",
    components: [
      { id: "startingPitcher", label: "Starting Pitcher", weight: 0.40 },
      { id: "bullpen", label: "Bullpen", weight: 0.25 },
      { id: "offense", label: "Offense", weight: 0.20 },
      { id: "environment", label: "Environment", weight: 0.10 },
      { id: "umpireFraming", label: "Umpire / Framing", weight: 0.05 },
    ],
  },
];

const parkRunFactors = {
  "Coors Field": 115,
  "Great American Ball Park": 107,
  "Fenway Park": 105,
  "Wrigley Field": 104,
  "Yankee Stadium": 103,
  "Citizens Bank Park": 103,
  "Chase Field": 101,
  "Daikin Park": 101,
  "Rogers Centre": 101,
  "Truist Park": 101,
  "American Family Field": 100,
  "Kauffman Stadium": 99,
  "Oriole Park at Camden Yards": 99,
  "Angel Stadium": 98,
  "Comerica Park": 98,
  "T-Mobile Park": 96,
  "Petco Park": 95,
  "loanDepot park": 94,
  "Oracle Park": 94,
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function loadLocalEnv(filePath) {
  let raw = "";
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) return;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  });
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|h1|h2|h3|h4|section|article|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function titleFromHtml(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function safeJoin(base, requested) {
  const resolved = path.resolve(base, requested);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    throw new Error("Invalid path");
  }
  return resolved;
}

function privateStaticPath(requestedPath) {
  const parts = requestedPath.split("/").filter(Boolean);
  return parts[0] === "data" || parts.some((part) => part.startsWith("."));
}

function labelFor(file) {
  return file
    .replace(/\.(docx|md|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFileName(name) {
  const cleaned = path.basename(decodeURIComponent(name || "resume.docx")).replace(/[^\w .()-]/g, "_").trim();
  if (!/\.(docx|md|txt)$/i.test(cleaned)) throw new Error("Only .docx, .md, and .txt resume files are supported.");
  if (/^readme\./i.test(cleaned)) throw new Error("That filename is reserved.");
  return cleaned || "resume.docx";
}

function outputFileName(name) {
  const cleaned = path.basename(decodeURIComponent(name || "download")).replace(/[^\w .()-]/g, "_").trim();
  if (!/\.(docx|txt)$/i.test(cleaned)) throw new Error("Only .docx and .txt outputs are supported.");
  return cleaned || "download.docx";
}

function todayIsoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function easternIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  return Math.round((end - start) / 86400000);
}

function dateRange(startDate, endDate) {
  const days = daysBetween(startDate, endDate);
  return Array.from({ length: days + 1 }, (_, index) => addDays(startDate, index));
}

function num(value, fallback = 0) {
  if (value === undefined || value === null || value === "" || value === ".---" || value === "-.--") return fallback;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function safeDivide(top, bottom, fallback = 0) {
  return bottom ? top / bottom : fallback;
}

function higherScore(value, low, high, fallback = 50) {
  if (!Number.isFinite(value)) return fallback;
  return clamp(((value - low) / (high - low)) * 100);
}

function lowerScore(value, high, low, fallback = 50) {
  if (!Number.isFinite(value)) return fallback;
  return clamp(((high - value) / (high - low)) * 100);
}

function normalizeHigherMetric(value, min, max, fallback = 0.5) {
  if (!Number.isFinite(value) || max <= min) return fallback;
  return clamp((value - min) / (max - min), 0, 1);
}

function normalizeLowerMetric(value, min, max, fallback = 0.5) {
  if (!Number.isFinite(value) || max <= min) return fallback;
  return clamp((max - value) / (max - min), 0, 1);
}

function sigmoidProbability(scoreDiff, k = 5) {
  if (!Number.isFinite(scoreDiff)) return 0.5;
  return 1 / (1 + Math.exp(-k * scoreDiff));
}

function averageScores(...values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 50;
}

function edgeBucket(margin) {
  if (!Number.isFinite(margin)) return "unavailable";
  if (margin >= 12) return "strong";
  if (margin >= 7) return "solid";
  if (margin >= 3) return "lean";
  return "tight";
}

function edgeBucketLabel(bucket) {
  if (bucket === "strong") return "Strong: margin 12+";
  if (bucket === "solid") return "Solid: margin 7-11.9";
  if (bucket === "lean") return "Lean: margin 3-6.9";
  if (bucket === "tight") return "Tight: margin under 3";
  return "Unavailable";
}

function emptyCalibrationProfile(modelId, message = "No saved pregame calibration sample is available yet.") {
  return {
    available: false,
    modelId,
    lookbackDays: CALIBRATION_LOOKBACK_DAYS,
    source: "none",
    message,
    overall: { picks: 0, correct: 0, incorrect: 0, accuracy: null },
    buckets: {},
  };
}

function confidenceRatingFromAccuracy(accuracy, picks, bucket = "unavailable", sampleFloor = MIN_CALIBRATION_BUCKET_PICKS) {
  if (!Number.isFinite(accuracy) || picks < sampleFloor) {
    return {
      bucket,
      label: "Unproven",
      className: "unproven",
      action: "Track only",
      reason: `Need ${sampleFloor}+ saved pregame picks in this bucket before trusting it.`,
    };
  }
  if (accuracy >= 0.62) {
    return { bucket, label: "Strong", className: "strong", action: "Playable", reason: "Saved pregame history has cleared the strong accuracy bar." };
  }
  if (accuracy >= 0.56) {
    return { bucket, label: "Solid", className: "solid", action: "Playable", reason: "Saved pregame history has been meaningfully above break-even." };
  }
  if (accuracy >= 0.52) {
    return { bucket, label: "Lean", className: "lean", action: "Small edge", reason: "Saved pregame history is above break-even but not strong." };
  }
  return { bucket, label: "No edge", className: "no-edge", action: "Pass", reason: "Saved pregame history has not beaten a coin-flip baseline." };
}

function confidenceForGame(game, calibration = null) {
  const bucket = edgeBucket(game.margin);
  if (!game.projectionAvailable || bucket === "unavailable") {
    return {
      bucket,
      label: "No projection",
      className: "unavailable",
      sampleSize: 0,
      accuracy: null,
      calibrated: false,
      reason: game.projectionNote || "Projection unavailable.",
    };
  }
  if (!calibration?.available) {
    return {
      bucket,
      label: "Uncalibrated",
      className: "unproven",
      sampleSize: 0,
      accuracy: null,
      calibrated: false,
      reason: calibration?.message || "Save pregame snapshots and run backtests before trusting confidence labels.",
    };
  }
  if ((calibration.overall?.picks || 0) < MIN_CALIBRATION_OVERALL_PICKS) {
    return {
      bucket,
      label: "Unproven",
      className: "unproven",
      sampleSize: calibration.overall?.picks || 0,
      accuracy: calibration.overall?.accuracy ?? null,
      calibrated: false,
      reason: `Only ${calibration.overall?.picks || 0} saved pregame picks in the ${CALIBRATION_LOOKBACK_DAYS}-day sample; need ${MIN_CALIBRATION_OVERALL_PICKS}+ before assigning confidence.`,
    };
  }
  const bucketStats = calibration.buckets?.[bucket] || emptyBacktestBucket(edgeBucketLabel(bucket));
  const rating = confidenceRatingFromAccuracy(bucketStats.accuracy, bucketStats.picks, bucket);
  return {
    ...rating,
    sampleSize: bucketStats.picks,
    accuracy: bucketStats.accuracy,
    calibrated: rating.className !== "unproven",
    reason: `${rating.reason} Bucket sample: ${bucketStats.picks} picks at ${Number.isFinite(bucketStats.accuracy) ? `${Math.round(bucketStats.accuracy * 100)}%` : "n/a"}.`,
  };
}

function emptyBacktestBucket(label) {
  return { label, picks: 0, correct: 0, incorrect: 0, accuracy: null, rating: confidenceRatingFromAccuracy(null, 0) };
}

function updateBacktestBucket(bucket, correct) {
  bucket.picks += 1;
  if (correct) bucket.correct += 1;
  else bucket.incorrect += 1;
  bucket.accuracy = bucket.picks ? bucket.correct / bucket.picks : null;
  bucket.rating = confidenceRatingFromAccuracy(bucket.accuracy, bucket.picks, "bucket", 3);
}

function statOuts(stat = {}) {
  if (Number.isFinite(Number(stat.outs))) return Number(stat.outs);
  const text = String(stat.inningsPitched || "0");
  const [whole, partial = "0"] = text.split(".");
  return Number(whole || 0) * 3 + Number(partial || 0);
}

function outsToIp(outs) {
  const whole = Math.floor(outs / 3);
  const partial = outs % 3;
  return `${whole}.${partial}`;
}

async function mlbFetch(pathname) {
  const response = await fetch(`${mlbBaseUrl}${pathname}`, {
    headers: {
      "User-Agent": "Resume Magic MLB Scorer",
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`MLB data request failed: ${response.status}`);
  return response.json();
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\.?\b/g, "saint")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamKey(value) {
  const normalized = normalizeName(value);
  return teamAliases[normalized] || normalized;
}

function canonicalBookmakerKey(bookmaker = {}) {
  const text = normalizeName(`${bookmaker.key || ""} ${bookmaker.title || ""}`);
  return oddsBookmakers.find((book) => book.aliases.some((alias) => text.includes(normalizeName(alias))))?.key || "";
}

function bookmakerLabel(bookKey) {
  return oddsBookmakers.find((book) => book.key === bookKey)?.label || bookKey;
}

function americanOddsToProbability(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 100 / (value + 100) : Math.abs(value) / (Math.abs(value) + 100);
}

function modelSideProbabilities(game) {
  if (!game.projectionAvailable || !Number.isFinite(game.away?.composite) || !Number.isFinite(game.home?.composite)) {
    return { away: null, home: null };
  }
  if (
    Number.isFinite(game.away?.modelSubValues?.sigmoidWinProbability) &&
    Number.isFinite(game.home?.modelSubValues?.sigmoidWinProbability)
  ) {
    return {
      away: game.away.modelSubValues.sigmoidWinProbability,
      home: game.home.modelSubValues.sigmoidWinProbability,
    };
  }
  const diff = game.home.composite - game.away.composite;
  const home = 1 / (1 + Math.exp(-diff / 18));
  return { home, away: 1 - home };
}

function sideForOutcomeName(outcomeName, game) {
  const key = teamKey(outcomeName);
  if (key === teamKey(game.away.teamName) || key === teamKey(game.away.abbreviation)) return "away";
  if (key === teamKey(game.home.teamName) || key === teamKey(game.home.abbreviation)) return "home";
  if (/\b(tie|draw)\b/i.test(String(outcomeName || ""))) return "tie";
  return "";
}

function totalSideForOutcomeName(outcomeName) {
  const normalized = normalizeName(outcomeName);
  if (normalized.includes("over")) return "over";
  if (normalized.includes("under")) return "under";
  return "";
}

function emptyBookOdds(bookKey) {
  return {
    key: bookKey,
    label: bookmakerLabel(bookKey),
    updatedAt: null,
    moneyline: { away: null, home: null, tie: null },
    runLine: { away: null, home: null },
    totals: { over: null, under: null },
    noVig: { away: null, home: null },
  };
}

function normalizeOutcome(outcome) {
  if (!outcome) return null;
  const price = Number(outcome.price);
  return {
    name: outcome.name || "",
    price: Number.isFinite(price) ? price : null,
    point: Number.isFinite(Number(outcome.point)) ? Number(outcome.point) : null,
  };
}

function addNoVigProbabilities(bookOdds) {
  const away = americanOddsToProbability(bookOdds.moneyline.away?.price);
  const home = americanOddsToProbability(bookOdds.moneyline.home?.price);
  if (Number.isFinite(away) && Number.isFinite(home) && away + home > 0) {
    bookOdds.noVig.away = away / (away + home);
    bookOdds.noVig.home = home / (away + home);
  }
}

function normalizeBookOdds(bookmaker, oddsEvent, game) {
  const bookKey = canonicalBookmakerKey(bookmaker);
  if (!bookKey) return null;
  const bookOdds = emptyBookOdds(bookKey);
  bookOdds.updatedAt = bookmaker.last_update || null;
  (bookmaker.markets || []).forEach((market) => {
    if (market.key === "h2h") {
      (market.outcomes || []).forEach((outcome) => {
        const side = sideForOutcomeName(outcome.name, game);
        if (!side) return;
        bookOdds.moneyline[side] = normalizeOutcome(outcome);
      });
    }
    if (market.key === "spreads") {
      (market.outcomes || []).forEach((outcome) => {
        const side = sideForOutcomeName(outcome.name, game);
        if (side === "away" || side === "home") bookOdds.runLine[side] = normalizeOutcome(outcome);
      });
    }
    if (market.key === "totals") {
      (market.outcomes || []).forEach((outcome) => {
        const side = totalSideForOutcomeName(outcome.name);
        if (side) bookOdds.totals[side] = normalizeOutcome(outcome);
      });
    }
  });
  addNoVigProbabilities(bookOdds);
  return bookOdds;
}

function oddsEventsFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.events)) return data.events;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function fetchMlbBookOdds() {
  if (!oddsApiKey) {
    return {
      configured: false,
      events: [],
      requestsRemaining: null,
      message: "Set ODDS_API_KEY or THE_ODDS_API_KEY, then restart the app to load FanDuel and DraftKings odds.",
    };
  }

  const primaryParams = new URLSearchParams({
    sport_key: "baseball_mlb",
    regions: "us",
    markets: "h2h,spreads,totals",
    bookmakers: oddsBookmakers.map((book) => book.key).join(","),
    oddsFormat: "american",
  });
  const legacyParams = new URLSearchParams({
    apiKey: oddsApiKey,
    regions: "us",
    markets: "h2h,spreads,totals",
    bookmakers: oddsBookmakers.map((book) => book.key).join(","),
    oddsFormat: "american",
  });
  const attempts = [
    {
      url: `${oddsApiBaseUrl}/odds?${primaryParams.toString()}`,
      headers: { "x-api-key": oddsApiKey, Accept: "application/json" },
    },
    {
      url: `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?${legacyParams.toString()}`,
      headers: { Accept: "application/json" },
    },
  ];

  let lastError = "Odds API request failed.";
  for (const attempt of attempts) {
    const response = await fetch(attempt.url, { headers: attempt.headers });
    const remaining = response.headers.get("x-requests-remaining");
    if (response.ok) {
      const data = await response.json();
      return {
        configured: true,
        events: oddsEventsFromResponse(data),
        requestsRemaining: remaining === null ? null : Number(remaining),
        message: "",
      };
    }
    const body = await response.text().catch(() => "");
    lastError = `Odds API request failed with status ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`;
  }
  throw new Error(lastError);
}

function oddsEventMatchesGame(event, game, allowDateDrift = false) {
  const eventDate = easternIsoDate(event.commence_time || event.commenceTime || event.start_time);
  const sameDate = allowDateDrift || eventDate === game.officialDate;
  if (!sameDate) return false;
  const eventHome = teamKey(event.home_team || event.homeTeam);
  const eventAway = teamKey(event.away_team || event.awayTeam);
  const gameHome = teamKey(game.home.teamName);
  const gameAway = teamKey(game.away.teamName);
  return eventHome === gameHome && eventAway === gameAway;
}

function matchOddsEvent(game, oddsEvents) {
  return oddsEvents.find((event) => oddsEventMatchesGame(event, game))
    || oddsEvents.find((event) => oddsEventMatchesGame(event, game, true))
    || null;
}

function averageMarketProbabilities(books) {
  const away = books.map((book) => book.noVig.away).filter(Number.isFinite);
  const home = books.map((book) => book.noVig.home).filter(Number.isFinite);
  return {
    away: away.length ? away.reduce((sum, value) => sum + value, 0) / away.length : null,
    home: home.length ? home.reduce((sum, value) => sum + value, 0) / home.length : null,
  };
}

function betterAmericanOdds(current, candidate) {
  if (!candidate || !Number.isFinite(candidate.price)) return current;
  if (!current || candidate.price > current.price) return candidate;
  return current;
}

function bestMoneylineForSide(books, side) {
  return books.reduce((best, book) => {
    const outcome = book.moneyline[side];
    return betterAmericanOdds(best, outcome ? { ...outcome, book: book.key, bookLabel: book.label } : null);
  }, null);
}

function pushInfoForBooks(books) {
  const spreadPoint = books.map((book) => book.runLine.away?.point).find(Number.isFinite);
  const totalPoint = books.map((book) => book.totals.over?.point).find(Number.isFinite);
  return {
    runLine: Number.isFinite(spreadPoint) && Number.isInteger(Math.abs(spreadPoint))
      ? `Run line can push at ${Math.abs(spreadPoint)}.`
      : "Run line usually has no push at half-run lines.",
    total: Number.isFinite(totalPoint) && Number.isInteger(totalPoint)
      ? `Total can push at ${totalPoint}.`
      : "Total usually has no push at half-run lines.",
  };
}

function valueLabel(edge) {
  if (!Number.isFinite(edge)) return "No market edge";
  if (edge >= 0.04) return "Value";
  if (edge >= 0.015) return "Lean value";
  if (edge <= -0.04) return "Market disagrees";
  return "Fair price";
}

function buildOddsComparisonForGame(game, oddsEvent) {
  const rawBooks = oddsEvent
    ? (oddsEvent.bookmakers || []).map((bookmaker) => normalizeBookOdds(bookmaker, oddsEvent, game)).filter(Boolean)
    : [];
  const books = oddsBookmakers.map((book) => rawBooks.find((item) => item.key === book.key) || emptyBookOdds(book.key));
  const marketProbabilities = averageMarketProbabilities(books);
  const modelProbabilities = modelSideProbabilities(game);
  const pickSide = game.winner?.side || null;
  const modelProbability = pickSide ? modelProbabilities[pickSide] : null;
  const marketProbability = pickSide ? marketProbabilities[pickSide] : null;
  const edge = Number.isFinite(modelProbability) && Number.isFinite(marketProbability)
    ? modelProbability - marketProbability
    : null;
  return {
    gamePk: game.gamePk,
    gameDate: game.gameDate,
    officialDate: game.officialDate,
    game: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
    away: { teamName: game.away.teamName, abbreviation: game.away.abbreviation },
    home: { teamName: game.home.teamName, abbreviation: game.home.abbreviation },
    projectionAvailable: game.projectionAvailable,
    pick: game.winner ? {
      side: pickSide,
      teamName: game.winner.teamName,
      abbreviation: game.winner.abbreviation,
    } : null,
    margin: Number.isFinite(game.margin) ? Number(game.margin.toFixed(1)) : null,
    modelProbabilities,
    marketProbabilities,
    modelProbability,
    marketProbability,
    edge,
    valueLabel: valueLabel(edge),
    bestMoneyline: pickSide ? bestMoneylineForSide(books, pickSide) : null,
    books,
    tieOutcomes: books
      .map((book) => book.moneyline.tie ? { book: book.key, bookLabel: book.label, ...book.moneyline.tie } : null)
      .filter(Boolean),
    pushInfo: pushInfoForBooks(books),
    matchedOdds: Boolean(oddsEvent),
  };
}

async function buildMlbOddsComparison(dateText, modelId = "core5") {
  const oddsResult = await fetchMlbBookOdds();
  if (!oddsResult.configured) {
    return {
      configured: false,
      sport: sports[0],
      date: dateText,
      generatedAt: new Date().toISOString(),
      provider: "The Odds API",
      books: oddsBookmakers,
      requiredEnv: ["ODDS_API_KEY", "THE_ODDS_API_KEY"],
      message: oddsResult.message,
      games: [],
    };
  }

  const scorecard = await buildMlbScorecard(dateText, modelId);
  const games = scorecard.games.map((game) => buildOddsComparisonForGame(game, matchOddsEvent(game, oddsResult.events)));
  return {
    configured: true,
    sport: sports[0],
    date: dateText,
    generatedAt: new Date().toISOString(),
    provider: "The Odds API",
    books: oddsBookmakers,
    model: scorecard.model,
    calibration: scorecard.calibration,
    requestsRemaining: oddsResult.requestsRemaining,
    notes: [
      "Moneyline probabilities are no-vig averages from FanDuel and DraftKings when both sides are available.",
      scorecard.calibration?.available
        ? "Model probabilities are score-implied from composite margin; confidence labels are separately gated by saved pregame backtests."
        : "Model probabilities are score-implied estimates from composite margin. Treat them as uncalibrated until saved pregame backtests prove the bucket.",
      "MLB full-game moneyline is normally two-way; a tie appears only if a book returns a 3-way/tie market. Run lines and totals can push on whole-number lines.",
    ],
    games,
  };
}

function pythagoreanWinPct(runsFor, runsAgainst) {
  const exponent = 1.83;
  const forPower = Math.pow(Math.max(0, runsFor), exponent);
  const againstPower = Math.pow(Math.max(0, runsAgainst), exponent);
  return safeDivide(forPower, forPower + againstPower, 0.5);
}

function fipFromStat(stat = {}, constant = 3.1) {
  const outs = statOuts(stat);
  if (!outs) return null;
  const ip = outs / 3;
  const hr = num(stat.homeRuns);
  const bb = num(stat.baseOnBalls);
  const hbp = num(stat.hitByPitch);
  const k = num(stat.strikeOuts);
  return ((13 * hr + 3 * (bb + hbp) - 2 * k) / ip) + constant;
}

function xfipProxyFromStat(stat = {}, context = {}) {
  const outs = statOuts(stat);
  if (!outs) return null;
  const ip = outs / 3;
  const expectedHr = (Number.isFinite(context.leagueHrPerIp) ? context.leagueHrPerIp : 1.1 / 9) * ip;
  const bb = num(stat.baseOnBalls);
  const hbp = num(stat.hitByPitch);
  const k = num(stat.strikeOuts);
  return ((13 * expectedHr + 3 * (bb + hbp) - 2 * k) / ip) + (context.fipConstant || 3.1);
}

function pitchingContextFromTeams(teamPitchingSplits = []) {
  const totals = teamPitchingSplits.reduce(
    (sum, split) => {
      const stat = split.stat || {};
      sum.outs += statOuts(stat);
      sum.hr += num(stat.homeRuns);
      sum.bb += num(stat.baseOnBalls);
      sum.hbp += num(stat.hitByPitch);
      sum.k += num(stat.strikeOuts);
      sum.er += num(stat.earnedRuns);
      return sum;
    },
    { outs: 0, hr: 0, bb: 0, hbp: 0, k: 0, er: 0 }
  );
  const ip = totals.outs / 3;
  if (!ip) return { fipConstant: 3.1, averageFip: 4.25, leagueHrPerIp: 1.1 / 9 };
  const leagueEra = (totals.er * 9) / ip;
  const formula = (13 * totals.hr + 3 * (totals.bb + totals.hbp) - 2 * totals.k) / ip;
  return { fipConstant: leagueEra - formula, averageFip: leagueEra, leagueHrPerIp: safeDivide(totals.hr, ip, 1.1 / 9) };
}

function fipConstantFromTeams(teamPitchingSplits = []) {
  return pitchingContextFromTeams(teamPitchingSplits).fipConstant;
}

function woba(stat = {}) {
  const doubles = num(stat.doubles);
  const triples = num(stat.triples);
  const homers = num(stat.homeRuns);
  const hits = num(stat.hits);
  const singles = Math.max(0, hits - doubles - triples - homers);
  const walks = Math.max(0, num(stat.baseOnBalls) - num(stat.intentionalWalks));
  const hbp = num(stat.hitByPitch);
  const denominator = num(stat.atBats) + walks + num(stat.sacFlies) + hbp;
  const weighted = (0.69 * walks) + (0.72 * hbp) + (0.89 * singles) + (1.27 * doubles) + (1.62 * triples) + (2.1 * homers);
  return safeDivide(weighted, denominator, null);
}

function slg(stat = {}) {
  return safeDivide(num(stat.totalBases), num(stat.atBats), null);
}

function kbbPct(stat = {}) {
  return safeDivide(num(stat.strikeOuts) - num(stat.baseOnBalls), num(stat.battersFaced), null);
}

function kPct(stat = {}) {
  return safeDivide(num(stat.strikeOuts), num(stat.battersFaced), 0.20);
}

function bbPct(stat = {}) {
  return safeDivide(num(stat.baseOnBalls), num(stat.battersFaced), 0.08);
}

function groundBallPct(stat = {}) {
  const ground = num(stat.groundOuts);
  const air = num(stat.airOuts || stat.flyOuts);
  return safeDivide(ground, ground + air, 0.43);
}

function strikePct(stat = {}) {
  const explicit = Number(stat.strikePercentage);
  if (Number.isFinite(explicit)) return explicit;
  return safeDivide(num(stat.strikes), num(stat.numberOfPitches), 0.63);
}

function barrelRateProxy(stat = {}) {
  const hrPerBatter = safeDivide(num(stat.homeRuns), num(stat.battersFaced), 0.030);
  const slgAllowed = Number(stat.slg);
  const slgPenalty = Number.isFinite(slgAllowed) ? (slgAllowed - 0.390) * 0.05 : 0;
  return clamp(0.045 + ((hrPerBatter - 0.030) * 1.6) + slgPenalty, 0.03, 0.12);
}

function whiffPctProxy(stat = {}) {
  return clamp(0.105 + ((kPct(stat) - 0.20) * 0.35) + ((strikePct(stat) - 0.63) * 0.08), 0.08, 0.18);
}

function chasePctProxy(stat = {}) {
  return clamp(0.300 + ((strikePct(stat) - 0.63) * 0.25) + ((0.08 - bbPct(stat)) * 0.35), 0.25, 0.38);
}

function sieraProxyFromStat(stat = {}, context = {}) {
  const xFip = xfipProxyFromStat(stat, context);
  if (!Number.isFinite(xFip)) return context.averageFip || 4.25;
  const kbb = kbbPct(stat) ?? 0.12;
  const groundBall = groundBallPct(stat);
  const barrel = barrelRateProxy(stat);
  return clamp(xFip - ((kbb - 0.12) * 2.0) - ((groundBall - 0.43) * 0.7) + ((barrel - 0.07) * 4.0), 2.5, 5.5);
}

function defenseEfficiency(stat = {}) {
  const homers = num(stat.homeRuns);
  const hitsInPlay = Math.max(0, num(stat.hits) - homers);
  const ballsInPlay = num(stat.atBats) - num(stat.strikeOuts) - homers + num(stat.sacFlies);
  return ballsInPlay > 0 ? 1 - (hitsInPlay / ballsInPlay) : null;
}

function mergeHittingStats(splits = []) {
  return splits.reduce((sum, split) => {
    const stat = split.stat || {};
    [
      "doubles",
      "triples",
      "homeRuns",
      "hits",
      "baseOnBalls",
      "intentionalWalks",
      "hitByPitch",
      "atBats",
      "sacFlies",
      "plateAppearances",
      "totalBases",
      "strikeOuts",
    ].forEach((key) => {
      sum[key] = (sum[key] || 0) + num(stat[key]);
    });
    return sum;
  }, {});
}

function component(id, label, weight, score, detail, value = "") {
  return { id, label, weight, score: Number.isFinite(score) ? score : null, detail, value };
}

function compositeFromComponents(components) {
  return components.reduce((sum, item) => sum + (Number.isFinite(item.score) ? item.score * item.weight : 0), 0);
}

function edgeScore(value, otherValue, direction = "higher", scale = 1, maxEdge = 15) {
  if (!Number.isFinite(value) && !Number.isFinite(otherValue)) return 50;
  if (!Number.isFinite(value) || !Number.isFinite(otherValue)) return 50;
  if (Math.abs(value - otherValue) < 0.0000001) return 50;
  const signedDiff = direction === "lower" ? otherValue - value : value - otherValue;
  const edge = clamp((signedDiff / Math.max(scale, 0.0001)) * maxEdge, -maxEdge, maxEdge);
  return 50 + edge;
}

function statNumber(stat = {}, keys = [], fallback = null) {
  for (const key of keys) {
    if (stat[key] === undefined || stat[key] === null || stat[key] === "") continue;
    const value = num(stat[key], NaN);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function statPercent(stat = {}, keys = [], fallback = null) {
  const value = statNumber(stat, keys, fallback);
  if (!Number.isFinite(value)) return fallback;
  return value > 1 ? value / 100 : value;
}

function teamEra(stat = {}) {
  const explicit = statNumber(stat, ["ERA", "era"], null);
  if (Number.isFinite(explicit)) return explicit;
  const ip = statOuts(stat) / 3;
  return safeDivide(num(stat.earnedRuns) * 9, ip, null);
}

function teamWhip(stat = {}) {
  const explicit = statNumber(stat, ["WHIP", "whip"], null);
  if (Number.isFinite(explicit)) return explicit;
  const ip = statOuts(stat) / 3;
  return safeDivide(num(stat.hits) + num(stat.baseOnBalls), ip, null);
}

function teamHitsPerNine(stat = {}) {
  const explicit = statNumber(stat, ["H9", "h9", "hitsPer9Inn", "hitsPerNine"], null);
  if (Number.isFinite(explicit)) return explicit;
  const ip = statOuts(stat) / 3;
  return safeDivide(num(stat.hits) * 9, ip, null);
}

function teamBattingAverageAgainst(stat = {}) {
  const explicit = statNumber(stat, ["BAA", "baa", "avg", "battingAverageAgainst"], null);
  if (Number.isFinite(explicit)) return explicit;
  return safeDivide(num(stat.hits), num(stat.atBats), null);
}

function teamLeftOnBasePct(stat = {}) {
  const explicit = statPercent(stat, ["LOB_pct", "LOB%", "lobPct", "leftOnBasePct", "leftOnBasePercentage", "strandRate"], null);
  if (Number.isFinite(explicit)) return clamp(explicit, 0, 1);
  const baserunners = num(stat.hits) + num(stat.baseOnBalls) + num(stat.hitByPitch);
  const denominator = baserunners - (1.4 * num(stat.homeRuns));
  return clamp(safeDivide(baserunners - num(stat.runs), denominator, 0.72), 0, 1);
}

function pitchingWarValue(stat = {}, fipConstant = 3.1) {
  const explicit = statNumber(stat, ["pWAR", "pwar", "pitchingWAR", "pitchingWar", "pitchingWinsAboveReplacement", "winsAboveReplacement"], null);
  if (Number.isFinite(explicit)) return explicit;
  const ip = statOuts(stat) / 3;
  const era = teamEra(stat);
  const fip = fipFromStat(stat, fipConstant) ?? era;
  const kbb = num(stat.strikeOuts) - num(stat.baseOnBalls);
  if (!ip || !Number.isFinite(fip) || !Number.isFinite(era)) return 0;
  return clamp(((4.8 - fip) * ip / 18) + ((4.7 - era) * ip / 27) + (kbb / 60), -10, 35);
}

function offensiveWarValue(stat = {}) {
  const explicit = statNumber(stat, ["oWAR", "owar", "offensiveWAR", "offensiveWar", "offenseWinsAboveReplacement", "winsAboveReplacement"], null);
  if (Number.isFinite(explicit)) return explicit;
  const wobaValue = woba(stat) ?? 0.320;
  const slgValue = slg(stat) ?? statNumber(stat, ["slg"], 0.400);
  return clamp((num(stat.runs) / 12) + ((wobaValue - 0.320) * 100) + ((slgValue - 0.400) * 30), -10, 40);
}

function formatSamfordValue(id, value) {
  if (!Number.isFinite(value)) return "n/a";
  if (id === "LOB_pct") return `${(value * 100).toFixed(1)}%`;
  if (id === "BAA") return value.toFixed(3).replace(/^0/, "");
  if (["ERA", "FIP", "WHIP", "H9"].includes(id)) return value.toFixed(2);
  if (["pWAR", "oWAR"].includes(id)) return value.toFixed(1);
  return Math.round(value).toString();
}

function samfordGamesPlayed(side = {}) {
  const games = statNumber(side.teamHittingStat, ["gamesPlayed", "games"], null)
    ?? statNumber(side.teamPitchingStat, ["gamesPlayed", "games"], null);
  if (Number.isFinite(games) && games > 0) return games;
  const hittingAtBats = num(side.teamHittingStat?.atBats);
  if (hittingAtBats > 0) return clamp(hittingAtBats / 34, 1, 162);
  return 162;
}

function samfordAverageGames(away, home) {
  return (samfordGamesPlayed(away) + samfordGamesPlayed(home)) / 2;
}

function samfordScale(definition, away, home) {
  const scale = typeof definition.scale === "function" ? definition.scale(away, home) : definition.scale;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function calibratedPairScore(value, otherValue, definition, away, home) {
  return edgeScore(value, otherValue, definition.direction, samfordScale(definition, away, home), SAMFORD_MAX_STAT_EDGE);
}

function parkFactorForVenue(venueName) {
  return parkRunFactors[venueName] || 100;
}

function parkFitScore({ parkFactor, lineupWrc, spFip }) {
  const runTilt = (parkFactor - 100) / 15;
  const offenseFit = (lineupWrc - 100) / 20;
  const pitchingFit = (4.2 - spFip) / 1.5;
  return clamp(50 + (runTilt * offenseFit * 10) + (Math.abs(runTilt) * pitchingFit * 5));
}

function expectedInningsFromPitchCount(pitchCount) {
  const pitches = Number.isFinite(Number(pitchCount)) ? Number(pitchCount) : 85;
  return clamp(6 - Math.max(0, pitches - 85) * 0.05, 3, 7);
}

function pitcherPitchBudget(pitchCountLastStart) {
  const pitches = Number.isFinite(Number(pitchCountLastStart)) ? Number(pitchCountLastStart) : 85;
  return clamp(Math.max(75, 105 - ((pitches - 85) * 0.4)), 75, 115);
}

function pitcherRestPenalty(daysRest) {
  if (!Number.isFinite(daysRest)) return 0;
  if (daysRest <= 1) return 0.25;
  if (daysRest === 2) return 0.18;
  if (daysRest === 3) return 0.10;
  if (daysRest === 4) return 0.02;
  if (daysRest === 5 || daysRest === 6) return 0;
  if (daysRest === 7) return 0.02;
  return 0.05;
}

function workloadPenaltyFromInnings(seasonInnings) {
  if (!Number.isFinite(seasonInnings) || seasonInnings < 100) return 0;
  if (seasonInnings < 140) return 0.02;
  return 0.05;
}

function timesThroughOrderExpected(pitchBudget) {
  return clamp(pitchBudget / (3.85 * 9), 1.5, 3.5);
}

function timesThroughOrderPenalty(ttoExpected) {
  let penalty = 0;
  if (ttoExpected > 1) penalty += Math.min(ttoExpected - 1, 1) * 0.08;
  if (ttoExpected > 2) penalty += Math.min(ttoExpected - 2, 1) * 0.20;
  return penalty;
}

function pitcherConfidenceTier(pqs) {
  if (pqs >= 7.5) return "ELITE";
  if (pqs >= 6.0) return "STRONG";
  if (pqs >= 4.5) return "AVERAGE";
  return "RISKY";
}

function pitcherQualityScoreFromRaw(rawScore) {
  return clamp(5 + ((rawScore - PITCHER_PQS_BASELINE) * PITCHER_PQS_SLOPE), 0, 10);
}

function pitcherBaseQualityComponentScore(baseScore) {
  return clamp(50 + ((baseScore - 11) * 5.5), 0, 100);
}

function pitcherMatchupEnvironmentComponentScore(report) {
  const neutralOpponentKScore = 0.22 * 10;
  const netContext = (report.matchupScore - neutralOpponentKScore)
    + report.environmentScore
    - report.restPenalty
    - report.workloadPenalty
    - report.ttoPenalty;
  return clamp(50 + (netContext * 8), 0, 100);
}

function starterRestPenalty(daysRest) {
  if (!Number.isFinite(daysRest)) return 0;
  if (daysRest <= 3) return (4 - daysRest) * 0.04;
  if (daysRest >= 8) return 0.02;
  return 0;
}

function platoonAdvantageForPitcher(pitcherHand, opponentLineup = {}) {
  const vsPitcherHand = pitcherHand === "L" ? opponentLineup.wobaVsL : opponentLineup.wobaVsR;
  const vsOtherHand = pitcherHand === "L" ? opponentLineup.wobaVsR : opponentLineup.wobaVsL;
  if (!Number.isFinite(vsPitcherHand) || !Number.isFinite(vsOtherHand)) return 0;
  return clamp((vsOtherHand - vsPitcherHand) / 0.050, -1, 1);
}

function sharpPitchingContext(side, opponentSide, context) {
  const workload = side.starterWorkload || {};
  const pitcherXfip = Number.isFinite(side.spXfip) ? side.spXfip : side.spFip;
  const pitcherKPct = kPct(side.pitcherStat);
  const pitcherBBPct = bbPct(side.pitcherStat);
  const daysRest = Number.isFinite(workload.daysRest) ? workload.daysRest : 5;
  const pitchCount = Number.isFinite(workload.pitchCountLastStart) ? workload.pitchCountLastStart : 85;
  const expectedInnings = Number.isFinite(workload.expectedInnings) ? workload.expectedInnings : expectedInningsFromPitchCount(pitchCount);
  const platoonAdvantage = platoonAdvantageForPitcher(side.pitcherHand, opponentSide?.lineup);
  const restPenalty = starterRestPenalty(daysRest);
  const catcherFramingRuns = Number.isFinite(side.catcherFramingRuns) ? side.catcherFramingRuns : 0;
  const framingBoost = catcherFramingRuns * 0.003;
  const raw = (1 / pitcherXfip) * 14
    + (pitcherKPct * 22)
    - (pitcherBBPct * 18)
    + (platoonAdvantage * 0.08)
    - restPenalty
    + framingBoost;

  return {
    raw,
    score: higherScore(raw, 3.5, 11, 50),
    pitcherXfip,
    pitcherKPct,
    pitcherBBPct,
    daysRest,
    pitchCount,
    expectedInnings,
    platoonAdvantage,
    restPenalty,
    catcherFramingRuns,
    framingBoost,
    source: side.spXfipFallback
      ? `xFIP proxy ${pitcherXfip.toFixed(2)} uses league HR-rate normalization fallback.`
      : `xFIP proxy ${pitcherXfip.toFixed(2)} uses league HR-rate normalization.`,
  };
}

function sharpBullpenContext(side, pitcherContext) {
  const expectedInnings = pitcherContext.expectedInnings;
  const bullpenExposure = Math.max(0, (7 - expectedInnings) / 7);
  const era30d = Number.isFinite(side.bullpen.era30d) ? side.bullpen.era30d : side.bullpen.era;
  const highLeverageEra = Number.isFinite(side.bullpen.highLeverageEra) ? side.bullpen.highLeverageEra : era30d;
  const appearancesLast3d = Number.isFinite(side.bullpen.appearancesLast3d) ? side.bullpen.appearancesLast3d : 0;
  const fatiguePenalty = appearancesLast3d * 0.03;
  const raw = ((0.5 / Math.max(era30d, 0.1)) + (0.5 / Math.max(highLeverageEra, 0.1)))
    * (1 + bullpenExposure * 0.3)
    - fatiguePenalty;
  return {
    raw,
    score: higherScore(raw, 0.02, 0.45, 50),
    era30d,
    highLeverageEra,
    appearancesLast3d,
    expectedInnings,
    bullpenExposure,
    fatiguePenalty,
  };
}

function sharpOffenseContext(side) {
  const lineupStrengthModifier = Number.isFinite(side.lineup.strengthModifier) ? side.lineup.strengthModifier : 1;
  const teamWoba = Number.isFinite(side.teamWoba) ? side.teamWoba : side.lineup.woba;
  const raw = ((side.pyth * 0.65) + ((teamWoba || 0.320) * 0.35)) * lineupStrengthModifier;
  return {
    raw,
    score: higherScore(raw, 0.25, 0.65, 50),
    pyth: side.pyth,
    teamWoba,
    lineupStrengthModifier,
  };
}

function sharpGameContext(side, context) {
  const parkFactor = context.parkFactor / 100;
  const windFactor = Number.isFinite(context.windFactor) ? context.windFactor : 0;
  const umpireZoneFactor = Number.isFinite(context.umpireZoneFactor) ? context.umpireZoneFactor : 0;
  const homeFieldBoost = side.side === "home" ? 0.055 : 0;
  const raw = parkFactor + windFactor + umpireZoneFactor + homeFieldBoost;
  return {
    raw,
    score: higherScore(raw, 0.88, 1.20, 50),
    parkFactor,
    windFactor,
    umpireZoneFactor,
    homeFieldBoost,
  };
}

function pitcherQualityReport(side, opponentSide, context) {
  const stat = side.pitcherStat || {};
  const workload = side.starterWorkload || {};
  const siera = sieraProxyFromStat(stat, context);
  const pitcherKPct = kPct(stat);
  const pitcherBBPct = bbPct(stat);
  const kMinusBbPct = pitcherKPct - pitcherBBPct;
  const groundBall = groundBallPct(stat);
  const barrelRateAgainst = barrelRateProxy(stat);
  const whiffPct = whiffPctProxy(stat);
  const chasePct = chasePctProxy(stat);
  const recent = workload.recentProcess || {};
  const veloTrend = Number.isFinite(recent.veloTrend) ? recent.veloTrend : 0;
  const whiffPctRecent = Number.isFinite(recent.whiffPctRecent) ? recent.whiffPctRecent : whiffPct;
  const zonePctRecent = Number.isFinite(recent.zonePctRecent) ? recent.zonePctRecent : 0.46;
  const daysRest = Number.isFinite(workload.daysRest) ? workload.daysRest : 5;
  const pitchCountLastStart = Number.isFinite(workload.pitchCountLastStart) ? workload.pitchCountLastStart : 85;
  const seasonInningsPitched = statOuts(stat) / 3;
  const pitchBudget = pitcherPitchBudget(pitchCountLastStart);
  const ttoExpected = timesThroughOrderExpected(pitchBudget);
  const ttoPenalty = timesThroughOrderPenalty(ttoExpected);
  const platoonWobaDelta = Number.isFinite(opponentSide?.lineup?.woba) && Number.isFinite(opponentSide?.teamWoba)
    ? opponentSide.lineup.woba - opponentSide.teamWoba
    : 0;
  const opposingKPct = Number.isFinite(opponentSide?.lineup?.kPct) ? opponentSide.lineup.kPct : 0.22;
  const parkFactorPitching = Number.isFinite(context.parkFactor) ? context.parkFactor / 100 : 1;
  const umpireZoneFactor = Number.isFinite(context.umpireZoneFactor) ? context.umpireZoneFactor : 0;
  const windFactor = Number.isFinite(context.windFactor) ? context.windFactor : 0;
  const baseScore = (1 / siera) * 14
    + (kMinusBbPct * 25)
    + (whiffPct * 15)
    + (chasePct * 8)
    - (barrelRateAgainst * 30)
    + (groundBall * 4);
  const veloAdjustment = veloTrend * 0.04;
  const whiffTrendRatio = whiffPctRecent / Math.max(whiffPct, 0.01);
  const whiffAdjustment = (whiffTrendRatio - 1) * 0.10;
  const zoneAdjustment = (zonePctRecent - 0.46) * 0.08;
  const recentFormScore = veloAdjustment + whiffAdjustment + zoneAdjustment;
  const restPenalty = pitcherRestPenalty(daysRest);
  const workloadPenalty = workloadPenaltyFromInnings(seasonInningsPitched);
  const matchupScore = -(platoonWobaDelta * 20) + (opposingKPct * 10);
  const umpireInteraction = umpireZoneFactor * (1 + (pitcherBBPct * 2));
  const environmentScore = -((parkFactorPitching - 1) * 5) + umpireInteraction - (windFactor * 4);
  const rawScore = baseScore
    + (recentFormScore * 0.15)
    + matchupScore
    + environmentScore
    - restPenalty
    - workloadPenalty
    - ttoPenalty;
  const pqs = pitcherQualityScoreFromRaw(rawScore);
  const expectedIp = clamp(pitchBudget / 16.5, 3, 7.5);
  const baseEraProjection = siera * (1 + (parkFactorPitching - 1))
    + (platoonWobaDelta * 5)
    - (recentFormScore * 0.3)
    + (ttoPenalty * 0.5);
  const projectedRuns = Math.max(0, baseEraProjection * (expectedIp / 9));

  return {
    siera,
    kMinusBbPct,
    pitcherKPct,
    pitcherBBPct,
    groundBallPct: groundBall,
    barrelRateAgainst,
    whiffPct,
    chasePct,
    veloTrend,
    whiffPctRecent,
    zonePctRecent,
    daysRest,
    pitchCountLastStart,
    seasonInningsPitched,
    pitchBudget,
    ttoExpected,
    platoonWobaDelta,
    opposingKPct,
    parkFactorPitching,
    umpireZoneFactor,
    windFactor,
    baseScore,
    recentFormScore,
    matchupScore,
    environmentScore,
    restPenalty,
    workloadPenalty,
    ttoPenalty,
    rawScore,
    pqs,
    expectedIp,
    projectedRuns,
    confidenceTier: pitcherConfidenceTier(pqs),
    sourceNotes: [
      "SIERA is approximated from xFIP proxy, K-BB%, ground-ball proxy, and contact-quality proxy because direct FanGraphs SIERA is not available in the MLB Stats API.",
      "Barrel, whiff, chase, velocity trend, zone, umpire, and wind use transparent proxies or neutral fallbacks until Statcast/weather/umpire feeds are connected.",
    ],
  };
}

function modelById(modelId) {
  return mlbModels.find((model) => model.id === modelId) || mlbModels[0];
}

function selectedModels(requestedModel = "all") {
  return requestedModel === "all" ? mlbModels : [modelById(requestedModel)];
}

function actualGameResult(game) {
  const awayScore = Number(game.teams?.away?.score);
  const homeScore = Number(game.teams?.home?.score);
  const hasScore = Number.isFinite(awayScore) && Number.isFinite(homeScore);
  const isFinal = game.status?.abstractGameState === "Final";
  const awayTeam = game.teams?.away?.team || {};
  const homeTeam = game.teams?.home?.team || {};
  let winner = null;
  if (isFinal && hasScore && awayScore !== homeScore) {
    const winnerSide = awayScore > homeScore ? "away" : "home";
    const winnerTeam = winnerSide === "away" ? awayTeam : homeTeam;
    winner = {
      side: winnerSide,
      teamName: winnerTeam.name,
      abbreviation: winnerTeam.abbreviation,
    };
  }
  return {
    isFinal,
    hasScore,
    detailedState: game.status?.detailedState || "",
    awayScore: hasScore ? awayScore : null,
    homeScore: hasScore ? homeScore : null,
    winner,
    scoreText: hasScore ? `${awayTeam.abbreviation || "Away"} ${awayScore}, ${homeTeam.abbreviation || "Home"} ${homeScore}` : "",
    resultText: isFinal && winner
      ? `${winner.teamName} won, ${awayTeam.abbreviation || "Away"} ${awayScore} - ${homeTeam.abbreviation || "Home"} ${homeScore}`
      : (hasScore ? `${game.status?.detailedState || "Score"}: ${awayTeam.abbreviation || "Away"} ${awayScore} - ${homeTeam.abbreviation || "Home"} ${homeScore}` : game.status?.detailedState || "Scheduled"),
  };
}

async function pitcherMap(personIds, season) {
  const ids = [...new Set(personIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const data = await mlbFetch(`/api/v1/people?personIds=${ids.join(",")}&hydrate=stats(group=[pitching],type=[season],season=${season},gameType=R)`);
  return new Map((data.people || []).map((person) => [person.id, person]));
}

async function starterWorkloadMap(personIds, dateText, season, pitchingContext) {
  const ids = [...new Set(personIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const data = await mlbFetch(`/api/v1/people?personIds=${ids.join(",")}&hydrate=stats(group=[pitching],type=[gameLog],season=${season},gameType=R)`);
  return new Map((data.people || []).map((person) => {
    const starts = (person.stats?.[0]?.splits || [])
      .filter((split) => num(split.stat?.gamesStarted) > 0)
      .filter((split) => split.date && split.date < dateText)
      .sort((a, b) => b.date.localeCompare(a.date));
    const lastStart = starts[0] || null;
    const recentStarts = starts.slice(0, 4);
    const recentFiveStarts = starts.slice(0, 5);
    const recentTotals = recentStarts.reduce(
      (sum, split) => {
        const stat = split.stat || {};
        sum.strikes += num(stat.strikes);
        sum.pitches += num(stat.numberOfPitches);
        sum.outs += statOuts(stat);
        return sum;
      },
      { strikes: 0, pitches: 0, outs: 0 }
    );
    const recentFipTotals = recentFiveStarts.reduce(
      (sum, split) => {
        const stat = split.stat || {};
        sum.outs += statOuts(stat);
        sum.homeRuns += num(stat.homeRuns);
        sum.baseOnBalls += num(stat.baseOnBalls);
        sum.hitByPitch += num(stat.hitByPitch);
        sum.strikeOuts += num(stat.strikeOuts);
        return sum;
      },
      { outs: 0, homeRuns: 0, baseOnBalls: 0, hitByPitch: 0, strikeOuts: 0 }
    );
    const pitchCountLastStart = num(lastStart?.stat?.pitchesThrown || lastStart?.stat?.numberOfPitches, 85);
    const daysRest = lastStart?.date ? Math.max(0, daysBetween(lastStart.date, dateText) - 1) : 5;
    const rollingXfipLast5 = recentFipTotals.outs ? xfipProxyFromStat(recentFipTotals, pitchingContext) : null;
    return [person.id, {
      lastStartDate: lastStart?.date || null,
      daysRest,
      pitchCountLastStart,
      expectedInnings: expectedInningsFromPitchCount(pitchCountLastStart),
      inningsLastStart: lastStart?.stat?.inningsPitched || "",
      rollingXfipLast5,
      rollingXfipStarts: recentFiveStarts.length,
      recentProcess: {
        veloTrend: 0,
        whiffPctRecent: null,
        zonePctRecent: clamp(safeDivide(recentTotals.strikes, recentTotals.pitches, 0.62) - 0.16, 0.42, 0.55),
        starts: recentStarts.length,
        innings: outsToIp(recentTotals.outs),
        source: "Velocity, whiff, and true zone rate are neutral/proxy fallbacks from the current MLB Stats API feed.",
      },
    }];
  }));
}

async function lineupSplitAggregate(teamId, sitCode, season, leagueWoba) {
  const data = await mlbFetch(`/api/v1/stats?stats=statSplits&group=hitting&gameType=R&season=${season}&teamId=${teamId}&playerPool=ALL&sitCodes=${sitCode}`);
  const topNine = (((data.stats || [])[0] || {}).splits || [])
    .filter((split) => num(split.stat?.plateAppearances) > 0)
    .sort((a, b) => num(b.stat?.plateAppearances) - num(a.stat?.plateAppearances))
    .slice(0, 9);
  const aggregate = mergeHittingStats(topNine);
  const lineupWoba = woba(aggregate);
  const estimatedWrc = lineupWoba && leagueWoba ? (lineupWoba / leagueWoba) * 100 : 100;
  return {
    wrcPlus: estimatedWrc,
    woba: lineupWoba,
    slg: slg(aggregate),
    kPct: safeDivide(num(aggregate.strikeOuts), num(aggregate.plateAppearances), 0.22),
    plateAppearances: num(aggregate.plateAppearances),
    split: sitCode === "vl" ? "vs LHP" : "vs RHP",
    hitters: topNine.map((split) => ({
      name: split.player?.fullName || "Unknown hitter",
      pa: num(split.stat?.plateAppearances),
      ops: split.stat?.ops || "",
    })),
  };
}

async function lineupSplitScore(teamId, pitcherHand, season, leagueWoba) {
  const activeCode = pitcherHand === "L" ? "vl" : "vr";
  const [vsLeft, vsRight] = await Promise.all([
    lineupSplitAggregate(teamId, "vl", season, leagueWoba),
    lineupSplitAggregate(teamId, "vr", season, leagueWoba),
  ]);
  const active = activeCode === "vl" ? vsLeft : vsRight;
  return {
    ...active,
    wobaVsL: vsLeft.woba,
    wobaVsR: vsRight.woba,
    wrcPlusVsL: vsLeft.wrcPlus,
    wrcPlusVsR: vsRight.wrcPlus,
    strengthModifier: 1,
  };
}

async function recentTeamHittingMap(teamIds, dateText, season, leagueWoba) {
  const wanted = new Set(teamIds);
  if (!wanted.size) return new Map();
  const startDate = addDays(dateText, -14);
  const endDate = addDays(dateText, -1);
  const data = await mlbFetch(`/api/v1/teams/stats?stats=byDateRange&group=hitting&sportIds=1&season=${season}&gameType=R&startDate=${startDate}&endDate=${endDate}`);
  const rows = (data.stats?.[0]?.splits || [])
    .filter((split) => wanted.has(split.team?.id));
  return new Map(rows.map((split) => {
    const recentWoba = woba(split.stat || {});
    const recentWrcPlus = recentWoba && leagueWoba ? (recentWoba / leagueWoba) * 100 : null;
    return [split.team.id, {
      woba: recentWoba,
      wrcPlus: recentWrcPlus,
      startDate,
      endDate,
      source: "MLB Stats API by-date-range hitting proxy for rolling wRC+.",
    }];
  }));
}

async function bullpenSnapshots(teamIds, dateText, fipConstant) {
  const wanted = new Set(teamIds);
  const startDate = addDays(dateText, -15);
  const startDate30d = addDays(dateText, -30);
  const endDate = addDays(dateText, -1);
  const workloadStartDate = addDays(dateText, -3);
  const schedule = await mlbFetch(`/api/v1/schedule?sportId=1&gameTypes=R&startDate=${startDate30d}&endDate=${endDate}`);
  const gamePks = [];
  (schedule.dates || []).forEach((date) => {
    (date.games || []).forEach((game) => {
      if (game.status?.abstractGameState !== "Final") return;
      const awayId = game.teams?.away?.team?.id;
      const homeId = game.teams?.home?.team?.id;
      if (wanted.has(awayId) || wanted.has(homeId)) gamePks.push({ gamePk: game.gamePk, officialDate: game.officialDate });
    });
  });
  const totals = new Map(teamIds.map((id) => [id, {
    outs: 0,
    earnedRuns: 0,
    appearances: 0,
    homeRuns: 0,
    baseOnBalls: 0,
    hitByPitch: 0,
    strikeOuts: 0,
    battersFaced: 0,
    outs30d: 0,
    earnedRuns30d: 0,
    appearances30d: 0,
    homeRuns30d: 0,
    baseOnBalls30d: 0,
    hitByPitch30d: 0,
    strikeOuts30d: 0,
    battersFaced30d: 0,
    recentPitches: 0,
    recentOuts: 0,
    recentAppearances: 0,
  }]));
  const boxes = await Promise.all(gamePks.map((game) => mlbFetch(`/api/v1/game/${game.gamePk}/boxscore`).then((box) => ({ box, officialDate: game.officialDate })).catch(() => null)));
  boxes.filter(Boolean).forEach(({ box, officialDate }) => {
    ["away", "home"].forEach((side) => {
      const team = box.teams?.[side];
      const teamId = team?.team?.id;
      if (!wanted.has(teamId)) return;
      const pitchers = team.pitchers || [];
      pitchers.slice(1).forEach((pitcherId) => {
        const stat = team.players?.[`ID${pitcherId}`]?.stats?.pitching || {};
        const outs = statOuts(stat);
        if (!outs) return;
        const current = totals.get(teamId);
        current.outs30d += outs;
        current.earnedRuns30d += num(stat.earnedRuns);
        current.appearances30d += 1;
        current.homeRuns30d += num(stat.homeRuns);
        current.baseOnBalls30d += num(stat.baseOnBalls);
        current.hitByPitch30d += num(stat.hitByPitch);
        current.strikeOuts30d += num(stat.strikeOuts);
        current.battersFaced30d += num(stat.battersFaced);
        if (officialDate >= startDate) {
          current.outs += outs;
          current.earnedRuns += num(stat.earnedRuns);
          current.appearances += 1;
          current.homeRuns += num(stat.homeRuns);
          current.baseOnBalls += num(stat.baseOnBalls);
          current.hitByPitch += num(stat.hitByPitch);
          current.strikeOuts += num(stat.strikeOuts);
          current.battersFaced += num(stat.battersFaced);
        }
        if (officialDate >= workloadStartDate) {
          current.recentPitches += num(stat.pitchesThrown || stat.numberOfPitches);
          current.recentOuts += outs;
          current.recentAppearances += 1;
        }
      });
    });
  });
  return new Map([...totals.entries()].map(([teamId, stat]) => {
    const era = stat.outs ? (stat.earnedRuns * 27) / stat.outs : 4.25;
    const era30d = stat.outs30d ? (stat.earnedRuns30d * 27) / stat.outs30d : era;
    const fip = stat.outs ? fipFromStat(stat, fipConstant) : null;
    const fip30d = stat.outs30d ? fipFromStat({
      outs: stat.outs30d,
      homeRuns: stat.homeRuns30d,
      baseOnBalls: stat.baseOnBalls30d,
      hitByPitch: stat.hitByPitch30d,
      strikeOuts: stat.strikeOuts30d,
    }, fipConstant) : fip;
    const bullpenKbb = kbbPct(stat);
    return [teamId, {
      ...stat,
      era,
      era30d,
      highLeverageEra: era30d,
      fip,
      fip30d,
      kbbPct: bullpenKbb,
      innings: outsToIp(stat.outs),
      innings30d: outsToIp(stat.outs30d),
      recentInnings: outsToIp(stat.recentOuts),
      appearancesLast3d: stat.recentAppearances,
      startDate,
      startDate30d,
      endDate,
      workloadStartDate,
    }];
  }));
}

function coreFiveComponents(side, opponentSide = {}) {
  const opponentLabel = opponentSide.abbreviation || "opponent";
  const spScore = side.starterKnown && opponentSide.starterKnown
    ? edgeScore(side.spFip, opponentSide.spFip, "lower", 1.5, 16)
    : null;
  const pythScore = edgeScore(side.pyth, opponentSide.pyth, "higher", 0.20, 16);
  const bullpenScore = edgeScore(side.bullpen.era, opponentSide.bullpen?.era, "lower", 2.5, 12);
  const lineupScore = edgeScore(side.lineup.wrcPlus, opponentSide.lineup?.wrcPlus, "higher", 35, 10);
  const homeFieldScore = edgeScore(side.side === "home" ? 1 : 0, opponentSide.side === "home" ? 1 : 0, "higher", 1, 8);
  return [
    component("spFip", "Starter FIP", 0.30, spScore, side.starterKnown ? `FIP ${side.spFip.toFixed(2)} vs ${opponentLabel} ${Number.isFinite(opponentSide.spFip) ? opponentSide.spFip.toFixed(2) : "n/a"}${side.spFallback ? " fallback" : ""}` : "No probable starter", side.starterKnown ? side.spFip : "TBD"),
    component("pyth", "Pythagorean W%", 0.25, pythScore, `Pyth W% ${(side.pyth * 100).toFixed(1)} vs ${opponentLabel} ${Number.isFinite(opponentSide.pyth) ? (opponentSide.pyth * 100).toFixed(1) : "n/a"}%`, side.pyth),
    component("bullpenEra", "Bullpen 15-day ERA", 0.20, bullpenScore, `15-day ERA ${side.bullpen.era.toFixed(2)} vs ${opponentLabel} ${Number.isFinite(opponentSide.bullpen?.era) ? opponentSide.bullpen.era.toFixed(2) : "n/a"}`, side.bullpen.era),
    component("lineupWrc", "Lineup wRC+", 0.18, lineupScore, `${side.lineup.wrcPlus.toFixed(1)} ${side.lineup.split} vs ${opponentLabel} ${Number.isFinite(opponentSide.lineup?.wrcPlus) ? opponentSide.lineup.wrcPlus.toFixed(1) : "n/a"}`, side.lineup.wrcPlus),
    component("homeField", "Home field", 0.07, homeFieldScore, side.side === "home" ? "Home" : "Away", side.side === "home" ? 1 : 0),
  ];
}

const samfordTopTenStats = [
  {
    ...samfordArticleTopTen[0],
    direction: "higher",
    value: (side) => num(side.teamHittingStat?.runs) - num(side.teamPitchingStat?.runs),
    scale: (away, home) => Math.max(35, samfordAverageGames(away, home) * 1.5),
    source: "Run differential",
  },
  {
    ...samfordArticleTopTen[1],
    direction: "lower",
    value: (side) => teamEra(side.teamPitchingStat),
    scale: 1.4,
    source: "Team pitching ERA",
  },
  {
    ...samfordArticleTopTen[2],
    direction: "lower",
    value: (side, context) => fipFromStat(side.teamPitchingStat, context.fipConstant),
    scale: 1.2,
    source: "Team FIP",
  },
  {
    ...samfordArticleTopTen[3],
    direction: "higher",
    value: (side) => teamLeftOnBasePct(side.teamPitchingStat),
    scale: 0.07,
    source: "LOB% / strand rate",
  },
  {
    ...samfordArticleTopTen[4],
    direction: "higher",
    value: (side, context) => pitchingWarValue(side.teamPitchingStat, context.fipConstant),
    scale: (away, home) => Math.max(4, samfordAverageGames(away, home) * 0.11),
    source: "Pitching WAR",
  },
  {
    ...samfordArticleTopTen[5],
    direction: "lower",
    value: (side) => teamWhip(side.teamPitchingStat),
    scale: 0.3,
    source: "Team WHIP",
  },
  {
    ...samfordArticleTopTen[6],
    direction: "lower",
    value: (side) => teamHitsPerNine(side.teamPitchingStat),
    scale: 2,
    source: "Hits allowed per 9",
  },
  {
    ...samfordArticleTopTen[7],
    direction: "lower",
    value: (side) => teamBattingAverageAgainst(side.teamPitchingStat),
    scale: 0.045,
    source: "Batting average against",
  },
  {
    ...samfordArticleTopTen[8],
    direction: "higher",
    value: (side) => offensiveWarValue(side.teamHittingStat),
    scale: (away, home) => Math.max(4, samfordAverageGames(away, home) * 0.11),
    source: "Offensive WAR",
  },
  {
    ...samfordArticleTopTen[9],
    direction: "higher",
    value: (side) => statNumber(side.teamPitchingStat, ["SV", "sv", "saves"], 0),
    scale: (away, home) => Math.max(4, samfordAverageGames(away, home) * 0.12),
    source: "Team saves",
  },
];

function validateSamfordArticleAlignment() {
  const model = mlbModels.find((item) => item.id === "samfordTop10");
  if (!model) throw new Error("Samford Top 10 model is missing.");
  samfordArticleTopTen.forEach((expected, index) => {
    const stat = samfordTopTenStats[index];
    const component = model.components[index];
    const expectedWeight = expected.weightRank / samfordArticleTotalWeight;
    if (!stat || stat.id !== expected.id || stat.label !== expected.label || stat.weightRank !== expected.weightRank || stat.direction !== expected.direction) {
      throw new Error(`Samford article stat mismatch at rank ${index + 1}: expected ${expected.id}.`);
    }
    if (!component || component.id !== expected.id || component.label !== expected.label || Math.abs(component.weight - expectedWeight) > 0.0000001) {
      throw new Error(`Samford article component mismatch at rank ${index + 1}: expected ${expected.id}.`);
    }
  });
}

validateSamfordArticleAlignment();

function samfordTopTenPairComponents(away, home, context) {
  const totalWeight = samfordTopTenStats.reduce((sum, item) => sum + item.weightRank, 0);
  const output = {
    away: { components: [], statWins: 0 },
    home: { components: [], statWins: 0 },
  };

  samfordTopTenStats.forEach((definition) => {
    const awayValue = definition.value(away, context);
    const homeValue = definition.value(home, context);
    const awayScore = calibratedPairScore(awayValue, homeValue, definition, away, home);
    const homeScore = calibratedPairScore(homeValue, awayValue, definition, away, home);
    const scale = samfordScale(definition, away, home);
    const winnerSide = awayScore === homeScore ? "tie" : (awayScore > homeScore ? "away" : "home");
    if (winnerSide === "away") output.away.statWins += 1;
    if (winnerSide === "home") output.home.statWins += 1;

    ["away", "home"].forEach((sideKey) => {
      const sideScore = sideKey === "away" ? awayScore : homeScore;
      const value = sideKey === "away" ? awayValue : homeValue;
      const otherValue = sideKey === "away" ? homeValue : awayValue;
      const advantage = winnerSide === "tie"
        ? "Tied"
        : `${winnerSide === sideKey ? "Advantage" : "Behind"} vs ${sideKey === "away" ? home.abbreviation : away.abbreviation}`;
      const contribution = sideScore * (definition.weightRank / totalWeight);
      output[sideKey].components.push(component(
        definition.id,
        definition.label,
        definition.weightRank / totalWeight,
        sideScore,
        `${advantage}; ${definition.source}: ${formatSamfordValue(definition.id, value)} vs ${formatSamfordValue(definition.id, otherValue)}; calibrated scale ${formatSamfordValue(definition.id, scale)}; weighted contribution ${contribution.toFixed(1)}`,
        value
      ));
    });
  });

  output.away.composite = compositeFromComponents(output.away.components);
  output.home.composite = compositeFromComponents(output.home.components);
  output.away.subValues = {
    samfordStatWins: output.away.statWins,
    samfordWeightedScore: output.away.composite,
    samfordTotalStats: samfordTopTenStats.length,
  };
  output.home.subValues = {
    samfordStatWins: output.home.statWins,
    samfordWeightedScore: output.home.composite,
    samfordTotalStats: samfordTopTenStats.length,
  };
  return output;
}

function expandedTenInputs(side, context) {
  const spKbb = kbbPct(side.pitcherStat);
  const spAllowedWoba = woba(side.pitcherStat);
  const spEra = num(side.pitcherStat.era, context.averageFip);
  const defenseEff = defenseEfficiency(side.teamPitchingStat);
  const parkScore = parkFitScore({ parkFactor: context.parkFactor, lineupWrc: side.lineup.wrcPlus, spFip: side.spFip });
  return {
    spKbb,
    spFip: side.spFip,
    lineupWrc: side.lineup.wrcPlus,
    pyth: side.pyth,
    recentPitches: side.bullpen.recentPitches,
    bullpenFip: side.bullpen.fip,
    bullpenKbb: side.bullpen.kbbPct,
    lineupWoba: side.lineup.woba,
    lineupSlg: side.lineup.slg,
    spAllowedWoba,
    spEra,
    defenseEff,
    parkScore,
  };
}

function expandedTenComponents(side, context, opponentSide = {}) {
  const current = expandedTenInputs(side, context);
  const opponent = expandedTenInputs(opponentSide, context);
  const opponentLabel = opponentSide.abbreviation || "opponent";
  const starterPairKnown = side.starterKnown && opponentSide.starterKnown;
  const bullpenSkillScore = averageScores(
    edgeScore(current.bullpenFip, opponent.bullpenFip, "lower", 1.2, 12),
    edgeScore(current.bullpenKbb, opponent.bullpenKbb, "higher", 0.12, 12)
  );
  const lineupQualityScore = averageScores(
    edgeScore(current.lineupWoba, opponent.lineupWoba, "higher", 0.055, 10),
    edgeScore(current.lineupSlg, opponent.lineupSlg, "higher", 0.100, 10)
  );
  const spContactScore = starterPairKnown
    ? averageScores(
      edgeScore(current.spAllowedWoba, opponent.spAllowedWoba, "lower", 0.080, 10),
      edgeScore(current.spEra, opponent.spEra, "lower", 1.50, 10)
    )
    : null;

  return [
    component("spKbb", "SP K-BB%", 0.17, starterPairKnown ? edgeScore(current.spKbb, opponent.spKbb, "higher", 0.12, 16) : null, side.starterKnown ? (Number.isFinite(current.spKbb) ? `K-BB% ${(current.spKbb * 100).toFixed(1)}% vs ${opponentLabel} ${Number.isFinite(opponent.spKbb) ? (opponent.spKbb * 100).toFixed(1) : "n/a"}%` : "K-BB% league fallback") : "No probable starter", current.spKbb),
    component("spFip", "SP FIP", 0.15, starterPairKnown ? edgeScore(current.spFip, opponent.spFip, "lower", 1.4, 16) : null, side.starterKnown ? `FIP ${side.spFip.toFixed(2)} vs ${opponentLabel} ${Number.isFinite(opponent.spFip) ? opponent.spFip.toFixed(2) : "n/a"}${side.spFallback ? " fallback" : ""}` : "No probable starter", side.spFip),
    component("lineupWrc", "Lineup wRC+", 0.14, edgeScore(current.lineupWrc, opponent.lineupWrc, "higher", 35, 12), `${side.lineup.wrcPlus.toFixed(1)} ${side.lineup.split} vs ${opponentLabel} ${Number.isFinite(opponent.lineupWrc) ? opponent.lineupWrc.toFixed(1) : "n/a"}`, side.lineup.wrcPlus),
    component("pyth", "Pythagorean W%", 0.12, edgeScore(current.pyth, opponent.pyth, "higher", 0.20, 14), `Pyth W% ${(side.pyth * 100).toFixed(1)} vs ${opponentLabel} ${Number.isFinite(opponent.pyth) ? (opponent.pyth * 100).toFixed(1) : "n/a"}%`, side.pyth),
    component("bullpenAvailability", "Bullpen availability", 0.10, edgeScore(current.recentPitches, opponent.recentPitches, "lower", 120, 10), `3-day relief workload: ${side.bullpen.recentPitches} pitches vs ${opponentLabel} ${Number.isFinite(opponent.recentPitches) ? opponent.recentPitches : "n/a"}, ${side.bullpen.recentInnings} IP`, side.bullpen.recentPitches),
    component("bullpenSkill", "Bullpen skill", 0.09, bullpenSkillScore, `15-day FIP ${Number.isFinite(side.bullpen.fip) ? side.bullpen.fip.toFixed(2) : "n/a"}, K-BB% ${Number.isFinite(side.bullpen.kbbPct) ? (side.bullpen.kbbPct * 100).toFixed(1) : "n/a"}%`, side.bullpen.fip),
    component("lineupQuality", "Lineup quality", 0.08, lineupQualityScore, `Proxy: wOBA ${Number.isFinite(side.lineup.woba) ? side.lineup.woba.toFixed(3) : "n/a"}, SLG ${Number.isFinite(side.lineup.slg) ? side.lineup.slg.toFixed(3) : "n/a"}`, side.lineup.woba),
    component("spContact", "SP contact allowed", 0.06, spContactScore, side.starterKnown ? `Proxy: allowed wOBA ${Number.isFinite(current.spAllowedWoba) ? current.spAllowedWoba.toFixed(3) : "n/a"}, ERA ${Number.isFinite(current.spEra) ? current.spEra.toFixed(2) : "n/a"}` : "No probable starter", current.spAllowedWoba),
    component("park", "Park fit", 0.05, edgeScore(current.parkScore, opponent.parkScore, "higher", 15, 6), `Run factor ${context.parkFactor}`, context.parkFactor),
    component("defense", "Defense proxy", 0.04, edgeScore(current.defenseEff, opponent.defenseEff, "higher", 0.04, 8), `DER proxy ${Number.isFinite(current.defenseEff) ? current.defenseEff.toFixed(3) : "n/a"}`, current.defenseEff),
  ];
}

function pitchingContextComponents(side, context, opponentSide) {
  const pitcher = sharpPitchingContext(side, opponentSide, context);
  const bullpen = sharpBullpenContext(side, pitcher);
  const offense = sharpOffenseContext(side);
  const gameContext = sharpGameContext(side, context);
  const opponentPitcher = sharpPitchingContext(opponentSide, side, context);
  const opponentBullpen = sharpBullpenContext(opponentSide, opponentPitcher);
  const opponentOffense = sharpOffenseContext(opponentSide);
  const opponentGameContext = sharpGameContext(opponentSide, context);
  const opponentLabel = opponentSide.abbreviation || "opponent";
  const starterPairKnown = side.starterKnown && opponentSide.starterKnown;
  side.modelSubValues = {
    expectedInnings: pitcher.expectedInnings,
    restPenalty: pitcher.restPenalty,
    bullpenExposure: bullpen.bullpenExposure,
    windFactor: gameContext.windFactor,
    umpireZoneFactor: gameContext.umpireZoneFactor,
  };
  side.rawModelScore = (pitcher.raw * 0.30) + (bullpen.raw * 0.25) + (offense.raw * 0.20) + (gameContext.raw * 0.25);

  return [
    component(
      "pitcherContext",
      "Starter xFIP context",
      0.30,
      starterPairKnown ? edgeScore(pitcher.raw, opponentPitcher.raw, "higher", 3.0, 18) : null,
      side.starterKnown
        ? `${pitcher.source} Raw ${pitcher.raw.toFixed(3)} vs ${opponentLabel} ${Number.isFinite(opponentPitcher.raw) ? opponentPitcher.raw.toFixed(3) : "n/a"}; K% ${(pitcher.pitcherKPct * 100).toFixed(1)}, BB% ${(pitcher.pitcherBBPct * 100).toFixed(1)}, rest ${pitcher.daysRest}d, last ${pitcher.pitchCount} pitches, platoon ${pitcher.platoonAdvantage.toFixed(2)}, framing ${pitcher.catcherFramingRuns.toFixed(1)}`
        : "No probable starter",
      side.starterKnown ? pitcher.pitcherXfip : "TBD"
    ),
    component(
      "bullpenContext",
      "Bullpen exposure",
      0.25,
      edgeScore(bullpen.raw, opponentBullpen.raw, "higher", 0.6, 14),
      `Raw ${bullpen.raw.toFixed(3)} vs ${opponentLabel} ${Number.isFinite(opponentBullpen.raw) ? opponentBullpen.raw.toFixed(3) : "n/a"}; 30-day ERA ${bullpen.era30d.toFixed(2)}, high-leverage proxy ${bullpen.highLeverageEra.toFixed(2)}, expected SP ${bullpen.expectedInnings.toFixed(1)} IP, exposure ${(bullpen.bullpenExposure * 100).toFixed(0)}%, 3-day appearances ${bullpen.appearancesLast3d}`,
      bullpen.era30d
    ),
    component(
      "offenseContext",
      "Offense quality",
      0.20,
      edgeScore(offense.raw, opponentOffense.raw, "higher", 0.20, 12),
      `Raw ${offense.raw.toFixed(3)} vs ${opponentLabel} ${Number.isFinite(opponentOffense.raw) ? opponentOffense.raw.toFixed(3) : "n/a"}; Pyth W% ${(offense.pyth * 100).toFixed(1)}%, team wOBA ${Number.isFinite(offense.teamWoba) ? offense.teamWoba.toFixed(3) : "n/a"}, lineup strength ${offense.lineupStrengthModifier.toFixed(2)}`,
      offense.teamWoba
    ),
    component(
      "gameContext",
      "Game context",
      0.25,
      edgeScore(gameContext.raw, opponentGameContext.raw, "higher", 0.11, 6),
      `Raw ${gameContext.raw.toFixed(3)} vs ${opponentLabel} ${Number.isFinite(opponentGameContext.raw) ? opponentGameContext.raw.toFixed(3) : "n/a"}; park ${gameContext.parkFactor.toFixed(2)}, wind ${gameContext.windFactor.toFixed(3)} neutral fallback, umpire zone ${gameContext.umpireZoneFactor.toFixed(3)} neutral fallback${side.side === "home" ? ", home +0.055" : ""}`,
      gameContext.raw
    ),
  ];
}

function pitcherQualityComponents(side, context, opponentSide) {
  const report = pitcherQualityReport(side, opponentSide, context);
  side.pitcherQualityReport = report;
  side.modelSubValues = {
    pqs: report.pqs,
    expectedIp: report.expectedIp,
    projectedRuns: report.projectedRuns,
    confidenceTier: report.confidenceTier,
    pitchBudget: report.pitchBudget,
    ttoExpected: report.ttoExpected,
    platoonWobaDelta: report.platoonWobaDelta,
    restPenalty: report.restPenalty,
    workloadPenalty: report.workloadPenalty,
    ttoPenalty: report.ttoPenalty,
  };
  return [
    component(
      "baseQuality",
      "Base quality",
      0.55,
      side.starterKnown ? pitcherBaseQualityComponentScore(report.baseScore) : null,
      side.starterKnown
        ? `SIERA proxy ${report.siera.toFixed(2)}, K-BB% ${(report.kMinusBbPct * 100).toFixed(1)}%, GB% ${(report.groundBallPct * 100).toFixed(1)}%, barrel proxy ${(report.barrelRateAgainst * 100).toFixed(1)}%, whiff proxy ${(report.whiffPct * 100).toFixed(1)}%, chase proxy ${(report.chasePct * 100).toFixed(1)}%`
        : "No probable starter",
      report.baseScore
    ),
    component(
      "recentForm",
      "Recent form",
      0.15,
      side.starterKnown ? clamp(50 + (report.recentFormScore * 250), 0, 100) : null,
      side.starterKnown
        ? `Velo trend ${report.veloTrend >= 0 ? "+" : ""}${report.veloTrend.toFixed(1)} mph neutral fallback, recent whiff proxy ${(report.whiffPctRecent * 100).toFixed(1)}%, zone proxy ${(report.zonePctRecent * 100).toFixed(1)}%`
        : "No probable starter",
      report.recentFormScore
    ),
    component(
      "matchup",
      "Matchup and environment",
      0.15,
      side.starterKnown ? pitcherMatchupEnvironmentComponentScore(report) : null,
      side.starterKnown
        ? `Platoon delta ${report.platoonWobaDelta >= 0 ? "+" : ""}${report.platoonWobaDelta.toFixed(3)}, opponent K% ${(report.opposingKPct * 100).toFixed(1)}, park ${report.parkFactorPitching.toFixed(2)}, rest penalty ${report.restPenalty.toFixed(2)}, TTO penalty ${report.ttoPenalty.toFixed(2)}`
        : "No probable starter",
      report.matchupScore + report.environmentScore
    ),
    component(
      "projection",
      "PQS projection",
      0.15,
      side.starterKnown ? report.pqs * 10 : null,
      side.starterKnown
        ? `PQS ${report.pqs.toFixed(2)}/10, ${report.confidenceTier}, expected ${report.expectedIp.toFixed(1)} IP, projected ${report.projectedRuns.toFixed(2)} runs, pitch budget ${Math.round(report.pitchBudget)}, TTO ${report.ttoExpected.toFixed(1)}`
        : "No probable starter",
      report.pqs
    ),
  ];
}

function weightedSigmoidMetric(label, normalized, weight, rawValue, source = "") {
  const value = Number.isFinite(normalized) ? clamp(normalized, 0, 1) : 0.5;
  return { label, normalized: value, weight, rawValue, source };
}

function weightedMetricDetail(metric) {
  const raw = metric.rawValue === undefined || metric.rawValue === null || metric.rawValue === ""
    ? "n/a"
    : metric.rawValue;
  const source = metric.source ? `, ${metric.source}` : "";
  return `${metric.label}: ${raw}, norm ${(metric.normalized * 100).toFixed(0)}%, contributes ${(metric.normalized * metric.weight * 100).toFixed(1)} pts${source}`;
}

function weightedSigmoidCategory(id, label, weight, metrics) {
  const contribution = metrics.reduce((sum, metric) => sum + (metric.normalized * metric.weight), 0);
  const score = weight ? (contribution / weight) * 100 : 50;
  return {
    component: component(
      id,
      label,
      weight,
      score,
      `${metrics.map(weightedMetricDetail).join("; ")}.`,
      contribution
    ),
    contribution,
    metrics,
  };
}

function restCredit(daysRest) {
  if (!Number.isFinite(daysRest)) return 1;
  if (daysRest >= 4) return 1;
  if (daysRest === 3) return 0.65;
  if (daysRest === 2) return 0.35;
  return 0.1;
}

function closerAvailabilityCredit(bullpen = {}) {
  const recentPitches = num(bullpen.recentPitches, 0);
  const recentAppearances = num(bullpen.recentAppearances, 0);
  const recentInnings = safeDivide(num(bullpen.recentOuts, 0), 3, 0);
  if (recentPitches >= 105 || recentAppearances >= 6 || recentInnings >= 8) return 0;
  if (recentPitches >= 75 || recentAppearances >= 4 || recentInnings >= 5) return 0.5;
  return 1;
}

function temperatureCredit(temperatureF) {
  if (!Number.isFinite(temperatureF)) return 0.5;
  if (temperatureF <= 50) return 0.65;
  if (temperatureF >= 80) return 0.5;
  return 0.65 - (((temperatureF - 50) / 30) * 0.15);
}

function weightedSigmoidComponents(side, context, opponentSide) {
  const rollingXfip = Number.isFinite(side.starterWorkload?.rollingXfipLast5)
    ? side.starterWorkload.rollingXfipLast5
    : side.spXfip;
  const opponentLineupWoba = opponentSide.lineup?.woba;
  const groundBall = groundBallPct(side.pitcherStat);
  const daysRest = num(side.starterWorkload?.daysRest, 5);
  const reliefFip30d = Number.isFinite(side.bullpen?.fip30d)
    ? side.bullpen.fip30d
    : (Number.isFinite(side.bullpen?.fip) ? side.bullpen.fip : context.averageFip);
  const highLeverageIpLast3d = safeDivide(num(side.bullpen?.recentOuts, 0), 3, 0);
  const recentHitting = context.recentTeamHitting?.get(side.teamId) || {};
  const rollingWrcPlus = Number.isFinite(recentHitting.wrcPlus) ? recentHitting.wrcPlus : side.lineup?.wrcPlus;
  const lineupAvailability = Number.isFinite(side.lineup?.strengthModifier) ? side.lineup.strengthModifier : 1;
  const parkFactor = num(context.parkFactor, 100);
  const windFactor = num(context.windFactor, 0);
  const umpireZoneFactor = num(context.umpireZoneFactor, 0);
  const temperatureF = Number.isFinite(context.temperatureF) ? context.temperatureF : null;
  const catcherFramingRuns = num(side.catcherFramingRuns, 0);
  const closerCredit = closerAvailabilityCredit(side.bullpen);

  const categories = [
    weightedSigmoidCategory("startingPitcher", "Starting Pitcher", 0.40, [
      weightedSigmoidMetric("xFIP season", normalizeLowerMetric(side.spXfip, 2.5, 5.5), 0.16, Number.isFinite(side.spXfip) ? side.spXfip.toFixed(2) : "n/a", side.spXfipFallback ? "league fallback" : "season proxy"),
      weightedSigmoidMetric("xFIP rolling last 5", normalizeLowerMetric(rollingXfip, 2.5, 5.5), 0.08, Number.isFinite(rollingXfip) ? rollingXfip.toFixed(2) : "n/a", Number.isFinite(side.starterWorkload?.rollingXfipLast5) ? `${side.starterWorkload.rollingXfipStarts || 0} starts` : "season fallback"),
      weightedSigmoidMetric("K%", normalizeHigherMetric(kPct(side.pitcherStat), 0.15, 0.35), 0.06, `${(kPct(side.pitcherStat) * 100).toFixed(1)}%`),
      weightedSigmoidMetric("BB%", normalizeLowerMetric(bbPct(side.pitcherStat), 0.04, 0.12), 0.04, `${(bbPct(side.pitcherStat) * 100).toFixed(1)}%`),
      weightedSigmoidMetric("Platoon split wOBA vs lineup", normalizeLowerMetric(opponentLineupWoba, 0.280, 0.380), 0.04, Number.isFinite(opponentLineupWoba) ? opponentLineupWoba.toFixed(3) : "n/a", "opponent split proxy"),
      weightedSigmoidMetric("GB%", normalizeHigherMetric(groundBall, 0.35, 0.60), 0.012, `${(groundBall * 100).toFixed(1)}%`, "park-aware slot"),
      weightedSigmoidMetric("Days rest", restCredit(daysRest), 0.008, `${daysRest}`),
    ]),
    weightedSigmoidCategory("bullpen", "Bullpen", 0.25, [
      weightedSigmoidMetric("Relief FIP last 30 days", normalizeLowerMetric(reliefFip30d, 2.8, 5.5), 0.125, Number.isFinite(reliefFip30d) ? reliefFip30d.toFixed(2) : "n/a"),
      weightedSigmoidMetric("High-leverage IP last 3 days", normalizeLowerMetric(highLeverageIpLast3d, 0, 8), 0.075, highLeverageIpLast3d.toFixed(1), "usage penalty proxy"),
      weightedSigmoidMetric("Closer availability", closerCredit, 0.05, `${Math.round(closerCredit * 100)}%`, "rest proxy"),
    ]),
    weightedSigmoidCategory("offense", "Offense", 0.20, [
      weightedSigmoidMetric("wRC+ vs pitcher handedness", normalizeHigherMetric(side.lineup?.wrcPlus, 60, 150), 0.10, Number.isFinite(side.lineup?.wrcPlus) ? side.lineup.wrcPlus.toFixed(1) : "n/a", side.lineup?.split || ""),
      weightedSigmoidMetric("Rolling wRC+ last 14 days", normalizeHigherMetric(rollingWrcPlus, 60, 150), 0.07, Number.isFinite(rollingWrcPlus) ? rollingWrcPlus.toFixed(1) : "n/a", recentHitting.source ? `${recentHitting.startDate} to ${recentHitting.endDate}` : "season fallback"),
      weightedSigmoidMetric("Lineup availability", clamp(lineupAvailability, 0, 1), 0.03, `${Math.round(clamp(lineupAvailability, 0, 1) * 100)}%`, "neutral until confirmed lineup/WAR feed"),
    ]),
    weightedSigmoidCategory("environment", "Environment", 0.10, [
      weightedSigmoidMetric("Park run factor", normalizeHigherMetric(parkFactor, 85, 115), 0.04, parkFactor.toFixed(0)),
      weightedSigmoidMetric("Wind", normalizeHigherMetric(windFactor, -0.10, 0.10), 0.035, windFactor.toFixed(3), "neutral unless weather feed connected"),
      weightedSigmoidMetric("Temperature", temperatureCredit(temperatureF), 0.015, Number.isFinite(temperatureF) ? `${temperatureF.toFixed(0)}F` : "neutral"),
      weightedSigmoidMetric("Home field", side.side === "home" ? 1 : 0, 0.01, side.side === "home" ? "home" : "away"),
    ]),
    weightedSigmoidCategory("umpireFraming", "Umpire / Framing", 0.05, [
      weightedSigmoidMetric("HP umpire zone size", normalizeHigherMetric(umpireZoneFactor, -0.10, 0.10), 0.03, umpireZoneFactor.toFixed(3), "neutral unless umpire feed connected"),
      weightedSigmoidMetric("Catcher framing rating", normalizeHigherMetric(catcherFramingRuns, -15, 15), 0.02, catcherFramingRuns.toFixed(1), "neutral unless Savant framing feed connected"),
    ]),
  ];

  side.modelSubValues = {
    weightedScore: categories.reduce((sum, category) => sum + category.contribution, 0),
    categoryContributions: Object.fromEntries(categories.map((category) => [
      category.component.label,
      Number((category.contribution * 100).toFixed(3)),
    ])),
    metricCount: categories.reduce((sum, category) => sum + category.metrics.length, 0),
    sigmoidK: WEIGHTED_SIGMOID_K,
  };
  return categories.map((category) => category.component);
}

function modelComponents(modelId, side, context, opponentSide) {
  if (modelId === "expanded10") return expandedTenComponents(side, context, opponentSide);
  if (modelId === "pitchingContext18") return pitchingContextComponents(side, context, opponentSide);
  if (modelId === "starterPqs") return pitcherQualityComponents(side, context, opponentSide);
  if (modelId === "weightedSigmoid") return weightedSigmoidComponents(side, context, opponentSide);
  return coreFiveComponents(side, opponentSide);
}

function cloneModelSide(side) {
  return {
    ...side,
    bullpen: { ...(side.bullpen || {}) },
    lineup: { ...(side.lineup || {}) },
    starterWorkload: { ...(side.starterWorkload || {}) },
    components: [],
    modelSubValues: null,
    pitcherQualityReport: null,
    rawModelScore: null,
    composite: null,
  };
}

function scoreSingleModelPair(model, awaySource, homeSource, context) {
  const away = cloneModelSide(awaySource);
  const home = cloneModelSide(homeSource);
  if (model.id === "samfordTop10") {
    const samford = samfordTopTenPairComponents(away, home, context);
    away.components = samford.away.components;
    away.composite = samford.away.composite;
    away.modelSubValues = samford.away.subValues;
    home.components = samford.home.components;
    home.composite = samford.home.composite;
    home.modelSubValues = samford.home.subValues;
  } else {
    [away, home].forEach((side) => {
      const opponent = side.side === "away" ? home : away;
      side.components = modelComponents(model.id, side, context, opponent);
      side.composite = model.id === "starterPqs" && side.pitcherQualityReport
        ? side.pitcherQualityReport.pqs * 10
        : compositeFromComponents(side.components);
    });
  }
  const projectionAvailable = model.id === "samfordTop10" ? true : away.starterKnown && home.starterKnown;
  const winnerSide = projectionAvailable ? (away.composite >= home.composite ? "away" : "home") : null;
  const winner = winnerSide === "away" ? away : (winnerSide === "home" ? home : null);
  const loser = winnerSide === "away" ? home : (winnerSide === "home" ? away : null);
  const margin = projectionAvailable ? Math.abs(winner.composite - loser.composite) : null;
  return { model, away, home, projectionAvailable, winner, loser, margin };
}

function scoreWeightedSigmoidPair(awaySource, homeSource, context) {
  const model = modelById("weightedSigmoid");
  const away = cloneModelSide(awaySource);
  const home = cloneModelSide(homeSource);
  [away, home].forEach((side) => {
    const opponent = side.side === "away" ? home : away;
    side.components = weightedSigmoidComponents(side, context, opponent);
    side.rawModelScore = compositeFromComponents(side.components) / 100;
    side.modelSubValues = {
      ...(side.modelSubValues || {}),
      weightedScore: side.rawModelScore,
    };
  });
  const projectionAvailable = away.starterKnown && home.starterKnown;
  if (!projectionAvailable) {
    away.composite = null;
    home.composite = null;
    return { model, away, home, projectionAvailable, winner: null, loser: null, margin: null };
  }
  const scoreDiffAway = away.rawModelScore - home.rawModelScore;
  const awayProbability = sigmoidProbability(scoreDiffAway, WEIGHTED_SIGMOID_K);
  const homeProbability = 1 - awayProbability;
  away.composite = awayProbability * 100;
  home.composite = homeProbability * 100;
  away.modelSubValues = {
    ...(away.modelSubValues || {}),
    sigmoidWinProbability: awayProbability,
    sigmoidK: WEIGHTED_SIGMOID_K,
    scoreDiff: scoreDiffAway,
  };
  home.modelSubValues = {
    ...(home.modelSubValues || {}),
    sigmoidWinProbability: homeProbability,
    sigmoidK: WEIGHTED_SIGMOID_K,
    scoreDiff: -scoreDiffAway,
  };
  const winnerSide = awayProbability >= homeProbability ? "away" : "home";
  const winner = winnerSide === "away" ? away : home;
  const loser = winnerSide === "away" ? home : away;
  const margin = Math.abs(winner.composite - loser.composite);
  return { model, away, home, projectionAvailable, winner, loser, margin };
}

async function buildMlbScorecard(dateText, modelId = "core5", options = {}) {
  const includeCalibration = options.includeCalibration !== false;
  const selectedModel = modelById(modelId);
  const schedule = await mlbFetch(`/api/v1/schedule?sportId=1&gameTypes=R&date=${dateText}&hydrate=probablePitcher,team`);
  const games = (schedule.dates || []).flatMap((date) => date.games || []);
  const season = games[0]?.season || dateText.slice(0, 4);
  const [teamPitching, teamHitting] = await Promise.all([
    mlbFetch(`/api/v1/teams/stats?stats=season&group=pitching&sportIds=1&season=${season}&gameType=R`),
    mlbFetch(`/api/v1/teams/stats?stats=season&group=hitting&sportIds=1&season=${season}&gameType=R`),
  ]);
  const pitchingSplits = teamPitching.stats?.[0]?.splits || [];
  const hittingSplits = teamHitting.stats?.[0]?.splits || [];
  const pitchingContext = pitchingContextFromTeams(pitchingSplits);
  const fipConstant = pitchingContext.fipConstant;
  const leagueWoba = woba(mergeHittingStats(hittingSplits));
  const teamPitchingById = new Map(pitchingSplits.map((split) => [split.team.id, split]));
  const teamHittingById = new Map(hittingSplits.map((split) => [split.team.id, split]));
  const pitcherIds = games.flatMap((game) => [game.teams?.away?.probablePitcher?.id, game.teams?.home?.probablePitcher?.id]);
  const teamIds = [...new Set(games.flatMap((game) => [game.teams?.away?.team?.id, game.teams?.home?.team?.id]).filter(Boolean))];
  const [pitchers, bullpens, starterWorkloads, recentTeamHitting] = await Promise.all([
    pitcherMap(pitcherIds, season),
    bullpenSnapshots(teamIds, dateText, fipConstant),
    starterWorkloadMap(pitcherIds, dateText, season, pitchingContext),
    selectedModel.id === "weightedSigmoid" ? recentTeamHittingMap(teamIds, dateText, season, leagueWoba) : Promise.resolve(new Map()),
  ]);

  const rows = await Promise.all(games.map(async (game) => {
    const pitcherHands = {};
    ["away", "home"].forEach((side) => {
      const probable = game.teams[side].probablePitcher;
      const pitcher = probable ? pitchers.get(probable.id) : null;
      pitcherHands[side] = pitcher?.pitchHand?.code || "R";
    });
    const sides = await Promise.all(["away", "home"].map(async (side) => {
      const opponentSide = side === "away" ? "home" : "away";
      const slot = game.teams[side];
      const team = slot.team;
      const probable = slot.probablePitcher;
      const starterKnown = Boolean(probable?.id);
      const pitcher = probable ? pitchers.get(probable.id) : null;
      const pitcherStat = pitcher?.stats?.[0]?.splits?.[0]?.stat || {};
      const pitcherHand = pitcherHands[side];
      const calculatedSpFip = fipFromStat(pitcherStat, fipConstant);
      const calculatedSpXfip = xfipProxyFromStat(pitcherStat, pitchingContext);
      const spFip = calculatedSpFip ?? pitchingContext.averageFip;
      const spXfip = calculatedSpXfip ?? pitchingContext.averageFip;
      const spSource = calculatedSpFip === null
        ? (probable ? "League-average fallback: probable starter has no usable season innings." : "No probable starter listed. Winner cannot be projected.")
        : "Calculated from probable starter season pitching line.";
      const teamHitting = teamHittingById.get(team.id)?.stat || {};
      const teamPitching = teamPitchingById.get(team.id)?.stat || {};
      const pyth = pythagoreanWinPct(num(teamHitting.runs), num(teamPitching.runs));
      const bullpen = bullpens.get(team.id) || { era: 4.25, innings: "0.0", appearances: 0 };
      const lineup = await lineupSplitScore(team.id, pitcherHands[opponentSide] === "L" ? "L" : "R", season, leagueWoba);
      return {
        side,
        teamId: team.id,
        teamName: team.name,
        abbreviation: team.abbreviation,
        probablePitcher: probable?.fullName || "TBD",
        starterKnown,
        pitcherHand,
        pitcherStat,
        teamHittingStat: teamHitting,
        teamPitchingStat: teamPitching,
        spFip,
        spXfip,
        spSource,
        spFallback: calculatedSpFip === null,
        spXfipFallback: calculatedSpXfip === null,
        starterWorkload: starterWorkloads.get(probable?.id) || {
          lastStartDate: null,
          daysRest: 5,
          pitchCountLastStart: 85,
          expectedInnings: expectedInningsFromPitchCount(85),
          inningsLastStart: "",
          rollingXfipLast5: null,
          rollingXfipStarts: 0,
        },
        catcherFramingRuns: 0,
        teamWoba: woba(teamHitting),
        pyth,
        bullpen,
        lineup,
      };
    }));
    const away = sides.find((side) => side.side === "away");
    const home = sides.find((side) => side.side === "home");
    const parkFactor = parkFactorForVenue(game.venue?.name || "");
    const sharedContext = {
      averageFip: pitchingContext.averageFip,
      fipConstant,
      leagueHrPerIp: pitchingContext.leagueHrPerIp,
      recentTeamHitting,
      parkFactor,
      windFactor: 0,
      temperatureF: null,
      umpireZoneFactor: 0,
    };
    const modelResult = selectedModel.id === "weightedSigmoid"
      ? scoreWeightedSigmoidPair(away, home, sharedContext)
      : scoreSingleModelPair(selectedModel, away, home, sharedContext);
    Object.assign(away, {
      components: modelResult.away.components,
      composite: modelResult.away.composite,
      modelSubValues: modelResult.away.modelSubValues,
      rawModelScore: modelResult.away.rawModelScore,
      pitcherQualityReport: modelResult.away.pitcherQualityReport,
    });
    Object.assign(home, {
      components: modelResult.home.components,
      composite: modelResult.home.composite,
      modelSubValues: modelResult.home.modelSubValues,
      rawModelScore: modelResult.home.rawModelScore,
      pitcherQualityReport: modelResult.home.pitcherQualityReport,
    });
    [away, home].forEach((side) => {
      delete side.pitcherStat;
      delete side.teamHittingStat;
      delete side.teamPitchingStat;
    });
    const projectionAvailable = modelResult.projectionAvailable;
    const winner = projectionAvailable ? (modelResult.winner.side === "away" ? away : home) : null;
    const loser = winner?.side === "away" ? home : away;
    const missingStarters = [away, home]
      .filter((side) => !side.starterKnown)
      .map((side) => side.teamName);
    return {
      gamePk: game.gamePk,
      gameDate: game.gameDate,
      officialDate: game.officialDate,
      status: game.status?.detailedState || "",
      venue: game.venue?.name || "",
      actualResult: actualGameResult(game),
      away,
      home,
      projectionAvailable,
      projectionNote: projectionAvailable
        ? ""
        : `Winner cannot be projected until probable starters are listed for ${missingStarters.join(" and ")}.`,
      missingStarters,
      winner: projectionAvailable
        ? {
            side: winner.side,
            teamName: winner.teamName,
            abbreviation: winner.abbreviation,
            composite: winner.composite,
          }
        : null,
      margin: projectionAvailable ? Math.abs(winner.composite - loser.composite) : null,
    };
  }));

  rows.sort((a, b) => {
    if (a.projectionAvailable !== b.projectionAvailable) return a.projectionAvailable ? -1 : 1;
    return (b.margin || 0) - (a.margin || 0);
  });
  const calibration = includeCalibration
    ? await buildMlbCalibrationProfile(dateText, selectedModel.id)
    : emptyCalibrationProfile(selectedModel.id, "Calibration was skipped for this internal scoring run.");
  rows.forEach((game) => {
    game.confidence = confidenceForGame(game, calibration);
  });
  return {
    date: dateText,
    season,
    totalGames: rows.length,
    generatedAt: new Date().toISOString(),
    source: "MLB Stats API",
    sport: sports[0],
    sports,
    model: selectedModel,
    models: mlbModels,
    calibration,
    notes: [
      selectedModel.id === "samfordTop10"
        ? "Team FIP is calculated from public season pitching stats with a season FIP constant derived from all MLB team pitching totals."
        : "SP FIP is calculated from public season pitching stats with a season FIP constant derived from all MLB team pitching totals.",
      selectedModel.id === "samfordTop10"
        ? "This rule set scores team-level season indicators, so it can project games even when probable starters are not listed."
        : "If either team has no probable starter listed, the winner cannot be projected and the game is moved below projected edges.",
      selectedModel.id !== "samfordTop10" ? "If a probable starter has no usable season innings or no probable starter is listed, SP FIP uses current league-average FIP and is labeled in the game detail." : "",
      selectedModel.id !== "samfordTop10" ? "Bullpen ERA is calculated from completed games in the prior 15 days, excluding the first pitcher listed for each team in each boxscore." : "",
      selectedModel.id !== "samfordTop10" ? "Projected lineup wRC+ is approximated as top-nine team hitters by plate appearances in the opposing starter's handedness split, scaled from estimated wOBA against league wOBA." : "",
      selectedModel.id === "expanded10" ? "Expanded 10 uses MLB public-feed proxies for xFIP/SIERA, xwOBA/xSLG, xERA, xwOBA allowed, bullpen availability, and OAA/DRS until richer data sources are added." : "",
      selectedModel.id === "pitchingContext18" ? "Pitching Context 18 uses an HR-normalized xFIP proxy, batter-handedness split proxy, starter workload from last game log, 30-day bullpen ERA, and neutral fallbacks for weather, umpire-zone, catcher-framing, and confirmed-lineup inputs until those feeds are connected. Scale factor 2.5 is kept as a calibration target for future log-loss backtesting." : "",
      selectedModel.id === "starterPqs" ? "Starter PQS is a starting-pitcher-only report. It intentionally excludes bullpen and team offense from the score; SIERA, barrel, whiff, chase, velocity, zone, weather, and umpire values use transparent proxies or neutral fallbacks where the current MLB Stats API does not expose the requested source fields." : "",
      selectedModel.id === "samfordTop10" ? "Samford Top 10 uses only the article's ranked indicators, in order: RD, ERA, FIP, LOB%, pWAR, WHIP, H/9, BAA, oWAR, and SV. No speed, stolen-base, error, fielding-percentage, pitch-type, or velocity inputs are included." : "",
      selectedModel.id === "samfordTop10" ? "Full FanGraphs fidelity requires direct pWAR, oWAR, and LOB% fields. MLB Stats API fields are used where available; pWAR/oWAR and LOB% fall back to transparent proxies until exact FanGraphs columns are connected." : "",
      selectedModel.id === "weightedSigmoid" ? `Model 6 normalizes each requested metric to 0-1, applies the specified category and sub-metric weights, and uses tuned sigmoid k=${WEIGHTED_SIGMOID_K} to display each team's win probability.` : "",
      selectedModel.id === "weightedSigmoid" ? "Model 6 uses MLB Stats API proxies for xFIP, rolling xFIP, split wRC+, recent offense, bullpen FIP, and bullpen workload; weather, umpire-zone, catcher-framing, and confirmed-lineup availability remain neutral fallbacks until those feeds are connected." : "",
      calibration.available ? `Confidence labels use saved pregame snapshots from the prior ${calibration.lookbackDays} days: ${calibration.overall.picks} picks at ${Math.round((calibration.overall.accuracy || 0) * 100)}%.` : calibration.message,
    ].filter(Boolean),
    league: { fipConstant, averageFip: pitchingContext.averageFip, leagueHrPerIp: pitchingContext.leagueHrPerIp, woba: leagueWoba },
    games: rows,
  };
}

function snapshotBlobPath(dateText) {
  return `${BLOB_SNAPSHOT_PREFIX}${dateText}.json`;
}

function snapshotBlobDate(pathname) {
  if (!pathname.startsWith(BLOB_SNAPSHOT_PREFIX) || !pathname.endsWith(".json")) return null;
  const dateText = pathname.slice(BLOB_SNAPSHOT_PREFIX.length, -5);
  return validDate(dateText) ? dateText : null;
}

function emptySnapshotStore(dateText, modelId) {
  return {
    version: SNAPSHOT_SCHEMA_VERSION,
    sport: "mlb",
    date: dateText,
    modelId,
    captures: [],
  };
}

function normalizeSnapshotStore(store, dateText, modelId) {
  if (!store || !Array.isArray(store.captures)) return emptySnapshotStore(dateText, modelId);
  return {
    version: store.version || SNAPSHOT_SCHEMA_VERSION,
    sport: "mlb",
    date: store.date || dateText,
    modelId: store.modelId || modelId,
    updatedAt: store.updatedAt || null,
    captures: store.captures,
  };
}

function normalizeSnapshotDocument(raw, dateText) {
  const models = {};
  if (raw?.models && typeof raw.models === "object") {
    for (const [modelId, store] of Object.entries(raw.models)) {
      models[modelId] = normalizeSnapshotStore(store, raw.date || dateText, modelId);
    }
  } else if (raw?.modelId && Array.isArray(raw.captures)) {
    models[raw.modelId] = normalizeSnapshotStore(raw, raw.date || dateText, raw.modelId);
  }

  return {
    version: raw?.version || SNAPSHOT_SCHEMA_VERSION,
    sport: "mlb",
    date: raw?.date || dateText,
    updatedAt: raw?.updatedAt || null,
    models,
  };
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

function blobConfigError() {
  const message = "Vercel Blob is not configured. Add BLOB_READ_WRITE_TOKEN to the Vercel project environment variables and redeploy.";
  const error = new Error(message);
  error.statusCode = 503;
  error.code = "BLOB_NOT_CONFIGURED";
  error.json = {
    error: message,
    code: error.code,
    requiredEnv: ["BLOB_READ_WRITE_TOKEN"],
  };
  return error;
}

function ensureBlobConfigured() {
  if (!blobToken()) throw blobConfigError();
}

async function blobSdk() {
  ensureBlobConfigured();
  return import("@vercel/blob");
}

async function streamToText(stream) {
  if (!stream) return "";
  return new Response(stream).text();
}

async function readSnapshotBlobDocument(dateText) {
  const { get } = await blobSdk();
  const pathname = snapshotBlobPath(dateText);
  let result;
  try {
    result = await get(pathname, { access: "private", token: blobToken() });
  } catch (error) {
    if (/not.?found/i.test(error.name || error.message || "")) return normalizeSnapshotDocument(null, dateText);
    throw error;
  }
  if (!result || result.statusCode !== 200 || !result.stream) return normalizeSnapshotDocument(null, dateText);
  const text = await streamToText(result.stream);
  return normalizeSnapshotDocument(JSON.parse(text), dateText);
}

async function writeSnapshotBlobDocument(document) {
  const { put } = await blobSdk();
  return put(
    snapshotBlobPath(document.date),
    JSON.stringify(document, null, 2),
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      token: blobToken(),
    }
  );
}

async function listSnapshotBlobDocuments() {
  const { list } = await blobSdk();
  const documents = [];
  let cursor;
  do {
    const page = await list({ prefix: BLOB_SNAPSHOT_PREFIX, cursor, limit: 1000, token: blobToken() });
    for (const blob of page.blobs || []) {
      const dateText = snapshotBlobDate(blob.pathname);
      if (!dateText) continue;
      documents.push(await readSnapshotBlobDocument(dateText));
    }
    cursor = page.cursor;
    if (!page.hasMore) break;
  } while (cursor);
  return documents;
}

async function readSnapshotStore(dateText, modelId) {
  const document = await readSnapshotBlobDocument(dateText);
  return normalizeSnapshotStore(document.models?.[modelId], dateText, modelId);
}

function compactSnapshotSide(side) {
  return {
    side: side.side,
    teamId: side.teamId,
    teamName: side.teamName,
    abbreviation: side.abbreviation,
    probablePitcher: side.probablePitcher,
    starterKnown: side.starterKnown,
    pitcherHand: side.pitcherHand,
    composite: Number.isFinite(side.composite) ? Number(side.composite.toFixed(4)) : null,
    rawModelScore: Number.isFinite(side.rawModelScore) ? Number(side.rawModelScore.toFixed(6)) : null,
    modelSubValues: side.modelSubValues || null,
    spFip: Number.isFinite(side.spFip) ? Number(side.spFip.toFixed(4)) : null,
    pyth: Number.isFinite(side.pyth) ? Number(side.pyth.toFixed(4)) : null,
    bullpenEra: Number.isFinite(side.bullpen?.era) ? Number(side.bullpen.era.toFixed(4)) : null,
    lineupWrcPlus: Number.isFinite(side.lineup?.wrcPlus) ? Number(side.lineup.wrcPlus.toFixed(4)) : null,
    components: (side.components || []).map((item) => ({
      id: item.id,
      label: item.label,
      weight: item.weight,
      score: Number.isFinite(item.score) ? Number(item.score.toFixed(4)) : null,
      detail: item.detail,
      value: item.value,
    })),
  };
}

function compactSnapshotGame(game) {
  const margin = Number.isFinite(game.margin) ? Number(game.margin.toFixed(4)) : null;
  return {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    gameDate: game.gameDate,
    statusAtCapture: game.status,
    venue: game.venue,
    actualAtCapture: {
      isFinal: game.actualResult?.isFinal || false,
      hasScore: game.actualResult?.hasScore || false,
      detailedState: game.actualResult?.detailedState || "",
      scoreText: game.actualResult?.scoreText || "",
    },
    away: compactSnapshotSide(game.away),
    home: compactSnapshotSide(game.home),
    projectionAvailable: game.projectionAvailable,
    projectionNote: game.projectionNote,
    missingStarters: game.missingStarters,
    winner: game.winner ? {
      side: game.winner.side,
      teamName: game.winner.teamName,
      abbreviation: game.winner.abbreviation,
      composite: Number.isFinite(game.winner.composite) ? Number(game.winner.composite.toFixed(4)) : null,
    } : null,
    margin,
    bucket: edgeBucket(margin),
    confidence: game.confidence || null,
  };
}

function isPregameCapture(capturedAt, gameDate) {
  const captureTime = Date.parse(capturedAt);
  const scheduledTime = Date.parse(gameDate);
  return Number.isFinite(captureTime) && Number.isFinite(scheduledTime) && captureTime <= scheduledTime;
}

function snapshotCaptureCounts(capture) {
  const games = capture.games || [];
  const projected = games.filter((game) => game.projectionAvailable && game.winner);
  const pregame = projected.filter((game) => isPregameCapture(capture.capturedAt, game.gameDate));
  return {
    games: games.length,
    projectedGames: projected.length,
    pregameGames: pregame.length,
    lateGames: projected.length - pregame.length,
  };
}

function summarizeSnapshotStore(store) {
  const captures = store.captures || [];
  const latest = captures[captures.length - 1] || null;
  const latestCounts = latest ? snapshotCaptureCounts(latest) : {
    games: 0,
    projectedGames: 0,
    pregameGames: 0,
    lateGames: 0,
  };
  const allCounts = captures.reduce(
    (sum, capture) => {
      const counts = snapshotCaptureCounts(capture);
      sum.games += counts.games;
      sum.projectedGames += counts.projectedGames;
      sum.pregameGames += counts.pregameGames;
      sum.lateGames += counts.lateGames;
      return sum;
    },
    { games: 0, projectedGames: 0, pregameGames: 0, lateGames: 0 }
  );
  return {
    date: store.date,
    model: modelById(store.modelId),
    captures: captures.length,
    latestCapturedAt: latest?.capturedAt || null,
    latest: latestCounts,
    totals: allCounts,
  };
}

async function listMlbSnapshotInventory(dateText = null, requestedModel = "all") {
  ensureBlobConfigured();
  const stores = [];
  if (dateText) {
    for (const model of selectedModels(requestedModel)) {
      stores.push(await readSnapshotStore(dateText, model.id));
    }
  } else {
    const documents = await listSnapshotBlobDocuments();
    for (const document of documents) {
      for (const model of selectedModels(requestedModel)) {
        stores.push(normalizeSnapshotStore(document.models?.[model.id], document.date, model.id));
      }
    }
  }
  return {
    sport: sports[0],
    generatedAt: new Date().toISOString(),
    snapshots: stores
      .map(summarizeSnapshotStore)
      .sort((a, b) => b.date.localeCompare(a.date) || a.model.id.localeCompare(b.model.id)),
  };
}

async function saveMlbPredictionSnapshots(dateText, requestedModel = "all") {
  ensureBlobConfigured();
  const document = await readSnapshotBlobDocument(dateText);
  document.version = SNAPSHOT_SCHEMA_VERSION;
  document.sport = "mlb";
  document.date = dateText;
  document.models = document.models || {};
  const summaries = [];
  let changed = false;

  for (const model of selectedModels(requestedModel)) {
    const scorecard = await buildMlbScorecard(dateText, model.id, { includeCalibration: false });
    const openGames = scorecard.games.filter((game) => !game.actualResult?.isFinal);
    const capturedAt = new Date().toISOString();
    const capture = {
      id: capturedAt.replace(/[:.]/g, "-"),
      capturedAt,
      scorecardGeneratedAt: scorecard.generatedAt,
      date: dateText,
      model: {
        id: model.id,
        name: model.name,
        description: model.description,
        components: model.components,
      },
      totalGames: scorecard.totalGames,
      games: openGames.map(compactSnapshotGame),
    };
    const store = normalizeSnapshotStore(document.models?.[model.id], dateText, model.id);
    if (capture.games.length) {
      store.version = SNAPSHOT_SCHEMA_VERSION;
      store.sport = "mlb";
      store.date = dateText;
      store.modelId = model.id;
      store.updatedAt = capturedAt;
      store.captures.push(capture);
      document.models[model.id] = store;
      document.updatedAt = capturedAt;
      changed = true;
    }
    const counts = snapshotCaptureCounts(capture);
    summaries.push({
      model,
      saved: capture.games.length > 0,
      capturedAt,
      totalGames: scorecard.totalGames,
      alreadyFinalGames: scorecard.totalGames - openGames.length,
      ...counts,
      captures: store.captures.length,
    });
  }

  if (changed) await writeSnapshotBlobDocument(document);

  return {
    sport: sports[0],
    date: dateText,
    generatedAt: new Date().toISOString(),
    summaries,
    note: `Snapshots save non-final games to Vercel Blob at ${snapshotBlobPath(dateText)}. Backtests count a saved pick only when it was captured before the game's scheduled start time.`,
  };
}

async function fetchMlbGameResults(dateText) {
  const schedule = await mlbFetch(`/api/v1/schedule?sportId=1&gameTypes=R&date=${dateText}&hydrate=team`);
  const games = (schedule.dates || []).flatMap((date) => date.games || []).map((game) => ({
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    gameDate: game.gameDate,
    venue: game.venue?.name || "",
    away: {
      teamName: game.teams?.away?.team?.name || "Away",
      abbreviation: game.teams?.away?.team?.abbreviation || "Away",
    },
    home: {
      teamName: game.teams?.home?.team?.name || "Home",
      abbreviation: game.teams?.home?.team?.abbreviation || "Home",
    },
    actualResult: actualGameResult(game),
  }));
  return {
    date: dateText,
    totalGames: games.length,
    finalGames: games.filter((game) => game.actualResult?.isFinal && game.actualResult?.winner).length,
    games,
  };
}

async function cachedMlbResults(dateText, cache) {
  if (!cache.has(dateText)) cache.set(dateText, await fetchMlbGameResults(dateText));
  return cache.get(dateText);
}

function selectPregameSnapshotPredictions(store) {
  const selected = new Map();
  let capturedGames = 0;
  let lateSnapshotGames = 0;
  const captures = [...(store.captures || [])].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  captures.forEach((capture) => {
    (capture.games || []).forEach((game) => {
      capturedGames += 1;
      if (!game.projectionAvailable || !game.winner) return;
      if (!isPregameCapture(capture.capturedAt, game.gameDate)) {
        lateSnapshotGames += 1;
        return;
      }
      const current = selected.get(game.gamePk);
      if (!current || Date.parse(current.capturedAt) < Date.parse(capture.capturedAt)) {
        selected.set(game.gamePk, { ...game, capturedAt: capture.capturedAt, snapshotId: capture.id });
      }
    });
  });
  return { predictions: selected, capturedGames, lateSnapshotGames };
}

function backtestThresholdSummary(records, threshold) {
  const filtered = records.filter((record) => record.margin >= threshold);
  const correct = filtered.filter((record) => record.correct).length;
  return {
    label: threshold === 0 ? "All picks" : `Margin ${threshold}+`,
    threshold,
    picks: filtered.length,
    correct,
    incorrect: filtered.length - correct,
    accuracy: filtered.length ? correct / filtered.length : null,
  };
}

function emptyBacktestBuckets() {
  return {
    tight: emptyBacktestBucket(edgeBucketLabel("tight")),
    lean: emptyBacktestBucket(edgeBucketLabel("lean")),
    solid: emptyBacktestBucket(edgeBucketLabel("solid")),
    strong: emptyBacktestBucket(edgeBucketLabel("strong")),
  };
}

function summarizeBacktestModel(model, scorecards) {
  const buckets = emptyBacktestBuckets();
  const records = [];
  let totalGames = 0;
  let finalGames = 0;
  let skippedGames = 0;

  scorecards.forEach((scorecard) => {
    totalGames += scorecard.totalGames;
    scorecard.games.forEach((game) => {
      if (!game.actualResult?.isFinal || !game.actualResult?.winner) {
        skippedGames += 1;
        return;
      }
      finalGames += 1;
      if (!game.projectionAvailable || !game.winner) {
        skippedGames += 1;
        return;
      }
      const correct = game.winner.side === game.actualResult.winner.side;
      const bucket = edgeBucket(game.margin);
      if (buckets[bucket]) updateBacktestBucket(buckets[bucket], correct);
      records.push({
        date: scorecard.date,
        gamePk: game.gamePk,
        game: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
        pick: game.winner.abbreviation,
        actual: game.actualResult.winner.abbreviation,
        correct,
        margin: Number(game.margin.toFixed(1)),
        bucket,
        score: game.actualResult.scoreText,
      });
    });
  });

  const correct = records.filter((record) => record.correct).length;
  const thresholds = [0, 3, 7, 12].map((threshold) => backtestThresholdSummary(records, threshold));
  return {
    model,
    source: "estimated",
    sourceLabel: "Historical estimate",
    totalGames,
    finalGames,
    projectedGames: records.length,
    skippedGames,
    correct,
    incorrect: records.length - correct,
    accuracy: records.length ? correct / records.length : null,
    buckets,
    thresholds,
    records: records.sort((a, b) => b.margin - a.margin || a.date.localeCompare(b.date)),
  };
}

async function summarizeSnapshotBacktestModel(model, dates, resultCache) {
  const buckets = emptyBacktestBuckets();
  const records = [];
  let totalGames = 0;
  let finalGames = 0;
  let skippedGames = 0;
  let snapshotCaptures = 0;
  let snapshotGames = 0;
  let lateSnapshotGames = 0;
  let missingSnapshotDates = 0;

  for (const date of dates) {
    const [store, results] = await Promise.all([
      readSnapshotStore(date, model.id),
      cachedMlbResults(date, resultCache),
    ]);
    const selected = selectPregameSnapshotPredictions(store);
    totalGames += results.totalGames;
    finalGames += results.finalGames;
    snapshotCaptures += store.captures.length;
    snapshotGames += selected.capturedGames;
    lateSnapshotGames += selected.lateSnapshotGames;
    if (!store.captures.length) missingSnapshotDates += 1;

    results.games.forEach((game) => {
      if (!game.actualResult?.isFinal || !game.actualResult?.winner) {
        skippedGames += 1;
        return;
      }
      const prediction = selected.predictions.get(game.gamePk);
      if (!prediction) {
        skippedGames += 1;
        return;
      }
      const margin = Number.isFinite(Number(prediction.margin)) ? Number(Number(prediction.margin).toFixed(1)) : 0;
      const bucket = prediction.bucket || edgeBucket(margin);
      const correct = prediction.winner.side === game.actualResult.winner.side;
      if (buckets[bucket]) updateBacktestBucket(buckets[bucket], correct);
      records.push({
        date,
        gamePk: game.gamePk,
        game: `${prediction.away.abbreviation} @ ${prediction.home.abbreviation}`,
        pick: prediction.winner.abbreviation,
        actual: game.actualResult.winner.abbreviation,
        correct,
        margin,
        bucket,
        score: game.actualResult.scoreText,
        capturedAt: prediction.capturedAt,
      });
    });
  }

  const correct = records.filter((record) => record.correct).length;
  const thresholds = [0, 3, 7, 12].map((threshold) => backtestThresholdSummary(records, threshold));
  return {
    model,
    source: "snapshots",
    sourceLabel: "Saved pregame snapshots",
    totalGames,
    finalGames,
    projectedGames: records.length,
    skippedGames,
    correct,
    incorrect: records.length - correct,
    accuracy: records.length ? correct / records.length : null,
    buckets,
    thresholds,
    records: records.sort((a, b) => b.margin - a.margin || a.date.localeCompare(b.date)),
    snapshotCaptures,
    snapshotGames,
    lateSnapshotGames,
    missingSnapshotDates,
  };
}

function calibrationProfileFromBacktestSummary(summary, lookbackDays = CALIBRATION_LOOKBACK_DAYS) {
  const overall = {
    picks: summary.projectedGames || 0,
    correct: summary.correct || 0,
    incorrect: summary.incorrect || 0,
    accuracy: summary.accuracy ?? null,
  };
  if (!overall.picks) {
    return emptyCalibrationProfile(
      summary.model.id,
      `No saved pregame picks were found for ${summary.model.shortName || summary.model.name} in the prior ${lookbackDays} days. Save snapshots before first pitch to calibrate confidence.`
    );
  }
  return {
    available: true,
    modelId: summary.model.id,
    model: summary.model,
    lookbackDays,
    source: summary.source,
    sourceLabel: summary.sourceLabel,
    generatedAt: new Date().toISOString(),
    dateRange: { dates: summary.dates || null },
    overall,
    buckets: summary.buckets,
    thresholds: summary.thresholds,
    message: `Calibration sample: ${overall.picks} saved pregame picks at ${Number.isFinite(overall.accuracy) ? `${Math.round(overall.accuracy * 100)}%` : "n/a"} over the prior ${lookbackDays} days.`,
  };
}

async function buildMlbCalibrationProfile(dateText, modelId = "core5", lookbackDays = CALIBRATION_LOOKBACK_DAYS) {
  if (!blobToken()) {
    return emptyCalibrationProfile(modelId, "Vercel Blob is not configured here, so live confidence labels are uncalibrated. Add BLOB_READ_WRITE_TOKEN, save pregame snapshots, then run backtests.");
  }
  const model = modelById(modelId);
  const startDate = addDays(dateText, -lookbackDays);
  const endDate = addDays(dateText, -1);
  const dates = dateRange(startDate, endDate);
  try {
    const summary = await summarizeSnapshotBacktestModel(model, dates, new Map());
    summary.dates = dates;
    return calibrationProfileFromBacktestSummary(summary, lookbackDays);
  } catch (error) {
    return emptyCalibrationProfile(modelId, error.message || "Unable to load saved pregame calibration snapshots.");
  }
}

async function buildMlbEstimatedBacktest(startDate, endDate, requestedModel = "all") {
  const dates = dateRange(startDate, endDate);
  const models = selectedModels(requestedModel);
  const summaries = [];

  for (const model of models) {
    const scorecards = [];
    for (const date of dates) {
      scorecards.push(await buildMlbScorecard(date, model.id, { includeCalibration: false }));
    }
    summaries.push(summarizeBacktestModel(model, scorecards));
  }

  return {
    sport: sports[0],
    startDate,
    endDate,
    dates,
    generatedAt: new Date().toISOString(),
    maxDays: BACKTEST_MAX_DAYS,
    source: "MLB Stats API",
    backtestSource: "estimated",
    dataWarning: "Backtests use the current public MLB data returned by the API. They do not yet use saved pregame snapshots, so older dates may include stat values that were not frozen before first pitch.",
    summaries,
  };
}

async function buildMlbSnapshotBacktest(startDate, endDate, requestedModel = "all") {
  ensureBlobConfigured();
  const dates = dateRange(startDate, endDate);
  const resultCache = new Map();
  const summaries = [];
  for (const model of selectedModels(requestedModel)) {
    summaries.push(await summarizeSnapshotBacktestModel(model, dates, resultCache));
  }
  return {
    sport: sports[0],
    startDate,
    endDate,
    dates,
    generatedAt: new Date().toISOString(),
    maxDays: BACKTEST_MAX_DAYS,
    source: "Saved Vercel Blob snapshots + MLB Stats API final scores",
    backtestSource: "snapshots",
    dataWarning: "Backtests count only saved predictions captured before scheduled first pitch. Save snapshots before games start; live or late captures are skipped.",
    summaries,
  };
}

async function buildMlbBacktest(startDate, endDate, requestedModel = "all", source = "snapshots") {
  if (source === "estimated") return buildMlbEstimatedBacktest(startDate, endDate, requestedModel);
  return buildMlbSnapshotBacktest(startDate, endDate, requestedModel);
}


module.exports = {
  addDays,
  buildMlbBacktest,
  buildMlbOddsComparison,
  buildMlbScorecard,
  listMlbSnapshotInventory,
  mlbModels,
  saveMlbPredictionSnapshots,
  sports,
  todayIsoDate,
  validDate,
  daysBetween,
  BACKTEST_MAX_DAYS,
};
