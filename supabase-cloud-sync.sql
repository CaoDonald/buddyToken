-- ============================================================================
-- buddyToken 多端云同步 · Supabase 表结构
--
-- 用法：Supabase 控制台 → SQL Editor → 整段粘贴执行一次（可重复执行，不会丢数据）。
--
-- 表名统一加 bt_ 前缀：Supabase 一个项目下所有表共用 public schema，
-- 加前缀避免与项目里的其他业务冲突（建议用独立项目，但共用也不会撞名）。
--
-- 数据流向：每台机器各自 push 自己的增量 → 各自 pull 别人的增量 →
-- 在本地 token-usage-data.js 里合并。云端只当「传阅箱」，不是权威数据源。
-- ============================================================================

-- ---------------------------------------------------------------- 机器名册
-- 前端据 machine_name 显示「台式机 / 笔记本」。machine_id 由各机首次运行时
-- 用 randomUUID 生成并存在本地 sync-state.json，不依赖主机名（主机名会重复）。
--
-- 这张表刻意没有 updated_at 列：它的时间语义由 last_seen 表达，而且数量小、
-- 每轮全量拉，不需要增量游标。因此它也不在下面的 updated_at 触发器数组里。
create table if not exists public.bt_machines (
  machine_id   text primary key,
  machine_name text not null default '',
  platform     text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

-- ---------------------------------------------------------------- 回合表
-- 一个回合 = 一次用户提问 = 该次提问里所有 API 请求的 token 之和，
-- 键是 conversationRequestId（小写归一），与官方账单行的 request_id 同源。
--
-- 主键含 machine_id 的理由：如果用户把 ~/.workbuddy 整个目录复制到另一台，
-- 同一个回合会同时出现在两台机器上。若只用 turn_key 做主键，两台会互相覆盖，
-- 「按机器看各自贡献」就永远只能看到一台。
--
-- steps 存每步明细（本地 d 字段：[时间ms, 工具, 输入, 输出, 缓存读, 模型耗时ms]），
-- 是体积大头，但看板的工具分布与耗时分析要靠它。
create table if not exists public.bt_turns (
  machine_id text    not null,
  turn_key   text    not null,
  n          integer not null default 0,
  in_tokens  bigint  not null default 0,   -- 避开 SQL 关键字 in，下同
  out_tokens bigint  not null default 0,
  cr_tokens  bigint  not null default 0,
  cc_tokens  bigint  not null default 0,
  tot_tokens bigint  not null default 0,
  t0         bigint  not null default 0,   -- 回合首个请求时间戳 ms
  t1         bigint  not null default 0,   -- 回合末个请求时间戳 ms（推送水位线用）
  model      text    not null default '',
  session_id text    not null default '',
  source     text    not null default '',
  project    text    not null default '',
  lat_sum    bigint  not null default 0,
  lat_n      integer not null default 0,
  steps      jsonb,
  updated_at timestamptz not null default now(),
  primary key (machine_id, turn_key)
);

-- ---------------------------------------------------------------- 账单表
-- 官方账单行：[requestId, 积分, 模型, 客户端, 时间戳ms, 账号uid]。
--
-- 账号列存 uid 文本，而不是本地数据文件里的 uids 下标：下标是「本机视角」的
-- 序号，A 机 uids=[u1,u2]、B 机 uids=[u2,u3] 时同一个下标指向不同人，
-- 跨机合并后归属会整体错乱。uid 文本才是跨机稳定标识；合并回本地时再由
-- 代码翻译成本机 uids 下标。
--
-- machine_id 表示「这条账单的请求是哪台机器发出的」，由 request_id 反查本机
-- 回合得到；查不到（CLI 会话、其他机器用同账号产生的请求、会话已清理）为 null，
-- 前端把它们归到「未标注」。
create table if not exists public.bt_bills (
  request_id   text primary key,
  credit       numeric not null default 0,
  model        text    not null default '',
  client       text    not null default '',
  request_time bigint  not null default 0,
  uid          text    not null default '',
  machine_id   text,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- 余额历史
-- 余额趋势用。与本地 credit-history.json 口径一致：同一账号同一天只留最后一条。
create table if not exists public.bt_hist (
  uid        text   not null,
  day        date   not null,
  ts         bigint not null default 0,    -- 当天最后一次观察时刻 ms
  remaining  bigint not null default 0,
  machine_id text,
  updated_at timestamptz not null default now(),
  primary key (uid, day)
);

-- ---------------------------------------------------------------- 账号余额快照
-- 注意：余额是「当前值」不是累加量，合并时取官方 updated_at 更大的一条。
-- login 是「本机登录态」（本机装了哪些客户端、凭证何时到期），属于机器本地
-- 事实，合并时永远保留本机值——用远端值覆盖会污染本机的登录徽标。
create table if not exists public.bt_acct (
  uid                 text primary key,
  name                text,
  total               bigint,
  remaining           bigint,
  used                bigint,
  packages            jsonb,
  login               jsonb,
  official_updated_at bigint,
  machine_id          text,
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------- 会话标题
create table if not exists public.bt_titles (
  session_id text primary key,
  title      text not null,
  machine_id text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 拉取游标索引
-- 拉取固定按 updated_at > 游标 增量查，每张带游标的表都要有索引，否则全表扫。
create index if not exists bt_turns_updated_idx  on public.bt_turns  (updated_at);
create index if not exists bt_bills_updated_idx  on public.bt_bills  (updated_at);
create index if not exists bt_hist_updated_idx   on public.bt_hist   (updated_at);
create index if not exists bt_acct_updated_idx   on public.bt_acct   (updated_at);
create index if not exists bt_titles_updated_idx on public.bt_titles (updated_at);

-- ---------------------------------------------------------------- updated_at 维护
-- 为什么必须用触发器：PostgREST 的 upsert 走的是 insert ... on conflict do update，
-- 列的 default now() 只在 insert 时生效，update 分支不会刷新 updated_at。
-- 而 updated_at 正是拉取游标——不刷新的话，别人永远拉不到这条的更新。
-- 顺带好处：时间由服务端给，不受各机时钟偏差影响。
--
-- 注意 bt_machines 不在其中：它没有 updated_at 列（时间由 last_seen 表达），
-- 机身名册数量小、每轮全量拉，不需要游标。把有列的表写进这个数组即可，
-- 混进没列的表会让触发器在写入时直接报 record "new" has no field "updated_at"。
create or replace function public.bt_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

-- 清理早期版本误建在 bt_machines 上的触发器（那一版把它也写进了数组）
drop trigger if exists trg_bt_machines_touch on public.bt_machines;

do $$
declare t text;
begin
  foreach t in array array['bt_turns','bt_bills','bt_hist','bt_acct','bt_titles']::text[]
  loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', t, t);
    execute format(
      'create trigger trg_%s_touch before insert or update on public.%I '
      'for each row execute function public.bt_touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- 访问控制
-- 表全部开启 RLS，并显式放行 anon 角色。
--
-- 取舍说明：单人多机自用场景，anon key 只存在各机本地的 sync-config.json
-- （已 gitignore、看板页面与代码仓库都不含），所以「放行 anon」实际等价于
-- 「拿到 key 就能读写」。不开 RLS 则 key 一旦泄露是彻底裸奔，所以必须开。
-- 不用 service_role 代替：那个 key 权限更大，泄露后果更重，本场景不需要。
--
-- key 泄露了怎么办：Supabase 控制台轮换 anon key，再更新各机的 sync-config.json。
do $$
declare t text;
begin
  foreach t in array array['bt_machines','bt_turns','bt_bills','bt_hist','bt_acct','bt_titles']::text[]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_anon_all', t);
    execute format(
      'create policy %I on public.%I for all to anon using (true) with check (true)',
      t || '_anon_all', t);
  end loop;
end $$;
