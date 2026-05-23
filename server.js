const http = require("http");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const root = __dirname;
loadLocalEnv(path.join(root, ".env.local"));
const resumeDir = path.join(root, "resume-bases");
const outputDir = path.join(root, "outputs");
const dataDir = path.join(root, "data");
const mlbSnapshotDir = path.join(dataDir, "mlb-prediction-snapshots");
const port = Number(process.env.PORT || 4173);
const mlbBaseUrl = "https://statsapi.mlb.com";
const oddsApiKey = process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || "";
const oddsApiBaseUrl = (process.env.ODDS_API_BASE_URL || "https://api.theoddsapi.com").replace(/\/+$/, "");
const BACKTEST_MAX_DAYS = 10;
const SNAPSHOT_SCHEMA_VERSION = 1;

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
    name: "MLB Core 5",
    shortName: "Core 5",
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
    name: "MLB Expanded 10",
    shortName: "Expanded 10",
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

function emptyBacktestBucket(label) {
  return { label, picks: 0, correct: 0, incorrect: 0, accuracy: null };
}

function updateBacktestBucket(bucket, correct) {
  bucket.picks += 1;
  if (correct) bucket.correct += 1;
  else bucket.incorrect += 1;
  bucket.accuracy = bucket.picks ? bucket.correct / bucket.picks : null;
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
    requestsRemaining: oddsResult.requestsRemaining,
    notes: [
      "Moneyline probabilities are no-vig averages from FanDuel and DraftKings when both sides are available.",
      "Model probabilities are score-implied estimates from the app's composite margin, not a fully calibrated win-probability model yet.",
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
  if (!ip) return { fipConstant: 3.1, averageFip: 4.25 };
  const leagueEra = (totals.er * 9) / ip;
  const formula = (13 * totals.hr + 3 * (totals.bb + totals.hbp) - 2 * totals.k) / ip;
  return { fipConstant: leagueEra - formula, averageFip: leagueEra };
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
    ].forEach((key) => {
      sum[key] = (sum[key] || 0) + num(stat[key]);
    });
    return sum;
  }, {});
}

function scoreParts({ spFip, pyth, bullpenEra, lineupWrc, home }) {
  return {
    sp: lowerScore(spFip, 6.5, 2.5, 50),
    pyth: higherScore(pyth, 0.25, 0.75, 50),
    bullpen: lowerScore(bullpenEra, 7.5, 2.0, 50),
    wrc: higherScore(lineupWrc, 60, 155, 50),
    hfa: home ? 100 : 0,
  };
}

function composite(parts) {
  return (parts.sp * 0.30) + (parts.pyth * 0.25) + (parts.bullpen * 0.20) + (parts.wrc * 0.18) + (parts.hfa * 0.07);
}

function component(id, label, weight, score, detail, value = "") {
  return { id, label, weight, score: Number.isFinite(score) ? score : null, detail, value };
}

function compositeFromComponents(components) {
  return components.reduce((sum, item) => sum + (Number.isFinite(item.score) ? item.score * item.weight : 0), 0);
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

async function lineupSplitScore(teamId, pitcherHand, season, leagueWoba) {
  const sitCode = pitcherHand === "L" ? "vl" : "vr";
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
    plateAppearances: num(aggregate.plateAppearances),
    split: sitCode === "vl" ? "vs LHP" : "vs RHP",
    hitters: topNine.map((split) => ({
      name: split.player?.fullName || "Unknown hitter",
      pa: num(split.stat?.plateAppearances),
      ops: split.stat?.ops || "",
    })),
  };
}

