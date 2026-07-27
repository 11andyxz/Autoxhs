/**
 * 文字溢出自适应：卡片尺寸是固定的，内容长度不是。与其静默截断（会把中文句子切一半），
 * 不如整卡等比降字号；降到下限还塞不下才标记为「溢出」，由 UI 提示人工精简。
 *
 * 这里放可单测的纯逻辑；真正的 DOM 测量在浏览器里跑（脚本由 browserFitScript 生成，
 * 与这里共用同一份档位，避免两边逻辑漂移）。
 */

/** 字号缩放下限。低于此值排版会散，宁可提示人工改文案。 */
export const FIT_MIN_SCALE = 0.62;
/** 每档缩多少。0.05 在「够快收敛」和「不过度缩小」之间比较平衡。 */
export const FIT_STEP = 0.05;

/**
 * 从 1.0 递减到 FIT_MIN_SCALE 的档位表（含端点，两位小数）。
 * 下限不一定落在步长网格上（1.00 每次减 0.05 只能到 0.65），所以最后补一档，
 * 保证「声明的下限」就是「真会试到的下限」。
 */
export function fitScales(): number[] {
  const out: number[] = [];
  for (let s = 1; s > FIT_MIN_SCALE + 1e-9; s -= FIT_STEP) {
    out.push(Math.round(s * 100) / 100);
  }
  out.push(FIT_MIN_SCALE);
  return out;
}

export type FitResult = {
  scale: number;
  /** 降到下限仍然装不下 */
  overflow: boolean;
};

/**
 * 选出第一个能装下的档位。fits(scale) 由调用方提供（浏览器里是真实测量，测试里是桩）。
 * 全部装不下时返回下限 + overflow=true —— 绝不静默截断内容。
 */
export function pickScale(fits: (scale: number) => boolean): FitResult {
  const scales = fitScales();
  for (const scale of scales) {
    if (fits(scale)) return { scale, overflow: false };
  }
  return { scale: scales[scales.length - 1], overflow: true };
}

/**
 * 生成注入页面的自适应脚本。对每张 .card 逐档试字号，测到不溢出为止；
 * 全部跑完后置 window.__fitDone = true，供 puppeteer 等待。
 * 溢出的卡片打上 data-overflow="1"，render 层据此回报给 UI。
 */
export function browserFitScript(): string {
  return `
(function () {
  var SCALES = ${JSON.stringify(fitScales())};
  var cards = document.querySelectorAll('.card');
  for (var c = 0; c < cards.length; c++) {
    var card = cards[c];
    var inner = card.querySelector('.inner');
    if (!inner) continue;
    var chosen = SCALES[SCALES.length - 1];
    var ok = false;
    for (var i = 0; i < SCALES.length; i++) {
      inner.style.setProperty('--fs', (20 * SCALES[i]).toFixed(2) + 'px');
      // 强制重排后再量：scrollHeight 超过 clientHeight 即溢出
      void inner.offsetHeight;
      if (inner.scrollHeight <= inner.clientHeight + 1) {
        chosen = SCALES[i];
        ok = true;
        break;
      }
    }
    inner.style.setProperty('--fs', (20 * chosen).toFixed(2) + 'px');
    if (!ok) card.setAttribute('data-overflow', '1');
  }
  window.__fitDone = true;
})();
`;
}
