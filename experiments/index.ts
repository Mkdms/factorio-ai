// 全部实验的登记表。新实验: 在 experiments/ 下写一个文件, 再在这里登记。
import type { Experiment } from "../src/verify/types.ts";
import { heatingTowerPower, heatingTowerBurnsAtMax } from "./heating-tower.ts";
import { copperBacteriaChance } from "./bacteria.ts";
import { activeProviderFirst, bufferBeforeStorage, robotsIgnorePlainChests } from "./logistics.ts";
import { absoluteSnapExact } from "./blueprint-snap.ts";
import { beaconSqrtRule } from "./beacons.ts";
import { poleWireReach, poleSupplyArea } from "./poles.ts";
import { beltSideload } from "./sideload.ts";
import { nutrientsSpoilLinear, pentapodEggHatches, freshnessInherited } from "./spoilage.ts";
import { scrapSharedProbability, acidNeutralisationEnergy, boilerRatio } from "./planets.ts";
import { productivityVsBeacons } from "./compare-modules.ts";
import { waitUntilFullVsTimed } from "./compare-trains.ts";
import { dragonTeethVsSolid } from "./compare-walls.ts";
import { disabledStopNoSkip, interruptAppendsTemporary, refuelInterruptNeedsWait } from "./trains.ts";
import { laserVsGunSupply } from "./compare-turrets.ts";
import { harvestOnDemand } from "./compare-gleba-harvest.ts";
import { blockVsBus } from "./compare-block-vs-bus.ts";
import { bufferOnlyToOptedIn, storageInsertOrder, activeProviderEmptied } from "./logistics2.ts";
import { stackMergeWeightedAverage, multipleSpoilableAveraged, fruitNoSpoilBeforeHarvest } from "./spoilage2.ts";
import { nutrientsFuelRateAndProductivity, idleNutrientsSpoil, bootstrapRecipes } from "./biochamber.ts";
import { accumulatorCapacityAndRate, reactorBurnsRegardless, pumpThroughput, pipeSegmentLimit, solarAccumulatorRatio } from "./power.ts";
import { interruptIgnoredWithTemporaryStop, stopPriorityHighestFirst } from "./trains2.ts";
import { pickupRightmostSlot, roboportLogisticsRange, landingPadAfterPassive, separateNetworks } from "./logistics3.ts";
import { spoiledFirstOnlyFromContainers, mashJellyTimers, spoilageAsFuel, spoiledInputBlocksMachine } from "./spoilage3.ts";
import { limitCountsEnRoute, signalHoldsFollower, singleHeadedCannotReverse, disabledEnRouteStillGoes } from "./trains3.ts";
import { biofluxToNutrients, bacteriaProductivityFull, eggProductivityNetOnly, biochamberNoElectricity } from "./biochamber2.ts";
import { constructionRange55, robotCargoSize, touchingRangesConnect } from "./logistics4.ts";
import { brownoutSlowsMachines } from "./power2.ts";
import { handSizeNoResearch, handSizeFullResearch } from "./inserters.ts";
import { railgunFriendlyFire, railgunBeyondTarget, turretIdleDrain, boompuffExplodes, qualityWithProductivity, teslaChainOwn, platformWeightCargo, explosiveRocketOwnWalls, biterEggHatch, refuelDryStation } from "./v1-claims.ts";
import { insertionLimits, inserterFarLane, fastReplaceKeeps, railGate, lavaDisposal, qualitySpoil, heatingExceptions, unreachableSameNameNoPath } from "./tips.ts";
import { qualitySciencePack, oneLandingPadPerSurface } from "./m2-misc.ts";
import { splitWiresStopFlicker, inserterLimitByChest } from "./circuits.ts";
import { inserterFromMovingBelt } from "./belts2.ts";
import { bridgeOverWater, supportReach, lavaSupports, deepOilNeedsResearch, elevatedNoStation, lavaMaxGap, aquiloAmmoniaSupports, glebaMarshSupports } from "./elevated.ts";
import { overgrowthSoilNeedsEggs } from "./soil.ts";
import { splitterEvenAndOverflow, splitterOutputPriority, splitterInputPriority, splitterFilter, splitterKeepsLanes, splitterSpeedTiers, undergroundMaxDistance, undergroundLaneFilter, undergroundBraiding } from "./splitters.ts";
import { turn90Radius13, sBendHalfDiagonal, elevatedSameShapes } from "./rails.ts";
import { bioCoreHour } from "./m3-bio-core.ts";
import { drainIsThirtieth, machineQualitySpeed, moduleQualityEffects, beaconQuality } from "./calc-rules.ts";
import { beltYellow, beltRed, beltBlue, beltGreen, stoneFurnaceRate, inserterBasic, inserterFast, inserterLong } from "./belts.ts";