async function bullpenSnapshots(teamIds, dateText, fipConstant) {
  const wanted = new Set(teamIds);
  const startDate = addDays(dateText, -15);
  const endDate = addDays(dateText, -1);
  const workloadStartDate = addDays(dateText, -3);
  const schedule = await mlbFetch(`/api/v1/schedule?sportId=1&gameTypes=R&startDate=${startDate}&endDate=${endDate}`);
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
    recentPitches: 0,
    recentOuts: 0,
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
        current.outs += outs;
        current.earnedRuns += num(stat.earnedRuns);
        current.appearances += 1;
        current.homeRuns += num(stat.homeRuns);
        current.baseOnBalls += num(stat.baseOnBalls);
        current.hitByPitch += num(stat.hitByPitch);
        current.strikeOuts += num(stat.strikeOuts);
        current.battersFaced += num(stat.battersFaced);
        if (officialDate >= workloadStartDate) {
          current.recentPitches += num(stat.pitchesThrown || stat.numberOfPitches);
          current.recentOuts += outs;
        }
      });
    });
  });
  return new Map([...totals.entries()].map(([teamId, stat]) => {
    const era = stat.outs ? (stat.earnedRuns * 27) / stat.outs : 4.25;
    const fip = stat.outs ? fipFromStat(stat, fipConstant) : null;
    const bullpenKbb = kbbPct(stat);
    return [teamId, {
      ...stat,
      era,
      fip,
      kbbPct: bullpenKbb,
      innings: outsToIp(stat.outs),
      recentInnings: outsToIp(stat.recentOuts),
      startDate,
      endDate,
      workloadStartDate,
    }];
  }));
}

function coreFiveComponents(side) {
  const parts = scoreParts({
    spFip: side.spFip,
    pyth: side.pyth,
    bullpenEra: side.bullpen.era,
    lineupWrc: side.lineup.wrcPlus,
    home: side.side === "home",
  });
  return [
    component("spFip", "Starter FIP", 0.30, side.starterKnown ? parts.sp : null, side.starterKnown ? `FIP ${side.spFip.toFixed(2)}${side.spFallback ? " fallback" : ""}` : "No probable starter", side.starterKnown ? side.spFip : "TBD"),
    component("pyth", "Pythagorean W%", 0.25, parts.pyth, `Pyth W% ${(side.pyth * 100).toFixed(1)}%`, side.pyth),
    component("bullpenEra", "Bullpen 15-day ERA", 0.20, parts.bullpen, `15-day ERA ${side.bullpen.era.toFixed(2)}`, side.bullpen.era),
    component("lineupWrc", "Lineup wRC+", 0.18, parts.wrc, `${side.lineup.wrcPlus.toFixed(1)} ${side.lineup.split}`, side.lineup.wrcPlus),
    component("homeField", "Home field", 0.07, parts.hfa, side.side === "home" ? "Home" : "Away", parts.hfa),
  ];
}

