import { Field } from './index.js';

const mk = (ws) => {
  const f = new Field({ windScale: ws, windAmp: 5, gravity: [0,0], drag: 0, seed: 1 });
  f.emit(1, { pos: [100, 100], life: 5 });
  f.step(1/60);
  return [f.velocities[0], f.velocities[1]];
};
console.log('windScale=0:', mk(0), ' (期待: 風なし → [0,0])');
console.log('windScale=1:', mk(1), ' (期待: 風あり)');
console.log('windScale=100:', mk(100), ' (期待: 風あり、異なる値)');

const f = new Field({ windScale: 0, windAmp: 5, seed: 1 });
console.log('stored:', f.windScale, ' (期待: 0 のまま、黙置換なし)');

// windAmp=0 + windScale=0 も安全か
const f2 = new Field({ windScale: 0, windAmp: 0, gravity:[0,0], drag:0, seed: 1 });
f2.emit(1, { pos:[100,100], life:5 });
for (let i=0;i<60;i++) f2.step(1/60);
console.log('windAmp=0 + windScale=0, pos:', f2.positions[0], f2.positions[1], ' (期待: 100,100 のまま)');

// windAmp>0 + windScale=0 で NaN が出ないか
const f3 = new Field({ windScale: 0, windAmp: 5, gravity:[0,0], drag:0, seed: 1 });
f3.emit(10, { pos:[100,100], spread:5, life:5 });
for (let i=0;i<600;i++) f3.step(1/60);
let finite = true;
for (let i=0;i<f3.count*2;i++) if (!Number.isFinite(f3.positions[i])) finite = false;
console.log('windAmp>0 + windScale=0 600steps, all finite:', finite, ' (期待: true)');

// 既存: windScale=1, windAmp=5 で風が効く(回帰)
const f4 = new Field({ windScale: 1, windAmp: 5, gravity:[0,0], drag:0, seed: 1 });
f4.emit(1, { pos:[100,100], life:5 });
f4.step(1/60);
console.log('windScale=1 回帰, vel:', f4.velocities[0], f4.velocities[1], ' (期待: 非ゼロ)');

// 負の windScale も安全にスキップ
const f5 = new Field({ windScale: -5, windAmp: 5, gravity:[0,0], drag:0, seed: 1 });
f5.emit(1, { pos:[100,100], life:5 });
for (let i=0;i<60;i++) f5.step(1/60);
console.log('windScale=-5, pos:', f5.positions[0], f5.positions[1], ' (期待: 100,100 のまま)');