export const EXPERIMENTS: { exp: Experiment; file: string }[] = [
  { exp: activeProviderFirst, file: "experiments/logistics.ts" },
  { exp: bufferBeforeStorage, file: "experiments/logistics.ts" },
  { exp: overgrowthSoilNeedsEggs, file: "experiments/soil.ts" },
  { exp: heatingTowerPower, file: "experiments/heating-tower.ts" },
  { exp: heatingTowerBurnsAtMax, file: "experiments/heating-tower.ts" },
  { exp: copperBacteriaChance, file: "experiments/bacteria.ts" },
  // 第二批: 蓝图要用的基本吞吐
  { exp: beltYellow, file: "experiments/belts.ts" },
  { exp: beltRed, file: "experiments/belts.ts" },
  { exp: beltBlue, file: "experiments/belts.ts" },
  { exp: beltGreen, file: "experiments/belts.ts" },
  { exp: stoneFurnaceRate, file: "experiments/belts.ts" },
  { exp: inserterBasic, file: "experiments/belts.ts" },
  { exp: inserterFast, file: "experiments/belts.ts" },
  { exp: inserterLong, file: "experiments/belts.ts" },
  // 第三批: 火车规则放宽的依据、游戏外设计精准落格
  { exp: robotsIgnorePlainChests, file: "experiments/logistics.ts" },
  { exp: absoluteSnapExact, file: "experiments/blueprint-snap.ts" },
  // 第四批: 分享塔公式、电线杆、侧向汇入、腐坏
  { exp: beaconSqrtRule, file: "experiments/beacons.ts" },
  { exp: poleWireReach, file: "experiments/poles.ts" },
  { exp: poleSupplyArea, file: "experiments/poles.ts" },
  { exp: beltSideload, file: "experiments/sideload.ts" },
  { exp: nutrientsSpoilLinear, file: "experiments/spoilage.ts" },
  { exp: pentapodEggHatches, file: "experiments/spoilage.ts" },
  { exp: freshnessInherited, file: "experiments/spoilage.ts" },
  // 第五批: 其他星球 (雷神星、祝融星、新地星)
  { exp: scrapSharedProbability, file: "experiments/planets.ts" },
  { exp: acidNeutralisationEnergy, file: "experiments/planets.ts" },
  { exp: boilerRatio, file: "experiments/planets.ts" },
  // 第六批: 思路并排比 (设计搜索)
  { exp: productivityVsBeacons, file: "experiments/compare-modules.ts" },
  { exp: waitUntilFullVsTimed, file: "experiments/compare-trains.ts" },
  { exp: dragonTeethVsSolid, file: "experiments/compare-walls.ts" },
  // 第七批: 火车 (停用车站、中断、加油中断)
  { exp: disabledStopNoSkip, file: "experiments/trains.ts" },
  { exp: interruptAppendsTemporary, file: "experiments/trains.ts" },
  { exp: refuelInterruptNeedsWait, file: "experiments/trains.ts" },
  // 第八批: 思路并排比 (第二轮)
  { exp: laserVsGunSupply, file: "experiments/compare-turrets.ts" },
  { exp: harvestOnDemand, file: "experiments/compare-gleba-harvest.ts" },
  { exp: blockVsBus, file: "experiments/compare-block-vs-bus.ts" },
  // 第九批: 五大主题补齐 (物流网、腐坏、生物室)
  { exp: bufferOnlyToOptedIn, file: "experiments/logistics2.ts" },
  { exp: storageInsertOrder, file: "experiments/logistics2.ts" },
  { exp: activeProviderEmptied, file: "experiments/logistics2.ts" },
  { exp: stackMergeWeightedAverage, file: "experiments/spoilage2.ts" },
  { exp: multipleSpoilableAveraged, file: "experiments/spoilage2.ts" },
  { exp: fruitNoSpoilBeforeHarvest, file: "experiments/spoilage2.ts" },
  { exp: nutrientsFuelRateAndProductivity, file: "experiments/biochamber.ts" },
  { exp: idleNutrientsSpoil, file: "experiments/biochamber.ts" },
  { exp: bootstrapRecipes, file: "experiments/biochamber.ts" },
  // 第十批: 电、火车补齐
  { exp: accumulatorCapacityAndRate, file: "experiments/power.ts" },
  { exp: reactorBurnsRegardless, file: "experiments/power.ts" },
  { exp: pumpThroughput, file: "experiments/power.ts" },
  { exp: pipeSegmentLimit, file: "experiments/power.ts" },
  { exp: solarAccumulatorRatio, file: "experiments/power.ts" },
  { exp: interruptIgnoredWithTemporaryStop, file: "experiments/trains2.ts" },
  { exp: stopPriorityHighestFirst, file: "experiments/trains2.ts" },
  // 第十一批: 物流网、腐坏补到 10 条
  { exp: pickupRightmostSlot, file: "experiments/logistics3.ts" },
  { exp: roboportLogisticsRange, file: "experiments/logistics3.ts" },
  { exp: landingPadAfterPassive, file: "experiments/logistics3.ts" },
  { exp: separateNetworks, file: "experiments/logistics3.ts" },
  { exp: spoiledFirstOnlyFromContainers, file: "experiments/spoilage3.ts" },
  { exp: mashJellyTimers, file: "experiments/spoilage3.ts" },
  { exp: spoilageAsFuel, file: "experiments/spoilage3.ts" },
  { exp: spoiledInputBlocksMachine, file: "experiments/spoilage3.ts" },
  // 第十二批: 火车、生物室补到 10 条
  { exp: limitCountsEnRoute, file: "experiments/trains3.ts" },
  { exp: signalHoldsFollower, file: "experiments/trains3.ts" },
  { exp: singleHeadedCannotReverse, file: "experiments/trains3.ts" },
  { exp: disabledEnRouteStillGoes, file: "experiments/trains3.ts" },
  { exp: biofluxToNutrients, file: "experiments/biochamber2.ts" },
  { exp: bacteriaProductivityFull, file: "experiments/biochamber2.ts" },
  { exp: eggProductivityNetOnly, file: "experiments/biochamber2.ts" },
  { exp: biochamberNoElectricity, file: "experiments/biochamber2.ts" },
  // 第十二批 (续): 物流网、电的"已核实"补到 10 条 (各有被推翻的, 不算数)
  { exp: constructionRange55, file: "experiments/logistics4.ts" },
  { exp: robotCargoSize, file: "experiments/logistics4.ts" },
  { exp: touchingRangesConnect, file: "experiments/logistics4.ts" },
  { exp: brownoutSlowsMachines, file: "experiments/power2.ts" },
  // 第十三批: 游戏内提示与技巧进沙盘
  { exp: insertionLimits, file: "experiments/tips.ts" },
  { exp: inserterFarLane, file: "experiments/tips.ts" },
  { exp: fastReplaceKeeps, file: "experiments/tips.ts" },
  { exp: railGate, file: "experiments/tips.ts" },
  { exp: lavaDisposal, file: "experiments/tips.ts" },
  { exp: qualitySpoil, file: "experiments/tips.ts" },
  { exp: heatingExceptions, file: "experiments/tips.ts" },
  { exp: unreachableSameNameNoPath, file: "experiments/tips.ts" },
  // 第十四批: 第三轮检索"待沙盘"
  { exp: qualitySciencePack, file: "experiments/m2-misc.ts" },
  { exp: oneLandingPadPerSurface, file: "experiments/m2-misc.ts" },
  { exp: splitWiresStopFlicker, file: "experiments/circuits.ts" },
  { exp: inserterLimitByChest, file: "experiments/circuits.ts" },
  { exp: inserterFromMovingBelt, file: "experiments/belts2.ts" },
  // 第十六批: 高架铁路 (用户: 什么时候该用高架, 不然要填土地)
  { exp: bridgeOverWater, file: "experiments/elevated.ts" },
  { exp: supportReach, file: "experiments/elevated.ts" },
  { exp: lavaSupports, file: "experiments/elevated.ts" },
  { exp: deepOilNeedsResearch, file: "experiments/elevated.ts" },
  { exp: elevatedNoStation, file: "experiments/elevated.ts" },
  { exp: lavaMaxGap, file: "experiments/elevated.ts" },
  // 第十七批: 分流器和地下传送带 (覆盖清单里的空白)
  { exp: splitterEvenAndOverflow, file: "experiments/splitters.ts" },
  { exp: splitterOutputPriority, file: "experiments/splitters.ts" },
  { exp: splitterInputPriority, file: "experiments/splitters.ts" },
  { exp: splitterFilter, file: "experiments/splitters.ts" },
  { exp: splitterKeepsLanes, file: "experiments/splitters.ts" },
  { exp: splitterSpeedTiers, file: "experiments/splitters.ts" },
  { exp: undergroundMaxDistance, file: "experiments/splitters.ts" },
  { exp: undergroundLaneFilter, file: "experiments/splitters.ts" },
  { exp: undergroundBraiding, file: "experiments/splitters.ts" },
  // 第十八批: 曲轨、半斜轨 (覆盖清单最后 6 个空白实体)
  { exp: turn90Radius13, file: "experiments/rails.ts" },
  { exp: sBendHalfDiagonal, file: "experiments/rails.ts" },
  { exp: elevatedSameShapes, file: "experiments/rails.ts" },
  // M2 收尾: 支架能立在哪 (玄冥星氨海有分歧)
  { exp: aquiloAmmoniaSupports, file: "experiments/elevated.ts" },
  { exp: glebaMarshSupports, file: "experiments/elevated.ts" },
  // M3 完成标准: 生物核心跑 1 小时对计算器
  { exp: bioCoreHour, file: "experiments/m3-bio-core.ts" },
  // 第十九批: 计算器的待核实规则 (待机耗电、品质)
  { exp: drainIsThirtieth, file: "experiments/calc-rules.ts" },
  { exp: machineQualitySpeed, file: "experiments/calc-rules.ts" },
  { exp: moduleQualityEffects, file: "experiments/calc-rules.ts" },
  { exp: beaconQuality, file: "experiments/calc-rules.ts" },
  // 第二十批: 搜索 / 喂料实测的测量条件 (没研究时机械臂每手几个)
  { exp: handSizeNoResearch, file: "experiments/inserters.ts" },
  // 第二十一批: 第一版知识清点搬来的 (会伤到自己的、和仓库相反的)
  { exp: railgunFriendlyFire, file: "experiments/v1-claims.ts" },
  { exp: railgunBeyondTarget, file: "experiments/v1-claims.ts" },
  { exp: turretIdleDrain, file: "experiments/v1-claims.ts" },
  { exp: boompuffExplodes, file: "experiments/v1-claims.ts" },
  { exp: qualityWithProductivity, file: "experiments/v1-claims.ts" },
  // 第二十二批: 第一版搬来的 (续)
  { exp: teslaChainOwn, file: "experiments/v1-claims.ts" },
  { exp: platformWeightCargo, file: "experiments/v1-claims.ts" },
  // 第二十三批
  { exp: explosiveRocketOwnWalls, file: "experiments/v1-claims.ts" },
  { exp: biterEggHatch, file: "experiments/v1-claims.ts" },
  // 第二十四批
  { exp: refuelDryStation, file: "experiments/v1-claims.ts" },
  { exp: handSizeFullResearch, file: "experiments/inserters.ts" },
];
