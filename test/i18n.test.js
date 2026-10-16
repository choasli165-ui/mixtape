import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zh from '../public/i18n/zh.js';
import * as ja from '../public/i18n/ja.js';

const run = (mod, s) => { for (const [re, fn] of mod.patterns) if (re.test(s)) return s.replace(re, fn); return mod.dict[s] ?? s; };

test('Chinese and Japanese cover the same strings, none empty', () => {
  assert.deepEqual(Object.keys(zh.dict).sort(), Object.keys(ja.dict).sort());
  for (const m of [zh, ja]) for (const [k, v] of Object.entries(m.dict)) assert.ok(v && v.trim(), k);
});

test('patterns translate text with numbers and names', () => {
  assert.equal(run(zh, 'Playlist · 41 tracks'), '歌单 · 41 首');
  assert.equal(run(ja, 'Playlist · 41 tracks'), 'プレイリスト · 41 曲');
  assert.equal(run(zh, 'A minor'), 'A 小调');
  assert.equal(run(ja, 'Splitting the song into parts… 45%'), '曲をパートに分離しています… 45%');
  assert.equal(run(zh, '⬇ 3 of 5 saved on this PC (12.5 MB) · saving 2 more…'), '⬇ 已在本机保存 3/5 首（12.5 MB） · 还有 2 首保存中…');
  assert.equal(run(ja, 'Drop (0:11)'), 'ドロップ (0:11)');
  assert.match(run(zh, 'Tempo 140 vs 98 BPM → matched · Key A minor vs F major → song B moved down 5'), /速度 140 对 98 BPM → 已匹配 · 调性 A 小调 对 F 大调 → 歌曲 B 降低 5 个半音/);
  assert.equal(run(ja, 'Phonk it up: Distorted drums, an 808 bass line and a slowed, roomy feel.'), 'Phonk 風に：歪んだドラム、808 ベース、スローで広がりのあるサウンド。');
  assert.equal(run(zh, "Couldn't play “Bussin” — skipping"), '无法播放“Bussin”——已跳过');
});
