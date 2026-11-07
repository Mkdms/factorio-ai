// Steam 成就缓存的解析 (src/play/steam-stats.ts): 段的位图才是成就, 累计数字不能当位图读
import test from "node:test";
import assert from "node:assert/strict";
import { newlyUnlocked, parseVdf, readAchievements } from "../src/play/steam-stats.ts";

const str = (k: string, v: string) => Buffer.concat([Buffer.from([1]), Buffer.from(`${k}\0${v}\0`, "utf8")]);
const int = (k: string, v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return Buffer.concat([Buffer.from([2]), Buffer.from(`${k}\0`, "utf8"), b]); };
const obj = (k: string, ...kids: Buffer[]) => Buffer.concat([Buffer.from([0]), Buffer.from(`${k}\0`, "utf8"), ...kids, Buffer.from([8])]);
const end = Buffer.from([8]);

const bit = (i: number, id: string, zh: string) => obj(String(i), str("name", id), obj("display", obj("name", str("schinese", zh), str("english", id))));
const schema = Buffer.concat([obj("427520",
  obj("stats",
    obj("2", int("type", 4), obj("bits", bit(0, "automate-this", "自动化生产！"), bit(1, "pest-control", "害虫防治"), bit(31, "last-bit", "最高位"))),
    obj("8", str("name", "iron-plates-per-hour"), int("type", 1)))), end]);
const stats = (bits: number, iron = 12177) => Buffer.concat([obj("cache", int("crc", 1), obj("2", int("data", bits)), obj("8", int("data", iron))), end]);

test("读得出已拿到的成就和中文名; 累计数字不当位图", () => {
  // 12177 的二进制有好多 1, 第一版把它当位图, 多读出一堆假成就
  const a = readAchievements(schema, stats(0b1));
  assert.equal(a.total, 3);
  assert.deepEqual(a.have, ["automate-this"]);
  assert.equal(a.names["pest-control"], "害虫防治");
  assert.equal(a.stats["iron-plates-per-hour"], 12177);
});

test("最高位不会因为有符号数读错", () => {
  assert.deepEqual(readAchievements(schema, stats(-2147483648)).have, ["last-bit"]);
});

test("没拿过任何成就的段: 全部没拿到", () => {
  const empty = Buffer.concat([obj("cache", int("crc", 1)), end]);
  assert.deepEqual(readAchievements(schema, empty).have, []);
});

test("跑之前和跑之后比出新拿到的", () => {
  assert.deepEqual(newlyUnlocked(["a"], ["a", "b"]), ["b"]);
  assert.deepEqual(newlyUnlocked(["a"], ["a"]), []);
});

test("文件坏了要报错, 不能当没拿到", () => {
  assert.throws(() => parseVdf(Buffer.from([99, 65, 0])), /不认识的类型/);
});
