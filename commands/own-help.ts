// ./fh help 动作名: 我们自己加的、派对 harness 里没有的命令 (命令行查不到它们的说明), 由包装 (commands/fh.ts) 直接答。
// 例子都在沙盘里真跑过 (test/sandbox/actions.test.ts "直通" 一组), 改例子要跟着改测试。
export const OWN_HELP: Record<string, string> = {
  mcp: `mcp {tool, args}: 直接用注入客户端的只读工具读游戏 (上游 factorio-mcp 的工具, 上面的命令没有的都能读)。
只开放: world_query / world_overview / ui_read / input_bindings / chat_read。只读、不动角色、不发给服务器; 动手一律用 ./fh 的动作。
world_query 的 args 就是上游的 query (selection、fields、limit、reads、mode …)。回复超过 2.4 万字只回开头, 全文在 mcp-last.json (用 python 取要的字段)。

例子:
1) 一片区域每台组装机的配方、状态、输出箱 (一次读完, reads 对选中的每台跟着读):
./fh call mcp --args '{"tool":"world_query","args":{"selection":{"kind":"entities","position":{"x":0,"y":0},"radius":30,"type":"assembling-machine"},"fields":["name","position","status"],"reads":[{"path":[{"method":"get_recipe"}],"fields":["name"]},{"path":[{"method":"get_output_inventory"},{"method":"get_contents"}]}]}}'
2) 找某种虚影 (原生过滤 filters: ghost_name、to_be_deconstructed、quality、has_item_inside …):
./fh call mcp --args '{"tool":"world_query","args":{"selection":{"kind":"entities","position":{"x":0,"y":0},"radius":30,"type":"entity-ghost","filters":{"ghost_name":"transport-belt"}},"fields":["ghost_name","position"]}}'
3) 一个对象能读哪些属性和方法 (mode members, search 按名字筛):
./fh call mcp --args '{"tool":"world_query","args":{"selection":{"kind":"inspect","target":{"kind":"character"}},"mode":"members","search":"inventory"}}'
4) 调一个只读方法 (inspect 默认 values 模式, 不收 limit; 要表的条目写 "mode":"entries","limit":64):
./fh call mcp --args '{"tool":"world_query","args":{"selection":{"kind":"inspect","target":{"kind":"game"},"path":[{"property":"forces"},{"index":"enemy"},{"method":"get_evolution_factor","arguments":["nauvis"]}]}}}'
5) 界面: 先看结构再读一支 (折线图的选择器 match {"native_type":"agui::Graph"}, 成就卡在成就窗口里):
./fh call mcp --args '{"tool":"ui_read","args":{"max_depth":1,"fields":[]}}'

区域查询看 selection_complete: false = 条数不够 (加 limit 或缩小范围)。读不到的属性在 read_status 里写原因, 不编值。`,
  belt_lanes: `belt_lanes {position | area | position + radius, limit?}: 传送带每条道上有什么。
一格 (给 position): 左道 / 右道 (按带子朝向分) 各有什么、各多少、每个物品在道上的位置; 地下带、分流器还有第 3~8 条线。
一片 (给 area 或 radius): 每格带子每条道的数, 不列位置。一次读完, 不动角色。
例: ./fh call belt_lanes --args '{"position":{"x":10.5,"y":-3.5}}'
    ./fh call belt_lanes --args '{"position":{"x":10,"y":-3},"radius":6}'`,
};
