// 服务器角色的标识 (库, 不直接运行): 不加任何标识, 开局只清掉以前加过的。
// 经过: 第八轮地图上看不到 AI2 → 我加了头顶大字和地图标记; 第九轮又去掉 (分支版 harness 自己在
// 头顶画了头像和名字), 我只删了头顶大字、按自己的理解留了地图标记; 第十轮用户截图地图上的 "A / AI2": "说过的东西 你又没弄？？"。
// 用户的意思是都不要。存档里以前加的 (地图标记、头顶大字) 开局清掉。
export const BOT_LABEL_LUA = `local a = ... local n, m = 0, 0
  for _, f in pairs(game.forces) do for _, s in pairs(game.surfaces) do for _, t in pairs(f.find_chart_tags(s)) do if t.text == a.n then t.destroy() n = n + 1 end end end end
  for _, o in pairs(rendering.get_all_objects()) do if o.valid and o.type == "text" and o.text == a.n then o.destroy() m = m + 1 end end
  return {tags = n, texts = m}`;
