# 接口能力

我们能从游戏里拿到什么、能做什么, 分三种情况:
| 身体 | 读 | 做 |
|---|---|---|
| 沙盘 (本机服务器 + RCON) | 运行时 API 全部可读 | 运行时 API 全部可写, 能直接建造、拆除、改速度、存档回档 |
| 联机 (游戏客户端 + factorio-mcp, 之后换成 io-client) | 文档里标为"可读"的属性和只读方法 (他的对象检查按同一份 API 文件开放, 有读取上限) | 只能键鼠和界面操作, 和真人玩家一样 |
| 联机做不到、只能绕的 | | 导入蓝图要走界面的"导入字符串"; 设请求、设配方都要点界面 |

下面的表由 `tools/api-catalog.mjs` 从游戏自带的 API 文件生成; "联机身体能不能读"要在 M1 用本机客户端连沙盘服务器逐项核实。

<!-- api-catalog:start -->
生成: `node tools/api-catalog.mjs`, 游戏 2.1.24 (运行时 API 第 6 版)。

| 项目 | 数量 |
|---|---|
| 运行时类 | 157 |
| 事件 | 229 |
| 概念 (数据结构) | 496 |
| 常量组 (defines) | 62 |
| 原型种类 | 279 |
| 原型数据类型 | 706 |
| 本机更新日志里的 2.1.x 版本 | 18 (最新 2.1.24) |

全局对象: `commands` `game` `helpers` `prototypes` `rcon` `remote` `rendering` `script` `settings`

### 自主玩家需要的接口 (存在性; 能不能在联机身体上读, M1 核实)
| 需要 | 接口 | 文档里 |
|---|---|---|
| 地图上有什么 (实体、状态) | `LuaSurface.find_entities_filtered`<br>`LuaEntity.status` | 方法<br>可读 |
| 地块 (湿地、可建) | `LuaSurface.get_tile`<br>`LuaTile.name` | 方法<br>可读 |
| 箱子和物品栏 | `LuaEntity.get_inventory`<br>`LuaInventory.get_contents` | 方法 (继承自 LuaControl)<br>方法 |
| 物流网库存和机器人 | `LuaLogisticNetwork.get_contents`<br>`LuaLogisticNetwork.available_logistic_robots` | 方法<br>可读 |
| 产量统计 | `LuaForce.get_item_production_statistics`<br>`LuaFlowStatistics.get_flow_count` | 方法<br>方法 |
| 电网统计 | `LuaEntity.electric_network_statistics` | 可读 |
| 污染/孢子 | `LuaSurface.get_pollution` | 方法 |
| 敌人进化 | `LuaForce.get_evolution_factor` | 方法 |
| 科技进度 | `LuaForce.technologies`<br>`LuaForce.current_research` | 可读<br>可读 |
| 火车状态和时刻表 | `LuaTrain.state`<br>`LuaTrain.get_schedule` | 可读<br>方法 |
| 游戏自带寻路 | `LuaSurface.request_path` | 方法 |
| 放蓝图 (沙盘) | `LuaItemStack.import_stack`<br>`LuaItemStack.build_blueprint` | 方法<br>方法 (继承自 LuaItemCommon) |
| 直接建造/拆除 (沙盘) | `LuaSurface.create_entity`<br>`LuaEntity.destroy` | 方法<br>方法 |
| 控制游戏速度 (沙盘) | `LuaGameScript.speed`<br>`LuaGameScript.tick_paused` | 可读/可写<br>可读/可写 |

### 按类分组 (可读属性 / 可写属性 / 方法 的个数)
**太空** (9): `LuaAsteroidChunkPrototype` 7/0/0, `LuaAsteroidCollectorControlBehavior` 5/3/0, `LuaCargoHatch` 7/0/1, `LuaCargoLandingPadControlBehavior` 6/4/0, `LuaPlanet` 5/0/4, `LuaSpaceConnectionPrototype` 9/0/0, `LuaSpaceLocationPrototype` 25/0/0, `LuaSpacePlatform` 22/9/12, `LuaSpacePlatformHubControlBehavior` 13/11/0