function expandedTenComponents(side, context) {
  const spKbb = kbbPct(side.pitcherStat);
  const spFipScore = lowerScore(side.spFip, 6.5, 2.5, 50);
  const lineupWrcScore = higherScore(side.lineup.wrcPlus, 60, 155, 50);
  const pythScore = higherScore(side.pyth, 0.25, 0.75, 50);
  const availabilityScore = lowerScore(side.bullpen.recentPitches, 180, 0, 70);
  const bullpenFipScore = lowerScore(side.bullpen.fip, 6.0, 2.5, 50);
  const bullpenKbbScore = higherScore(side.bullpen.kbbPct, 0.02, 0.24, 50);
  const lineupWobaScore = higherScore(side.lineup.woba, 0.280, 0.380, 50);
  const lineupSlgScore = higherScore(side.lineup.slg, 0.340, 0.520, 50);
  const spAllowedWoba = woba(side.pitcherStat);
  const spEra = num(side.pitcherStat.era, context.averageFip);
  const spAllowedWobaScore = lowerScore(spAllowedWoba, 0.410, 0.260, 50);
  const spEraScore = lowerScore(spEra, 6.5, 2.0, 50);
  const defenseEff = defenseEfficiency(side.teamPitchingStat);
  const defenseScore = higherScore(defenseEff, 0.650, 0.730, 50);
  const parkScore = parkFitScore({ parkFactor: context.parkFactor, lineupWrc: side.lineup.wrcPlus, spFip: side.spFip });

  return [
    component("spKbb", "SP K-BB%", 0.17, side.starterKnown ? higherScore(spKbb, 0.02, 0.30, 50) : null, side.starterKnown ? (Number.isFinite(spKbb) ? `K-BB% ${(spKbb * 100).toFixed(1)}%` : "K-BB% league fallback") : "No probable starter", spKbb),
    component("spFip", "SP FIP", 0.15, side.starterKnown ? spFipScore : null, side.starterKnown ? `FIP ${side.spFip.toFixed(2)}${side.spFallback ? " fallback" : ""}` : "No probable starter", side.spFip),
    component("lineupWrc", "Lineup wRC+", 0.14, lineupWrcScore, `${side.lineup.wrcPlus.toFixed(1)} ${side.lineup.split}`, side.lineup.wrcPlus),
    component("pyth", "Pythagorean W%", 0.12, pythScore, `Pyth W% ${(side.pyth * 100).toFixed(1)}%`, side.pyth),
    component("bullpenAvailability", "Bullpen availability", 0.10, availabilityScore, `3-day relief workload: ${side.bullpen.recentPitches} pitches, ${side.bullpen.recentInnings} IP`, side.bullpen.recentPitches),
    component("bullpenSkill", "Bullpen skill", 0.09, averageScores(bullpenFipScore, bullpenKbbScore), `15-day FIP ${Number.isFinite(side.bullpen.fip) ? side.bullpen.fip.toFixed(2) : "n/a"}, K-BB% ${Number.isFinite(side.bullpen.kbbPct) ? (side.bullpen.kbbPct * 100).toFixed(1) : "n/a"}%`, side.bullpen.fip),
    component("lineupQuality", "Lineup quality", 0.08, averageScores(lineupWobaScore, lineupSlgScore), `Proxy: wOBA ${Number.isFinite(side.lineup.woba) ? side.lineup.woba.toFixed(3) : "n/a"}, SLG ${Number.isFinite(side.lineup.slg) ? side.lineup.slg.toFixed(3) : "n/a"}`, side.lineup.woba),
    component("spContact", "SP contact allowed", 0.06, side.starterKnown ? averageScores(spAllowedWobaScore, spEraScore) : null, side.starterKnown ? `Proxy: allowed wOBA ${Number.isFinite(spAllowedWoba) ? spAllowedWoba.toFixed(3) : "n/a"}, ERA ${Number.isFinite(spEra) ? spEra.toFixed(2) : "n/a"}` : "No probable starter", spAllowedWoba),
    component("park", "Park fit", 0.05, parkScore, `Run factor ${context.parkFactor}`, context.parkFactor),
    component("defense", "Defense proxy", 0.04, defenseScore, `DER proxy ${Number.isFinite(defenseEff) ? defenseEff.toFixed(3) : "n/a"}`, defenseEff),
  ];
}

function modelComponents(modelId, side, context) {
  return modelId === "expanded10" ? expandedTenComponents(side, context) : coreFiveComponents(side);
}

