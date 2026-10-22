export async function retryOnceWithFreshCsrf({ token, request, refresh, onRefresh = () => {} }) {
  try { return await request(token); }
  catch (error) {
    if (error?.status !== 403) throw error;
    const fresh = await refresh();
    if (typeof fresh !== "string" || !fresh) throw error;
    onRefresh(fresh);
    return request(fresh);
  }
}
