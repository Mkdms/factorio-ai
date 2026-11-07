// 转接: 第二版的 src/play/model-name.ts 在新项目里是 core/brains/lineup.ts
export * from "../../core/brains/lineup.ts";
export { NAME_RULE as HARNESS_NAME_RULE } from "../../core/brains/lineup.ts";
/** 第二版界面上没指定模型时的显示名 */
export const DEFAULT_MODEL_NAME = "Claude Opus 5.5";
