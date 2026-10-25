// Supabase Edge Function: uptime-ping
//
// 用途：给 UptimeRobot 之类的外部监控定时打一发，防止 Free 计划项目因
// 「最近一周数据库活动不足」被自动暂停。
//
// 为什么不能只返回 200：Supabase 判定活跃看的是数据库请求，单纯碰 Edge Runtime
// 不够稳。所以这里真的查一次 bt_machines（limit 1），再把结果压成一个布尔返回。
//
// 该函数以 verify_jwt=false 部署，任何人可调用；返回体不含任何业务数据，
// 只有 db 是否成功、HTTP 状态码和耗时。

Deno.serve(async (req) => {
  const started = Date.now();
  const url = new URL(req.url);

  let db = false;
  let dbStatus = 0;
  let dbError: string | null = null;

  try {
    const base = Deno.env.get("SUPABASE_URL") ?? "";
    const key =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY") ??
      "";

    const res = await fetch(
      `${base}/rest/v1/bt_machines?select=machine_id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );

    dbStatus = res.status;
    await res.text(); // 丢弃内容，只留状态
    db = res.ok;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      db,
      dbStatus,
      dbError,
      time: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ms: Date.now() - started,
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
});
