export function methodAllowed(req, res, methods = ["GET"]) {
  if (methods.includes(req.method)) return true;
  res.setHeader("Allow", methods.join(", "));
  res.status(405).send("Method not allowed");
  return false;
}

export function queryParam(req, name, fallback = "") {
  const value = req.query?.[name];
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export function handleError(res, error) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  res.status(status).send(status === 500 ? error.message || "Server error" : error.message);
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