**火车与铁路** (8): `LuaRailEnd` 9/0/6, `LuaRailPath` 8/0/0, `LuaRailSignalBaseControlBehavior` 9/7/0, `LuaSchedule` 9/2/32, `LuaTrain` 29/4/15, `LuaTrainManager` 2/0/4, `LuaTrainStopControlBehavior` 12/10/0, `LuaVirtualSignalPrototype` 4/0/0

**物流 (机器人、请求)** (7): `LuaLogisticCell` 17/0/3, `LuaLogisticContainerControlBehavior` 8/6/0, `LuaLogisticNetwork` 25/1/10, `LuaLogisticPoint` 15/2/3, `LuaLogisticSection` 11/4/3, `LuaLogisticSections` 4/0/3, `LuaRoboportControlBehavior` 10/8/0

**电路网络** (35): `LuaAccumulatorControlBehavior` 4/2/0, `LuaAgriculturalTowerControlBehavior` 7/5/0, `LuaArithmeticCombinatorControlBehavior` 3/1/0, `LuaArtilleryTurretControlBehavior` 3/1/0, `LuaAssemblingMachineControlBehavior` 11/9/0, `LuaBoilerControlBehavior` 3/1/0, `LuaCircuitNetwork` 8/0/1, `LuaCombinatorControlBehavior` 1/0/1, `LuaConstantCombinatorControlBehavior` 5/1/3, `LuaContainerControlBehavior` 5/3/0, `LuaControlBehavior` 4/2/1, `LuaDeciderCombinatorControlBehavior` 3/1/12, `LuaDisplayPanelControlBehavior` 5/1/5, `LuaFurnaceControlBehavior` 10/8/0, `LuaGenericOnOffControlBehavior` 5/4/0, `LuaHeatPipeControlBehavior` 4/2/0, `LuaInserterControlBehavior` 7/5/0, `LuaLabControlBehavior` 9/7/0, `LuaLampControlBehavior` 9/6/0, `LuaLandMineControlBehavior` 2/0/0, `LuaLoaderControlBehavior` 4/2/0, `LuaMiningDrillControlBehavior` 5/2/0, `LuaProgrammableSpeakerControlBehavior` 4/2/0, `LuaProxyContainerControlBehavior` 5/3/0, `LuaPumpControlBehavior` 3/1/0, `LuaRadarControlBehavior` 4/2/0, `LuaReactorControlBehavior` 5/3/0, `LuaRocketSiloControlBehavior` 5/3/0, `LuaSelectorCombinatorControlBehavior` 3/1/0, `LuaSingleFluidBoxControlBehavior` 5/3/0, `LuaSplitterControlBehavior` 9/7/0, `LuaTransportBeltControlBehavior` 4/2/0, `LuaTurretControlBehavior` 6/4/0, `LuaWallControlBehavior` 6/4/0, `LuaWireConnector` 12/0/6

**玩家与界面** (9): `LuaGui` 10/0/0, `LuaGuiElement` 86/72/32, `LuaModSettingPrototype` 10/0/0, `LuaPermissionGroup` 5/1/5, `LuaPermissionGroups` 3/0/2, `LuaPlayer` 57/26/75, `LuaRendering` 1/0/12, `LuaRenderObject` 53/48/5, `LuaStyle` 62/66/1

**物品与物品栏** (17): `LuaBurner` 10/3/0, `LuaBurnerPrototype` 16/0/0, `LuaBurnerUsagePrototype` 2/0/0, `LuaEquipment` 24/5/0, `LuaEquipmentCategoryPrototype` 2/0/0, `LuaEquipmentGrid` 18/1/14, `LuaEquipmentGridPrototype` 6/0/0, `LuaEquipmentPrototype` 20/0/4, `LuaFluidEnergySourcePrototype` 18/0/0, `LuaFluidPrototype` 13/0/0, `LuaInventory` 10/0/27, `LuaItem` 7/0/0, `LuaItemCommon` 50/29/28, `LuaItemGroup` 8/0/0, `LuaItemPrototype` 85/0/15, `LuaItemStack` 13/4/14, `LuaItemSubGroup` 7/0/0

