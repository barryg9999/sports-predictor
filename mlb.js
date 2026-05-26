const form = document.getElementById("scoreForm");
const dateInput = document.getElementById("gameDate");
const runStatus = document.getElementById("runStatus");
const resultTitle = document.getElementById("resultTitle");
const scoreRows = document.getElementById("scoreRows");
const gameDetails = document.getElementById("gameDetails");
const scoreNote = document.getElementById("scoreNote");
const sportSelect = document.getElementById("sportSelect");
const modelSelect = document.getElementById("modelSelect");
const modelBar = document.getElementById("modelBar");
const oddsForm = document.getElementById("oddsForm");
const oddsStatus = document.getElementById("oddsStatus");
const oddsContext = document.getElementById("oddsContext");
const oddsNote = document.getElementById("oddsNote");
const oddsRows = document.getElementById("oddsRows");
const snapshotForm = document.getElementById("snapshotForm");
const snapshotDate = document.getElementById("snapshotDate");
const snapshotModel = document.getElementById("snapshotModel");
const snapshotStatus = document.getElementById("snapshotStatus");
const snapshotNote = document.getElementById("snapshotNote");
const snapshotResults = document.getElementById("snapshotResults");
const backtestForm = document.getElementById("backtestForm");
const backtestStart = document.getElementById("backtestStart");
const backtestEnd = document.getElementById("backtestEnd");
const backtestModel = document.getElementById("backtestModel");
const backtestSource = document.getElementById("backtestSource");
const backtestStatus = document.getElementById("backtestStatus");
const backtestNote = document.getElementById("backtestNote");
const backtestResults = document.getElementById("backtestResults");

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const precise = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3, minimumFractionDigits: 3 });
const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

let currentScorecard = null;
let selectedGamePk = null;

function todayEastern() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function score(value) {
  return Number.isFinite(value) ? fmt.format(value) : "0.0";
}

function accuracy(value) {
  return Number.isFinite(value) ? pct.format(value) : "N/A";
}

