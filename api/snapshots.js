import lib from "./_lib.cjs";
import { handleError, httpError, methodAllowed, queryParam } from "./_shared/http.js";

const { listMlbSnapshotInventory, mlbModels, saveMlbPredictionSnapshots, todayIsoDate, validDate } = lib;

export default async function handler(req, res) {
  try {
    if (!methodAllowed(req, res, ["GET", "POST"])) return;
    const sport = queryParam(req, "sport", "mlb").toLowerCase();
    if (sport !== "mlb") throw httpError(400, "Only MLB is available right now.");

    const date = queryParam(req, "date", "");
    const modelId = queryParam(req, "model", "all");
    if (date && !validDate(date)) throw httpError(400, "Use date in YYYY-MM-DD format.");
    if (modelId !== "all" && !mlbModels.some((model) => model.id === modelId)) throw httpError(400, "Unknown MLB model.");

    if (req.method === "POST") {
      const snapshot = await saveMlbPredictionSnapshots(date || todayIsoDate(), modelId);
      res.status(200).json(snapshot);
      return;
    }

    const inventory = await listMlbSnapshotInventory(date || null, modelId);
    res.status(200).json(inventory);
  } catch (error) {
    handleError(res, error);
  }
}
