export function logIncomingRequest(route: string, request: Request, extra?: Record<string, unknown>) {
  const deviceId = request.headers.get('x-aidol-device-id')?.trim() ?? '';
  const payload = {
    at: new Date().toISOString(),
    method: request.method,
    route,
    device: deviceId ? `${deviceId.slice(0, 8)}…` : 'missing',
    region: process.env.VERCEL_REGION ?? 'unknown',
    deployment: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    ...extra
  };
  console.log(`[aidol] ${route} ${request.method}`, payload);
}
