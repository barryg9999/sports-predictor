import lib from "./_lib.cjs";
import { handleError, httpError, methodAllowed, queryParam } from "./_shared/http.js";

const { listMlbSnapshotInventory, mlbModels, todayIsoDate, validDate } = lib;

function selectedModels(modelId) {
  return modelId === "all" ? mlbModels : mlbModels.filter((model) => model.id === modelId);
}

function readOnlySnapshotResponse(date, modelId) {
  return {
    sport: { id: "mlb", name: "MLB", enabled: true },
    date,
    generatedAt: new Date().toISOString(),
    summaries: selectedModels(modelId).map((model) => ({
      model,
      saved: false,
      capturedAt: null,
      totalGames: 0,
      alreadyFinalGames: 0,
      games: 0,
      projectedGames: 0,
      pregameGames: 0,
      lateGames: 0,
      captures: 0,
    })),
    note: "This Vercel deployment is read-only. Prediction snapshots require persistent storage, so saving is disabled until a database or blob store is connected.",
  };
}

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
      res.status(200).json(readOnlySnapshotResponse(date || todayIsoDate(), modelId));
      return;
    }

    const inventory = await listMlbSnapshotInventory(date || null, modelId);
    res.status(200).json(inventory);
  } catch (error) {
    handleError(res, error);
  }
}
