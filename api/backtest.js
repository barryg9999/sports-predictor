import lib from "./_lib.cjs";
import { handleError, httpError, methodAllowed, queryParam } from "./_shared/http.js";

const { addDays, BACKTEST_MAX_DAYS, buildMlbBacktest, daysBetween, mlbModels, todayIsoDate, validDate } = lib;

export default async function handler(req, res) {
  try {
    if (!methodAllowed(req, res, ["GET"])) return;
    const sport = queryParam(req, "sport", "mlb").toLowerCase();
    if (sport !== "mlb") throw httpError(400, "Only MLB is available right now.");

    const startDate = queryParam(req, "startDate", addDays(todayIsoDate(), -7));
    const endDate = queryParam(req, "endDate", addDays(todayIsoDate(), -1));
    const modelId = queryParam(req, "model", "all");
    const source = queryParam(req, "source", "snapshots");

    if (!validDate(startDate) || !validDate(endDate)) throw httpError(400, "Use startDate and endDate in YYYY-MM-DD format.");
    const days = daysBetween(startDate, endDate);
    if (days < 0) throw httpError(400, "Start date must be before or equal to end date.");
    if (days + 1 > BACKTEST_MAX_DAYS) throw httpError(400, `Backtest range is limited to ${BACKTEST_MAX_DAYS} days at a time.`);
    if (modelId !== "all" && !mlbModels.some((model) => model.id === modelId)) throw httpError(400, "Unknown MLB model.");
    if (!["snapshots", "estimated"].includes(source)) throw httpError(400, "Unknown backtest source.");

    const backtest = await buildMlbBacktest(startDate, endDate, modelId, source);
    res.status(200).json(backtest);
  } catch (error) {
    handleError(res, error);
  }
}