function signedPct(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value > 0 ? "+" : ""}${pct.format(value)}`;
}

function american(value) {
  if (!Number.isFinite(Number(value))) return "N/A";
  const price = Number(value);
  return price > 0 ? `+${price}` : String(price);
}

function addDaysToDate(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function gameTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : timeFmt.format(date);
}

function captureTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not saved" : dateTimeFmt.format(date);
}

function confidenceClass(game) {
  return game?.confidence?.className || (game?.projectionAvailable ? "unproven" : "unavailable");
}

function confidenceLabel(game, index) {
  if (!game?.projectionAvailable) return "No projection";
  const label = game.confidence?.label || "Uncalibrated";
  return `${index + 1}. ${label}`;
}

function calibrationNote(calibration) {
  if (!calibration) return "";
  if (!calibration.available) return ` Confidence: ${esc(calibration.message || "Uncalibrated until saved pregame backtests exist.")}`;
  return ` Confidence sample: <strong>${calibration.overall?.picks || 0}</strong> saved pregame picks over ${calibration.lookbackDays || 30} days at <strong>${accuracy(calibration.overall?.accuracy)}</strong>.`;
}

function actualResultHtml(result) {
  if (!result?.hasScore) return `<span class="actual-result pending">${esc(result?.detailedState || "Scheduled")}</span>`;
  const label = result.isFinal && result.winner ? `${esc(result.winner.teamName)} won` : esc(result.detailedState || "Score");
  return `
    <span class="actual-result ${result.isFinal ? "final" : "live"}">
      <strong>${label}</strong>
      <em>${esc(result.scoreText)}</em>
    </span>
  `;
}

function componentValue(component) {
  if (Number.isFinite(component.score)) return score(component.score);
  if (component.value !== undefined && component.value !== null && component.value !== "") return esc(component.value);
  return "N/A";
}

function weightLabel(weight) {
  return Number.isFinite(weight) ? `${Math.round(weight * 100)}%` : "Final";
}

function scoringComponents(side, projectionAvailable) {
  const sigmoidProbability = side.modelSubValues?.sigmoidWinProbability;
  const isSigmoidModel = Number.isFinite(sigmoidProbability);
  return [
    {
      id: "composite",
      label: isSigmoidModel ? "Win probability" : "Composite",
      score: projectionAvailable ? side.composite : null,
      detail: projectionAvailable && isSigmoidModel
        ? `Weighted score ${score((side.modelSubValues.weightedScore || 0) * 100)}/100`
        : (projectionAvailable ? "Weighted total" : "Projection paused"),
      weight: null,
      value: projectionAvailable ? side.composite : "N/A",
    },
    ...(side.components || []),
  ];
}

function modelSubValuesHtml(subValues) {
  if (!subValues) return "";
  if (Number.isFinite(subValues.sigmoidWinProbability)) {
    const contributions = subValues.categoryContributions
      ? Object.entries(subValues.categoryContributions)
        .map(([label, value]) => `${esc(label)} ${score(value)} pts`)
        .join("; ")
      : "";
    return `<p class="detail-foot">Model 6: win probability ${accuracy(subValues.sigmoidWinProbability)}; weighted score ${score((subValues.weightedScore || 0) * 100)}/100; score gap ${Number.isFinite(subValues.scoreDiff) ? precise.format(subValues.scoreDiff) : "N/A"}; sigmoid k=${score(subValues.sigmoidK)}.${contributions ? ` Category contributions: ${contributions}.` : ""}</p>`;
  }
  if (Number.isFinite(subValues.samfordStatWins)) {
    return `<p class="detail-foot">Samford Top 10: won ${subValues.samfordStatWins} of ${subValues.samfordTotalStats || 10} indicators; weighted score ${score(subValues.samfordWeightedScore)}.</p>`;
  }
  if (Number.isFinite(subValues.pqs)) {
    return `<p class="detail-foot">Pitcher report: PQS ${precise.format(subValues.pqs)}/10; tier ${esc(subValues.confidenceTier || "N/A")}; expected ${score(subValues.expectedIp)} IP; projected ${precise.format(subValues.projectedRuns)} runs; pitch budget ${Math.round(subValues.pitchBudget || 0)}; TTO ${score(subValues.ttoExpected)}; platoon delta ${Number.isFinite(subValues.platoonWobaDelta) ? `${subValues.platoonWobaDelta >= 0 ? "+" : ""}${precise.format(subValues.platoonWobaDelta)}` : "N/A"}.</p>`;
  }
  if (Number.isFinite(subValues.bullpenExposure)) {
    return `<p class="detail-foot">Model sub-values: expected SP ${score(subValues.expectedInnings)} IP; rest penalty ${precise.format(subValues.restPenalty)}; bullpen exposure ${pct.format(subValues.bullpenExposure)}; wind ${precise.format(subValues.windFactor)}; umpire zone ${precise.format(subValues.umpireZoneFactor)}.</p>`;
  }
  return "";
}

function syncModelSelect(select, models = [], includeAll = false) {
  const selected = select.value;
  select.innerHTML = [
    includeAll ? `<option value="all">All models</option>` : "",
    ...models.map((model) => `<option value="${esc(model.id)}">${esc(model.name)}</option>`),
  ].join("");
  const validSelection = includeAll && selected === "all" || models.some((model) => model.id === selected);
  select.value = validSelection ? selected : (includeAll ? "all" : models[0].id);
}

function renderModelBar(model) {
  const components = model?.components || [];
  modelBar.innerHTML = components
    .map((item) => `
      <div>
        <strong>${Math.round(item.weight * 100)}%</strong>
        <span>${esc(item.label)}</span>
      </div>
    `)
    .join("");
}

function syncModelOptions(models = []) {
  if (!models.length) return;
  syncModelSelect(modelSelect, models);
  syncModelSelect(snapshotModel, models, true);
  syncModelSelect(backtestModel, models, true);
}

function sideCard(side, projectionAvailable) {
  const hitters = side.lineup.hitters
    .slice(0, 9)
    .map((hitter) => `<span>${esc(hitter.name)} <em>${hitter.pa} PA, ${esc(hitter.ops || "OPS n/a")}</em></span>`)
    .join("");
  const componentTiles = scoringComponents(side, projectionAvailable)
    .map((component) => `
      <div>
        <strong>${componentValue(component)}</strong>
        <span>${esc(component.label)}</span>
        <small>${esc(component.detail)} · ${weightLabel(component.weight)}</small>
      </div>
    `)
    .join("");
  const subValues = modelSubValuesHtml(side.modelSubValues);
  return `
    <div class="team-score-card">
      <div class="team-score-head">
        <div>
          <h3>${esc(side.teamName)}</h3>
          <p>${esc(side.probablePitcher)} (${esc(side.pitcherHand)})</p>
          ${side.spFallback || !side.starterKnown ? `<p class="source-warning">${esc(side.spSource)}</p>` : ""}
        </div>
        <strong>${projectionAvailable ? score(side.composite) : "N/A"}</strong>
      </div>
      <div class="component-grid">${componentTiles}</div>
      <details class="hitter-list">
        <summary>Lineup proxy hitters</summary>
        <div>${hitters || "<span>No hitter split data available.</span>"}</div>
      </details>
      ${subValues}
      <p class="detail-foot">Bullpen window: ${esc(side.bullpen.startDate)} to ${esc(side.bullpen.endDate)}; ${esc(side.bullpen.innings)} IP across ${side.bullpen.appearances} relief appearances.</p>
    </div>
  `;
}

function renderSelectedGame() {
  if (!currentScorecard?.games?.length) {
    gameDetails.innerHTML = "";
    return;
  }
  const game = currentScorecard.games.find((item) => item.gamePk === selectedGamePk) || currentScorecard.games[0];
  selectedGamePk = game.gamePk;
  const marginText = game.projectionAvailable ? `margin ${score(game.margin)}` : "winner cannot be projected";
  const componentCount = currentScorecard?.model?.components?.length || 5;
  gameDetails.innerHTML = `
    <article class="game-detail-card selected-game-card">
      <div class="game-title">
        <div>
          <h2>${esc(game.away.teamName)} @ ${esc(game.home.teamName)}</h2>
          <p>${esc(game.venue)} · ${gameTime(game.gameDate)} · ${esc(marginText)}</p>
        </div>
        <div class="game-title-actions">
          <span class="pill ${game.projectionAvailable ? "ok" : "warn"}">${game.projectionAvailable ? `Pick: ${esc(game.winner.teamName)}` : "Cannot project"}</span>
          ${game.actualResult?.hasScore ? actualResultHtml(game.actualResult) : ""}
        </div>
      </div>
      ${game.projectionAvailable ? "" : `<p class="projection-warning">${esc(game.projectionNote)}</p>`}
      <p class="selected-note">${componentCount + 1} values are shown for each team: composite plus the ${componentCount} weighted scoring components.</p>
      <div class="matchup-grid">
        ${sideCard(game.away, game.projectionAvailable)}
        ${sideCard(game.home, game.projectionAvailable)}
      </div>
    </article>
  `;
  document.querySelectorAll(".score-table tbody tr[data-game-pk]").forEach((row) => {
    const active = Number(row.dataset.gamePk) === selectedGamePk;
    row.classList.toggle("selected", active);
    row.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function selectGame(gamePk) {
  selectedGamePk = Number(gamePk);
  renderSelectedGame();
  gameDetails.scrollIntoView({ behavior: "smooth", block: "start" });
}

function render(data) {
  currentScorecard = data;
  selectedGamePk = data.games[0]?.gamePk || null;
  syncModelOptions(data.models || []);
  renderModelBar(data.model);
  resultTitle.textContent = `${data.totalGames} ${data.sport?.name || "MLB"} games scored for ${data.date}`;
  oddsContext.textContent = `Uses ${data.model?.name || "selected model"} for ${data.date}.`;
  oddsStatus.textContent = "Ready";
  oddsStatus.className = "pill";
  oddsRows.innerHTML = `<tr><td colspan="5" class="empty-row">Load odds to compare FanDuel, DraftKings, tie markets, and model edge for this slate.</td></tr>`;
  scoreNote.innerHTML = `<strong>${esc(data.model?.name || "Model")}</strong>: ${esc(data.model?.description || "")} ${esc(data.notes.join(" "))}${calibrationNote(data.calibration)} League FIP constant: <strong>${precise.format(data.league.fipConstant)}</strong>. League-average FIP fallback: <strong>${precise.format(data.league.averageFip)}</strong>. League estimated wOBA: <strong>${precise.format(data.league.woba)}</strong>.`;

  if (!data.games.length) {
    scoreRows.innerHTML = `<tr><td colspan="7" class="empty-row">No MLB regular-season games found for this date.</td></tr>`;
    gameDetails.innerHTML = "";
    return;
  }

  scoreRows.innerHTML = data.games.map((game, index) => {
    const winner = game.projectionAvailable ? (game.winner.side === "home" ? game.home : game.away) : null;
    const loser = game.projectionAvailable ? (game.winner.side === "home" ? game.away : game.home) : null;
    const klass = confidenceClass(game);
    return `
      <tr class="${game.gamePk === selectedGamePk ? "selected" : ""}" data-game-pk="${game.gamePk}" tabindex="0" aria-selected="${game.gamePk === selectedGamePk ? "true" : "false"}">
        <td><span class="edge-pill ${klass}" title="${esc(game.confidence?.reason || "")}">${esc(confidenceLabel(game, index))}</span></td>
        <td>
          <strong>${esc(game.away.abbreviation)} @ ${esc(game.home.abbreviation)}</strong>
          <span>${esc(game.venue)} · ${gameTime(game.gameDate)} · ${esc(game.status)}</span>
        </td>
        <td>${game.projectionAvailable ? esc(winner.teamName) : `<span class="projection-table-note">${esc(game.projectionNote)}</span>`}</td>
        <td>${actualResultHtml(game.actualResult)}</td>
        <td>${game.projectionAvailable ? score(winner.composite) : "N/A"}</td>
        <td>${game.projectionAvailable ? score(loser.composite) : "N/A"}</td>
        <td>${game.projectionAvailable ? score(game.margin) : "N/A"}</td>
      </tr>
    `;
  }).join("");

  renderSelectedGame();
}

async function loadScorecard(date) {
  runStatus.textContent = "Loading";
  runStatus.className = "pill warn";
  scoreRows.innerHTML = `<tr><td colspan="7" class="empty-row">Gathering schedule, starters, team strength, bullpen usage, and split hitting data...</td></tr>`;
  gameDetails.innerHTML = "";
  try {
    const params = new URLSearchParams({
      sport: sportSelect.value || "mlb",
      model: modelSelect.value || "core5",
      date,
    });
    const response = await fetch(`/api/score?${params.toString()}`);
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    render(data);
    runStatus.textContent = "Scored";
    runStatus.className = "pill ok";
  } catch (error) {
    runStatus.textContent = "Needs attention";
    runStatus.className = "pill warn";
    scoreRows.innerHTML = `<tr><td colspan="7" class="empty-row">${esc(error.message || "Unable to load MLB data.")}</td></tr>`;
  }
}

function outcomeText(outcome, teamLabel = "") {
  if (!outcome) return "N/A";
  const point = Number.isFinite(outcome.point) ? `${outcome.point > 0 ? "+" : ""}${score(outcome.point)} ` : "";
  return `${teamLabel}${point}${american(outcome.price)}`;
}

function totalText(outcome, label) {
  if (!outcome) return `${label} N/A`;
  const point = Number.isFinite(outcome.point) ? score(outcome.point) : "N/A";
  return `${label} ${point} ${american(outcome.price)}`;
}

function bookSummary(book, game) {
  return `
    <div class="book-market">
      <strong>Moneyline</strong>
      <span>${esc(game.away.abbreviation)} ${outcomeText(book.moneyline.away)} / ${esc(game.home.abbreviation)} ${outcomeText(book.moneyline.home)}</span>
    </div>
    <div class="book-market">
      <strong>Run line</strong>
      <span>${esc(game.away.abbreviation)} ${outcomeText(book.runLine.away)} / ${esc(game.home.abbreviation)} ${outcomeText(book.runLine.home)}</span>
    </div>
    <div class="book-market">
      <strong>Total</strong>
      <span>${esc(totalText(book.totals.over, "O"))} / ${esc(totalText(book.totals.under, "U"))}</span>
    </div>
  `;
}

function valueClass(edge) {
  if (!Number.isFinite(edge)) return "neutral";
  if (edge >= 0.04) return "positive";
  if (edge <= -0.04) return "negative";
  return "neutral";
}

function oddsEdgeHtml(game) {
  if (!game.projectionAvailable || !game.pick) {
    return `<span class="market-note">No model projection</span>`;
  }
  const best = game.bestMoneyline;
  return `
    <div class="market-edge ${valueClass(game.edge)}">
      <strong>${esc(game.valueLabel)}</strong>
      <span>${esc(game.pick.abbreviation)} model ${accuracy(game.modelProbability)} vs market ${accuracy(game.marketProbability)}</span>
      <span>Edge ${signedPct(game.edge)}${best ? ` · best ML ${esc(best.bookLabel)} ${american(best.price)}` : ""}</span>
    </div>
  `;
}

function tiePushText(game) {
  const ties = (game.tieOutcomes || [])
    .map((item) => `${item.bookLabel} ${american(item.price)}`)
    .join(" / ");
  return `
    <div class="book-market">
      <strong>Tie market</strong>
      <span>${ties ? esc(ties) : "No 3-way tie outcome returned."}</span>
    </div>
    <div class="book-market">
      <strong>Push rules</strong>
      <span>${esc(game.pushInfo?.runLine || "Run line push depends on the listed point.")}</span>
      <span>${esc(game.pushInfo?.total || "Total push depends on the listed point.")}</span>
    </div>
  `;
}

function oddsGameRow(game) {
  const fanDuel = game.books.find((book) => book.key === "fanduel") || {};
  const draftKings = game.books.find((book) => book.key === "draftkings") || {};
  return `
    <tr>
      <td>
        <strong>${esc(game.game)}</strong>
        <span>${esc(game.away.teamName)} @ ${esc(game.home.teamName)}</span>
        <span>${game.matchedOdds ? "Odds matched" : "No matching odds event"}</span>
      </td>
      <td>${oddsEdgeHtml(game)}</td>
      <td>${bookSummary(fanDuel, game)}</td>
      <td>${bookSummary(draftKings, game)}</td>
      <td>${tiePushText(game)}</td>
    </tr>
  `;
}

function renderOdds(data) {
  if (!data.configured) {
    oddsStatus.textContent = "Needs key";
    oddsStatus.className = "pill warn";
    oddsNote.textContent = data.message || "Set ODDS_API_KEY or THE_ODDS_API_KEY and restart the app.";
    oddsRows.innerHTML = `<tr><td colspan="5" class="empty-row">${esc(oddsNote.textContent)}</td></tr>`;
    return;
  }
  const matched = data.games.filter((game) => game.matchedOdds).length;
  oddsNote.textContent = `${data.provider}: ${matched} of ${data.games.length} games matched. ${data.requestsRemaining === null ? "" : `${data.requestsRemaining} odds requests remaining. `}${(data.notes || []).join(" ")}`;
  oddsRows.innerHTML = data.games.length
    ? data.games.map(oddsGameRow).join("")
    : `<tr><td colspan="5" class="empty-row">No odds games returned for this date.</td></tr>`;
}

async function loadOdds() {
  oddsStatus.textContent = "Loading";
  oddsStatus.className = "pill warn";
  oddsRows.innerHTML = `<tr><td colspan="5" class="empty-row">Loading FanDuel and DraftKings odds...</td></tr>`;
  try {
    const params = new URLSearchParams({
      sport: "mlb",
      model: modelSelect.value || "core5",
      date: dateInput.value || todayEastern(),
    });
    const response = await fetch(`/api/odds?${params.toString()}`);
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    renderOdds(data);
    if (data.configured) {
      oddsStatus.textContent = "Loaded";
      oddsStatus.className = "pill ok";
    }
  } catch (error) {
    oddsStatus.textContent = "Needs attention";
    oddsStatus.className = "pill warn";
    oddsRows.innerHTML = `<tr><td colspan="5" class="empty-row">${esc(error.message || "Unable to load odds.")}</td></tr>`;
  }
}

function snapshotSummaryCard(summary) {
  const latest = summary.latest || {};
  const totals = summary.totals || {};
  return `
    <article class="snapshot-card">
      <div class="snapshot-card-head">
        <div>
          <h3>${esc(summary.model.name)}</h3>
          <p>${summary.captures} captures saved for ${esc(summary.date)}.</p>
        </div>
        <strong>${summary.latestCapturedAt ? captureTime(summary.latestCapturedAt) : "None"}</strong>
      </div>
      <div class="snapshot-metrics">
        <div><strong>${latest.pregameGames || 0}</strong><span>Pregame picks</span></div>
        <div><strong>${latest.lateGames || 0}</strong><span>Late picks</span></div>
        <div><strong>${totals.projectedGames || 0}</strong><span>Total picks saved</span></div>
      </div>
    </article>
  `;
}

function snapshotSaveCard(summary) {
  return `
    <article class="snapshot-card">
      <div class="snapshot-card-head">
        <div>
          <h3>${esc(summary.model.name)}</h3>
          <p>${summary.saved ? `${summary.games} non-final games captured.` : "No non-final games were available to capture."}</p>
        </div>
        <strong>${summary.saved ? "Saved" : "Skipped"}</strong>
      </div>
      <div class="snapshot-metrics">
        <div><strong>${summary.pregameGames}</strong><span>Pregame picks</span></div>
        <div><strong>${summary.lateGames}</strong><span>Late picks</span></div>
        <div><strong>${summary.alreadyFinalGames}</strong><span>Already final</span></div>
      </div>
    </article>
  `;
}

function renderSnapshotInventory(data) {
  const saved = (data.snapshots || []).filter((summary) => summary.captures > 0);
  snapshotResults.innerHTML = saved.length
    ? saved.map(snapshotSummaryCard).join("")
    : `<div class="empty-row">No saved snapshots for this date yet.</div>`;
}

function renderSnapshotSave(data) {
  snapshotNote.textContent = data.note;
  snapshotResults.innerHTML = data.summaries.map(snapshotSaveCard).join("");
}

async function loadSnapshotInventory() {
  try {
    const params = new URLSearchParams({
      sport: "mlb",
      model: snapshotModel.value || "all",
      date: snapshotDate.value || todayEastern(),
    });
    const response = await fetch(`/api/snapshots?${params.toString()}`);
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    renderSnapshotInventory(data);
  } catch (error) {
    snapshotResults.innerHTML = `<div class="empty-row">${esc(error.message || "Unable to load snapshots.")}</div>`;
  }
}

async function saveSnapshot() {
  snapshotStatus.textContent = "Saving";
  snapshotStatus.className = "pill warn";
  snapshotResults.innerHTML = `<div class="empty-row">Saving model predictions for non-final games...</div>`;
  try {
    const params = new URLSearchParams({
      sport: "mlb",
      model: snapshotModel.value || "all",
      date: snapshotDate.value || todayEastern(),
    });
    const response = await fetch(`/api/snapshots?${params.toString()}`, { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    renderSnapshotSave(data);
    snapshotStatus.textContent = "Saved";
    snapshotStatus.className = "pill ok";
  } catch (error) {
    snapshotStatus.textContent = "Needs attention";
    snapshotStatus.className = "pill warn";
    snapshotResults.innerHTML = `<div class="empty-row">${esc(error.message || "Unable to save snapshot.")}</div>`;
  }
}

function thresholdAdvice(thresholds = []) {
  const useful = thresholds
    .filter((item) => item.picks >= 3)
    .sort((a, b) => b.accuracy - a.accuracy || b.picks - a.picks)[0];
  if (!useful) return "Need more completed picks before setting a no-pick threshold.";
  const allPicks = thresholds.find((item) => item.threshold === 0);
  if (allPicks?.picks >= 3 && Number.isFinite(allPicks.accuracy) && allPicks.accuracy < 0.5) {
    return `This sample is below 50% (${accuracy(allPicks.accuracy)}). Treat this model as no-pick until more saved pregame data improves.`;
  }
  if (useful.threshold === 0) return "No margin filter improved this sample. Treat all confidence labels as uncalibrated.";
  return `Best sample filter: only use picks with ${useful.label.toLowerCase()} (${accuracy(useful.accuracy)} on ${useful.picks} picks).`;
}

function backtestSummaryCard(summary) {
  const sourceLine = summary.source === "snapshots"
    ? `${summary.snapshotCaptures || 0} captures, ${summary.snapshotGames || 0} saved games; ${summary.lateSnapshotGames || 0} late picks skipped.`
    : "Rebuilt from the current MLB API response for the selected historical dates.";
  const bucketRows = ["strong", "solid", "lean", "tight"].map((key) => {
    const bucket = summary.buckets[key];
    const rating = bucket.rating || {};
    return `
      <tr>
        <td><span class="edge-pill ${key}">${esc(key)}</span></td>
        <td>${bucket.picks}</td>
        <td>${bucket.correct}</td>
        <td>${bucket.incorrect}</td>
        <td>${accuracy(bucket.accuracy)}</td>
        <td><span class="edge-pill ${esc(rating.className || "unproven")}">${esc(rating.label || "Unproven")}</span></td>
      </tr>
    `;
  }).join("");

  const thresholdRows = summary.thresholds.map((item) => `
    <tr>
      <td>${esc(item.label)}</td>
      <td>${item.picks}</td>
      <td>${item.correct}</td>
      <td>${item.incorrect}</td>
      <td>${accuracy(item.accuracy)}</td>
    </tr>
  `).join("");

  const recentRows = summary.records.slice(0, 12).map((record) => `
    <tr>
      <td>${esc(record.date)}</td>
      <td>${esc(record.game)}<span>${esc(record.score)}</span></td>
      <td>${esc(record.pick)}</td>
      <td>${esc(record.actual)}</td>
      <td><span class="actual-result ${record.correct ? "final" : "pending"}"><strong>${record.correct ? "Right" : "Wrong"}</strong><em>${esc(record.bucket)} · ${score(record.margin)}${record.capturedAt ? ` · ${captureTime(record.capturedAt)}` : ""}</em></span></td>
    </tr>
  `).join("");

  return `
    <article class="backtest-card">
      <div class="backtest-card-head">
        <div>
          <h3>${esc(summary.model.name)}</h3>
          <p>${summary.projectedGames} projected finals from ${summary.finalGames} completed games; ${summary.skippedGames} skipped. ${esc(sourceLine)}</p>
        </div>
        <strong>${accuracy(summary.accuracy)}</strong>
      </div>
      <div class="backtest-metrics">
        <div><strong>${summary.correct}</strong><span>Right</span></div>
        <div><strong>${summary.incorrect}</strong><span>Wrong</span></div>
        <div><strong>${summary.projectedGames}</strong><span>Picks</span></div>
      </div>
      <p class="calibration-advice">${esc(thresholdAdvice(summary.thresholds))}</p>
      <div class="backtest-tables">
        <div>
          <h4>Confidence Buckets</h4>
          <table class="score-table compact-table">
            <thead><tr><th>Bucket</th><th>Picks</th><th>Right</th><th>Wrong</th><th>Accuracy</th><th>Use</th></tr></thead>
            <tbody>${bucketRows}</tbody>
          </table>
        </div>
        <div>
          <h4>No-Pick Thresholds</h4>
          <table class="score-table compact-table">
            <thead><tr><th>Filter</th><th>Picks</th><th>Right</th><th>Wrong</th><th>Accuracy</th></tr></thead>
            <tbody>${thresholdRows}</tbody>
          </table>
        </div>
      </div>
      <details class="backtest-detail-list">
        <summary>Show strongest tested picks</summary>
        <div class="score-table-wrap">
          <table class="score-table compact-table">
            <thead><tr><th>Date</th><th>Game</th><th>Pick</th><th>Actual</th><th>Result</th></tr></thead>
            <tbody>${recentRows || `<tr><td colspan="5" class="empty-row">No completed projected games in this range.</td></tr>`}</tbody>
          </table>
        </div>
      </details>
    </article>
  `;
}

function renderBacktest(data) {
  backtestNote.textContent = data.dataWarning;
  backtestResults.innerHTML = data.summaries.map(backtestSummaryCard).join("");
}

async function runBacktest() {
  backtestStatus.textContent = "Running";
  backtestStatus.className = "pill warn";
  backtestResults.innerHTML = `<div class="empty-row">Running date range through the selected model set...</div>`;
  try {
    const params = new URLSearchParams({
      sport: "mlb",
      model: backtestModel.value || "all",
      source: backtestSource.value || "snapshots",
      startDate: backtestStart.value,
      endDate: backtestEnd.value,
    });
    const response = await fetch(`/api/backtest?${params.toString()}`);
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    renderBacktest(data);
    backtestStatus.textContent = "Backtested";
    backtestStatus.className = "pill ok";
  } catch (error) {
    backtestStatus.textContent = "Needs attention";
    backtestStatus.className = "pill warn";
    backtestResults.innerHTML = `<div class="empty-row">${esc(error.message || "Unable to run backtest.")}</div>`;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadScorecard(dateInput.value || todayEastern());
});

oddsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadOdds();
});

snapshotForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveSnapshot();
});

snapshotDate.addEventListener("change", () => loadSnapshotInventory());
snapshotModel.addEventListener("change", () => loadSnapshotInventory());

backtestForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runBacktest();
});

sportSelect.addEventListener("change", () => loadScorecard(dateInput.value || todayEastern()));
modelSelect.addEventListener("change", () => loadScorecard(dateInput.value || todayEastern()));

scoreRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-game-pk]");
  if (row) selectGame(row.dataset.gamePk);
});

scoreRows.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-game-pk]");
  if (!row) return;
  event.preventDefault();
  selectGame(row.dataset.gamePk);
});

dateInput.value = todayEastern();
snapshotDate.value = todayEastern();
backtestEnd.value = addDaysToDate(todayEastern(), -1);
backtestStart.value = addDaysToDate(backtestEnd.value, -6);
loadScorecard(dateInput.value);
loadSnapshotInventory();