async function buildMlbScorecard(dateText, modelId = "core5") {
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
  const [pitchers, bullpens] = await Promise.all([pitcherMap(pitcherIds, season), bullpenSnapshots(teamIds, dateText, fipConstant)]);

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
      const spFip = calculatedSpFip ?? pitchingContext.averageFip;
      const spSource = calculatedSpFip === null
        ? (probable ? "League-average fallback: probable starter has no usable season innings." : "No probable starter listed. Winner cannot be projected.")
        : "Calculated from probable starter season pitching line.";
      const teamHitting = teamHittingById.get(team.id)?.stat || {};
      const teamPitching = teamPitchingById.get(team.id)?.stat || {};
      const pyth = pythagoreanWinPct(num(teamHitting.runs), num(teamPitching.runs));
      const bullpen = bullpens.get(team.id) || { era: 4.25, innings: "0.0", appearances: 0 };
      const lineup = await lineupSplitScore(team.id, pitcherHands[opponentSide] === "L" ? "L" : "R", season, leagueWoba);
      const parts = scoreParts({
        spFip,
        pyth,
        bullpenEra: bullpen.era,
        lineupWrc: lineup.wrcPlus,
        home: side === "home",
      });
      return {
        side,
        teamId: team.id,
        teamName: team.name,
        abbreviation: team.abbreviation,
        probablePitcher: probable?.fullName || "TBD",
        starterKnown,
        pitcherHand,
        pitcherStat,
        teamPitchingStat: teamPitching,
        spFip,
        spSource,
        spFallback: calculatedSpFip === null,
        pyth,
        bullpen,
        lineup,
        parts,
      };
    }));
    const away = sides.find((side) => side.side === "away");
    const home = sides.find((side) => side.side === "home");
    const projectionAvailable = away.starterKnown && home.starterKnown;
    const parkFactor = parkFactorForVenue(game.venue?.name || "");
    [away, home].forEach((side) => {
      side.components = modelComponents(selectedModel.id, side, {
        averageFip: pitchingContext.averageFip,
        parkFactor,
      });
      side.composite = compositeFromComponents(side.components);
      delete side.pitcherStat;
      delete side.teamPitchingStat;
    });
    const winner = projectionAvailable ? (away.composite >= home.composite ? away : home) : null;
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
    notes: [
      "SP FIP is calculated from public season pitching stats with a season FIP constant derived from all MLB team pitching totals.",
      "If either team has no probable starter listed, the winner cannot be projected and the game is moved below projected edges.",
      "If a probable starter has no usable season innings or no probable starter is listed, SP FIP uses current league-average FIP and is labeled in the game detail.",
      "Bullpen ERA is calculated from completed games in the prior 15 days, excluding the first pitcher listed for each team in each boxscore.",
      "Projected lineup wRC+ is approximated as top-nine team hitters by plate appearances in the opposing starter's handedness split, scaled from estimated wOBA against league wOBA.",
      selectedModel.id === "expanded10" ? "Expanded 10 uses MLB public-feed proxies for xFIP/SIERA, xwOBA/xSLG, xERA, xwOBA allowed, bullpen availability, and OAA/DRS until richer data sources are added." : "",
    ].filter(Boolean),
    league: { fipConstant, averageFip: pitchingContext.averageFip, woba: leagueWoba },
    games: rows,
  };
}