**世界与地图** (16): `LuaAISettings` 8/6/0, `LuaBootstrap` 6/0/28, `LuaChunkIterator` 2/0/0, `LuaGameScript` 32/11/45, `LuaHelpers` 4/0/19, `LuaNamedNoiseExpression` 4/0/0, `LuaNamedNoiseFunction` 3/0/0, `LuaProfiler` 2/0/5, `LuaRandomGenerator` 2/0/1, `LuaRemote` 2/0/3, `LuaSettings` 4/0/1, `LuaSurface` 37/25/96, `LuaSurfacePropertyPrototype` 5/0/0, `LuaSurfacePrototype` 4/0/0, `LuaTile` 8/0/6, `LuaTilePrototype` 33/0/0

**实体** (7): `LuaAutoplaceControlPrototype` 5/0/0, `LuaCommandable` 19/0/7, `LuaControl` 53/28/33, `LuaEntity` 258/138/177, `LuaEntityPrototype` 604/0/26, `LuaSegment` 7/0/0, `LuaSegmentedUnit` 17/7/9

**势力、科技、配方** (8): `LuaAchievementPrototype` 43/0/0, `LuaForce` 63/49/90, `LuaQualityPrototype` 48/0/2, `LuaRecipe` 18/3/2, `LuaRecipeCategoryPrototype` 2/0/0, `LuaRecipePrototype` 35/0/4, `LuaTechnology` 20/5/2, `LuaTechnologyPrototype` 19/0/0

**其他** (41): `LuaActiveTriggerPrototype` 9/0/0, `LuaAirbornePollutantPrototype` 6/0/0, `LuaAmmoCategoryPrototype` 4/0/0, `LuaCollisionLayerPrototype` 2/0/0, `LuaCommandProcessor` 3/0/2, `LuaCustomChartTag` 9/5/1, `LuaCustomEventPrototype` 3/0/0, `LuaCustomInputPrototype` 15/0/0, `LuaCustomTable` 2/0/0, `LuaDamagePrototype` 2/0/0, `LuaDebugAdapter` 3/0/5, `LuaDecorativePrototype` 12/0/0, `LuaElectricEnergySourcePrototype` 8/0/2, `LuaElectricNetwork` 5/0/2, `LuaElectricSubNetwork` 5/0/2, `LuaFlowStatistics` 11/0/13, `LuaFluidBoxPrototype` 9/0/1, `LuaFontPrototype` 9/0/0, `LuaFuelCategoryPrototype` 2/0/0, `LuaHeatBufferPrototype` 10/0/0, `LuaHeatEnergySourcePrototype` 14/0/0, `LuaLazyLoadedValue` 2/0/1, `LuaModData` 4/0/1, `LuaModuleCategoryPrototype` 2/0/0, `LuaNotificationQueue` 2/0/6, `LuaParticlePrototype` 14/0/0, `LuaPin` 14/10/2, `LuaProcessionLayerInheritanceGroupPrototype` 2/0/0, `LuaProcessionPrototype` 6/0/0, `LuaPrototypeBase` 12/0/0, `LuaPrototypes` 57/0/11, `LuaRCON` 1/0/1, `LuaRecord` 25/13/26, `LuaResourceCategoryPrototype` 2/0/0, `LuaShortcutPrototype` 7/0/0, `LuaSimulation` 5/11/15, `LuaTerritory` 4/1/7, `LuaTransportLine` 7/0/13, `LuaTrivialSmokePrototype` 16/0/0, `LuaUndoRedoStack` 3/0/16, `LuaVoidEnergySourcePrototype` 5/0/0

<!-- api-catalog:end -->
