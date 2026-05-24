import lib from "./_lib.cjs";
import { handleError, httpError, methodAllowed, queryParam } from "./_shared/http.js";

const { buildMlbScorecard, mlbModels, todayIsoDate, validDate } = lib;

export default async function handler(req, res) {
  try {
    if (!methodAllowed(req, res, ["GET"])) return;
    const sport = queryParam(req, "sport", "mlb").toLowerCase();
    if (sport !== "mlb") throw httpError(400, "Only MLB is available right now.");

    const date = queryParam(req, "date", todayIsoDate());
    const modelId = queryParam(req, "model", "core5");
    if (!validDate(date)) throw httpError(400, "Use a date in YYYY-MM-DD format.");
    if (!mlbModels.some((model) => model.id === modelId)) throw httpError(400, "Unknown MLB model.");

    const scorecard = await buildMlbScorecard(date, modelId);
    res.status(200).json(scorecard);
  } catch (error) {
    handleError(res, error);
  }
}