function snapshotStorePath(dateText, modelId) {
  return path.join(mlbSnapshotDir, `${dateText}-${modelId}.json`);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readSnapshotStore(dateText, modelId) {
  const store = await readJsonFile(snapshotStorePath(dateText, modelId), null);
  if (!store || !Array.isArray(store.captures)) {
    return {
      version: SNAPSHOT_SCHEMA_VERSION,
      sport: "mlb",
      date: dateText,
      modelId,
      captures: [],
    };
  }
  return store;
}

async function writeSnapshotStore(store) {
  await fs.mkdir(mlbSnapshotDir, { recursive: true });
  await fs.writeFile(snapshotStorePath(store.date, store.modelId), JSON.stringify(store, null, 2));
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
  const stores = [];
  if (dateText) {
    for (const model of selectedModels(requestedModel)) {
      stores.push(await readSnapshotStore(dateText, model.id));
    }
  } else {
    let entries = [];
    try {
      entries = await fs.readdir(mlbSnapshotDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const store = await readJsonFile(path.join(mlbSnapshotDir, entry.name), null);
      if (store?.sport === "mlb" && Array.isArray(store.captures)) stores.push(store);
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
  const summaries = [];
  for (const model of selectedModels(requestedModel)) {
    const scorecard = await buildMlbScorecard(dateText, model.id);
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
    const store = await readSnapshotStore(dateText, model.id);
    if (capture.games.length) {
      store.version = SNAPSHOT_SCHEMA_VERSION;
      store.sport = "mlb";
      store.date = dateText;
      store.modelId = model.id;
      store.updatedAt = capturedAt;
      store.captures.push(capture);
      await writeSnapshotStore(store);
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
  return {
    sport: sports[0],
    date: dateText,
    generatedAt: new Date().toISOString(),
    summaries,
    note: "Snapshots save non-final games only. Backtests count a saved pick only when it was captured before the game's scheduled start time.",
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
    tight: emptyBacktestBucket("Tight: margin under 3"),
    lean: emptyBacktestBucket("Lean: margin 3-6.9"),
    solid: emptyBacktestBucket("Solid: margin 7-11.9"),
    strong: emptyBacktestBucket("Strong: margin 12+"),
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

async function buildMlbEstimatedBacktest(startDate, endDate, requestedModel = "all") {
  const dates = dateRange(startDate, endDate);
  const models = selectedModels(requestedModel);
  const summaries = [];

  for (const model of models) {
    const scorecards = [];
    for (const date of dates) {
      scorecards.push(await buildMlbScorecard(date, model.id));
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
    source: "Saved local snapshots + MLB Stats API final scores",
    backtestSource: "snapshots",
    dataWarning: "Backtests count only saved predictions captured before scheduled first pitch. Save snapshots before games start; live or late captures are skipped.",
    summaries,
  };
}

async function buildMlbBacktest(startDate, endDate, requestedModel = "all", source = "snapshots") {
  if (source === "estimated") return buildMlbEstimatedBacktest(startDate, endDate, requestedModel);
  return buildMlbSnapshotBacktest(startDate, endDate, requestedModel);
}

async function listResumeBases() {
  await fs.mkdir(resumeDir, { recursive: true });
  const entries = await fs.readdir(resumeDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !/^readme\./i.test(entry.name) && /\.(docx|md|txt)$/i.test(entry.name))
    .map((entry) => ({
      file: entry.name,
      label: labelFor(entry.name),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/outputs") {
    if (req.method !== "POST") {
      send(res, 405, "Method not allowed");
      return;
    }
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = outputFileName(req.headers["x-file-name"]);
    const stampedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${fileName}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await fs.writeFile(path.join(outputDir, stampedName), Buffer.concat(chunks));
    send(res, 200, JSON.stringify({ ok: true, file: stampedName, url: `/outputs/${encodeURIComponent(stampedName)}` }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/job-link") {
    const target = url.searchParams.get("url") || "";
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      send(res, 400, "Enter a valid job link.");
      return;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      send(res, 400, "Only http and https job links are supported.");
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(parsed.href, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 Barry Job Search GPT",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
      });
    } catch (error) {
      send(res, 504, "The job link did not respond quickly enough. Paste the JD text instead.");
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      send(res, 502, `The job link returned ${response.status}. Paste the JD text instead.`);
      return;
    }
    const raw = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const text = contentType.includes("html") ? htmlToText(raw) : raw.replace(/\s+/g, " ").trim();
    if (text.length < 200) {
      send(res, 422, "I could not extract enough job description text from that link. Paste the JD text instead.");
      return;
    }
    send(res, 200, JSON.stringify({ url: parsed.href, title: titleFromHtml(raw), text }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/mlb-score" || url.pathname === "/api/score") {
    const sport = (url.searchParams.get("sport") || "mlb").toLowerCase();
    if (sport !== "mlb") {
      send(res, 400, "Only MLB is available right now.");
      return;
    }
    const date = url.searchParams.get("date") || todayIsoDate();
    const modelId = url.searchParams.get("model") || "core5";
    if (!validDate(date)) {
      send(res, 400, "Use a date in YYYY-MM-DD format.");
      return;
    }
    const scorecard = await buildMlbScorecard(date, modelId);
    send(res, 200, JSON.stringify(scorecard), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/odds") {
    const sport = (url.searchParams.get("sport") || "mlb").toLowerCase();
    if (sport !== "mlb") {
      send(res, 400, "Only MLB is available right now.");
      return;
    }
    const date = url.searchParams.get("date") || todayIsoDate();
    const modelId = url.searchParams.get("model") || "core5";
    if (!validDate(date)) {
      send(res, 400, "Use a date in YYYY-MM-DD format.");
      return;
    }
    if (!mlbModels.some((model) => model.id === modelId)) {
      send(res, 400, "Unknown MLB model.");
      return;
    }
    const odds = await buildMlbOddsComparison(date, modelId);
    send(res, 200, JSON.stringify(odds), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/snapshots") {
    const sport = (url.searchParams.get("sport") || "mlb").toLowerCase();
    if (sport !== "mlb") {
      send(res, 400, "Only MLB is available right now.");
      return;
    }
    const date = url.searchParams.get("date") || "";
    const modelId = url.searchParams.get("model") || "all";
    if (date && !validDate(date)) {
      send(res, 400, "Use date in YYYY-MM-DD format.");
      return;
    }
    if (modelId !== "all" && !mlbModels.some((model) => model.id === modelId)) {
      send(res, 400, "Unknown MLB model.");
      return;
    }
    if (req.method === "POST") {
      const snapshot = await saveMlbPredictionSnapshots(date || todayIsoDate(), modelId);
      send(res, 200, JSON.stringify(snapshot), "application/json; charset=utf-8");
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, "Method not allowed");
      return;
    }
    const inventory = await listMlbSnapshotInventory(date || null, modelId);
    send(res, 200, JSON.stringify(inventory), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/backtest") {
    const sport = (url.searchParams.get("sport") || "mlb").toLowerCase();
    if (sport !== "mlb") {
      send(res, 400, "Only MLB is available right now.");
      return;
    }
    const startDate = url.searchParams.get("startDate") || addDays(todayIsoDate(), -7);
    const endDate = url.searchParams.get("endDate") || addDays(todayIsoDate(), -1);
    const modelId = url.searchParams.get("model") || "all";
    const source = url.searchParams.get("source") || "snapshots";
    if (!validDate(startDate) || !validDate(endDate)) {
      send(res, 400, "Use startDate and endDate in YYYY-MM-DD format.");
      return;
    }
    const days = daysBetween(startDate, endDate);
    if (days < 0) {
      send(res, 400, "Start date must be before or equal to end date.");
      return;
    }
    if (days + 1 > BACKTEST_MAX_DAYS) {
      send(res, 400, `Backtest range is limited to ${BACKTEST_MAX_DAYS} days at a time.`);
      return;
    }
    if (modelId !== "all" && !mlbModels.some((model) => model.id === modelId)) {
      send(res, 400, "Unknown MLB model.");
      return;
    }
    if (!["snapshots", "estimated"].includes(source)) {
      send(res, 400, "Unknown backtest source.");
      return;
    }
    const backtest = await buildMlbBacktest(startDate, endDate, modelId, source);
    send(res, 200, JSON.stringify(backtest), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/resume-bases") {
    if (req.method === "POST") {
      await fs.mkdir(resumeDir, { recursive: true });
      const fileName = safeFileName(req.headers["x-file-name"]);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await fs.writeFile(path.join(resumeDir, fileName), Buffer.concat(chunks));
      send(res, 200, JSON.stringify({ ok: true, file: fileName }), "application/json; charset=utf-8");
      return;
    }
    const list = await listResumeBases();
    send(res, 200, JSON.stringify(list), "application/json; charset=utf-8");
    return;
  }

  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === "/") requestedPath = "/index.html";
  if (privateStaticPath(requestedPath)) {
    send(res, 404, "Not found");
    return;
  }
  const base = requestedPath.startsWith("/resume-bases/") ? resumeDir : requestedPath.startsWith("/outputs/") ? outputDir : root;
  const relative = requestedPath.startsWith("/resume-bases/")
    ? requestedPath.replace(/^\/resume-bases\//, "")
    : requestedPath.startsWith("/outputs/")
      ? requestedPath.replace(/^\/outputs\//, "")
    : requestedPath.replace(/^\//, "");
  const filePath = safeJoin(base, relative);
  const data = await fs.readFile(filePath);
  const headers = {
    "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
  };
  if (requestedPath.startsWith("/outputs/")) {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath).replace(/"/g, "")}"`;
  }
  res.writeHead(200, headers);
  res.end(data);
}

const server = http.createServer((req, res) => {
  serveStatic(req, res).catch((error) => {
    const status = error.code === "ENOENT" ? 404 : 500;
    send(res, status, status === 404 ? "Not found" : error.message);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sports Scorecard is running at http://127.0.0.1:${port}`);
  console.log(`Open http://127.0.0.1:${port}/mlb.html`);
});
