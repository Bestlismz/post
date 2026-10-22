export function httpError(status, message, fields = {}) {
  return Object.assign(new Error(message), { status, fieldErrors: fields });
}
export function requireRole(...roles) {
  return (request, _response, next) => {
    if (!request.actor) return next(httpError(401, "Authentication required"));
    if (!roles.includes(request.actor.role)) return next(httpError(403, "Role does not permit this action"));
    next();
  };
}
